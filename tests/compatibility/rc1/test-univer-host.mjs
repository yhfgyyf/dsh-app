import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const report = JSON.parse(await readFile('.test-data/rc1-plugins/univer-upgrade/plugin-upgrade-report.json', 'utf8'));
const child = spawnSync(process.execPath, ['scripts/test-univer-plugin-host.mjs'], {
  stdio: 'inherit', env: { ...process.env,
    DSH_TEST_UNIVER_PLUGIN: join(report.data, 'home/profiles/test/node_modules/dsh-univer-office'),
    DSH_TEST_UNIVER_PROVENANCE: 'tests/compatibility/rc1/univer-provenance.json',
    DSH_TEST_REPORTS: '.test-data/rc1-plugins/univer-host',
  },
});
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
