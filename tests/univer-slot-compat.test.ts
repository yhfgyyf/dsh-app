import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Cordis from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import * as UiSlots from '@deepseek-ai/dsh-client-ui-slots';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { createDesktopModuleFacade, DesktopSlotCore } from '../src/renderer/univer-slot-compat.ts';

const name = 'conversation.chat.turnTail';
const registrant = 'dsh-univer-office';
const component = () => null;

function fixture(Core: typeof SlotCore = DesktopSlotCore) {
  const slots = new Core();
  slots.register({ name: 'root', children: { [name]: { kind: 'list', scope: 'session' }, 'other.list': { kind: 'list', scope: 'session' } } } as never, component);
  return slots;
}

function register(slots: SlotCore, options: Record<string, unknown>, render: any = component) {
  return slots.register(options as never, render);
}

test('upstream reproduces the legacy missing id error and Desktop adapts that registration', () => {
  const select = () => null;
  const options = { name, registrant, priority: -10, select };
  assert.throws(() => register(fixture(SlotCore), options), /requires options.id/);
  const slots = fixture();
  const dispose = register(slots, options);
  const entry = slots.entries(name)[0];
  assert.equal(entry.options.id, 'univer-turn-preview');
  assert.equal(entry.options.priority, -10);
  assert.equal(entry.registrant, registrant);
  assert.equal(entry.select, undefined, 'Legacy routing must move into the component');
  assert.equal(options.select, select, 'Do not mutate the installed plugin options');
  assert.equal('id' in options, false);
  dispose();
  assert.equal(slots.entries(name).length, 0);
  register(slots, options)();
  assert.equal(slots.entries(name).length, 0);
});

test('legacy selector hides ordinary turns and supplies matched data to a React child', () => {
  const slots = fixture();
  let selected = 0;
  let rendered = 0;
  const match = { turn: 7, files: ['book.xlsx'] };
  const options = { name, registrant, select: (props: any) => { selected++; return props.show ? match : null; } };
  function Preview(props: any) {
    rendered++;
    const [suffix] = React.useState('preview');
    assert.equal(props.matched, match);
    assert.equal(props.sessionId, 'session-7');
    return React.createElement('span', null, `${props.matched.files[0]}:${suffix}`);
  }
  register(slots, options, Preview);
  assert.equal(selected, 0, 'Do not evaluate selection during registration');
  const Wrapper = slots.entries(name)[0].component as React.ComponentType<any>;
  assert.equal(renderToStaticMarkup(React.createElement(Wrapper, { show: false, sessionId: 'session-7' })), '');
  assert.equal(rendered, 0, 'Ordinary turns must not render PreviewCard');
  assert.equal(renderToStaticMarkup(React.createElement(Wrapper, { show: true, sessionId: 'session-7' })), '<span>book.xlsx:preview</span>');
  assert.equal(rendered, 1);
  assert.equal(selected, 2);
  // Calling the wrapper does not execute Preview's hooks: React owns that child.
  const child = (Wrapper as (props: any) => React.ReactNode)({ show: true, sessionId: 'session-7' });
  assert.ok(React.isValidElement(child));
  assert.equal(child.type, Preview);
  assert.equal(rendered, 1);
});

test('new Univer registrations keep their explicit identity and component unchanged', () => {
  const slots = fixture();
  const select = () => null;
  register(slots, { name, registrant, id: 'univer-new-preview', select }, component);
  const entry = slots.entries(name)[0];
  assert.equal(entry.options.id, 'univer-new-preview');
  assert.equal(entry.component, component);
  assert.equal(entry.select, select);
});

test('compatibility remains limited to the known legacy Univer slot shape', () => {
  for (const options of [
    { name, registrant: 'another-plugin', select: () => null },
    { name, select: () => null },
    { name: 'other.list', registrant, select: () => null },
    { name, registrant },
    { name, registrant, select: 'invalid-selector' },
  ]) assert.throws(() => register(fixture(), options), /requires options.id/);
});

test('adapted legacy registrations retain upstream duplicate-id validation', () => {
  const slots = fixture();
  const options = { name, registrant, select: () => null };
  const dispose = register(slots, options);
  assert.throws(() => register(slots, options), /already has an entry with id/);
  dispose();
  assert.doesNotThrow(() => register(slots, options));
});

test('public module facade names only anonymous Univer exports across queued and live registrations', () => {
  const target = createDesktopModuleFacade();
  const apply = () => {};
  const original = Object.create(null, {
    __esModule: { value: true },
    apply: { get: () => apply, enumerable: true },
    inject: { value: ['slots'], enumerable: true },
  });
  let materialized = 0;
  target.load({ id: registrant, factory: () => { materialized++; return original; } });
  const other = { id: 'another-plugin', factory: () => original };
  const chunk = { id: registrant, chunk: 'client.preview.js', factory: () => original };
  const explicit = { name: 'future-univer', apply };
  target.load(other);
  target.load(chunk);
  target.load({ id: registrant, factory: () => explicit });
  assert.equal(target.pendingQueue[1], other);
  assert.equal(target.pendingQueue[2], chunk);
  assert.equal(target.pendingQueue[3].factory(() => {}), explicit);
  const queued = target.pendingQueue.splice(0);
  const live: any[] = [];
  target.mode = 'live';
  target.load = registration => { live.push(registration); };
  for (const registration of queued) target.load(registration);
  assert.equal(live[1], other);
  assert.equal(live[2], chunk);
  assert.equal(live[3].factory(() => {}), explicit);
  const named = live[0].factory(() => {});
  assert.equal(named.name, registrant);
  assert.equal(named.__esModule, true);
  assert.equal(Object.getPrototypeOf(named), Object.getPrototypeOf(original));
  assert.deepEqual(Object.getOwnPropertyDescriptor(named, 'apply'), Object.getOwnPropertyDescriptor(original, 'apply'));
  assert.equal(original.name, undefined);
  assert.equal(materialized, 1);
  target.load({ id: registrant, factory: () => explicit });
  assert.equal(live.at(-1).factory(() => {}), explicit);
  target.load(other);
  assert.equal(live.at(-1), other);
  assert.equal(live.at(-1).factory(() => {}), original);
  target.load(chunk);
  assert.equal(live.at(-1), chunk);
  assert.equal(live.at(-1).factory(() => {}), original);
  target.load({ id: registrant, factory: () => original });
  assert.equal(live.at(-1).factory(() => {}).name, registrant, 'Reloaded anonymous exports must retain the same source identity');
});

test('actual module Loader and SlotRegistry identify the legacy contribution by package name', async () => {
  const dependencies: Record<string, unknown> = {
    react: React, 'react-dom': ReactDom, 'react-dom/client': ReactDomClient, 'react/jsx-runtime': ReactJsxRuntime,
    '@deepseek-ai/cordis': Cordis, '@deepseek-ai/dsh-client-ui-slots': { ...UiSlots, SlotCore: DesktopSlotCore },
  };
  async function evaluate(packageName: string) {
    let exports: any;
    runInNewContext(await readFile(new URL(`../.runtime/node_modules/@deepseek-ai/${packageName}/lib/client.js`, import.meta.url), 'utf8'), {
      console, URL, queueMicrotask,
      document: { querySelectorAll: () => [], head: { querySelectorAll: () => [] } },
      window: { __ModuleLoader__: { load(entry: any) { exports = entry.factory((name: string) => {
        assert.ok(name in dependencies, name); return dependencies[name];
      }); } } },
    });
    return exports;
  }
  const { SlotRegistry } = await evaluate('dsh-client-ui-renderer');
  const clientModules = await evaluate('dsh-client-modules');
  const graph = {
    rev: 'fixture', entries: [{ id: registrant, rev: 'fixture', url: '/univer.js' }],
    batches: [{ url: '/univer.js', rev: 'fixture', phase: 'application', entries: [registrant] }],
  };
  const target = createDesktopModuleFacade();
  let fiberName: string | undefined;
  const modules = clientModules.createClientModuleSystem(target, { id: 'bootstrap', exports: {} }, {
    boot: graph, staticModules: dependencies,
    async loadBundle() {
      target.load({ id: registrant, factory: () => ({ apply(ctx: any) {
        fiberName = ctx.fiber.name;
        ctx.slots.register({ name, select: () => null }, component);
      } }) });
    },
  });
  const ctx = new Cordis.Context();
  try {
    const registry = new SlotRegistry(ctx);
    registry.register({ name: 'root', children: { [name]: { kind: 'list', scope: 'session' } } }, component);
    await ctx.plugin(Loader);
    ctx.loader.internal = modules;
    await modules.entries.start(ctx.loader, clientModules.parseBootManifest(graph));
    await ctx.loader.await();
    assert.equal(fiberName, registrant);
    assert.equal(registry.entries(name)[0].registrant, registrant);
    assert.equal(registry.entries(name)[0].options.id, 'univer-turn-preview');
    assert.equal([...ctx.loader.entries()][0].fiber?.state, 2);
  } finally {
    await ctx.fiber.dispose();
  }
});
