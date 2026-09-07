import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export async function runtimeManifest(root: string) {
  const files: { path: string; bytes: number; sha256: string }[] = [];
  async function visit(relative: string) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(join(root, path));
        files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      } else throw new Error(`Unexpected runtime entry: ${path}`);
    }
  }
  await visit('');
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}
