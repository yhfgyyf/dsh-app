export const COMPUTER_DRIVER_VERSION = '0.25.0';

export type ComputerPermissions = { supported: boolean; accessibility: boolean; screenRecording: boolean };
export type ComputerOwner = { sessionId: string; reason: string; applicationPid?: number };
export type ComputerTarget = { pid: number; windowId: number; appName: string; windowTitle: string };
export type ComputerPreview = { target: ComputerTarget; capturedAt: number; image?: ComputerImage; error?: string };
export type ComputerState = {
  enabled: boolean;
  phase: 'idle' | 'starting' | 'active' | 'stopping' | 'error';
  driverVersion: string;
  permissions: ComputerPermissions;
  owner?: ComputerOwner;
  target?: ComputerTarget;
  action?: string;
  error?: string;
  stopShortcutAvailable?: boolean;
};
export type ComputerImage = { mimeType: string; dataBase64: string };
export type ComputerResult = { text: string; data?: unknown; images: ComputerImage[] };
export type ComputerOperation = 'status' | 'start' | 'observe' | 'act' | 'stop';
export type ComputerRequest = { id: string; sessionId: string; operation: ComputerOperation; arguments: Record<string, unknown> };

export const COMPUTER_ACTIONS = ['launch_app', 'click', 'double_click', 'right_click', 'drag', 'type_text', 'press_key', 'hotkey', 'set_value', 'scroll', 'invoke_menu', 'bring_to_front'] as const;
export type ComputerAction = typeof COMPUTER_ACTIONS[number];

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isComputerRequest(value: unknown): value is ComputerRequest {
  return record(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 160 &&
    typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= 256 &&
    ['status', 'start', 'observe', 'act', 'stop'].includes(value.operation as string) && record(value.arguments);
}

/** Coordinates stay correct when the model provider resizes a screenshot. */
export function screenshotCoordinates(args: Record<string, unknown>, width: number, height: number) {
  const result = { ...args };
  for (const key of ['x', 'y', 'from_x', 'from_y', 'to_x', 'to_y']) {
    if (result[key] === undefined) continue;
    const value = result[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${key} 必须是截图内 0 到 1 的相对坐标。`);
    const dimension = key.endsWith('x') ? width : height;
    if (!positiveInteger(dimension)) throw new Error('本次观察没有可靠的截图尺寸，请重新观察。');
    result[key] = Math.min(dimension - 1, Math.round(value * dimension));
  }
  return result;
}
