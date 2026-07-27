import { describe, expect, it } from 'vitest';
import type { Host } from '../lib/types';
import {
  createSessionTransportRuntimeStore,
  ensureSessionTerminalChannel,
  setSessionTargetTerminalMuxReady,
  setSessionTransportSocket,
  setTargetTerminalTransport,
  upsertSessionTransportRuntime,
} from '../lib/session-transport-runtime';
import {
  resolvePassiveTickTransportHealth,
  resolvePassiveVisibleRefreshTickMs,
} from './session-context-lifecycle';

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

function makeSocket(bufferedAmount: number) {
  return {
    bufferedAmount,
    readyState: 1,
    close() {},
    send() {},
    getDiagnostics() {
      return { transport: 'ws', reason: null };
    },
  };
}

describe('P1 passive visible pane fast lane', () => {
  describe('resolvePassiveVisibleRefreshTickMs', () => {
    it('keeps legacy slow lane when no transport health is provided', () => {
      const result = resolvePassiveVisibleRefreshTickMs(33);
      expect(result).toBe(198); // 33 * 6
      expect(result).toBeGreaterThanOrEqual(160);
    });

    it('returns fast lane 16-50ms for good transport', () => {
      const result = resolvePassiveVisibleRefreshTickMs(33, {
        bufferedBytes: 0,
        backpressured: false,
        connected: true,
      });
      expect(result).toBeGreaterThanOrEqual(16);
      expect(result).toBeLessThanOrEqual(50);
    });

    it('returns slow lane >=100ms for backpressured transport', () => {
      const result = resolvePassiveVisibleRefreshTickMs(33, {
        bufferedBytes: 200 * 1024,
        backpressured: true,
        connected: true,
      });
      expect(result).toBeGreaterThanOrEqual(100);
    });

    it('returns slow lane >=100ms for disconnected transport', () => {
      const result = resolvePassiveVisibleRefreshTickMs(33, {
        bufferedBytes: 0,
        backpressured: false,
        connected: false,
      });
      expect(result).toBeGreaterThanOrEqual(100);
    });

    it('returns medium lane 50-100ms for moderate buffered bytes', () => {
      const result = resolvePassiveVisibleRefreshTickMs(33, {
        bufferedBytes: 64 * 1024,
        backpressured: false,
        connected: true,
      });
      expect(result).toBeGreaterThanOrEqual(50);
      expect(result).toBeLessThan(100);
    });
  });

  describe('resolvePassiveTickTransportHealth', () => {
    it('reads bufferedAmount from transportRuntimeStore', () => {
      const store = createSessionTransportRuntimeStore();
      upsertSessionTransportRuntime(store, 's1', makeHost());
      setSessionTransportSocket(store, 's1', makeSocket(42 * 1024) as any);
      const health = resolvePassiveTickTransportHealth(
        's1',
        'connected',
        {
          current: store,
        },
      );
      expect(health).toEqual({
        bufferedBytes: 42 * 1024,
        backpressured: false,
        connected: true,
      });
    });

    it('marks transport backpressured at >=128KiB', () => {
      const store = createSessionTransportRuntimeStore();
      upsertSessionTransportRuntime(store, 's1', makeHost());
      setSessionTransportSocket(store, 's1', makeSocket(200 * 1024) as any);
      const health = resolvePassiveTickTransportHealth(
        's1',
        'connected',
        {
          current: store,
        },
      );
      expect(health).toEqual({
        bufferedBytes: 200 * 1024,
        backpressured: true,
        connected: true,
      });
    });

    it('reports disconnected even if no socket is present', () => {
      const store = createSessionTransportRuntimeStore();
      const health = resolvePassiveTickTransportHealth(
        's1',
        'disconnected',
        {
          current: store,
        },
      );
      expect(health).toEqual({
        bufferedBytes: 0,
        backpressured: false,
        connected: false,
      });
    });

    it('prefers the ready mux target transport over a legacy per-session active socket', () => {
      const store = createSessionTransportRuntimeStore();
      upsertSessionTransportRuntime(store, 's1', makeHost());
      const targetKey = store.sessions.get('s1')!.targetKey;
      setSessionTransportSocket(store, 's1', makeSocket(42 * 1024) as any);
      setTargetTerminalTransport(store, targetKey, makeSocket(256 * 1024) as any);
      ensureSessionTerminalChannel(store, 's1', { channelId: 'channel-a' });
      setSessionTargetTerminalMuxReady(store, 's1', true);

      const health = resolvePassiveTickTransportHealth(
        's1',
        'connected',
        { current: store },
      );
      expect(health).toEqual({
        bufferedBytes: 256 * 1024,
        backpressured: true,
        connected: true,
      });
    });
  });
});
