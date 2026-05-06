// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useHostStorage } from './useHostStorage';

describe('useHostStorage daemon-first truth', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, String(value));
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
    });
  });

  it('upserts by daemonHostId + sessionName even if bridge endpoint changed', () => {
    const { result } = renderHook(() => useHostStorage());

    act(() => {
      result.current.upsertHost({
        name: 'Mac A',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-1',
        sessionName: 'main',
        authToken: 'token-a',
        relayHostId: undefined,
        relayDeviceId: undefined,
        tailscaleHost: undefined,
        ipv6Host: undefined,
        ipv4Host: undefined,
        signalUrl: undefined,
        transportMode: 'auto',
        authType: 'password',
        password: undefined,
        privateKey: undefined,
        tags: [],
        pinned: false,
        autoCommand: '',
        lastConnected: 1,
      });
    });

    act(() => {
      result.current.upsertHost({
        name: 'Mac A relay',
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
        daemonHostId: 'daemon-host-1',
        sessionName: 'main',
        authToken: 'token-b',
        relayHostId: undefined,
        relayDeviceId: undefined,
        tailscaleHost: undefined,
        ipv6Host: undefined,
        ipv4Host: undefined,
        signalUrl: undefined,
        transportMode: 'webrtc',
        authType: 'password',
        password: undefined,
        privateKey: undefined,
        tags: ['relay'],
        pinned: true,
        autoCommand: '',
        lastConnected: 2,
      });
    });

    expect(result.current.hosts).toHaveLength(1);
    expect(result.current.hosts[0]).toEqual(
      expect.objectContaining({
        daemonHostId: 'daemon-host-1',
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
        sessionName: 'main',
        pinned: true,
      }),
    );
  });

  it('keeps different daemonHostId hosts separate even when bridge endpoint and sessionName match', () => {
    const { result } = renderHook(() => useHostStorage());

    act(() => {
      result.current.upsertHost({
        name: 'Daemon A',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        sessionName: 'main',
        authToken: 'token-a',
        relayHostId: undefined,
        relayDeviceId: undefined,
        tailscaleHost: undefined,
        ipv6Host: undefined,
        ipv4Host: undefined,
        signalUrl: undefined,
        transportMode: 'auto',
        authType: 'password',
        password: undefined,
        privateKey: undefined,
        tags: [],
        pinned: false,
        autoCommand: '',
        lastConnected: 1,
      });
    });

    act(() => {
      result.current.upsertHost({
        name: 'Daemon B',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-b',
        sessionName: 'main',
        authToken: 'token-a',
        relayHostId: undefined,
        relayDeviceId: undefined,
        tailscaleHost: undefined,
        ipv6Host: undefined,
        ipv4Host: undefined,
        signalUrl: undefined,
        transportMode: 'auto',
        authType: 'password',
        password: undefined,
        privateKey: undefined,
        tags: [],
        pinned: false,
        autoCommand: '',
        lastConnected: 1,
      });
    });

    expect(result.current.hosts).toHaveLength(2);
    expect(result.current.hosts.map((item) => item.daemonHostId).sort()).toEqual([
      'daemon-host-a',
      'daemon-host-b',
    ]);
  });
});
