import * as React from 'react';
import { createRoot } from 'react-dom/client';

export function mount(client: (...args: any[]) => void) {
  let AuditDock: React.ComponentType<any>;
  const counts = { opened: 0, closed: 0 };
  const retained = { active: true, reviewer: 'fixture', completedSteps: 7, auditCount: 2, failureCount: 0 };
  client(
    { __ModuleLoader__: { load: (entry: any) => { AuditDock = entry.factory(() => React).AuditDock; } } },
    async () => ({ ok: true, json: async () => retained }),
    class { constructor() { counts.opened++; } addEventListener() {} close() { counts.closed++; } },
  );
  let store = { id: 'audit-history', preset: 'standard' };
  const listeners = new Set<() => void>();
  const subscribe = (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };
  const snapshot = () => store;
  const useProjection = (key: string) => {
    const current = React.useSyncExternalStore(subscribe, snapshot);
    return key === 'agentPreset' ? current.preset : undefined;
  };
  function Fixture() {
    const current = React.useSyncExternalStore(subscribe, snapshot);
    return <AuditDock sessionId={current.id} useProjection={useProjection} view={retained} />;
  }
  const node = document.createElement('div'); node.id = 'audit-render-fixture'; document.body.append(node);
  const root = createRoot(node); root.render(<Fixture />);
  return {
    select(preset: string, id = store.id) { store = { id, preset }; for (const callback of listeners) callback(); },
    counts,
    dispose() { root.unmount(); node.remove(); },
  };
}
