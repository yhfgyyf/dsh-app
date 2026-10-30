"""One-run relay for the hash-pinned, public 0.1.45 release files only."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from urllib.request import urlopen

plan = json.loads(Path(sys.argv[1]).read_text())
repo = 'yhfgyyf/dsh-app'
release_id = 428552206
target = '7b43480f34b11057946bdefcd358b7ad6fa89d01'
work = Path(os.environ['RUNNER_TEMP']) / 'release-transfer'
work.mkdir()
received = set()
lock = threading.Lock()
helper_id = None
server = None
tunnel = None


def gh(*args):
    return subprocess.check_output(['gh', *args], text=True)


def release():
    r = json.loads(gh('api', f'repos/{repo}/releases/{release_id}'))
    assert r['draft'] and r['tag_name'] == 'v0.1.45' and r['target_commitish'] == target
    return r


def reply(handler, code, data):
    body = json.dumps(data).encode()
    handler.send_response(code)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path != '/status':
            return reply(self, 404, {})
        with lock:
            return reply(self, 200, {'received': sorted(received), 'expected': plan['parts']})

    def do_PUT(self):
        try:
            self.connection.settimeout(180)
            match = re.fullmatch(r'/(\d+)/(\d+)', self.path)
            if not match:
                return reply(self, 404, {})
            asset_id, part_id = map(int, match.groups())
            asset = plan['assets'][asset_id]
            expected_hash = asset['chunks'][part_id]
            length = min(plan['chunkBytes'], asset['bytes'] - part_id * plan['chunkBytes'])
            if int(self.headers.get('Content-Length', '-1')) != length or length <= 0:
                return reply(self, 400, {'error': 'length'})
            data = self.rfile.read(length)
            if len(data) != length or hashlib.sha256(data).hexdigest() != expected_hash:
                return reply(self, 400, {'error': 'hash'})
            dest = work / f'{asset_id}-{part_id}.part'
            with lock:
                if (asset_id, part_id) not in received:
                    dest.write_bytes(data)
                    received.add((asset_id, part_id))
            return reply(self, 200, {'ok': True})
        except (ValueError, IndexError):
            return reply(self, 400, {})


try:
    release()
    metadata = json.loads(gh('api', 'repos/cloudflare/cloudflared/releases/latest'))
    binary = next(a for a in metadata['assets'] if a['name'] == 'cloudflared-linux-amd64')
    assert binary['digest'] and binary['digest'].startswith('sha256:')
    executable = work / 'cloudflared'
    with urlopen(binary['browser_download_url'], timeout=60) as src, executable.open('wb') as dest:
        for block in iter(lambda: src.read(1024 * 1024), b''):
            dest.write(block)
    assert 'sha256:' + hashlib.sha256(executable.read_bytes()).hexdigest() == binary['digest']
    executable.chmod(0o755)
    server = ThreadingHTTPServer(('127.0.0.1', 8376), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tunnel_log = work / 'tunnel.log'
    env = {k: v for k, v in os.environ.items() if k not in ['GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']}
    with tunnel_log.open('w') as log:
        tunnel = subprocess.Popen([str(executable), 'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:8376'], env=env, stdout=log, stderr=log)
    url = None
    for _ in range(60):
        match = re.search(r'https://[-a-z0-9]+\.trycloudflare\.com', tunnel_log.read_text())
        if match:
            url = match.group()
            break
        assert tunnel.poll() is None, 'Tunnel did not start'
        time.sleep(1)
    assert url, 'No tunnel URL'
    helper = work / ('upload-relay-' + os.environ['GITHUB_RUN_ID'] + '.json')
    helper.write_text(json.dumps({'url': url, 'chunkBytes': plan['chunkBytes'], 'parts': plan['parts'], 'assets': [{k: a[k] for k in ['name', 'bytes', 'sha256']} for a in plan['assets']]}))
    gh('release', 'upload', 'v0.1.45', '--repo', repo, str(helper))
    helper_id = next(a['id'] for a in release()['assets'] if a['name'] == helper.name)
    print('Relay metadata ready:', helper.name, flush=True)
    deadline = time.monotonic() + 900
    previous = -1
    while True:
        with lock:
            count = len(received)
        if count != previous:
            print('Verified chunks:', count, '/', plan['parts'], flush=True)
            previous = count
        if count == plan['parts']:
            break
        assert time.monotonic() < deadline, 'Timed out waiting for the pinned files'
        time.sleep(1)
    for asset_id, asset in enumerate(plan['assets']):
        path = work / asset['name']
        h = hashlib.sha256()
        with path.open('wb') as dest:
            for part_id in range(len(asset['chunks'])):
                data = (work / f'{asset_id}-{part_id}.part').read_bytes()
                dest.write(data)
                h.update(data)
        assert path.stat().st_size == asset['bytes'] and h.hexdigest() == asset['sha256']
        existing = [a for a in release()['assets'] if a['name'] == asset['name']]
        if not existing:
            gh('release', 'upload', 'v0.1.45', '--repo', repo, str(path))
        uploaded = next(a for a in release()['assets'] if a['name'] == asset['name'])
        assert uploaded['state'] == 'uploaded' and uploaded['size'] == asset['bytes'] and uploaded['digest'] == 'sha256:' + asset['sha256']
        print('Release file verified:', asset['name'], flush=True)
finally:
    if helper_id:
        gh('api', '--method', 'DELETE', f'repos/{repo}/releases/assets/{helper_id}')
    if tunnel:
        tunnel.terminate()
        tunnel.wait(timeout=15)
    if server:
        server.shutdown()
