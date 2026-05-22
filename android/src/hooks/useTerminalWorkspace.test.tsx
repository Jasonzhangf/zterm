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
      updateKind: 'replace',
      revision: 1,
    },
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

  it('caps pane count so each averaged pane stays close to phone width/height', () => {
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

    expect(result.current.currentMaxSplitCount).toBe(3);
    expect(result.current.workspace.panes).toHaveLength(3);

    rerender({ viewportHeight: 620 });

    expect(result.current.currentMaxSplitCount).toBe(3);
    expect(result.current.workspace.panes).toHaveLength(3);
    expect(result.current.workspace.panes.map((pane) => pane.size)).toEqual([1 / 3, 1 / 3, 1 / 3]);
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
});
