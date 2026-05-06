// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionHistoryStorage } from './useSessionHistoryStorage';

describe('useSessionHistoryStorage daemon-first truth', () => {
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

  it('collapses server groups by daemonHostId even when bridge endpoints differ', () => {
    const { result } = renderHook(() => useSessionHistoryStorage());

    act(() => {
      result.current.recordSessionGroupOpen({
        name: 'Daemon A / main',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        authToken: 'token-a',
        sessionNames: ['main'],
      });
    });

    act(() => {
      result.current.recordSessionGroupOpen({
        name: 'Daemon A / logs',
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
        daemonHostId: 'daemon-host-a',
        authToken: 'token-a',
        sessionNames: ['logs'],
      });
    });

    expect(result.current.sessionGroups).toHaveLength(1);
    expect(result.current.sessionGroups[0]).toEqual(
      expect.objectContaining({
        id: 'daemon:daemon-host-a',
        daemonHostId: 'daemon-host-a',
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
      }),
    );
  });

  it('keeps different daemonHostId groups separate even when bridge endpoint matches', () => {
    const { result } = renderHook(() => useSessionHistoryStorage());

    act(() => {
      result.current.recordSessionGroupOpen({
        name: 'Daemon A',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        authToken: 'token-a',
        sessionNames: ['main'],
      });
    });

    act(() => {
      result.current.recordSessionGroupOpen({
        name: 'Daemon B',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-b',
        authToken: 'token-a',
        sessionNames: ['logs'],
      });
    });

    expect(result.current.sessionGroups).toHaveLength(2);
    expect(result.current.sessionGroups.map((item) => item.id).sort()).toEqual([
      'daemon:daemon-host-a',
      'daemon:daemon-host-b',
    ]);
  });

  it('collapses old bridge-only group and later daemon-owned group for the same endpoint into one server truth', () => {
    const { result } = renderHook(() => useSessionHistoryStorage());

    act(() => {
      result.current.recordSessionGroupOpen({
        name: 'Bridge only',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        authToken: 'token-a',
        sessionNames: ['zterm'],
      });
    });

    act(() => {
      result.current.recordSessionGroupOpen({
        name: 'Daemon owned',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'daemon-Macstudio.local-128564413166185f',
        authToken: 'token-a',
        sessionNames: ['zterm'],
      });
    });

    expect(result.current.sessionGroups).toHaveLength(1);
    expect(result.current.sessionGroups[0]).toEqual(
      expect.objectContaining({
        id: 'daemon:daemon-Macstudio.local-128564413166185f',
        daemonHostId: 'daemon-Macstudio.local-128564413166185f',
      }),
    );
  });
});
