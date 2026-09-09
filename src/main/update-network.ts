import { session } from 'electron';
import { isGitHubUpdateUrl, type UpdateFetch } from './update-download.ts';

/** Chromium follows system proxies; an isolated session guards every redirect before it connects. */
export function createUpdateFetch(): UpdateFetch {
  const updates = session.fromPartition('dsh-updates');
  updates.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, callback) => {
    callback({ cancel: !isGitHubUpdateUrl(request.url) });
  });
  // Chromium fetch cancels manual redirects. The session guard permits automatic
  // GitHub/CDN redirects without sharing the browser's cookies or credentials.
  return (input, options) => updates.fetch(input instanceof URL ? input.href : input, { ...options, credentials: 'omit', redirect: 'follow' });
}
