// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOpenTabRuntime } from './useOpenTabRuntime';
import { STORAGE_KEYS } from '../lib/types';
import { auditOpenTabsAgainstRemoteSessions as auditOpenTabsAgainstRemoteSessionsMock } from '../lib/remote-tab-audit';

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })),
  },
}));

vi.mock('../lib/remote-tab-audit', () => ({
  auditOpenTabsAgainstRemoteSessions: vi.fn(async () => undefined),
}));

class NoopWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = NoopWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {}

  send() {}

  close() {
    this.readyState = NoopWebSocket.CLOSED;
    this.onclose?.();
  }
}

function buildSession(id: string, state: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'error' = 'connected') {
  return {
    id,
    hostId: `host-${id}`,
    connectionName: `conn-${id}`,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: `session-${id}`,
    authToken: `token-${id}`,
    title: `session-${id}`,
    ws: null,
    state,
    hasUnread: false,
    createdAt: id === 's1' ? 1 : 2,
    daemonHeadRevision: id === 's1' ? 1 : 9,
    daemonHeadEndIndex: id === 's1' ? 1 : 9,
    buffer: {
      lines: [],
      gapRanges: [],
      startIndex: 0,
      endIndex: 0,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 0,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      cursor: null,
      updateKind: 'replace' as const,
      revision: id === 's1' ? 1 : 9,
    },
  } as any;
}

function seedOpenTabs() {
  localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify([
    {
      sessionId: 's1',
      hostId: 'host-s1',
      connectionName: 'conn-s1',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      sessionName: 'session-s1',
      authToken: 'token-s1',
      createdAt: 1,
    },
    {
      sessionId: 's2',
      hostId: 'host-s2',
      connectionName: 'conn-s2',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      sessionName: 'session-s2',
      authToken: 'token-s2',
      createdAt: 2,
    },
  ]));
  localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, 's1');
}

describe('useOpenTabRuntime explicit resume gating', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('WebSocket', NoopWebSocket);
    seedOpenTabs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not double-resume a target that already has a connecting runtime shell', () => {
    const switchSession = vi.fn();
    const resumeActiveSessionTransport = vi.fn(() => true);

    const { result } = renderHook(() => useOpenTabRuntime({
      bridgeSettings: { servers: [] } as any,
      hosts: [],
      hostsLoaded: true,
      restoreSwitchReason: 'explicit-resume',
      sessions: [buildSession('s1', 'connected'), buildSession('s2', 'connecting')],
      sessionGroups: [],
      runtimeActiveSessionId: 's1',
      createSession: vi.fn(() => 's2'),
      closeSession: vi.fn(),
      switchSession,
      moveSession: vi.fn(),
      renameSession: vi.fn(),
      reconnectSession: vi.fn(),
      resumeActiveSessionTransport,
      clearSessionDraft: vi.fn(),
      ensureTerminalPageVisible: vi.fn(),
      setPageState: vi.fn(),
      pruneSessionGroupSelectionToRemoteTruth: vi.fn(),
    }));

    act(() => {
      result.current.handleSwitchSession('s2');
    });

    expect(switchSession).toHaveBeenCalledTimes(1);
    expect(switchSession).toHaveBeenCalledWith('s2', { refreshSource: 'explicit-resume' });
    expect(resumeActiveSessionTransport).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();
  });

  it('keeps explicit resume for a disconnected target that needs transport reopen', () => {
    const switchSession = vi.fn();
    const resumeActiveSessionTransport = vi.fn(() => true);

    const { result } = renderHook(() => useOpenTabRuntime({
      bridgeSettings: { servers: [] } as any,
      hosts: [],
      hostsLoaded: true,
      restoreSwitchReason: 'explicit-resume',
      sessions: [buildSession('s1', 'connected'), buildSession('s2', 'disconnected')],
      sessionGroups: [],
      runtimeActiveSessionId: 's1',
      createSession: vi.fn(() => 's2'),
      closeSession: vi.fn(),
      switchSession,
      moveSession: vi.fn(),
      renameSession: vi.fn(),
      reconnectSession: vi.fn(),
      resumeActiveSessionTransport,
      clearSessionDraft: vi.fn(),
      ensureTerminalPageVisible: vi.fn(),
      setPageState: vi.fn(),
      pruneSessionGroupSelectionToRemoteTruth: vi.fn(),
    }));

    act(() => {
      result.current.handleSwitchSession('s2');
    });

    expect(switchSession).toHaveBeenCalledTimes(1);
    expect(switchSession).toHaveBeenCalledWith('s2', { refreshSource: 'explicit-resume' });
    expect(resumeActiveSessionTransport).toHaveBeenCalledTimes(1);
    expect(resumeActiveSessionTransport).toHaveBeenCalledWith('s2');
  });

  it('passes open sessions and mux target manager into remote audits', async () => {
    const auditMock = vi.mocked(auditOpenTabsAgainstRemoteSessionsMock);
    auditMock.mockClear();
    localStorage.clear();
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => ['session-s1']);
    const baseOptions = {
      bridgeSettings: { servers: [] } as any,
      hosts: [],
      hostsLoaded: true,
      restoreSwitchReason: 'explicit-resume' as const,
      sessionGroups: [],
      runtimeActiveSessionId: 's1',
      createSession: vi.fn(() => 's1'),
      closeSession: vi.fn(),
      switchSession: vi.fn(),
      moveSession: vi.fn(),
      renameSession: vi.fn(),
      reconnectSession: vi.fn(),
      resumeActiveSessionTransport: vi.fn(() => true),
      manageTmuxSessionsOnOpenTransport,
      clearSessionDraft: vi.fn(),
      ensureTerminalPageVisible: vi.fn(),
      setPageState: vi.fn(),
      pruneSessionGroupSelectionToRemoteTruth: vi.fn(),
    };

    const { rerender } = renderHook(
      ({ sessions }) => useOpenTabRuntime({
        ...baseOptions,
        sessions,
      }),
      { initialProps: { sessions: [] as any[] } },
    );

    rerender({ sessions: [buildSession('s1', 'connected')] });

    await waitFor(() => expect(auditMock).toHaveBeenCalled());
    const [, deps] = auditMock.mock.calls[auditMock.mock.calls.length - 1]! as any;
    expect(deps).toEqual(expect.objectContaining({
      sessionsRef: expect.any(Object),
      prioritySessionIdsRef: expect.any(Object),
      manageTmuxSessionsOnOpenTransport,
    }));
    expect((deps as any).sessionsRef.current.map((session: any) => session.id)).toEqual(['s1']);
    expect((deps as any).prioritySessionIdsRef.current).toEqual([null, 's1']);
  });
});
