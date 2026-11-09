import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const fixtures = join(root, 'tests/compatibility/rc1');
const data = join(root, '.test-data/rc1-plugins');
const manifest = JSON.parse(await readFile(join(fixtures, 'inputs.json'), 'utf8'));
assert.equal(JSON.parse(await readFile(join(root, '.runtime/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version, manifest.core);
await mkdir(data, { recursive: true });
const extract = async (archive, directory) => {
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.ok(names.every(name => name.startsWith('package/') && !name.includes('\\') && !name.split('/').includes('..')));
  await mkdir(directory, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', directory]);
  return join(directory, 'package');
};
for (const [name, pin] of Object.entries(manifest.archives)) {
  const bytes = await readFile(join(fixtures, name));
  assert.equal(bytes.length, pin.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
}
const side = await extract(join(fixtures, 'dsh-side-chat-0.1.8.tgz'), join(data, 'side'));
const p2p = await extract(join(fixtures, 'dsh-p2p-collab-0.3.4.tgz'), join(data, 'p2p'));
assert.equal(JSON.parse(await readFile(join(side, 'package.json'), 'utf8')).version, '0.1.8');
assert.equal(JSON.parse(await readFile(join(p2p, 'package.json'), 'utf8')).version, '0.3.4');
await cp(side, join(fixtures, 'side/dist/package'), { recursive: true });
// Replace only the disposable build fixture, never a user-installed package.
for (const relative of ['plugins/dsh-p2p-collab', 'node_modules/dsh-p2p-collab']) {
  const directory = join(root, '.runtime', relative);
  assert.equal(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).name, 'dsh-p2p-collab');
  await rm(directory, { recursive: true });
  await cp(p2p, directory, { recursive: true });
}
const original = await extract(join(data, 'dsh-univer-office-0.3.5-universal.2.tgz'), join(data, 'univer-original'));
const univer = await extract(join(data, 'delivered/dsh-univer-office-0.3.5-universal.3.tgz'), join(data, 'univer'));
const reviewed = JSON.parse(await readFile(join(fixtures, 'univer-provenance.json'), 'utf8'));
for (const entry of reviewed.files) assert.equal(createHash('sha256').update(await readFile(join(univer, entry.path))).digest('hex'), entry.sha256, entry.path);
await writeFile(join(data, 'prepared.json'), JSON.stringify({ core: manifest.core, desktop: manifest.desktop, side, p2p, original, univer, checkedArchiveHashes: manifest.archives, univerPayloadMatchesMacArchive: true }, null, 2));
console.log('Exact delivered Side/P2P archives and every reviewed Univer payload file verified.');
