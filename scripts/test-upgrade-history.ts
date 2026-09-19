import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { DesktopRuntime } from '../src/main/runtime.ts';
import { connectFixture } from '../tests/fixture-client.ts';

// Only copied logs are mounted. The source argument is never hydrated by DSH.
const root = fileURLToPath(new URL('..', import.meta.url));
const sourceArgument = process.argv[2];
assert.ok(sourceArgument, 'Usage: node scripts/test-upgrade-history.ts <backup-sessions-directory>');
const source = await realpath(resolve(sourceArgument));
const runtimeRoot = resolve(process.env.DSH_TEST_DESKTOP_RUNTIME ?? join(root, '.runtime'));
await mkdir(join(root, '.test-data'), { recursive: true });
await mkdir(join(root, 'docs/evidence'), { recursive: true });
const data = await mkdtemp(join(root, '.test-data/upgrade-history-'));
const home = join(data, 'home');
const copied = join(home, 'sessions');
const state = join(data, 'state');
await mkdir(home);
await mkdir(state);
const logName = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/;
type Log = { path: string; sha256: string; bytes: number };
async function inventory(directory: string): Promise<Log[]> {
  const logs: Log[] = [];
  async function walk(dir: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'History fixture refuses symbolic links');
      if (entry.isDirectory()) await walk(path);
      else if (logName.test(entry.name)) {
        const bytes = await readFile(path);
        logs.push({ path: relative(directory, path), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
      }
    }
  }
  await walk(directory);
  return logs;
}
function aggregate(logs: Log[]) {
  return createHash('sha256').update(JSON.stringify(logs)).digest('hex');
}
function rowsOf(buffer: Buffer, compressed: boolean): any[] {
  const decoded: Buffer[] = [];
  if (!compressed) decoded.push(buffer);
  // Node decodes one Zstd frame per call; bytesWritten is the consumed frame length.
  while (compressed && buffer.length > 0) {
    const frame = zstdDecompressSync(buffer, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    assert.ok(frame.engine.bytesWritten > 0 && frame.engine.bytesWritten <= buffer.length);
    decoded.push(frame.buffer);
    buffer = buffer.subarray(frame.engine.bytesWritten);
  }
  return Buffer.concat(decoded).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function failureType(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.match(/"code"\s*:\s*"([a-zA-Z0-9_/-]+)"/)?.[1]
    ?? (text.includes('timed out') ? 'timeout' : error instanceof Error ? error.name : 'unknown');
}
const before = await inventory(source);
assert.ok(before.length > 0, 'Backup must contain session logs');
await cp(source, copied, { recursive: true, filter: path => !basename(path).endsWith('.lock') });
const copiedBefore = await inventory(copied);
assert.deepEqual(copiedBefore, before);
for (const log of copiedBefore) await chmod(join(copied, log.path), 0o444);
await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n', { mode: 0o600 });
// Reading Audit history must not launch its default external reviewer companion.
await writeFile(join(state, 'desktop.patch.yml'), '- id: audit-bundle\n  config:\n    enabled: false\n', { mode: 0o600 });
const latest = new Map<string, Log>();
for (const log of copiedBefore) {
  const dir = dirname(log.path);
  const rank = (path: string) => Number(basename(path).match(/\.v(\d+)/)?.[1] ?? 0);
  if (!latest.has(dir) || rank(log.path) > rank(latest.get(dir)!.path)) latest.set(dir, log);
}
const catalog: { sessionId: string; preset: string; initialPreset: string; version: number; events: number; log: string }[] = [];
const scanFailures: { log: string; type: string }[] = [];
for (const log of latest.values()) {
  try {
    const rows = rowsOf(await readFile(join(copied, log.path)), log.path.endsWith('.zstd'));
    const header = rows[0];
    let preset = header.agentPreset ?? 'unspecified';
    for (const row of rows) if (row.type === 'agent-preset/selected') preset = row.data.agentPreset;
    catalog.push({ sessionId: header.id, preset, initialPreset: header.agentPreset ?? 'unspecified', version: header.version, events: rows.length - 1, log: log.path });
  } catch (error) { scanFailures.push({ log: log.path, type: failureType(error) }); }
}
const counts: Record<string, number> = {};
for (const session of catalog) counts[session.preset] = (counts[session.preset] ?? 0) + 1;
const results: any[] = [];
const runtimeMessages: Record<string, number> = {};
const print = console.log.bind(console);
// Runtime failures can contain user text or paths; retain only diagnostic categories.
console.log = (...values: unknown[]) => {
  const text = values.map(String).join(' ');
  const category = /background activation/.test(text) ? 'background-activation'
    : /EACCES|EPERM|permission denied/.test(text) ? 'readonly-permission'
    : /error|failed|invalid|corrupt/i.test(text) ? 'other-error'
    : 'other';
  runtimeMessages[category] = (runtimeMessages[category] ?? 0) + 1;
};
const core = new DesktopRuntime({ runtimeRoot, entry: join(runtimeRoot, 'app/index.ts'), home: state, configHome: home, cwd: data, onExit: () => {} });
let client: Awaited<ReturnType<typeof connectFixture>> | undefined;
let listCount = 0;
let missingFromList = 0;
let status = 'pass';
try {
  const ready = await core.start();
  const connection = join(data, 'connection.json');
  await writeFile(connection, JSON.stringify({ owner: 'dsh-desktop-test', ...ready }), { mode: 0o600 });
  client = await connectFixture(connection);
  const { items } = await client.rpc('session/list', { _request: {} });
  listCount = items.length;
  const listed = new Set(items.map((item: any) => item.sessionId));
  missingFromList = catalog.filter(item => !listed.has(item.sessionId)).length;
  for (const preset of ['standard', 'ptc', 'audit', 'auto']) {
    const candidate = catalog.filter(item => item.preset === preset && listed.has(item.sessionId))
      .sort((a, b) => b.events - a.events)[0];
    if (!candidate) { results.push({ preset, status: 'missing-representative' }); continue; }
    const history = client.follow('session/follow', { request: { address: { kind: 'session', sessionId: candidate.sessionId }, maxMessages: 10 } });
    try {
      await history.wait(frames => frames.some(frame => frame.type === 'snapshot'), 20000);
      const snapshot = history.frames.find(frame => frame.type === 'snapshot');
      assert.equal(snapshot.header.id, candidate.sessionId);
      assert.ok(snapshot.records.length > 0, 'Representative must contain readable history');
      assert.equal(snapshot.projections.values.agentPreset, preset);
      results.push({ preset, status: 'pass', sourceVersion: candidate.version, sourceEvents: candidate.events, snapshotRecords: snapshot.records.length, cursor: snapshot.cursor, hasMore: snapshot.hasMore, projectionMatches: true, log: candidate.log });
    } catch (error) { results.push({ preset, status: 'failed', failureType: failureType(error), log: candidate.log }); }
    finally { history.close(); }
  }
} catch (error) {
  status = 'failed';
  results.push({ status: 'failed', phase: 'boot-or-list', failureType: failureType(error) });
} finally {
  client?.close();
  await core.stop();
  console.log = print;
}
const after = await inventory(source);
const copiedAfter = await inventory(copied);
const copiedMap = new Map(copiedAfter.map(log => [log.path, log]));
const changedCopies = before.filter(log => copiedMap.get(log.path)?.sha256 !== log.sha256);
const addedCopies = copiedAfter.filter(log => !before.some(item => item.path === log.path));
const sourceUnchanged = aggregate(before) === aggregate(after);
if (!sourceUnchanged || changedCopies.length > 0 || missingFromList > 0 || scanFailures.length > 0 || results.some(item => item.status !== 'pass')) status = 'failed';
const report = {
  at: new Date().toISOString(), status, runtimeRoot, data,
  scope: 'Backup copied to isolated DSH_HOME; copied existing logs chmod 0444; list and follow only; no prompt or model request; Audit reviewer disabled in test-only patch',
  counts: { logFiles: before.length, sessionDirectoriesWithLogs: latest.size, listed: listCount, missingFromList, byFinalPreset: counts, originalLogsChanged: sourceUnchanged ? 0 : 1, copiedExistingLogsChanged: changedCopies.length, copiedLogsAdded: addedCopies.length },
  sourceDigestBefore: aggregate(before), sourceDigestAfter: aggregate(after), copiedDigestBefore: aggregate(copiedBefore), copiedDigestAfter: aggregate(copiedAfter),
  results, scanFailures, runtimeMessages,
  logs: before.map(log => ({ ...log, sourceAfter: after.find(item => item.path === log.path)?.sha256, copiedAfter: copiedMap.get(log.path)?.sha256 })),
  addedCopies,
};
await writeFile(join(root, 'docs/evidence/upgrade-history-alpha2.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
print(JSON.stringify({ status, counts: report.counts, representatives: results.map(({ preset, status, sourceVersion, snapshotRecords, failureType }) => ({ preset, status, sourceVersion, snapshotRecords, failureType })), sourceUnchanged, runtimeMessages }));
if (status !== 'pass') process.exitCode = 1;
