// Real DSH ToolRuntime and Univer native gateway, using a disposable workspace.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = resolve(process.env.DSH_TEST_RUNTIME ?? join(root, '.runtime'));
assert.ok(process.env.DSH_TEST_UNIVER_PLUGIN, 'DSH_TEST_UNIVER_PLUGIN must point to an installed candidate package with its new dependencies');
const installed = await realpath(resolve(process.env.DSH_TEST_UNIVER_PLUGIN));
const reportRoot = resolve(process.env.DSH_TEST_REPORTS ?? join(root, '.test-data/univer-upgrade'));
await mkdir(reportRoot, { recursive: true });
const data = await mkdtemp(join(reportRoot, 'host-fixture-'));
const workspace = join(data, 'workspace'); await mkdir(workspace);
const report = { data, runtime, installed, platform: process.platform, architecture: process.arch,
  scope: 'Real DSH 0.2.0-rc.1 ToolRuntime, Univer gateway/worker and freshly installed native dependencies; no LLM, browser, user profile or telemetry requests', dependencies: {}, calls: [], checks: [], failures: [] };
let ctx;
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function packageDirectory(require, name) {
  // Assets-only packages need not export a JS entry or their package.json.
  for (const modules of require.resolve.paths(name) ?? []) {
    const directory = join(modules, name);
    try { if (JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).name === name) return realpath(directory); } catch {}
  }
  throw new Error(`Cannot locate ${name}`);
}
try {
  const manifest = JSON.parse(await readFile(join(root, 'patches/univer-office-0.3.5-dsh-rc1/manifest.json'), 'utf8'));
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.version, manifest.version);
  for (const entry of manifest.files) {
    assert.equal(createHash('sha256').update(await readFile(join(installed, entry.path))).digest('hex'), entry.after, `Unreviewed plugin file: ${entry.path}`);
  }
  // Keep the installed profile read-only. The isolated package resolves peers from
  // the selected DSH runtime and all direct dependencies from this exact install.
  const candidate = join(data, 'package'); await cp(installed, candidate, { recursive: true });
  const modules = join(data, 'node_modules'); await mkdir(modules);
  await symlink(join(runtime, 'node_modules/@deepseek-ai'), join(modules, '@deepseek-ai'), process.platform === 'win32' ? 'junction' : 'dir');
  const pluginRequire = createRequire(join(installed, 'package.json'));
  for (const name of Object.keys(metadata.dependencies)) {
    const directory = await packageDirectory(pluginRequire, name);
    const target = join(modules, name); await mkdir(dirname(target), { recursive: true });
    await symlink(directory, target, process.platform === 'win32' ? 'junction' : 'dir');
    report.dependencies[name] = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).version;
  }
  assert.equal(report.dependencies['@univerjs-pro/exchange-node-binding'], '1.0.1');
  assert.equal(report.dependencies['@univerjs-pro/engine-formula-rust-binding'], '1.0.1');
  assert.equal(typeof pluginRequire('@univerjs-pro/exchange-node-binding').exchangeExportSnapshot, 'function');
  assert.equal(typeof pluginRequire('@univerjs-pro/engine-formula-rust-binding').formulaEngineExecute, 'function');
  report.checks.push('Both exact 1.0.1 native bindings load on this platform');
  process.env.DSH_HOME = join(data, 'home');
  process.env.DSH_TELEMETRY_DISABLED = '1';
  process.env.NODE_PATH = [modules, join(runtime, 'node_modules')].join(delimiter);
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  const load = (name) => import(pathToFileURL(runtimeRequire.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: LlmRuntime, ToolCallId } = await load('@deepseek-ai/dsh-llm');
  const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
  const { default: ToolRuntime } = await load('@deepseek-ai/dsh-tools');
  const { default: SkillRegistry } = await load('@deepseek-ai/dsh-skill');
  const { Session, SessionId } = await load('@deepseek-ai/dsh-session');
  const Univer = await import(pathToFileURL(join(candidate, 'lib/index.js')).href);
  assert.equal(Univer.resolveConfig({}).telemetry, false);
  assert.equal(Univer.Config({}).telemetry, false);
  report.checks.push('Reviewed candidate and both default telemetry=false paths verified');
  ctx = new Context();
  await ctx.plugin(LlmRuntime); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(SkillRegistry);
  await ctx.plugin(Univer, { telemetry: false, skills: true, gatewayPort: await freePort(), gatewayStartupTimeoutMs: 60_000, resourceCacheRoot: join(data, 'resource-cache') });
  const schemas = ctx.tools.schemas();
  const names = schemas.filter(x => x.name.startsWith('univer_')).map(x => x.name);
  assert.ok(names.includes('univer_execute'));
  const queries = schemas.find(x => x.name === 'univer_api').parameters.properties.queries;
  assert.equal(queries.type, 'array'); assert.equal(queries.items.type, 'string');
  const queryTools = schemas.filter(x => x.parameters.properties?.queries);
  assert.ok(queryTools.length >= 2);
  for (const schema of queryTools) { assert.equal(schema.parameters.properties.queries.type, 'array'); assert.equal(schema.parameters.properties.queries.items.type, 'string'); }
  report.checks.push(`${names.length} tools register; API and resource queries both have explicit array item schemas`);
  const skills = (await ctx.skills.list({ cwd: workspace })).filter(x => x.provider === 'univer');
  assert.equal(skills.length, 8);
  for (const skill of skills) assert.ok((await ctx.skills.get(skill.name, { cwd: workspace })).content.length > 100);
  report.checks.push('All eight bundled skill providers list and load through the rc.1 registry');
  const session = Session.create(SessionId('univer-rc1-fixture'), [], { id: SessionId('univer-rc1-fixture'), version: 4, cwd: workspace, createdAt: Date.now(), isSeeded: false });
  const agent = { id: session.id, session };
  let n = 0;
  async function execute(name, args) {
    return ctx.tools.execute({ callId: ToolCallId('univer-rc1-' + (++n)), name, arguments: args, agent, signal: AbortSignal.timeout(90_000) });
  }
  const rejected = await execute('univer_api', { action: 'find', queries: '["border"]' });
  assert.equal(rejected.isError, true); assert.match(JSON.stringify(rejected), /INVALID_ARGS/);
  report.checks.push('Stringified array is rejected as INVALID_ARGS before entering the plugin');
  async function call(name, args) {
    const result = await execute(name, args);
    report.calls.push({ name, isError: result.isError, value: result.value, error: result.isError ? result.error : undefined });
    assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.value?.ok, true, JSON.stringify(result.value));
    return result.value;
  }
  const file = join(workspace, 'alignment-regression.univer');
  const api = await call('univer_api', { action: 'show', queries: ['FHorizontalAlignment', 'FRange.setHorizontalAlignment', 'FRange.getHorizontalAlignment'] });
  const apiType = api.result.find(x => x.query === 'FHorizontalAlignment')?.type;
  assert.match(apiType?.definition ?? '', /'right'/); assert.match(apiType?.definition ?? '', /'normal'/);
  await call('univer_new', { file });
  const tree = await call('univer_worktree', { action: 'create', file, name: 'RC1 compatibility fixture' });
  const worktreeId = tree.result.worktreeId ?? tree.result.worktree?.worktreeId ?? tree.result.worktree?.id; assert.ok(worktreeId);
  const unit = await call('univer_unit', { action: 'create', file, worktreeId, kind: 'sheet', name: 'Alignment regression' });
  const unitId = unit.result.unitId ?? unit.result.unit?.unitId ?? unit.result.unit?.id; assert.ok(unitId);
  const common = { file, worktreeId, unitId };
  await call('univer_execute', { ...common, code: "const sheet = univerAPI.getActiveWorkbook().getSheets()[0]; sheet.getRange('A1:B2').setValues([['right', 'legacy'], [1, 2]]); return sheet.getRange('A1:B2').getValues();" });
  for (const [alignment, cell] of [['right', 'A1'], ['normal', 'B1']]) {
    const result = await call('univer_execute', { ...common, code: `const range = univerAPI.getActiveWorkbook().getSheets()[0].getRange('${cell}'); range.setHorizontalAlignment('${alignment}'); return range.getHorizontalAlignment();` });
    assert.equal(result.result.value, 'normal');
  }
  const invalid = await call('univer_execute', { ...common, code: "const range = univerAPI.getActiveWorkbook().getSheets()[0].getRange('A2'); try { range.setHorizontalAlignment('invalid-alignment-fixture'); return { rejected: false }; } catch (error) { return { rejected: true, message: error.message }; }" });
  assert.equal(invalid.result.value.rejected, true);
  const final = await call('univer_execute', { ...common, code: "const sheet = univerAPI.getActiveWorkbook().getSheets()[0]; return { right: sheet.getRange('A1').getHorizontalAlignment(), legacy: sheet.getRange('B1').getHorizontalAlignment(), values: sheet.getRange('A1:B2').getValues() };" });
  assert.deepEqual(final.result.value, { right: 'normal', legacy: 'normal', values: [['right', 'legacy'], [1, 2]] });
  report.checks.push('Nine real tool calls create file/worktree/sheet, preserve right+normal behavior and reject invalid alignment');
} catch (error) { report.failures.push(error.stack ?? String(error)); process.exitCode = 1; }
finally {
  await ctx?.fiber.dispose();
  report.status = report.failures.length ? 'fail' : 'pass';
  await writeFile(join(data, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(reportRoot, 'plugin-host-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, data, dependencies: report.dependencies, checks: report.checks, failures: report.failures }, null, 2));
}
