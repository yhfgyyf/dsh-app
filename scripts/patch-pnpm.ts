import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ORIGINAL = 'd3a7f4bde2f32c5acc5f012d1edc24c24ea247c2f6c8823146f8cd69ed70b22f';
const PATCHED = 'f64af5b629ba66ae980f6821dfc22f3820c6aeb8ea0f709c3d2789a5ea5b7669';
const sha = (source: string) => createHash('sha256').update(source).digest('hex');

/** pnpm 11.7.0's old hoisted graph only supplies removal paths. Fetching its
 * missing optional packages can recreate workers after CLI shutdown and hang.
 * Keep the current graph's install/fetch behavior intact. Reject upstream drift.
 */
export async function patchPnpm(packageDirectory: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '11.7.0', 'Revalidate the hoisted graph fix before changing pnpm');
  const file = join(packageDirectory, 'dist/pnpm.mjs');
  const source = await readFile(file, 'utf8');
  if (sha(source) === PATCHED) return;
  assert.equal(sha(source), ORIGINAL, 'Unrecognized pnpm source; refusing to overwrite it');
  const patched = source.replace(
    'prevGraph = (await _lockfileToHoistedDepGraph(currentLockfile, {\n      ...opts3,\n      force: true,',
    'prevGraph = (await _lockfileToHoistedDepGraph(currentLockfile, {\n      ...opts3,\n      metadataOnly: true,\n      force: true,',
  ).replace(
    '    if (skipFetch) {\n      const { filesIndexFile } = opts3.storeController.getFilesIndexFilePath({',
    '    if (opts3.metadataOnly === true) {\n      fetchResponse = {};\n    } else if (skipFetch) {\n      const { filesIndexFile } = opts3.storeController.getFilesIndexFilePath({',
  );
  assert.equal(sha(patched), PATCHED, 'Unexpected pnpm patch result');
  await writeFile(file, patched);
}
