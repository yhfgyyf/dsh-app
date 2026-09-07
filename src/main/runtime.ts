import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { assertBootGraph, type BootGraph } from '../shared/dsh-boot.ts';

export type RuntimeReady = { type: 'ready'; endpoint: string; launchUrl: string; graph: BootGraph; hostPlugins: string[] };
type RuntimeOptions = { runtimeRoot: string; entry: string; home: string; configHome?: string; cwd: string; onExit: (code: number | null) => void; pickDirectory?: () => Promise<string | null> };
export async function availableDesktopPort(port: number): Promise<number> {
  if (!port) return 0;
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve(0) : reject(error));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve(port)));
  });
}
export class DesktopRuntime {
  child?: ChildProcess;
  ready?: RuntimeReady;
  private stopping = false;
  private options: RuntimeOptions;
  constructor(options: RuntimeOptions) { this.options = options; }
  async graph(): Promise<BootGraph> {
    const child = this.child;
    if (!this.ready || !child?.connected) throw new Error('DSH 核心尚未就绪。');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', failed); };
      const failed = () => { cleanup(); reject(new Error('DSH 核心不可用。')); };
      const receive = (message: any) => {
        if (message?.type !== 'boot-result' || message.id !== id) return;
        cleanup();
        try { assertBootGraph(message.graph); resolve(message.graph); } catch (error) { reject(error); }
      };
      const timer = setTimeout(failed, 10000);
      child.on('message', receive); child.once('exit', failed);
      child.send({ type: 'get-boot', id });
    });
  }
  async start(): Promise<RuntimeReady> {
    if (this.ready) return this.ready;
    await mkdir(this.options.home, { recursive: true });
    let port = 0;
    const portFile = join(this.options.home, 'desktop-transport.json');
    try {
      const saved = JSON.parse(await readFile(portFile, 'utf8')).port;
      if (Number.isInteger(saved) && saved >= 1024 && saved <= 65535) port = saved;
    } catch { /* A first launch asks the OS for an unused loopback port. */ }
    port = await availableDesktopPort(port);
    this.stopping = false;
    const child = spawn(join(this.options.runtimeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), [this.options.entry], {
      cwd: this.options.cwd,
      windowsHide: true,
      env: { ...process.env, DSH_HOME: this.options.configHome ?? this.options.home, DSH_DESKTOP_CONFIG_HOME: this.options.configHome ?? this.options.home, DSH_DESKTOP_STATE_HOME: this.options.home, DSH_DESKTOP_RUNTIME_ROOT: this.options.runtimeRoot, DSH_DESKTOP_PORT: String(port), DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;
    child.on('message', async (message: any) => {
      if (message?.type !== 'pick-folder' || typeof message.id !== 'string') return;
      let path: string | null = null;
      try { path = await this.options.pickDirectory?.() ?? null; } catch { /* Cancellation yields no selection. */ }
      if (child.connected) child.send({ type: 'folder-picked', id: message.id, path });
    });
    // Keep process output local; login URLs are only carried by structured IPC.
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => console.log(String(chunk).replace(/token=[^\s]+/g, 'token=[redacted]')));
    child.once('exit', code => { this.ready = undefined; this.child = undefined; if (!this.stopping) this.options.onExit(code); });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('DSH 核心启动超时。')); }, 45000);
      const finish = () => clearTimeout(timer);
      child.once('error', error => { finish(); reject(error); });
      child.once('exit', code => { finish(); reject(new Error(`DSH 核心已退出 (${code})。`)); });
      child.on('message', message => {
        const value = message as RuntimeReady & { error?: string };
        if (value.type === 'ready') {
          try {
            assertBootGraph(value.graph);
            const endpoint = new URL(value.endpoint);
            if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || new URL(value.launchUrl).origin !== endpoint.origin) throw new Error('Invalid owned core address');
            this.ready = value;
            void writeFile(portFile, JSON.stringify({ port: Number(endpoint.port) }), { mode: 0o600 }).then(() => { finish(); resolve(value); }, error => { finish(); child.kill('SIGTERM'); reject(error); });
          } catch (error) { finish(); child.kill('SIGTERM'); reject(error); }
        } else if ((message as { type: string }).type === 'failed') { finish(); child.kill('SIGTERM'); reject(new Error(value.error ?? 'DSH 核心启动失败。')); }
      });
    });
  }
  async stop() {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
      const forceTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
      child.once('exit', () => { clearTimeout(timer); clearTimeout(forceTimer); resolve(); });
      if (child.connected) child.send({ type: 'shutdown' });
      else child.kill('SIGTERM');
    });
  }
}
