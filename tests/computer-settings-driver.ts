// Permission/driver outcomes are controlled only in the native settings fixture.
export const fixture = {
  permissions: { supported: true, accessibility: false, screenRecording: false },
  prompts: 0, starts: 0, stops: 0, fail: false,
  start: undefined as undefined | (() => Promise<void>),
};
export class CuaComputerDriver {
  constructor(_options: unknown) {}
  async permissions(prompt = false) { if (prompt) fixture.prompts++; return { ...fixture.permissions }; }
  async start(signal: AbortSignal) {
    fixture.starts++;
    await fixture.start?.();
    signal.throwIfAborted();
    if (fixture.fail) throw new Error('Fixture driver unavailable');
  }
  async stop() { fixture.stops++; }
  async describe() { return { tools: [] }; }
  async call() { throw new Error('Settings fixture must never operate the desktop'); }
}
