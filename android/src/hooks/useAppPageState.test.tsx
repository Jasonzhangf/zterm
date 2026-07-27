// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppPageState } from './useAppPageState';
import { STORAGE_KEYS } from '../lib/types';

describe('useAppPageState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('does not cold-restore the terminal page when no runtime session exists', () => {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal' }));

    const { result } = renderHook(() => useAppPageState({
      hosts: [],
      sessions: [],
      runtimeActiveSessionId: null,
      addHost: vi.fn(),
      updateHost: vi.fn(),
      deleteHost: vi.fn(),
      ensureTerminalPageVisible: vi.fn(),
    }));

    expect(result.current.pageState.kind).toBe('connections');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVE_PAGE) || '{}')).toEqual({
      kind: 'connections',
    });
  });

  it('keeps persisted terminal page only when a runtime session can own it', () => {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal' }));
    const ensureTerminalPageVisible = vi.fn();

    renderHook(() => useAppPageState({
      hosts: [],
      sessions: [{
        id: 's1',
        hostId: 'host-s1',
        connectionName: 'Mac Studio',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        sessionName: 'freehand',
        title: 'freehand',
        ws: null,
        state: 'connected',
        hasUnread: false,
        createdAt: 1,
      } as any],
      runtimeActiveSessionId: 's1',
      addHost: vi.fn(),
      updateHost: vi.fn(),
      deleteHost: vi.fn(),
      ensureTerminalPageVisible,
    }));

    expect(ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
    // The hook has no direct page setter in this test; App's
    // ensureTerminalPageVisible callback owns the in-memory route transition.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVE_PAGE) || '{}')).toEqual({
      kind: 'connections',
    });
  });

  it('syncs saved hosts to the server preset owner before returning to connections', () => {
    const addHost = vi.fn((host) => ({
      id: 'host-1',
      createdAt: 123,
      ...host,
    }));
    const syncSavedHostToServerPreset = vi.fn();

    const { result } = renderHook(() => useAppPageState({
      hosts: [],
      sessions: [],
      runtimeActiveSessionId: null,
      addHost,
      updateHost: vi.fn(),
      deleteHost: vi.fn(),
      ensureTerminalPageVisible: vi.fn(),
      syncSavedHostToServerPreset,
    }));

    const hostData = {
      name: 'macbookair',
      connectionName: 'macbookair',
      bridgeHost: '100.86.84.63',
      bridgePort: 3333,
      daemonHostId: 'macbook-air',
      sessionName: 'server',
      authToken: 'token',
      authType: 'password' as const,
      password: undefined,
      privateKey: undefined,
      autoCommand: '',
      tags: [],
      pinned: false,
      lastConnected: undefined,
    };

    act(() => {
      result.current.handleSaveHost(hostData);
    });

    expect(addHost).toHaveBeenCalledWith(hostData);
    expect(syncSavedHostToServerPreset).toHaveBeenCalledWith(hostData);
    expect(result.current.pageState.kind).toBe('connections');
  });
});
