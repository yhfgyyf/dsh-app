import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { notificationBadgePng } from '../src/main/notification-badge.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, '.test-data'), { recursive: true });
const data = await mkdtemp(join(root, '.test-data/task-notifications-'));
await writeFile(join(data, 'badge-12.png'), notificationBadgePng(12));
const child = spawn(createRequire(import.meta.url)('electron'),
  [join(root, 'tests/task-notifications-native.cjs')], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '', DSH_NOTIFICATION_TEST_DATA: data }, stdio: 'inherit',
  });
const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
const report = JSON.parse(await readFile(join(data, 'report.json'), 'utf8'));
await writeFile(join(root, '.test-data/task-notifications-latest.json'), JSON.stringify({ data, ...report }, null, 2));
assert.equal(code, 0, 'Native notification fixture failed');
assert.equal(report.passed, true);
console.log('Native task notification report: ' + join(data, 'report.json'));
