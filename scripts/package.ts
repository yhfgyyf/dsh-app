import { packager } from '@electron/packager';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runtimeManifest } from './runtime-manifest.ts';
import { macSigningIdentity, machOFiles } from './macos-signing.ts';
import { macSignature, verifyMacSigningContinuity } from '../src/main/macos-signature.ts';
import { verifyComputerDriverBuild } from './build-computer-driver.ts';

if (process.platform !== 'darwin') throw new Error('此打包脚本面向 macOS。');
const { values } = parseArgs({ options: { 'developer-id': { type: 'boolean' }, 'previous-app': { type: 'string' } } });
// Validate credentials before creating artifacts. A requested release identity
// must never silently fall back to a build-specific ad-hoc signature.
const signing = await macSigningIdentity(values['developer-id'] === true);
const developerId = !!signing.teamId;
const root = fileURLToPath(new URL('..', import.meta.url));
await verifyComputerDriverBuild(join(root, '.runtime/computer-use'));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = join(root, 'release', stamp);
const staging = join(output, 'staging');
await mkdir(staging, { recursive: true });
await cp(join(root, 'dist'), join(staging, 'dist'), { recursive: true });
await cp(join(root, 'README.md'), join(staging, 'README.md'));
await cp(join(root, 'THIRD_PARTY_NOTICES.md'), join(staging, 'THIRD_PARTY_NOTICES.md'));
await writeFile(join(staging, 'package.json'), JSON.stringify({ name: version.name, version: version.version, description: version.description, main: version.main, private: true }, null, 2));

const run = (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
});
const iconset = join(output, 'DSH.iconset');
await run('swift', [join(root, 'scripts/make-icon.swift'), iconset]);
await run('iconutil', ['-c', 'icns', iconset, '-o', join(output, 'DSH.icns')]);
const runtime = join(output, 'runtime');
await cp(join(root, '.runtime'), runtime, { recursive: true, dereference: true });
const nativeFiles = developerId ? await machOFiles(runtime) : new Set<string>();
const nodeEntitlements = join(output, 'node-entitlements.plist');
if (developerId) {
  const { stdout } = await promisify(execFile)('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', join(runtime, 'bin/node')]);
  assert.match(stdout, /<plist/, 'Bundled Node entitlements could not be read');
  await writeFile(nodeEntitlements, stdout);
  // Retain the tested Node runtime exceptions, but never ship debugger access.
  if (stdout.includes('<key>com.apple.security.get-task-allow</key>')) await run('/usr/libexec/PlistBuddy', ['-c', 'Delete :com.apple.security.get-task-allow', nodeEntitlements]);
}
const packaged = await packager({
  extraResource: [runtime], dir: staging, name: 'DSH Desktop', appBundleId: 'io.dsh.desktop', appVersion: version.version, buildVersion: version.version, platform: 'darwin', arch: process.arch as 'arm64' | 'x64', electronVersion: version.devDependencies.electron, out: output, asar: true, prune: false, icon: join(output, 'DSH.icns'), appCopyright: 'Independent desktop client for DeepSeek Harness', extendInfo: { NSHumanReadableCopyright: 'Independent desktop client for DeepSeek Harness' },
  osxSign: {
    identity: signing.identity, identityValidation: developerId, keychain: signing.keychain,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    // Formal builds sign native addons and tools too; non-code resources stay exact.
    ignore: file => file.includes('/Contents/Resources/') && !nativeFiles.has(file.split('/Contents/Resources/runtime/')[1] ?? ''),
    optionsForFile: file => developerId
      ? { hardenedRuntime: true, entitlements: file.endsWith('/Contents/Resources/runtime/bin/node') ? nodeEntitlements : file.includes('/Contents/Resources/runtime/') ? [] : join(root, 'scripts/macos-entitlements.plist') }
      : { hardenedRuntime: false, timestamp: 'none' },
  },
});
const app = join(packaged[0], 'DSH Desktop.app');
await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
const signature = await macSignature(app);
const designatedRequirement = signature.requirement;
if (developerId) {
  assert.equal(signature.developerId, true, 'Formal app lacks a Developer ID signature');
  assert.equal(signature.teamId, signing.teamId, 'Formal app has the wrong signing team');
  assert.ok(signature.timestamp, 'Formal app lacks a secure signing timestamp');
} else console.warn('macOS: ad-hoc signing changes the permission identity between builds. This local test build is not ready for public distribution.');
const continuity = values['previous-app'] ? await verifyMacSigningContinuity(values['previous-app'], app) : undefined;
const sourceRuntime = await runtimeManifest(join(root, '.runtime'));
const packagedRuntime = await runtimeManifest(join(app, 'Contents/Resources/runtime'));
if (!developerId) assert.deepEqual(packagedRuntime, sourceRuntime, 'Packaged runtime differs from the tested runtime');
else {
  assert.deepEqual(packagedRuntime.files.map(file => file.path), sourceRuntime.files.map(file => file.path), 'Signing changed runtime file membership');
  assert.deepEqual(packagedRuntime.files.filter(file => !nativeFiles.has(file.path)), sourceRuntime.files.filter(file => !nativeFiles.has(file.path)), 'Signing changed non-native runtime resources');
  for (const file of nativeFiles) await run('/usr/bin/codesign', ['--verify', '--strict', join(app, 'Contents/Resources/runtime', file)]);
  await writeFile(join(output, 'runtime-source-manifest.json'), JSON.stringify(sourceRuntime, null, 2));
}
await writeFile(join(output, 'runtime-manifest.json'), JSON.stringify(packagedRuntime, null, 2));
const archive = join(output, `DSH-Desktop-${version.version}-macOS-${process.arch}.zip`);
await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
// Verify the distributed ZIP, including its signature resource seal.
const extracted = join(output, 'verification');
await run('ditto', ['-x', '-k', archive, extracted]);
const extractedApp = join(extracted, 'DSH Desktop.app');
await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', extractedApp]);
assert.deepEqual(await runtimeManifest(join(extractedApp, 'Contents/Resources/runtime')), packagedRuntime, 'Archived runtime differs from the packaged runtime');
assert.deepEqual(await readFile(join(extractedApp, 'Contents/Resources/app.asar')), await readFile(join(app, 'Contents/Resources/app.asar')), 'Archived app differs from the packaged app');
const bytes = await readFile(archive);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const result = { app, archive, sha256, bytes: bytes.length, signed: true, signature: developerId ? 'developer-id' : 'ad-hoc', signingTeam: signing.teamId, designatedRequirement, signingContinuity: continuity, developerId, notarized: false, distributionReady: false, archiveVerified: true, installedComputerUseVerified: false, electron: version.devDependencies.electron, runtime: { fileCount: packagedRuntime.fileCount, bytes: packagedRuntime.bytes, sha256: packagedRuntime.sha256 } };
await writeFile(join(output, 'artifact.json'), JSON.stringify(result, null, 2));
await writeFile(join(root, 'release/latest.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
