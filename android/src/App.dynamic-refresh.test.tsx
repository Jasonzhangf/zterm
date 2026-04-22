// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from './lib/types';

function makeSession(id: string, revision: number) {
  return {
    id,
    hostId: `host-${id}`,
    connectionName: `conn-${id}`,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: `session-${id}`,
    title: `title-${id}`,
    ws: null,
    state: 'connected' as const,
    hasUnread: false,
    createdAt: 1,
    buffer: {
      lines: [],
      startIndex: 0,
      endIndex: 0,
      viewportEndIndex: 0,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      updateKind: 'replace' as const,
      revision,
    },
  };
}

const sessionHarness = vi.hoisted(() => {
  let state = {
    sessions: [makeSession('s1', 1)],
    activeSessionId: 's1',
    connectedCount: 1,
  };
  let staleActiveSession = state.sessions[0];
  const reconnectAllSessions = vi.fn();

  return {
    readState: () => state,
    readStaleActiveSession: () => staleActiveSession,
    reconnectAllSessions,
    update(next: typeof state, stale = staleActiveSession) {
      state = next;
      staleActiveSession = stale;
    },
    reset() {
      state = {
        sessions: [makeSession('s1', 1)],
        activeSessionId: 's1',
        connectedCount: 1,
      };
      staleActiveSession = state.sessions[0];
      reconnectAllSessions.mockReset();
    },
  };
});

vi.mock('./contexts/SessionContext', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSession: () => ({
    state: sessionHarness.readState(),
    createSession: vi.fn(),
    closeSession: vi.fn(),
    switchSession: vi.fn(),
    moveSession: vi.fn(),
    renameSession: vi.fn(),
    reconnectSession: vi.fn(),
    reconnectAllSessions: sessionHarness.reconnectAllSessions,
    getActiveSession: () => sessionHarness.readStaleActiveSession(),
    sendInput: vi.fn(),
    sendImagePaste: vi.fn(),
    resizeTerminal: vi.fn(),
  }),
}));

vi.mock('./hooks/useAppUpdate', () => ({
  useAppUpdate: () => ({
    latestManifest: null,
    availableManifest: null,
    updateChecking: false,
    updateInstalling: false,
    updateError: null,
    appUpdatePreferences: { manifestUrl: '', ignoredVersionName: null, ignoredVersionCode: null },
    setAppUpdatePreferences: vi.fn(),
    checkForUpdates: vi.fn(),
    startUpdate: vi.fn(),
    resetIgnorePolicy: vi.fn(),
  }),
}));

vi.mock('./hooks/useHostStorage', () => ({
  useHostStorage: () => ({
    hosts: [],
    addHost: vi.fn(),
    upsertHost: vi.fn(),
    updateHost: vi.fn(),
    deleteHost: vi.fn(),
  }),
}));

vi.mock('./hooks/useQuickActionStorage', () => ({
  useQuickActionStorage: () => ({
    quickActions: [],
    setQuickActions: vi.fn(),
  }),
}));

vi.mock('./hooks/useShortcutActionStorage', () => ({
  useShortcutActionStorage: () => ({
    shortcutActions: [],
    setShortcutActions: vi.fn(),
  }),
}));

vi.mock('./hooks/useSessionDraftStorage', () => ({
  useSessionDraftStorage: () => ({
    drafts: {},
    setDraft: vi.fn(),
    clearDraft: vi.fn(),
    pruneDrafts: vi.fn(),
  }),
}));

vi.mock('./hooks/useSessionHistoryStorage', () => ({
  useSessionHistoryStorage: () => ({
    sessionGroups: [],
    recordSessionOpen: vi.fn(),
    recordSessionGroupOpen: vi.fn(),
    setSessionGroupSelection: vi.fn(),
    deleteSessionGroup: vi.fn(),
  }),
}));

vi.mock('./components/tmux/TmuxSessionPickerSheet', () => ({
  TmuxSessionPickerSheet: () => null,
}));

vi.mock('./pages/ConnectionsPage', () => ({
  ConnectionsPage: () => null,
}));

vi.mock('./pages/ConnectionPropertiesPage', () => ({
  ConnectionPropertiesPage: () => null,
}));

vi.mock('./pages/SettingsPage', () => ({
  SettingsPage: () => null,
}));

vi.mock('./pages/TerminalPage', () => ({
  TerminalPage: ({ activeSession }: { activeSession: { buffer: { revision: number } } | null }) => (
    <div data-testid="terminal-revision">{activeSession?.buffer.revision ?? -1}</div>
  ),
}));

import { AppContent } from './App';

describe('App dynamic refresh matrix', () => {
  const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');

  beforeEach(() => {
    sessionHarness.reset();
    localStorage.clear();
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal', focusSessionId: 's1' }));
  });

  afterEach(() => {
    cleanup();
    if (originalVisibilityState) {
      Object.defineProperty(document, 'visibilityState', originalVisibilityState);
    }
  });

  it('keeps terminal rendering in sync across sequential active-session buffer updates', async () => {
    const view = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      sessionHarness.update(
        {
          sessions: [makeSession('s1', 2)],
          activeSessionId: 's1',
          connectedCount: 1,
        },
        makeSession('s1', 1),
      );
    });
    view.rerender(<AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('2'));

    act(() => {
      sessionHarness.update(
        {
          sessions: [makeSession('s1', 3)],
          activeSessionId: 's1',
          connectedCount: 1,
        },
        makeSession('s1', 2),
      );
    });
    view.rerender(<AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('3'));
  });

  it('follows state activeSession switch even when stale getter still points to previous session', async () => {
    const view = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      sessionHarness.update(
        {
          sessions: [makeSession('s1', 1), makeSession('s2', 9)],
          activeSessionId: 's2',
          connectedCount: 2,
        },
        makeSession('s1', 1),
      );
    });
    view.rerender(<AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('9'));
  });

  it('does not reconnect healthy sessions on pageshow/online noise', async () => {
    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      window.dispatchEvent(new Event('pageshow'));
      window.dispatchEvent(new Event('online'));
    });

    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
  });

  it('coalesces hidden-resume lifecycle burst into a single reconnect sweep', async () => {
    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('resume'));
    });

    expect(sessionHarness.reconnectAllSessions).toHaveBeenCalledTimes(1);
  });
});
