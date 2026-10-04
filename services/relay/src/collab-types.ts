/** Public collaboration protocol. This module is also bundled into the desktop plugin. */
export const COLLAB_PROTOCOL = 'dsh-collab-v1';
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT = 48 * 1024;
export type TaskStatus = 'open' | 'review' | 'resolved' | 'closed';
export type CollabActor = 'user' | 'dsh';
export type CollabPeer = { id: string; nickname: string; createdAt: number };
export type CollabJoinResult = CollabPeer & { recovery: { supported: true; ready: boolean } };
export type CollabAttachment = { id: string; name: string; size: number; sha256: string };
export type CollabTask = {
  id: string; authorId: string; title: string; description: string; acceptance: string; tags: string[];
  status: TaskStatus; revision: number; specRevision: number; createdAt: number; updatedAt: number; acceptedReplyId: string | null;
  replyCount: number; solutionCount: number; following: boolean;
};
export type UsageCounts = {
  uncachedInputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null;
  outputTokens: number | null; reasoningTokens: number | null; totalTokens: number | null;
};
export type ExecutionReport = {
  runId: string; startedAt: number; finishedAt: number;
  client: { appVersion: string; runtimeVersion: string; pluginVersion: string; platform: string; arch: string };
  usage: { status: 'complete' | 'partial' | 'unavailable'; source: 'client-runtime'; totals: UsageCounts;
    routes: ({ provider: string; model: string } & UsageCounts)[]; sessions: number; attempts: number };
};
export type CollabSolution = { verification: string; limitations: string; report: ExecutionReport | null };
export type CollabReply = {
  id: string; taskId: string; authorId: string; actor: CollabActor; kind: 'message' | 'solution';
  body: string; baseRevision: number; replaces: string | null; supersededBy?: string | null; attemptId: string | null; createdAt: number;
  solution: CollabSolution | null; attachments: CollabAttachment[];
};
export type CollabCandidates = { items: CollabReply[]; hasMore: boolean; total: number };
export type CollabParticipation = { peerId: string; status: 'working' | 'waiting' | 'submitted' | 'withdrawn'; updatedAt: number };
export type CollabAttempt = {
  id: string; taskId: string; peerId: string; baseRevision: number;
  status: 'working' | 'waiting' | 'ready' | 'paused' | 'budget' | 'submitted' | 'withdrawn' | 'completed' | 'error';
  direction: string; nextStep: string; waitReason: string; createdAt: number; updatedAt: number;
};
export type CollabValidation = {
  id: string; taskId: string; replyId: string; authorId: string; baseRevision: number; candidateDigest: string;
  outcome: 'passed' | 'failed' | 'inconclusive'; method: string; environment: string; evidence: string; createdAt: number;
};
export type CollabAcceptance = {
  id: string; taskId: string; replyId: string; authorId: string; validationId: string; baseRevision: number;
  candidateDigest: string; evidence: string; createdAt: number;
};
export type CollabDetail = { task: CollabTask; peers: CollabPeer[]; replies: CollabReply[]; attachments: CollabAttachment[]; participants: CollabParticipation[]; attempts: CollabAttempt[]; validations: CollabValidation[]; decision: CollabAcceptance | null; cursor: number; replyOffset: number; hasMore: boolean };
export type CollabEvent = { id: number; taskId: string; actorId: string; kind: string; subjectId: string | null; sourceAttemptId?: string | null; at: number };
export type CollabInboxItem = CollabEvent & { read: boolean; title: string };
export type CollabIdentity = { deviceId: string; kind: 'desktop' | 'mobile'; bindingId?: string; role: 'viewer' | 'control'; expiresAt: number };

export class CollabError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = code) { super(message); this.status = status; this.code = code; }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollabError(400, 'invalid_object');
  return value as Record<string, unknown>;
}
export function textField(value: unknown, max = MAX_TEXT, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!optional && !value.trim())) throw new CollabError(400, 'invalid_text');
  return value.trim();
}
export function idField(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new CollabError(400, 'invalid_id');
  return value;
}
export function numberField(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new CollabError(400, 'invalid_number');
  return value;
}
export function attachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new CollabError(400, 'invalid_attachments');
  const ids = value.map(idField);
  if (new Set(ids).size !== ids.length) throw new CollabError(400, 'duplicate_attachment');
  return ids;
}
export function tagsField(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new CollabError(400, 'invalid_tags');
  return [...new Set(value.map(v => textField(v, 32)))];
}
export const emptyCounts = (): UsageCounts => ({ uncachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null });
export function countsField(value: unknown): UsageCounts {
  const r = record(value), out = emptyCounts();
  for (const key of Object.keys(out) as (keyof UsageCounts)[]) out[key] = r[key] === null || r[key] === undefined ? null : numberField(r[key]);
  if (out.reasoningTokens !== null && out.outputTokens !== null && out.reasoningTokens > out.outputTokens) throw new CollabError(400, 'invalid_usage');
  const buckets = [out.uncachedInputTokens, out.cacheReadTokens, out.cacheWriteTokens, out.outputTokens];
  if (out.totalTokens !== null && buckets.every(v => v !== null) && buckets.reduce<number>((s, v) => s + v!, 0) !== out.totalTokens) throw new CollabError(400, 'inconsistent_usage');
  return out;
}
export function reportField(value: unknown): ExecutionReport | null {
  if (value === null || value === undefined) return null;
  const r = record(value), client = record(r.client), usage = record(r.usage);
  if (!['complete', 'partial', 'unavailable'].includes(usage.status as string) || usage.source !== 'client-runtime' || !Array.isArray(usage.routes) || usage.routes.length > 64) throw new CollabError(400, 'invalid_report');
  const startedAt = numberField(r.startedAt), finishedAt = numberField(r.finishedAt);
  if (finishedAt < startedAt) throw new CollabError(400, 'invalid_report_time');
  const totals = countsField(usage.totals);
  if (usage.status === 'complete' && (totals.uncachedInputTokens === null || totals.outputTokens === null || totals.totalTokens === null)) throw new CollabError(400, 'incomplete_usage');
  return { runId: idField(r.runId), startedAt, finishedAt,
    client: { appVersion: textField(client.appVersion, 80), runtimeVersion: textField(client.runtimeVersion, 80), pluginVersion: textField(client.pluginVersion, 80), platform: textField(client.platform, 32), arch: textField(client.arch, 32) },
    usage: { status: usage.status as ExecutionReport['usage']['status'], source: 'client-runtime', totals,
      routes: usage.routes.map(v => { const route = record(v); return { provider: textField(route.provider, 160), model: textField(route.model, 160), ...countsField(route) }; }),
      sessions: numberField(usage.sessions, 1, 10000), attempts: numberField(usage.attempts, 0, 100000) } };
}
