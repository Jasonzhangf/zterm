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
      result.current.setSessionGroupSelection({
        name: 'Daemon A / main',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        authToken: 'token-a',
        sessionNames: ['main'],
      });
    });

    act(() => {
      result.current.setSessionGroupSelection({
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
      result.current.setSessionGroupSelection({
        name: 'Daemon A',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        authToken: 'token-a',
        sessionNames: ['main'],
      });
    });

    act(() => {
      result.current.setSessionGroupSelection({
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
      result.current.setSessionGroupSelection({
        name: 'Bridge only',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        authToken: 'token-a',
        sessionNames: ['zterm'],
      });
    });

    act(() => {
      result.current.setSessionGroupSelection({
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

  it('marks missing stored session names against remote tmux truth for the matching server only', () => {
    const { result } = renderHook(() => useSessionHistoryStorage());

    act(() => {
      result.current.setSessionGroupSelection({
        name: 'Daemon A',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        authToken: 'token-a',
        sessionNames: ['main', 'logs', 'stale'],
      });
      result.current.setSessionGroupSelection({
        name: 'Daemon B',
        bridgeHost: '100.64.0.11',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-b',
        authToken: 'token-b',
        sessionNames: ['other'],
      });
    });

    act(() => {
      result.current.pruneSessionGroupSelectionToRemoteTruth(
        {
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          daemonHostId: 'daemon-host-a',
        },
        ['logs', 'main', 'logs'],
      );
    });

    expect(result.current.sessionGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        daemonHostId: 'daemon-host-a',
        sessionNames: ['logs', 'main', 'stale'],
        missingSessionNames: ['stale'],
      }),
      expect.objectContaining({ daemonHostId: 'daemon-host-b', sessionNames: ['other'] }),
    ]));
  });

  it('marks all stored session names missing when remote tmux truth no longer contains any selected session', () => {
    const { result } = renderHook(() => useSessionHistoryStorage());

    act(() => {
      result.current.setSessionGroupSelection({
        name: 'Daemon A',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        authToken: 'token-a',
        sessionNames: ['stale'],
      });
    });

    act(() => {
      result.current.pruneSessionGroupSelectionToRemoteTruth(
        {
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          daemonHostId: 'daemon-host-a',
        },
        [],
      );
    });

    expect(result.current.sessionGroups).toEqual([
      expect.objectContaining({
        daemonHostId: 'daemon-host-a',
        sessionNames: ['stale'],
        missingSessionNames: ['stale'],
      }),
    ]);
  });

  it('deletes a stored server group explicitly and persists the removal', () => {
    const { result } = renderHook(() => useSessionHistoryStorage());

    act(() => {
      result.current.setSessionGroupSelection({
        name: 'Daemon A',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        authToken: 'token-a',
        sessionNames: ['main', 'logs'],
      });
      result.current.setSessionGroupSelection({
        name: 'Daemon B',
        bridgeHost: '100.64.0.11',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-b',
        authToken: 'token-b',
        sessionNames: ['other'],
      });
    });

    act(() => {
      result.current.deleteSessionGroup({
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
      });
    });

    expect(result.current.sessionGroups).toEqual([
      expect.objectContaining({
        daemonHostId: 'daemon-host-b',
        sessionNames: ['other'],
      }),
    ]);
    expect(JSON.parse(window.localStorage.getItem('zterm:session-groups') || '[]')).toEqual([
      expect.objectContaining({
        daemonHostId: 'daemon-host-b',
        sessionNames: ['other'],
      }),
    ]);
  });
});
