// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOpenTabRuntime } from './useOpenTabRuntime';
import { STORAGE_KEYS } from '../lib/types';

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
    seedOpenTabs();
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
    expect(switchSession).toHaveBeenCalledWith('s2');
    expect(resumeActiveSessionTransport).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('s2');
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
    expect(switchSession).toHaveBeenCalledWith('s2');
    expect(resumeActiveSessionTransport).toHaveBeenCalledTimes(1);
    expect(resumeActiveSessionTransport).toHaveBeenCalledWith('s2');
  });
});
