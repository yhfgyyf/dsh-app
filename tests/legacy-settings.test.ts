import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { prepareLegacySettings, migrateProgressiveOverride } from '../src/runtime/legacy-settings.ts';

const yaml = createRequire(new URL('../.runtime/package.json', import.meta.url))('yaml');
test('legacy import merges shared models with existing desktop settings and migrates the selected preset once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-settings-'));
  const shared = join(root, 'shared'), desktop = join(root, 'desktop');
  await mkdir(shared); await mkdir(desktop);
  const models = { 'llm-pi-ai': { providers: { fixture: { models: [{ id: 'retained' }] } } }, 'agent-presets': { default: 'code', modeSelectionEnabled: true } };
  const original = '# retain this comment\nui-onboarding:\n  welcomeNoticeVersion: 4\n';
  await writeFile(join(shared, 'settings.yaml'), yaml.stringify(models));
  await writeFile(join(desktop, 'settings.yaml'), original);
  try {
    await prepareLegacySettings(shared, desktop, yaml);
    const merged = yaml.parse(await readFile(join(desktop, 'settings.yaml'), 'utf8'));
    assert.deepEqual(merged['llm-pi-ai'], models['llm-pi-ai']);
    assert.deepEqual(merged['agent-preset-registry'], { selectedDefault: 'ptc', modeSelectionEnabled: true });
    assert.equal(merged['ui-onboarding'].welcomeNoticeVersion, 4);
    assert.equal(merged['agent-presets'], undefined);
    assert.equal(await readFile(join(desktop, 'settings.yaml.before-0.1.7'), 'utf8'), original);
    assert.deepEqual(yaml.parse(await readFile(join(shared, 'settings.yaml'), 'utf8')), models);
    await writeFile(join(desktop, 'settings.yaml.imported'), 'import finished');
    await writeFile(join(desktop, 'settings.yaml'), 'new profile settings');
    await prepareLegacySettings(shared, desktop, yaml);
    assert.equal(await readFile(join(desktop, 'settings.yaml'), 'utf8'), 'new profile settings');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the former local progressive-tools override migrates to the bundled fix without losing unrelated rows', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-overrides-'));
  const file = join(home, 'desktop.patch.yml');
  const rows = [{ id: 'audit-bundle', config: { binary: '/test/dsh' } }, { id: 'progressive-tools', disabled: true }, { insert: [{ id: 'progressive-tools-local', name: 'file:///app/local-plugins/dsh-progressive-tools/lib/index.js', config: { optionalEagerTools: ['fixture'] } }] }];
  const original = yaml.stringify(rows);
  await writeFile(file, original);
  try {
    await migrateProgressiveOverride(home, yaml);
    assert.deepEqual(yaml.parse(await readFile(file, 'utf8')), [rows[0], { id: 'progressive-tools', disabled: false, config: { optionalEagerTools: ['fixture'] } }]);
    assert.equal(await readFile(file + '.before-0.1.7', 'utf8'), original);
    const once = await readFile(file, 'utf8');
    await migrateProgressiveOverride(home, yaml);
    assert.equal(await readFile(file, 'utf8'), once);
  } finally { await rm(home, { recursive: true, force: true }); }
});
