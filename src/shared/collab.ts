import type { CollabEvent, CollabPeer, ExecutionReport } from '../../services/relay/src/collab-types.ts';
export type CollabExecutionMode = 'manual' | 'continuous';
export type CollabDecision = { eventId: number; decision: 'adopt' | 'verify' | 'defer' | 'reject'; reason: string };
export type CollabCheckpoint = { action: 'continue' | 'wait' | 'ready'; summary: string; nextStep: string; wakeOn: string[]; decisions: CollabDecision[]; contribution?: { summary: string } };
export type CollabLocalAttempt = {
  id: string; taskId: string; title: string; direction: string; baseRevision: number; currentTaskRevision: number;
  publicDirection?: string; candidateReplyId?: string;
  status: 'working' | 'waiting' | 'ready' | 'paused' | 'budget' | 'submitted' | 'withdrawn' | 'completed' | 'error';
  desiredState: 'active' | 'paused' | 'withdrawn'; executionMode: CollabExecutionMode; publishMode: CollabPublishMode;
  limits: CollabSettings; startedAt: number; updatedAt: number; runIds: string[]; activeRunId?: string;
  nextStep: string; waitReason: string; wakeOn: string[]; usedTokens: number; usedMillis: number;
  receivedCursor: number; reviewedCursor: number; pendingEvents: CollabEvent[]; eventEpoch?: number;
  decisions: (CollabDecision & { at: number })[];
  eventArchive?: { at: number; reason: string; receivedCursor: number; reviewedCursor: number; pendingEvents: CollabEvent[]; decisions: (CollabDecision & { at: number })[] }[];
  publicUpdate?: { operationId: string; payload: Record<string, unknown> }; syncError?: string;
};
export type CollabRun = {
  id: string; taskId: string; title: string; taskRevision: number; mode: 'reply' | 'solve'; sessionId: string;
  startedAt: number; finishedAt?: number; status: 'preparing' | 'running' | 'completed' | 'stopped' | 'error';
  limits: CollabSettings;
  error?: string; stopReason?: string; output?: string; report?: ExecutionReport; reportSnapshot?: string; eventCount?: number;
  publishMode?: CollabPublishMode;
  submission?: CollabSubmission; submissionError?: string;
  submittedReplyId?: string;
  submittedKind?: 'message' | 'solution'; replacesReplyId?: string;
  publicationSkipReason?: string; inputContributionDigests?: string[];
  publication?: { operationId: string; status: 'pending' | 'published' | 'error'; error?: string; replyId?: string; payload?: Record<string, unknown> };
  attemptId?: string; triggerEventIds?: number[]; checkpoint?: CollabCheckpoint; checkpointHandled?: boolean; settledTokens?: number; activeMillis?: number; eventEpoch?: number;
};
export type CollabPublishMode = 'manual' | 'review' | 'auto';
export type CollabGeneratedFile = { id: string; path: string; name: string; size: number; sha256: string; uploadId: string; attachmentId?: string };
export type CollabSubmission = { body: string; verification: string; limitations: string; files: CollabGeneratedFile[] };
export type CollabSettings = { maxTokens: number; maxMinutes: number; publishMode?: CollabPublishMode; executionMode?: CollabExecutionMode };
export const MAX_COLLAB_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60000);
export const DEFAULT_COLLAB_SETTINGS: CollabSettings = { maxTokens: 1_000_000, maxMinutes: 480, publishMode: 'review', executionMode: 'manual' };
export function collabSettings(maxTokens: unknown, maxMinutes: unknown, publishMode: unknown = 'review', executionMode: unknown = 'manual'): CollabSettings {
  if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 0) throw new Error('Token 阈值须为非负整数，0 表示不限制；数值不能超过 9007199254740991。');
  if (typeof maxMinutes !== 'number' || !Number.isSafeInteger(maxMinutes) || maxMinutes < 0 || maxMinutes > MAX_COLLAB_MINUTES) throw new Error(`运行时间须为非负整数分钟，0 表示不限制；数值不能超过 ${MAX_COLLAB_MINUTES} 分钟。`);
  if (!['manual', 'review', 'auto'].includes(publishMode as string)) throw new Error('请选择手动发布、AI 生成人审核后发布或 AI 自动发布。');
  if (!['manual', 'continuous'].includes(executionMode as string)) throw new Error('请选择手动推进或在预算内持续探索。');
  if (executionMode === 'continuous' && maxTokens === 0 && maxMinutes === 0) throw new Error('持续探索至少需要一项有限的 Token 或时间预算。');
  return { maxTokens, maxMinutes, publishMode: publishMode as CollabPublishMode, executionMode: executionMode as CollabExecutionMode };
}
export type CollabState = {
  peer: CollabPeer; registered: boolean; syncing: boolean; origin?: string;
  unread: number; cursor: number; lastSyncAt?: number; settings: CollabSettings; runs: Omit<CollabRun, 'output' | 'report' | 'submission'>[];
  attempts: CollabLocalAttempt[];
};
export type CollabRpcResult<T = any> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: object } };
