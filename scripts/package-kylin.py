"""Package an already-built desktop against the verified LoongArch old-ABI runtime."""
from pathlib import Path
import argparse, datetime, hashlib, json, math, os, re, shutil, stat, struct, subprocess, sys

parser = argparse.ArgumentParser(description=__doc__)
for name in ['base', 'source', 'source-commit', 'work', 'output']:
    parser.add_argument('--' + name, required=True)
parser.add_argument('--runtime-source', help='Fresh tested runtime whose JS dependency graph replaces the previous core')
parser.add_argument('--node-distribution', help='Relocatable Node SDK installed from the validated old-world build')
parser.add_argument('--node-sha256', help='SHA-256 of the Node executable tested on the old system image')
parser.add_argument('--builtin-binding', help='require_builtin.node built and tested against the bundled Node SDK')
parser.add_argument('--builtin-sha256', help='SHA-256 of that tested Node ABI binding')
args = parser.parse_args()
source, work, output = (Path(value).resolve() for value in [args.source, args.work, args.output])
archive = Path(args.base).resolve()
def read(path): return json.loads(path.read_text())
def save(path, value): path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()
def copy(a, b):
    subprocess.run(['cp', '-cR' if sys.platform == 'darwin' else '-a', str(a), str(b)], check=True)

# Preserve the reviewed Electron shell and old-world native providers from this base.
base_version = {
    '69df3d458308bf436405e35bbe6069c117fd335b1d121dcd26cc3a84fbde06b3': '0.1.56-1',
    'f0929fa2a090b5d7852f2f44054508b734a6567421d87858f962fb8c3d93ace2': '0.1.54-1',
    '2e8c4586c4fa239050af8e7214e02b0d0089e42d7be0997da2b4381842217491': '0.1.46-1',
    '855025b3b08b333c761a3247bff20c13083b2418a70862b5068a323e52328294': '0.1.48-1',
    'e2b81b7439b45e0b716362fa416b94ca15b10c368d4bd8540700f8b1ec3f450c': '0.1.49-1',
}[sha(archive)]
assert not work.exists() and not output.exists(), 'Keep previous builds; use new work/output directories'
version = read(source / 'package.json')['version']
assert re.fullmatch(r'\d+\.\d+\.\d+', version)
build_targets = read(source / 'kylin-build-targets.json')
assert build_targets['targets'] == ['node20', 'chrome126']
assert sha(source / 'scripts/build.ts') == build_targets['buildScriptAfterSha256']
work.mkdir(parents=True)
base, stage, verify = (work / name for name in ['base', 'stage', 'verification'])
subprocess.run(['dpkg-deb', '-x', str(archive), str(base)], check=True)
subprocess.run(['dpkg-deb', '-e', str(archive), str(base / 'DEBIAN')], check=True)
copy(base, stage)
app, runtime = (stage / 'opt/dsh-desktop/resources' / name for name in ['app', 'runtime'])
assert read(runtime / 'kylin-build.json')['debianVersion'] == base_version
pins = read(source / 'runtime/dependencies.json')
core = pins['dsh']
node_replaced = bool(args.node_distribution)
if core == '0.2.3-alpha.2' and not node_replaced:
    previous = read(runtime / 'kylin-build.json')
    if previous['node'] != pins['node'] or previous.get('nodeSha256') != sha(runtime / 'node/bin/node'):
        raise ValueError('This core requires the tested Node 24.22.3 old-world SDK')
if node_replaced:
    if not (args.runtime_source and args.builtin_binding and args.builtin_sha256):
        raise ValueError('A Node SDK upgrade needs its matching builtin loader and JS runtime')
    sdk = Path(args.node_distribution).resolve()
    assert sha(sdk / 'bin/node') == args.node_sha256
    header = (sdk / 'include/node/node_version.h').read_text()
    built_version = '.'.join(re.search(r'^#define NODE_' + part + r'_VERSION\s+(\d+)', header, re.M)[1]
                             for part in ('MAJOR', 'MINOR', 'PATCH'))
    assert built_version == pins['node']
    node_abi = re.search(r'^#define NODE_MODULE_VERSION (\d+)$', header, re.M)[1]
    binding = Path(args.builtin_binding).resolve()
    assert sha(binding) == args.builtin_sha256
    shutil.rmtree(runtime / 'node')
    copy(sdk, runtime / 'node')
    assert 'node/bin/node' in (runtime / 'bin/node').read_text(), 'Expected the Desktop Node launcher'
runtime_upgrade = None
if args.runtime_source:
    fresh = Path(args.runtime_source).resolve()
    assert read(fresh / 'node_modules/@deepseek-ai/dsh/package.json')['version'] == core
    # These ABI1 builds are deliberately retained at the versions recorded by
    # the verified base. Never copy native binaries from the build host.
    ports = {'koffi', 'node-pty', 'sharp', 'node-addon-require-builtin',
        '@deepseek-ai/node-addon-system-linux-loong64', '@vscode/ripgrep-linux-loong64'}
    if node_replaced:
        ports.remove('node-addon-require-builtin')
    def packages(root):
        paths = list(root.glob('*/package.json')) + list(root.glob('@*/*/package.json'))
        return {read(p)['name']: p.parent for p in paths}
    old_packages, new_packages = packages(runtime / 'node_modules'), packages(fresh / 'node_modules')
    assert all(name in old_packages for name in ports)
    speech = '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice'
    speech_originals = {'index.js': '286792bd82085586fbb0869aa32b3e3733425b4059a517465abed97dd710a15a',
        'worker.js': 'cf530352910d233d96eed917a7ff5ef8b64632491c3cd2ebfdc89377eb24a2ec'}
    speech_port = work / 'speech-port'
    copy(old_packages[speech], speech_port)
    for name, expected in speech_originals.items():
        assert sha(new_packages[speech] / 'lib' / name) == expected, 'Rebase the offline LoongArch speech port'
    installed = []
    for name, directory in new_packages.items():
        if name in ports:
            continue
        metadata = read(directory / 'package.json')
        def accepts(values, target):
            return not values or target not in [v[1:] for v in values if v.startswith('!')] and (not any(not v.startswith('!') for v in values) or target in values)
        if not accepts(metadata.get('os'), 'linux') or not accepts(metadata.get('cpu'), 'loong64'):
            continue
        # The Office package publishes frame-forwarding addons for macOS and Windows.
        # On Linux its supported frontend is the optional WASM package.
        if name == '@deepseek-ai/libreoffice-kit':
            directory_copy = work / 'libreoffice-kit'
            copy(directory, directory_copy)
            prebuilds = directory_copy / 'frame-forwarding/prebuilds'
            if prebuilds.exists():
                for platform in ('darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64'):
                    if (prebuilds / platform).is_dir(): shutil.rmtree(prebuilds / platform)
            directory = directory_copy
        for path in directory.rglob('*'):
            if path.is_file():
                with path.open('rb') as f: header = f.read(4)
                assert header[:2] != b'MZ' and header not in [b'\x7fELF', *[bytes.fromhex(x) for x in ['cffaedfe', 'feedfacf', 'cafebabe']]], 'Unreviewed host-native file: ' + str(path)
        target = runtime / 'node_modules' / name
        if target.is_symlink(): target.unlink()
        elif target.exists(): shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        copy(directory, target)
        installed.append({'name': name, 'version': metadata['version']})
    if node_replaced:
        builtin = runtime / 'node_modules/node-addon-require-builtin'
        builtin_target = builtin / 'build/nodeabi' / f'node-v{node_abi}-linux-loong64-gnu/require_builtin.node'
        builtin_target.parent.mkdir(parents=True)
        shutil.copy2(binding, builtin_target)
    target_speech = runtime / 'node_modules' / speech
    for name in speech_originals: shutil.copy2(speech_port / 'lib' / name, target_speech / 'lib' / name)
    assert sha(speech_port / 'runtime/assets.json') == sha(target_speech / 'runtime/assets.json')
    shutil.rmtree(target_speech / 'runtime')
    copy(speech_port / 'runtime', target_speech / 'runtime')
    for name in ['app', 'plugins']:
        shutil.rmtree(runtime / name)
        copy(fresh / name, runtime / name)
    metadata = read(fresh / 'package.json')
    metadata.setdefault('overrides', {}).update({'koffi': read(old_packages['koffi'] / 'package.json')['version'], 'sharp': read(old_packages['sharp'] / 'package.json')['version']})
    save(runtime / 'package.json', metadata)
    runtime_upgrade = {'core': core, 'copiedPackages': installed,
        'retainedNativePackages': {name: read(old_packages[name] / 'package.json')['version'] for name in sorted(ports)},
        'offlineSpeechPortPreserved': True}
else:
    assert read(runtime / 'node_modules/@deepseek-ai/dsh/package.json')['version'] == core, 'A core upgrade requires --runtime-source'
shutil.rmtree(app / 'dist')
copy(source / 'dist', app / 'dist')
for path in [app / 'dist', *(app / 'dist').rglob('*')]:
    assert not path.is_symlink()
    path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
package = read(app / 'package.json'); package['version'] = version; save(app / 'package.json', package)
for name in ['README.md', 'README.en.md']: shutil.copy2(source / name, app / name)
for directory in ['app', 'node_modules/dsh-desktop-surface']:
    shutil.copy2(source / '.runtime' / directory / 'desktop.patch.yml', runtime / directory / 'desktop.patch.yml')
    for name in ['index.ts', 'browser-use.ts', 'task-notifications.ts']:
        target = runtime / directory / name
        shutil.copy2(source / 'dist/runtime' / name, target); target.chmod(0o644)
for name in ['browser-use.js', 'task-notifications.js']:
    compiled = runtime / 'node_modules/dsh-desktop-surface' / name
    shutil.copy2(source / '.runtime/node_modules/dsh-desktop-surface' / name, compiled); compiled.chmod(0o644)
for relative, mode in [('usr/bin/dsh-browser-cdp', 0o755), ('usr/share/applications/dsh-browser-cdp.desktop', 0o644)]:
    target = stage / relative
    shutil.copy2(source / 'scripts/kylin' / target.name, target); target.chmod(mode)
subprocess.run(['/bin/sh', '-n', str(stage / 'usr/bin/dsh-browser-cdp')], check=True)
doc = stage / 'usr/share/doc/dsh-desktop/README.Browser-Use'
shutil.copy2(source / 'docs/KYLIN_BROWSER_USE.md', doc); doc.chmod(0o644)
meta = read(runtime / 'runtime.json')
meta.update(desktopVersion=version, desktopPackageVersion=version + '-1', dsh=core)
if node_replaced:
    meta.update(node=pins['node'], nodeCompatibility='Old-world ABI1 build meeting the upstream engine requirement on glibc 2.28.')
save(runtime / 'runtime.json', meta)
build = read(runtime / 'kylin-build.json')
build.update(app=version, dsh=core, debianVersion=version + '-1', sourceCommit=args.source_commit,
    builtAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), basePackageSha256=sha(archive),
    browserUse='Exclusive official CDP attach on loopback 127.0.0.1:9222 with native LBrowser discovery',
    taskNotifications='Completed/interrupted task notifications; LauncherEntry count plus red numeric window/tray icon for UKUI',
    inheritedValidation={'baseVersion': base_version, 'checks': build.get('currentValidation')},
    currentValidation={'compiledTargets': build_targets['targets'], 'physicalKylinGuiTested': False})
if node_replaced:
    build.update(node=pins['node'], nodeSha256=args.node_sha256, upstreamMinimumNode=pins['node'], nodeRequirementException=False)
    build['hostDependencyFix'].update(version=read(builtin / 'package.json')['version'],
        node=pins['node'], abi='node-v' + node_abi, nativeSha256=args.builtin_sha256,
        nativeSourceArchiveSha256='8a8d738ec4601ef362cb011f13b39568abd8d26d174cf60eee17261ed91f725f')
if runtime_upgrade: build['runtimeUpgrade'] = runtime_upgrade
save(runtime / 'kylin-build.json', build)
notes = stage / 'usr/share/doc/dsh-desktop/README.Kylin'
notes.write_text('DSH Desktop ' + version + ' / core ' + core + ' / Kylin V10 old-world ABI1\n\n'
    f"Browser Use: see README.Browser-Use. Electron {build['electron']}, Node {build['node']}, Python {build['python']}.\n"
    'Background tasks notify on completion or unexpected interruption. Deliberate Stop is silent.\n'
    'Unread session counts use LauncherEntry plus a red numeric window/tray icon for UKUI.\n'
    'No user extensions are preinstalled; existing user profiles/plugins are preserved.\n'
    'Physical Kylin/LBrowser GUI has not been tested for this package.\n')
assert read(runtime / 'node_modules/@deepseek-ai/dsh/package.json')['version'] == core
assert read(runtime / 'local-plugins/package.json') == {'private': True}
assert [p.name for p in (runtime / 'local-plugins').iterdir()] == ['package.json']
for name in ['dsh-p2p-collab', 'dsh-side-chat', 'dsh-univer-office', 'dsh-whale-widget', 'rea-mcp']:
    assert not (runtime / 'node_modules' / name).exists() and not (runtime / 'plugins' / name).exists(), name
for name in read(runtime / 'package.json')['dependencies']:
    assert read(runtime / 'node_modules' / name / 'package.json')['name'] == name, name

files, links, native, md5 = [], [], [], []
for path in stage.rglob('*'):
    rel = path.relative_to(stage).as_posix()
    if path.is_symlink():
        assert path.resolve().exists() and stage in path.resolve().parents
        links.append({'path': rel, 'target': os.readlink(path)}); continue
    if not path.is_file(): continue
    with path.open('rb') as f: header = f.read(64)
    if header[:4] == b'\x7fELF':
        assert header[4:6] == b'\x02\x01' and struct.unpack_from('<H', header, 18)[0] == 258
        assert struct.unpack_from('<I', header, 48)[0] == 3, rel
        if node_replaced and path == runtime / 'node/bin/node':
            assert sha(path) == args.node_sha256
        elif node_replaced and path == builtin_target:
            assert sha(path) == args.builtin_sha256
        else:
            assert sha(path) == sha(base / rel), 'Native binary changed: ' + rel
        native.append({'path': rel, 'sha256': sha(path), 'machine': 258, 'flags': '0x3'})
    else:
        assert header[:2] != b'MZ' and header[:4] not in [bytes.fromhex(x) for x in ['cffaedfe', 'feedfacf', 'cafebabe']], rel
    if rel.startswith('DEBIAN/'): continue
    files.append({'path': rel, 'bytes': path.stat().st_size, 'mode': stat.S_IMODE(path.stat().st_mode), 'sha256': sha(path)})
    md5.append(hashlib.md5(path.read_bytes()).hexdigest() + '  ' + rel)
assert len(native) == 92
control = stage / 'DEBIAN/control'
text = re.sub(r'^Version:.*$', 'Version: ' + version + '-1', control.read_text(), flags=re.M)
text = re.sub(r'^Installed-Size:.*$', 'Installed-Size: ' + str(math.ceil(sum(f['bytes'] for f in files) / 1024)), text, flags=re.M)
control.write_text(text)
(stage / 'DEBIAN/md5sums').write_text('\n'.join(sorted(md5)) + '\n')
output.mkdir(parents=True)
installer = output / ('DSH-Desktop-' + version + '-Kylin-V10-loongarch64.deb')
partial = installer.with_suffix('.deb.part')
subprocess.run(['dpkg-deb', '--root-owner-group', '--build', str(stage), str(partial)], check=True)
subprocess.run(['dpkg-deb', '-x', str(partial), str(verify)], check=True)
for row in files:
    path = verify / row['path']
    assert not path.is_symlink() and path.stat().st_size == row['bytes'] and sha(path) == row['sha256'] and stat.S_IMODE(path.stat().st_mode) == row['mode'], row['path']
assert {p.relative_to(verify).as_posix() for p in verify.rglob('*') if p.is_file() and not p.is_symlink()} == {r['path'] for r in files}
for row in links: assert os.readlink(verify / row['path']) == row['target']
assert subprocess.check_output(['dpkg-deb', '-f', str(partial), 'Version'], text=True).strip() == version + '-1'
partial.rename(installer)
result = {**build, 'installer': str(installer), 'sha256': sha(installer), 'bytes': installer.stat().st_size,
    'archiveVerified': True, 'nativeElfFiles': len(native), 'allNativeFilesUnchangedFromBase': not node_replaced,
    'fileCount': len(files), 'anonymousManifestVerified': True, 'preinstalledUserPlugins': [], 'signed': False}
save(output / 'artifact.json', result); save(output / 'elf-audit.json', native)
save(work / 'payload-manifest.json', files); save(work / 'symlinks.json', links)
shutil.copy2(doc, output / 'BROWSER-USE.md')
(output / 'SHA256SUMS.txt').write_text(result['sha256'] + '  ' + installer.name + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
