import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ORIGINAL = 'd3a7f4bde2f32c5acc5f012d1edc24c24ea247c2f6c8823146f8cd69ed70b22f';
const HOISTED_GRAPH_PATCHED = 'f64af5b629ba66ae980f6821dfc22f3820c6aeb8ea0f709c3d2789a5ea5b7669';
const PATCHED = 'f66904bea8ef001d926aa2c3800f848fa478ef0a609216f0df56787511c4b9b3';
const sha = (source: string) => createHash('sha256').update(source).digest('hex');

/** pnpm 11.7.0's old hoisted graph only supplies removal paths. Fetching its
 * missing optional packages can recreate workers after CLI shutdown and hang.
 * Keep the current graph's install/fetch behavior intact. Its bundled atomic
 * writer also needs bounded Windows retries while the complete temporary file
 * survives transient sharing violations. Never remove the destination first.
 * Reject upstream drift.
 */
export async function patchPnpm(packageDirectory: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '11.7.0', 'Revalidate the pnpm compatibility fixes before changing its version');
  const file = join(packageDirectory, 'dist/pnpm.mjs');
  const source = await readFile(file, 'utf8');
  if (sha(source) === PATCHED) return;
  assert.ok([ORIGINAL, HOISTED_GRAPH_PATCHED].includes(sha(source)), 'Unrecognized pnpm source; refusing to overwrite it');
  let patched = source.replace(
    'prevGraph = (await _lockfileToHoistedDepGraph(currentLockfile, {\n      ...opts3,\n      force: true,',
    'prevGraph = (await _lockfileToHoistedDepGraph(currentLockfile, {\n      ...opts3,\n      metadataOnly: true,\n      force: true,',
  ).replace(
    '    if (skipFetch) {\n      const { filesIndexFile } = opts3.storeController.getFilesIndexFilePath({',
    '    if (opts3.metadataOnly === true) {\n      fetchResponse = {};\n    } else if (skipFetch) {\n      const { filesIndexFile } = opts3.storeController.getFilesIndexFilePath({',
  );
  const rename = '        await promisify15(fs119.rename)(tmpfile, truename);';
  assert.equal(patched.split(rename).length - 1, 2, 'Expected both pinned write-file-atomic versions');
  patched = patched.replaceAll(rename, `        let renameDelay = 20;
        for (let renameRetries = 0; ; renameRetries++) {
          try {
            await promisify15(fs119.rename)(tmpfile, truename);
            break;
          } catch (error) {
            if (process.platform !== "win32" || !["EACCES", "EBUSY", "EPERM"].includes(error?.code) || renameRetries >= 8) throw error;
          }
          await new Promise((resolveRename) => setTimeout(resolveRename, renameDelay));
          renameDelay = Math.min(renameDelay * 2, 200);
        }`);
  assert.equal(sha(patched), PATCHED, 'Unexpected pnpm patch result');
  await writeFile(file, patched);
}
