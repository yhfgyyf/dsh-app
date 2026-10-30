import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode/lib/server.js';
import { CodexRuntime, deriveCodexUsage } from '../src/codex-runtime.ts';
import { collabOutput, collectCollabUsage } from '../../../src/runtime/collab-usage.ts';

// Opt-in: uses the existing native Codex login and consumes one model turn.
const home = await mkdtemp(join(tmpdir(), 'codex-native-image-'));
const runtime = new CodexRuntime(home, { command: process.env.CODEX_COLLAB_CODEX ?? 'codex', model: process.env.CODEX_COLLAB_MODEL });
const report: any = { native: true, home, startedAt: new Date().toISOString() };
try {
  await runtime.restore(); const { sessionId } = await runtime.create({});
  const data = (await QRCode.toDataURL('CODEX PHONE TEST', { width: 192 })).split(',')[1];
  await runtime.prompt({ sessionId, content: [{ type: 'text', text: 'Inspect the supplied image. Reply briefly whether it is a QR code. Do not call tools, delegate, or access external services.' }, { type: 'image', mediaType: 'image/png', name: 'fixture.png', data }] });
  const deadline = Date.now() + 90000;
  while (runtime.session(sessionId).status === 'running') {
    if (Date.now() > deadline) throw new Error('Native image smoke timed out.');
    if (runtime.pending.size) throw new Error('Native image smoke requires a human response.');
    await new Promise(r => setTimeout(r, 100));
  }
  const inspection = await runtime.inspect(sessionId);
  assert.equal(inspection.events.at(-1).data.reason, 'completed', JSON.stringify(inspection.events.at(-1)));
  const user = runtime.session(sessionId).wireEvents!.find(e => e.type === 'user/message');
  const image = user.data.content.find((p: any) => p.type === 'image'); assert.ok(image, JSON.stringify(user));
  assert.equal((await runtime.attachment(sessionId, image.attachment.attachmentId)).data, data);
  assert.match(collabOutput(inspection), /QR/i);
  Object.assign(report, { passed: true, nativeClient: runtime.app.info.userAgent, model: runtime.session(sessionId).model, image: image.attachment, output: collabOutput(inspection), usage: collectCollabUsage([inspection], deriveCodexUsage) });
} catch (error) { report.passed = false; report.error = error instanceof Error ? error.message : String(error); throw error; }
finally {
  await runtime.stop(); report.finishedAt = new Date().toISOString();
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/native-image.json', JSON.stringify(report, null, 2), { mode: 0o600 });
}
console.log('Native Codex image input, durable phone reference and authenticated image read passed.');
