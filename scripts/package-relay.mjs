import { readFile, writeFile, mkdir, copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { resolve, join, dirname, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const desktop = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const relay = join(root, 'services/relay');
const output = resolve(process.argv[2] ?? join(root, 'release', `remote-${desktop.version}`));
const releaseVersion = process.argv[3] ?? desktop.version;
if (!/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,95}$/.test(releaseVersion)) throw new Error('Invalid relay package version');
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, '.relay-source-'));
const name = `dsh-relay-${releaseVersion}`, directory = join(stage, name);
await mkdir(directory);
const files = [];
async function save(path, content) {
  const dest = join(directory, path); await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, content);
  files.push({ path, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
}
for (const path of [
  'LICENSE', 'package-lock.json', 'tsconfig.json',
  'Dockerfile', 'compose.yml', 'compose.collaboration.yml', '.env.example',
  'src/private-server.ts', 'src/private-store.ts', 'src/private-admin.ts', 'src/client-endpoints.ts', 'src/registration-code.ts',
  'dist/private-server.js', 'dist/private-store.js', 'dist/private-admin.js', 'dist/client-endpoints.js', 'dist/registration-code.js',
  ...['collab-types', 'collab-auth', 'collab-store', 'collab-server', 'collab-admin'].flatMap(name => [`src/${name}.ts`, `dist/${name}.js`]),
  'test/collab.test.ts',
  'test/private-deployment.test.ts', 'test/private-routes.test.ts', 'test/private-upgrade.test.ts', 'test/private-registration-code.test.ts',
  'test/fixtures/ca/ca.pem', 'test/fixtures/ca/server.pem', 'test/fixtures/ca/expired-ca.pem',
  'test/fixtures/relay-0.1.30/private-server.js', 'test/fixtures/relay-0.1.30/private-store.js', 'test/fixtures/relay-0.1.30/PROVENANCE.json',
  'deploy/upgrade.mjs', 'deploy/database-check.mjs', 'deploy/relay.env.example', 'deploy/dsh-relay.service', 'deploy/nginx.conf.example',
  'deploy/COLLABORATION.md', 'deploy/nginx.collaboration.conf.example',
]) await save(path, await readFile(join(relay, path)));
for (const entry of await readdir(join(relay, 'web'), { recursive: true, withFileTypes: true })) {
  if (entry.isFile()) { const path = relative(relay, join(entry.parentPath, entry.name)).split(sep).join('/'); await save(path, await readFile(join(relay, path))); }
}
const pkg = JSON.parse(await readFile(join(relay, 'package.json'), 'utf8'));
pkg.scripts = { build: 'tsc -p tsconfig.json', start: 'node dist/private-server.js', 'admin:private': 'node dist/private-admin.js',
  'start:collaboration': 'node dist/collab-server.js', 'admin:collaboration': 'node dist/collab-admin.js', test: 'tsx --test test/private-*.test.ts test/collab.test.ts' };
await save('package.json', JSON.stringify(pkg, null, 2) + '\n');
await save('README.md', (await readFile(join(relay, 'deploy/README-UBUNTU.md'), 'utf8')).replaceAll('{{RELAY_VERSION}}', releaseVersion));
await save('REMOTE-SOURCES.json', await readFile(join(root, 'REMOTE-SOURCES.json')));
await writeFile(join(directory, 'PACKAGE-MANIFEST.json'), JSON.stringify({
  releaseVersion, desktopVersion: desktop.version, upstreamRelayVersion: pkg.version, protocol: 'dsh-desktop-remote-v1',
  createdAt: new Date().toISOString(), node: pkg.engines.node, files,
  notes: ['Private relay and optional collaboration service; no user data or installed native modules.', 'Install dependencies on the Ubuntu target before starting.', 'Test script covers private deployment and collaboration; Desktop integration tests remain in the main repository.'],
}, null, 2) + '\n');
const archive = join(output, `DSH-Relay-${releaseVersion}-source.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', stage, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
await copyFile(join(directory, 'README.md'), join(output, 'Ubuntu-Relay-README.md'));
const bytes = await readFile(archive);
const result = { archive, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), stage: directory, files: files.length + 1 };
await writeFile(join(output, 'relay-artifact.json'), JSON.stringify(result, null, 2) + '\n');
await writeFile(join(output, 'SHA256SUMS'), `${result.sha256}  ${basename(archive)}\n`);
console.log(JSON.stringify(result, null, 2));
