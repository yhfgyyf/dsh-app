import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
export const fakeOptions = { command: process.execPath, args: [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))] };
export async function waitFor(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const until = Date.now() + ms;
  while (!await fn()) { if (Date.now() > until) throw new Error('Timed out waiting for test condition.'); await new Promise(r => setTimeout(r, 15)); }
}
export function runCli(args: string[], input?: string) {
  return new Promise<{ code: number | null; out: string; error: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', error = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { error += data; }); child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, out, error }); }); child.stdin.end(input);
  });
}
export class McpClient {
  child;
  private next = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(home: string, entry = cli) {
    this.child = spawn(process.execPath, [entry, 'mcp', '--home', home], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', line => {
      const value = JSON.parse(line), pending = this.pending.get(value.id); if (!pending) return;
      this.pending.delete(value.id); clearTimeout(pending.timer); if (value.error) pending.reject(new Error(value.error.message)); else pending.resolve(value.result);
    });
  }
  request(method: string, params: any = {}) {
    const id = ++this.next;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('MCP response timeout')); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async start() {
    const result = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); return result;
  }
  async tool(name: string, args: object = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text); return result.structuredContent.value;
  }
  async close() {
    const child = this.child;
    if (child.exitCode !== null) return;
    await new Promise<void>(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.stdin.end(); });
    for (const value of this.pending.values()) clearTimeout(value.timer); this.pending.clear();
  }
}
