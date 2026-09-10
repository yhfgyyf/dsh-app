import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { constants, openSync, closeSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DEFAULT_UPDATE_SCHEDULE, RELEASES_URL, localDay, nextDailyCheck, selectUpdate, validateUpdateSchedule, type UpdateRelease, type UpdateSchedule, type UpdateState } from '../shared/updates.ts';
import { downloadUpdate, githubFetch, type UpdateFetch } from './update-download.ts';
import { fileSha256, physicalFs, run, type InstallPlan } from '../updater/install.ts';
import { macUpdateTarget } from './update-target.ts';
import { verifyMacSigningContinuity } from './macos-signature.ts';

const execute = promisify(execFile);
type Options = {
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  appPath: string;
  runtimeRoot: string;
  executable: string;
  packaged: boolean;
  userApplications?: string;
  corePid: () => number | undefined;
  quit: () => void;
  publish: (state: UpdateState) => void;
  fetch?: UpdateFetch;
};

/** Verify the complete macOS bundle before placing it next to the current app. */
export async function prepareMacUpdate(archive: string, directory: string, version: string) {
  const { stdout } = await execute('/usr/bin/unzip', ['-Z1', archive], { maxBuffer: 16 * 1024 * 1024 });
  const entries = stdout.split('\n').filter(Boolean);
  if (!entries.length || entries.some(path => path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || !['DSH Desktop.app', '__MACOSX'].includes(path.split('/')[0]))) throw new Error('更新 ZIP 的文件路径无效。');
  const extracted = join(directory, 'extracted');
  await mkdir(extracted);
  await run('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
  const bundle = join(extracted, 'DSH Desktop.app');
  const root = await realpath(bundle);
  async function verifyLinks(path: string) {
    for (const entry of await physicalFs.promises.readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(file);
        if (resolved !== root && !resolved.startsWith(root + sep)) throw new Error('更新包包含越界的符号链接。');
      } else if (entry.isDirectory()) await verifyLinks(file);
      else if (!(await physicalFs.promises.lstat(file)).isFile()) throw new Error('更新包包含无效文件。');
    }
  }
  await verifyLinks(bundle);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const info = join(bundle, 'Contents/Info.plist');
  const get = async (key: string) => (await execute('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', info])).stdout.trim();
  if (await get('CFBundleIdentifier') !== 'io.dsh.desktop' || await get('CFBundleShortVersionString') !== version) throw new Error('更新包的应用标识或版本不匹配。');
  return bundle;
}

export class DesktopUpdates {
  state: UpdateState;
  private release?: UpdateRelease;
  private downloaded?: { path: string; directory: string; bundle?: string };
  private busy?: Promise<UpdateState>;
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private lastDailyCheck?: string;
  private preferenceWrites: Promise<void> = Promise.resolve();
  private fetch: UpdateFetch;
  private options: Options;
  constructor(options: Options) {
    this.options = options;
    this.state = { status: 'idle', currentVersion: options.currentVersion, schedule: { ...DEFAULT_UPDATE_SCHEDULE } };
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  private set(state: Partial<UpdateState>) {
    this.state = { ...this.state, error: undefined, retry: undefined, ...state };
    this.options.publish(this.state);
    return this.state;
  }
  start() {
    if (!this.options.packaged || this.started) return;
    this.started = true;
    this.scheduleNext(true);
  }
  stop() { clearTimeout(this.timer); this.timer = undefined; this.started = false; }
  private scheduleNext(launch = false) {
    clearTimeout(this.timer);
    const daily = this.state.schedule.mode === 'daily';
    if (!daily && !launch) return;
    const delay = daily ? nextDailyCheck(new Date(), this.state.schedule.time, this.lastDailyCheck).getTime() - Date.now() : 15000;
    this.timer = setTimeout(() => {
      if (daily) {
        this.lastDailyCheck = localDay(new Date());
        void this.saveSchedule().catch(() => {});
      }
      void this.check().finally(() => { if (this.started && this.state.schedule.mode === 'daily') this.scheduleNext(); });
    }, Math.max(0, delay));
    this.timer.unref();
  }
  private saveSchedule(schedule?: UpdateSchedule) {
    const write = this.preferenceWrites.then(async () => {
      await mkdir(this.options.home, { recursive: true });
      const temporary = join(this.options.home, `preferences-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify({ ...(schedule ?? this.state.schedule), lastDailyCheck: this.lastDailyCheck }), { mode: 0o600 });
      await rename(temporary, join(this.options.home, 'preferences.json'));
      if (schedule) this.set({ schedule, error: this.state.error, retry: this.state.retry });
    });
    this.preferenceWrites = write.catch(() => {});
    return write;
  }
  async setSchedule(value: unknown): Promise<UpdateState> {
    const schedule = validateUpdateSchedule(value);
    await this.saveSchedule(schedule);
    if (this.started) this.scheduleNext();
    return this.state;
  }
  private work(retry: NonNullable<UpdateState['retry']>, task: () => Promise<UpdateState>): Promise<UpdateState> {
    if (this.busy) return this.busy;
    this.busy = task().catch(error => this.set({ status: 'error', retry: retry === 'install' && !this.downloaded ? 'download' : retry, error: error instanceof Error ? error.message : '更新失败，请重试。' })).finally(() => { this.busy = undefined; });
    return this.busy;
  }
  check(): Promise<UpdateState> {
    if (this.downloaded || this.state.status === 'installing') return Promise.resolve(this.state);
    return this.work('check', async () => {
      this.set({ status: 'checking' });
      const response = await githubFetch(RELEASES_URL, this.fetch, AbortSignal.timeout(15000));
      let text = '';
      if (!response.body) throw new Error('GitHub 版本列表为空。');
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        text += decoder.decode(chunk, { stream: true });
        if (text.length > 4 * 1024 * 1024) throw new Error('GitHub 版本列表过大。');
      }
      text += decoder.decode();
      this.release = selectUpdate(JSON.parse(text), this.options.currentVersion, this.options.platform, this.options.arch);
      return this.set({ status: this.release ? 'available' : 'current', version: this.release?.version, releaseUrl: this.release?.releaseUrl, progress: undefined, checkedAt: new Date().toISOString() });
    });
  }
  download(): Promise<UpdateState> {
    if (this.state.status === 'ready' || this.state.status === 'installing') return Promise.resolve(this.state);
    if (this.downloaded) return Promise.resolve(this.set({ status: 'ready', progress: 100 }));
    return this.work('download', async () => {
      if (!this.release) throw new Error('请先检查应用更新。');
      this.set({ status: 'downloading', progress: 0 });
      await mkdir(this.options.home, { recursive: true });
      const directory = await mkdtemp(join(this.options.home, 'download-'));
      const path = join(directory, this.release.name);
      await downloadUpdate(this.release, path, this.fetch, progress => { if (progress !== this.state.progress) this.set({ progress }); });
      const bundle = this.options.platform === 'darwin' ? await prepareMacUpdate(path, directory, this.release.version) : undefined;
      this.downloaded = { path, directory, bundle };
      return this.set({ status: 'ready', progress: 100 });
    });
  }
  install(): Promise<UpdateState> {
    return this.work('install', async () => {
      if (!this.options.packaged) throw new Error('请从已安装的 DSH Desktop 中执行更新。');
      if (!this.downloaded || !this.release) throw new Error('请先下载并校验更新。');
      const { directory, path, bundle } = this.downloaded;
      const platform = this.options.platform;
      if (platform !== 'darwin' && platform !== 'win32') throw new Error('此系统暂不支持安装更新。');
      let target = platform === 'darwin' ? dirname(dirname(dirname(this.options.executable))) : dirname(this.options.executable);
      if (platform === 'darwin' && !relative(target, this.options.appPath).startsWith('Contents' + sep)) throw new Error('请将 DSH Desktop 放入应用程序目录后再更新。');
      if (await fileSha256(path).catch(() => undefined) !== this.release.sha256) { this.downloaded = undefined; throw new Error('已下载的安装包缺失或发生变化，请重新下载。'); }
      if (platform === 'darwin') target = await macUpdateTarget(target, this.options.userApplications, this.release.version);
      try { await access(dirname(target), constants.W_OK); }
      catch { throw new Error('应用所在目录不可写，请将应用安装到当前用户可写的目录。'); }
      let payload = path;
      const id = randomUUID();
      const backup = join(dirname(target), `.DSH-Desktop-backup-${this.options.currentVersion}-${id}${platform === 'darwin' ? '.app' : ''}`);
      if (platform === 'darwin') {
        if (!bundle) throw new Error('更新包尚未完成校验。');
        const stage = await mkdtemp(join(dirname(target), '.DSH-Desktop-update-'));
        payload = join(stage, 'DSH Desktop.app');
        await run('/usr/bin/ditto', [bundle, payload]);
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', payload]);
        const currentBundle = dirname(dirname(dirname(this.options.executable)));
        await verifyMacSigningContinuity(currentBundle, payload);
        if (target !== currentBundle) await verifyMacSigningContinuity(target, payload);
      }
      const helper = join(directory, 'install.cjs');
      const nodeName = platform === 'win32' ? 'node.exe' : 'node';
      const node = join(directory, nodeName);
      await writeFile(helper, await readFile(join(this.options.appPath, 'dist/updater/index.cjs')), { mode: 0o600 });
      await copyFile(join(this.options.runtimeRoot, 'bin', nodeName), node);
      if (platform !== 'win32') await chmod(node, 0o700);
      const plan: InstallPlan = { platform, parentPid: process.pid, corePid: this.options.corePid(), target, payload, backup, version: this.release.version, sha256: platform === 'darwin' ? await fileSha256(join(payload, 'Contents/Resources/app.asar')) : this.release.sha256, result: join(this.options.home, 'install-result.json') };
      const planPath = join(directory, 'install.json');
      await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
      const log = openSync(join(directory, 'install.log'), 'a', 0o600);
      let child;
      try { child = spawn(node, [helper, planPath], { detached: true, windowsHide: true, cwd: directory, stdio: ['ignore', log, log, 'ipc'] }); }
      finally { closeSync(log); }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('更新安装进程启动超时。')); }, 10000);
        child.once('message', message => { clearTimeout(timer); if ((message as { type?: string }).type === 'ready') resolve(); else reject(new Error('更新安装进程未就绪。')); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('更新安装进程已退出。')); });
      });
      child.unref();
      const state = this.set({ status: 'installing' });
      this.stop();
      this.options.quit();
      return state;
    });
  }
  async restoreResult() {
    try {
      const saved = JSON.parse(await readFile(join(this.options.home, 'preferences.json'), 'utf8'));
      this.lastDailyCheck = typeof saved.lastDailyCheck === 'string' ? saved.lastDailyCheck : undefined;
      this.set({ schedule: validateUpdateSchedule(saved) });
    } catch { /* A first launch defaults to checking once at startup. */ }
    try {
      const result = JSON.parse(await readFile(join(this.options.home, 'install-result.json'), 'utf8'));
      if (result.status === 'error') this.set({ status: 'error', error: `上次更新未完成：${String(result.error).slice(0, 400)}` });
    } catch { /* No previous installation. */ }
  }
}
