import { cp, mkdir, readFile, writeFile, realpath, chmod, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const installed = process.env.DSH_INSTALL_ROOT ?? dirname(await realpath(join(homedir(), '.local/bin/dsh')));
const source = installed.replaceAll('\\', '/').endsWith('/lib') ? dirname(installed) : installed;
const destination = join(root, '.runtime');
const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const pins = JSON.parse(await readFile(join(root, 'runtime/dependencies.json'), 'utf8'));
if (pkg.name !== '@deepseek-ai/dsh' || pkg.version !== pins.dsh) throw new Error(`Runtime snapshot requires the verified DSH ${pins.dsh} installation.`);
try {
  await rename(destination, join(root, `.runtime-before-${Date.now()}`));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
await mkdir(destination, { recursive: true });
await cp(join(source, 'node_modules'), join(destination, 'node_modules'), { recursive: true, dereference: true });
// Snapshot published plugin files only: no sessions, settings, keys or source checkouts.
for (const name of ['dsh-auto-preset-router', 'dsh-audit-mode', 'dsh-progressive-tools']) {
  const directory = join(process.env.DSH_PLUGIN_ROOT ?? join(homedir(), '.dsh/profiles/web/node_modules'), name);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const out = join(destination, 'node_modules', name);
  await mkdir(out, { recursive: true });
  for (const path of ['package.json', ...manifest.files]) {
    if (path.includes('*') || path.includes('..')) throw new Error(`Unsupported snapshot entry: ${name}/${path}`);
    await cp(join(directory, path), join(out, path), { recursive: true, dereference: true });
  }
}
await mkdir(join(destination, 'bin'), { recursive: true });
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
await cp(process.execPath, join(destination, 'bin', nodeName));
if (process.platform !== 'win32') await chmod(join(destination, 'bin', nodeName), 0o755);
await writeFile(join(destination, 'package.json'), JSON.stringify({ name: 'dsh-desktop-runtime', version: '0.1.0', private: true, type: 'module' }));
const req = createRequire(join(destination, 'package.json'));
const auditInstaller = await import(new URL('install-audit-compat.mjs', import.meta.url).href);
await auditInstaller.applyAuditCompat({ nodeModules: join(destination, 'node_modules'), pluginRoot: join(destination, 'node_modules/dsh-audit-mode'), backupHome: join(root, '.build-runtime') });
const artifactInstaller = await import(new URL('install-artifact-links.mjs', import.meta.url).href);
await artifactInstaller.applyArtifactLinks();
const sidebarInstaller = await import(new URL('install-sidebar-autoclose.mjs', import.meta.url).href);
await sidebarInstaller.applySidebarAutoclose();
const computerInstaller = await import(new URL('prepare-computer-use.ts', import.meta.url).href);
await computerInstaller.prepareComputerUse();
const progressiveImageInstaller = await import(new URL('install-progressive-images.mjs', import.meta.url).href);
await progressiveImageInstaller.applyProgressiveImages();
for (const name of ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-base', 'dsh-auto-preset-router', 'dsh-audit-mode', 'dsh-progressive-tools']) req.resolve(name);
await writeFile(join(destination, 'snapshot.json'), JSON.stringify({ dsh: pkg.version, node: process.version, nodeSha256: createHash('sha256').update(await readFile(process.execPath)).digest('hex'), createdAt: new Date().toISOString() }, null, 2));
console.log('Prepared independent DSH runtime and Node binary; no user data copied.');
