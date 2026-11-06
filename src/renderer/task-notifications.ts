type Context = {
  effect(factory: () => () => void, label?: string): void;
  get(name: 'uiWorkspace'): { openSession(sessionId: string): void };
  sidebarRight: { mounted: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void } };
};

/** Native notification clicks reuse the upstream conversation navigation. */
export function installTaskNotificationNavigation(ctx: Context) {
  ctx.effect(() => {
    const api = window.dshDesktop;
    if (!api) return () => {};
    let disposed = false;
    const sync = () => { void api.setNotificationView(ctx.sidebarRight.mounted.getSnapshot() ?? null).catch(() => {}); };
    const open = () => { void api.takeNotificationTarget().then(id => { if (!disposed && id) ctx.get('uiWorkspace').openSession(id); }).catch(() => {}); };
    const stopOpen = api.onNotificationOpen(open), stopView = ctx.sidebarRight.mounted.subscribe(sync);
    sync(); open();
    return () => { disposed = true; stopOpen(); stopView(); void api.setNotificationView(null).catch(() => {}); };
  }, 'desktop: task notifications');
}
