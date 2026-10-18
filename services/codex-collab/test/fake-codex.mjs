import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const sessions = new Map();
const requests = new Map();
let initialized = false;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const note = (method, params) => send({ method, params });
async function finish(s, turn, prompt) {
  if (s.turn !== turn) return;
  const text = 'Codex fixture 中文 result';
  if (prompt.includes('submission.json')) {
    const dir = /roundDirectory：([^；]+)/.exec(prompt)?.[1] ?? s.cwd;
    const continuing = prompt.includes('CONTINUE_TWICE') && !s.count;
    await writeFile(join(dir, 'result.txt'), s.count ? '43\n' : '42\n');
    await writeFile(join(dir, 'submission.json'), JSON.stringify({ messageType: continuing ? 'progress' : 'solution', body: `Fixture ${continuing ? 'progress' : 'solution'} with evidence ${s.count ?? 0}.`, verification: 'deterministic test', limitations: '', files: ['result.txt'] }));
    await writeFile(join(dir, 'continuation.json'), JSON.stringify({ action: continuing ? 'continue' : 'ready', summary: continuing ? 'One more fixture round' : 'Fixture complete', nextStep: continuing ? 'Finish CONTINUE_TWICE' : '', wakeOn: [], decisions: [], contribution: { summary: 'Fixture evidence and result file' } }));
  }
  note('item/agentMessage/delta', { threadId: s.id, turnId: turn, itemId: turn + '-answer', delta: text });
  const total = { inputTokens: (s.count ?? 0) * 10 + 10, cachedInputTokens: (s.count ?? 0) * 2 + 2, outputTokens: (s.count ?? 0) * 4 + 4, reasoningOutputTokens: 0, totalTokens: (s.count ?? 0) * 14 + 14 };
  const usage = { threadId: s.id, turnId: turn, tokenUsage: { total, last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4, reasoningOutputTokens: 0, totalTokens: 14 } } };
  if (!prompt.includes('NO_USAGE')) { note('thread/tokenUsage/updated', usage); note('thread/tokenUsage/updated', usage); }
  note('item/completed', { threadId: s.id, turnId: turn, item: { id: turn + '-answer', type: 'agentMessage', text, phase: 'final_answer' } });
  note('turn/completed', { threadId: s.id, turn: { id: turn, status: 'completed', items: [] } });
  s.count = (s.count ?? 0) + 1; s.turn = undefined;
}
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'initialized') { initialized = true; continue; }
  if (!m.method) { const pending = requests.get(m.id); if (pending) { requests.delete(m.id); await finish(...pending); } continue; }
  const p = m.params ?? {};
  if (m.method === 'initialize') { send({ id: m.id, result: { userAgent: 'codex/fixture' } }); continue; }
  if (!initialized) { send({ id: m.id, error: { code: -1, message: 'not initialized' } }); continue; }
  if (m.method === 'thread/start') { const id = randomUUID(), s = { id, cwd: p.cwd }; sessions.set(id, s); send({ id: m.id, result: { thread: { id }, model: 'fixture-model', modelProvider: 'fixture' } }); }
  else if (m.method === 'thread/resume') { sessions.set(p.threadId, { id: p.threadId, cwd: p.cwd }); send({ id: m.id, result: { thread: { id: p.threadId } } }); }
  else if (m.method === 'thread/name/set') send({ id: m.id, result: {} });
  else if (m.method === 'turn/start') {
    const s = sessions.get(p.threadId), turn = randomUUID(), prompt = p.input.map(v => v.text).join('\n'); s.turn = turn; s.cwd = p.cwd ?? s.cwd;
    note('turn/started', { threadId: s.id, turn: { id: turn, status: 'inProgress', items: [] } });
    note('item/completed', { threadId: s.id, turnId: turn, item: { type: 'userMessage', id: turn + '-user', content: p.input } });
    if (prompt.includes('FAST')) await finish(s, turn, prompt);
    send({ id: m.id, result: { turn: { id: turn, status: 'inProgress', items: [] } } });
    if (prompt.includes('APPROVAL')) { const id = randomUUID(); requests.set(id, [s, turn, prompt]); send({ id, method: 'item/commandExecution/requestApproval', params: { threadId: s.id, turnId: turn, itemId: randomUUID(), command: 'fixture command', reason: 'fixture approval' } }); }
    else if (prompt.includes('QUESTION')) { const id = randomUUID(); requests.set(id, [s, turn, prompt]); send({ id, method: 'item/tool/requestUserInput', params: { threadId: s.id, turnId: turn, itemId: randomUUID(), isBlocking: true, questions: [{ id: 'choice', header: 'Choice', question: 'Which?', options: [{ label: 'A', description: 'Option A' }] }] } }); }
    else if (!prompt.includes('FAST') && !prompt.includes('WAIT')) {
      if (prompt.includes('SLOW')) note('item/agentMessage/delta', { threadId: s.id, turnId: turn, itemId: turn + '-answer', delta: 'Partial prefix ' });
      setTimeout(() => { void finish(s, turn, prompt); }, prompt.includes('SLOW') ? 1000 : 20);
    }
  } else if (m.method === 'turn/interrupt') {
    const s = sessions.get(p.threadId); if (s.turn === p.turnId) { note('turn/completed', { threadId: s.id, turn: { id: s.turn, status: 'interrupted', items: [] } }); s.turn = undefined; }
    send({ id: m.id, result: {} });
  } else if (m.method === 'turn/steer') send({ id: m.id, result: { turnId: p.expectedTurnId } });
  else send({ id: m.id, error: { code: -32601, message: 'unsupported fixture method' } });
}
