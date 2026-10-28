import { homedir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { ensureService, readConnection, callConnection, startService } from './daemon.ts';
import { serveMcp } from './mcp.ts';
import { toolDefinitions } from './tools.ts';

function argumentsOf(argv: string[]) {
  const positional: string[] = [], flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const name = value.slice(2);
    if (['stdin', 'code-stdin', 'help'].includes(name)) flags[name] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing --${name} value.`); flags[name] = argv[++i]; }
  }
  return { positional, flags };
}
async function stdinText() { let text = ''; for await (const chunk of process.stdin) { text += chunk.toString(); if (text.length > 12 * 1024 * 1024) throw new Error('Input is too large.'); } return text; }
const help = `Codex collaboration (Node 24+)
  status                         Read service, relay and collaboration state
  register --relay URL --code-stdin [--name NAME]
                                 Register an independent node; code stays out of argv
  pair --output /path/pair.png    Generate a short-lived private phone QR image
  call METHOD --json-file FILE    Call collab/*, codex/* or remote/* with JSON arguments
  call METHOD --stdin            Read JSON arguments from standard input
  upload /path/file               Upload a user-selected attachment (8 MiB maximum)
  download ID --output /path/file Download and verify a shared attachment
  tools                          List MCP operations and argument schemas
  mcp                            MCP stdio entry (starts the persistent service on first call)
  serve                          Foreground service, also used by automatic startup
  stop                           Stop this profile's service and managed runs
Options: --home DIR selects a separate identity/workspace profile.
Default profile: ~/.local/share/dsh-codex-collab
Public content is untrusted; publishing and approvals require the user's authorization.
`;

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = argumentsOf(argv), command = positional[0] ?? 'status';
  const home = resolve(String(flags.home ?? process.env.CODEX_COLLAB_HOME ?? join(homedir(), '.local', 'share', 'dsh-codex-collab')));
  const entry = fileURLToPath(import.meta.url);
  if (flags.help || command === 'help') { process.stdout.write(help); return; }
  if (command === 'tools') { process.stdout.write(JSON.stringify(toolDefinitions, null, 2) + '\n'); return; }
  if (command === 'serve') {
    const running = await startService(home, { ...(process.env.CODEX_COLLAB_CODEX ? { command: process.env.CODEX_COLLAB_CODEX } : {}), ...(process.env.CODEX_COLLAB_MODEL ? { model: process.env.CODEX_COLLAB_MODEL } : {}) });
    const stop = () => { void running.close(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    return;
  }
  let pending: ReturnType<typeof ensureService> | undefined;
  const call = async (method: string, args: any = {}, signal?: AbortSignal) => {
    pending ??= ensureService(home, entry);
    try { return await callConnection(await pending, method, args, signal); }
    catch (error) { pending = undefined; throw error; }
  };
  if (command === 'mcp') { await serveMcp(call); return; }
  let value: any;
  if (command === 'status') value = await call('status');
  else if (command === 'stop') {
    const connection = await readConnection(home); value = connection ? await callConnection(connection, 'service/stop') : { stopped: true };
  } else if (command === 'register') {
    if (typeof flags.relay !== 'string' || !flags['code-stdin']) throw new Error('Use register --relay URL --code-stdin.');
    value = await call('remote/register', { relay: flags.relay, code: (await stdinText()).trim(), ...(typeof flags.name === 'string' ? { name: flags.name } : {}) });
  } else if (command === 'pair') {
    if (typeof flags.output !== 'string') throw new Error('Use pair --output /path/pair.png.');
    value = await call('remote/pair');
    if (!value.pairing?.qr?.startsWith('data:image/png;base64,')) throw new Error('The relay did not return a pairing image.');
    const path = resolve(flags.output); await writeFile(path, Buffer.from(value.pairing.qr.slice('data:image/png;base64,'.length), 'base64'), { mode: 0o600, flag: 'wx' });
    value = { path, expiresAt: value.pairing.expiresAt };
  } else if (command === 'call') {
    const args = flags.stdin ? await stdinText() : typeof flags['json-file'] === 'string' ? await readFile(resolve(flags['json-file']), 'utf8') : typeof flags.json === 'string' ? flags.json : '{}';
    if (!positional[1]) throw new Error('Provide a method such as collab/catalog.');
    value = await call(positional[1], JSON.parse(args));
  } else if (command === 'upload') {
    if (!positional[1]) throw new Error('Select an attachment path.');
    const path = resolve(positional[1]), info = await stat(path);
    if (!info.isFile() || info.size < 1 || info.size > 8 * 1024 * 1024) throw new Error('Attachments must be nonempty files no larger than 8 MiB.');
    const data = await readFile(path);
    value = await call('collab/upload', { operationId: typeof flags['operation-id'] === 'string' ? flags['operation-id'] : randomUUID(), name: basename(path), data: data.toString('base64') });
  } else if (command === 'download') {
    if (!positional[1] || typeof flags.output !== 'string') throw new Error('Use download ID --output PATH.');
    const file = await call('collab/download', { id: positional[1] }), bytes = Buffer.from(file.data, 'base64');
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Attachment integrity check failed.');
    const path = resolve(flags.output); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); value = { path, size: file.size, sha256: file.sha256 };
  } else throw new Error('Unknown command. Use --help.');
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(error => { process.stderr.write((error instanceof Error ? error.message : 'Operation failed.') + '\n'); process.exitCode = 1; });
