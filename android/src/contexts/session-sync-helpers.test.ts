// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../lib/types';
import {
  buildActiveSessionRefreshPlan,
  buildReconnectHandshakeFailurePlan,
  buildTransportOpenConnectedEffectPlan,
  buildTransportOpenLiveFailureEffectPlan,
  buildConnectedHeadRefreshPlan,
  buildSessionConnectedUpdates,
  buildSessionConnectingLabelUpdates,
  buildSessionConnectionFields,
  buildSessionConnectingUpdates,
  buildSessionErrorUpdates,
  buildSessionIdleAfterReconnectBlockedUpdates,
  buildSessionReconnectAttemptProgressUpdates,
  buildSessionReconnectingFailureUpdates,
  buildSessionScheduleListLoadingState,
  buildSessionReconnectingUpdates,
  buildSessionScheduleErrorState,
  buildSessionScheduleLoadingState,
  buildSessionTransportPrimeState,
  buildDefaultSessionVisibleRange,
  hasSessionLocalWindow,
  buildManagedSessionReuseKey,
  buildSessionBufferSyncRequestPayload,
  createPendingSessionTransportOpenIntent,
  findReusableManagedSession,
  normalizeSessionVisibleRangeState,
  scoreReusableManagedSession,
  shouldPullFollowBuffer,
  shouldOpenManagedSessionTransport,
  shouldPullVisibleRangeBuffer,
  visibleRangeStatesEqual,
  doesSessionPullStateCoverRequest,
  doesSessionPullStateMatchExactLocalSnapshot,
} from './session-sync-helpers';

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: 'session-1',
    hostId: 'host-1',
    connectionName: 'conn-1',
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    sessionName: 'tmux-1',
    title: 'tab-1',
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
    daemonHeadRevision: 6,
    daemonHeadEndIndex: 120,
    buffer: {
      lines: [],
      gapRanges: [],
      startIndex: 80,
      endIndex: 120,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 120,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      cursor: null,
      updateKind: 'replace',
      revision: 6,
    },
    ...overrides,
  };
}

describe('session sync helper refresh planner', () => {
  it('requests head on foreground resume for active open transport', () => {
    expect(buildActiveSessionRefreshPlan({
      hasSession: true,
      isActive: true,
      sessionState: 'connected',
      wsReadyState: WebSocket.OPEN,
      reconnectInFlight: false,
      pendingTransportOpen: false,
      allowReconnectIfUnavailable: true,
      transportStale: false,
      source: 'active-resume',
    })).toEqual({
      action: 'request-head',
      resetPullBookkeeping: true,
    });
  });

  it('probes stale active transport before reconnecting', () => {
    expect(buildActiveSessionRefreshPlan({
      hasSession: true,
      isActive: true,
      sessionState: 'connected',
      wsReadyState: WebSocket.OPEN,
      reconnectInFlight: false,
      pendingTransportOpen: false,
      allowReconnectIfUnavailable: true,
      transportStale: true,
      source: 'active-tick',
    })).toEqual({
      action: 'probe-stale-transport',
      probeReason: 'active-tick',
    });
  });

  it('reconnects when active foreground restore finds no usable transport and reconnect is allowed', () => {
    expect(buildActiveSessionRefreshPlan({
      hasSession: true,
      isActive: true,
      sessionState: 'closed',
      wsReadyState: WebSocket.CLOSED,
      reconnectInFlight: false,
      pendingTransportOpen: false,
      allowReconnectIfUnavailable: true,
      transportStale: false,
      source: 'active-resume',
    })).toEqual({ action: 'reconnect' });
  });

  it('skips active tick when reconnect is already in flight', () => {
    expect(buildActiveSessionRefreshPlan({
      hasSession: true,
      isActive: true,
      sessionState: 'reconnecting',
      wsReadyState: WebSocket.CLOSED,
      reconnectInFlight: true,
      pendingTransportOpen: false,
      allowReconnectIfUnavailable: true,
      transportStale: false,
      source: 'active-tick',
    })).toEqual({ action: 'skip', reason: 'tick-blocked-by-reconnect' });
  });
});

describe('session sync helper session connection config truth', () => {
  const host = {
    id: 'host-1',
    createdAt: 1,
    name: 'conn-1',
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    sessionName: 'tmux-1',
    authToken: 'token-1',
    authType: 'password' as const,
    tags: [],
    pinned: false,
    autoCommand: 'top',
  };

  it('builds stable session connection fields from host identity', () => {
    expect(buildSessionConnectionFields(host, 'tmux-resolved')).toEqual({
      hostId: 'host-1',
      connectionName: 'conn-1',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      sessionName: 'tmux-resolved',
      authToken: 'token-1',
      autoCommand: 'top',
    });
  });

  it('builds connecting updates without duplicating field assembly at call sites', () => {
    expect(buildSessionConnectingUpdates(host, 'tmux-resolved')).toMatchObject({
      hostId: 'host-1',
      connectionName: 'conn-1',
      sessionName: 'tmux-resolved',
      state: 'connecting',
      reconnectAttempt: 0,
      lastError: undefined,
    });
  });

  it('builds reconnecting updates with ws reset truth', () => {
    expect(buildSessionReconnectingUpdates(host, 'tmux-resolved')).toMatchObject({
      hostId: 'host-1',
      connectionName: 'conn-1',
      sessionName: 'tmux-resolved',
      state: 'reconnecting',
      reconnectAttempt: 0,
      lastError: undefined,
      ws: null,
    });
  });

  it('builds transport prime state as single pre-open truth for connect and reconnect', () => {
    expect(buildSessionTransportPrimeState(host, 'connect')).toEqual({
      resolvedSessionName: 'tmux-1',
      transportHost: {
        ...host,
        sessionName: 'tmux-1',
      },
      sessionUpdates: buildSessionConnectingUpdates(host, 'tmux-1'),
    });
    expect(buildSessionTransportPrimeState({
      ...host,
      sessionName: '   ',
      name: 'conn-fallback',
    }, 'reconnect')).toEqual({
      resolvedSessionName: 'conn-fallback',
      transportHost: {
        ...host,
        sessionName: 'conn-fallback',
        name: 'conn-fallback',
      },
      sessionUpdates: buildSessionReconnectingUpdates({
        ...host,
        sessionName: '   ',
        name: 'conn-fallback',
      }, 'conn-fallback'),
    });
  });

  it('builds schedule loading state from session name only', () => {
    expect(buildSessionScheduleLoadingState('tmux-resolved')).toEqual({
      sessionName: 'tmux-resolved',
      jobs: [],
      loading: true,
    });
  });

  it('builds schedule error state by stopping loading and attaching error', () => {
    expect(buildSessionScheduleErrorState({
      sessionName: 'tmux-resolved',
      jobs: [],
      loading: true,
      error: undefined,
    }, 'boom')).toEqual({
      sessionName: 'tmux-resolved',
      jobs: [],
      loading: false,
      error: 'boom',
    });
  });

  it('builds reconnect attempt progress updates without duplicating shape at call sites', () => {
    expect(buildSessionReconnectAttemptProgressUpdates(3)).toEqual({
      state: 'reconnecting',
      reconnectAttempt: 3,
    });
  });

  it('builds connecting label updates from handshake session name only', () => {
    expect(buildSessionConnectingLabelUpdates('tmux-renamed')).toEqual({
      state: 'connecting',
      sessionName: 'tmux-renamed',
    });
  });

  it('builds session error updates with optional ws reset', () => {
    expect(buildSessionErrorUpdates('boom')).toEqual({
      state: 'error',
      lastError: 'boom',
    });
    expect(buildSessionErrorUpdates('boom', { includeWsNull: true })).toEqual({
      state: 'error',
      lastError: 'boom',
      ws: null,
    });
  });

  it('builds reconnect-blocked idle updates as single truth', () => {
    expect(buildSessionIdleAfterReconnectBlockedUpdates('skip')).toEqual({
      state: 'idle',
      lastError: 'skip',
      reconnectAttempt: 0,
      ws: null,
    });
  });

  it('builds reconnecting failure updates with preserved next attempt', () => {
    expect(buildSessionReconnectingFailureUpdates('boom', 4)).toEqual({
      state: 'reconnecting',
      lastError: 'boom',
      reconnectAttempt: 4,
      ws: null,
    });
  });

  it('detects whether a session already has a local buffer window', () => {
    expect(hasSessionLocalWindow(makeSession())).toBe(true);
    expect(hasSessionLocalWindow(makeSession({
      buffer: {
        ...makeSession().buffer,
        startIndex: 10,
        endIndex: 10,
        revision: 0,
      },
    }))).toBe(false);
    expect(hasSessionLocalWindow(null)).toBe(false);
  });

  it('does not treat a newer head revision as blocked by an older same-window in-flight tail refresh', () => {
    expect(doesSessionPullStateMatchExactLocalSnapshot({
      purpose: 'tail-refresh',
      startedAt: 1,
      targetHeadRevision: 6,
      targetStartIndex: 96,
      targetEndIndex: 120,
      requestKnownRevision: 5,
      requestLocalStartIndex: 0,
      requestLocalEndIndex: 120,
    }, {
      knownRevision: 5,
      localStartIndex: 0,
      localEndIndex: 120,
      requestStartIndex: 96,
      requestEndIndex: 120,
    })).toBe(true);
  });

  it('builds connected updates as single truth', () => {
    expect(buildSessionConnectedUpdates()).toEqual({
      state: 'connected',
      reconnectAttempt: 0,
      lastError: undefined,
    });
  });

  it('builds schedule-list loading state on connected', () => {
    expect(buildSessionScheduleListLoadingState({
      sessionName: 'old',
      jobs: [],
      loading: false,
      error: 'old-error',
    }, 'new-name')).toEqual({
      sessionName: 'new-name',
      jobs: [],
      loading: true,
      error: undefined,
    });
  });

  it('builds connected head refresh plan from active/live-window truth', () => {
    expect(buildConnectedHeadRefreshPlan({
      shouldLiveRefresh: true,
      hadLocalWindowBeforeConnected: true,
    })).toEqual({
      shouldRequestHead: true,
      shouldMarkPendingConnectTailRefresh: true,
    });
    expect(buildConnectedHeadRefreshPlan({
      shouldLiveRefresh: true,
      hadLocalWindowBeforeConnected: false,
    })).toEqual({
      shouldRequestHead: true,
      shouldMarkPendingConnectTailRefresh: false,
    });
    expect(buildConnectedHeadRefreshPlan({
      shouldLiveRefresh: false,
      hadLocalWindowBeforeConnected: true,
    })).toEqual({
      shouldRequestHead: false,
      shouldMarkPendingConnectTailRefresh: false,
    });
  });

  it('builds connected effect plan from debug scope', () => {
    expect(buildTransportOpenConnectedEffectPlan('connect')).toEqual({
      debugEvent: 'session.ws.connected',
      clearSupersededSockets: false,
      flushPendingInputQueue: false,
    });
    expect(buildTransportOpenConnectedEffectPlan('reconnect')).toEqual({
      debugEvent: 'session.ws.reconnect.connected',
      clearSupersededSockets: true,
      flushPendingInputQueue: true,
    });
  });

  it('builds live failure effect plan from debug scope', () => {
    expect(buildTransportOpenLiveFailureEffectPlan('connect')).toEqual({
      clearPendingIntent: true,
      clearTransportToken: true,
      clearScheduleErrorState: true,
      clearSupersededSockets: false,
      scheduleReconnect: true,
    });
    expect(buildTransportOpenLiveFailureEffectPlan('reconnect')).toEqual({
      clearPendingIntent: true,
      clearTransportToken: true,
      clearScheduleErrorState: true,
      clearSupersededSockets: true,
      scheduleReconnect: true,
    });
  });

  it('builds reconnect handshake failure plan without embedding side effects', () => {
    expect(buildReconnectHandshakeFailurePlan({
      retryable: false,
      currentAttempt: 2,
    })).toEqual({ action: 'terminal-error' });
    expect(buildReconnectHandshakeFailurePlan({
      retryable: true,
      currentAttempt: 2,
    })).toEqual({ action: 'retry-reconnect', nextAttempt: 3 });
    expect(buildReconnectHandshakeFailurePlan({
      retryable: true,
      currentAttempt: 6,
    })).toEqual({ action: 'retry-reconnect', nextAttempt: 6 });
  });
});

describe('session sync helper transport open intent truth', () => {
  const host = {
    id: 'host-1',
    createdAt: 1,
    name: 'conn-1',
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    sessionName: 'tmux-1',
    authType: 'password' as const,
    tags: [],
    pinned: false,
  };

  it('routes first failure through handshake path and clears timeout once', () => {
    const clearHandshakeTimeout = vi.fn();
    const finalizeSocketFailureBaseline = vi.fn().mockReturnValue({ shouldContinue: true, manualClosed: false });
    const onHandshakeFailure = vi.fn();
    const intent = createPendingSessionTransportOpenIntent({
      sessionId: 's-1',
      host,
      resolvedSessionName: 'tmux-1',
      debugScope: 'connect',
      clearHandshakeTimeout,
      finalizeSocketFailureBaseline,
      onHandshakeFailure,
    });

    intent.finalizeFailure('boom', true);

    expect(clearHandshakeTimeout).toHaveBeenCalledTimes(1);
    expect(finalizeSocketFailureBaseline).toHaveBeenCalledTimes(1);
    expect(onHandshakeFailure).toHaveBeenCalledWith('boom', true, 'handshake');
  });

  it('routes post-connect failure through live path only once', () => {
    const clearHandshakeTimeout = vi.fn();
    const onHandshakeFailure = vi.fn();
    const onHandshakeConnected = vi.fn();
    const intent = createPendingSessionTransportOpenIntent({
      sessionId: 's-1',
      host,
      resolvedSessionName: 'tmux-1',
      debugScope: 'reconnect',
      clearHandshakeTimeout,
      finalizeSocketFailureBaseline: vi.fn(),
      onHandshakeFailure,
      onHandshakeConnected,
    });

    intent.onConnected({} as any);
    intent.finalizeFailure('late-boom', true);
    intent.finalizeFailure('late-boom-2', true);

    expect(onHandshakeConnected).toHaveBeenCalledWith(expect.anything(), 'tmux-1');
    expect(onHandshakeFailure).toHaveBeenCalledTimes(1);
    expect(onHandshakeFailure).toHaveBeenCalledWith('late-boom', true, 'live');
  });

  it('suppresses handshake continuation when baseline says stop', () => {
    const onHandshakeFailure = vi.fn();
    const intent = createPendingSessionTransportOpenIntent({
      sessionId: 's-1',
      host,
      resolvedSessionName: 'tmux-1',
      debugScope: 'connect',
      clearHandshakeTimeout: vi.fn(),
      finalizeSocketFailureBaseline: vi.fn().mockReturnValue({ shouldContinue: false, manualClosed: true }),
      onHandshakeFailure,
    });

    intent.finalizeFailure('manual-close', false);

    expect(onHandshakeFailure).not.toHaveBeenCalled();
  });
});

describe('session sync helper visible-range truth', () => {
  it('normalizes visible range without renderer mode semantics', () => {
    expect(normalizeSessionVisibleRangeState({
      startIndex: -10,
      endIndex: 120.9,
      viewportRows: 24.8,
    })).toEqual({
      startIndex: 0,
      endIndex: 120,
      viewportRows: 24,
    });
  });

  it('builds default visible range from session tail truth', () => {
    const session = makeSession();
    expect(buildDefaultSessionVisibleRange(session)).toEqual({
      startIndex: 96,
      endIndex: 120,
      viewportRows: 24,
    });
  });

  it('detects visible-range repair need from local gap coverage only', () => {
    const session = makeSession({
      buffer: {
        ...makeSession().buffer,
        startIndex: 56,
        endIndex: 80,
        gapRanges: [{ startIndex: 72, endIndex: 76 }],
      },
      daemonHeadEndIndex: 80,
    });
    expect(shouldPullVisibleRangeBuffer(session, {
      startIndex: 56,
      endIndex: 80,
      viewportRows: 24,
    })).toBe(true);
  });

  it('requests visible-range repair when local mirror misses the declared request window history', () => {
    const session = makeSession({
      daemonHeadEndIndex: 80,
      buffer: {
        ...makeSession().buffer,
        startIndex: 56,
        endIndex: 80,
      },
    });
    expect(shouldPullVisibleRangeBuffer(session, {
      startIndex: 56,
      endIndex: 80,
      viewportRows: 24,
    })).toBe(true);
  });

  it('keeps tail refresh independent from visible-range repair mode', () => {
    const session = makeSession({
      daemonHeadRevision: 7,
      daemonHeadEndIndex: 120,
      buffer: {
        ...makeSession().buffer,
        startIndex: 80,
        endIndex: 120,
        revision: 6,
      },
    });
    expect(shouldPullFollowBuffer(session, {
      startIndex: 96,
      endIndex: 120,
      viewportRows: 24,
    })).toBe(true);
  });

  it('builds reading-repair payload from visible range request window and gaps', () => {
    const session = makeSession({
      daemonHeadEndIndex: 80,
      buffer: {
        ...makeSession().buffer,
        startIndex: 56,
        endIndex: 80,
        revision: 5,
        gapRanges: [{ startIndex: 72, endIndex: 76 }],
      },
    });
    expect(buildSessionBufferSyncRequestPayload(
      session,
      { startIndex: 56, endIndex: 80, viewportRows: 24 },
      { purpose: 'reading-repair' },
    )).toMatchObject({
      knownRevision: 5,
      localStartIndex: 56,
      localEndIndex: 80,
      requestStartIndex: 8,
      requestEndIndex: 80,
      missingRanges: [
        { startIndex: 8, endIndex: 56 },
        { startIndex: 72, endIndex: 76 },
      ],
    });
  });

  it('compares visible ranges by absolute range instead of renderer mode', () => {
    expect(visibleRangeStatesEqual(
      { startIndex: 56, endIndex: 80, viewportRows: 24 },
      { startIndex: 56, endIndex: 80, viewportRows: 24 },
    )).toBe(true);
    expect(visibleRangeStatesEqual(
      { startIndex: 56, endIndex: 80, viewportRows: 24 },
      { startIndex: 57, endIndex: 80, viewportRows: 24 },
    )).toBe(false);
  });
});

describe('session sync helper managed session reuse truth', () => {
  it('builds managed session reuse key from target identity only', () => {
    expect(buildManagedSessionReuseKey({
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      sessionName: 'tmux-a',
      authToken: 'token-1',
    })).toBe('100.127.23.27::3333::tmux-a::token-1');
  });

  it('prefers active/connected managed session when multiple candidates match', () => {
    const winner = findReusableManagedSession({
      sessions: [
        makeSession({ id: 's-older', state: 'connected', createdAt: 1 }),
        makeSession({ id: 's-active', state: 'connected', createdAt: 2 }),
        makeSession({ id: 's-newer', state: 'reconnecting', createdAt: 3 }),
      ],
      host: {
        id: 'host-1',
        createdAt: 1,
        name: 'conn-1',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authType: 'password',
        tags: [],
        pinned: false,
      },
      resolvedSessionName: 'tmux-1',
      activeSessionId: 's-active',
    });
    expect(winner?.id).toBe('s-active');
    expect(scoreReusableManagedSession(winner!, 's-active')).toBeGreaterThan(
      scoreReusableManagedSession(makeSession({ id: 's-older', state: 'connected', createdAt: 1 }), 's-active'),
    );
  });

  it('opens managed session transport only when there is no usable/opening transport truth', () => {
    expect(shouldOpenManagedSessionTransport({
      readyState: WebSocket.OPEN,
      hasPendingOpenIntent: false,
      sessionState: 'connected',
    })).toBe(false);
    expect(shouldOpenManagedSessionTransport({
      readyState: WebSocket.CONNECTING,
      hasPendingOpenIntent: false,
      sessionState: 'connecting',
    })).toBe(false);
    expect(shouldOpenManagedSessionTransport({
      readyState: WebSocket.CLOSED,
      hasPendingOpenIntent: false,
      sessionState: 'idle',
    })).toBe(true);
    expect(shouldOpenManagedSessionTransport({
      readyState: WebSocket.CLOSED,
      hasPendingOpenIntent: true,
      sessionState: 'idle',
    })).toBe(false);
  });
});

describe('session sync helper pull-state truth', () => {
  it('does not let an older in-flight pull cover a new request from a newer local snapshot', () => {
    expect(doesSessionPullStateCoverRequest({
      purpose: 'tail-refresh',
      startedAt: 1,
      targetHeadRevision: 71737,
      targetStartIndex: 187513,
      targetEndIndex: 187577,
      requestKnownRevision: 71688,
      requestLocalStartIndex: 186512,
      requestLocalEndIndex: 187512,
    }, {
      knownRevision: 71736,
      localStartIndex: 186513,
      localEndIndex: 187513,
      requestStartIndex: 187519,
      requestEndIndex: 187550,
    })).toBe(false);
  });

  it('still treats a narrower request from the same local snapshot as covered by the current in-flight pull', () => {
    expect(doesSessionPullStateCoverRequest({
      purpose: 'tail-refresh',
      startedAt: 1,
      targetHeadRevision: 71737,
      targetStartIndex: 187513,
      targetEndIndex: 187577,
      requestKnownRevision: 71736,
      requestLocalStartIndex: 186513,
      requestLocalEndIndex: 187513,
    }, {
      knownRevision: 71736,
      localStartIndex: 186513,
      localEndIndex: 187513,
      requestStartIndex: 187519,
      requestEndIndex: 187550,
    })).toBe(true);
  });
});
