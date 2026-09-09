import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const requireDsh = createRequire(new URL('../.runtime/package.json', import.meta.url));
const WebSocket = requireDsh('ws');

export async function connectFixture(connectionFile: string | URL = new URL('../.test-data/fixture-connection.json', import.meta.url)) {
  const config = JSON.parse(await readFile(connectionFile, 'utf8'));
  assert.equal(config.owner, 'dsh-desktop-test', 'Writes are restricted to the owned disposable fixture.');
  assert.equal(new URL(config.endpoint).hostname, '127.0.0.1');
  assert.notEqual(new URL(config.endpoint).port, '3080');
  const response = await fetch(config.launchUrl, { redirect: 'manual' });
  assert.equal(response.status, 303);
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie);
  const headers = { cookie, origin: config.endpoint, 'content-type': 'application/json' };
  const rpc = async (method: string, args: object = {}, allowFailure = false, channel = '/api') => {
    const rpcId = randomUUID();
    const response = await fetch(config.endpoint + channel + '/' + method, { method: 'POST', headers, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, `${method}: HTTP ${response.status}`);
    const body = await response.json();
    assert.equal(body.rpcId, rpcId);
    if (allowFailure) return body.result;
    assert.equal(body.result.ok, true, `${method}: ${JSON.stringify(body.result.error)}`);
    return body.result.value;
  };
  const socket = new WebSocket(config.endpoint.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie, origin: config.endpoint } });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const streams = new Map<string, { frames: any[]; error?: unknown }>();
  socket.on('message', (bytes: Buffer) => {
    const message = JSON.parse(bytes.toString());
    const stream = streams.get(message.streamId);
    if (!stream) return;
    if (message.type === 'item') stream.frames.push(message.value);
    if (message.type === 'error') stream.error = message.error;
  });
  function follow(endpoint: string, args: object = {}) {
    const streamId = randomUUID();
    const state = { frames: [] as any[], error: undefined as unknown };
    streams.set(streamId, state);
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    return {
      frames: state.frames,
      async wait(predicate: (frames: any[]) => boolean, timeout = 15000) {
        const started = Date.now();
        while (!predicate(state.frames)) {
          if (state.error) throw new Error(JSON.stringify(state.error));
          if (Date.now() - started > timeout) throw new Error(`${endpoint} timed out; ${state.frames.length} frames`);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return state.frames;
      },
      close() { socket.send(JSON.stringify({ type: 'cancel', streamId })); streams.delete(streamId); },
    };
  }
  return { rpc, follow, headers, endpoint: config.endpoint as string, close: () => socket.close() };
}
