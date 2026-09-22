import { inspectNpmPackage, PackageInspectionError, PACKAGE_ARCHIVE_LIMIT } from './plugin-audit-package.ts';
import { reviewPlugin } from './plugin-security.ts';
import type { PluginReviewDependencies } from './plugin-security.ts';
import type { PluginSecurityReport } from '../shared/plugin-security.ts';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'dsh-desktop-plugin-security';
export const inject = ['connection', 'llm', 'agentDefaultModel', 'profileContext'];
type RpcResult = { ok: true; value: PluginSecurityReport | { spec: string; sha256: string; installSpec: string } } | { ok: false; error: { code: string; message: string; details: object } };
interface RuntimeContext {
  connection: { rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult>): () => void | Promise<void> } };
  llm: PluginReviewDependencies['llm'];
  agentDefaultModel: PluginReviewDependencies['agentDefaultModel'];
  profileContext: { dir: string };
  effect(factory: () => (() => void | Promise<void>), label?: string): unknown;
}
class PackageCacheError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function apply(ctx: RuntimeContext) {
  let active = false;
  const reviews = new Map<string, { report: PluginSecurityReport; path: string }>();
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const failure = (code: string, message: string): RpcResult => ({ ok: false, error: { code: 'plugin-review/' + code, message, details: {} } });
  const installFailure = (code: string, message: string): RpcResult => ({ ok: false, error: { code: 'plugin-install/' + code, message, details: {} } });
  const cacheArchive = async (archive: Buffer, sha256: string, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    const directory = join(ctx.profileContext.dir, 'reviewed-packages');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new PackageCacheError('cache', '安装包缓存路径无效，未开始安装。');
    const path = join(directory, sha256 + '.tgz');
    try { await writeFile(path, archive, { flag: 'wx', mode: 0o444 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PACKAGE_ARCHIVE_LIMIT || stat.size !== archive.length || hash(await readFile(path)) !== sha256) throw new PackageCacheError('changed', '安装包缓存与下载内容不一致，未开始安装。');
    signal.throwIfAborted();
    return path;
  };
  ctx.effect(() => ctx.connection.rpc.handle('/desktop-plugin-security', async (endpoint, payload, signal) => {
    const body = payload as { args?: { spec?: unknown; reviewId?: unknown } } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'args')
      || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) return endpoint === 'prepare-direct-install'
        ? installFailure('invalid-input', '插件安装准备参数无效。') : failure('invalid-input', '插件检查参数无效。');
    for (const [id, review] of reviews) if (Date.now() - Date.parse(review.report.checkedAt) >= 600000) reviews.delete(id);
    if (endpoint === 'prepare-direct-install') {
      if (Object.keys(body.args).some(key => key !== 'spec') || typeof body.args.spec !== 'string' || body.args.spec.length > 320
        || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(body.args.spec)) return installFailure('invalid-input', '直接安装准备需要公共 npm 包的精确版本。');
      try {
        let archive: Buffer | undefined;
        const inspected = await inspectNpmPackage(body.args.spec, signal, { onArchive: bytes => { archive = bytes; } });
        if (!archive) return installFailure('unavailable', '无法下载或准备安装包，未开始安装。请重试。');
        const path = await cacheArchive(archive, inspected.sha256, signal);
        return { ok: true, value: { spec: inspected.spec, sha256: inspected.sha256, installSpec: path } };
      } catch (error) {
        if (signal.aborted) return installFailure('cancelled', '安装包准备已取消，未开始安装。');
        if (error instanceof PackageCacheError) return installFailure(error.code, error.message);
        const detail = error instanceof PackageInspectionError
          ? error.message.replaceAll('未完成检查', '未开始安装').replaceAll('检查上限', '大小上限').replaceAll('审查材料', '安装包') : '请重试。';
        return installFailure('unavailable', '安装包下载或准备失败：' + detail);
      }
    }
    if (endpoint === 'prepare-install') {
      if (Object.keys(body.args).some(key => key !== 'reviewId') || typeof body.args.reviewId !== 'string') return failure('invalid-input', '安装确认参数无效。');
      const reviewed = reviews.get(body.args.reviewId);
      if (!reviewed) return failure('expired', '检查报告已过期，请重新检查。');
      try {
        const stat = await lstat(reviewed.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PACKAGE_ARCHIVE_LIMIT || hash(await readFile(reviewed.path)) !== reviewed.report.sha256) return failure('changed', '已检查的安装包发生变化，请重新检查。');
        signal.throwIfAborted();
        return { ok: true, value: { spec: reviewed.report.spec, sha256: reviewed.report.sha256!, installSpec: reviewed.path } };
      } catch { return failure('unavailable', '已检查的安装包不可用，请重新检查。'); }
    }
    if (endpoint !== 'review' || Object.keys(body.args).some(key => key !== 'spec') || typeof body.args.spec !== 'string'
      || !body.args.spec.trim() || body.args.spec.length > 320 || /[\u0000-\u001f\u007f]/.test(body.args.spec)) return failure('invalid-input', '插件检查参数无效。');
    if (active) return { ok: false, error: { code: 'plugin-review/busy', message: '已有插件检查正在进行，请稍后重试。', details: {} } };
    active = true;
    try {
      let archive: Buffer | undefined;
      let inspectionProblem: string | undefined;
      const report = await reviewPlugin(body.args.spec.trim(), signal, { inspectPackage: async (spec, abort) => {
        try { return await inspectNpmPackage(spec, abort, { onArchive: bytes => { archive = bytes; } }); }
        catch (error) { if (error instanceof PackageInspectionError) inspectionProblem = error.message; throw error; }
      }, llm: ctx.llm, agentDefaultModel: ctx.agentDefaultModel });
      if (report.error?.code === 'package-unavailable' && inspectionProblem) { report.error.message = inspectionProblem; report.summary = inspectionProblem; }
      if (report.error || !archive || !report.sha256) return { ok: true, value: report };
      const path = await cacheArchive(archive, report.sha256, signal);
      report.reviewId = randomUUID();
      if (reviews.size >= 32) reviews.delete(reviews.keys().next().value!);
      reviews.set(report.reviewId, { report, path });
      return { ok: true, value: report };
    } catch (error) {
      if (error instanceof PackageCacheError) return failure(error.code, error.message);
      return failure('unavailable', '无法保存已检查的安装包，未开始安装。请重试。');
    } finally { active = false; }
  }), name);
}
