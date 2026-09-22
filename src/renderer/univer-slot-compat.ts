import { createElement, type ComponentType } from 'react';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';

type RuntimeRegistration = {
  name: string;
  registrant?: string;
  id?: string;
  select?: (props: Record<string, unknown>) => unknown;
  [key: string]: unknown;
};

type ClientRegistration = { id: string; chunk?: string; factory(require: (name: string) => unknown): any };

/** Univer 0.3.2 reads V3 tool-result wrappers; DSH V4 carries a tool message. */
export function legacyUniverMatch(match: any) {
  const event = match.event;
  const message = event?.data?.message;
  if (event?.type !== 'tool/result' || message?.role !== 'tool' || !Array.isArray(message.content)) return match;
  return { ...match, event: { ...event, data: { ...event.data, message: {
    ...message, role: 'user', content: [{ type: 'tool-result', toolCallId: message.toolCallId, content: message.content, isError: message.isError }],
  } } } };
}

function legacyUniverContext(ctx: any) {
  // Adapt only this plugin's definition. Other consumers retain the V4 event.
  return new Proxy(ctx, { get(target, key) {
    if (key !== 'get') return Reflect.get(target, key, target);
    return (name: string) => {
      const service = target.get(name);
      if (name !== 'uiConversation' || !service) return service;
      const events = new Proxy(service.events, { get(registry, member) {
        if (member !== 'register') return Reflect.get(registry, member, registry);
        return (definition: any) => registry.register(definition.kind !== 'univerTurn' ? definition : {
          ...definition,
          update(context: any, match: any) { return definition.update(context, legacyUniverMatch(match)); },
        });
      } });
      return new Proxy(service, { get(owner, member) { return member === 'events' ? events : Reflect.get(owner, member, owner); } });
    };
  } });
}

/** Keep the public queue/live facade while naming the anonymous Univer plugin. */
export function createDesktopModuleFacade() {
  const pendingQueue: ClientRegistration[] = [];
  let sink: (registration: ClientRegistration) => void = registration => { pendingQueue.push(registration); };
  const load = (registration: ClientRegistration) => {
    if (registration.id !== 'dsh-univer-office' || registration.chunk !== undefined) return sink(registration);
    sink({ ...registration, factory(require) {
      const exports = registration.factory(require);
      if (exports === null || typeof exports !== 'object' || exports.name !== undefined || typeof exports.apply !== 'function') return exports;
      return Object.create(Object.getPrototypeOf(exports), {
        ...Object.getOwnPropertyDescriptors(exports),
        name: { value: 'dsh-univer-office', enumerable: true, configurable: true },
        apply: { value: (ctx: any) => exports.apply(legacyUniverContext(ctx)), enumerable: true, configurable: true },
      });
    } });
  };
  return {
    mode: 'queue', pendingQueue,
    get load() { return load; },
    set load(next: (registration: ClientRegistration) => void) { sink = next; },
  };
}

/** Adapt npm Univer 0.3.2's former chain contribution to the current list slot. */
export class DesktopSlotCore extends SlotCore {
  override register: SlotCore['register'] = ((options: RuntimeRegistration, component: ComponentType<any>) => {
    if (options.registrant !== 'dsh-univer-office' || options.name !== 'conversation.chat.turnTail'
      || options.id !== undefined || typeof options.select !== 'function') {
      return super.register(options as never, component as never);
    }
    const { select, ...registration } = options;
    function LegacyUniverTurnTail(props: Record<string, unknown>) {
      const matched = select(props);
      // Preserve the selector's null contract and React's child hook boundary.
      return matched === null ? null : createElement(component, { ...props, matched });
    }
    return super.register({ ...registration, id: 'univer-turn-preview' } as never, LegacyUniverTurnTail as never);
  }) as SlotCore['register'];
}
