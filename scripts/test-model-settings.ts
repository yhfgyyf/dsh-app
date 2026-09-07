import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, mkdtemp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DesktopRuntime } from '../src/main/runtime.ts';
import { connectFixture } from '../tests/fixture-client.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireDsh = createRequire(new URL('../.runtime/package.json', import.meta.url));
const { parse, stringify } = requireDsh('yaml');
await mkdir(join(root, '.test-data'), { recursive: true });
const data = await mkdtemp(join(root, '.test-data/model-settings-'));
const configHome = join(data, 'shared-config');
await mkdir(configHome);
const profile = { displayName: 'Shared fixture provider', apiKeyEnv: 'DESKTOP_SHARED_TEST_KEY', api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'shared-model', contextWindow: 32768, maxTokens: 2048 }] };
const settingsFile = join(configHome, 'settings.yaml');
const credentialsFile = join(configHome, '.credentials.yaml');
await writeFile(settingsFile, '# Shared settings comment must survive\n' + stringify({ 'llm-pi-ai': { providers: { 'desktop-shared': profile } }, 'agent-default-model': { provider: 'desktop-shared', model: 'shared-model' }, untouched: { preserve: true } }), { mode: 0o600 });
await writeFile(credentialsFile, stringify({ version: 1, refs: { DESKTOP_SHARED_TEST_KEY: 'disposable-test-value' }, records: {} }), { mode: 0o600 });
await writeFile(join(configHome, '.env'), 'DESKTOP_DOTENV_TEST_KEY=disposable-dotenv-value\n', { mode: 0o600 });
const cores: DesktopRuntime[] = [];
const clients: Awaited<ReturnType<typeof connectFixture>>[] = [];
const results: { name: string; status: string }[] = [];
const check = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); results.push({ name, status: 'pass' }); console.log('PASS', name); }
  catch (error) { results.push({ name, status: 'fail' }); throw error; }
};
const until = async (predicate: () => Promise<boolean>) => {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > 10000) throw new Error('Shared configuration did not hot-reload');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
async function start(index: number) {
  const core = new DesktopRuntime({ runtimeRoot: join(root, '.runtime'), entry: join(root, '.runtime/app/index.ts'), home: join(data, 'core-' + index), configHome, cwd: data, onExit: () => {} });
  cores.push(core);
  const ready = await core.start();
  const connectionFile = join(data, 'connection-' + index + '.json');
  await writeFile(connectionFile, JSON.stringify({ owner: 'dsh-desktop-test', ...ready }), { mode: 0o600 });
  const client = await connectFixture(connectionFile);
  clients.push(client);
  return client;
}
try {
  const a = await start(1);
  const b = await start(2);
  const namespace = async (client: typeof a, ns: string) => (await client.rpc('settings/describe')).namespaces.find((entry: any) => entry.ns === ns);
  const credential = async (client: typeof a, ref: string) => (await client.rpc('credentials/describe', { refs: [ref] }))[ref];
  await check('both independent cores load existing shared providers and default model', async () => {
    for (const client of [a, b]) {
      assert.partialDeepStrictEqual((await namespace(client, 'llm-pi-ai')).value.providers['desktop-shared'], profile);
      const catalog = await client.rpc('session/modelCatalog');
      assert.equal(catalog.default.provider, 'desktop-shared');
      assert.equal(catalog.default.model, 'shared-model');
      assert.ok(JSON.stringify(catalog.groups).includes('shared-model'));
    }
  });
  await check('managed credentials and shared .env fallback expose status without secrets', async () => {
    for (const client of [a, b]) {
      assert.deepEqual(await credential(client, 'DESKTOP_SHARED_TEST_KEY'), { configured: true, source: 'file', writable: true });
      assert.deepEqual(await credential(client, 'DESKTOP_DOTENV_TEST_KEY'), { configured: true, source: 'user-env', writable: true });
    }
  });
  await check('model edits hot-reload in both directions and preserve unrelated configuration', async () => {
    await a.rpc('settings/update', { ns: 'llm-pi-ai', patch: { providers: { 'desktop-shared': { ...profile, displayName: 'Updated by first core' } } } });
    await until(async () => (await namespace(b, 'llm-pi-ai')).value.providers['desktop-shared'].displayName === 'Updated by first core');
    await b.rpc('settings/update', { ns: 'llm-pi-ai', patch: { providers: { 'desktop-shared': { ...profile, displayName: 'Updated by second core' } } } });
    await until(async () => (await namespace(a, 'llm-pi-ai')).value.providers['desktop-shared'].displayName === 'Updated by second core');
    const raw = await readFile(settingsFile, 'utf8');
    assert.match(raw, /Shared settings comment must survive/);
    assert.equal(parse(raw).untouched.preserve, true);
  });
  await check('credential removal and replacement propagate through the shared managed file', async () => {
    await a.rpc('credentials/unset', { ref: 'DESKTOP_SHARED_TEST_KEY' });
    await until(async () => !(await credential(b, 'DESKTOP_SHARED_TEST_KEY')).configured);
    await b.rpc('credentials/set', { ref: 'DESKTOP_SHARED_TEST_KEY', value: 'replacement-disposable-test-value' });
    await until(async () => (await credential(a, 'DESKTOP_SHARED_TEST_KEY')).configured);
    assert.equal(parse(await readFile(credentialsFile, 'utf8')).refs.DESKTOP_SHARED_TEST_KEY, 'replacement-disposable-test-value');
    if (process.platform !== 'win32') assert.equal((await stat(credentialsFile)).mode & 0o777, 0o600);
  });
  await check('concurrent settings writers preserve both changes', async () => {
    await Promise.all([
      a.rpc('settings/update', { ns: 'ui-theme', patch: { preference: 'light' } }),
      b.rpc('settings/update', { ns: 'locale', patch: { preference: 'en' } }),
    ]);
    const disk = parse(await readFile(settingsFile, 'utf8'));
    assert.equal(disk['ui-theme'].preference, 'light');
    assert.equal(disk.locale.preference, 'en');
    assert.equal(disk.untouched.preserve, true);
  });
  await check('both cores load sessions from the same DSH home', async () => {
    const created = await a.rpc('session/create', { request: { cwd: data, agentPreset: 'standard' } });
    assert.ok((await a.rpc('session/list', { _request: {} })).items.some((entry: any) => entry.sessionId === created.sessionId));
    await until(async () => (await b.rpc('session/list', { _request: {} })).items.some((entry: any) => entry.sessionId === created.sessionId));
    for (const index of [1, 2]) {
      await assert.rejects(stat(join(data, 'core-' + index, 'settings.yaml')), { code: 'ENOENT' });
      await assert.rejects(stat(join(data, 'core-' + index, '.credentials.yaml')), { code: 'ENOENT' });
    }
  });
  await check('shared model configuration survives an independent core restart', async () => {
    a.close();
    await cores[0].stop();
    const restarted = await start(1);
    assert.equal((await namespace(restarted, 'llm-pi-ai')).value.providers['desktop-shared'].displayName, 'Updated by second core');
    assert.equal((await credential(restarted, 'DESKTOP_SHARED_TEST_KEY')).configured, true);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  for (const core of cores) await core.stop();
  await mkdir(join(root, 'docs/evidence'), { recursive: true });
  await writeFile(join(root, 'docs/evidence/model-settings.json'), JSON.stringify({ at: new Date().toISOString(), scope: 'two independent cores with disposable shared settings and credentials; no external model requests', results }, null, 2));
}
