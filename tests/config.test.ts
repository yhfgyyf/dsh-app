import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreferences, isEndpointDocument, parseConnectionInput, parsePreferences } from '../src/shared/config.ts';

test('accepts loopback addresses and keeps the login token only in the launch URL', () => {
  const connection = parseConnectionInput(' http://127.0.0.1:3080/?token=test-only-token ');
  assert.equal(connection.endpoint, 'http://127.0.0.1:3080');
  assert.equal(connection.launchUrl, 'http://127.0.0.1:3080/?token=test-only-token');
  assert.equal(parseConnectionInput('https://localhost:3080').endpoint, 'https://localhost:3080');
  assert.equal(parseConnectionInput('http://[::1]:3080/').endpoint, 'http://[::1]:3080');
});

test('rejects remote origins, credentials, unsupported paths and ambiguous authentication', () => {
  const invalid = [
    'https://example.com', 'http://127.0.0.1.example.com:3080/',
    'http://127.0.0.1@evil.example/', 'http://user:secret@localhost:3080',
    'file:///etc/passwd', 'javascript:alert(1)', '127.0.0.1:3080',
    'http://localhost:3080/settings', 'http://localhost:3080/#token=secret',
    'http://localhost:3080/?token=a&token=b', 'http://localhost:3080/?token=',
    'http://localhost:3080/?redirect=https://evil.example',
    'http://local\nhost:3080/', 'http://localhost:3080/\\evil', 'http://localhost:0/',
    null, {}, 3080, 'x'.repeat(8193),
  ];
  for (const value of invalid) assert.throws(() => parseConnectionInput(value));
});

test('validation errors do not disclose supplied secrets', () => {
  for (const value of ['http://secret:private-password@example.com', 'http://localhost:3080/?token=private-token&extra=1']) {
    assert.throws(() => parseConnectionInput(value), (error: Error) => {
      assert.doesNotMatch(error.message, /private-password|private-token|secret/);
      return true;
    });
  }
});

test('projects preferences to a fresh credential-free shape', () => {
  const value = {
    ...defaultPreferences(),
    endpoint: 'http://127.0.0.1:3080/?token=private-token',
    token: 'do-not-persist',
    nested: { password: 'do-not-persist' },
    window: { ...defaultPreferences().window, x: -1920, y: -30, secret: 'do-not-persist' },
  };
  const parsed = parsePreferences(value);
  assert.equal(parsed.endpoint, 'http://127.0.0.1:3080');
  assert.equal(parsed.window.x, -1920);
  assert.equal(parsed.window.y, -30);
  assert.doesNotMatch(JSON.stringify(parsed), /token|password|secret|private-token|do-not-persist/);
  assert.notEqual(parsed, value);
  assert.notEqual(parsed.window, value.window);
});

test('rejects invalid preference versions, bounds and zoom levels', () => {
  for (const patch of [
    { version: 2 }, { version: '1' }, { window: {} }, { zoomFactor: NaN },
    { zoomFactor: Infinity }, { zoomFactor: 0.1 }, { zoomFactor: 3 },
    { window: { ...defaultPreferences().window, width: 0 } },
    { window: { ...defaultPreferences().window, height: 479 } },
    { window: { ...defaultPreferences().window, x: 0.5 } },
    { window: { ...defaultPreferences().window, maximized: 'false' } },
  ]) assert.throws(() => parsePreferences({ ...defaultPreferences(), ...patch }));
  for (const value of [null, [], false]) assert.throws(() => parsePreferences(value));
});

test('only the selected endpoint root is eligible for the native document boundary', () => {
  const endpoint = 'http://127.0.0.1:3080';
  assert.equal(isEndpointDocument(endpoint + '/', endpoint), true);
  assert.equal(isEndpointDocument(endpoint + '/?token=test-only', endpoint), true);
  for (const document of ['http://127.0.0.1:3081/', 'https://127.0.0.1:3080/', 'http://localhost:3080/', endpoint + '/other.html', 'file:///tmp/test.html', 'http://user@127.0.0.1:3080/', 'not-a-url']) {
    assert.equal(isEndpointDocument(document, endpoint), false, document);
  }
  assert.equal(isEndpointDocument(endpoint, 'https://example.com'), false);
});

test('default preferences do not share mutable state', () => {
  const first = defaultPreferences();
  first.window.width = 1000;
  assert.equal(defaultPreferences().window.width, 1320);
});

test('computer opt-in persists and older preferences default to disabled', () => {
  const { computerEnabled, ...old } = defaultPreferences();
  assert.equal(computerEnabled, false);
  assert.equal(parsePreferences(old).computerEnabled, false);
  assert.equal(parsePreferences({ ...old, computerEnabled: true }).computerEnabled, true);
  assert.throws(() => parsePreferences({ ...old, computerEnabled: 'true' }));
});
