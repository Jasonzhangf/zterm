// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAppPageState } from './useAppPageState';

describe('useAppPageState', () => {
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
