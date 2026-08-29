// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionHistoryStorage } from './useSessionHistoryStorage';
import type { TraversalRelayDeviceSnapshot } from '../lib/types';

describe('useSessionHistoryStorage daemon-first truth', () => {
  const canonicalRelayDevice = (): TraversalRelayDeviceSnapshot => {
    const now = new Date().toISOString();
    return {
      deviceId: 'mac-studio',
      deviceName: 'Mac Studio',
      platform: 'darwin',
      appVersion: '0.1.3',
      updatedAt: now,
      client: { connected: false, lastSeenAt: now },
      daemon: {
        connected: true,
        lastSeenAt: now,
        hostId: 'mac-studio',
        version: '0.1.3',
        endpoints: [
          {
            id: 'lan:192.168.0.3:3333',
            kind: 'lan',
            host: '192.168.0.3',
            port: 3333,
            authToken: 'token-a',
            authRequired: true,
            lastSeenAt: now,
          },
          {
            id: 'relay-rtc:mac-studio',
            kind: 'relay-rtc',
            relayHostId: 'mac-studio',
            authToken: 'token-a',
            authRequired: true,
            lastSeenAt: now,
          },
        ],
        sessions: [],
      },
    };
  };

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

  it('normalizes legacy Herdr groups into one tmux group for the same daemon and endpoint', () => {
    const { result } = renderHook(() => useSessionHistoryStorage());

    act(() => {
      result.current.setSessionGroupSelection({
        name: 'Daemon A tmux',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        terminalBackend: 'tmux',
        sessionNames: ['shared'],
      });
      result.current.setSessionGroupSelection({
        name: 'Daemon A Herdr',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        terminalBackend: 'herdr',
        sessionNames: ['shared'],
      });
    });

    expect(result.current.sessionGroups).toHaveLength(1);
    expect(result.current.sessionGroups[0]).toEqual(expect.objectContaining({
      terminalBackend: 'tmux',
      sessionNames: ['shared'],
    }));
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

  it('preserves relay endpoint candidates on stored session group truth', () => {
    const { result } = renderHook(() => useSessionHistoryStorage());
    const relayEndpointCandidates = [{
      id: 'relay-rtc:daemon-host-a',
      kind: 'relay-rtc' as const,
      relayHostId: 'daemon-host-a',
      authRequired: true,
      lastSeenAt: '2026-07-17T00:00:00.000Z',
    }];

    act(() => {
      result.current.setSessionGroupSelection({
        name: 'Daemon A',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        authToken: 'token-a',
        relayEndpointCandidates,
        sessionNames: ['rcc'],
      });
    });

    expect(result.current.sessionGroups[0]).toEqual(expect.objectContaining({
      daemonHostId: 'daemon-host-a',
      relayEndpointCandidates: [
        expect.objectContaining({
          id: 'relay-rtc:daemon-host-a',
          kind: 'relay-rtc',
          relayHostId: 'daemon-host-a',
        }),
      ],
    }));
    expect(JSON.parse(window.localStorage.getItem('zterm:session-groups') || '[]')[0]).toEqual(expect.objectContaining({
      relayEndpointCandidates: [
        expect.objectContaining({
          id: 'relay-rtc:daemon-host-a',
          kind: 'relay-rtc',
          relayHostId: 'daemon-host-a',
        }),
      ],
    }));
  });

  it('merges stale and canonical session groups after relay device truth arrives', async () => {
    window.localStorage.setItem('zterm:session-groups', JSON.stringify([
      {
        id: 'daemon:daemon-old',
        name: '10.0.2.2',
        bridgeHost: '10.0.2.2',
        bridgePort: 3333,
        daemonHostId: 'daemon-old',
        terminalBackend: 'tmux',
        authToken: 'token-a',
        sessionNames: ['zterm-drawer-b'],
        missingSessionNames: ['zterm-drawer-b'],
        lastOpenedAt: 1,
      },
      {
        id: 'daemon:mac-studio',
        name: '192.168.0.3',
        bridgeHost: '192.168.0.3',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        terminalBackend: 'tmux',
        authToken: 'token-a',
        sessionNames: ['zterm'],
        missingSessionNames: [],
        lastOpenedAt: 2,
      },
    ]));

    const { result } = renderHook(() => useSessionHistoryStorage([canonicalRelayDevice()]));

    await waitFor(() => {
      expect(result.current.sessionGroups).toEqual([
        expect.objectContaining({
          id: 'daemon:mac-studio',
          daemonHostId: 'mac-studio',
          sessionNames: expect.arrayContaining(['zterm', 'zterm-drawer-b']),
          missingSessionNames: ['zterm-drawer-b'],
        }),
      ]);
    });

    const persisted = JSON.parse(window.localStorage.getItem('zterm:session-groups') || '[]');
    expect(persisted).toEqual([
      expect.objectContaining({
        daemonHostId: 'mac-studio',
        sessionNames: expect.arrayContaining(['zterm', 'zterm-drawer-b']),
      }),
    ]);
  });

  it('keeps stale alias session names when refreshing the canonical group', async () => {
    window.localStorage.setItem('zterm:session-groups', JSON.stringify([
      {
        id: 'daemon:daemon-old',
        name: '10.0.2.2',
        bridgeHost: '10.0.2.2',
        bridgePort: 3333,
        daemonHostId: 'daemon-old',
        terminalBackend: 'tmux',
        authToken: 'token-a',
        sessionNames: ['zterm-drawer-b'],
        missingSessionNames: [],
        lastOpenedAt: 1,
      },
      {
        id: 'daemon:mac-studio',
        name: '192.168.0.3',
        bridgeHost: '192.168.0.3',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        terminalBackend: 'tmux',
        authToken: 'token-a',
        sessionNames: ['zterm'],
        missingSessionNames: [],
        lastOpenedAt: 2,
      },
    ]));

    const { result } = renderHook(() => useSessionHistoryStorage([canonicalRelayDevice()]));
    await waitFor(() => {
      expect(result.current.sessionGroups).toHaveLength(1);
    });

    act(() => {
      result.current.setSessionGroupSelection({
        name: '192.168.0.3',
        bridgeHost: '192.168.0.3',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        terminalBackend: 'tmux',
        authToken: 'token-a',
        sessionNames: ['zterm'],
      });
    });

    expect(result.current.sessionGroups[0]).toEqual(expect.objectContaining({
      daemonHostId: 'mac-studio',
      sessionNames: expect.arrayContaining(['zterm', 'zterm-drawer-b']),
    }));
  });

  it('records the last entered session for a server group without replacing the catalog', () => {
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
    });

    act(() => {
      result.current.markSessionGroupEntered({
        name: 'Daemon A',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        authToken: 'token-a',
      }, 'logs');
    });

    expect(result.current.sessionGroups[0]).toEqual(expect.objectContaining({
      daemonHostId: 'daemon-host-a',
      sessionNames: ['logs', 'main'],
      lastOpenedSessionName: 'logs',
    }));
    expect(JSON.parse(window.localStorage.getItem('zterm:session-groups') || '[]')[0]).toEqual(expect.objectContaining({
      lastOpenedSessionName: 'logs',
    }));
  });

  it('keeps relay-only daemon session group history when bridgeHost is empty', () => {
    const { result } = renderHook(() => useSessionHistoryStorage());

    act(() => {
      result.current.setSessionGroupSelection({
        name: 'Mac Studio',
        bridgeHost: '',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        relayEndpointCandidates: [{
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
          authRequired: true,
          lastSeenAt: '2026-07-17T00:00:00.000Z',
        }],
        sessionNames: ['zterm'],
        lastOpenedSessionName: 'zterm',
      });
    });

    expect(result.current.sessionGroups).toEqual([
      expect.objectContaining({
        id: 'daemon:mac-studio',
        bridgeHost: '',
        daemonHostId: 'mac-studio',
        sessionNames: ['zterm'],
        lastOpenedSessionName: 'zterm',
      }),
    ]);
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

  it('clears last entered session when remote tmux truth no longer contains it', () => {
    const { result } = renderHook(() => useSessionHistoryStorage());

    act(() => {
      result.current.setSessionGroupSelection({
        name: 'Daemon A',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        authToken: 'token-a',
        sessionNames: ['main', 'logs'],
        lastOpenedSessionName: 'logs',
      });
    });

    act(() => {
      result.current.pruneSessionGroupSelectionToRemoteTruth(
        {
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          daemonHostId: 'daemon-host-a',
        },
        ['main'],
      );
    });

    expect(result.current.sessionGroups[0]).toEqual(expect.objectContaining({
      sessionNames: ['logs', 'main'],
      missingSessionNames: ['logs'],
      lastOpenedSessionName: undefined,
    }));
  });

  it('clears missing markers when a later catalog confirms the sessions again', () => {
    const { result } = renderHook(() => useSessionHistoryStorage());

    act(() => {
      result.current.setSessionGroupSelection({
        name: 'Daemon A',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        sessionNames: ['main', 'logs'],
      });
      result.current.pruneSessionGroupSelectionToRemoteTruth(
        { bridgeHost: '100.64.0.10', bridgePort: 3333, daemonHostId: 'daemon-host-a' },
        [],
      );
      result.current.pruneSessionGroupSelectionToRemoteTruth(
        { bridgeHost: '100.64.0.10', bridgePort: 3333, daemonHostId: 'daemon-host-a' },
        ['main', 'logs'],
      );
    });

    expect(result.current.sessionGroups[0]).toEqual(expect.objectContaining({
      sessionNames: ['logs', 'main'],
      missingSessionNames: [],
    }));
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
