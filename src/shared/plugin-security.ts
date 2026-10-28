export interface PackageReviewMaterials {
  name: string;
  version: string;
  spec: string;
  integrity: string;
  sha256: string;
  repository?: string;
  files: { path: string; content: string; truncated?: boolean }[];
  facts: {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    optionalDependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
  };
  scope: {
    filesTotal: number;
    filesReviewed: number;
    bytesReviewed: number;
    archiveBytes: number;
    expandedBytes: number;
    omittedFiles: number;
    truncated: boolean;
    dependencies: 'manifest-only';
  };
  limitations: string[];
}

export type PluginRisk = 'low' | 'medium' | 'high' | 'unknown';
export interface PluginSecurityFinding {
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  evidence: { path: string; quote: string };
  recommendation: string;
}
export interface PluginSecurityReport {
  status: 'complete' | 'incomplete';
  spec: string;
  /** Host-issued handle for the exact reviewed archive; never supplied by the model. */
  reviewId?: string;
  name?: string;
  version?: string;
  integrity?: string;
  sha256?: string;
  checkedAt: string;
  reviewer?: { provider: string; model: string };
  summary: string;
  risk: PluginRisk;
  findings: PluginSecurityFinding[];
  limitations: string[];
  scope?: PackageReviewMaterials['scope'];
  /** A report never authorizes installation. The person must confirm in the UI. */
  requiresConfirmation: true;
  error?: {
    code: 'invalid-input' | 'package-unavailable' | 'model-unavailable' | 'invalid-response' | 'output-limit' | 'stream-failed' | 'cancelled' | 'timeout';
    message: string;
  };
}
