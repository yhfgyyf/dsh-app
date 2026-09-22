import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as stores from '@deepseek-ai/dsh-client-store';

const source = await readFile(new URL('../.runtime/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js', import.meta.url), 'utf8');
const exact = 'dsh-review-test@1.2.3';
const digest = 'a'.repeat(64);
const lockedArchive = `/reviewed-packages/${digest}.tgz`;
const report = (now = Date.now(), extra: object = {}) => ({ status: 'complete', spec: exact, reviewId: 'host-review-id', sha256: digest, checkedAt: new Date(now).toISOString(), summary: 'Fixture review', risk: 'high', findings: [], limitations: [], requiresConfirmation: true, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) { for (let i = 0; i < 30 && !predicate(); i++) await tick(); assert.ok(predicate(), 'Controller did not reach the expected phase'); }

function harness(options: { review?: (spec: string, signal: AbortSignal) => Promise<any>; prepare?: (signal: AbortSignal) => Promise<any>; prepareDirect?: (signal: AbortSignal) => Promise<any>; install?: (spec: string, options: any) => Promise<any>; inspect?: () => any } = {}) {
  let now = Date.now();
  const dependencies: Record<string, unknown> = {
    react: {}, 'react/jsx-runtime': {}, '@deepseek-ai/dsh-client-ui-primitives': {},
    '@deepseek-ai/dsh-client-ui-slots': {}, '@deepseek-ai/dsh-client-store': stores,
  };
  let plugin: any;
  runInNewContext(source, { AbortController, console, crypto: globalThis.crypto, Date: class extends Date { static now() { return now; } },
    window: { __ModuleLoader__: { load(entry: any) { plugin = entry.factory((name: string) => dependencies[name]); } } },
  });
  const registrations: any[] = [], disposers: (() => void)[] = [], reviews: { spec: string; signal: AbortSignal }[] = [], prepares: AbortSignal[] = [], directPrepares: { spec: string; signal: AbortSignal }[] = [], installs: { spec: string; options: any }[] = [];
  const context = {
    effect(factory: () => () => void) { disposers.push(factory()); }, on() { return () => {}; },
    configForms: { describe: () => stores.createSnapshotStore([]), get() {} },
    locale: { resolveText: (text: string) => text, register() { return () => {}; }, bind() { return (key: string) => key; } },
    get(name: string) { assert.equal(name, 'connection'); return { rpc: { async call(channel: string, method: string, payload: any, signal: AbortSignal) {
      assert.equal(channel, '/desktop-plugin-security');
      if (method === 'prepare-direct-install') {
        directPrepares.push({ spec: payload.args.spec, signal });
        assert.equal(payload.args.spec, exact);
        return options.prepareDirect ? options.prepareDirect(signal) : { ok: true, value: { spec: exact, sha256: digest, installSpec: lockedArchive } };
      }
      if (method === 'prepare-install') {
        assert.equal(payload.args.reviewId, 'host-review-id'); prepares.push(signal);
        return options.prepare ? options.prepare(signal) : { ok: true, value: { spec: exact, sha256: digest, installSpec: lockedArchive } };
      }
      assert.equal(method, 'review');
      reviews.push({ spec: payload.args.spec, signal });
      return options.review ? options.review(payload.args.spec, signal) : { ok: true, value: report(now) };
    } } }; },
    remote: { $on() { return () => {}; }, pluginInventory: { async list() { return { ok: true, value: { managementAvailable: true } }; } }, pluginManager: {
      async registries() { return { ok: true, value: { registry: 'https://registry.npmjs.org/', fallbackRegistries: [], resolved: 'https://registry.npmjs.org/' } }; },
      async inspect() { return { ok: true, value: options.inspect?.() ?? { status: 'accepted', kind: 'registry', registry: 'https://registry.npmjs.org/', name: 'dsh-review-test', version: '1.2.3', bundle: true } }; },
      async installBundle(spec: string, settings: any) { installs.push({ spec, options: settings }); return options.install ? options.install(spec, settings) : { ok: true, value: { application: 'applied', bundle: 'dsh-review-test' } }; },
      async listBundles() { return { ok: true, value: [] }; }, async listPlugins() { return { ok: true, value: [] }; },
    } },
    slots: { inject(_name: string, factory: () => unknown) { factory(); }, register(options: any, component: any) { registrations.push({ options, component }); return () => {}; }, registerFactory() { return () => {}; } },
  };
  plugin.apply(context);
  const main = registrations.find(entry => entry.options.name === 'main').options.inject();
  const market = registrations.find(entry => entry.options.name === 'settings.section').options.inject();
  return { main, market, reviews, prepares, directPrepares, installs, snapshot: () => main.hooks.pluginManager.getSnapshot(), advance: (ms: number) => { now += ms; },
    begin(face = market, spec = 'dsh-review-test@latest') { face.openInstall(); face.editInstallSpec(spec); face.reviewBeforeInstall(); },
    beginDirect(face = market, spec = 'dsh-review-test@latest') { face.openInstall(); face.editInstallSpec(spec); face.runInstall(); },
    dispose() { for (const dispose of disposers.reverse()) dispose(); },
  };
}

test('both install surfaces can directly install the inspected exact version without review RPCs', async () => {
  for (const surface of ['main', 'market'] as const) {
    const app = harness();
    try {
      app.beginDirect(app[surface]); await until(() => app.snapshot().install.phase === 'done');
      assert.equal(app.reviews.length, 0); assert.equal(app.prepares.length, 0);
      assert.equal(app.directPrepares.length, 1);
      assert.equal(app.installs.length, 1); assert.equal(app.installs[0].spec, lockedArchive);
      assert.equal(app.snapshot().install.subject.spec, exact);
      assert.equal(app.installs[0].options.enabled, false, 'Enabling stays an explicit official action');
    } finally { app.dispose(); }
  }
});

test('direct installation preserves the official local-package spec without registry preparation', async () => {
  const spec = '/tmp/dsh-local-test';
  const app = harness({ inspect: () => ({ status: 'accepted', kind: 'path', name: 'dsh-local-test', version: '1.2.3', bundle: true }) });
  try {
    app.beginDirect(app.market, spec); await until(() => app.snapshot().install.phase === 'done');
    assert.equal(app.installs.length, 1); assert.equal(app.installs[0].spec, spec);
    assert.equal(app.reviews.length, 0); assert.equal(app.prepares.length, 0); assert.equal(app.directPrepares.length, 0);
  } finally { app.dispose(); }
});

test('both install surfaces can request a DSH report and require explicit acknowledgement before a reviewed install', async () => {
  for (const surface of ['main', 'market'] as const) {
    const app = harness();
    try {
      app.begin(app[surface]); await until(() => app.snapshot().install.phase === 'review');
      assert.equal(app.reviews[0].spec, exact);
      assert.equal(app.installs.length, 0);
      app[surface].continueReviewedInstall(); await tick(); assert.equal(app.installs.length, 0);
      app[surface].acknowledgeReview(true); app[surface].continueReviewedInstall();
      await until(() => app.snapshot().install.phase === 'done');
      assert.equal(app.installs.length, 1); assert.equal(app.installs[0].spec, lockedArchive);
      assert.equal(app.snapshot().install.subject.spec, exact, 'The report subject keeps its npm identity');
      assert.equal(app.prepares.length, 1);
      assert.equal(app.directPrepares.length, 0);
      assert.equal(app.installs[0].options.enabled, false, 'Enabling stays an explicit official action');
    } finally { app.dispose(); }
  }
});

test('a failed or incomplete review still permits an explicit direct install', async () => {
  for (const response of [
    { ok: false, error: { code: 'review-failed', message: 'Model unavailable' } },
    { ok: true, value: report(Date.now(), { status: 'incomplete', error: { code: 'package-unavailable', message: 'Unsupported source' } }) },
  ]) {
    const app = harness({ review: async () => response });
    try {
      app.begin(); await until(() => app.snapshot().install.phase === 'review');
      app.market.installWithoutReview(); await until(() => app.snapshot().install.phase === 'done');
      assert.equal(app.installs.length, 1); assert.equal(app.installs[0].spec, lockedArchive);
      assert.equal(app.directPrepares.length, 1);
      assert.equal(app.prepares.length, 0);
      assert.equal(app.snapshot().install.review, null); assert.equal(app.snapshot().install.reviewError, null);
      assert.equal(app.snapshot().install.reviewAcknowledged, false);
    } finally { app.dispose(); }
  }
});

test('skipping an in-flight review aborts it and ignores its late answer while installing', async () => {
  let settleReview!: (value: any) => void;
  let settleInstall!: (value: any) => void;
  const app = harness({
    review: () => new Promise(resolve => { settleReview = resolve; }),
    install: () => new Promise(resolve => { settleInstall = resolve; }),
  });
  try {
    app.begin(); await until(() => app.reviews.length === 1);
    app.market.installWithoutReview(); await until(() => app.installs.length === 1);
    assert.equal(app.reviews[0].signal.aborted, true);
    const state = app.snapshot().install;
    assert.equal(state.phase, 'starting'); assert.equal(state.review, null);
    settleReview({ ok: true, value: report() }); await tick();
    assert.equal(app.snapshot().install, state);
    assert.equal(app.installs[0].spec, lockedArchive); assert.equal(app.prepares.length, 0);
    assert.equal(app.directPrepares.length, 1);
    settleInstall({ ok: true, value: { application: 'applied', bundle: 'dsh-review-test' } });
    await until(() => app.snapshot().install.phase === 'done');
  } finally { app.dispose(); }
});

test('direct installation retries approved build scripts without introducing a review', async () => {
  let attempts = 0;
  const app = harness({ install: async () => ++attempts === 1
    ? { ok: true, value: { application: 'failed', pendingBuilds: ['fixture-build'], packageResult: { exitCode: 1 }, error: { code: 'builds-blocked', diagnostic: 'needs approval' } } }
    : { ok: true, value: { application: 'applied', bundle: 'dsh-review-test' } },
  });
  try {
    app.beginDirect(); await until(() => app.snapshot().install.phase === 'failed');
    app.market.approveBuildsAndRetry(); await until(() => app.snapshot().install.phase === 'done');
    assert.equal(app.installs.length, 2);
    assert.equal(app.installs[1].spec, lockedArchive);
    assert.deepEqual([...app.installs[1].options.approvedBuilds], ['fixture-build']);
    assert.equal(app.reviews.length, 0); assert.equal(app.prepares.length, 0);
    assert.equal(app.directPrepares.length, 2);
  } finally { app.dispose(); }
});

test('a different registry cannot silently install or review a public npm archive', async () => {
  for (const action of ['beginDirect', 'begin'] as const) {
    const app = harness({ inspect: () => ({ status: 'accepted', kind: 'registry', registry: 'https://private.example/', name: 'dsh-review-test', version: '1.2.3', bundle: true }) });
    try {
      app[action](); await until(() => app.snapshot().install.phase === 'idle' && app.snapshot().install.inputError !== null);
      assert.match(app.snapshot().install.inputError.reason, /公共 npm/);
      assert.equal(app.installs.length, 0); assert.equal(app.reviews.length, 0); assert.equal(app.directPrepares.length, 0);
    } finally { app.dispose(); }
  }
});

test('an inspect refusal prevents both direct installation and optional review', async () => {
  for (const action of ['beginDirect', 'begin'] as const) {
    const app = harness({ inspect: () => ({ status: 'refused', problem: 'not-a-plugin', reason: 'Not a DSH plugin' }) });
    try {
      app[action](); await until(() => app.snapshot().install.phase === 'idle' && app.snapshot().install.inputError !== null);
      assert.equal(app.snapshot().install.inputError.problem, 'not-a-plugin');
      assert.equal(app.installs.length, 0); assert.equal(app.reviews.length, 0); assert.equal(app.prepares.length, 0); assert.equal(app.directPrepares.length, 0);
    } finally { app.dispose(); }
  }
});

test('cancelling direct archive preparation aborts its request and ignores a late archive', async () => {
  let settle!: (value: any) => void;
  const app = harness({ prepareDirect: () => new Promise(resolve => { settle = resolve; }) });
  try {
    app.beginDirect(); await until(() => app.directPrepares.length === 1);
    app.market.closeInstall(); assert.equal(app.directPrepares[0].signal.aborted, true);
    settle({ ok: true, value: { spec: exact, sha256: digest, installSpec: lockedArchive } }); await tick();
    assert.equal(app.installs.length, 0); assert.equal(app.snapshot().install.open, false);
  } finally { app.dispose(); }
});

test('direct archive preparation refuses mismatched identity and invalid or failed responses', async () => {
  for (const response of [
    { ok: true, value: { spec: 'different@2.0.0', sha256: digest, installSpec: lockedArchive } },
    { ok: true, value: { spec: exact, sha256: 'invalid-digest', installSpec: lockedArchive } },
    { ok: true, value: { spec: exact, sha256: digest, installSpec: '' } },
    { ok: false, error: { code: 'package-unavailable', message: 'Download exceeds limit' } },
  ]) {
    const app = harness({ prepareDirect: async () => response });
    try {
      app.beginDirect(); await until(() => app.snapshot().install.phase === 'idle' && app.snapshot().install.inputError !== null);
      assert.equal(app.directPrepares.length, 1);
      assert.equal(app.installs.length, 0); assert.equal(app.reviews.length, 0); assert.equal(app.prepares.length, 0);
    } finally { app.dispose(); }
  }
});

test('failed or mismatched review reports cannot authorize installation', async () => {
  for (const value of [report(Date.now(), { spec: 'different@1.2.3' }), report(Date.now(), { error: { code: 'package-unavailable', message: 'Unsupported source' }, status: 'incomplete' }), report(Date.now(), { requiresConfirmation: false }), report(Date.now(), { checkedAt: 'not-a-date' }), report(Date.now(), { reviewId: undefined })]) {
    const app = harness({ review: async () => ({ ok: true, value }) });
    try {
      app.begin(); await until(() => app.snapshot().install.phase === 'review');
      app.market.acknowledgeReview(true); app.market.continueReviewedInstall(); await tick();
      assert.equal(app.installs.length, 0);
    } finally { app.dispose(); }
  }
});

test('an expired report triggers a new DSH check and clears the previous acknowledgement', async () => {
  const app = harness();
  try {
    app.begin(); await until(() => app.snapshot().install.phase === 'review');
    app.market.acknowledgeReview(true); app.advance(10 * 60 * 1000); app.market.continueReviewedInstall();
    await until(() => app.reviews.length === 2 && app.snapshot().install.phase === 'review');
    assert.equal(app.snapshot().install.reviewAcknowledged, false); assert.equal(app.installs.length, 0);
    app.market.acknowledgeReview(true); app.market.continueReviewedInstall();
    await until(() => app.installs.length === 1);
  } finally { app.dispose(); }
});

test('closing, replacing or disposing a review aborts its request and ignores a late result', async () => {
  for (const action of ['close', 'replace', 'dispose']) {
    let settle!: (result: any) => void;
    const app = harness({ review: () => new Promise(resolve => { settle = resolve; }) });
    try {
      app.begin(); await until(() => app.reviews.length === 1);
      if (action === 'close') app.market.closeInstall();
      else if (action === 'replace') { app.main.openInstall(); app.main.editInstallSpec('different@2.0.0'); }
      else app.dispose();
      assert.equal(app.reviews[0].signal.aborted, true);
      await tick(); // The replacement dialog may finish its independent registry lookup.
      const state = app.snapshot().install;
      settle({ ok: true, value: report() }); await tick();
      assert.equal(app.snapshot().install, state); assert.equal(app.installs.length, 0);
    } finally { if (action !== 'dispose') app.dispose(); }
  }
});

test('retrying blocked build scripts cannot reuse an expired report', async () => {
  const app = harness({ install: async () => ({ ok: true, value: { application: 'failed', pendingBuilds: ['fixture-build'], packageResult: { exitCode: 1 }, error: { code: 'builds-blocked', diagnostic: 'needs approval' } } }) });
  try {
    app.begin(); await until(() => app.snapshot().install.phase === 'review');
    app.market.acknowledgeReview(true); app.market.continueReviewedInstall(); await until(() => app.snapshot().install.phase === 'failed');
    app.advance(10 * 60 * 1000); app.market.approveBuildsAndRetry();
    await until(() => app.reviews.length === 2 && app.snapshot().install.phase === 'review');
    assert.equal(app.installs.length, 1); assert.equal(app.snapshot().install.reviewAcknowledged, false);
    app.market.acknowledgeReview(true); app.market.continueReviewedInstall(); await until(() => app.installs.length === 2);
    assert.deepEqual([...app.installs[1].options.approvedBuilds], ['fixture-build']);
  } finally { app.dispose(); }
});

test('prepare-install binds the reviewed archive and rejects changed or expired host receipts', async () => {
  for (const response of [
    { ok: true, value: { spec: 'different@2.0.0', sha256: digest, installSpec: lockedArchive } },
    { ok: true, value: { spec: exact, sha256: 'b'.repeat(64), installSpec: lockedArchive } },
    { ok: true, value: { spec: exact, sha256: digest, installSpec: '' } },
    { ok: false, error: { code: 'plugin-review/expired', message: 'Expired' } },
  ]) {
    const app = harness({ prepare: async () => response });
    try {
      app.begin(); await until(() => app.snapshot().install.phase === 'review');
      app.market.acknowledgeReview(true); app.market.continueReviewedInstall();
      await until(() => app.snapshot().install.phase === 'review' && app.snapshot().install.reviewError);
      assert.equal(app.installs.length, 0); assert.equal(app.snapshot().install.reviewAcknowledged, false);
    } finally { app.dispose(); }
  }
});

test('cancelling while the archive is prepared cannot start installation on a late reply', async () => {
  let settle!: (value: any) => void;
  const app = harness({ prepare: () => new Promise(resolve => { settle = resolve; }) });
  try {
    app.begin(); await until(() => app.snapshot().install.phase === 'review');
    app.market.acknowledgeReview(true); app.market.continueReviewedInstall();
    await until(() => app.snapshot().install.phase === 'preparing');
    app.market.closeInstall(); assert.equal(app.prepares[0].aborted, true);
    settle({ ok: true, value: { spec: exact, sha256: digest, installSpec: lockedArchive } }); await tick();
    assert.equal(app.installs.length, 0); assert.equal(app.snapshot().install.open, false);
  } finally { app.dispose(); }
});
