export interface MarketplaceRequest {
  query: string;
  /** Zero-based npm candidate page. */
  page?: number;
}

export interface MarketplaceItem {
  name: string;
  version: string;
  description: string;
  npmUrl: string;
  homepage?: string;
  repository?: string;
  /** Canonical repository root only when published metadata explicitly identifies GitHub. */
  githubUrl?: string;
  /** npm package-wide downloads for the returned inclusive date range, not a safety score. */
  downloads?: { count: number; start: string; end: string };
  author?: string;
  /** A declared bundle is not proof that third-party code works on this host. */
  compatibility: 'unknown';
  bundleVerified: true;
}

export interface MarketplaceResult {
  items: MarketplaceItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** npm candidate count, not the number of verified or compatible bundles. */
  total: number;
  source: 'npm';
  skipped: number;
  warning?: string;
}

export type MarketplaceErrorCode = 'marketplace/invalid-query' | 'marketplace/unavailable' | 'marketplace/invalid-response' | 'marketplace/cancelled' | 'marketplace/timeout' | 'marketplace/not-found';
export type MarketplaceRpcResult = { ok: true; value: MarketplaceResult } | { ok: false; error: { code: MarketplaceErrorCode; message: string; details: object } };
