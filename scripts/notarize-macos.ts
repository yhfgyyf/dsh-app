import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { macSignature } from '../src/main/macos-signature.ts';
import { runtimeManifest } from './runtime-manifest.ts';

if (process.platform !== 'darwin') throw new Error('公证脚本需要 macOS。');
const { values } = parseArgs({ options: { artifact: { type: 'string' }, profile: { type: 'string' }, submit: { type: 'boolean' } } });
if (!values.artifact) throw new Error('需要 --artifact 指向正式签名构建的 artifact.json。默认只检查；--submit --profile <钥匙串配置名> 才会上传 Apple 公证。');
const file = resolve(values.artifact);
const artifact = JSON.parse(await readFile(file, 'utf8'));
const run = promisify(execFile);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
assert.equal(artifact.developerId, true, '只能公证 Developer ID 正式签名构建');
assert.equal(dirname(artifact.archive), dirname(file), '安装包必须属于所选构建目录');
assert.equal(sha256(await readFile(artifact.archive)), artifact.sha256, '安装包与构建记录不一致');
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', artifact.app]);
const signature = await macSignature(artifact.app);
assert.ok(signature.developerId && signature.timestamp && signature.teamId === artifact.signingTeam, '正式签名或时间戳不正确');
assert.equal((await runtimeManifest(join(artifact.app, 'Contents/Resources/runtime'))).sha256, artifact.runtime.sha256, '待公证 App 的运行时已更改');
if (!values.submit) {
  console.log('本地公证前检查通过，未上传。提交时显式添加 --submit --profile <钥匙串配置名>。');
} else {
  if (!values.profile) throw new Error('提交公证需要 --profile 指定已保存到钥匙串的 notarytool 配置。');
  const output = join(dirname(file), `notarized-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(output);
  // Credentials remain in Keychain. This explicit command is the only upload.
  const { stdout } = await run('/usr/bin/xcrun', ['notarytool', 'submit', artifact.archive, '--keychain-profile', values.profile, '--wait', '--output-format', 'json'], { maxBuffer: 4 * 1024 * 1024 });
  const submission = JSON.parse(stdout);
  await writeFile(join(output, 'notarization.json'), JSON.stringify(submission, null, 2));
  if (submission.status !== 'Accepted') throw new Error(`Apple 公证未通过；请用 notarytool log 查看提交 ${submission.id}。`);
  const app = join(output, 'DSH Desktop.app');
  await run('/usr/bin/ditto', [artifact.app, app]);
  await run('/usr/bin/xcrun', ['stapler', 'staple', app]);
  await run('/usr/bin/xcrun', ['stapler', 'validate', app]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  const archive = join(output, basename(artifact.archive));
  await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
  const verification = join(output, 'verification');
  await run('/usr/bin/ditto', ['-x', '-k', archive, verification]);
  const extracted = join(verification, 'DSH Desktop.app');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', extracted]);
  await run('/usr/bin/xcrun', ['stapler', 'validate', extracted]);
  await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', extracted]);
  assert.equal((await runtimeManifest(join(extracted, 'Contents/Resources/runtime'))).sha256, artifact.runtime.sha256);
  const bytes = await readFile(archive);
  const result = { ...artifact, app, archive, bytes: bytes.length, sha256: sha256(bytes), notarized: true, notarizationId: submission.id, distributionReady: false, installedComputerUseVerified: false };
  await writeFile(join(output, 'artifact.json'), JSON.stringify(result, null, 2));
  await writeFile(join(output, 'SHA256SUMS.txt'), `${result.sha256}  ${basename(archive)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log('公证与最终安装包校验通过。发布前仍需在正式签名 App 上完成 Computer Use 和跨版本权限保留测试。');
}
