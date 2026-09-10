import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
type Execute = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
export async function macSignature(app: string, run: Execute = execute) {
  const result = await run('/usr/bin/codesign', ['--display', '--verbose=4', '--requirements', '-', app]);
  const text = result.stdout + result.stderr;
  // codesign prefixes a synthesized ad-hoc requirement with "# ".
  const requirement = /^#?\s*designated => (.+)$/m.exec(text)?.[1];
  if (!requirement) throw new Error('应用没有有效的签名身份。');
  return { requirement, developerId: /^Authority=Developer ID Application:/m.test(text), teamId: /^TeamIdentifier=(.+)$/m.exec(text)?.[1], timestamp: /^Timestamp=(.+)$/m.exec(text)?.[1] };
}

/** A formally signed installation must never silently change its permission identity. */
export async function verifyMacSigningContinuity(current: string, next: string, run: Execute = execute) {
  const before = await macSignature(current, run);
  if (!before.developerId) return { status: 'legacy-migration' as const, previousRequirement: before.requirement };
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', `=${before.requirement}`, next]);
  } catch {
    throw new Error('更新包的签名身份与已安装版本不一致。为避免原有电脑操作授权失效，已停止安装；请获取同一开发者正式签名的更新包。');
  }
  return { status: 'verified' as const, previousRequirement: before.requirement };
}
