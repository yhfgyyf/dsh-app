import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

test('pinned DSH Gateway broadcasts approvals/questions and accepts exactly one result across clients', async () => {
  const require = createRequire(new URL('../.runtime/package.json', import.meta.url));
  const { TypertGatewayService } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-api-gateway')).href);
  for (const event of ['approval/request', 'user-questions/request']) {
    const gateway = Object.create(TypertGatewayService.prototype);
    gateway.remoteEventClients = new Map(); gateway.pendingRemoteEvents = new Map();
    gateway.remoteEvents = { lifetime: new AbortController(), host: { home: '/fixture' } };
    const a = new AbortController(), b = new AbortController();
    const desktop = gateway.openRemoteEvents({ args: {} }, a.signal), phone = gateway.openRemoteEvents({ args: {} }, b.signal);
    const d = (await desktop.next()).value, p = (await phone.next()).value;
    assert.notEqual(d.clientId, p.clientId);
    const agent = {}, decisions: unknown[] = [];
    gateway.startRemoteEvent({ event, request: { agent, message: 'fixture question' }, context: { subject: agent, agentId: 'fixture-agent', value: { effect: () => () => {} } }, resolve: (v: unknown) => decisions.push(v), reject: (e: unknown) => { throw e; } });
    const df = (await desktop.next()).value, pf = (await phone.next()).value;
    assert.equal(df.type, 'waterfall'); assert.equal(df.eventId, pf.eventId);
    gateway.receiveRemoteEventResult(gateway.remoteEventClients.get(p.clientId), { clientId: p.clientId, eventId: pf.eventId, outcome: { kind: 'result', value: 'phone answer' } });
    assert.equal((await desktop.next()).value.type, 'cancel');
    gateway.receiveRemoteEventResult(gateway.remoteEventClients.get(d.clientId), { clientId: d.clientId, eventId: df.eventId, outcome: { kind: 'result', value: 'stale desktop answer' } });
    assert.deepEqual(decisions, [{ kind: 'result', value: 'phone answer' }]);
    await desktop.return(); await phone.return();
  }
});
