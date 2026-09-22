import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

type Sections = Record<string, Record<string, unknown>>;
type Yaml = { parse(text: string): Sections | null; stringify(value: unknown): string };

/** Preserve the former shared settings before the official per-profile import. */
export async function prepareLegacySettings(configHome: string, stateHome: string, yaml: Yaml) {
  const target = join(stateHome, 'settings.yaml');
  if (await access(`${target}.imported`).then(() => true, () => false)) return;
  const read = async (file: string) => readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const local = await read(target);
  const shared = configHome === stateHome ? undefined : await read(join(configHome, 'settings.yaml')) ?? await read(join(configHome, 'settings.yaml.imported'));
  if (local === undefined && shared === undefined) return;
  const sections: Sections = { ...yaml.parse(shared ?? '') };
  for (const [key, value] of Object.entries(yaml.parse(local ?? '') ?? {})) sections[key] = { ...sections[key], ...value };
  const presets = sections['agent-presets'];
  if (presets) {
    const { default: defaultPreset, ...rest } = presets;
    const aliases: Record<string, string> = { code: 'ptc', guardian: 'audit' };
    sections['agent-preset-registry'] = {
      ...rest,
      ...(typeof defaultPreset === 'string' ? { selectedDefault: aliases[defaultPreset] ?? defaultPreset } : {}),
      ...sections['agent-preset-registry'],
    };
    delete sections['agent-presets'];
  }
  await mkdir(stateHome, { recursive: true });
  // Retain the exact old document, including comments and sections rejected by upstream.
  if (local !== undefined) await copyFile(target, `${target}.before-0.1.7`, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, yaml.stringify(sections), { mode: 0o600 });
  await rename(temporary, target);
}

/** Retire our former file-URL override now that its fixes ship in the bundle. */
export async function migrateProgressiveOverride(stateHome: string, yaml: { parse(text: string): any; stringify(value: unknown): string }) {
  const file = join(stateHome, 'desktop.patch.yml');
  const original = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (original === undefined) return;
  const rows = yaml.parse(original);
  if (!Array.isArray(rows)) return;
  const legacy = rows.flatMap(row => row.insert ?? []).find(row => row.id === 'progressive-tools-local' && typeof row.name === 'string' && /local-plugins[/\\]dsh-progressive-tools[/\\]lib[/\\]index\.js$/.test(row.name));
  if (!legacy) return;
  const next = rows.map(row => row.id === 'progressive-tools' ? { ...row, disabled: legacy.disabled ?? false, config: { ...row.config, ...legacy.config } } : row.insert ? { ...row, insert: row.insert.filter((entry: any) => entry !== legacy) } : row).filter(row => !row.insert || row.insert.length);
  if (!next.some(row => row.id === 'progressive-tools')) next.push({ id: 'progressive-tools', disabled: legacy.disabled ?? false, config: legacy.config ?? {} });
  await copyFile(file, `${file}.before-0.1.7`, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, yaml.stringify(next), { mode: 0o600 });
  await rename(temporary, file);
}
