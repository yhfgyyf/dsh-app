export type BrowserUseState = {
  enabled: boolean;
  phase: 'disabled' | 'starting' | 'ready' | 'stopping' | 'error';
  browser?: string;
  error?: string;
};

export type BrowserUseConfig = { enabled: false } | { enabled: true; executablePath: string };
