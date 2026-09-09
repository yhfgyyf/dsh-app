import { randomUUID } from 'node:crypto';
import type { ComputerDriver } from './computer-use-driver.ts';
import { COMPUTER_ACTIONS, COMPUTER_DRIVER_VERSION, record, positiveInteger, screenshotCoordinates } from '../shared/computer-use.ts';
import type { ComputerRequest, ComputerResult, ComputerState, ComputerAction } from '../shared/computer-use.ts';

type Snapshot = { id: string; kind: string; time: number; pid?: number; windowId?: number; snapshotId?: string; width: number; height: number; elements: Set<string | number>; apps: Record<string, unknown>[] };
const inputFields = ['element_index', 'element_token', 'x', 'y', 'delivery_mode'];
const fields: Record<ComputerAction, string[]> = {
  launch_app: ['app_index'], click: [...inputFields, 'button', 'count', 'modifier', 'action'],
  double_click: inputFields, right_click: [...inputFields, 'modifier'],
  drag: ['from_x', 'from_y', 'to_x', 'to_y', 'duration_ms', 'steps', 'button', 'modifier', 'delivery_mode'],
  type_text: [...inputFields, 'text', 'delay_ms'], press_key: [...inputFields, 'key', 'modifiers'],
  hotkey: [...inputFields, 'keys'], set_value: ['element_index', 'element_token', 'value'],
  scroll: [...inputFields, 'direction', 'amount', 'by'], invoke_menu: ['path'], bring_to_front: [],
};
function json(data: unknown): ComputerResult { return { text: JSON.stringify(data), data, images: [] }; }
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter(record) : []; }
function dimensions(result: ComputerResult) {
  const image = result.images[0];
  if (image?.mimeType !== 'image/png') return { width: 0, height: 0 };
  const bytes = Buffer.from(image.dataBase64, 'base64');
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('驱动返回了无效的 PNG。');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** One App-owned desktop lease. Only the owned core can request observations/actions. */
export class DesktopComputerUse {
  state: ComputerState = { phase: 'idle', driverVersion: COMPUTER_DRIVER_VERSION, permissions: { supported: ['darwin', 'win32'].includes(process.platform), accessibility: false, screenRecording: false } };
  private active?: AbortController;
  private stopping?: Promise<void>;
  private snapshot?: Snapshot;
  private expiry?: ReturnType<typeof setTimeout>;
  private startedAt = 0;
  private driver: ComputerDriver;
  private publish: (state: ComputerState) => void;
  private platform: NodeJS.Platform;
  constructor(driver: ComputerDriver, publish: (state: ComputerState) => void = () => {}, platform = process.platform) { this.driver = driver; this.publish = publish; this.platform = platform; }
  private update(change: Partial<ComputerState>) { this.state = { ...this.state, ...change }; this.publish(structuredClone(this.state)); }
  setStopShortcutAvailable(available: boolean) { this.update({ stopShortcutAvailable: available }); }
  async permissions(prompt = false): Promise<ComputerState> {
    try { this.update({ permissions: await this.driver.permissions(prompt), error: undefined }); }
    catch (error) { this.update({ error: String(error) }); }
    return this.state;
  }
  private requireOwner(sessionId: string) {
    if (this.state.phase !== 'active' || this.state.owner?.sessionId !== sessionId) throw new Error('当前会话没有电脑操作授权，请先调用 computer_start。');
    if (Date.now() - this.startedAt >= 3600000) { void this.stop().catch(() => {}); throw new Error('电脑操作授权已到期，请重新开始。'); }
  }
  private armExpiry() {
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => { void this.stop().catch(() => {}); }, Math.min(600000, Math.max(1, 3600000 - (Date.now() - this.startedAt))));
    this.expiry.unref();
  }
  async request(request: ComputerRequest, signal: AbortSignal): Promise<ComputerResult> {
    signal.throwIfAborted();
    if (request.operation === 'status') return json(await this.permissions());
    if (request.operation === 'stop') {
      if (this.state.owner && this.state.owner.sessionId !== request.sessionId) throw new Error('其他会话正在操作桌面。');
      await this.stop(); return json(this.state);
    }
    if (this.stopping || this.active) throw new Error('桌面操作正在进行或停止，请等该操作结束后重试。');
    if (request.operation !== 'start') this.requireOwner(request.sessionId);
    else {
      if (this.state.owner) throw new Error('桌面已被会话占用，请先结束已有授权。');
      const { reason, application_pid: pid } = request.arguments;
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000 || (pid !== undefined && !positiveInteger(pid))) throw new Error('电脑操作目的或应用 PID 无效。');
      this.startedAt = Date.now();
      this.update({ phase: 'active', owner: { sessionId: request.sessionId, reason, ...(pid === undefined ? {} : { applicationPid: pid }) }, error: undefined });
    }
    const controller = new AbortController();
    this.active = controller;
    const abort = () => { controller.abort(signal.reason); void this.stop().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    this.update({ action: request.operation === 'act' ? String(request.arguments.action) : request.operation });
    try {
      const timeout = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
      let result: ComputerResult;
      if (request.operation === 'start') {
        await this.driver.start(timeout);
        this.update({ permissions: await this.driver.permissions() });
        result = json({ started: true, scope: this.state.owner, instructions: 'Use computer_observe before acting. Read UI evidence after every action. Stop with computer_stop when done.' });
      } else if (request.operation === 'observe') result = await this.observe(request.arguments, timeout);
      else result = await this.act(request.arguments, timeout);
      controller.signal.throwIfAborted();
      this.armExpiry();
      return result;
    } catch (error) {
      this.snapshot = undefined;
      if (request.operation === 'start' || controller.signal.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) await this.stop();
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      if (this.active === controller) this.active = undefined;
      if (this.state.phase === 'active') this.update({ action: undefined });
    }
  }
  private async observe(args: Record<string, unknown>, signal: AbortSignal): Promise<ComputerResult> {
    const { kind, pid, window_id: windowId } = args;
    const boundPid = this.state.owner?.applicationPid;
    if (kind === 'describe') {
      const schema = await this.driver.describe(signal);
      const actions = record(schema) ? records(schema.tools).filter(tool => COMPUTER_ACTIONS.includes(tool.name as ComputerAction)).map(tool => {
        const native = record(tool.inputSchema) ? tool.inputSchema : {};
        const properties = record(native.properties) ? native.properties : {};
        return { name: tool.name, description: tool.description, parameters: Object.fromEntries(Object.entries(properties).filter(([key]) => fields[tool.name as ComputerAction].includes(key))) };
      }) : [];
      return json({ actions, launch_app: { app_index: 'Use an app_index from computer_observe kind=apps.' }, coordinates: 'x/y and drag coordinates must be normalized 0..1 within the latest screenshot; pid/window/session/snapshot are injected by the App.' });
    }
    let name: string;
    let native: Record<string, unknown> = {};
    if (kind === 'apps') { if (boundPid) throw new Error('当前授权仅限一个应用。请观察该应用的窗口。'); name = 'list_apps'; }
    else if (kind === 'windows') {
      if (pid !== undefined && !positiveInteger(pid)) throw new Error('PID 无效。');
      if (boundPid && pid !== undefined && pid !== boundPid) throw new Error('目标应用超出本次授权范围。');
      name = 'list_windows'; native = { ...(boundPid ?? pid ? { pid: boundPid ?? pid } : {}) };
    } else if (kind === 'window') {
      if (!positiveInteger(pid) || !positiveInteger(windowId)) throw new Error('请从窗口列表选择有效的 pid 和 window_id。');
      if (boundPid && pid !== boundPid) throw new Error('目标应用超出本次授权范围。');
      name = 'get_window_state'; native = { pid, window_id: windowId, max_elements: 250, max_depth: 15, max_dimension: 1200, include_screenshot: args.include_screenshot !== false };
      if (typeof args.query === 'string' && args.query.length <= 200) native.query = args.query;
    } else if (kind === 'desktop') {
      if (boundPid) throw new Error('当前授权仅限一个应用，不能观察整个桌面。');
      name = 'get_desktop_state';
    } else throw new Error('观察类型无效。');
    this.snapshot = undefined;
    const result = await this.driver.call(name, native, signal);
    const data = record(result.data) ? result.data : {};
    const apps = records(Array.isArray(result.data) ? result.data : data.apps);
    const elements = records(data.elements);
    const snapshot: Snapshot = { id: randomUUID(), kind, time: Date.now(), ...(kind === 'window' ? { pid: pid as number, windowId: windowId as number } : {}), snapshotId: typeof data.snapshot_id === 'string' ? data.snapshot_id : undefined, ...dimensions(result), elements: new Set(elements.flatMap(e => [e.element_index, e.element_token].filter((v): v is string | number => typeof v === 'string' || typeof v === 'number'))), apps };
    this.snapshot = snapshot;
    return { ...result, data: { observation_id: snapshot.id, ...data, ...(kind === 'apps' ? { apps: apps.map((app, app_index) => ({ ...app, app_index })) } : {}), coordinate_system: 'normalized_0_to_1', screenshot_dimensions: { width: snapshot.width, height: snapshot.height } } };
  }
  private async act(args: Record<string, unknown>, signal: AbortSignal): Promise<ComputerResult> {
    const action = args.action as ComputerAction;
    if (!COMPUTER_ACTIONS.includes(action) || !record(args.arguments)) throw new Error('操作或参数无效。');
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.id !== args.observation_id || Date.now() - snapshot.time > 60000) throw new Error('观察已失效，请重新调用 computer_observe。');
    if (Object.keys(args.arguments).some(key => !fields[action].includes(key))) throw new Error('操作包含不支持的参数；目标、路径和驱动设置由 App 管理。');
    let native = { ...args.arguments };
    if (action === 'launch_app') {
      const index = native.app_index;
      const app = Number.isSafeInteger(index) && (index as number) >= 0 ? snapshot.apps[index as number] : undefined;
      if (snapshot.kind !== 'apps' || !app || this.state.owner?.applicationPid) throw new Error('请从最新的应用列表选择 app_index。');
      if (this.platform === 'win32' && typeof app.launch_path === 'string') native = { launch_path: app.launch_path };
      else if (typeof app.bundle_id === 'string' && app.bundle_id) native = { bundle_id: app.bundle_id };
      else if (typeof app.name === 'string' && app.name) native = { name: app.name };
      else throw new Error('此应用没有可验证的启动标识。');
    } else {
      if (!['window', 'desktop'].includes(snapshot.kind)) throw new Error('请先观察目标窗口或桌面。');
      for (const key of ['element_index', 'element_token']) if (native[key] !== undefined && !snapshot.elements.has(native[key] as string | number)) throw new Error('控件不属于最近一次观察。');
      native = screenshotCoordinates(native, snapshot.width, snapshot.height);
      if (snapshot.kind === 'window') {
        native.pid = snapshot.pid; native.window_id = snapshot.windowId;
        if (native.element_index !== undefined) {
          if (!snapshot.snapshotId) throw new Error('驱动未返回可用的控件快照，请重新观察或使用截图坐标。');
          native.snapshot_id = snapshot.snapshotId;
        }
      } else {
        if (!['click', 'drag', 'type_text', 'press_key', 'hotkey', 'scroll'].includes(action)) throw new Error('此操作需要一个明确的窗口。');
        native.scope = 'desktop'; native.target = { kind: 'desktop', display_id: 'primary' };
      }
    }
    this.snapshot = undefined;
    return this.driver.call(action, native, signal);
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.state.phase === 'idle' && !this.active) return;
    clearTimeout(this.expiry);
    this.snapshot = undefined;
    this.active?.abort(new Error('电脑操作已停止。'));
    this.update({ phase: 'stopping', action: undefined });
    this.stopping = (async () => {
      try { await this.driver.stop(); this.update({ phase: 'idle', owner: undefined, error: undefined }); }
      catch (error) { this.update({ phase: 'error', error: `驱动停止失败：${String(error)}` }); throw error; }
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}
