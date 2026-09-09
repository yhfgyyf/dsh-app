import { readFile, writeFile } from 'node:fs/promises';
import { installUpdate, validatePlan, waitForExit, type InstallPlan } from './install.ts';

async function main() {
  let plan: InstallPlan | undefined;
  try {
    plan = JSON.parse(await readFile(process.argv[2], 'utf8')) as InstallPlan;
    validatePlan(plan);
    process.send?.({ type: 'ready' });
    process.disconnect?.();
    await waitForExit(plan.parentPid);
    if (plan.corePid) await waitForExit(plan.corePid);
    await installUpdate(plan);
  } catch (error) {
    const message = error instanceof Error ? error.message : '应用更新失败。';
    if (plan?.result) await writeFile(plan.result, JSON.stringify({ status: 'error', error: message, backup: plan.backup }), { mode: 0o600 }).catch(() => {});
    console.error(message);
    process.exitCode = 1;
  }
}
void main();
