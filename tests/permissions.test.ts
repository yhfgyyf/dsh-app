import test from 'node:test';
import assert from 'node:assert/strict';
import type { MediaAccessPermissionRequest, Session, WebContents } from 'electron';
import { installDesktopPermissions } from '../src/main/permissions.ts';

type RequestHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
type CheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
type CheckDetails = Parameters<CheckHandler>[3];

function fixture() {
  const state = { endpoint: 'http://127.0.0.1:31877', url: 'http://127.0.0.1:31877/', destroyed: false };
  const contents = { getURL: () => state.url, isDestroyed: () => state.destroyed } as WebContents;
  let current: WebContents | undefined = contents;
  let requestHandler: RequestHandler | undefined;
  let checkHandler: CheckHandler | undefined;
  const session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'> = {
    setPermissionRequestHandler(handler) { assert.ok(handler); assert.equal(requestHandler, undefined); requestHandler = handler; },
    setPermissionCheckHandler(handler) { assert.ok(handler); assert.equal(checkHandler, undefined); checkHandler = handler; },
  };
  installDesktopPermissions(session as Session, () => current, () => state.endpoint);
  assert.ok(requestHandler); assert.ok(checkHandler);
  return {
    state, contents,
    setCurrent(value: WebContents | undefined) { current = value; },
    request(permission: Parameters<RequestHandler>[1] = 'media', overrides: Partial<MediaAccessPermissionRequest> = {}, sender = contents) {
      const replies: boolean[] = [];
      requestHandler!(sender, permission, granted => replies.push(granted), {
        isMainFrame: true, requestingUrl: state.url, mediaTypes: ['audio'], ...overrides,
      });
      assert.equal(replies.length, 1, 'Permission requests must receive exactly one decision');
      assert.equal(typeof replies[0], 'boolean');
      return replies[0];
    },
    check(permission: Parameters<CheckHandler>[1] = 'media', overrides: Partial<CheckDetails> = {}, sender: WebContents | null = contents, origin = state.endpoint) {
      return checkHandler!(sender, permission, origin, { isMainFrame: true, requestingUrl: state.url, mediaType: 'audio', ...overrides });
    },
  };
}

test('registered permission callbacks allow only main conversation microphone and sanitized clipboard writes', () => {
  const f = fixture();
  for (const suffix of ['/', '/?token=fixture#conversation']) {
    f.state.url = f.state.endpoint + suffix;
    assert.equal(f.request(), true);
    assert.equal(f.check(), true);
    assert.equal(f.request('clipboard-sanitized-write', { mediaTypes: undefined }), true);
    assert.equal(f.check('clipboard-sanitized-write', { mediaType: undefined }), true);
  }
});

test('cameras, mixed or absent media types and unrelated permissions stay denied', () => {
  const f = fixture();
  for (const mediaTypes of [undefined, [], ['video'], ['audio', 'video'], ['audio', 'audio']] as MediaAccessPermissionRequest['mediaTypes'][]) {
    assert.equal(f.request('media', { mediaTypes }), false, JSON.stringify(mediaTypes));
  }
  // A future or malformed Electron value must not widen the audio-only boundary.
  assert.equal(f.request('media', { mediaTypes: ['unknown'] as unknown as MediaAccessPermissionRequest['mediaTypes'] }), false);
  for (const mediaType of [undefined, 'video', 'unknown'] as const) assert.equal(f.check('media', { mediaType }), false);
  for (const permission of ['display-capture', 'unknown', 'clipboard-read', 'geolocation', 'notifications', 'openExternal', 'speaker-selection'] as const) assert.equal(f.request(permission), false, permission);
  for (const permission of ['clipboard-read', 'geolocation', 'notifications', 'openExternal', 'mediaKeySystem'] as const) assert.equal(f.check(permission), false, permission);
});

test('same-origin and foreign subframes cannot acquire microphone or clipboard permissions', () => {
  const f = fixture();
  for (const requestingUrl of [f.state.url, 'https://example.invalid/']) {
    for (const permission of ['media', 'clipboard-sanitized-write'] as const) {
      assert.equal(f.request(permission, { isMainFrame: false, requestingUrl }), false);
      assert.equal(f.check(permission, { isMainFrame: false, requestingUrl }), false);
      assert.equal(f.check(permission, { isMainFrame: false, requestingUrl: undefined, embeddingOrigin: f.state.endpoint }), false);
    }
  }
});

test('other webContents are denied even when they display the same trusted document', () => {
  const f = fixture();
  const other = { getURL: () => f.state.url, isDestroyed: () => false } as WebContents;
  for (const permission of ['media', 'clipboard-sanitized-write'] as const) {
    assert.equal(f.request(permission, {}, other), false);
    assert.equal(f.check(permission, {}, other), false);
    assert.equal(f.check(permission, {}, null), false);
  }
});

test('closed or unavailable windows do not retain an earlier permission grant', () => {
  const f = fixture();
  assert.equal(f.request(), true); assert.equal(f.check(), true);
  f.state.destroyed = true;
  assert.equal(f.request(), false); assert.equal(f.check(), false);
  f.state.destroyed = false;
  f.setCurrent(undefined);
  assert.equal(f.request(), false); assert.equal(f.check(), false);
  const replacement = { getURL: () => f.state.url, isDestroyed: () => false } as WebContents;
  f.setCurrent(replacement);
  assert.equal(f.request(), false); assert.equal(f.check(), false);
  assert.equal(f.request('media', {}, replacement), true); assert.equal(f.check('media', {}, replacement), true);
});

test('setup pages and navigation away from the conversation cannot inherit its microphone permission', () => {
  const f = fixture();
  const original = f.state.url;
  for (const url of ['file:///fixture/setup.html', 'dsh-app://setup/', f.state.endpoint + '/setup', f.state.endpoint + '/api/file', 'https://example.invalid/', 'about:blank']) {
    f.state.url = url;
    assert.equal(f.request('media', { requestingUrl: original }), false, url);
    assert.equal(f.check('media', { requestingUrl: original }), false, url);
    assert.equal(f.request('clipboard-sanitized-write'), false, url);
    assert.equal(f.check('clipboard-sanitized-write'), false, url);
  }
});

test('requesting document and check origin must independently match the current endpoint', () => {
  const f = fixture();
  for (const url of ['https://example.invalid/', 'http://127.0.0.1:31878/', 'http://localhost:31877/', 'https://127.0.0.1:31877/', f.state.endpoint + '/setup', 'http://user:pass@127.0.0.1:31877/', '', 'not a URL']) {
    for (const permission of ['media', 'clipboard-sanitized-write'] as const) {
      assert.equal(f.request(permission, { requestingUrl: url }), false, url);
      assert.equal(f.check(permission, { requestingUrl: url }), false, url);
      assert.equal(f.check(permission, {}, f.contents, url), false, url);
    }
  }
  assert.equal(f.check('media', { requestingUrl: undefined }), false);
  assert.equal(f.check('clipboard-sanitized-write', { requestingUrl: undefined }), false);
});

test('endpoint changes require the new owned document instead of a stale trusted origin', () => {
  const f = fixture();
  const oldEndpoint = f.state.endpoint;
  assert.equal(f.request(), true); assert.equal(f.check(), true);
  f.state.endpoint = 'http://127.0.0.1:31878';
  assert.equal(f.request(), false); assert.equal(f.check('media', {}, f.contents, oldEndpoint), false);
  f.state.url = f.state.endpoint + '/';
  assert.equal(f.request(), true); assert.equal(f.check(), true);
  assert.equal(f.request('media', { requestingUrl: oldEndpoint + '/' }), false);
  assert.equal(f.check('media', {}, f.contents, oldEndpoint), false);
});
