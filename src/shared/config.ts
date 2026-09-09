export type WindowBounds = {
  width: number;
  height: number;
  x?: number;
  y?: number;
};

export type DesktopPreferences = {
  version: 1;
  endpoint: string;
  window: WindowBounds & { maximized: boolean };
  zoomFactor: number;
  computerEnabled: boolean;
};

export type ConnectionInput = {
  endpoint: string;
  /** Used only for the initial DSH cookie exchange; never persist this URL. */
  launchUrl: string;
};

export function defaultPreferences(): DesktopPreferences {
  return {
    version: 1,
    endpoint: 'http://127.0.0.1:3080',
    window: { width: 1320, height: 900, maximized: false },
    zoomFactor: 1,
    computerEnabled: false,
  };
}

/** Validate the loopback address supplied by the app-owned core. */
export function parseConnectionInput(input: unknown): ConnectionInput {
  const invalid = () => new Error('DSH 核心地址无效。');
  if (typeof input !== 'string' || input.length > 8192) throw invalid();
  const text = input.trim();
  if (!/^https?:\/\//i.test(text) || /[\u0000-\u0020\u007f\\]/.test(text)) throw invalid();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid();
  }
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (!loopback.has(url.hostname) || url.port === '0' || url.username || url.password || url.pathname !== '/' || url.hash) {
    throw invalid();
  }
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== 'token') || keys.length > 1) throw invalid();
  if (keys.length === 1 && !url.searchParams.get('token')) throw invalid();
  return { endpoint: url.origin, launchUrl: url.href };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedNumber(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error('桌面配置包含无效数值。');
  }
  return value;
}

/** Validate and project a preferences file onto its public, credential-free schema. */
export function parsePreferences(value: unknown): DesktopPreferences {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.window)) {
    throw new Error('无法读取此版本的桌面配置。');
  }
  const endpoint = parseConnectionInput(value.endpoint).endpoint;
  const bounds: WindowBounds = {
    width: boundedNumber(value.window.width, 640, 16384, true),
    height: boundedNumber(value.window.height, 480, 16384, true),
  };
  // macOS displays to the left/above the primary display have negative coordinates.
  if (value.window.x !== undefined) bounds.x = boundedNumber(value.window.x, -131072, 131072, true);
  if (value.window.y !== undefined) bounds.y = boundedNumber(value.window.y, -131072, 131072, true);
  if (typeof value.window.maximized !== 'boolean') throw new Error('桌面窗口配置无效。');
  if (value.computerEnabled !== undefined && typeof value.computerEnabled !== 'boolean') throw new Error('电脑操作开关配置无效。');
  return {
    version: 1,
    endpoint,
    window: { ...bounds, maximized: value.window.maximized },
    zoomFactor: boundedNumber(value.zoomFactor, 0.5, 2),
    computerEnabled: value.computerEnabled ?? false,
  };
}

/** Limit navigation and native IPC to documents served by the selected DSH endpoint. */
export function isEndpointDocument(documentUrl: string, endpoint: string): boolean {
  try {
    const selected = parseConnectionInput(endpoint).endpoint;
    const document = new URL(documentUrl);
    return document.origin === selected && document.pathname === '/' && !document.username && !document.password;
  } catch {
    return false;
  }
}
