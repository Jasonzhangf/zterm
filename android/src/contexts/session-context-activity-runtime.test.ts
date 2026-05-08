import { describe, expect, it, vi } from 'vitest';
import { ensureActiveSessionFreshRuntime } from './session-context-activity-runtime';

function buildSession(id: string, state: 'connected' | 'connecting' | 'reconnecting' | 'closed' = 'connected') {
  return {
    id,
    state,
    daemonHeadRevision: 1,
    daemonHeadEndIndex: 120,
  } as any;
}

function createSocket(readyState: number) {
  return {
    readyState,
    getDiagnostics: () => ({}),
  } as any;
}

describe('session-context-activity-runtime', () => {
  it('treats explicit foreground resume target as refreshable even before runtime active session catches up', () => {
    const requestSessionBufferHead = vi.fn(() => true);

    const refreshed = ensureActiveSessionFreshRuntime({
      refreshOptions: {
        sessionId: 'session-2',
        source: 'active-resume',
        forceHead: true,
        allowReconnectIfUnavailable: true,
      },
      refs: {
        stateRef: {
          current: {
            sessions: [buildSession('session-1'), buildSession('session-2')],
            activeSessionId: 'session-1',
            liveSessionIds: [],
          },
        },
        pendingResumeTailRefreshRef: { current: new Set<string>() },
        lastActiveReentryAtRef: { current: new Map<string, number>() },
        lastConnectedBaselineAtRef: { current: new Map<string, number>() },
        connectedBaselineBurstGuardRef: { current: new Set<string>() },
        lastServerActivityAtRef: { current: new Map<string, number>() },
        lastHeadRequestAtRef: { current: new Map<string, number>() },
      },
      readSessionTransportRuntime: () => ({ targetKey: 'target-2' }),
      readSessionTargetRuntime: () => ({ sessionIds: ['session-2'] }),
      readSessionTransportSocket: () => createSocket(WebSocket.OPEN),
      isReconnectInFlight: () => false,
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      isSessionTransportActivityStale: () => false,
      runtimeDebug: vi.fn(),
      readSessionBufferSnapshot: () => ({ revision: 1, startIndex: 96, endIndex: 120 }),
      probeOrReconnectStaleSessionTransport: vi.fn(() => 'probed'),
      resetSessionTransportPullBookkeeping: vi.fn(),
      requestSessionBufferHead,
      resolveTerminalRefreshCadence: () => ({ headTickMs: 33, headStalePingMs: 200, pullRequestStaleMs: 1500 }),
      reconnectSession: vi.fn(),
    });

    expect(refreshed).toBe(true);
    expect(requestSessionBufferHead).toHaveBeenCalledWith('session-2', expect.anything(), { force: true });
  });

  it('does not broaden active tick ownership when runtime active session still points elsewhere', () => {
    const requestSessionBufferHead = vi.fn(() => true);

    const refreshed = ensureActiveSessionFreshRuntime({
      refreshOptions: {
        sessionId: 'session-2',
        source: 'active-tick',
        allowReconnectIfUnavailable: false,
      },
      refs: {
        stateRef: {
          current: {
            sessions: [buildSession('session-1'), buildSession('session-2')],
            activeSessionId: 'session-1',
            liveSessionIds: [],
          },
        },
        pendingResumeTailRefreshRef: { current: new Set<string>() },
        lastActiveReentryAtRef: { current: new Map<string, number>() },
        lastConnectedBaselineAtRef: { current: new Map<string, number>() },
        connectedBaselineBurstGuardRef: { current: new Set<string>() },
        lastServerActivityAtRef: { current: new Map<string, number>() },
        lastHeadRequestAtRef: { current: new Map<string, number>() },
      },
      readSessionTransportRuntime: () => ({ targetKey: 'target-2' }),
      readSessionTargetRuntime: () => ({ sessionIds: ['session-2'] }),
      readSessionTransportSocket: () => createSocket(WebSocket.OPEN),
      isReconnectInFlight: () => false,
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      isSessionTransportActivityStale: () => false,
      runtimeDebug: vi.fn(),
      readSessionBufferSnapshot: () => ({ revision: 1, startIndex: 96, endIndex: 120 }),
      probeOrReconnectStaleSessionTransport: vi.fn(() => 'probed'),
      resetSessionTransportPullBookkeeping: vi.fn(),
      requestSessionBufferHead,
      resolveTerminalRefreshCadence: () => ({ headTickMs: 33, headStalePingMs: 200, pullRequestStaleMs: 1500 }),
      reconnectSession: vi.fn(),
    });

    expect(refreshed).toBe(false);
    expect(requestSessionBufferHead).not.toHaveBeenCalled();
  });

  it('skips duplicate forced resume head immediately after connected baseline head', () => {
    const requestSessionBufferHead = vi.fn(() => true);
    const refs = {
      stateRef: {
        current: {
          sessions: [buildSession('session-1'), buildSession('session-2')],
          activeSessionId: 'session-2',
          liveSessionIds: ['session-2'],
        },
      },
      pendingResumeTailRefreshRef: { current: new Set<string>() },
      lastActiveReentryAtRef: { current: new Map<string, number>() },
      lastConnectedBaselineAtRef: { current: new Map<string, number>([['session-2', Date.now()]]) },
      connectedBaselineBurstGuardRef: { current: new Set<string>(['session-2']) },
      lastServerActivityAtRef: { current: new Map<string, number>() },
      lastHeadRequestAtRef: { current: new Map<string, number>() },
    };

    const refreshed = ensureActiveSessionFreshRuntime({
      refreshOptions: {
        sessionId: 'session-2',
        source: 'active-resume',
        forceHead: true,
        allowReconnectIfUnavailable: true,
      },
      refs,
      readSessionTransportRuntime: () => ({ targetKey: 'target-2' }),
      readSessionTargetRuntime: () => ({ sessionIds: ['session-2'] }),
      readSessionTransportSocket: () => createSocket(WebSocket.OPEN),
      isReconnectInFlight: () => false,
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      isSessionTransportActivityStale: () => false,
      runtimeDebug: vi.fn(),
      readSessionBufferSnapshot: () => ({ revision: 1, startIndex: 96, endIndex: 120 }),
      probeOrReconnectStaleSessionTransport: vi.fn(() => 'probed'),
      resetSessionTransportPullBookkeeping: vi.fn(),
      requestSessionBufferHead,
      resolveTerminalRefreshCadence: () => ({ headTickMs: 33, headStalePingMs: 200, pullRequestStaleMs: 1500 }),
      reconnectSession: vi.fn(),
    });

    expect(refreshed).toBe(true);
    expect(requestSessionBufferHead).not.toHaveBeenCalled();
    expect(refs.connectedBaselineBurstGuardRef.current.has('session-2')).toBe(false);
  });
});
