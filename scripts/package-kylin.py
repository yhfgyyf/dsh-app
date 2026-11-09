"""Package an already-built desktop against the verified LoongArch old-ABI runtime."""
from pathlib import Path
import argparse, datetime, hashlib, json, math, os, re, shutil, stat, struct, subprocess, sys

parser = argparse.ArgumentParser(description=__doc__)
for name in ['base', 'source', 'source-commit', 'work', 'output']:
    parser.add_argument('--' + name, required=True)
parser.add_argument('--runtime-source', help='Fresh tested runtime whose JS dependency graph replaces the previous core')
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

# This runtime is the existing Node22 / Electron31 / ABI1 port, not a host-native rebuild.
base_version = {
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
core = read(source / 'runtime/dependencies.json')['dsh']
runtime_upgrade = None
if args.runtime_source:
    fresh = Path(args.runtime_source).resolve()
    assert read(fresh / 'node_modules/@deepseek-ai/dsh/package.json')['version'] == core
    # These ABI1 builds are deliberately retained at the versions recorded by
    # the verified base. Never copy native binaries from the build host.
    ports = {'koffi', 'node-pty', 'sharp', 'node-addon-require-builtin',
        '@deepseek-ai/node-addon-system-linux-loong64', '@vscode/ripgrep-linux-loong64'}
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
save(runtime / 'runtime.json', meta)
build = read(runtime / 'kylin-build.json')
build.update(app=version, dsh=core, debianVersion=version + '-1', sourceCommit=args.source_commit,
    builtAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), basePackageSha256=sha(archive),
    browserUse='Exclusive official CDP attach on loopback 127.0.0.1:9222 with native LBrowser discovery',
    taskNotifications='Completed/interrupted task notifications; LauncherEntry count plus red numeric window/tray icon for UKUI',
    inheritedValidation={'baseVersion': base_version, 'checks': build.get('currentValidation')},
    currentValidation={'compiledTargets': build_targets['targets'], 'physicalKylinGuiTested': False})
if runtime_upgrade: build['runtimeUpgrade'] = runtime_upgrade
save(runtime / 'kylin-build.json', build)
notes = stage / 'usr/share/doc/dsh-desktop/README.Kylin'
notes.write_text('DSH Desktop ' + version + ' / core ' + core + ' / Kylin V10 old-world ABI1\n\n'
    'Browser Use: see README.Browser-Use. Electron31.7.7, Node22.16.0 and Python3.12.14 retained.\n'
    'Background tasks notify on completion or unexpected interruption. Deliberate Stop is silent.\n'
    'Unread session counts use LauncherEntry plus a red numeric window/tray icon for UKUI.\n'
    'Node22 remains an exception to the upstream Node>=24.9 requirement.\n'
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
    'archiveVerified': True, 'nativeElfFiles': len(native), 'allNativeFilesUnchangedFromBase': True,
    'fileCount': len(files), 'anonymousManifestVerified': True, 'preinstalledUserPlugins': [], 'signed': False}
save(output / 'artifact.json', result); save(output / 'elf-audit.json', native)
save(work / 'payload-manifest.json', files); save(work / 'symlinks.json', links)
shutil.copy2(doc, output / 'BROWSER-USE.md')
(output / 'SHA256SUMS.txt').write_text(result['sha256'] + '  ' + installer.name + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
