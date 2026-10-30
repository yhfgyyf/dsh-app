import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode/lib/server.js';
import { collaborationFixture } from '../../relay/test/collab-fixture.ts';
import { RemoteTestClient, relayPost } from '../../../tests/remote-client.ts';
import { startService } from '../src/daemon.ts';
import { fakeOptions, waitFor } from './helpers.ts';

async function mux(phone: RemoteTestClient, value: unknown) { phone.send({ type: 'ws_data', channel: 'mux', text: JSON.stringify(value) }); }
async function nextMux(phone: RemoteTestClient) {
  const chunks: Buffer[] = [];
  for (;;) { const frame = await phone.next(); assert.equal(frame.type, 'ws_data'); chunks.push(Buffer.from(frame.data, 'base64')); if (frame.final) return JSON.parse(Buffer.concat(chunks).toString()); }
}
async function untilMux(phone: RemoteTestClient, predicate: (frame: any) => boolean, all: any[] = []) {
  for (let n = 0; n < 200; n++) { const frame = await nextMux(phone); all.push(frame); if (predicate(frame)) return frame; }
  throw new Error('Expected phone event was not received.');
}
async function rpc(phone: RemoteTestClient, method: string, args: any = {}) {
  const result = await phone.http('/api/' + method, Buffer.from(JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } })));
  assert.equal(result.status, 200); const body = JSON.parse(result.body.toString());
  assert.equal(body.result.ok, true, JSON.stringify(body.result.error)); return body.result.value;
}

test('phone pairs over real encrypted relay: history, streaming, approvals, uploads, reconnect and revoke', { timeout: 30000 }, async () => {
  const relay = await collaborationFixture(), home = await mkdtemp(join(tmpdir(), 'codex-phone-'));
  const running = await startService(home, fakeOptions), clients: RemoteTestClient[] = [];
  const originalQR = QRCode.toDataURL; let invitation: any;
  QRCode.toDataURL = (async (text: string, options: any) => { invitation = JSON.parse(text); return originalQR(text, options); }) as any;
  const frames: any[] = [];
  try {
    await running.service.call('remote/register', { relay: relay.origin, code: relay.code, name: 'Codex phone fixture' });
    const pair = await running.service.call('remote/pair'); assert.ok(pair.pairing.qr.startsWith('data:image/png;base64,'));
    const claim = await relayPost(relay.origin, 'claim-qr', { ...invitation.relay, name: 'Fixture Android' });
    assert.equal(claim.status, 201);
    await waitFor(async () => (await running.service.call('remote/state')).devices.some((d: any) => d.id === claim.body.bindingId), 10000);
    await waitFor(async () => (await relayPost(relay.origin, 'status', { bindingId: claim.body.bindingId }, claim.body.bindingToken)).body.state === 'approved', 10000);
    const connect = async () => { const phone = new RemoteTestClient(); clients.push(phone); await phone.connect(relay.origin, claim.body.bindingId, claim.body.bindingToken, invitation.key); return phone; };
    const phone = await connect(), stream = await connect();
    stream.send({ type: 'ws_open', channel: 'mux' }); assert.equal((await stream.next()).type, 'ws_open');
    await mux(stream, { type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } });
    const ready = await nextMux(stream); assert.equal(ready.value.type, 'ready'); const clientId = ready.value.clientId;
    const session = await rpc(phone, 'session/create', { request: {} });
    assert.ok((await rpc(phone, 'session/list')).items.some((s: any) => s.sessionId === session.sessionId));
    await mux(stream, { type: 'open', streamId: 'follow', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: session.sessionId }, assistantStream: true, maxMessages: 2 } } } });
    const snapshot = (await untilMux(stream, f => f.streamId === 'follow' && f.value.type === 'snapshot', frames)).value;
    assert.equal(snapshot.assistantStream.revision, 0);
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=';
    await rpc(phone, 'session/prompt', { request: { sessionId: session.sessionId, requestId: randomUUID(), content: [{ type: 'text', text: 'APPROVAL' }, { type: 'image', mediaType: 'image/png', data: pixel, name: 'pixel.png' }] } });
    const approval = (await untilMux(stream, f => f.value?.type === 'waterfall', frames)).value;
    assert.equal(approval.event, 'approval/request'); assert.equal(running.service.runtime.pending.size, 1);
    await rpc(phone, '$events/result', { clientId, eventId: approval.eventId, outcome: { kind: 'result', value: 'allowed-once' } });
    await untilMux(stream, f => f.value?.type === 'assistant-stream' && f.value.frame.type === 'end', frames);
    await waitFor(() => running.service.runtime.session(session.sessionId).status === 'idle');
    const imageId = running.service.runtime.session(session.sessionId).wireEvents!.find(e => e.type === 'user/message').data.content.find((p: any) => p.type === 'image').attachment.attachmentId;
    const image = await rpc(phone, 'session/attachment', { request: { sessionId: session.sessionId, attachmentId: imageId } });
    assert.equal(image.data, pixel); assert.equal(image.attachment.width, 1);
    const upload = await phone.http('/api/session/uploadFileBinary?sessionId=' + session.sessionId + '&name=notes.txt', Buffer.from('A phone attachment.'));
    assert.equal(upload.status, 200, upload.body.toString()); const receipt = JSON.parse(upload.body.toString()).value; assert.equal(receipt.file.bytes, 19);
    await rpc(phone, 'session/prompt', { request: { sessionId: session.sessionId, requestId: randomUUID(), content: [{ type: 'file', receiptId: receipt.receiptId }, { type: 'text', text: 'SLOW' }] } });
    await untilMux(stream, f => f.value?.type === 'assistant-stream' && f.value.frame.type === 'chunk', frames);
    stream.close();
    const reconnected = await connect(); reconnected.send({ type: 'ws_open', channel: 'mux' }); assert.equal((await reconnected.next()).type, 'ws_open');
    await mux(reconnected, { type: 'open', streamId: 'follow-again', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: session.sessionId }, assistantStream: true, maxMessages: 2 } } } });
    const resumed = (await nextMux(reconnected)).value;
    assert.ok(resumed.assistantStream.revision > snapshot.assistantStream.revision); assert.ok(resumed.assistantStream.activeAttempt.stream.length > 0);
    assert.ok(resumed.hasMore);
    const older = await rpc(phone, 'session/page', { request: { address: { kind: 'session', sessionId: session.sessionId }, throughSeq: resumed.cursor, beforeSeq: resumed.records[0].event.seq, maxMessages: 2 } });
    assert.equal(older.records.at(-1).event.seq, resumed.records[0].event.seq - 1);
    await untilMux(reconnected, f => f.value?.type === 'assistant-stream' && f.value.frame.type === 'end', frames);
    await rpc(phone, 'session/prompt', { request: { sessionId: session.sessionId, requestId: randomUUID(), content: [{ type: 'text', text: 'WAIT' }] } });
    await rpc(phone, 'session/cancel', { request: { sessionId: session.sessionId } });
    await waitFor(() => running.service.runtime.session(session.sessionId).status === 'idle');
    const collaboration = await phone.http('/desktop-collab/identity', Buffer.from(JSON.stringify({ method: 'identity', payload: { args: {} } })));
    assert.equal(JSON.parse(collaboration.body.toString()).result.value.serverPeer.id, running.service.client.data.peerId);
    await running.service.call('remote/revoke', { id: claim.body.bindingId });
    assert.equal((await relayPost(relay.origin, 'ticket', { bindingId: claim.body.bindingId }, claim.body.bindingToken)).status, 403);
    await mkdir('artifacts', { recursive: true });
    await writeFile('artifacts/phone-wire.json', JSON.stringify({ snapshot, resumed, older, frames, image }, null, 2), { mode: 0o600 });
  } finally { QRCode.toDataURL = originalQR; for (const phone of clients) phone.close(); await running.close(); await relay.close(); await rm(home, { recursive: true, force: true }); }
});
