import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { clientProof, createClientCipher, type SecureCipher } from '../src/runtime/remote/e2ee.ts';
const WebSocket = createRequire(new URL('../.runtime/package.json', import.meta.url))('ws');
export async function relayPost(origin: string, path: string, body: unknown, token?: string) {
  const response = await fetch(origin + '/v1/' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
export class RemoteTestClient {
  socket: any;
  cipher?: SecureCipher;
  id = '';
  private frames: any[] = [];
  private waiter?: () => void;
  private closed = false;
  async connect(origin: string, bindingId: string, bindingToken: string, key: string) {
    const ticket = await relayPost(origin, 'ticket', { bindingId }, bindingToken);
    if (ticket.status !== 200) throw new Error(`ticket ${ticket.status}`);
    this.id = ticket.body.accessSessionId;
    this.socket = new WebSocket(origin.replace(/^http/, 'ws') + '/v1/tunnel');
    this.socket.on('message', (raw: Buffer) => { const m = JSON.parse(raw.toString()); this.frames.push(m.type === 'sealed' ? this.cipher!.open(m) : m); this.waiter?.(); });
    this.socket.on('error', () => {});
    this.socket.on('close', () => { this.closed = true; this.waiter?.(); });
    await new Promise<void>((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
    this.socket.send(JSON.stringify({ type: 'auth', ticket: ticket.body.ticket }));
    await this.next();
    const random = randomBytes(32).toString('base64url');
    this.socket.send(JSON.stringify({ type: 'client_hello', accessSessionId: this.id, clientRandomB64: random, clientProofB64: clientProof(key, this.id, random) }));
    const hello = await this.next();
    this.cipher = createClientCipher(key, this.id, random, hello);
  }
  send(value: unknown) { this.socket.send(JSON.stringify({ type: 'sealed', accessSessionId: this.id, ...this.cipher!.seal(value) })); }
  async next(): Promise<any> {
    const deadline = Date.now() + 10000;
    while (!this.frames.length) {
      if (this.closed) throw new Error('closed');
      if (Date.now() > deadline) throw new Error('frame timeout');
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 200); this.waiter = () => { clearTimeout(timer); resolve(); }; });
    }
    return this.frames.shift();
  }
  async http(path: string, body = Buffer.from('{"args":{}}'), method = 'POST') {
    const channel = 'test_' + randomBytes(6).toString('hex');
    this.send({ type: 'http_open', channel, method, path, length: body.length, contentType: 'application/json' });
    let frame = await this.next();
    if (frame.type !== 'http_ack') throw new Error('request refused');
    let seq = 0;
    for (let offset = 0; offset < body.length; offset += 49152) {
      this.send({ type: 'http_data', channel, seq: seq++, data: body.subarray(offset, offset + 49152).toString('base64') });
      frame = await this.next(); if (frame.type !== 'http_ack') throw new Error('upload failed');
    }
    this.send({ type: 'http_end', channel });
    const head = await this.next(), chunks: Buffer[] = []; seq = 0;
    while (true) {
      frame = await this.next();
      if (frame.type === 'http_end') break;
      if (frame.type !== 'http_data' || frame.seq !== seq++) throw new Error('response failed');
      chunks.push(Buffer.from(frame.data, 'base64'));
      this.send({ type: 'http_response_ack', channel, seq: frame.seq });
    }
    return { status: head.status, body: Buffer.concat(chunks) };
  }
  close() { this.socket?.terminate(); }
}
