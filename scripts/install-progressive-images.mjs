import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');

/** Match PTC's durable image forwarding for the pinned invoke_tool composite. */
export async function applyProgressiveImages() {
  const pin = JSON.parse(await readFile(join(root, 'patches/progressive-images/manifest.json'), 'utf8'));
  const base = join(root, '.runtime/node_modules', pin.package);
  const pkg = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
  if (pkg.name !== pin.package || pkg.version !== pin.version) throw new Error('Unexpected progressive-tools image contract.');
  const path = join(base, pin.path);
  const before = await readFile(path, 'utf8');
  if (sha(before) === pin.after) return { changed: false };
  if (sha(before) !== pin.before) throw new Error('Unrecognized progressive-tools changes preserved: ' + path);
  const original = '\t\t\tfor (const context of result.additionalContexts ?? []) exec.deferContext(context);';
  if (before.split(original).length !== 2) throw new Error('Progressive image forwarding anchor differs.');
  const after = 'import { createUserMessage } from "@deepseek-ai/dsh-llm";\n' + before.replace(original, '\t\t\tif (!result.isError && result.content.some(block => block.type === "image")) exec.deferContext(createUserMessage({ content: result.content, source: { kind: "plugin", plugin: "dsh-progressive-tools" } }));\n' + original);
  if (sha(after) !== pin.after) throw new Error('Progressive image result checksum differs.');
  const backup = join(root, '.build-runtime/backups', `progressive-images-${Date.now()}`);
  await mkdir(backup, { recursive: true });
  await writeFile(join(backup, 'index.js'), before);
  if (sha(await readFile(join(backup, 'index.js'))) !== pin.before) throw new Error('Progressive image backup verification failed.');
  await writeFile(path, after);
  if (sha(await readFile(path)) !== pin.after) throw new Error('Progressive image installed checksum differs.');
  return { changed: true, backup };
}
