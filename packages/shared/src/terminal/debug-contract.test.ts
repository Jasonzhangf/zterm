import { describe, expect, it } from 'vitest';
import {
  BoundedDebugEventStore,
  DebugHub,
  DebugPermissionService,
  matchesDebugFilter,
  type DebugEvent,
} from './debug-contract';

type Payload = { readonly scope: string };

function event(nodeId: string, kind: string, payload: Payload): DebugEvent<Payload> {
  return {
    eventId: `${nodeId}:${kind}`,
    nodeId,
    kind,
    sequence: 1,
    capturedAt: '2026-08-15T00:00:00.000Z',
    sensitivity: 'internal',
    payload,
  };
}

describe('shared debug contract', () => {
  it('drops bounded events and increments the drop counter', () => {
    const store = new BoundedDebugEventStore<Payload>(2);
    expect(store.push(event('a', 'metric', { scope: '1' }))).toBe(true);
    expect(store.push(event('a', 'metric', { scope: '2' }))).toBe(true);
    expect(store.push(event('a', 'metric', { scope: '3' }))).toBe(false);
    expect(store.list()).toHaveLength(2);
    expect(store.getDropCount()).toBe(1);
  });

  it('applies typed filters to subscribers', () => {
    const hub = new DebugHub<Payload>();
    const received: string[] = [];
    hub.subscribe({ nodeIds: ['buffer-node'], kinds: ['revision'] }, (debugEvent) => {
      received.push(debugEvent.nodeId);
    });

    hub.publish(event('other-node', 'revision', { scope: 'x' }));
    hub.publish(event('buffer-node', 'other', { scope: 'y' }));
    hub.publish(event('buffer-node', 'revision', { scope: 'z' }));

    expect(received).toEqual(['buffer-node']);
  });

  it('matches filters without mutating events', () => {
    const debugEvent = event('a', 'metric', { scope: 'x' });
    expect(matchesDebugFilter({ nodeIds: ['a'], sensitivity: ['internal'] }, debugEvent)).toBe(true);
    const hub = new DebugHub<Payload>({ maxEvents: 1 });
    hub.publish(debugEvent);
    expect(Object.isFrozen(hub.listEvents()[0])).toBe(true);
  });

  it('defaults debug permissions to deny and expires explicit grants', () => {
    let now = 1000;
    const service = new DebugPermissionService({ now: () => now });

    expect(service.can('debug:control')).toBe(false);
    service.grant('debug:control', 100);
    expect(service.can('debug:control')).toBe(true);
    expect(service.can('debug:read')).toBe(false);

    now = 1101;
    expect(service.can('debug:control')).toBe(false);
    expect(service.getGrantSummary()).toEqual({ capability: null, expiresAt: 0 });
  });
});
