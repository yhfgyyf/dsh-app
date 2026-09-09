export const UPDATE_REPOSITORY = 'yhfgyyf/dsh-app';
export const RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=100`;

export type UpdateSchedule = { mode: 'startup' | 'daily'; time: string };
export const DEFAULT_UPDATE_SCHEDULE: UpdateSchedule = { mode: 'startup', time: '09:00' };

export function validateUpdateSchedule(value: unknown): UpdateSchedule {
  const schedule = value as Partial<UpdateSchedule> | null;
  if (!schedule || !['startup', 'daily'].includes(schedule.mode ?? '') || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time ?? '')) throw new Error('请选择启动检查或每日检查，并设置有效时间。');
  return { mode: schedule.mode!, time: schedule.time! };
}

export function localDay(date: Date) { return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`; }

export function nextDailyCheck(now: Date, time: string, lastDay?: string): Date {
  validateUpdateSchedule({ mode: 'daily', time });
  const [hour, minute] = time.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime() || localDay(now) === lastDay) next.setDate(next.getDate() + 1);
  return next;
}

export type UpdateState = {
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  currentVersion: string;
  schedule: UpdateSchedule;
  version?: string;
  releaseUrl?: string;
  progress?: number;
  checkedAt?: string;
  error?: string;
  retry?: 'check' | 'download' | 'install';
};

export type UpdateRelease = { version: string; releaseUrl: string; assetUrl: string; name: string; bytes: number; sha256: string };

/** Compare release versions, including numeric prerelease identifiers. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z.-]+)?$/.exec(value);
    if (!match) throw new Error('无效的应用版本号。');
    return { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') };
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return Math.sign(a.numbers[i] - b.numbers[i]);
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Published previews count: this repository distributes its desktop builds as previews. */
export function selectUpdate(value: unknown, current: string, platform: string, arch: string): UpdateRelease | undefined {
  const suffix = platform === 'darwin' && arch === 'arm64' ? 'macOS-arm64.zip' : platform === 'win32' && arch === 'x64' ? 'Windows-x64-Setup.exe' : undefined;
  if (!suffix) throw new Error('此系统暂不支持应用内更新。');
  if (!Array.isArray(value)) throw new Error('GitHub 返回了无效的版本列表。');
  const candidates: UpdateRelease[] = [];
  for (const entry of value) {
    if (!entry || entry.draft || !entry.published_at || typeof entry.tag_name !== 'string' || !Array.isArray(entry.assets)) continue;
    const version = entry.tag_name.replace(/^v/, '');
    try { if (compareVersions(version, current) <= 0) continue; } catch { continue; }
    const name = `DSH-Desktop-${version}-${suffix}`;
    const asset = entry.assets.find((item: any) => item?.name === name && item.state === 'uploaded');
    if (!asset) continue;
    const expectedUrl = `https://github.com/${UPDATE_REPOSITORY}/releases/download/${encodeURIComponent(entry.tag_name)}/${name}`;
    if (asset.browser_download_url !== expectedUrl || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest ?? '') || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 2 ** 31) throw new Error(`版本 ${version} 的安装包校验信息无效。`);
    candidates.push({ version, name, assetUrl: expectedUrl, releaseUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${encodeURIComponent(entry.tag_name)}`, bytes: asset.size, sha256: asset.digest.slice(7).toLowerCase() });
  }
  return candidates.sort((a, b) => compareVersions(b.version, a.version))[0];
}
