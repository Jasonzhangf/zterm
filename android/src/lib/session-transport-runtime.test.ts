import { describe, expect, it } from 'vitest';
import type { Host } from './types';
import {
  buildTransportTargetKey,
  clearSessionSupersededSockets,
  createSessionTransportRuntimeStore,
  getSessionTargetControlTransport,
  getSessionTargetTransportRuntime,
  getSessionTransportTargetKey,
  getTargetControlTransport,
  getTargetTransportRuntime,
  getSessionTransportHost,
  getSessionTransportRuntime,
  getSessionTransportSocket,
  moveSessionTransportSocketToSuperseded,
  removeSessionTransportRuntime,
  setSessionTargetControlTransport,
  setTargetControlTransport,
  setSessionTransportSocket,
  upsertSessionTransportRuntime,
} from './session-transport-runtime';

function makeHost(overrides?: Partial<Host>): Host {
  return {
    id: 'host-1',
    createdAt: 1,
    name: 'conn',
    bridgeHost: '100.64.0.1',
    bridgePort: 3333,
    sessionName: 'alpha',
    authToken: 'token-a',
    authType: 'password',
    tags: [],
    pinned: false,
    ...overrides,
  };
}

function makeSocket(name: string) {
  return {
    name,
    readyState: 1,
    closeCalls: 0,
    send() {},
    close() {
      this.closeCalls += 1;
      this.readyState = 3;
    },
    getDiagnostics() {
      return { transport: 'ws', reason: null };
    },
  };
}

describe('session transport runtime store', () => {
  it('uses bridgeHost + bridgePort + authToken as the target key truth', () => {
    expect(buildTransportTargetKey(makeHost())).toBe('100.64.0.1:3333:token-a');
    expect(buildTransportTargetKey(makeHost({ authToken: 'token-b' }))).toBe('100.64.0.1:3333:token-b');
    expect(buildTransportTargetKey(makeHost({ bridgePort: 4444 }))).toBe('100.64.0.1:4444:token-a');
  });

  it('groups same-target sessions under one target runtime while keeping per-session runtime truth', () => {
    const store = createSessionTransportRuntimeStore();

    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));

    expect(store.targets.size).toBe(1);
    expect(store.targets.values().next().value?.sessionIds).toEqual(['session-1', 'session-2']);
    expect(getSessionTransportRuntime(store, 'session-1')?.targetKey).toBe(getSessionTransportRuntime(store, 'session-2')?.targetKey);
    expect(getSessionTransportTargetKey(store, 'session-1')).toBe(getSessionTransportRuntime(store, 'session-1')?.targetKey);
    expect(getSessionTransportHost(store, 'session-2')?.sessionName).toBe('beta');
    expect(getSessionTargetTransportRuntime(store, 'session-1')).toBe(getSessionTargetTransportRuntime(store, 'session-2'));
  });

  it('keeps one target-level control transport truth shared by same-target sessions', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));

    const targetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    const controlSocket = makeSocket('control-a');

    setTargetControlTransport(store, targetKey, controlSocket as any);

    expect(getTargetTransportRuntime(store, targetKey)?.controlTransport).toBe(controlSocket);
    expect(getTargetControlTransport(store, targetKey)).toBe(controlSocket);
    expect(getSessionTargetControlTransport(store, 'session-1')).toBe(controlSocket);
    expect(getSessionTargetControlTransport(store, 'session-2')).toBe(controlSocket);
  });

  it('session-side helper can update the shared target control transport without touching per-session sockets', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));

    const sessionSocket = makeSocket('session-a');
    const controlSocket = makeSocket('control-a');

    setSessionTransportSocket(store, 'session-1', sessionSocket as any);
    setSessionTargetControlTransport(store, 'session-2', controlSocket as any);

    expect(getSessionTransportSocket(store, 'session-1')).toBe(sessionSocket);
    expect(getSessionTransportSocket(store, 'session-2')).toBeNull();
    expect(getSessionTargetControlTransport(store, 'session-1')).toBe(controlSocket);
    expect(getSessionTargetControlTransport(store, 'session-2')).toBe(controlSocket);
  });

  it('moves replaced session sockets into superseded truth without affecting siblings', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));

    const socketA = makeSocket('a');
    const socketB = makeSocket('b');
    setSessionTransportSocket(store, 'session-1', socketA as any);
    setSessionTransportSocket(store, 'session-2', socketB as any);

    moveSessionTransportSocketToSuperseded(store, 'session-1');

    expect(getSessionTransportSocket(store, 'session-1')).toBeNull();
    expect(getSessionTransportRuntime(store, 'session-1')?.supersededSockets).toEqual([socketA]);
    expect(getSessionTransportSocket(store, 'session-2')).toBe(socketB);
    expect(getSessionTransportRuntime(store, 'session-2')?.supersededSockets).toEqual([]);
  });

  it('clears superseded sockets and drops empty target runtimes only when the last session leaves', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));

    const socketA = makeSocket('a');
    setSessionTransportSocket(store, 'session-1', socketA as any);
    moveSessionTransportSocketToSuperseded(store, 'session-1');

    expect(clearSessionSupersededSockets(store, 'session-1')).toEqual([socketA]);
    expect(getSessionTransportRuntime(store, 'session-1')?.supersededSockets).toEqual([]);

    removeSessionTransportRuntime(store, 'session-1');
    expect(store.targets.size).toBe(1);
    expect(store.targets.values().next().value?.sessionIds).toEqual(['session-2']);

    removeSessionTransportRuntime(store, 'session-2');
    expect(store.targets.size).toBe(0);
    expect(store.sessions.size).toBe(0);
  });

  it('retains target runtime while control transport exists and drops it only after control closes', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));

    const targetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    const controlSocket = makeSocket('control-a');

    setTargetControlTransport(store, targetKey, controlSocket as any);
    removeSessionTransportRuntime(store, 'session-1');

    expect(store.sessions.size).toBe(0);
    expect(store.targets.size).toBe(1);
    expect(getTargetTransportRuntime(store, targetKey)?.controlTransport).toBe(controlSocket);

    setTargetControlTransport(store, targetKey, null);

    expect(getTargetTransportRuntime(store, targetKey)).toBeNull();
    expect(store.targets.size).toBe(0);
  });

  it('drops empty old target on session retarget only when that old target has no control transport', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));

    const oldTargetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    const oldControlSocket = makeSocket('old-control');
    setTargetControlTransport(store, oldTargetKey, oldControlSocket as any);

    upsertSessionTransportRuntime(
      store,
      'session-1',
      makeHost({
        bridgeHost: '100.64.0.2',
        authToken: 'token-b',
        sessionName: 'alpha',
      }),
    );

    const newTargetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    expect(newTargetKey).not.toBe(oldTargetKey);
    expect(getTargetTransportRuntime(store, oldTargetKey)?.sessionIds).toEqual([]);
    expect(getTargetTransportRuntime(store, oldTargetKey)?.controlTransport).toBe(oldControlSocket);
    expect(getTargetTransportRuntime(store, newTargetKey)?.sessionIds).toEqual(['session-1']);

    setTargetControlTransport(store, oldTargetKey, null);

    expect(getTargetTransportRuntime(store, oldTargetKey)).toBeNull();
    expect(getTargetTransportRuntime(store, newTargetKey)?.sessionIds).toEqual(['session-1']);
  });
});
