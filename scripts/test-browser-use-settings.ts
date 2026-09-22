import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, '.test-data'), { recursive: true });
const data = await mkdtemp(join(root, '.test-data/browser-use-settings-'));
const electron = createRequire(import.meta.url)('electron');
for (const restore of ['0', '1']) {
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(electron, [join(root, 'tests/browser-use-settings.cjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, DSH_BROWSER_SETTINGS_TEST_DATA: data, DSH_BROWSER_SETTINGS_RESTORE: restore } });
    child.once('error', reject); child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`Browser settings ${restore === '1' ? 'restore' : 'enable'} test failed (${code})`);
}
await mkdir(join(root, 'docs/evidence'), { recursive: true });
await writeFile(join(root, 'docs/evidence/browser-use-settings.json'), JSON.stringify({ status: 'pass', platform: process.platform, runs: await Promise.all(['enable', 'restore'].map(async phase => JSON.parse(await readFile(join(data, `report-${phase}.json`), 'utf8')))) }, null, 2));
console.log('PASS Browser Use settings and restart persistence:', data);
