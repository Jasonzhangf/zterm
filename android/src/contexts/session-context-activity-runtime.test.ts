import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_TRANSPORT_KEEPALIVE_GRACE_MS,
  ensureActiveSessionFreshRuntime,
  resolveSessionTransportKeepaliveGrace,
} from './session-context-activity-runtime';

function createBaseOptions(overrides: Partial<Parameters<typeof ensureActiveSessionFreshRuntime>[0]> = {}) {
  const stateRef = {
    current: {
      sessions: [{
        id: 'session-1',
        state: 'connected',
      } as any],
      activeSessionId: 'session-1',
      liveSessionIds: [],
    },
  };
  const options: Parameters<typeof ensureActiveSessionFreshRuntime>[0] = {
    refreshOptions: {
      sessionId: 'session-1',
      source: 'active-reentry',
      allowReconnectIfUnavailable: true,
    },
    refs: {
      stateRef,
      pendingResumeTailRefreshRef: { current: new Set<string>() },
      lastActiveReentryAtRef: { current: new Map<string, number>() },
      lastConnectedBaselineAtRef: { current: new Map<string, number>() },
      connectedBaselineBurstGuardRef: { current: new Set<string>() },
      lastServerActivityAtRef: { current: new Map<string, number>() },
      lastHeadRequestAtRef: { current: new Map<string, number>() },
      staleTransportProbeAtRef: { current: new Map<string, number>() },
      reconnectRuntimesRef: { current: new Map<string, { connecting: boolean; timer: number | null }>() },
    },
    readSessionTransportRuntime: () => ({ targetKey: '127.0.0.1:3333:' }),
    readSessionTargetRuntime: () => ({ sessionIds: ['session-1'] }),
    readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
    isReconnectInFlight: () => false,
    hasPendingSessionTransportOpen: () => false,
    isPendingSessionTransportOpenStale: () => false,
    isSessionTransportActivityStale: () => false,
    runtimeDebug: vi.fn(),
    updateSessionSync: vi.fn(),
    readSessionBufferSnapshot: () => ({ revision: 1, startIndex: 0, endIndex: 24 }),
    resetSessionTransportPullBookkeeping: vi.fn(),
    requestSessionBufferHead: vi.fn(() => true),
    resolveTerminalRefreshCadence: () => ({ headTickMs: 500, headStalePingMs: 500, pullRequestStaleMs: 1000 }),
    reconnectSession: vi.fn(),
    ...overrides,
  };
  return options;
}

describe('ensureActiveSessionFreshRuntime', () => {
  it('resolves keepalive grace from recent server activity or connected baseline', () => {
    const refs = createBaseOptions().refs;
    refs.lastServerActivityAtRef.current.set('session-1', 10_000);
    refs.lastConnectedBaselineAtRef.current.set('session-1', 20_000);

    expect(resolveSessionTransportKeepaliveGrace({
      sessionId: 'session-1',
      refs,
      now: 20_000 + SESSION_TRANSPORT_KEEPALIVE_GRACE_MS - 1,
    })).toEqual({
      active: true,
      lastAliveAt: 20_000,
      ageMs: SESSION_TRANSPORT_KEEPALIVE_GRACE_MS - 1,
      graceMs: SESSION_TRANSPORT_KEEPALIVE_GRACE_MS,
    });
    expect(resolveSessionTransportKeepaliveGrace({
      sessionId: 'session-1',
      refs,
      now: 20_000 + SESSION_TRANSPORT_KEEPALIVE_GRACE_MS,
    }).active).toBe(false);
  });

  it('requests head on the existing open socket for active reentry', () => {
    const ws = { readyState: WebSocket.OPEN } as any;
    const requestSessionBufferHead = vi.fn(() => true);
    const reconnectSession = vi.fn();
    const resetSessionTransportPullBookkeeping = vi.fn();
    const options = createBaseOptions({
      readSessionTransportSocket: () => ws,
      requestSessionBufferHead,
      reconnectSession,
      resetSessionTransportPullBookkeeping,
    });

    expect(ensureActiveSessionFreshRuntime(options)).toBe(true);
    expect(resetSessionTransportPullBookkeeping).toHaveBeenCalledWith('session-1', 'active-reentry');
    expect(requestSessionBufferHead).toHaveBeenCalledWith('session-1', ws, { force: undefined });
    expect(reconnectSession).not.toHaveBeenCalled();
  });

  it('marks resume-tail on active reentry even when an old local buffer exists', () => {
    const ws = { readyState: WebSocket.OPEN } as any;
    const refs = createBaseOptions().refs;
    const options = createBaseOptions({
      refreshOptions: {
        sessionId: 'session-1',
        source: 'active-reentry',
        forceHead: true,
        markResumeTail: true,
        allowReconnectIfUnavailable: true,
      },
      refs,
      readSessionTransportSocket: () => ws,
      readSessionBufferSnapshot: () => ({ revision: 9, startIndex: 100, endIndex: 124 }),
      requestSessionBufferHead: vi.fn(() => true),
    });

    expect(ensureActiveSessionFreshRuntime(options)).toBe(true);
    expect(refs.pendingResumeTailRefreshRef.current.has('session-1')).toBe(true);
  });

  it('does not let active reentry guards suppress an explicit resume forced head request', () => {
    const now = 2000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const ws = { readyState: WebSocket.OPEN } as any;
    const requestSessionBufferHead = vi.fn(() => true);
    const reconnectSession = vi.fn();
    const refs = createBaseOptions().refs;
    refs.lastActiveReentryAtRef.current.set('session-1', now - 100);
    refs.connectedBaselineBurstGuardRef.current.add('session-1');
    const options = createBaseOptions({
      refreshOptions: {
        sessionId: 'session-1',
        source: 'explicit-resume',
        forceHead: true,
        markResumeTail: true,
        allowReconnectIfUnavailable: true,
      },
      refs,
      readSessionTransportSocket: () => ws,
      requestSessionBufferHead,
      reconnectSession,
    });

    try {
      expect(ensureActiveSessionFreshRuntime(options)).toBe(true);
      expect(requestSessionBufferHead).toHaveBeenCalledWith('session-1', ws, { force: true });
      expect(refs.pendingResumeTailRefreshRef.current.has('session-1')).toBe(true);
      expect(refs.connectedBaselineBurstGuardRef.current.has('session-1')).toBe(true);
      expect(reconnectSession).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('waits for a connecting same-session socket instead of reconnecting', () => {
    const reconnectSession = vi.fn();
    const requestSessionBufferHead = vi.fn();
    const options = createBaseOptions({
      readSessionTransportSocket: () => ({ readyState: WebSocket.CONNECTING } as any),
      reconnectSession,
      requestSessionBufferHead,
    });

    expect(ensureActiveSessionFreshRuntime(options)).toBe(false);
    expect(requestSessionBufferHead).not.toHaveBeenCalled();
    expect(reconnectSession).not.toHaveBeenCalled();
  });

  it('reconnects explicit resume when pending transport-open bookkeeping is stale', () => {
    const reconnectSession = vi.fn();
    const updateSessionSync = vi.fn();
    const options = createBaseOptions({
      refreshOptions: {
        sessionId: 'session-1',
        source: 'explicit-resume',
        allowReconnectIfUnavailable: true,
      },
      readSessionTransportSocket: () => null,
      hasPendingSessionTransportOpen: () => true,
      isPendingSessionTransportOpenStale: () => true,
      reconnectSession,
      updateSessionSync,
      refs: {
        ...createBaseOptions().refs,
        stateRef: {
          current: {
            sessions: [{ id: 'session-1', state: 'reconnecting' } as any],
            activeSessionId: 'session-1',
            liveSessionIds: [],
          },
        },
      },
    });

    expect(ensureActiveSessionFreshRuntime(options)).toBe(true);
    expect(updateSessionSync).not.toHaveBeenCalledWith('session-1', {
      state: 'reconnecting',
      lastError: 'Waiting for existing websocket open',
    });
    expect(reconnectSession).toHaveBeenCalledWith('session-1');
  });

  it('waits for fresh pending transport open instead of starting a second reconnect', () => {
    const reconnectSession = vi.fn();
    const updateSessionSync = vi.fn();
    const options = createBaseOptions({
      refreshOptions: {
        sessionId: 'session-1',
        source: 'explicit-resume',
        allowReconnectIfUnavailable: true,
      },
      readSessionTransportSocket: () => null,
      hasPendingSessionTransportOpen: () => true,
      isPendingSessionTransportOpenStale: () => false,
      reconnectSession,
      updateSessionSync,
      refs: {
        ...createBaseOptions().refs,
        stateRef: {
          current: {
            sessions: [{ id: 'session-1', state: 'reconnecting' } as any],
            activeSessionId: 'session-1',
            liveSessionIds: [],
          },
        },
      },
    });

    expect(ensureActiveSessionFreshRuntime(options)).toBe(false);
    expect(updateSessionSync).toHaveBeenCalledWith('session-1', {
      state: 'reconnecting',
      lastError: 'Waiting for existing websocket open',
    });
    expect(reconnectSession).not.toHaveBeenCalled();
  });

  it('does not reconnect closed sessions from passive active reentry', () => {
    const reconnectSession = vi.fn();
    const options = createBaseOptions({
      readSessionTransportSocket: () => null,
      reconnectSession,
      refs: {
        ...createBaseOptions().refs,
        stateRef: {
          current: {
            sessions: [{ id: 'session-1', state: 'closed' } as any],
            activeSessionId: 'session-1',
            liveSessionIds: [],
          },
        },
      },
    });

    expect(ensureActiveSessionFreshRuntime(options)).toBe(false);
    expect(reconnectSession).not.toHaveBeenCalled();
  });

  it('allows explicit resume to reconnect a closed session through the unique reconnect owner', () => {
    const reconnectSession = vi.fn();
    const options = createBaseOptions({
      refreshOptions: {
        sessionId: 'session-1',
        source: 'explicit-resume',
        allowReconnectIfUnavailable: true,
      },
      readSessionTransportSocket: () => null,
      reconnectSession,
      refs: {
        ...createBaseOptions().refs,
        stateRef: {
          current: {
            sessions: [{ id: 'session-1', state: 'closed' } as any],
            activeSessionId: 'session-1',
            liveSessionIds: [],
          },
        },
      },
    });

    expect(ensureActiveSessionFreshRuntime(options)).toBe(true);
    expect(reconnectSession).toHaveBeenCalledWith('session-1');
  });

  it('does not reconnect a recently alive unavailable transport during explicit resume', () => {
    const now = 100_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const reconnectSession = vi.fn();
    const runtimeDebug = vi.fn();
    const refs = createBaseOptions().refs;
    refs.lastServerActivityAtRef.current.set('session-1', now - 5_000);
    const options = createBaseOptions({
      refreshOptions: {
        sessionId: 'session-1',
        source: 'explicit-resume',
        allowReconnectIfUnavailable: true,
      },
      refs,
      readSessionTransportSocket: () => ({ readyState: WebSocket.CLOSED } as any),
      reconnectSession,
      runtimeDebug,
    });

    try {
      expect(ensureActiveSessionFreshRuntime(options)).toBe(false);
      expect(reconnectSession).not.toHaveBeenCalled();
      expect(runtimeDebug).toHaveBeenCalledWith('session.transport.explicit-resume.skip', expect.objectContaining({
        reason: 'transport-keepalive-grace',
        keepaliveGraceActive: true,
      }));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not apply keepalive grace to active tick recovery', () => {
    const now = 100_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const reconnectSession = vi.fn();
    const refs = createBaseOptions().refs;
    refs.lastServerActivityAtRef.current.set('session-1', now - 5_000);
    const options = createBaseOptions({
      refreshOptions: {
        sessionId: 'session-1',
        source: 'active-tick',
        allowReconnectIfUnavailable: true,
      },
      refs,
      readSessionTransportSocket: () => ({ readyState: WebSocket.CLOSED } as any),
      reconnectSession,
    });

    try {
      expect(ensureActiveSessionFreshRuntime(options)).toBe(true);
      expect(reconnectSession).toHaveBeenCalledWith('session-1');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reconnects an unavailable transport after the keepalive grace window expires', () => {
    const now = 300_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const reconnectSession = vi.fn();
    const refs = createBaseOptions().refs;
    refs.lastConnectedBaselineAtRef.current.set('session-1', now - SESSION_TRANSPORT_KEEPALIVE_GRACE_MS - 1);
    const options = createBaseOptions({
      refreshOptions: {
        sessionId: 'session-1',
        source: 'active-reentry',
        allowReconnectIfUnavailable: true,
      },
      refs,
      readSessionTransportSocket: () => null,
      reconnectSession,
    });

    try {
      expect(ensureActiveSessionFreshRuntime(options)).toBe(true);
      expect(reconnectSession).toHaveBeenCalledWith('session-1');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps current reconnect in-flight behavior while inside keepalive grace', () => {
    const now = 100_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const reconnectSession = vi.fn();
    const refs = createBaseOptions().refs;
    refs.lastServerActivityAtRef.current.set('session-1', now - 5_000);
    const options = createBaseOptions({
      refreshOptions: {
        sessionId: 'session-1',
        source: 'explicit-resume',
        allowReconnectIfUnavailable: true,
      },
      refs,
      readSessionTransportSocket: () => null,
      isReconnectInFlight: () => true,
      reconnectSession,
    });

    try {
      expect(ensureActiveSessionFreshRuntime(options)).toBe(false);
      expect(reconnectSession).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('marks a same-socket head probe pending and clears no transport when the probe is fresh', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const ws = { readyState: WebSocket.OPEN } as any;
    const requestSessionBufferHead = vi.fn(() => true);
    const reconnectSession = vi.fn();
    const refs = createBaseOptions().refs;
    const options = createBaseOptions({
      refs,
      readSessionTransportSocket: () => ws,
      requestSessionBufferHead,
      reconnectSession,
      resolveTerminalRefreshCadence: () => ({ headTickMs: 500, headStalePingMs: 500, pullRequestStaleMs: 1200 }),
    });

    try {
      expect(ensureActiveSessionFreshRuntime(options)).toBe(true);
      expect(requestSessionBufferHead).toHaveBeenCalledWith('session-1', ws, { force: undefined });
      expect(refs.staleTransportProbeAtRef.current.get('session-1')).toBe(1000);
      expect(reconnectSession).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps using the same open socket when a head probe gets no response', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2500);
    const ws = { readyState: WebSocket.OPEN } as any;
    const requestSessionBufferHead = vi.fn(() => true);
    const reconnectSession = vi.fn();
    const refs = createBaseOptions().refs;
    refs.staleTransportProbeAtRef.current.set('session-1', 1000);
    const options = createBaseOptions({
      refs,
      readSessionTransportSocket: () => ws,
      requestSessionBufferHead,
      reconnectSession,
      resolveTerminalRefreshCadence: () => ({ headTickMs: 500, headStalePingMs: 500, pullRequestStaleMs: 1200 }),
    });

    try {
      expect(ensureActiveSessionFreshRuntime(options)).toBe(true);
      expect(requestSessionBufferHead).toHaveBeenCalledWith('session-1', ws, { force: undefined });
      expect(reconnectSession).not.toHaveBeenCalled();
      expect(refs.staleTransportProbeAtRef.current.get('session-1')).toBe(2500);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not reconnect while the same-socket head probe is still inside the response budget', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1500);
    const ws = { readyState: WebSocket.OPEN } as any;
    const requestSessionBufferHead = vi.fn(() => true);
    const reconnectSession = vi.fn();
    const refs = createBaseOptions().refs;
    refs.staleTransportProbeAtRef.current.set('session-1', 1000);
    const options = createBaseOptions({
      refs,
      readSessionTransportSocket: () => ws,
      requestSessionBufferHead,
      reconnectSession,
      resolveTerminalRefreshCadence: () => ({ headTickMs: 500, headStalePingMs: 500, pullRequestStaleMs: 1200 }),
    });

    try {
      expect(ensureActiveSessionFreshRuntime(options)).toBe(true);
      expect(requestSessionBufferHead).toHaveBeenCalledWith('session-1', ws, { force: undefined });
      expect(reconnectSession).not.toHaveBeenCalled();
      expect(refs.staleTransportProbeAtRef.current.get('session-1')).toBe(1000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not stack active-tick head probes while a same-socket probe is still pending', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1500);
    const ws = { readyState: WebSocket.OPEN } as any;
    const requestSessionBufferHead = vi.fn(() => true);
    const reconnectSession = vi.fn();
    const runtimeDebug = vi.fn();
    const refs = createBaseOptions().refs;
    refs.staleTransportProbeAtRef.current.set('session-1', 1000);
    const options = createBaseOptions({
      refreshOptions: {
        sessionId: 'session-1',
        source: 'active-tick',
        allowReconnectIfUnavailable: true,
      },
      refs,
      readSessionTransportSocket: () => ws,
      requestSessionBufferHead,
      reconnectSession,
      runtimeDebug,
      resolveTerminalRefreshCadence: () => ({ headTickMs: 500, headStalePingMs: 500, pullRequestStaleMs: 1200 }),
    });

    try {
      expect(ensureActiveSessionFreshRuntime(options)).toBe(false);
      expect(requestSessionBufferHead).not.toHaveBeenCalled();
      expect(reconnectSession).not.toHaveBeenCalled();
      expect(refs.staleTransportProbeAtRef.current.get('session-1')).toBe(1000);
      expect(runtimeDebug).toHaveBeenCalledWith('session.transport.active-tick.head-probe.pending', expect.objectContaining({
        sessionId: 'session-1',
        pendingProbeAgeMs: 500,
      }));
    } finally {
      nowSpy.mockRestore();
    }
  });
});
