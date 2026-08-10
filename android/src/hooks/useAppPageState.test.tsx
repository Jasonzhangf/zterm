// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppPageState } from './useAppPageState';
import { STORAGE_KEYS } from '../lib/types';

const appListenerMock = vi.hoisted(() => ({
  backButton: null as null | (() => void),
  exitApp: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (eventName: string, listener: () => void) => {
      if (eventName === 'backButton') {
        appListenerMock.backButton = listener;
      }
      return {
        remove: vi.fn(async () => {
          if (appListenerMock.backButton === listener) {
            appListenerMock.backButton = null;
          }
        }),
      };
    }),
    exitApp: appListenerMock.exitApp,
  },
}));

describe('useAppPageState', () => {
  beforeEach(() => {
    localStorage.clear();
    appListenerMock.backButton = null;
    appListenerMock.exitApp.mockClear();
  });

  const sessionS1 = {
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
  } as any;

  it('returns from settings to connections on the Android back gesture', async () => {
    const { result } = renderHook(() => useAppPageState({
      hosts: [],
      sessions: [],
      runtimeActiveSessionId: null,
      addHost: vi.fn(),
      updateHost: vi.fn(),
      deleteHost: vi.fn(),
      ensureTerminalPageVisible: vi.fn(),
    }));

    act(() => result.current.handleOpenSettingsPage());
    expect(result.current.pageState.kind).toBe('settings');
    await waitFor(() => expect(appListenerMock.backButton).not.toBeNull());

    act(() => appListenerMock.backButton?.());

    expect(result.current.pageState.kind).toBe('connections');
    expect(appListenerMock.exitApp).not.toHaveBeenCalled();
  });

  it('preserves Android exit behavior when the current page does not own back navigation', async () => {
    renderHook(() => useAppPageState({
      hosts: [],
      sessions: [],
      runtimeActiveSessionId: null,
      addHost: vi.fn(),
      updateHost: vi.fn(),
      deleteHost: vi.fn(),
      ensureTerminalPageVisible: vi.fn(),
    }));

    await waitFor(() => expect(appListenerMock.backButton).not.toBeNull());
    act(() => appListenerMock.backButton?.());

    expect(appListenerMock.exitApp).toHaveBeenCalledTimes(1);
  });

  it('consumes Android system back on the terminal page so the drawer edge cannot exit the app', async () => {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal' }));
    const { result } = renderHook(() => useAppPageState({
      hosts: [],
      sessions: [sessionS1],
      runtimeActiveSessionId: 's1',
      addHost: vi.fn(),
      updateHost: vi.fn(),
      deleteHost: vi.fn(),
      ensureTerminalPageVisible: vi.fn(),
    }));

    expect(result.current.pageState.kind).toBe('terminal');
    await waitFor(() => expect(appListenerMock.backButton).not.toBeNull());
    act(() => appListenerMock.backButton?.());

    expect(result.current.pageState.kind).toBe('terminal');
    expect(appListenerMock.exitApp).not.toHaveBeenCalled();
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

    const { result } = renderHook(() => useAppPageState({
      hosts: [],
      sessions: [sessionS1],
      runtimeActiveSessionId: 's1',
      addHost: vi.fn(),
      updateHost: vi.fn(),
      deleteHost: vi.fn(),
      ensureTerminalPageVisible,
    }));

    expect(result.current.pageState.kind).toBe('terminal');
    expect(ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVE_PAGE) || '{}')).toEqual({
      kind: 'terminal',
    });
  });

  it('does not restore terminal when the active runtime id is stale', () => {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal' }));
    const ensureTerminalPageVisible = vi.fn();

    const { result } = renderHook(() => useAppPageState({
      hosts: [],
      sessions: [sessionS1],
      runtimeActiveSessionId: 'stale-session',
      addHost: vi.fn(),
      updateHost: vi.fn(),
      deleteHost: vi.fn(),
      ensureTerminalPageVisible,
    }));

    expect(result.current.pageState.kind).toBe('connections');
    expect(ensureTerminalPageVisible).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVE_PAGE) || '{}')).toEqual({
      kind: 'connections',
    });
  });

  it('preserves a pending terminal route while persisted tabs hydrate into a runtime session', async () => {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal' }));
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify([{
      sessionId: 's1',
      hostId: 'host-s1',
      connectionName: 'Mac Studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      sessionName: 'freehand',
      createdAt: 1,
    }]));
    const ensureTerminalPageVisible = vi.fn();

    const { result, rerender } = renderHook(
      ({ sessions, runtimeActiveSessionId }) => useAppPageState({
        hosts: [],
        sessions,
        runtimeActiveSessionId,
        addHost: vi.fn(),
        updateHost: vi.fn(),
        deleteHost: vi.fn(),
        ensureTerminalPageVisible,
      }),
      {
        initialProps: {
          sessions: [] as any[],
          runtimeActiveSessionId: null as string | null,
        },
      },
    );

    expect(result.current.pageState.kind).toBe('terminal');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVE_PAGE) || '{}')).toEqual({
      kind: 'terminal',
    });

    rerender({ sessions: [sessionS1], runtimeActiveSessionId: 's1' });

    await waitFor(() => {
      expect(result.current.pageState.kind).toBe('terminal');
      expect(ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVE_PAGE) || '{}')).toEqual({
      kind: 'terminal',
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
