import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireRuntime = createRequire(join(root, '.runtime/package.json'));
const load = (name: string) => import(pathToFileURL(requireRuntime.resolve(name)).href);
const plugin = await load('@deepseek-ai/dsh-tool-workspace-dependencies');
const { patchWorkspaceDependencySource } = await import(new URL('../scripts/install-workspace-dependencies.mjs', import.meta.url).href);
const base = { desktopVersion: 'test', platform: 'darwin', arch: 'arm64', python: '3.12.14', node: '24.15.0', pnpm: '11.7.0', pythonPackages: { openpyxl: '3.1.5' } };

test('workspace dependency adapter is repeatable and refuses unknown source edits', async () => {
  const source = await readFile(requireRuntime.resolve('@deepseek-ai/dsh-tool-workspace-dependencies'), 'utf8');
  assert.equal(patchWorkspaceDependencySource(source), source);
  assert.throws(() => patchWorkspaceDependencySource(source + '\n// unexpected edit\n'), /Unknown workspace dependency changes/);
});

test('workspace paths reuse the existing Desktop Node and pnpm on macOS and Windows', () => {
  for (const platform of ['darwin', 'win32']) {
    const root = '/desktop/runtime';
    const paths = plugin.workspaceDependencyPaths(root, plugin.parsePrimaryRuntime({ ...base, platform }));
    assert.equal(paths.node, join(root, 'bin', platform === 'win32' ? 'node.exe' : 'node'));
    assert.equal(paths.nodePackages, join(root, 'node_modules'));
    assert.equal(paths.pnpm, join(root, 'package-manager/node_modules/pnpm/bin/pnpm.mjs'));
    assert.equal(paths.officeExample, join(root, 'examples/office-smoke.py'));
    assert.deepEqual(paths.pythonDistributions, base.pythonPackages);
  }
});

test('LoongArch metadata must declare the Linux old-world ABI explicitly', () => {
  const loong = { ...base, platform: 'linux', arch: 'loong64' };
  assert.throws(() => plugin.parsePrimaryRuntime(loong), /invalid metadata/);
  assert.throws(() => plugin.parsePrimaryRuntime({ ...loong, abi: 'new-world' }), /invalid metadata/);
  assert.throws(() => plugin.parsePrimaryRuntime({ ...loong, platform: 'darwin', abi: 'loongarch64-old-world' }), /invalid metadata/);
  assert.equal(plugin.parsePrimaryRuntime({ ...loong, abi: 'loongarch64-old-world' }).abi, 'loongarch64-old-world');
});

test('the registered model tool reports the actual payload and its executable example', async t => {
  const [{ Context }, { default: LlmRuntime, ToolCallId }, { default: ToolRuntime }, { default: SystemPrompt }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-system-prompt'),
  ]);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  await ctx.plugin(plugin, { source: join(root, '.runtime') });
  const description = ctx.tools.get('load_workspace_dependencies').description;
  assert.ok(!description.includes('Python includes numpy'));
  const result = await ctx.tools.execute({ callId: ToolCallId('workspace-runtime-test'), name: 'load_workspace_dependencies', arguments: {}, signal: new AbortController().signal });
  assert.equal(result.isError, false, result.error?.message);
  assert.equal(result.value.pythonDistributions.openpyxl, '3.1.5');
  assert.ok(result.value.officeExample.endsWith('office-smoke.py'));
  assert.ok(!('numpy' in result.value.pythonDistributions));
});
