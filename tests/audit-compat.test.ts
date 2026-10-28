import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeNodeModules = process.env.DSH_OVERLAY_TEST_RUNTIME ?? fileURLToPath(new URL('../.runtime/node_modules', import.meta.url));

test('the packaged audit dock only mounts for the current audit preset, even with retained audit history', async () => {
  const client = await readFile(join(runtimeNodeModules, 'dsh-audit-mode/lib/client.js'), 'utf8');
  let exports: any;
  let effects = 0;
  vm.runInNewContext(client, {
    window: { __ModuleLoader__: { load: (entry: any) => { exports = entry.factory((name: string) => name === 'react' ? {
      createElement: (type: unknown, props: unknown) => ({ type, props }),
      useState: () => [null, () => {}], useEffect: () => { effects++; },
    } : {}); } } },
    location: { origin: 'http://localhost:3080' },
  });
  const render = (preset?: string, sessionId = 'one') => exports.AuditDock({ sessionId, view: { active: true }, useProjection: (name: string) => { assert.equal(name, 'agentPreset'); return preset; } });
  for (const preset of ['standard', 'code', 'minimal', 'cordis', 'auto', undefined]) assert.equal(render(preset), null, String(preset));
  const audit = render('audit');
  assert.equal(typeof audit.type, 'function');
  assert.equal(audit.props.key, 'one');
  assert.equal(render('audit', 'two').props.key, 'two');
  assert.equal(render('standard'), null, 'Leaving audit must immediately unmount the audit panel');
  assert.equal(effects, 0, 'A non-audit session must not start audit subscriptions');
});

// Host-owned inspection and repeated preset disposal are covered by test:audit-switch.
