import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PreferencesError, PreferencesFile } from '../src/main/preferences.ts';
import { defaultPreferences } from '../src/shared/config.ts';

async function fixture(t: { after(callback: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-preferences-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: new PreferencesFile(directory) };
}

test('missing preferences load defaults without creating a file', async (t) => {
  const { directory, file } = await fixture(t);
  assert.deepEqual(await file.load(), defaultPreferences());
  assert.deepEqual(await readdir(directory), []);
});

test('persists valid preferences atomically with POSIX owner-only permissions where supported', async (t) => {
  const { directory, file } = await fixture(t);
  const preferences = { ...defaultPreferences(), zoomFactor: 1.2 };
  await file.save(preferences);
  assert.deepEqual(await file.load(), preferences);
  if (process.platform !== 'win32') assert.equal((await stat(file.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['desktop.json']);
});

test('concurrent writes finish in order and snapshot caller state', async (t) => {
  const { file } = await fixture(t);
  const one = { ...defaultPreferences(), zoomFactor: 0.8 };
  const two = { ...defaultPreferences(), zoomFactor: 1.3 };
  const first = file.save(one);
  const second = file.save(two);
  two.zoomFactor = 2;
  await Promise.all([first, second]);
  assert.equal((await file.load()).zoomFactor, 1.3);
});

test('keeps corrupt preferences intact and never includes file content in errors', async (t) => {
  const { file, directory } = await fixture(t);
  const original = '{ malformed: "private-secret"';
  await writeFile(file.path, original);
  await assert.rejects(file.load(), (error: Error) => error instanceof PreferencesError && !error.message.includes('private-secret'));
  await assert.rejects(file.save(defaultPreferences()), PreferencesError);
  assert.equal(await readFile(file.path, 'utf8'), original);
  assert.deepEqual(await readdir(directory), ['desktop.json']);
});

test('does not follow a symlink to unrelated user settings', async (t) => {
  const { file, directory } = await fixture(t);
  const unrelated = join(directory, 'unrelated-settings.json');
  const original = JSON.stringify(defaultPreferences());
  await writeFile(unrelated, original);
  await symlink(unrelated, file.path);
  await assert.rejects(file.load(), PreferencesError);
  await assert.rejects(file.save({ ...defaultPreferences(), zoomFactor: 1.5 }), PreferencesError);
  assert.equal(await readFile(unrelated, 'utf8'), original);
});

test('cleans credential-like unknown fields and authentication URLs on save', async (t) => {
  const { file } = await fixture(t);
  await file.save({ ...defaultPreferences(), endpoint: 'http://127.0.0.1:3080/?token=private-token' });
  assert.doesNotMatch(await readFile(file.path, 'utf8'), /token|private-token/);
});

test('rejects invalid input before enqueuing it, allowing a later valid write', async (t) => {
  const { file } = await fixture(t);
  assert.throws(() => file.save({ ...defaultPreferences(), zoomFactor: 10 }));
  await file.save(defaultPreferences());
  assert.deepEqual(await file.load(), defaultPreferences());
});
