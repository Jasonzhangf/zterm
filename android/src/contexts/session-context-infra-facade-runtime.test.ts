import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createSessionTransportRuntimeStore,
  getSessionTransportRuntime,
  setSessionTargetTerminalMuxReady,
  setTargetTerminalTransport,
  upsertSessionTransportRuntime,
} from '../lib/session-transport-runtime';
import { ensureSessionTerminalChannel, getSessionTerminalChannel } from '../lib/terminal-channel-mux-runtime';
import type { Host } from '../lib/types';
import {
  createSessionInfraFacadeRuntime,
  shouldRouteAndroidHostToTraversalSocket,
  wrapSessionPayloadForTargetMuxRuntime,
} from './session-context-infra-facade-runtime';

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
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send() {},
    close() {},
    getDiagnostics() {
      return { transport: 'ws', reason: null };
    },
  };
}

function createMuxStore() {
  const store = createSessionTransportRuntimeStore();
  upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
  const targetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
  const targetSocket = makeSocket('target-terminal');
  setTargetTerminalTransport(store, targetKey, targetSocket as any);
  ensureSessionTerminalChannel(store.terminalChannels, 'session-1', { channelId: 'channel-a' });
  setSessionTargetTerminalMuxReady(store, 'session-1', true);
  return { store, targetSocket };
}

function unwrap(data: string | ArrayBuffer) {
  expect(typeof data).toBe('string');
  return JSON.parse(data as string);
}

describe('Android connection service platform wiring', () => {
  it('uses the native service projection for ordinary Android WebSocket targets', () => {
    expect(shouldRouteAndroidHostToTraversalSocket(makeHost())).toBe(false);
  });

  it('routes explicit WebRTC and relay-rtc certified Android hosts through the traversal transport', () => {
    expect(shouldRouteAndroidHostToTraversalSocket(makeHost({ transportMode: 'webrtc' }))).toBe(true);
    expect(shouldRouteAndroidHostToTraversalSocket(makeHost({
      relayEndpointCandidates: [{
        id: 'relay-rtc:daemon-host-a',
        kind: 'relay-rtc',
        relayHostId: 'daemon-host-a',
        authRequired: true,
        lastSeenAt: '2026-09-10T00:00:00.000Z',
      }],
    }))).toBe(true);
  });

  it('routes Android daemon target sockets through the native service projection factory', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'session-context-infra-facade-runtime.ts'), 'utf8');

    expect(source).toContain('Capacitor.isNativePlatform()');
    expect(source).toContain("Capacitor.getPlatform() === 'android'");
    expect(source).toContain('openAndroidConnectionServiceTransportSocket(host)');
  });

  it('routes explicit WebRTC and relay-rtc Android targets through the traversal transport', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'session-context-infra-facade-runtime.ts'), 'utf8');

    expect(source).toContain('shouldRouteAndroidHostToTraversalSocket(host)');
    expect(source).toContain("transportRole: 'session'");
    expect(source).toContain('buildTraversalSocketForHostRuntime({');
  });
});

describe('body demand reconciliation', () => {
  it('reopens a closed mux channel when the session becomes body-subscribed again', () => {
    const { store } = createMuxStore();
    const channel = getSessionTerminalChannel(store.terminalChannels, 'session-1');
    if (!channel) {
      throw new Error('channel not initialized');
    }
    channel.state = 'closed';
    const reopenSessionTerminalChannel = vi.fn();
    const stateRef = {
      current: {
        activeSessionId: null,
        liveSessionIds: ['session-1'],
        sessions: [{ id: 'session-1', state: 'connected' }],
      },
    };
    const runtime = createSessionInfraFacadeRuntime({
      stateRef,
      dispatch: vi.fn(),
      reduceSessionAction: (state: unknown, _action: unknown) => state,
      transportRuntimeStoreRef: { current: store },
      sessionBufferStoreRef: { current: {} },
      sessionRenderGateRef: { current: {} },
      sessionHeadStoreRef: { current: {} },
      sessionDebugMetricsStoreRef: { current: {} },
      scheduleStatesRef: { current: {} },
      setScheduleStates: vi.fn(),
      sessionAttachTokensRef: { current: new Map() },
      pendingSessionTransportOpenIntentsRef: { current: new Map() },
      activeBodySubscriptionSuppressedRef: { current: false },
      reopenSessionTerminalChannelRef: { current: reopenSessionTerminalChannel },
      reconnectStore: {},
      tailRefreshStore: {},
      bufferFrameAssemblyRef: { current: new Map() },
      sessionPullStateRef: { current: new Map() },
      heartbeatStore: {},
      handshakeTimeoutsRef: { current: new Map() },
      sessionRevisionResetRef: { current: new Map() },
      lastHeadRequestAtRef: { current: new Map() },
      terminalCacheLines: 1000,
      defaultRows: 40,
      bridgeSettings: {},
      staleActivityMs: 3000,
      runtimeDebug: vi.fn(),
    } as any);

    runtime.reconcilePhysicalBodySubscriptions('live-sessions');

    expect(reopenSessionTerminalChannel).toHaveBeenCalledWith('session-1');
  });
});

describe('wrapSessionPayloadForTargetMuxRuntime', () => {
  it('leaves non-target sockets unchanged', () => {
    const { store } = createMuxStore();
    const legacySocket = makeSocket('legacy-session');
    const data = JSON.stringify({ type: 'input', payload: 'pwd\r' });

    expect(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: legacySocket as any,
      data,
    })).toBe(data);
  });

  it('wraps session-bound JSON messages in channel envelopes on the target mux socket', () => {
    const { store, targetSocket } = createMuxStore();
    const wrapped = unwrap(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: JSON.stringify({ type: 'input', payload: 'echo alpha\r' }),
    }));

    expect(wrapped).toEqual({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-a',
        message: {
          type: 'input',
          payload: 'echo alpha\r',
        },
      },
    });
  });

  it('wraps binary chunks with the owning channel id', () => {
    const { store, targetSocket } = createMuxStore();
    const wrapped = unwrap(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: new TextEncoder().encode('image-chunk').buffer,
    }));

    expect(wrapped).toEqual({
      type: 'mux-channel-binary',
      payload: {
        channelId: 'channel-a',
        dataBase64: 'aW1hZ2UtY2h1bms=',
      },
    });
  });

  it('maps target and close messages to mux target-level frames without rebuilding sockets', () => {
    const { store, targetSocket } = createMuxStore();

    expect(unwrap(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: JSON.stringify({ type: 'list-sessions' }),
    }))).toEqual({
      type: 'mux-target-message',
      payload: {
        message: { type: 'list-sessions' },
      },
    });

    expect(unwrap(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: JSON.stringify({ type: 'close' }),
    }))).toEqual({
      type: 'mux-channel-close',
      payload: {
        channelId: 'channel-a',
        reason: 'client requested channel close',
      },
    });
  });

  it('does not double-wrap existing mux frames and rejects legacy connect frames on target mux transport', () => {
    const { store, targetSocket } = createMuxStore();
    const muxHello = JSON.stringify({
      type: 'mux-hello',
      payload: { version: 1, clientInstanceId: 'session-1' },
    });

    expect(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: muxHello,
    })).toBe(muxHello);

    expect(() => wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: JSON.stringify({
        type: 'connect',
        payload: {
          openRequestId: 'open-1',
          sessionTransportToken: 'token-1',
          sessionName: 'alpha',
        },
      }),
    })).toThrow(/legacy terminal message connect/);
  });
});
