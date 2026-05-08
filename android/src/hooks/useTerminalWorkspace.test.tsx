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

    expect(result.current.findPaneForSession('s3')?.id).toBe('pane-1');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[useTerminalWorkspace] Refused to attach sessions to a missing pane.',
      expect.objectContaining({
        paneId: 'pane-missing',
        sessionIds: ['s3'],
      }),
    );
    consoleErrorSpy.mockRestore();
  });
});
