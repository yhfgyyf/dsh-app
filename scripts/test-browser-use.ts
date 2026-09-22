import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DesktopRuntime } from '../src/main/runtime.ts';
import { browserCandidates } from '../src/main/browser-use.ts';
import { connectFixture } from '../tests/fixture-client.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, '.test-data'), { recursive: true });
const data = await mkdtemp(join(root, '.test-data/browser-use-'));
const home = join(data, 'home'); const state = join(data, 'state');
await mkdir(home); await mkdir(state);
const browser = (await Promise.all(browserCandidates(process.platform, homedir(), process.env).map(async value => await access(value.path).then(() => value, () => undefined)))).find(Boolean);
assert.ok(browser, 'Install Chrome or Edge to run the real Browser Use integration test');
const probe = join(data, 'probe.mjs');
await writeFile(probe, `import { randomUUID } from 'node:crypto';
export const inject = ['connection', 'webServer', 'agents', 'tools'];
export function apply(ctx) {
  ctx.connection.rpc.handle('/browser-use-test', async (method, payload, signal) => {
    const agent = ctx.agents.get(payload.args.sessionId);
    if (!agent) throw new Error('Fixture session not found');
    if (method === 'catalog') return { ok: true, value: { provider: ctx.get('browserUse')?.providerName ?? null, tools: ctx.tools.schemas(agent).map(tool => tool.name) } };
    const result = await ctx.tools.execute({ agent, signal, callId: randomUUID(), name: payload.args.name, arguments: payload.args.arguments });
    return { ok: true, value: result };
  });
}
`);
await writeFile(join(state, 'desktop.patch.yml'), '- id: audit-bundle\n  config: { enabled: false }\n- insert:\n    - id: browser-use-test\n      name: ' + JSON.stringify(probe) + '\n');
const page = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><title>DSH Browser Use fixture</title><label>Name <input id="name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply</button><output></output></html>`); });
await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(page.address() as { port: number }).port}/`;
const core = new DesktopRuntime({ runtimeRoot: join(root, '.runtime'), entry: join(root, '.runtime/app/index.ts'), home: state, configHome: home, cwd: data, onExit: () => {} });
let client: Awaited<ReturnType<typeof connectFixture>> | undefined;
const checks: string[] = [];
try {
  const ready = await core.start();
  const connection = join(data, 'connection.json');
  await writeFile(connection, JSON.stringify({ owner: 'dsh-desktop-test', ...ready }), { mode: 0o600 });
  client = await connectFixture(connection);
  const create = async () => (await client!.rpc('session/create', { request: { cwd: data, agentPreset: 'standard' } })).sessionId as string;
  const catalog = (sessionId: string) => client!.rpc('catalog', { sessionId }, false, '/browser-use-test');
  const call = async (sessionId: string, name: string, args: object) => {
    const result = await client!.rpc('execute', { sessionId, name, arguments: args }, false, '/browser-use-test');
    assert.equal(result.isError, false, JSON.stringify(result));
    return result;
  };
  const before = await create();
  assert.equal((await catalog(before)).provider, null);
  checks.push('Browser Use is absent by default');
  await core.configureBrowserUse({ enabled: true, executablePath: browser.path });
  const first = await create();
  assert.equal((await catalog(first)).provider, 'playwright-mcp');
  await call(first, 'describe_tools', { names: ['mcp__playwright-mcp__browser_navigate', 'mcp__playwright-mcp__browser_evaluate', 'mcp__playwright-mcp__browser_take_screenshot'] });
  await call(first, 'invoke_tool', { name: 'mcp__playwright-mcp__browser_navigate', arguments: { url } });
  const edited = await call(first, 'invoke_tool', { name: 'mcp__playwright-mcp__browser_evaluate', arguments: { function: '() => { document.querySelector("input").value = "DSH_BROWSER_OK"; document.querySelector("button").click(); localStorage.setItem("dshFixture", "first"); return document.querySelector("output").textContent; }' } });
  await writeFile(join(data, 'edit-result.json'), JSON.stringify(edited, null, 2));
  assert.match(edited.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n').split('### Ran Playwright code')[0], /DSH_BROWSER_OK/);
  const screenshot = await call(first, 'invoke_tool', { name: 'mcp__playwright-mcp__browser_take_screenshot', arguments: { type: 'png' } });
  assert.ok(screenshot.content.some((block: any) => block.type === 'image'), 'Screenshot must survive progressive tool invocation');
  checks.push('Real browser navigation, form interaction and screenshot through describe_tools/invoke_tool');
  const second = await create();
  await call(second, 'describe_tools', { names: ['mcp__playwright-mcp__browser_navigate', 'mcp__playwright-mcp__browser_evaluate'] });
  await call(second, 'invoke_tool', { name: 'mcp__playwright-mcp__browser_navigate', arguments: { url } });
  const isolated = await call(second, 'invoke_tool', { name: 'mcp__playwright-mcp__browser_evaluate', arguments: { function: '() => ({ isolated: localStorage.getItem("dshFixture") === null })' } });
  const output = isolated.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n').split('### Ran Playwright code')[0];
  assert.match(output, /"isolated":\s*true/);
  checks.push('Two sessions use isolated browser storage');
  await core.configureBrowserUse({ enabled: false });
  for (const sessionId of [before, first, second]) {
    const state = await catalog(sessionId);
    assert.equal(state.provider, null);
    assert.ok(state.tools.every((name: string) => !name.startsWith('mcp__playwright-mcp__')));
  }
  checks.push('Disable unloads provider and removes tools from all sessions');
  await core.configureBrowserUse({ enabled: true, executablePath: browser.path });
  await create();
  await core.configureBrowserUse({ enabled: false });
  checks.push('Provider can be enabled again after complete cleanup');
  const report = { status: 'pass', browser: browser.name, platform: process.platform, checks };
  await mkdir(join(root, 'docs/evidence'), { recursive: true });
  await writeFile(join(root, 'docs/evidence/browser-use.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  client?.close(); await core.stop();
  await new Promise<void>(resolve => page.close(() => resolve()));
}
