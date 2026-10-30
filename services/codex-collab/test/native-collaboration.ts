import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { collaborationFixture } from '../../relay/test/collab-fixture.ts';
import { startService } from '../src/daemon.ts';
import { waitFor } from './helpers.ts';

// Opt-in live model execution, with all relay writes confined to an in-memory local fixture.
const relay = await collaborationFixture(), home = await mkdtemp(join(tmpdir(), 'codex-native-collab-'));
const running = await startService(home, { model: process.env.CODEX_COLLAB_MODEL });
const evidence: any = { native: true, relay: 'isolated-local-fixture', home, startedAt: new Date().toISOString() };
try {
  const call = running.service.call;
  await call('remote/register', { relay: relay.origin, code: relay.code, name: 'Native Codex collaboration smoke' });
  const task = await call('collab/create', { operationId: randomUUID(), title: 'Native integration fixture: multiply 6 by 7', description: 'Compute 6 * 7 and write the result followed by a newline to answer.txt. Use only the round directory. Do not use subagents, MCP or network.', acceptance: 'answer.txt contains exactly 42 followed by a newline; provide a brief solution and generated file.' });
  const run = await call('collab/start', { operationId: randomUUID(), taskId: task.id, mode: 'solve', publishMode: 'review', executionMode: 'manual', maxTokens: 300000, maxMinutes: 3 });
  await waitFor(() => running.service.runtime.session(run.sessionId).status === 'idle' || running.service.runtime.pending.size > 0, 180000);
  assert.equal(running.service.runtime.pending.size, 0, 'Native execution needs a human approval.');
  const completed = await call('collab/run', { runId: run.id });
  assert.equal(completed.status, 'completed', completed.stopReason); assert.equal(completed.report.usage.status, 'complete');
  assert.ok(completed.submission, completed.submissionError);
  const answer = completed.submission.files.find((f: any) => f.path === 'answer.txt'); assert.ok(answer);
  const file = await call('collab/generated-file', { runId: run.id, fileId: answer.id });
  assert.equal(Buffer.from(file.data, 'base64').toString(), '42\n');
  assert.equal((await call('collab/detail', { taskId: task.id })).replies.length, 0);
  evidence.passed = true; evidence.run = completed;
} catch (error) { evidence.passed = false; evidence.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await running.close(); await relay.close(); evidence.finishedAt = new Date().toISOString();
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/native-collaboration.json', JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: evidence.passed, error: evidence.error, evidence: 'artifacts/native-collaboration.json' }));
}
