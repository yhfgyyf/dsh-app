import { open, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { UpdateRelease } from '../shared/updates.ts';

export type UpdateFetch = typeof globalThis.fetch;

/** GitHub redirects assets to its release CDN; no application credentials are sent. */
export async function githubFetch(url: string, fetch: UpdateFetch, signal: AbortSignal): Promise<Response> {
  for (let redirects = 0; redirects < 6; redirects++) {
    const address = new URL(url);
    if (address.protocol !== 'https:' || address.username || address.password || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(address.hostname)) throw new Error('更新下载地址不属于 GitHub。');
    const response = await fetch(url, { redirect: 'manual', credentials: 'omit', signal, headers: { 'User-Agent': 'DSH-Desktop-Updater', Accept: address.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('GitHub 下载重定向无效。');
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 403 || response.status === 429 ? 'GitHub 请求暂时受限，请稍后重试。' : `GitHub 请求失败 (${response.status})。`); }
    return response;
  }
  throw new Error('GitHub 下载重定向次数过多。');
}

export async function downloadUpdate(release: UpdateRelease, destination: string, fetch: UpdateFetch, progress: (value: number) => void) {
  const temporary = destination + '.part';
  const response = await githubFetch(release.assetUrl, fetch, AbortSignal.timeout(15 * 60 * 1000));
  if (!response.body) throw new Error('安装包下载为空。');
  const file = await open(temporary, 'wx', 0o600);
  const hash = createHash('sha256');
  let received = 0;
  try {
    for await (const value of response.body) {
      received += value.byteLength;
      if (received > release.bytes) throw new Error('安装包大小与 GitHub 发布记录不符。');
      hash.update(value);
      await file.writeFile(value);
      progress(Math.floor(received / release.bytes * 100));
    }
    if (received !== release.bytes || hash.digest('hex') !== release.sha256) throw new Error('安装包 SHA-256 校验失败，请重新下载。');
    await file.sync();
    await file.close();
    await rename(temporary, destination);
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}
