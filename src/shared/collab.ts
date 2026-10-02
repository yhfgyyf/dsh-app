import type { CollabPeer, ExecutionReport } from '../../services/relay/src/collab-types.ts';
export type CollabRun = {
  id: string; taskId: string; title: string; taskRevision: number; mode: 'reply' | 'solve'; sessionId: string;
  startedAt: number; finishedAt?: number; status: 'preparing' | 'running' | 'completed' | 'stopped' | 'error';
  limits: CollabSettings;
  error?: string; stopReason?: string; output?: string; report?: ExecutionReport; reportSnapshot?: string; eventCount?: number;
  publishMode?: CollabPublishMode;
  submission?: CollabSubmission; submissionError?: string;
  submittedReplyId?: string;
  publication?: { operationId: string; status: 'pending' | 'published' | 'error'; error?: string; replyId?: string; payload?: Record<string, unknown> };
};
export type CollabPublishMode = 'manual' | 'review' | 'auto';
export type CollabGeneratedFile = { id: string; path: string; name: string; size: number; sha256: string; uploadId: string; attachmentId?: string };
export type CollabSubmission = { body: string; verification: string; limitations: string; files: CollabGeneratedFile[] };
export type CollabSettings = { maxTokens: number; maxMinutes: number; publishMode?: CollabPublishMode };
export const MAX_COLLAB_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60000);
export const DEFAULT_COLLAB_SETTINGS: CollabSettings = { maxTokens: 1_000_000, maxMinutes: 480, publishMode: 'review' };
export function collabSettings(maxTokens: unknown, maxMinutes: unknown, publishMode: unknown = 'review'): CollabSettings {
  if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 0) throw new Error('Token 阈值须为非负整数，0 表示不限制；数值不能超过 9007199254740991。');
  if (typeof maxMinutes !== 'number' || !Number.isSafeInteger(maxMinutes) || maxMinutes < 0 || maxMinutes > MAX_COLLAB_MINUTES) throw new Error(`运行时间须为非负整数分钟，0 表示不限制；数值不能超过 ${MAX_COLLAB_MINUTES} 分钟。`);
  if (!['manual', 'review', 'auto'].includes(publishMode as string)) throw new Error('请选择手动发布、AI 生成人审核后发布或 AI 自动发布。');
  return { maxTokens, maxMinutes, publishMode: publishMode as CollabPublishMode };
}
export type CollabState = {
  peer: CollabPeer; syncing: boolean; origin?: string;
  unread: number; cursor: number; lastSyncAt?: number; settings: CollabSettings; runs: Omit<CollabRun, 'output' | 'report' | 'submission'>[];
};
export type CollabRpcResult<T = any> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: object } };
