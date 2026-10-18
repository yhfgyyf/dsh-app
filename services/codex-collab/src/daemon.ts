import { spawn } from 'node:child_process';
import { open, unlink, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CollaborationService } from './service.ts';
import type { RuntimeOptions } from './codex-runtime.ts';
import { privateDirectory, readJson, writeJson } from './storage.ts';

export type Connection = { pid: number; instance: string; origin: string; token: string };
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
export async function readConnection(home: string) {
  const value = await readJson<Connection | null>(join(home, 'connection.json'), null);
  if (!value || !Number.isInteger(value.pid) || value.pid < 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin) || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) return null;
  return value;
}
export async function callConnection(connection: Connection, method: string, args: any = {}, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(60000);
  const response = await fetch(connection.origin + '/rpc', { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
  const text = await response.text(); if (text.length > 24 * 1024 * 1024) throw new Error('Local response is too large.');
  const result = JSON.parse(text);
  if (!response.ok || !result.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Local service request failed.');
  return result.value;
}
export async function startService(home: string, options: RuntimeOptions = {}) {
  home = resolve(home); await privateDirectory(home);
  // Serialize stale-lock recovery as well as initial creation. Never let two starters
  // remove one another's newly acquired service.lock after observing the same dead PID.
  const startupPath = join(home, 'service-start.lock');
  const startup = await open(startupPath, 'wx', 0o600).catch(() => { throw new Error('A service startup already owns this profile. If startup was interrupted, inspect service-start.lock before recovery.'); });
  try {
    await startup.writeFile(JSON.stringify({ pid: process.pid })); await startup.sync();
    return await startLockedService(home, options);
  } finally { await startup.close(); await unlink(startupPath); }
}
async function startLockedService(home: string, options: RuntimeOptions) {
  const lockPath = join(home, 'service.lock');
  try {
    const prior = await readJson<{ pid: number; instance: string } | null>(lockPath, null);
    if (prior) {
      if (!Number.isInteger(prior.pid) || prior.pid < 1 || alive(prior.pid)) throw new Error('This profile already has a running service.');
      await unlink(lockPath);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const lock = await open(lockPath, 'wx', 0o600), instance = randomUUID();
  await lock.writeFile(JSON.stringify({ pid: process.pid, instance })); await lock.sync();
  const service = new CollaborationService(home, options); let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    await service.stop().catch(() => {});
    const current = await readJson<{ instance: string } | null>(lockPath, null);
    if (current?.instance === instance) { await unlink(join(home, 'connection.json')).catch(() => {}); await unlink(lockPath).catch(() => {}); }
    await lock.close();
  };
  try {
    await service.start();
    service.mobile.setShutdown(close);
    const connection = { pid: process.pid, instance, origin: service.mobile.endpoint, token: service.mobile.token };
    await writeJson(join(home, 'connection.json'), connection);
    return { service, connection, close };
  } catch (error) { await close(); throw error; }
}
export async function ensureService(home: string, entry: string) {
  home = resolve(home); await privateDirectory(home);
  let connection = await readConnection(home);
  if (connection) {
    try { await callConnection(connection, 'status'); return connection; }
    catch { if (alive(connection.pid)) throw new Error('The existing service is unresponsive. Inspect it before restarting.'); }
  }
  const logPath = join(home, 'service.log');
  try { if (!(await lstat(logPath)).isFile()) throw new Error('Invalid service log.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const log = await open(logPath, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [entry, 'serve', '--home', home], { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, CODEX_COLLAB_WORKER: '1' }, windowsHide: true });
    child.unref();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      connection = await readConnection(home);
      if (connection) { try { await callConnection(connection, 'status'); return connection; } catch {} }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Service startup failed. Inspect ${logPath}.`);
  } finally { await log.close(); }
}
