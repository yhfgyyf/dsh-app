import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRuntime, deriveCodexUsage } from '../src/codex-runtime.ts';
import { collectCollabUsage } from '../../../src/runtime/collab-usage.ts';
import { waitFor } from './helpers.ts';

// Explicitly invoked only: this uses the user's native Codex authentication and model.
const home = await mkdtemp(join(tmpdir(), 'codex-native-smoke-'));
let runtime = new CodexRuntime(home, { ...(process.env.CODEX_COLLAB_MODEL ? { model: process.env.CODEX_COLLAB_MODEL } : {}) });
const evidence: any = { home, startedAt: new Date().toISOString(), native: true, rounds: [] };
try {
  await runtime.restore(); const { sessionId } = await runtime.create({});
  evidence.client = runtime.app.info;
  for (const round of [1, 2, 3]) {
    if (round === 3) {
      await runtime.stop(); runtime = new CodexRuntime(home); await runtime.restore();
      assert.equal(runtime.app.generation, 0); assert.equal(runtime.session(sessionId).status, 'idle');
    }
    const cwd = join(home, 'collaboration', 'workspaces', `round-${round}`), name = `proof-${round}.txt`, expected = `codex-collaboration-round-${round}\n`;
    await runtime.prompt({ sessionId, requestId: `native-round-${round}`, cwd, content: [{ type: 'text', text: `This is an authorized local integration test. Write exactly ${JSON.stringify(expected)} to ${name} in the current working directory ${cwd}. Use only this directory, do not read other files or use network, MCP or subagents. Then answer briefly. Do not perform any other work.` }] });
    await waitFor(() => runtime.session(sessionId).status === 'idle' || runtime.pending.size > 0, 180000);
    if (runtime.pending.size) throw new Error('Native test requires a human approval; no approval was inferred.');
    if (runtime.session(sessionId).error) throw new Error(runtime.session(sessionId).error);
    assert.equal(await readFile(join(cwd, name), 'utf8'), expected);
    const usage = collectCollabUsage([await runtime.inspect(sessionId)], deriveCodexUsage);
    assert.equal(usage.status, 'complete'); assert.ok(usage.totals.totalTokens! > 0);
    evidence.rounds.push({ round, cwd, file: name, usage });
  }
  assert.ok(evidence.rounds[1].usage.totals.totalTokens > evidence.rounds[0].usage.totals.totalTokens);
  assert.ok(evidence.rounds[2].usage.totals.totalTokens > evidence.rounds[1].usage.totals.totalTokens);
  evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await runtime.stop(); evidence.finishedAt = new Date().toISOString();
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/native-smoke.json', JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: evidence.passed, error: evidence.error, rounds: evidence.rounds.length, evidence: 'artifacts/native-smoke.json' }));
}
