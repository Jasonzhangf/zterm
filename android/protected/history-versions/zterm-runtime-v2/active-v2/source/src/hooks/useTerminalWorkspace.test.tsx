// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS, type Session } from '../lib/types';
import { useTerminalWorkspace } from './useTerminalWorkspace';

function makeSession(id: string): Session {
  return {
    id,
    hostId: `host-${id}`,
    connectionName: `conn-${id}`,
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    sessionName: `tmux-${id}`,
    title: `tab-${id}`,
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
  };
}

describe('useTerminalWorkspace explicit pane truth', () => {
  beforeEach(() => {
    const storageBacking = new Map<string, string>();
    const storageShim = {
      get length() {
        return storageBacking.size;
      },
      clear() {
        storageBacking.clear();
      },
      getItem(key: string) {
        return storageBacking.has(key) ? storageBacking.get(key)! : null;
      },
      key(index: number) {
        return Array.from(storageBacking.keys())[index] ?? null;
      },
      removeItem(key: string) {
        storageBacking.delete(key);
      },
      setItem(key: string, value: string) {
        storageBacking.set(key, String(value));
      },
    } as Storage;
    vi.stubGlobal('localStorage', storageShim);
    localStorage.clear();
  });

  it('refuses to attach a session to a missing pane instead of silently falling back to P1/active pane', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
      ],
      activePaneId: 'pane-1',
    }));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useTerminalWorkspace({
      sessions: [makeSession('s1'), makeSession('s2'), makeSession('s3')],
      activeSessionId: 's1',
      viewportWidth: 1200,
      viewportHeight: 900,
      maxSplitCount: 4,
    }));

    act(() => {
      result.current.attachSessionToPane('s3', 'pane-missing');
    });

    expect(result.current.findPaneForSession('s3')).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[useTerminalWorkspace] Refused to attach sessions to a missing pane.',
      expect.objectContaining({
        paneId: 'pane-missing',
        sessionIds: ['s3'],
      }),
    );
    consoleErrorSpy.mockRestore();
  });

  it('rejects an empty restore snapshot instead of inventing a pane identity', () => {
    const { result } = renderHook(() => useTerminalWorkspace({
      sessions: [makeSession('s1'), makeSession('s2')],
      activeSessionId: 's1',
      viewportWidth: 1200,
      viewportHeight: 900,
      maxSplitCount: 4,
    }));

    expect(() => {
      act(() => {
        result.current.attachSessionToPane('s2', 'pane-missing', {
          restoreSnapshot: { panes: [], activePaneId: 'pane-missing' },
        });
      });
    }).toThrow('[useTerminalWorkspace] workspace invariant violated: session sync requires at least one pane.');
  });

  it('does not resurrect a runtime session into workspace tabs when it was never in explicit open-tab truth', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
      ],
      activePaneId: 'pane-2',
    }));

    const { result } = renderHook(() => useTerminalWorkspace({
      sessions: [makeSession('s1'), makeSession('s2'), makeSession('s3')],
      activeSessionId: 's1',
      viewportWidth: 1200,
      viewportHeight: 900,
      maxSplitCount: 4,
    }));

    expect(result.current.findPaneForSession('s1')?.id).toBe('pane-1');
    expect(result.current.findPaneForSession('s2')?.id).toBe('pane-2');
    expect(result.current.findPaneForSession('s3')).toBeNull();
    expect(result.current.workspace.panes.flatMap((pane) => pane.tabs.map((tab) => tab.sessionId))).toEqual(['s1', 's2']);
  });

  it('does not resurrect stale persisted layout tabs when no open-tab/session truth exists', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        {
          id: 'pane-main',
          size: 1,
          activeTabId: 'tab-session-stale-routecodex',
          tabs: [{ id: 'tab-session-stale-routecodex', sessionId: 'session-stale-routecodex' }],
        },
      ],
      activePaneId: 'pane-main',
    }));

    const { result } = renderHook(() => useTerminalWorkspace({
      sessions: [],
      activeSessionId: null,
      viewportWidth: 390,
      viewportHeight: 844,
      maxSplitCount: 4,
    }));

    expect(result.current.workspace).toEqual({
      panes: [{
        id: 'pane-main',
        size: 1,
        tabs: [],
        activeTabId: '',
      }],
      activePaneId: 'pane-main',
    });
    expect(result.current.activePaneSessionId).toBeNull();
    expect(result.current.findPaneForSession('session-stale-routecodex')).toBeNull();
  });

  it('keeps persisted pane tabs when a runtime transport is closed but open-tab truth is still present', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-demo-tab', tabs: [{ id: 'tab-demo-tab', sessionId: 'demo-tab' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-zterm-tab', tabs: [{ id: 'tab-zterm-tab', sessionId: 'zterm-tab' }] },
      ],
      activePaneId: 'pane-1',
    }));

    const { result, rerender } = renderHook(({ sessions }) => useTerminalWorkspace({
      sessions,
      activeSessionId: 'demo-tab',
      viewportWidth: 1200,
      viewportHeight: 900,
      maxSplitCount: 4,
    }), {
      initialProps: {
        sessions: [
          makeSession('demo-tab'),
          makeSession('zterm-tab'),
        ] as Session[],
      },
    });

    expect(result.current.workspace.panes.flatMap((pane) => pane.tabs.map((tab) => tab.sessionId))).toEqual(['demo-tab', 'zterm-tab']);

    rerender({
      sessions: [
        { ...makeSession('demo-tab'), state: 'closed' },
        makeSession('zterm-tab'),
      ],
    });

    expect(result.current.workspace.panes.flatMap((pane) => pane.tabs.map((tab) => tab.sessionId))).toEqual(['demo-tab', 'zterm-tab']);
    expect(result.current.activePaneSessionId).toBe('demo-tab');
  });

  it('keeps split pane owner as the single truth instead of overriding it from runtime active session', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
      ],
      activePaneId: 'pane-2',
    }));

    const { result, rerender } = renderHook(({ activeSessionId }) => useTerminalWorkspace({
      sessions: [makeSession('s1'), makeSession('s2')],
      activeSessionId,
      viewportWidth: 1200,
      viewportHeight: 900,
      maxSplitCount: 4,
    }), {
      initialProps: {
        activeSessionId: 's1' as string | null,
      },
    });

    expect(result.current.workspace.activePaneId).toBe('pane-2');
    expect(result.current.activePaneSessionId).toBe('s2');

    rerender({ activeSessionId: 's1' });

    expect(result.current.workspace.activePaneId).toBe('pane-2');
    expect(result.current.activePaneSessionId).toBe('s2');
  });

  it('offers four-pane choice when landscape width already qualifies for three panes', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.25, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.25, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
        { id: 'pane-3', size: 0.25, activeTabId: 'tab-s3', tabs: [{ id: 'tab-s3', sessionId: 's3' }] },
        { id: 'pane-4', size: 0.25, activeTabId: 'tab-s4', tabs: [{ id: 'tab-s4', sessionId: 's4' }] },
      ],
      activePaneId: 'pane-1',
    }));

    const { result, rerender } = renderHook(({ viewportHeight }) => useTerminalWorkspace({
      sessions: [makeSession('s1'), makeSession('s2'), makeSession('s3'), makeSession('s4')],
      activeSessionId: 's1',
      viewportWidth: 1200,
      viewportHeight,
      maxSplitCount: 4,
    }), {
      initialProps: { viewportHeight: 900 },
    });

    expect(result.current.currentMaxSplitCount).toBe(4);
    expect(result.current.workspace.panes).toHaveLength(4);

    rerender({ viewportHeight: 620 });

    expect(result.current.currentMaxSplitCount).toBe(4);
    expect(result.current.workspace.panes).toHaveLength(4);
    expect(result.current.workspace.panes.map((pane) => pane.size)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it('hides split control and keeps one pane when width is not greater than 70% of height', () => {
    const { result } = renderHook(() => useTerminalWorkspace({
      sessions: [makeSession('s1'), makeSession('s2')],
      activeSessionId: 's1',
      viewportWidth: 320,
      viewportHeight: 800,
      maxSplitCount: 4,
    }));

    expect(result.current.splitAvailable).toBe(false);
    expect(result.current.currentMaxSplitCount).toBe(1);

    act(() => {
      result.current.setSplitCount(2);
    });

    expect(result.current.workspace.panes).toHaveLength(1);
  });

  it('shows split control when width is greater than 70% of height while still capping count by phone-like pane aspect', () => {
    const { result } = renderHook(() => useTerminalWorkspace({
      sessions: [makeSession('s1'), makeSession('s2'), makeSession('s3')],
      activeSessionId: 's1',
      viewportWidth: 650,
      viewportHeight: 800,
      maxSplitCount: 4,
    }));

    expect(result.current.splitAvailable).toBe(true);
    expect(result.current.currentMaxSplitCount).toBe(1);
  });

  it('adds newly opened explicit sessions into the single-pane workspace so split actions have real tabs to split', () => {
    const { result, rerender } = renderHook(({ sessions }) => useTerminalWorkspace({
      sessions,
      activeSessionId: 's1',
      viewportWidth: 900,
      viewportHeight: 844,
      maxSplitCount: 4,
    }), {
      initialProps: {
        sessions: [makeSession('s1')] as Session[],
      },
    });

    expect(result.current.workspace.panes).toHaveLength(1);
    expect(result.current.workspace.panes[0]?.tabs.map((tab) => tab.sessionId)).toEqual(['s1']);

    rerender({
      sessions: [makeSession('s1'), makeSession('s2')],
    });

    expect(result.current.workspace.panes).toHaveLength(1);
    expect(result.current.workspace.panes[0]?.tabs.map((tab) => tab.sessionId)).toEqual(['s1', 's2']);

    act(() => {
      result.current.setSplitCount(2);
    });

    expect(result.current.workspace.panes).toHaveLength(2);
  });

  it('keeps the source pane slot when moving the only session into an empty numbered pane', () => {
    const { result } = renderHook(() => useTerminalWorkspace({
      sessions: [makeSession('s1')],
      activeSessionId: 's1',
      viewportWidth: 900,
      viewportHeight: 844,
      maxSplitCount: 4,
    }));

    act(() => {
      result.current.setSplitCount(2);
    });

    expect(result.current.workspace.panes).toHaveLength(2);
    const sourcePaneId = result.current.workspace.panes[0]!.id;
    const emptyPaneId = result.current.workspace.panes[1]!.id;
    expect(result.current.workspace.panes[0]!.tabs.map((tab) => tab.sessionId)).toEqual(['s1']);
    expect(result.current.workspace.panes[1]!.tabs).toEqual([]);

    act(() => {
      result.current.assignSessionToPane('s1', emptyPaneId);
    });

    expect(result.current.workspace.panes.map((pane) => pane.id)).toEqual([sourcePaneId, emptyPaneId]);
    expect(result.current.workspace.panes[0]!.tabs).toEqual([]);
    expect(result.current.workspace.panes[0]!.activeTabId).toBe('');
    expect(result.current.workspace.panes[1]!.tabs.map((tab) => tab.sessionId)).toEqual(['s1']);
    expect(result.current.workspace.activePaneId).toBe(emptyPaneId);
    expect(result.current.splitVisible).toBe(true);
  });

  it('keeps a valid active tab when collapsing after the only session moved into an empty pane', () => {
    const { result } = renderHook(() => useTerminalWorkspace({
      sessions: [makeSession('s1')],
      activeSessionId: 's1',
      viewportWidth: 900,
      viewportHeight: 844,
      maxSplitCount: 4,
    }));

    act(() => {
      result.current.setSplitCount(2);
    });
    const targetPaneId = result.current.workspace.panes[1]!.id;
    act(() => {
      result.current.assignSessionToPane('s1', targetPaneId);
    });
    act(() => {
      result.current.setSplitCount(1);
    });

    expect(result.current.workspace.panes).toHaveLength(1);
    expect(result.current.workspace.panes[0]!.tabs.map((tab) => tab.sessionId)).toEqual(['s1']);
    expect(result.current.workspace.panes[0]!.activeTabId).toBe('tab-s1');
    expect(result.current.activePaneSessionId).toBe('s1');
  });
});
