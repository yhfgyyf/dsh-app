import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const appRoot = resolve(process.env.DSH_SIDE_CHAT_APP_ROOT ?? resolve(root, '../dsh-desktop'));
const executable = createRequire(resolve(appRoot, 'package.json'))('electron');
const env = { ...process.env, DSH_SIDE_CHAT_APP_ROOT: appRoot, DSH_SIDE_CHAT_SURFACE: process.argv.includes('--web') ? 'web' : 'desktop', ...process.argv.includes('--content-tools') ? { DSH_DESKTOP_CONTENT_TOOLS_TEST: '1' } : {} };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [resolve(root, 'tests/app.cjs')], { cwd: appRoot, env, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => {
  let result = code ?? 1;
  if (result === 0 && process.env.DSH_SIDE_CHAT_TEST_BASELINE !== '1') {
    const surface = process.argv.includes('--content-tools') ? 'content-tools' : process.argv.includes('--web') ? 'web' : 'desktop';
    const path = resolve(root, '.test-data/latest-' + surface + '.json');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const markers = [];
    const scan = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.name === '.dsh-side-chat-v2.json' && path !== report.preservedCorruptMarker) markers.push(path);
      }
    };
    scan(resolve(report.data, 'core'));
    if (markers.length > 0) { report.failures.push('App/Core shutdown left temporary side-chat storage: ' + markers.join(', ')); result = 1; }
    else report.checks.push('App/Core shutdown discards the remaining live temporary side; only the unchanged corrupt startup fixture may retain its marker');
    writeFileSync(path, JSON.stringify(report, null, 2));
    writeFileSync(resolve(report.data, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ surface, checks: report.checks, failures: report.failures, console: report.console, frameworkDiagnostics: report.frameworkDiagnostics, data: report.data }, null, 2));
  }
  process.exitCode = result;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill('SIGTERM'));
