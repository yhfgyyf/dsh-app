"""Rebuild the published Kylin require-builtin port against the matching Node SDK."""
import argparse
import hashlib
import json
import subprocess
import tarfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
for name in ('archive', 'sdk', 'cxx', 'work'):
    parser.add_argument('--' + name, required=True, type=Path)
args = parser.parse_args()
archive, sdk, compiler, work = (p.resolve() for p in (args.archive, args.sdk, args.cxx, args.work))
# Source and original build command were published with DSH Desktop v0.1.45.
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
assert digest == '8a8d738ec4601ef362cb011f13b39568abd8d26d174cf60eee17261ed91f725f'
work.mkdir(parents=True, exist_ok=False)
with tarfile.open(archive) as src:
    src.extractall(work, filter='data')
with tarfile.open(work / 'build-dependencies/node-addon-api-8.9.0.tgz') as headers:
    headers.extractall(work / 'node-addon-api', filter='data')
command = json.loads((work / 'build-and-tests/build-command.json').read_text())
command[0] = str(compiler)
command[command.index('-std=c++2a')] = '-std=c++20'
for i, arg in enumerate(command):
    if arg.startswith('-I') and '/headers/' in arg:
        command[i] = '-I' + str(sdk / 'include/node')
    elif arg.startswith('-I') and '/node-addon-api/' in arg:
        command[i] = '-I' + str(work / 'node-addon-api/package')
    elif '/addon-source/' in arg:
        command[i] = str(work / 'addon-source' / arg.split('/addon-source/')[1])
command[command.index('-o') + 1] = str(work / 'require_builtin.node')
subprocess.run(command, check=True)
