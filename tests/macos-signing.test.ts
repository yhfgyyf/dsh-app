import test from 'node:test';
import assert from 'node:assert/strict';
import { developerIdentity } from '../scripts/macos-signing.ts';
import { verifyMacSigningContinuity } from '../src/main/macos-signature.ts';
import { resetDshComputerPermissions } from '../src/main/macos-privacy.ts';

const fingerprint = 'A'.repeat(40);
const name = 'Developer ID Application: Fixture (ABCDE12345)';
test('formal packaging requires the selected Developer ID private-key identity', () => {
  const identities = `1) ${fingerprint} "${name}"\n 1 valid identities found`;
  for (const requested of [undefined, '-', 'unavailable']) assert.throws(() => developerIdentity(requested, identities), /不会回退到 ad-hoc/);
  assert.throws(() => developerIdentity(fingerprint, `1) ${fingerprint} "Apple Development: Fixture (ABCDE12345)"`), /Developer ID Application/);
  assert.equal(developerIdentity(fingerprint.toLowerCase(), identities).teamId, 'ABCDE12345');
  assert.equal(developerIdentity(name, identities).identity, fingerprint);
});

test('updates enforce the installed Developer ID requirement and reject an identity change', async () => {
  const requirement = 'identifier "io.dsh.desktop" and anchor apple generic and certificate leaf[subject.OU] = ABCDE12345';
  let changed = false; const commands: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    commands.push(args);
    if (args.includes('--display')) return { stdout: '', stderr: `Authority=${name}\nTeamIdentifier=ABCDE12345\ndesignated => ${requirement}\n` };
    if (changed) throw new Error('code failed to satisfy specified code requirement(s)');
    return { stdout: '', stderr: '' };
  };
  assert.equal((await verifyMacSigningContinuity('/current.app', '/next.app', run)).status, 'verified');
  assert.deepEqual(commands.at(-1), ['--verify', '--deep', '--strict', '--test-requirement', `=${requirement}`, '/next.app']);
  changed = true;
  await assert.rejects(verifyMacSigningContinuity('/current.app', '/next.app', run), /签名身份.*不一致/);
});

test('legacy ad-hoc migration is identified without pretending its old grants transfer', async () => {
  const result = await verifyMacSigningContinuity('/current.app', '/next.app', async () => ({ stdout: '# designated => cdhash H"012345"\n', stderr: 'Signature=adhoc\n' }));
  assert.equal(result.status, 'legacy-migration');
});

test('explicit privacy recovery resets only DSH and stops on a system error', async () => {
  const calls: string[][] = [];
  await resetDshComputerPermissions(async (command, args) => { assert.equal(command, '/usr/bin/tccutil'); calls.push(args); });
  assert.deepEqual(calls, [['reset', 'Accessibility', 'io.dsh.desktop'], ['reset', 'ScreenCapture', 'io.dsh.desktop']]);
  let count = 0;
  await assert.rejects(resetDshComputerPermissions(async () => { count++; throw new Error('fixture failure'); }), /fixture failure/);
  assert.equal(count, 1);
});
