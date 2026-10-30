import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; dispose(): void };
export type AppServerOptions = { command?: string; args?: string[]; env?: NodeJS.ProcessEnv; requestTimeout?: number };

/** One native Codex process and a bidirectional, newline-delimited JSON-RPC connection. */
export class AppServer extends EventEmitter {
  private options: AppServerOptions;
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<any>;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private buffer = '';
  info: any;
  generation = 0;
  constructor(options: AppServerOptions = {}) { super(); this.options = options; }
  async start(): Promise<any> {
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try { return await this.starting; } catch (error) { this.starting = undefined; throw error; }
  }
  private async launch() {
    this.generation++;
    this.buffer = '';
    const child = this.child = spawn(this.options.command ?? 'codex', this.options.args ?? ['app-server', '-c', 'mcp_servers.dsh-collab={command="node",args=[],enabled=false}', '-c', 'plugins."dsh-codex-collab@dsh-local".enabled=false'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: this.options.env ?? process.env, windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (child !== this.child) return;
      this.buffer += chunk;
      if (this.buffer.length > 32 * 1024 * 1024) { this.fail(new Error('Codex protocol frame is too large.')); child.kill(); return; }
      for (;;) {
        const newline = this.buffer.indexOf('\n'); if (newline < 0) break;
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let frame: any;
        try { frame = JSON.parse(line); } catch { this.fail(new Error('Invalid Codex protocol response.')); child.kill(); return; }
        if (frame.method) this.emit(frame.id === undefined ? 'notification' : 'request', frame);
        else if (typeof frame.id === 'number') {
          const pending = this.pending.get(frame.id); if (!pending) continue;
          this.pending.delete(frame.id); clearTimeout(pending.timer); pending.dispose();
          if (frame.error) pending.reject(Object.assign(new Error(String(frame.error.message ?? 'Codex request failed.')), { code: frame.error.code }));
          else pending.resolve(frame.result);
        }
      }
    });
    // Native diagnostics can contain private prompts. Drain them without logging them.
    child.stderr.resume();
    child.on('error', () => { if (child === this.child) this.fail(new Error('Cannot start Codex. Check the configured executable.')); });
    child.on('exit', (code, signal) => {
      if (child !== this.child) return;
      this.child = undefined; this.starting = undefined;
      this.fail(new Error(`Codex app-server exited (${signal ?? code}).`));
      this.emit('disconnected');
    });
    this.info = await this.request('initialize', { clientInfo: { name: 'dsh_codex_collab', title: 'Codex collaboration', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
    return this.info;
  }
  request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const remove = () => { const p = this.pending.get(id); if (p) clearTimeout(p.timer); this.pending.delete(id); signal?.removeEventListener('abort', abort); };
      const abort = () => { remove(); reject(signal?.reason ?? new Error('Cancelled.')); };
      const timer = setTimeout(() => { remove(); reject(new Error(`Codex ${method} timed out; inspect the session before retrying.`)); }, this.options.requestTimeout ?? 30000);
      this.pending.set(id, { resolve, reject, timer, dispose: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.send({ id, method, params }); } catch (error) { remove(); reject(error); }
    });
  }
  respond(id: string | number, result: unknown) { this.send({ id, result }); }
  reject(id: string | number, message: string) { this.send({ id, error: { code: -32601, message } }); }
  private send(value: unknown) {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server is unavailable.');
    if (this.child.stdin.writableLength > 16 * 1024 * 1024) throw new Error('Codex request queue is full.');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.dispose(); pending.reject(error); }
    this.pending.clear();
  }
  async stop() {
    const child = this.child; if (!child) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.stdin.end();
    });
  }
}
