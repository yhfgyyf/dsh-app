export type BrowserUseMode = 'extension' | 'attach';

export type BrowserUseState = {
  enabled: boolean;
  phase: 'disabled' | 'starting' | 'ready' | 'stopping' | 'error';
  browser?: string;
  mode?: BrowserUseMode;
  cdpEndpoint?: string;
  error?: string;
  extensionTokenConfigured?: boolean;
  credentialError?: string;
  restartRequired?: boolean;
};

export type BrowserUseConfig = { enabled: false } | { enabled: true; cdpEndpoint: string } | { enabled: true; executablePath: string; userDataDir?: string; extensionToken?: string };
