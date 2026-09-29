import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DesktopRuntime } from '../src/main/runtime.ts';
import { connectFixture } from '../tests/fixture-client.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = resolve(process.env.DSH_TEST_DESKTOP_RUNTIME ?? join(root, '.runtime'));
const requireRuntime = createRequire(join(runtime, 'package.json'));
const { resolvePrimaryRuntime } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-tool-workspace-dependencies')).href);
const paths = await resolvePrimaryRuntime(runtime);
const run = promisify(execFile);
await mkdir(join(root, '.test-data'), { recursive: true });
const data = await mkdtemp(join(root, '.test-data/workspace-dependencies-'));
const home = join(data, 'home');
await mkdir(home);
const probe = join(data, 'probe.mjs');
await writeFile(probe, `import { randomUUID } from 'node:crypto';
export const inject = ['connection', 'agents', 'tools'];
export function apply(ctx) {
  ctx.connection.rpc.handle('/workspace-dependency-test', async (method, payload, signal) => {
    const agent = ctx.agents.get(payload.args.sessionId);
    if (!agent) throw new Error('Fixture session not found');
    if (method === 'catalog') return { ok: true, value: ctx.tools.schemas(agent).map(tool => tool.name) };
    return { ok: true, value: await ctx.tools.execute({ agent, signal, callId: randomUUID(), name: payload.args.name, arguments: payload.args.arguments }) };
  });
}
`);
await writeFile(join(home, 'desktop.patch.yml'), '- insert:\n    - id: workspace-dependency-test\n      name: ' + JSON.stringify(probe) + '\n');
const core = new DesktopRuntime({ runtimeRoot: runtime, entry: join(runtime, 'app/index.ts'), home, cwd: data, onExit: () => {} });
let client: Awaited<ReturnType<typeof connectFixture>> | undefined;
const modes = ['standard', 'ptc', 'minimal', 'cordis', 'auto', 'audit'];
try {
  const ready = await core.start();
  const connection = join(data, 'connection.json');
  await writeFile(connection, JSON.stringify({ owner: 'dsh-desktop-test', ...ready }), { mode: 0o600 });
  client = await connectFixture(connection);
  for (const mode of modes) {
    const sessionId = (await client.rpc('session/create', { request: { cwd: data, agentPreset: mode } })).sessionId;
    const catalog: string[] = await client.rpc('catalog', { sessionId }, false, '/workspace-dependency-test');
    const calls: readonly (readonly [string, Record<string, unknown>])[] = catalog.includes('run_code') ? [
      ['run_code', { code: 'return await tools.describe_tools({names:["load_workspace_dependencies"]});', description: 'Inspect bundled workspace runtime tool schema' }],
      ['run_code', { code: 'return await tools.load_workspace_dependencies({});', description: 'Read bundled Python and Node runtime paths' }],
    ] as const : [
      ['describe_tools', { names: ['load_workspace_dependencies'] }],
      ['invoke_tool', { name: 'load_workspace_dependencies', arguments: {} }],
    ] as const;
    for (const [index, [name, args]] of calls.entries()) {
      const result = await client.rpc('execute', { sessionId, name, arguments: args }, false, '/workspace-dependency-test');
      assert.equal(result.isError, false, `${mode}/${name}: ${JSON.stringify(result)}`);
      if (index === 1) assert.ok(JSON.stringify(result).includes('office-smoke.py'), `${mode}: example path missing`);
    }
  }
} finally { client?.close(); await core.stop(); }
// No host Python/Node or user-site packages. Keep Windows OS loader variables.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PATH', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV'].includes(key.toUpperCase())));
env.PATH = join(data, 'no-host-runtimes');
env.PYTHONHOME = join(data, 'invalid-python-home');
env.PYTHONPATH = join(data, 'invalid-python-path');
env.PYTHONDONTWRITEBYTECODE = '1';
const output = join(data, '中文空格 Office outputs');
await run(paths.python, ['-I', '-B', paths.officeExample, '--output', output, '--node', paths.node], { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
const office = JSON.parse(await readFile(join(output, '测试报告.json'), 'utf8'));
assert.equal(office.passed, true);
await run(paths.python, ['-I', '-B', '-m', 'pip', 'check'], { env, windowsHide: true });
const venv = join(data, 'workspace venv');
await run(paths.python, ['-I', '-B', '-m', 'venv', '--copies', '--system-site-packages', venv], { env, windowsHide: true });
const venvPython = join(venv, ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3']));
await run(venvPython, ['-I', '-B', '-c', 'import sys,openpyxl,docx,pptx,PIL,lxml,pypdf,reportlab; assert sys.prefix != sys.base_prefix; print("venv-ok")'], { env, windowsHide: true });
await run(venvPython, ['-I', '-B', '-m', 'pip', 'check'], { env, windowsHide: true });
const pnpm = await run(paths.node, ['--expose-internals', paths.pnpm, '--version'], { env, windowsHide: true });
assert.match(pnpm.stdout.trim(), /^11\.7\.0$/);
const report = { status: 'pass', platform: process.platform, arch: process.arch, runtime, output, checks: [...office.checks, 'pip dependency consistency', 'workspace venv creation, inherited libraries and pip', 'bundled pnpm through bundled Node', 'no host Python/Node in PATH', 'actual DSH discovery/execution through Native or Code in all six presets'], modes, office };
await writeFile(join(data, 'report.json'), JSON.stringify(report, null, 2));
await writeFile(join(root, '.test-data/workspace-dependencies-latest.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
