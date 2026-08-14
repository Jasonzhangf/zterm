import { describe, expect, it, vi } from 'vitest';
import { createSessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import { createSessionReconnectStore } from '../lib/session-reconnect-store';
import { mergeHostWithLatestProjection } from '../lib/home-connection-projection';
import {
  closeSessionRuntime,
  connectSessionRuntime,
  createSessionRuntime,
  reconnectSessionRuntime,
  renameRemoteSessionRuntime,
  runReconnectHostProbeAndFallback,
  scheduleReconnectRuntime,
  startReconnectAttemptRuntime,
} from './session-context-session-runtime';
import { buildTransportTargetKey } from '../lib/session-transport-runtime';
import type { Session } from '../lib/types';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';

const host = {
  id: 'host-1',
  createdAt: 1,
  name: 'conn',
  bridgeHost: '127.0.0.1',
  bridgePort: 3333,
  sessionName: 'tmux-1',
  authType: 'password' as const,
  tags: [],
  pinned: false,
};

const targetKey = buildTransportTargetKey(host);

function makeDaemonConnection(options: {
  socket?: any;
  terminalSocket?: any;
  channelState?: 'opening' | 'open' | 'closing' | 'closed' | null;
} = {}) {
  const socket = 'socket' in options ? options.socket : { readyState: WebSocket.OPEN };
  return {
    readSessionResource: vi.fn((sessionId: string) => ({
      sessionId,
      socket,
      terminalSocket: 'terminalSocket' in options ? options.terminalSocket : null,
      channel: options.channelState ? { state: options.channelState } : null,
    })),
    readSessionSocket: vi.fn(() => socket),
    readSessionTargetSocket: vi.fn(() => socket),
    readOpenSessionSocket: vi.fn(() => socket),
    sendSessionRaw: vi.fn(),
    sendSessionMessage: vi.fn(),
  } as unknown as ClientDaemonConnection;
}

describe('closeSessionRuntime', () => {
  it('closes the session socket instead of parking it as superseded', () => {
    const sendSocketPayload = vi.fn();
    const cleanupSocket = vi.fn();
    const cleanupControlSocket = vi.fn();
    const clearSessionTransportRuntime = vi.fn();
    const writeSessionTransportToken = vi.fn();
    const deleteSessionSync = vi.fn();
    const setScheduleStates = vi.fn();
    const bufferFrameAssemblyRef = { current: new Map([['session-1', {
      pending: null,
      error: null,
      repairDispatchedRevisions: [11],
    }]]) };
    const sessionRevisionResetRef = { current: new Map([['session-1', {
      revision: 11,
      latestEndIndex: 2,
      seenAt: 100,
    }]]) };

    closeSessionRuntime({
      sessionId: 'session-1',
      refs: {
        reconnectStore: createSessionReconnectStore(),
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        tailRefreshStore: (() => {
          const store = createSessionTailRefreshStore();
          store.markPendingInputTailRefresh('session-1', 1, 1);
          store.markPendingConnectTailRefresh('session-1');
          store.markPendingResumeTailRefresh('session-1');
          return store;
        })(),
        lastActiveReentryAtRef: { current: new Map([['session-1', 1]]) },
        lastConnectedBaselineAtRef: { current: new Map([['session-1', 1]]) },
        sessionVisibleRangeRef: { current: new Map([['session-1', { startIndex: 0, endIndex: 1 }]]) },
        sessionRevisionResetRef,
        bufferFrameAssemblyRef,
        sessionBufferStoreRef: { current: { deleteSession: vi.fn() } },
        sessionRenderGateRef: { current: { deleteSession: vi.fn() } },
        sessionHeadStoreRef: { current: { deleteSession: vi.fn() } },
        sessionDebugMetricsStoreRef: { current: { clearSession: vi.fn() } },
      },
      clearReconnectForSession: vi.fn(),
      readSessionTransportRuntime: () => ({ targetKey: 'target-a' }),
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1', 'session-2'] }),
      daemonConnection: makeDaemonConnection({ socket: { readyState: WebSocket.OPEN } as any }),
      sendSocketPayload,
      runtimeDebug: vi.fn(),
      cleanupSocket,
      cleanupControlSocket,
      writeSessionTransportToken,
      clearSessionTransportRuntime,
      setScheduleStates,
      deleteSessionSync,
    });

    expect(sendSocketPayload).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ readyState: WebSocket.OPEN }),
      JSON.stringify({ type: 'close' }),
    );
    expect(cleanupSocket).toHaveBeenCalledWith('session-1', true);
    expect(cleanupControlSocket).not.toHaveBeenCalled();
    expect(writeSessionTransportToken).toHaveBeenCalledWith('session-1', null);
    expect(clearSessionTransportRuntime).toHaveBeenCalledWith('session-1');
    expect(bufferFrameAssemblyRef.current.has('session-1')).toBe(false);
    expect(sessionRevisionResetRef.current.has('session-1')).toBe(false);
    expect(deleteSessionSync).toHaveBeenCalledWith('session-1');
  });

  it('also closes the shared control transport when the last target session is closed', () => {
    const cleanupSocket = vi.fn();
    const cleanupControlSocket = vi.fn();

    closeSessionRuntime({
      sessionId: 'session-1',
      refs: {
        reconnectStore: createSessionReconnectStore(),
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        tailRefreshStore: createSessionTailRefreshStore(),
        lastActiveReentryAtRef: { current: new Map() },
        lastConnectedBaselineAtRef: { current: new Map() },
        sessionVisibleRangeRef: { current: new Map() },
        sessionRevisionResetRef: { current: new Map() },
        bufferFrameAssemblyRef: { current: new Map() },
        sessionBufferStoreRef: { current: { deleteSession: vi.fn() } },
        sessionRenderGateRef: { current: { deleteSession: vi.fn() } },
        sessionHeadStoreRef: { current: { deleteSession: vi.fn() } },
        sessionDebugMetricsStoreRef: { current: { clearSession: vi.fn() } },
      },
      clearReconnectForSession: vi.fn(),
      readSessionTransportRuntime: () => ({ targetKey: 'target-a' }),
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1'] }),
      daemonConnection: makeDaemonConnection({ socket: null }),
      sendSocketPayload: vi.fn(),
      runtimeDebug: vi.fn(),
      cleanupSocket,
      cleanupControlSocket,
      writeSessionTransportToken: vi.fn(),
      clearSessionTransportRuntime: vi.fn(),
      setScheduleStates: vi.fn(),
      deleteSessionSync: vi.fn(),
    });

    expect(cleanupSocket).toHaveBeenCalledWith('session-1', true);
    expect(cleanupControlSocket).toHaveBeenCalledWith('session-1', true);
  });
});

describe('scheduleReconnectRuntime', () => {
  it('clears stale reconnect timer when host truth is already missing', () => {
    vi.useFakeTimers();
    const timer = setTimeout(() => undefined, 10_000) as unknown as number;
    const reconnectRuntime = {
      phase: 'scheduled' as const,
      attempt: 2,
      timer,
      nextDelayMs: null,
    };
    const reconnectStore = createSessionReconnectStore();
    reconnectStore.write('session-1', reconnectRuntime);

    scheduleReconnectRuntime({
      sessionId: 'session-1',
      message: 'missing-host',
      retryable: true,
      refs: {
        reconnectStore,
        stateRef: { current: { sessions: [], activeSessionId: 'session-1' } },
      },
      readSessionTransportHost: () => null,
      shouldAutoReconnectSessionFn: () => true,
      updateSessionSync: vi.fn(),
      emitSessionStatus: vi.fn(),
      startReconnectAttempt: vi.fn(),
    });

    expect(reconnectStore.read('session-1')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('clears queued reconnect timer without projecting terminal error when auto reconnect is blocked for inactive session', () => {
    vi.useFakeTimers();
    const timer = setTimeout(() => undefined, 10_000) as unknown as number;
    const reconnectStore = createSessionReconnectStore();
    reconnectStore.write('session-1', {
      phase: 'scheduled' as const,
      attempt: 1,
      timer,
      nextDelayMs: null,
    });
    const updateSessionSync = vi.fn();
    const emitSessionStatus = vi.fn();

    scheduleReconnectRuntime({
      sessionId: 'session-1',
      message: 'inactive-blocked',
      retryable: true,
      refs: {
        reconnectStore,
        stateRef: { current: { sessions: [], activeSessionId: 'session-2', liveSessionIds: [] } },
      },
      readSessionTransportHost: () => ({
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authType: 'password',
        tags: [],
        pinned: false,
      }),
      shouldAutoReconnectSessionFn: () => false,
      updateSessionSync,
      emitSessionStatus,
      startReconnectAttempt: vi.fn(),
    });

    expect(reconnectStore.read('session-1')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(updateSessionSync).toHaveBeenCalled();
    expect(emitSessionStatus).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps retryable reconnect out of terminal error projection for a visible live pane', () => {
    vi.useFakeTimers();
    const reconnectStore = createSessionReconnectStore();
    const updateSessionSync = vi.fn();
    const emitSessionStatus = vi.fn();
    const startReconnectAttempt = vi.fn();

    scheduleReconnectRuntime({
      sessionId: 'session-2',
      message: 'visible-pane-stale',
      retryable: true,
      refs: {
        reconnectStore,
        stateRef: { current: { sessions: [], activeSessionId: 'session-1', liveSessionIds: ['session-2'] } },
      },
      readSessionTransportHost: () => ({
        id: 'host-2',
        createdAt: 1,
        name: 'conn-2',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-2',
        authType: 'password',
        tags: [],
        pinned: false,
      }),
      shouldAutoReconnectSessionFn: (options) => (
        options.sessionId === options.activeSessionId
        || Boolean(options.liveSessionIds?.includes(options.sessionId))
      ),
      updateSessionSync,
      emitSessionStatus,
      startReconnectAttempt,
    });

    expect(reconnectStore.read('session-2')).not.toBeNull();
    expect(updateSessionSync).toHaveBeenCalled();
    expect(emitSessionStatus).not.toHaveBeenCalled();
    expect(startReconnectAttempt).toHaveBeenCalledWith('session-2');
    vi.useRealTimers();
  });

  it('manual close suppresses retryable reconnect and clears scheduled phase', () => {
    vi.useFakeTimers();
    const reconnectStore = createSessionReconnectStore();
    const timer = setTimeout(() => undefined, 10_000) as unknown as number;
    reconnectStore.schedule('session-1', { attempt: 4, timer });
    reconnectStore.markManualClosed('session-1');
    const updateSessionSync = vi.fn();
    const emitSessionStatus = vi.fn();
    const startReconnectAttempt = vi.fn();

    scheduleReconnectRuntime({
      sessionId: 'session-1',
      message: 'manual-close',
      retryable: true,
      refs: {
        reconnectStore,
        stateRef: { current: { sessions: [], activeSessionId: 'session-1', liveSessionIds: [] } },
      },
      readSessionTransportHost: () => host,
      shouldAutoReconnectSessionFn: () => true,
      updateSessionSync,
      emitSessionStatus,
      startReconnectAttempt,
    });

    expect(reconnectStore.read('session-1')).toBeNull();
    expect(reconnectStore.isManualClosed('session-1')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(updateSessionSync).not.toHaveBeenCalled();
    expect(emitSessionStatus).not.toHaveBeenCalled();
    expect(startReconnectAttempt).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('startReconnectAttemptRuntime', () => {
  it('transitions idle into scheduled and then connecting without carrying the timer', async () => {
    vi.useFakeTimers();
    const reconnectStore = createSessionReconnectStore();
    reconnectStore.write('session-1', {
      phase: 'idle',
      attempt: 2,
      nextDelayMs: 50,
    });
    const updateSessionSync = vi.fn();
    const queueReconnectTransportOpenIntent = vi.fn();
    const probeReconnectHost = vi.fn(async () => true);

    startReconnectAttemptRuntime({
      sessionId: 'session-1',
      refs: { reconnectStore },
      readSessionTransportHost: () => host,
      computeReconnectDelay: vi.fn(() => 1000),
      updateSessionSync,
      writeSessionTransportToken: vi.fn(() => null),
      queueReconnectTransportOpenIntent,
      probeReconnectHost,
    });

    expect(reconnectStore.read('session-1')).toEqual(expect.objectContaining({
      phase: 'scheduled',
      attempt: 3,
      nextDelayMs: null,
    }));

    await vi.advanceTimersByTimeAsync(50);

    const runtime = reconnectStore.read('session-1');
    expect(runtime).toEqual({
      phase: 'connecting',
      attempt: 3,
      nextDelayMs: null,
    });
    if (runtime?.phase === 'connecting') {
      expect('timer' in runtime).toBe(false);
    }
    expect(updateSessionSync).toHaveBeenCalledWith('session-1', expect.objectContaining({
      state: 'reconnecting',
    }));
    expect(queueReconnectTransportOpenIntent).toHaveBeenCalledWith('session-1', host);
    vi.useRealTimers();
  });

  it('uses the freshest direct endpoints for reconnect candidates when the cached host direct fields are stale after a network change', async () => {
    vi.useFakeTimers();
    const reconnectStore = createSessionReconnectStore();
    reconnectStore.write('session-1', {
      phase: 'idle',
      attempt: 2,
      nextDelayMs: 50,
    });
    // Cached host keeps the pre-switch direct endpoints. The device list has
    // already refreshed with the new Tailscale IP, but reconnect only sees the
    // cached host today.
    const staleCachedHost = {
      ...host,
      id: 'relay-device:dev-1:daemon-1',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      daemonHostId: 'daemon-1',
      relayHostId: 'daemon-1',
      tailscaleHost: '100.66.1.82',
      ipv4Host: '203.0.113.10',
      sessionName: 'tmux-1',
    };
    const freshestProjectedHost = {
      ...staleCachedHost,
      tailscaleHost: '100.99.2.1',
    };
    const queueReconnectTransportOpenIntent = vi.fn();
    // Only the new post-switch Tailscale IP answers the probe.
    const probeReconnectHost = vi.fn(async (bridgeHost: string) => bridgeHost === '100.99.2.1');

    startReconnectAttemptRuntime({
      sessionId: 'session-1',
      refs: { reconnectStore },
      readSessionTransportHost: () => staleCachedHost,
      computeReconnectDelay: vi.fn(() => 1000),
      updateSessionSync: vi.fn(),
      writeSessionTransportToken: vi.fn(() => null),
      queueReconnectTransportOpenIntent,
      probeReconnectHost,
      // Mirrors the session provider wiring: the freshest home projection
      // (device list) refreshes the cached host right before probing.
      refreshHostForReconnect: (cachedHost) => (
        mergeHostWithLatestProjection(cachedHost, [freshestProjectedHost])
      ),
    });
    await vi.advanceTimersByTimeAsync(50);

    // Regression guard: reconnect candidates must include the freshest direct
    // endpoints so a switched network can still reach the daemon without a
    // full app restart.
    const probed = probeReconnectHost.mock.calls.map((call) => call[0]);
    expect(probed).toContain('100.99.2.1');
    vi.useRealTimers();
  });

  it('does not queue a duplicate reconnect while phase is scheduled or connecting', () => {
    vi.useFakeTimers();
    const reconnectStore = createSessionReconnectStore();
    reconnectStore.schedule('session-1', {
      attempt: 1,
      timer: setTimeout(() => undefined, 10_000) as unknown as number,
    });
    reconnectStore.write('session-2', {
      phase: 'connecting',
      attempt: 3,
      nextDelayMs: null,
    });
    const queueReconnectTransportOpenIntent = vi.fn();

    for (const sessionId of ['session-1', 'session-2']) {
      startReconnectAttemptRuntime({
        sessionId,
        refs: { reconnectStore },
        readSessionTransportHost: () => host,
        computeReconnectDelay: vi.fn(() => 1000),
        updateSessionSync: vi.fn(),
        writeSessionTransportToken: vi.fn(() => null),
        queueReconnectTransportOpenIntent,
      });
    }

    expect(queueReconnectTransportOpenIntent).not.toHaveBeenCalled();
    expect(reconnectStore.read('session-1')).toEqual(expect.objectContaining({ phase: 'scheduled' }));
    expect(reconnectStore.read('session-2')).toEqual(expect.objectContaining({ phase: 'connecting' }));
    vi.useRealTimers();
  });
});

describe('runReconnectHostProbeAndFallback', () => {
  const fallbackHost = {
    id: 'host-1',
    createdAt: 1,
    name: 'conn',
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: 'tmux-1',
    authType: 'password' as const,
    tags: [],
    pinned: false,
  };

  function makeProbeFallbackOptions(overrides: {
    probe?: (bridgeHost: string, bridgePort: number) => Promise<boolean>;
    attempt?: number;
    scheduleReconnectRetry?: () => void;
    recordReconnectHostProbe?: (result: {
      sessionId: string;
      candidates: Array<{ bridgeHost: string; bridgePort: number; reachable: boolean }>;
    }) => void;
  } = {}) {
    const queueReconnectTransportOpenIntent = vi.fn();
    const updateSessionSync = vi.fn();
    const writeHost = vi.fn();
    const deleteRuntime = vi.fn();
    return {
      options: {
        sessionId: 'session-1',
        host: fallbackHost,
        attempt: overrides.attempt ?? 0,
        probe: overrides.probe,
        writeHost,
        updateSessionSync,
        queueReconnectTransportOpenIntent,
        refreshStore: createSessionReconnectStore(),
        isManualClosed: () => false,
        deleteRuntime,
        scheduleReconnectRetry: overrides.scheduleReconnectRetry || vi.fn(),
        recordReconnectHostProbe: overrides.recordReconnectHostProbe,
      } as Parameters<typeof runReconnectHostProbeAndFallback>[0],
      queueReconnectTransportOpenIntent,
      updateSessionSync,
      writeHost,
      deleteRuntime,
    };
  }

  it('records the current host probe without gating the first reconnect attempt', async () => {
    const probe = vi.fn(() => Promise.resolve(true));
    const { options, queueReconnectTransportOpenIntent, deleteRuntime } = makeProbeFallbackOptions({ probe, attempt: 0 });

    await runReconnectHostProbeAndFallback(options);

    expect(probe).toHaveBeenCalledWith('127.0.0.1', 3333);
    expect(queueReconnectTransportOpenIntent).toHaveBeenCalledWith('session-1', fallbackHost);
    expect(deleteRuntime).not.toHaveBeenCalled();
  });

  it('probes every fallback candidate in parallel and queues the first reachable one on retry', async () => {
    let firstStarted: (() => void) | undefined;
    const firstStartedGate = new Promise<void>((resolve) => { firstStarted = resolve; });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const probe = vi.fn(async (bridgeHost: string) => {
      if (bridgeHost === '100.66.1.82') {
        firstStarted?.();
        await firstGate; // slow candidate: stays in flight
        return true;
      }
      return false; // tailscale/ipv4 candidates are dead
    });
    const hostWithTailscale = {
      ...fallbackHost,
      bridgeHost: '127.0.0.1',
      tailscaleHost: '100.66.1.82',
      ipv4Host: '203.0.113.10',
    } as typeof fallbackHost & { tailscaleHost?: string; ipv4Host?: string };
    const { options, queueReconnectTransportOpenIntent, updateSessionSync } = makeProbeFallbackOptions({
      probe,
      attempt: 2,
    });
    const recordReconnectHostProbe = vi.fn();
    options.recordReconnectHostProbe = recordReconnectHostProbe;
    options.host = hostWithTailscale;

    const pending = runReconnectHostProbeAndFallback(options);
    // The fast (dead) candidates must be probed while the slow candidate is
    // still in flight: parallel probing, not serial.
    await firstStartedGate;
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
    releaseFirst?.();
    await pending;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(queueReconnectTransportOpenIntent).toHaveBeenCalledWith('session-1', hostWithTailscale);
    expect(updateSessionSync).not.toHaveBeenCalled();
    expect(recordReconnectHostProbe).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      candidates: expect.arrayContaining([
        { bridgeHost: '100.66.1.82', bridgePort: 3333, reachable: true },
      ]),
    }));
  });

  it('opens the real transport immediately even when every HTTP probe fails', async () => {
    const probe = vi.fn(() => Promise.resolve(false));
    const recordReconnectHostProbe = vi.fn();
    const { options, queueReconnectTransportOpenIntent, updateSessionSync, deleteRuntime } = makeProbeFallbackOptions({
      probe,
      attempt: 2,
      recordReconnectHostProbe,
    });

    await runReconnectHostProbeAndFallback(options);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(queueReconnectTransportOpenIntent).toHaveBeenCalledWith('session-1', fallbackHost);
    expect(updateSessionSync).not.toHaveBeenCalled();
    expect(recordReconnectHostProbe).toHaveBeenCalledWith({
      sessionId: 'session-1',
      candidates: [
        { bridgeHost: '127.0.0.1', bridgePort: 3333, reachable: false },
      ],
    });
    expect(deleteRuntime).not.toHaveBeenCalled();
  });

  it('does not wait for the HTTP probe before queueing the real transport open', async () => {
    let releaseProbe: (() => void) | undefined;
    const probe = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseProbe = () => resolve(false);
    }));
    const { options, queueReconnectTransportOpenIntent } = makeProbeFallbackOptions({ probe });

    const pending = runReconnectHostProbeAndFallback(options);
    await Promise.resolve();

    expect(queueReconnectTransportOpenIntent).toHaveBeenCalledWith('session-1', fallbackHost);
    releaseProbe?.();
    await pending;
  });
});

describe('active truth ownership gates', () => {
  it('connectSessionRuntime does not mutate active truth directly', () => {
    const setActiveSessionSync = vi.fn();
    const queueConnectTransportOpenIntent = vi.fn();

    connectSessionRuntime({
      sessionId: 'session-1',
      host: {
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authType: 'password',
        tags: [],
        pinned: false,
      },
      refs: {
        reconnectStore: createSessionReconnectStore(),
      },
      clearReconnectForSession: vi.fn(),
      cleanupSocket: vi.fn(),
      writeSessionTransportHost: vi.fn(),
      writeSessionTransportToken: vi.fn(),
      daemonConnection: makeDaemonConnection({ socket: null }),
      readSessionTargetKey: vi.fn(() => null),
      hasPendingSessionTransportOpen: vi.fn(() => false),
      isPendingSessionTransportOpenStale: vi.fn(() => false),
      updateSessionSync: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setActiveSessionSync,
      queueConnectTransportOpenIntent,
    } as any);

    expect(setActiveSessionSync).not.toHaveBeenCalled();
    expect(queueConnectTransportOpenIntent).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ sessionName: 'tmux-1' }),
    );
  });

  it('createSessionRuntime reuses an existing managed session without mutating active truth directly', () => {
    const connectSession = vi.fn();
    const writeSessionTransportHost = vi.fn();

    const existingSession: Session = {
      id: 'session-existing',
      hostId: 'host-1',
      connectionName: 'conn',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      daemonHostId: undefined,
      sessionName: 'tmux-1',
      authToken: undefined,
      autoCommand: undefined,
      title: 'tmux-1',
      ws: null,
      state: 'connected',
      hasUnread: false,
      customName: undefined,
      reconnectAttempt: 0,
      createdAt: 1,
    };

    const sessionId = createSessionRuntime({
      host: {
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authType: 'password',
        tags: [],
        pinned: false,
      },
      createOptions: {
        connect: false,
        sessionId: 'session-existing',
      },
      refs: {
        stateRef: {
          current: {
            sessions: [existingSession],
            activeSessionId: 'other-session',
          },
        },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        sessionBufferStoreRef: { current: { commitBuffer: vi.fn(), setBuffer: vi.fn() } },
        sessionHeadStoreRef: { current: { setHead: vi.fn() } },
      },
      runtimeDebug: vi.fn(),
      resolveSessionCacheLines: vi.fn(() => 1000),
      createSessionSync: vi.fn(),
      updateSessionSync: vi.fn(),
      writeSessionTransportHost,
      daemonConnection: makeDaemonConnection({ socket: null }),
      connectSession,
      defaultViewport: { cols: 80, rows: 24 },
    });

    expect(sessionId).toBe('session-existing');
    expect(connectSession).not.toHaveBeenCalled();
    expect(writeSessionTransportHost).toHaveBeenCalledWith(
      'session-existing',
      expect.objectContaining({
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
      }),
    );
  });

  it('updates the backend when reusing a session id for a different terminal backend', () => {
    const updateSessionSync = vi.fn();
    const existingSession: Session = {
      id: 'session-existing',
      hostId: 'host-1',
      connectionName: 'conn',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      daemonHostId: undefined,
      sessionName: 'shared',
      terminalBackend: 'tmux',
      authToken: undefined,
      autoCommand: undefined,
      title: 'shared',
      ws: null,
      state: 'closed',
      hasUnread: false,
      customName: undefined,
      reconnectAttempt: 0,
      createdAt: 1,
    };

    const sessionId = createSessionRuntime({
      host: {
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'shared',
        terminalBackend: 'herdr',
        authType: 'password',
        tags: [],
        pinned: false,
      },
      createOptions: {
        connect: false,
        sessionId: 'session-existing',
      },
      refs: {
        stateRef: {
          current: {
            sessions: [existingSession],
            activeSessionId: 'session-existing',
          },
        },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        sessionBufferStoreRef: { current: { commitBuffer: vi.fn(), setBuffer: vi.fn() } },
        sessionHeadStoreRef: { current: { setHead: vi.fn() } },
      },
      runtimeDebug: vi.fn(),
      resolveSessionCacheLines: vi.fn(() => 1000),
      createSessionSync: vi.fn(),
      updateSessionSync,
      writeSessionTransportHost: vi.fn(),
      daemonConnection: makeDaemonConnection({ socket: null }),
      connectSession: vi.fn(),
      defaultViewport: { cols: 80, rows: 24 },
    });

    expect(sessionId).toBe('session-existing');
    expect(updateSessionSync).toHaveBeenCalledWith(
      'session-existing',
      expect.objectContaining({ terminalBackend: 'herdr' }),
    );
  });

  it('createSessionRuntime reuses a stale direct session when a relay daemon target resolves the same endpoint owner', () => {
    const connectSession = vi.fn();
    const writeSessionTransportHost = vi.fn();
    const updateSessionSync = vi.fn();

    const existingSession: Session = {
      id: 'session-existing',
      hostId: 'host-direct',
      connectionName: '100.66.1.82',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      daemonHostId: undefined,
      sessionName: 'rcc',
      authToken: 'wterm-4123456',
      autoCommand: undefined,
      title: 'rcc',
      ws: null,
      state: 'connected',
      hasUnread: false,
      customName: undefined,
      reconnectAttempt: 0,
      createdAt: 1,
    };

    const sessionId = createSessionRuntime({
      host: {
        id: 'host-relay',
        createdAt: 2,
        name: 'Mac Studio · rcc',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        sessionName: 'rcc',
        authToken: 'wterm-4123456',
        transportMode: 'auto',
        relayEndpointCandidates: [{
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
          authRequired: true,
          lastSeenAt: '2026-07-17T00:00:00.000Z',
        }],
        authType: 'password',
        tags: [],
        pinned: false,
      },
      createOptions: {
        connect: false,
        sessionId: 'session-existing',
      },
      refs: {
        stateRef: {
          current: {
            sessions: [existingSession],
            activeSessionId: 'session-existing',
          },
        },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        sessionBufferStoreRef: { current: { commitBuffer: vi.fn(), setBuffer: vi.fn() } },
        sessionHeadStoreRef: { current: { setHead: vi.fn() } },
      },
      runtimeDebug: vi.fn(),
      resolveSessionCacheLines: vi.fn(() => 1000),
      createSessionSync: vi.fn(),
      updateSessionSync,
      writeSessionTransportHost,
      daemonConnection: makeDaemonConnection({ socket: null }),
      connectSession,
      defaultViewport: { cols: 80, rows: 24 },
    });

    expect(sessionId).toBe('session-existing');
    expect(connectSession).not.toHaveBeenCalled();
    expect(writeSessionTransportHost).toHaveBeenCalledWith(
      'session-existing',
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        transportMode: 'auto',
        relayEndpointCandidates: [expect.objectContaining({
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
        })],
      }),
    );
    expect(updateSessionSync).toHaveBeenCalledWith(
      'session-existing',
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        sessionName: 'rcc',
      }),
    );
  });

  it('createSessionRuntime restores transport identity for a closed local shell without opening websocket', () => {
    const connectSession = vi.fn();
    const writeSessionTransportHost = vi.fn();

    const sessionId = createSessionRuntime({
      host: {
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authType: 'password',
        tags: [],
        pinned: false,
      },
      createOptions: {
        connect: false,
        sessionId: 'session-restored',
      },
      refs: {
        stateRef: {
          current: {
            sessions: [],
            activeSessionId: null,
          },
        },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        sessionBufferStoreRef: { current: { commitBuffer: vi.fn(), setBuffer: vi.fn() } },
        sessionHeadStoreRef: { current: { setHead: vi.fn() } },
      },
      runtimeDebug: vi.fn(),
      resolveSessionCacheLines: vi.fn(() => 1000),
      createSessionSync: vi.fn(),
      updateSessionSync: vi.fn(),
      writeSessionTransportHost,
      daemonConnection: makeDaemonConnection({ socket: null }),
      connectSession,
      defaultViewport: { cols: 80, rows: 24 },
    });

    expect(sessionId).toBe('session-restored');
    expect(connectSession).not.toHaveBeenCalled();
    expect(writeSessionTransportHost).toHaveBeenCalledWith(
      'session-restored',
      expect.objectContaining({
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
      }),
    );
  });

  it('reopens transport when reusing a managed session whose label is connected but transport truth is missing', () => {
    const connectSession = vi.fn();

    const existingSession: Session = {
      id: 'session-existing',
      hostId: 'host-1',
      connectionName: 'conn',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      daemonHostId: undefined,
      sessionName: 'tmux-1',
      authToken: undefined,
      autoCommand: undefined,
      title: 'tmux-1',
      ws: null,
      state: 'connected',
      hasUnread: false,
      customName: undefined,
      reconnectAttempt: 0,
      createdAt: 1,
    };

    const sessionId = createSessionRuntime({
      host: {
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authType: 'password',
        tags: [],
        pinned: false,
      },
      createOptions: {
        connect: true,
        sessionId: 'session-existing',
      },
      refs: {
        stateRef: {
          current: {
            sessions: [existingSession],
            activeSessionId: 'session-existing',
          },
        },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        sessionBufferStoreRef: { current: { commitBuffer: vi.fn(), setBuffer: vi.fn() } },
        sessionHeadStoreRef: { current: { setHead: vi.fn() } },
      },
      runtimeDebug: vi.fn(),
      resolveSessionCacheLines: vi.fn(() => 1000),
      createSessionSync: vi.fn(),
      updateSessionSync: vi.fn(),
      daemonConnection: makeDaemonConnection({ socket: null }),
      connectSession,
      defaultViewport: { cols: 80, rows: 24 },
    });

    expect(sessionId).toBe('session-existing');
    expect(connectSession).toHaveBeenCalledWith(
      'session-existing',
      expect.objectContaining({
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
      }),
    );
  });

  it('does not reopen an existing managed session when its mux target socket is open', () => {
    const connectSession = vi.fn();
    const targetSocket = { readyState: WebSocket.OPEN } as any;

    const existingSession: Session = {
      id: 'session-existing',
      hostId: 'host-1',
      connectionName: 'conn',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      daemonHostId: undefined,
      sessionName: 'tmux-1',
      authToken: undefined,
      autoCommand: undefined,
      title: 'tmux-1',
      ws: null,
      state: 'connected',
      hasUnread: false,
      customName: undefined,
      reconnectAttempt: 0,
      createdAt: 1,
    };

    const sessionId = createSessionRuntime({
      host: {
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authType: 'password',
        tags: [],
        pinned: false,
      },
      createOptions: {
        connect: true,
        sessionId: 'session-existing',
      },
      refs: {
        stateRef: {
          current: {
            sessions: [existingSession],
            activeSessionId: 'session-existing',
          },
        },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        sessionBufferStoreRef: { current: { commitBuffer: vi.fn(), setBuffer: vi.fn() } },
        sessionHeadStoreRef: { current: { setHead: vi.fn() } },
      },
      runtimeDebug: vi.fn(),
      resolveSessionCacheLines: vi.fn(() => 1000),
      createSessionSync: vi.fn(),
      updateSessionSync: vi.fn(),
      daemonConnection: makeDaemonConnection({ socket: targetSocket, channelState: 'open' }),
      connectSession,
      defaultViewport: { cols: 80, rows: 24 },
    } as any);

    expect(sessionId).toBe('session-existing');
    expect(connectSession).not.toHaveBeenCalled();
  });

  it('reopens an existing managed session channel when its mux target remains open', () => {
    const connectSession = vi.fn();
    const targetSocket = { readyState: WebSocket.OPEN } as any;
    const existingSession: Session = {
      id: 'session-existing',
      hostId: 'host-1',
      connectionName: 'conn',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      daemonHostId: undefined,
      sessionName: 'tmux-1',
      authToken: undefined,
      autoCommand: undefined,
      title: 'tmux-1',
      ws: null,
      state: 'idle',
      hasUnread: false,
      customName: undefined,
      reconnectAttempt: 0,
      createdAt: 1,
    };

    const sessionId = createSessionRuntime({
      host: {
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authType: 'password',
        tags: [],
        pinned: false,
      },
      createOptions: {
        connect: true,
        sessionId: 'session-existing',
      },
      refs: {
        stateRef: {
          current: {
            sessions: [existingSession],
            activeSessionId: 'session-existing',
          },
        },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        sessionBufferStoreRef: { current: { commitBuffer: vi.fn(), setBuffer: vi.fn() } },
        sessionHeadStoreRef: { current: { setHead: vi.fn() } },
      },
      runtimeDebug: vi.fn(),
      resolveSessionCacheLines: vi.fn(() => 1000),
      createSessionSync: vi.fn(),
      updateSessionSync: vi.fn(),
      daemonConnection: makeDaemonConnection({ socket: targetSocket, channelState: 'closed' }),
      connectSession,
      defaultViewport: { cols: 80, rows: 24 },
    } as any);

    expect(sessionId).toBe('session-existing');
    expect(connectSession).toHaveBeenCalledWith('session-existing', expect.objectContaining({
      sessionName: 'tmux-1',
    }));
  });
});

describe('session transport reuse runtime gates', () => {
  it('schedules the initial non-empty buffer for the shared render projection', () => {
    const commitBuffer = vi.fn();
    const scheduleSessionRenderCommit = vi.fn();
    const sessionId = createSessionRuntime({
      host,
      createOptions: {
        connect: false,
        sessionId: 'session-cached-preview',
        buffer: {
          lines: [['cached-row'] as any],
          startIndex: 0,
          endIndex: 1,
          bufferHeadStartIndex: 0,
          bufferTailEndIndex: 1,
          cols: 80,
          rows: 24,
          revision: 3,
          cacheLines: 1000,
          gapRanges: [],
          cursor: null,
        } as any,
      },
      refs: {
        stateRef: { current: { sessions: [], activeSessionId: null } },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        sessionBufferStoreRef: { current: { commitBuffer, setBuffer: vi.fn() } },
        sessionHeadStoreRef: { current: { setHead: vi.fn() } },
      },
      runtimeDebug: vi.fn(),
      resolveSessionCacheLines: vi.fn(() => 1000),
      scheduleSessionRenderCommit,
      createSessionSync: vi.fn(),
      updateSessionSync: vi.fn(),
      daemonConnection: makeDaemonConnection({ socket: null }),
      connectSession: vi.fn(),
      defaultViewport: { cols: 80, rows: 24 },
    });

    expect(sessionId).toBe('session-cached-preview');
    expect(commitBuffer).toHaveBeenCalledWith(sessionId, expect.objectContaining({ revision: 3 }));
    expect(scheduleSessionRenderCommit).toHaveBeenCalledWith(sessionId);
  });

  it('connectSessionRuntime reuses an open same-target session transport without cleanup or new open intent', () => {
    const cleanupSocket = vi.fn();
    const queueConnectTransportOpenIntent = vi.fn();

    connectSessionRuntime({
      sessionId: 'session-1',
      host,
      refs: {
        reconnectStore: createSessionReconnectStore(),
      },
      clearReconnectForSession: vi.fn(),
      cleanupSocket,
      writeSessionTransportHost: vi.fn(),
      writeSessionTransportToken: vi.fn(),
      updateSessionSync: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      queueConnectTransportOpenIntent,
      daemonConnection: makeDaemonConnection({ socket: { readyState: WebSocket.OPEN } as any }),
      readSessionTargetKey: () => targetKey,
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
    } as any);

    expect(cleanupSocket).not.toHaveBeenCalled();
    expect(queueConnectTransportOpenIntent).not.toHaveBeenCalled();
  });

  it('connectSessionRuntime reuses an open same-target mux target socket when the legacy session socket is empty', () => {
    const cleanupSocket = vi.fn();
    const queueConnectTransportOpenIntent = vi.fn();
    const targetSocket = { readyState: WebSocket.OPEN } as any;

    connectSessionRuntime({
      sessionId: 'session-1',
      host,
      refs: {
        reconnectStore: createSessionReconnectStore(),
      },
      clearReconnectForSession: vi.fn(),
      cleanupSocket,
      writeSessionTransportHost: vi.fn(),
      writeSessionTransportToken: vi.fn(),
      updateSessionSync: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      queueConnectTransportOpenIntent,
      daemonConnection: makeDaemonConnection({ socket: targetSocket, channelState: 'open' }),
      readSessionTargetKey: () => targetKey,
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
    } as any);

    expect(cleanupSocket).not.toHaveBeenCalled();
    expect(queueConnectTransportOpenIntent).not.toHaveBeenCalled();
  });

  it('connectSessionRuntime reopens a closed mux channel without replacing its open target socket', () => {
    const cleanupSocket = vi.fn();
    const queueConnectTransportOpenIntent = vi.fn();
    const targetSocket = { readyState: WebSocket.OPEN } as any;

    connectSessionRuntime({
      sessionId: 'session-1',
      host,
      refs: {
        reconnectStore: createSessionReconnectStore(),
      },
      clearReconnectForSession: vi.fn(),
      cleanupSocket,
      writeSessionTransportHost: vi.fn(),
      writeSessionTransportToken: vi.fn(),
      updateSessionSync: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      queueConnectTransportOpenIntent,
      daemonConnection: makeDaemonConnection({ socket: targetSocket, channelState: 'closed' }),
      readSessionTargetKey: () => targetKey,
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
    } as any);

    expect(cleanupSocket).toHaveBeenCalledWith('session-1', false);
    expect(queueConnectTransportOpenIntent).toHaveBeenCalledWith('session-1', host);
  });

  it('connectSessionRuntime waits for a connecting same-target transport with a fresh pending open', () => {
    const cleanupSocket = vi.fn();
    const queueConnectTransportOpenIntent = vi.fn();

    connectSessionRuntime({
      sessionId: 'session-1',
      host,
      refs: {
        reconnectStore: createSessionReconnectStore(),
      },
      clearReconnectForSession: vi.fn(),
      cleanupSocket,
      writeSessionTransportHost: vi.fn(),
      writeSessionTransportToken: vi.fn(),
      updateSessionSync: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      queueConnectTransportOpenIntent,
      daemonConnection: makeDaemonConnection({ socket: { readyState: WebSocket.CONNECTING } as any }),
      readSessionTargetKey: () => targetKey,
      hasPendingSessionTransportOpen: () => true,
      isPendingSessionTransportOpenStale: () => false,
    } as any);

    expect(cleanupSocket).not.toHaveBeenCalled();
    expect(queueConnectTransportOpenIntent).not.toHaveBeenCalled();
  });

  it('reconnectSessionRuntime reuses an open same-target socket without cleanup or forced reconnect', () => {
    const cleanupSocket = vi.fn();
    const scheduleReconnect = vi.fn();

    reconnectSessionRuntime({
      sessionId: 'session-1',
      refs: {
        stateRef: {
          current: {
            sessions: [{
              id: 'session-1',
              hostId: 'host-1',
              connectionName: 'conn',
              bridgeHost: '127.0.0.1',
              bridgePort: 3333,
              sessionName: 'tmux-1',
              authToken: undefined,
              autoCommand: undefined,
              createdAt: 1,
            } as Session],
            activeSessionId: 'session-1',
          },
        },
        reconnectStore: createSessionReconnectStore(),
      },
      clearReconnectForSession: vi.fn(),
      readSessionTransportHost: () => host,
      readSessionTargetKey: () => targetKey,
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1'] }),
      daemonConnection: makeDaemonConnection({ socket: { readyState: WebSocket.OPEN } as any }),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      runtimeDebug: vi.fn(),
      cleanupSocket,
      writeSessionTransportHost: vi.fn(),
      updateSessionSync: vi.fn(),
      scheduleReconnect,
    } as any);

    expect(cleanupSocket).not.toHaveBeenCalled();
    expect(scheduleReconnect).not.toHaveBeenCalled();
  });

  it('reconnectSessionRuntime reuses an open same-target mux target socket when the legacy session socket is empty', () => {
    const cleanupSocket = vi.fn();
    const scheduleReconnect = vi.fn();
    const targetSocket = { readyState: WebSocket.OPEN } as any;

    reconnectSessionRuntime({
      sessionId: 'session-1',
      refs: {
        stateRef: {
          current: {
            sessions: [{
              id: 'session-1',
              hostId: 'host-1',
              connectionName: 'conn',
              bridgeHost: '127.0.0.1',
              bridgePort: 3333,
              sessionName: 'tmux-1',
              authToken: undefined,
              autoCommand: undefined,
              createdAt: 1,
            } as Session],
            activeSessionId: 'session-1',
          },
        },
        reconnectStore: createSessionReconnectStore(),
      },
      clearReconnectForSession: vi.fn(),
      readSessionTransportHost: () => host,
      readSessionTargetKey: () => targetKey,
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1', 'session-2'] }),
      daemonConnection: makeDaemonConnection({ socket: targetSocket, channelState: 'open' }),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      runtimeDebug: vi.fn(),
      cleanupSocket,
      writeSessionTransportHost: vi.fn(),
      updateSessionSync: vi.fn(),
      scheduleReconnect,
    } as any);

    expect(cleanupSocket).not.toHaveBeenCalled();
    expect(scheduleReconnect).not.toHaveBeenCalled();
  });

  it('reconnectSessionRuntime reopens a closed mux channel on the existing target transport', () => {
    const cleanupSocket = vi.fn();
    const scheduleReconnect = vi.fn();
    const targetSocket = { readyState: WebSocket.OPEN } as any;

    reconnectSessionRuntime({
      sessionId: 'session-1',
      refs: {
        stateRef: {
          current: {
            sessions: [{
              id: 'session-1',
              hostId: 'host-1',
              connectionName: 'conn',
              bridgeHost: '127.0.0.1',
              bridgePort: 3333,
              sessionName: 'tmux-1',
              authToken: undefined,
              autoCommand: undefined,
              createdAt: 1,
            } as Session],
            activeSessionId: 'session-1',
          },
        },
        reconnectStore: createSessionReconnectStore(),
      },
      clearReconnectForSession: vi.fn(),
      readSessionTransportHost: () => host,
      readSessionTargetKey: () => targetKey,
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1', 'session-2'] }),
      daemonConnection: makeDaemonConnection({ socket: targetSocket, channelState: 'closed' }),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      runtimeDebug: vi.fn(),
      cleanupSocket,
      writeSessionTransportHost: vi.fn(),
      updateSessionSync: vi.fn(),
      scheduleReconnect,
    } as any);

    expect(cleanupSocket).toHaveBeenCalledWith('session-1', false);
    expect(scheduleReconnect).toHaveBeenCalledWith('session-1', 'manual reconnect', true, {
      immediate: true,
      resetAttempt: true,
      force: true,
    });
  });

  it('reconnectSessionRuntime clears stale pending open bookkeeping and rebuilds the same target', () => {
    const cleanupSocket = vi.fn();
    const cleanupControlSocket = vi.fn();
    const scheduleReconnect = vi.fn();
    const pendingStore = new Map<string, any>([
      ['session-1', { sessionId: 'session-1', createdAt: 1 }],
    ]);

    reconnectSessionRuntime({
      sessionId: 'session-1',
      refs: {
        stateRef: {
          current: {
            sessions: [{
              id: 'session-1',
              hostId: 'host-1',
              connectionName: 'conn',
              bridgeHost: '127.0.0.1',
              bridgePort: 3333,
              sessionName: 'tmux-1',
              authToken: undefined,
              autoCommand: undefined,
              createdAt: 1,
            } as Session],
            activeSessionId: 'session-1',
          },
        },
        reconnectStore: createSessionReconnectStore(),
        pendingSessionTransportOpenIntentsRef: { current: pendingStore },
      },
      clearReconnectForSession: vi.fn(),
      readSessionTransportHost: () => host,
      readSessionTargetKey: () => targetKey,
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1'] }),
      daemonConnection: makeDaemonConnection({ socket: { readyState: WebSocket.CONNECTING } as any }),
      hasPendingSessionTransportOpen: () => true,
      isPendingSessionTransportOpenStale: () => true,
      runtimeDebug: vi.fn(),
      cleanupSocket,
      cleanupControlSocket,
      writeSessionTransportHost: vi.fn(),
      updateSessionSync: vi.fn(),
      scheduleReconnect,
    } as any);

    expect(pendingStore.has('session-1')).toBe(false);
    expect(cleanupControlSocket).toHaveBeenCalledWith('session-1', true);
    expect(cleanupSocket).toHaveBeenCalledWith('session-1', false);
    expect(scheduleReconnect).toHaveBeenCalledWith('session-1', 'manual reconnect', true, {
      immediate: true,
      resetAttempt: true,
      force: true,
    });
  });

  it('reconnectSessionRuntime preserves the automatic retry budget during lifecycle recovery', () => {
    const clearReconnectForSession = vi.fn();
    const scheduleReconnect = vi.fn();
    const reconnectStore = createSessionReconnectStore();
    reconnectStore.write('session-1', {
      phase: 'idle',
      attempt: 11,
      nextDelayMs: 1200,
    });

    reconnectSessionRuntime({
      sessionId: 'session-1',
      reconnectOptions: { preserveAttempt: true },
      refs: {
        stateRef: {
          current: {
            sessions: [{
              id: 'session-1',
              hostId: 'host-1',
              connectionName: 'conn',
              bridgeHost: '127.0.0.1',
              bridgePort: 3333,
              sessionName: 'tmux-1',
              authToken: undefined,
              autoCommand: undefined,
              createdAt: 1,
            } as Session],
            activeSessionId: 'session-1',
          },
        },
        reconnectStore,
      },
      clearReconnectForSession,
      readSessionTransportHost: () => host,
      readSessionTargetKey: () => targetKey,
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1'] }),
      daemonConnection: makeDaemonConnection({ socket: { readyState: WebSocket.CLOSED } as any }),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      runtimeDebug: vi.fn(),
      cleanupSocket: vi.fn(),
      writeSessionTransportHost: vi.fn(),
      updateSessionSync: vi.fn(),
      scheduleReconnect,
    } as any);

    expect(clearReconnectForSession).not.toHaveBeenCalled();
    expect(reconnectStore.read('session-1')?.attempt).toBe(11);
    expect(scheduleReconnect).toHaveBeenCalledWith('session-1', 'automatic reconnect', true, {
      immediate: true,
      resetAttempt: false,
      force: true,
    });
  });

  it('reconnectSessionRuntime still rebuilds a closed same-target socket', () => {
    const cleanupSocket = vi.fn();
    const scheduleReconnect = vi.fn();

    reconnectSessionRuntime({
      sessionId: 'session-1',
      refs: {
        stateRef: {
          current: {
            sessions: [{
              id: 'session-1',
              hostId: 'host-1',
              connectionName: 'conn',
              bridgeHost: '127.0.0.1',
              bridgePort: 3333,
              sessionName: 'tmux-1',
              authToken: undefined,
              autoCommand: undefined,
              createdAt: 1,
            } as Session],
            activeSessionId: 'session-1',
          },
        },
        reconnectStore: createSessionReconnectStore(),
      },
      clearReconnectForSession: vi.fn(),
      readSessionTransportHost: () => host,
      readSessionTargetKey: () => targetKey,
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1'] }),
      daemonConnection: makeDaemonConnection({ socket: { readyState: WebSocket.CLOSED } as any }),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      runtimeDebug: vi.fn(),
      cleanupSocket,
      writeSessionTransportHost: vi.fn(),
      updateSessionSync: vi.fn(),
      scheduleReconnect,
    } as any);

    expect(cleanupSocket).toHaveBeenCalledWith('session-1', false);
    expect(scheduleReconnect).toHaveBeenCalledWith('session-1', 'manual reconnect', true, {
      immediate: true,
      resetAttempt: true,
      force: true,
    });
  });

  it('reconnectSessionRuntime rebuilds an opening mux channel when the physical target socket is gone', () => {
    const cleanupSocket = vi.fn();
    const scheduleReconnect = vi.fn();

    reconnectSessionRuntime({
      sessionId: 'session-1',
      refs: {
        stateRef: {
          current: {
            sessions: [{
              id: 'session-1',
              hostId: 'host-1',
              connectionName: 'conn',
              bridgeHost: '127.0.0.1',
              bridgePort: 3333,
              sessionName: 'tmux-1',
              authToken: undefined,
              autoCommand: undefined,
              createdAt: 1,
            } as Session],
            activeSessionId: 'session-1',
          },
        },
        reconnectStore: createSessionReconnectStore(),
      },
      clearReconnectForSession: vi.fn(),
      readSessionTransportHost: () => host,
      readSessionTargetKey: () => targetKey,
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1'] }),
      daemonConnection: makeDaemonConnection({ socket: null, terminalSocket: null, channelState: 'opening' }),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      runtimeDebug: vi.fn(),
      cleanupSocket,
      writeSessionTransportHost: vi.fn(),
      updateSessionSync: vi.fn(),
      scheduleReconnect,
    } as any);

    expect(cleanupSocket).toHaveBeenCalledWith('session-1', false);
    expect(scheduleReconnect).toHaveBeenCalledWith('session-1', 'manual reconnect', true, {
      immediate: true,
      resetAttempt: true,
      force: true,
    });
  });

});

describe('scheduleReconnectRuntime max attempts', () => {
  it('stops automatic retries after MAX_RECONNECT_ATTEMPTS consecutive failures instead of looping forever', async () => {
    vi.useFakeTimers();
    try {
      const reconnectStore = createSessionReconnectStore();
      reconnectStore.write('session-1', {
        phase: 'idle',
        attempt: 12, // >= MAX_RECONNECT_ATTEMPTS
        nextDelayMs: null,
      });
      const updateSessionSync = vi.fn();
      const emitSessionStatus = vi.fn();
      const startReconnectAttempt = vi.fn();

      scheduleReconnectRuntime({
        sessionId: 'session-1',
        message: 'transport down',
        retryable: true,
        refs: {
          reconnectStore,
          stateRef: { current: { sessions: [], activeSessionId: 'session-1' } },
        },
        readSessionTransportHost: () => host,
        shouldAutoReconnectSessionFn: () => true,
        updateSessionSync,
        emitSessionStatus,
        startReconnectAttempt,
      });

      // Attempt budget exhausted: reconnect runtime is removed, no new
      // attempt is scheduled, and the user sees an explicit error.
      expect(reconnectStore.read('session-1')).toBeNull();
      expect(startReconnectAttempt).not.toHaveBeenCalled();
      expect(emitSessionStatus).toHaveBeenCalledWith('session-1', 'error', '自动重连失败次数过多，请手动重连');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('renameRemoteSessionRuntime', () => {
  it('migrates the remote tmux identity without overwriting a local custom tab name', () => {
    const updateSessionSync = vi.fn();
    renameRemoteSessionRuntime({
      sessionId: 'session-1',
      name: 'renamed-tmux',
      sessions: [{
        id: 'session-1',
        hostId: 'host-1',
        connectionName: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'old-tmux',
        title: 'old title',
        customName: 'My Local Tab',
        ws: null,
        state: 'connected',
        hasUnread: false,
        createdAt: 1,
      }],
      updateSessionSync,
    });

    expect(updateSessionSync).toHaveBeenCalledWith('session-1', {
      sessionName: 'renamed-tmux',
      customName: 'My Local Tab',
      title: 'My Local Tab',
    });
  });

  it('keeps generated display names in sync across consecutive remote renames and refreshes the reconnect host', () => {
    const updateSessionSync = vi.fn();
    const writeSessionTransportHost = vi.fn();
    const writeSessionTerminalChannelName = vi.fn();
    renameRemoteSessionRuntime({
      sessionId: 'session-1',
      name: 'second-tmux',
      sessions: [{
        id: 'session-1',
        hostId: 'host-1',
        connectionName: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'first-tmux',
        title: 'first-tmux',
        customName: 'first-tmux',
        ws: null,
        state: 'connected',
        hasUnread: false,
        createdAt: 1,
      }],
      updateSessionSync,
      readSessionTransportHost: () => ({
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'first-tmux',
        authType: 'password',
        tags: [],
        pinned: false,
      }),
      writeSessionTransportHost,
      writeSessionTerminalChannelName,
    });

    expect(updateSessionSync).toHaveBeenCalledWith('session-1', {
      sessionName: 'second-tmux',
      customName: 'second-tmux',
      title: 'second-tmux',
    });
    expect(writeSessionTransportHost).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ sessionName: 'second-tmux' }),
    );
    expect(writeSessionTerminalChannelName).toHaveBeenCalledWith('session-1', 'second-tmux');
  });
});
