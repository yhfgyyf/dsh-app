import { createHash, randomUUID } from 'node:crypto';
import type { ComputerDriver } from './computer-use-driver.ts';
import { COMPUTER_ACTIONS, COMPUTER_DRIVER_VERSION, record, positiveInteger, screenshotCoordinates } from '../shared/computer-use.ts';
import type { ComputerRequest, ComputerResult, ComputerState, ComputerAction, ComputerPreview } from '../shared/computer-use.ts';

type WindowBounds = { x: number; y: number; width: number; height: number };
type Snapshot = { id: string; kind: string; time: number; pid?: number; windowId?: number; bounds?: WindowBounds; snapshotId?: string; width: number; height: number; imageHash?: string; elements: Set<string | number>; apps: Record<string, unknown>[]; screenshot: boolean; accessibility: boolean; maxDimension: number };
const coordinateFields = ['x', 'y', 'from_x', 'from_y', 'to_x', 'to_y'];
const inputFields = ['element_index', 'element_token', 'x', 'y', 'delivery_mode'];
const fields: Record<ComputerAction, string[]> = {
  launch_app: ['app_index'], click: [...inputFields, 'button', 'count', 'modifier', 'action'],
  double_click: inputFields, right_click: [...inputFields, 'modifier'],
  drag: ['from_x', 'from_y', 'to_x', 'to_y', 'duration_ms', 'steps', 'button', 'modifier', 'delivery_mode'],
  type_text: [...inputFields, 'text', 'delay_ms', 'method'], press_key: [...inputFields, 'key', 'modifiers'],
  hotkey: [...inputFields, 'keys'], set_value: ['element_index', 'element_token', 'value'],
  scroll: [...inputFields, 'direction', 'amount', 'by'], invoke_menu: ['path'], bring_to_front: [],
};
const actionDescriptions: Record<ComputerAction, string> = {
  launch_app: 'Launch an app_index from the latest apps observation.',
  click: 'Click an observed element_token/element_index OR an x,y pair normalized within the latest screenshot. Verify the target actually activated.',
  double_click: 'Double-click an observed element OR a normalized x,y pair.',
  right_click: 'Right-click an observed element OR a normalized x,y pair. Inspect the resulting menu.',
  drag: 'Drag between normalized from_x,from_y and to_x,to_y points in the latest screenshot.',
  type_text: 'Type text into the current focus, or supply an observed element OR normalized x,y to refocus first. Coordinates cause a click and may change the selection. On macOS method="paste" with foreground replaces and verifies the clipboard before pasting. Verify actual text; never repeat possibly partial input.',
  press_key: 'Press one key with optional modifiers. Use foreground for custom canvases. Click once to focus the intended editor, then omit x,y to preserve its cursor/selection. Supply x,y only when another focus click is intended.',
  hotkey: 'Send modifiers followed by one key. Use foreground for custom canvases. Click once to focus the intended editor, then omit x,y to preserve its cursor/selection. Verify the visible result.',
  set_value: 'Set the value of an observed accessibility element; use element_token or element_index.',
  scroll: 'Scroll an observed element or normalized x,y target. Inspect the resulting position.',
  invoke_menu: 'Invoke an exact observed native application-menu path. Custom drawn menus may require normalized screenshot targeting instead.',
  bring_to_front: 'Activate the exact observed window. This does not select a particular editor or field inside it.',
};
const argumentDescriptions: Record<string, string> = {
  element_index: 'Element index from the latest observation. Do not combine with x,y.',
  element_token: 'Element token from the latest observation. Do not combine with x,y.',
  delivery_mode: 'background is best-effort and may have no effect. foreground targets the observed window. For canvas keyboard input, click the editor once, then omit x,y to preserve focus. Verify the effect; delivery acknowledgement is not target success.',
  button: 'Mouse button to press.', count: 'Number of clicks.', modifier: 'Modifier held during the pointer action.', action: 'Accessibility action supported by the observed element.',
  duration_ms: 'Drag duration in milliseconds.', steps: 'Number of intermediate drag steps.', text: 'Literal text to input.', delay_ms: 'Delay between typed characters in milliseconds.',
  key: 'One key name.', modifiers: 'Modifier key names held while pressing the key.', keys: 'Modifier key names followed by one non-modifier key.', value: 'Value to assign to the observed accessibility element.',
  direction: 'Scroll direction.', amount: 'Scroll amount in the unit selected by by.', by: 'Scroll unit.', path: 'Exact native menu labels obtained from observation; do not guess translated or custom menu paths.',
};
function json(data: unknown): ComputerResult { return { text: JSON.stringify(data), data, images: [] }; }
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter(record) : []; }
function windowBounds(value: unknown): WindowBounds | undefined {
  if (!record(value) || !['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) || (value.width as number) <= 0 || (value.height as number) <= 0) return;
  return { x: value.x as number, y: value.y as number, width: value.width as number, height: value.height as number };
}
function dimensions(result: ComputerResult) {
  const image = result.images[0];
  if (image?.mimeType !== 'image/png') return { width: 0, height: 0 };
  const bytes = Buffer.from(image.dataBase64, 'base64');
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('驱动返回了无效的 PNG。');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), imageHash: createHash('sha256').update(bytes).digest('hex') };
}

/** One App-owned desktop lease. Only the owned core can request observations/actions. */
export class DesktopComputerUse {
  state: ComputerState = { enabled: false, phase: 'idle', driverVersion: COMPUTER_DRIVER_VERSION, permissions: { supported: ['darwin', 'win32'].includes(process.platform), accessibility: false, screenRecording: false } };
  private desiredEnabled = false;
  private activation?: AbortController;
  private refreshing?: Promise<ComputerState>;
  private active?: AbortController;
  private stopping?: Promise<void>;
  private snapshot?: Snapshot;
  private expiry?: ReturnType<typeof setTimeout>;
  private startedAt = 0;
  private previewing?: Promise<ComputerPreview | undefined>;
  private previewController?: AbortController;
  private driver: ComputerDriver;
  private publish: (state: ComputerState) => void;
  private platform: NodeJS.Platform;
  constructor(driver: ComputerDriver, publish: (state: ComputerState) => void = () => {}, platform = process.platform) { this.driver = driver; this.publish = publish; this.platform = platform; }
  private update(change: Partial<ComputerState>) { this.state = { ...this.state, ...change }; this.publish(structuredClone(this.state)); }
  setStopShortcutAvailable(available: boolean) { this.update({ stopShortcutAvailable: available }); }
  async setEnabled(enabled: boolean, prompt = true): Promise<ComputerState> {
    this.desiredEnabled = enabled;
    if (!enabled) {
      this.activation?.abort();
      this.update({ enabled: false });
      await this.stop();
      return this.state;
    }
    // A prompt must not get swallowed by an in-flight background permission check.
    if (this.refreshing) await this.refreshing;
    return this.permissions(prompt);
  }
  async permissions(prompt = false): Promise<ComputerState> {
    if (this.refreshing) return this.refreshing;
    const controller = new AbortController();
    this.activation = controller;
    this.refreshing = (async () => {
      try {
        const permissions = await this.driver.permissions(prompt);
        controller.signal.throwIfAborted();
        this.update({ permissions, error: undefined });
        if (!this.desiredEnabled || !permissions.supported || !permissions.accessibility || !permissions.screenRecording) {
          const wasEnabled = this.state.enabled;
          this.update({ enabled: false });
          if (wasEnabled) await this.stop();
          if (this.desiredEnabled) {
            const missing = [!permissions.accessibility && '辅助功能', !permissions.screenRecording && '屏幕录制'].filter(Boolean).join('、');
            this.update({ error: !permissions.supported ? '当前系统不支持电脑操作。' : `当前版本未获得有效的${missing}权限。${this.platform === 'darwin' ? '如果系统设置中的 DSH 已开启，旧版本的授权可能仍在列表中；请移除旧条目，重新添加 /Applications/DSH Desktop.app 并授权，然后按系统提示退出并重新打开。' : '请检查系统权限后重试。'}` });
          }
        } else if (!this.state.enabled) {
          await this.stopping;
          controller.signal.throwIfAborted();
          await this.driver.start(AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]));
          controller.signal.throwIfAborted();
          this.update({ enabled: true });
        }
      } catch (error) {
        this.update({ enabled: false });
        await this.stop().catch(() => {});
        if (!controller.signal.aborted) this.update({ error: String(error) });
      }
      return this.state;
    })().finally(() => { if (this.activation === controller) this.activation = undefined; this.refreshing = undefined; });
    return this.refreshing;
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
    if (!this.state.enabled) throw new Error('请先打开 App 中的电脑操作开关。');
    await this.permissions();
    await this.previewing;
    signal.throwIfAborted();
    if (!this.state.enabled) throw new Error('电脑操作不可用，请检查 App 中的电脑操作开关和系统权限。');
    if (this.stopping || this.active) throw new Error('桌面操作正在进行或停止，请等该操作结束后重试。');
    if (request.operation !== 'start') this.requireOwner(request.sessionId);
    else {
      if (this.state.owner) throw new Error('桌面已被会话占用，请先结束已有授权。');
      const { reason, application_pid: pid } = request.arguments;
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000 || (pid !== undefined && !positiveInteger(pid))) throw new Error('电脑操作目的或应用 PID 无效。');
      this.update({ phase: 'starting', owner: { sessionId: request.sessionId, reason, ...(pid === undefined ? {} : { applicationPid: pid }) }, target: undefined, error: undefined });
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
        // The user-controlled App switch grants access. Starting only binds the
        // active task and scope; file/shell approval policy is independent.
        const permissions = await this.driver.permissions();
        timeout.throwIfAborted();
        if (!permissions.accessibility || !permissions.screenRecording || !permissions.supported) throw new Error('系统权限已更改，请检查电脑操作开关。');
        await this.driver.start(timeout);
        timeout.throwIfAborted();
        this.startedAt = Date.now();
        this.update({ phase: 'active', permissions });
        result = json({ started: true, approvedBy: 'desktop-switch', scope: this.state.owner, instructions: 'Observe the exact app window before acting. Actions refresh that window by default; inspect the returned evidence. Stop with computer_stop when done.' });
      } else if (request.operation === 'observe') result = await this.observe(request.arguments, timeout);
      else result = await this.act(request.arguments, timeout);
      controller.signal.throwIfAborted();
      this.armExpiry();
      return result;
    } catch (error) {
      if (this.active === controller && (request.operation === 'start' || controller.signal.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)))) await this.stop();
      if (request.operation === 'act' && this.snapshot?.id === request.arguments.observation_id) throw new Error(`not_dispatched; observation_retained: ${error instanceof Error ? error.message : String(error)}。更正参数后可使用同一 observation_id。`, { cause: error });
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
      if (args.action !== undefined && !COMPUTER_ACTIONS.includes(args.action as ComputerAction)) throw new Error('操作名称无效。');
      const schema = await this.driver.describe(signal);
      const actions = record(schema) ? records(schema.tools).filter(tool => COMPUTER_ACTIONS.includes(tool.name as ComputerAction) && (args.action === undefined || args.action === tool.name)).map(tool => {
        const action = tool.name as ComputerAction;
        const summary = { name: action, description: actionDescriptions[action] };
        if (args.action === undefined) return summary;
        const native = record(tool.inputSchema) ? tool.inputSchema : {};
        const properties = record(native.properties) ? native.properties : {};
        if (action === 'launch_app') return { ...summary, parameters: { app_index: { type: 'integer', minimum: 0, description: 'app_index from the latest apps observation.' } }, required: ['app_index'] };
        const parameters = Object.fromEntries(Object.entries(properties).filter(([key]) => fields[action].includes(key)).map(([key, value]) => [key,
          coordinateFields.includes(key) ? { type: 'number', minimum: 0, maximum: 1, description: `${key}: normalized 0..1 within the complete latest screenshot, including its title bar. Do not apply Retina scale, window bounds or pixel offsets.` } :
            argumentDescriptions[key] && record(value) ? { ...value, description: argumentDescriptions[key] } : value,
        ]));
        if (action === 'type_text') parameters.method = { type: 'string', enum: ['keyboard', 'paste'], description: 'Default keyboard. paste requires macOS, a window and foreground; replaces the system clipboard with text, verifies it, then sends an exact-window paste. Use for custom text editors that ignore synthesized characters.' };
        return { ...summary, parameters, required: Array.isArray(native.required) ? native.required.filter(key => fields[action].includes(key as string)) : [] };
      }) : [];
      return json({ actions, ...(args.action === undefined ? { next: 'Call computer_observe with kind="describe" and action="click" (or another listed action) for its parameters.' } : {}), coordinates: 'All x/y and drag coordinates are normalized 0..1 within the complete latest screenshot. The App handles pixel/Retina conversion and binds the target.' });
    }
    let name: string;
    let native: Record<string, unknown> = {};
    if (kind === 'apps') { if (boundPid) throw new Error('当前授权仅限一个应用。请观察该应用的窗口。'); name = 'list_apps'; }
    else if (kind === 'windows') {
      if (pid !== undefined && !positiveInteger(pid)) throw new Error('PID 无效。');
      if (boundPid && pid !== undefined && pid !== boundPid) throw new Error('目标应用超出本次授权范围。');
      name = 'list_windows'; native = { ...(boundPid ?? pid ? { pid: boundPid ?? pid } : {}) };
    } else if (kind === 'window') {
      if (!positiveInteger(pid) || !positiveInteger(windowId)) throw new Error(`kind="window" 必须同时提供有效的 pid 和 window_id；缺少或无效：${[!positiveInteger(pid) && 'pid', !positiveInteger(windowId) && 'window_id'].filter(Boolean).join('、')}。请使用同一窗口列表项中的两个值。`);
      if (boundPid && pid !== boundPid) throw new Error('目标应用超出本次授权范围。');
      if (args.max_dimension !== undefined && (!Number.isInteger(args.max_dimension) || (args.max_dimension as number) < 320 || (args.max_dimension as number) > 2400)) throw new Error('截图长边必须为 320 到 2400 像素。');
      if (args.include_screenshot === false && args.include_accessibility_tree === false) throw new Error('截图和辅助功能树不能同时关闭。');
      name = 'get_window_state'; native = { pid, window_id: windowId, max_elements: 250, max_depth: 15, max_dimension: args.max_dimension ?? 1600, include_screenshot: args.include_screenshot !== false, include_accessibility_tree: args.include_accessibility_tree !== false };
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
    const snapshot: Snapshot = { id: randomUUID(), kind, time: Date.now(), ...(kind === 'window' ? { pid: pid as number, windowId: windowId as number, bounds: windowBounds(data.window_bounds) } : {}), snapshotId: typeof data.snapshot_id === 'string' ? data.snapshot_id : undefined, ...dimensions(result), elements: new Set(elements.flatMap(e => [e.element_index, e.element_token].filter((v): v is string | number => typeof v === 'string' || typeof v === 'number'))), apps, screenshot: args.include_screenshot !== false, accessibility: args.include_accessibility_tree !== false, maxDimension: (args.max_dimension as number | undefined) ?? 1600 };
    this.snapshot = snapshot;
    if (kind === 'window') this.update({ target: { pid: pid as number, windowId: windowId as number, appName: typeof data.app_name === 'string' ? data.app_name : '', windowTitle: typeof data.window_title === 'string' ? data.window_title : '' } });
    else if (kind === 'desktop') this.update({ target: undefined });
    // Native capture scale describes an earlier frame, before PNG resizing.
    // Expose only dimensions measured from the image delivered to the model.
    const { screenshot_scale: _scale, screenshot_width: _width, screenshot_height: _height, ...observedData } = data;
    return { ...result, text: '', data: { ...observedData, observation_id: snapshot.id, ...(snapshot.imageHash ? { screenshot_sha256: snapshot.imageHash } : {}), ...(kind === 'apps' ? { apps: apps.map((app, app_index) => ({ ...app, app_index })) } : {}), coordinate_system: 'normalized_0_to_1', coordinate_origin: 'top_left_of_complete_screenshot', screenshot_dimensions: { width: snapshot.width, height: snapshot.height } } };
  }
  private async act(args: Record<string, unknown>, signal: AbortSignal): Promise<ComputerResult> {
    const action = args.action as ComputerAction;
    if (!COMPUTER_ACTIONS.includes(action) || !record(args.arguments) || (args.observe_after !== undefined && typeof args.observe_after !== 'boolean')) throw new Error('操作或参数无效。');
    const input = args.arguments;
    const snapshot = this.snapshot;
    if (snapshot && snapshot.id === args.observation_id && Date.now() - snapshot.time > 60000) this.snapshot = undefined;
    if (!snapshot || snapshot.id !== args.observation_id || !this.snapshot) throw new Error('观察已失效，请重新调用 computer_observe。');
    if (Object.keys(args.arguments).some(key => !fields[action].includes(key))) throw new Error('操作包含不支持的参数；目标、路径和驱动设置由 App 管理。');
    let native = { ...args.arguments };
    if ((native.x !== undefined) !== (native.y !== undefined)) throw new Error('目标必须同时提供 x 和 y。');
    if (native.x !== undefined && (native.element_index !== undefined || native.element_token !== undefined)) throw new Error('目标不能同时使用控件和 x,y 坐标。');
    if (native.delivery_mode !== undefined && !['background', 'foreground'].includes(native.delivery_mode as string)) throw new Error('delivery_mode 必须为 background 或 foreground。');
    if (action === 'drag' && !['from_x', 'from_y', 'to_x', 'to_y'].every(key => native[key] !== undefined)) throw new Error('拖动必须提供完整的起点和终点坐标。');
    if (action === 'type_text' && native.method !== undefined && !['keyboard', 'paste'].includes(native.method as string)) throw new Error('文字输入 method 必须为 keyboard 或 paste。');
    if (action === 'type_text' && native.method === 'paste' && (this.platform !== 'darwin' || snapshot.kind !== 'window' || native.delivery_mode !== 'foreground' || typeof native.text !== 'string')) throw new Error('粘贴输入需要 macOS 上的明确窗口、foreground 和 text。');
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
    if (snapshot.kind === 'window' && coordinateFields.some(key => input[key] !== undefined)) {
      // The native worker caches the screenshot-to-window transform. Do not
      // apply it to a window that has moved/resized since this observation.
      let current: WindowBounds | undefined;
      try {
        const windows = await this.driver.call('list_windows', { pid: snapshot.pid }, signal);
        const entries = records(record(windows.data) ? windows.data.windows : windows.data);
        current = windowBounds(entries.find(window => window.pid === snapshot.pid && window.window_id === snapshot.windowId)?.bounds);
      } catch (error) {
        this.snapshot = undefined;
        signal.throwIfAborted();
        throw new Error(`not_dispatched; observation_consumed: 无法确认目标窗口的当前位置，请重新观察。${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      if (!snapshot.bounds || !current || (Object.keys(snapshot.bounds) as (keyof WindowBounds)[]).some(key => snapshot.bounds![key] !== current![key])) {
        this.snapshot = undefined;
        throw new Error('not_dispatched; observation_consumed: 目标窗口位置或尺寸已变化，或无法确认原截图对应的窗口；请重新观察后定位。');
      }
    }
    const feedback = { observation_id: snapshot.id, observation_consumed: true, target: { kind: snapshot.kind, pid: snapshot.pid, window_id: snapshot.windowId }, screenshot_dimensions: { width: snapshot.width, height: snapshot.height },
      coordinates: { normalized: Object.fromEntries(coordinateFields.filter(key => input[key] !== undefined).map(key => [key, input[key]])), screenshot_pixels: Object.fromEntries(coordinateFields.filter(key => native[key] !== undefined).map(key => [key, native[key]])) }, outcome: 'unverified' };
    this.snapshot = undefined;
    let result: ComputerResult;
    try { result = await this.driver.call(action, native, signal); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw error;
      const observe = snapshot.kind === 'window' ? { kind: 'window', pid: snapshot.pid, window_id: snapshot.windowId } : { kind: snapshot.kind };
      throw new Error(`possibly_dispatched; observation_consumed: ${error instanceof Error ? error.message : String(error)}\n本次 observation_id 已消费。请先 computer_observe(${JSON.stringify(observe)})，核对输入是否已经生效；不要重试旧 ID 或重复可能已部分生效的输入。`, { cause: error });
    }
    const actionData = record(result.data) ? result.data : {};
    const delivery = { status: 'returned', ...(record(actionData.delivery) ? { mode: actionData.delivery.mode } : input.delivery_mode === undefined ? {} : { mode: input.delivery_mode }), ...(typeof actionData.route === 'string' ? { route: actionData.route } : {}), ...(typeof actionData.effect === 'string' ? { reported_effect: actionData.effect } : {}) };
    if (snapshot.kind !== 'window' || args.observe_after === false) return { ...result, data: { ...(record(result.data) ? result.data : { action_result: result.text }), action_feedback: { ...feedback, delivery, observation: { status: 'not_requested', required_before_next_action: true } } } };
    try {
      const observed = await this.observe({ kind: 'window', pid: snapshot.pid, window_id: snapshot.windowId, include_screenshot: snapshot.screenshot, include_accessibility_tree: snapshot.accessibility, max_dimension: snapshot.maxDimension }, signal);
      const data = record(observed.data) ? observed.data : {};
      const changed = snapshot.imageHash && typeof data.screenshot_sha256 === 'string' ? snapshot.imageHash !== data.screenshot_sha256 : null;
      return { ...observed, text: changed === false ? '操作已返回，但画面与操作前完全相同。若预期目标应有可见变化，请重新定位或检查投递路径；不要认定目标已完成。' : '操作已返回；画面变化不等于目标完成，请核对预期效果。', data: { ...data, action_result: result.data ?? result.text, action_feedback: { ...feedback, delivery, observation: { status: 'refreshed', observation_id: data.observation_id, required_before_next_action: false }, screenshot_changed: changed } } };
    } catch (error) {
      signal.throwIfAborted();
      return { text: '操作已返回，但重新观察失败。不要重复可能已经生效的输入；请先重新观察。', data: { action_result: result.data ?? result.text, action_feedback: { ...feedback, delivery, observation: { status: 'failed', required_before_next_action: true } }, observation_error: String(error) }, images: [] };
    }
  }
  /** UI-only capture: never changes the agent's snapshot or refreshes its lease. */
  preview(): Promise<ComputerPreview | undefined> {
    if (this.previewing) return this.previewing;
    if (!this.state.enabled || this.state.phase !== 'active' || !this.state.target || this.active) return Promise.resolve(undefined);
    const target = { ...this.state.target }, owner = this.state.owner?.sessionId;
    const controller = new AbortController();
    this.previewController = controller;
    this.previewing = (async () => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
      const current = () => !controller.signal.aborted && this.state.enabled && this.state.phase === 'active' && this.state.owner?.sessionId === owner && this.state.target?.pid === target.pid && this.state.target?.windowId === target.windowId;
      try {
        const permissions = await this.driver.permissions();
        if (!permissions.accessibility || !permissions.screenRecording) { await this.permissions(); return; }
        const result = await this.driver.capturePreview({ pid: target.pid, window_id: target.windowId, include_screenshot: true, include_accessibility_tree: false, max_dimension: 640 }, signal);
        signal.throwIfAborted();
        if (!current()) return;
        if (!result.images[0] || !dimensions(result).width) throw new Error('目标窗口没有可用画面。');
        return { target, capturedAt: Date.now(), image: result.images[0] };
      } catch (error) {
        if (current()) return { target, capturedAt: Date.now(), error: `暂时无法读取目标窗口：${String(error)}` };
      }
    })().finally(() => { this.previewing = undefined; if (this.previewController === controller) this.previewController = undefined; });
    return this.previewing;
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    clearTimeout(this.expiry);
    this.previewController?.abort();
    this.snapshot = undefined;
    this.active?.abort(new Error('电脑操作已停止。'));
    this.update({ phase: 'stopping', action: undefined, target: undefined });
    this.stopping = (async () => {
      try { await this.driver.stop(); this.update({ phase: 'idle', owner: undefined, error: undefined }); }
      catch (error) { this.update({ phase: 'error', error: `驱动停止失败：${String(error)}` }); throw error; }
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}
