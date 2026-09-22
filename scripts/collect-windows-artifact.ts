import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const artifact = JSON.parse(await readFile(join(root, 'release/latest-windows.json'), 'utf8'));
const output = join(root, 'release/upload');
await mkdir(output, { recursive: true });
await cp(artifact.installer, join(output, basename(artifact.installer)));
await cp(join(dirname(artifact.installer), 'runtime-manifest.json'), join(output, 'runtime-manifest-windows-x64.json'));
await cp(join(root, '.test-data/update-network/latest.json'), join(output, 'windows-update-network-report.json'));
const presetChecks = JSON.parse(await readFile(join(root, 'docs/evidence/audit-switch.json'), 'utf8'));
if (presetChecks.status !== 'pass' || presetChecks.results.length < 8 || presetChecks.results.some((result: { status: string }) => result.status !== 'pass')) throw new Error('Preset verification did not pass.');
await writeFile(join(output, 'windows-preset-report.json'), JSON.stringify({ status: presetChecks.status, scope: presetChecks.scope, results: presetChecks.results }, null, 2));
const nativeLatest = JSON.parse(await readFile(join(root, '.test-data/computer-native-latest.json'), 'utf8'));
const nativeRuns = await Promise.all((await readdir(join(root, '.test-data/computer-native'))).sort().map(async directory => JSON.parse(await readFile(join(root, '.test-data/computer-native', directory, 'report.json'), 'utf8'))));
if (nativeRuns.some(run => run.failures.length)) throw new Error('Native computer verification contained a failed run.');
await writeFile(join(output, 'windows-computer-native-report.json'), JSON.stringify({ ...nativeLatest, runs: nativeRuns }, null, 2));
await cp(join(root, '.test-data/computer-tools-latest.json'), join(output, 'windows-computer-tools-report.json'));
await cp(join(root, '.test-data/computer-settings-latest.json'), join(output, 'windows-computer-settings-report.json'));
for (const name of ['browser-use', 'browser-use-settings']) {
  const browser = JSON.parse(await readFile(join(root, 'docs/evidence', name + '.json'), 'utf8'));
  if (browser.status !== 'pass' || browser.platform !== 'win32') throw new Error('Windows Browser Use verification did not pass.');
  await writeFile(join(output, 'windows-' + name + '-report.json'), JSON.stringify(browser, null, 2));
}
const marketplaceRoot = join(root, '.test-data/plugin-marketplace-native');
const marketplaceLatest = (await readdir(marketplaceRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).sort((a, b) => Number(b.name) - Number(a.name))[0];
if (!marketplaceLatest) throw new Error('Marketplace verification report is missing.');
const marketplaceDirectory = join(marketplaceRoot, marketplaceLatest.name);
const marketplace = JSON.parse(await readFile(join(marketplaceDirectory, 'report.json'), 'utf8'));
if (!Array.isArray(marketplace.failures) || marketplace.failures.length || !Array.isArray(marketplace.checks) || !marketplace.checks.length) throw new Error('Marketplace verification did not pass.');
const marketplaceScreenshots = ['marketplace-high-risk-review.png', 'marketplace-enabled.png'];
for (const name of marketplaceScreenshots) await cp(join(marketplaceDirectory, name), join(output, 'windows-' + name));
// Publish only acceptance evidence, not the fixture home, configuration or logs.
await writeFile(join(output, 'windows-plugin-marketplace-report.json'), JSON.stringify({
  status: 'pass', run: marketplaceLatest.name, package: marketplace.package,
  checks: marketplace.checks, failures: marketplace.failures,
  modelRequests: marketplace.modelRequests, reviewedArchiveSha256: marketplace.reviewedArchive?.sha256,
  screenshots: marketplaceScreenshots.map(name => 'windows-' + name),
}, null, 2));
const univerRoot = join(root, '.test-data/univer-client');
const univer = JSON.parse(await readFile(join(univerRoot, 'report.json'), 'utf8'));
if (univer.status !== 'pass' || !Array.isArray(univer.failures) || univer.failures.length || !Array.isArray(univer.checks) || univer.checks.length < 3 || univer.clientSha256 !== 'df478f1ee572440e0b779728c9684b36c61809c36961e42d659a3486894b4ac7') throw new Error('Published Univer client verification did not pass.');
await cp(join(univerRoot, 'ready.png'), join(output, 'windows-univer-client-ready.png'));
await writeFile(join(output, 'windows-univer-client-report.json'), JSON.stringify({
  status: univer.status, checks: univer.checks, failures: univer.failures,
  clientSha256: univer.clientSha256, platform: univer.platform, scope: univer.scope,
  screenshot: 'windows-univer-client-ready.png',
}, null, 2));
for (const [from, to] of [['.test-data/windows-installer-report.json', 'windows-installer-report.json'], ['.test-data/native-owned/report.json', 'windows-native-report.json'], ['docs/evidence/three-surfaces.json', 'windows-three-surfaces-report.json'], ['.test-data/updates-native/latest.json', 'windows-updates-report.json'], ['.test-data/artifact-links-native/latest.json', 'windows-artifact-links-report.json'], ['.test-data/sidebar-browser-native/report.json', 'windows-sidebar-browser-report.json']]) await cp(join(root, from), join(output, to));
await writeFile(join(output, 'SHA256SUMS-windows.txt'), `${artifact.sha256}  ${basename(artifact.installer)}\n`);
await writeFile(join(output, 'windows-artifact.json'), JSON.stringify({ ...artifact, app: undefined, installer: basename(artifact.installer) }, null, 2));
