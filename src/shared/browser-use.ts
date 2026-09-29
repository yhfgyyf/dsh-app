export type BrowserUseState = {
  enabled: boolean;
  phase: 'disabled' | 'starting' | 'ready' | 'stopping' | 'error';
  browser?: string;
  error?: string;
  extensionTokenConfigured?: boolean;
  credentialError?: string;
  restartRequired?: boolean;
};

export type BrowserUseConfig = { enabled: false } | { enabled: true; executablePath: string; userDataDir?: string; extensionToken?: string };
