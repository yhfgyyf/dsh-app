import assert from 'node:assert/strict';
import { packager } from '@electron/packager';
import { chmod, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeManifest } from './runtime-manifest.ts';
import { copyPackagedRuntime, verifyPackagedRuntime } from './package-runtime.ts';

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build this package on Ubuntu amd64.');
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const runtimeInfo = JSON.parse(await readFile(join(root, '.runtime/runtime.json'), 'utf8'));
assert.equal(runtimeInfo.platform, 'linux');
assert.equal(runtimeInfo.arch, 'x64');
assert.equal(runtimeInfo.desktopVersion, pkg.version);
assert.equal(execFileSync(join(root, '.runtime/bin/node'), ['--version'], { encoding: 'utf8' }).trim(), 'v24.15.0');
const output = join(root, 'release', new Date().toISOString().replace(/[:.]/g, '-'));
const staging = join(output, 'staging');
await mkdir(staging, { recursive: true });
await cp(join(root, 'dist'), join(staging, 'dist'), { recursive: true });
for (const name of ['README.md', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, name), join(staging, name));
await writeFile(join(staging, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, main: pkg.main, private: true }, null, 2));
const runtime = join(output, 'runtime');
await copyPackagedRuntime(join(root, '.runtime'), runtime);
const [app] = await packager({ dir: staging, extraResource: [runtime], name: 'DSH Desktop', executableName: 'dsh-desktop', appVersion: pkg.version, buildVersion: pkg.version, platform: 'linux', arch: 'x64', electronVersion: pkg.devDependencies.electron, out: output, asar: true, prune: false });
const packagedRuntime = await runtimeManifest(join(app, 'resources/runtime'));
assert.deepEqual(packagedRuntime, await runtimeManifest(runtime), 'Packaged runtime differs from the prepared runtime');
const debroot = join(output, 'debroot');
const payload = join(debroot, 'opt/dsh-desktop');
await mkdir(join(debroot, 'opt'), { recursive: true });
await cp(app, payload, { recursive: true });
for (const name of ['DEBIAN', 'usr/bin', 'usr/share/applications', 'usr/share/pixmaps', 'usr/share/doc/dsh-desktop']) await mkdir(join(debroot, name), { recursive: true });
await writeFile(join(debroot, 'usr/bin/dsh-desktop'), '#!/bin/sh\nexec /opt/dsh-desktop/dsh-desktop "$@"\n');
await chmod(join(debroot, 'usr/bin/dsh-desktop'), 0o755);
await writeFile(join(debroot, 'usr/share/applications/dsh-desktop.desktop'), '[Desktop Entry]\nName=DSH Desktop\nComment=Desktop client for DeepSeek Harness\nExec=/usr/bin/dsh-desktop %U\nIcon=dsh-desktop\nType=Application\nCategories=Development;Utility;\nTerminal=false\nStartupWMClass=DSH Desktop\n');
execFileSync(join(runtime, 'dependencies/python/bin/python3'), ['-I', '-B', '-c', 'from PIL import Image; import sys; Image.open(sys.argv[1]).save(sys.argv[2])', join(root, 'assets/icon.ico'), join(debroot, 'usr/share/pixmaps/dsh-desktop.png')]);
await cp(join(root, 'docs/UBUNTU.md'), join(debroot, 'usr/share/doc/dsh-desktop/README.Ubuntu'));
await cp(join(root, 'THIRD_PARTY_NOTICES.md'), join(debroot, 'usr/share/doc/dsh-desktop/copyright'));
const allFiles: string[] = [];
async function collect(directory: string) {
  // Electron's temporary application root is private (0700). Installed files
  // belong to root and must remain readable/executable by desktop users.
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) {
      await chmod(path, (await stat(path)).mode & 0o111 ? 0o755 : 0o644);
      allFiles.push(path);
    }
    else throw new Error(`Unexpected package entry: ${path}`);
  }
}
await collect(debroot);
let bytes = 0;
const md5: string[] = [];
for (const path of allFiles.sort()) {
  const data = await readFile(path);
  bytes += data.length;
  md5.push(`${createHash('md5').update(data).digest('hex')}  ${path.slice(debroot.length + 1)}`);
}
await writeFile(join(debroot, 'DEBIAN/control'), `Package: dsh-desktop\nVersion: ${pkg.version}-1ubuntu1\nSection: utils\nPriority: optional\nArchitecture: amd64\nMaintainer: DSH Desktop <noreply@github.com>\nInstalled-Size: ${Math.ceil(bytes / 1024)}\nDepends: libc6 (>= 2.35), libstdc++6, libgtk-3-0 | libgtk-3-0t64, libnss3, libnspr4, libgbm1, libasound2t64 | libasound2, libsecret-1-0, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxfixes3, libxrandr2, libxkbcommon0, libdrm2, libatk1.0-0 | libatk1.0-0t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libcups2 | libcups2t64, ca-certificates, xdg-utils\nHomepage: https://github.com/yhfgyyf/dsh-app\nDescription: Independent desktop client for DeepSeek Harness\n Includes a private Node.js and Python runtime. Supports Ubuntu 22.04 and 24.04 LTS.\n`);
await writeFile(join(debroot, 'DEBIAN/md5sums'), md5.join('\n') + '\n');
await writeFile(join(debroot, 'DEBIAN/postinst'), '#!/bin/sh\nset -e\nif [ "$1" = configure ]; then\n  chown root:root /opt/dsh-desktop/chrome-sandbox\n  chmod 4755 /opt/dsh-desktop/chrome-sandbox\n  if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications; fi\nfi\n');
await chmod(join(debroot, 'DEBIAN/postinst'), 0o755);
await chmod(join(payload, 'chrome-sandbox'), 0o4755);
execFileSync('/bin/sh', ['-n', join(debroot, 'DEBIAN/postinst')]);
const installer = join(output, `DSH-Desktop-${pkg.version}-Ubuntu-amd64.deb`);
execFileSync('dpkg-deb', ['--root-owner-group', '--uniform-compression', '-Zxz', '-z6', '-b', debroot, installer], { stdio: 'inherit' });
const extracted = join(output, 'verification');
execFileSync('dpkg-deb', ['-x', installer, extracted]);
await verifyPackagedRuntime(join(extracted, 'opt/dsh-desktop/resources/runtime'));
for (const path of ['opt/dsh-desktop', 'opt/dsh-desktop/resources/runtime', 'opt/dsh-desktop/resources/runtime/bin']) {
  assert.equal((await stat(join(extracted, path))).mode & 0o777, 0o755, `Installed directory is not accessible: ${path}`);
}
assert.equal((await stat(join(extracted, 'opt/dsh-desktop/chrome-sandbox'))).mode & 0o7777, 0o4755);
assert.deepEqual(await runtimeManifest(join(extracted, 'opt/dsh-desktop/resources/runtime')), packagedRuntime);
assert.deepEqual(await readFile(join(extracted, 'opt/dsh-desktop/resources/app.asar')), await readFile(join(payload, 'resources/app.asar')));
const archive = await readFile(installer);
const sha256 = createHash('sha256').update(archive).digest('hex');
await writeFile(installer + '.sha256', `${sha256}  ${installer.split('/').at(-1)}\n`);
const result = { app, installer, sha256, bytes: archive.length, platform: 'linux', arch: 'x64', distribution: ['Ubuntu 22.04 LTS', 'Ubuntu 24.04 LTS'], archiveVerified: true, signed: false, electron: pkg.devDependencies.electron, runtime: { fileCount: packagedRuntime.fileCount, bytes: packagedRuntime.bytes, sha256: packagedRuntime.sha256 } };
await writeFile(join(output, 'runtime-manifest.json'), JSON.stringify(packagedRuntime, null, 2));
await writeFile(join(output, 'artifact.json'), JSON.stringify(result, null, 2));
await writeFile(join(root, 'release/latest-linux.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
