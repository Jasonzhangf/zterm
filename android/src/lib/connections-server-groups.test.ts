import { describe, expect, it, vi } from 'vitest';
import { buildConnectionsServerGroups } from './connections-server-groups';
import { TraversalRouteHealthCache } from './traversal/route-health-cache';
import type { Host, Session, SessionGroupHistory, TraversalRelayDeviceSnapshot } from './types';
import type { TraversalPlanCandidate } from './traversal/types';

function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: overrides.id || 'host-1',
    createdAt: overrides.createdAt || 1,
    name: overrides.name || 'Main Host',
    bridgeHost: overrides.bridgeHost || '100.64.0.10',
    bridgePort: overrides.bridgePort || 3333,
    daemonHostId: overrides.daemonHostId,
    relayHostId: overrides.relayHostId,
    sessionName: overrides.sessionName || 'main',
    authType: overrides.authType || 'password',
    tags: overrides.tags || [],
    pinned: overrides.pinned || false,
    authToken: overrides.authToken || 'token-a',
    lastConnected: overrides.lastConnected || 10,
    transportMode: overrides.transportMode || 'auto',
    password: overrides.password,
    privateKey: overrides.privateKey,
    autoCommand: overrides.autoCommand,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id || 'session-1',
    hostId: overrides.hostId || 'host-1',
    connectionName: overrides.connectionName || 'Main Host',
    bridgeHost: overrides.bridgeHost || '100.64.0.10',
    bridgePort: overrides.bridgePort || 3333,
    daemonHostId: overrides.daemonHostId,
    sessionName: overrides.sessionName || 'logs',
    authToken: overrides.authToken || 'token-a',
    title: overrides.title || 'logs',
    ws: null,
    state: overrides.state || 'connected',
    hasUnread: overrides.hasUnread || false,
    createdAt: overrides.createdAt || 20,
    buffer: overrides.buffer || {
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

function makeGroup(overrides: Partial<SessionGroupHistory> = {}): SessionGroupHistory {
  return {
    id: overrides.id || 'group-1',
    name: overrides.name || 'server group',
    bridgeHost: overrides.bridgeHost || '100.64.0.10',
    bridgePort: overrides.bridgePort || 3333,
    daemonHostId: overrides.daemonHostId,
    authToken: overrides.authToken || 'token-a',
    sessionNames: overrides.sessionNames || ['main', 'logs'],
    missingSessionNames: overrides.missingSessionNames || [],
    lastOpenedAt: overrides.lastOpenedAt || 30,
  };
}

function makeRelayDevice(overrides: Partial<TraversalRelayDeviceSnapshot> = {}): TraversalRelayDeviceSnapshot {
  return {
    deviceId: overrides.deviceId || 'mac-studio-device',
    deviceName: overrides.deviceName || 'mac-studio',
    platform: overrides.platform || 'mac',
    appVersion: overrides.appVersion || '0.1.2',
    updatedAt: overrides.updatedAt || '2026-05-29T00:00:00.000Z',
    client: overrides.client || { connected: false, lastSeenAt: '' },
    daemon: overrides.daemon || {
      connected: true,
      lastSeenAt: '2026-05-29T00:00:00.000Z',
      hostId: 'mac-studio',
      version: '0.1.2',
    },
  };
}

describe('buildConnectionsServerGroups', () => {
  it('does not create host-only groups without session-group or live runtime truth', () => {
    expect(buildConnectionsServerGroups({
      hosts: [
        makeHost({ id: 'host-stale', daemonHostId: 'daemon-host-1', sessionName: 'stale' }),
      ],
      sessions: [],
      sessionGroups: [],
    })).toEqual([]);
  });

  it('groups by daemonHostId first even when bridge endpoint differs', () => {
    const groups = buildConnectionsServerGroups({
      hosts: [
        makeHost({ id: 'host-main', bridgeHost: '100.64.0.10', bridgePort: 3333, daemonHostId: 'daemon-host-1', sessionName: 'main' }),
        makeHost({ id: 'host-logs', bridgeHost: '100.127.23.27', bridgePort: 4444, daemonHostId: 'daemon-host-1', sessionName: 'logs' }),
      ],
      sessions: [],
      sessionGroups: [
        makeGroup({ daemonHostId: 'daemon-host-1', bridgeHost: '100.64.0.10', bridgePort: 3333, sessionNames: ['main', 'logs'] }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: 'daemon:daemon-host-1',
      daemonHostId: 'daemon-host-1',
      bridgeHost: '100.64.0.10',
    });
    expect(groups[0]?.sessions.map((entry) => entry.sessionName)).toEqual(['logs', 'main']);
  });


  it('prefers the newer session-group daemon endpoint over a stale saved host endpoint for the same daemon owner', () => {
    const groups = buildConnectionsServerGroups({
      hosts: [
        makeHost({
          id: 'host-stale',
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          daemonHostId: 'daemon-host-1',
          sessionName: 'main',
          lastConnected: 1,
        }),
      ],
      sessions: [],
      sessionGroups: [
        makeGroup({
          daemonHostId: 'daemon-host-1',
          bridgeHost: '100.127.23.27',
          bridgePort: 4444,
          sessionNames: ['main'],
          lastOpenedAt: 99,
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      daemonHostId: 'daemon-host-1',
      bridgeHost: '100.127.23.27',
      bridgePort: 4444,
    });
  });


  it('prefers the newer daemon auth token over a stale saved host token for the same owner', () => {
    const groups = buildConnectionsServerGroups({
      hosts: [
        makeHost({
          id: 'host-stale',
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          daemonHostId: 'daemon-host-1',
          authToken: 'token-stale',
          sessionName: 'main',
          lastConnected: 1,
        }),
      ],
      sessions: [],
      sessionGroups: [
        makeGroup({
          daemonHostId: 'daemon-host-1',
          bridgeHost: '100.127.23.27',
          bridgePort: 4444,
          authToken: 'token-fresh',
          sessionNames: ['main'],
          lastOpenedAt: 99,
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      daemonHostId: 'daemon-host-1',
      authToken: 'token-fresh',
    });
  });

  it('collapses bridge-history and daemon-live entries for the same server into one card', () => {
    const groups = buildConnectionsServerGroups({
      hosts: [
        makeHost({
          id: 'host-main',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          sessionName: 'zterm',
        }),
      ],
      sessions: [
        makeSession({
          id: 'live-zterm',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          daemonHostId: 'daemon-Macstudio.local-128564413166185f',
          sessionName: 'zterm',
        }),
      ],
      sessionGroups: [
        makeGroup({
          id: 'bridge:100.66.1.82::3333',
          name: '100.66.1.82 · 1 tabs',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          sessionNames: ['zterm'],
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      daemonHostId: 'daemon-Macstudio.local-128564413166185f',
    });
    expect(groups[0]?.sessions).toHaveLength(1);
  });


  it('upgrades a bridge-only group id to the daemon key once daemon truth arrives', () => {
    const groups = buildConnectionsServerGroups({
      hosts: [
        makeHost({
          id: 'host-main',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          sessionName: 'zterm',
        }),
      ],
      sessions: [
        makeSession({
          id: 'live-zterm',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          daemonHostId: 'daemon-Macstudio.local-128564413166185f',
          sessionName: 'zterm',
        }),
      ],
      sessionGroups: [
        makeGroup({
          id: 'bridge:100.66.1.82::3333',
          name: '100.66.1.82 · 1 tabs',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          sessionNames: ['zterm'],
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe('daemon:daemon-Macstudio.local-128564413166185f');
  });

  it('uses account relay daemon devices as parent truth and folds legacy daemon ids into the same device card', () => {
    const groups = buildConnectionsServerGroups({
      relayDevices: [makeRelayDevice()],
      hosts: [
        makeHost({
          id: 'host-main',
          name: 'mac-studio main',
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          daemonHostId: 'mac-studio',
          sessionName: 'main',
        }),
      ],
      sessions: [
        makeSession({
          id: 'legacy-live',
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          daemonHostId: 'daemon-Macstudio.local-128564413166185f',
          sessionName: 'demo',
        }),
      ],
      sessionGroups: [
        makeGroup({
          daemonHostId: 'mac-studio',
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          sessionNames: ['main'],
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: 'daemon:mac-studio',
      name: 'mac-studio',
      daemonHostId: 'mac-studio',
    });
    expect(groups[0]?.sessions.map((entry) => entry.sessionName).sort()).toEqual(['demo', 'main']);
  });

  it('keeps recently disconnected account daemon devices visible before sessions are known', () => {
    const groups = buildConnectionsServerGroups({
      relayDevices: [
        makeRelayDevice({
          deviceId: 'mac-air-device',
          deviceName: 'macbook-air',
          daemon: {
            connected: false,
            lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
            hostId: 'macbook-air',
            version: '0.1.2',
          },
        }),
      ],
      hosts: [],
      sessions: [],
      sessionGroups: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      name: 'macbook-air',
      daemonHostId: 'macbook-air',
      daemonConnected: false,
      sessions: [],
    });
  });

  it('projects relay directory sessions and endpoint candidates without requiring a saved host', () => {
    const groups = buildConnectionsServerGroups({
      relayDevices: [
        makeRelayDevice({
          deviceId: 'relay-device-a',
          deviceName: 'relay-mac',
          daemon: {
            connected: true,
            lastSeenAt: '2026-06-28T00:00:00.000Z',
            hostId: 'relay-daemon-a',
            version: '0.1.3',
            endpoints: [
              {
                id: 'direct:tailscale:relay-daemon-a',
                kind: 'tailscale',
                host: 'relay-mac.tailnet.ts.net',
                port: 3333,
                authRequired: true,
                lastSeenAt: '2026-06-28T00:00:00.000Z',
              },
            ],
            sessions: [
              {
                name: 'main',
                cwd: '/Users/jason/project',
                title: 'main',
                updatedAt: '2026-06-28T00:00:00.000Z',
              },
            ],
          },
        }),
      ],
      hosts: [],
      sessions: [],
      sessionGroups: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: 'daemon:relay-daemon-a',
      relayDeviceTruth: true,
      relayEndpointCandidates: [
        expect.objectContaining({ id: 'direct:tailscale:relay-daemon-a' }),
      ],
      openableSessions: ['main'],
      defaultSessionNames: ['main'],
    });
    expect(groups[0]?.sessions[0]).toMatchObject({
      sessionName: 'main',
      missingFromRemoteTruth: false,
    });
  });

  it('projects explainable route diagnostics from directory candidates and route health', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cache = new TraversalRouteHealthCache({ now: () => 1000 });
    const relayCandidate = {
      id: 'relay-rtc:relay-daemon-a',
      kind: 'rtc',
      path: 'rtc-relay',
      endpoint: 'relay-daemon-a',
      signalUrl: 'wss://relay.example/ws/client?hostId=relay-daemon-a',
      iceServers: [],
    } satisfies TraversalPlanCandidate;
    const tailscaleCandidate = {
      id: 'direct:tailscale:relay-daemon-a',
      kind: 'ws',
      path: 'tailscale',
      endpoint: 'relay-mac.tailnet.ts.net',
      url: 'ws://relay-mac.tailnet.ts.net',
    } satisfies TraversalPlanCandidate;
    cache.recordSuccess({ accountId: 'user-a', daemonHostId: 'relay-daemon-a' }, relayCandidate, 132);
    cache.recordFailure({ accountId: 'user-a', daemonHostId: 'relay-daemon-a' }, tailscaleCandidate, 'timeout');

    const groups = buildConnectionsServerGroups({
      accountId: 'user-a',
      routeHealthCache: cache,
      traversalPathPriority: ['tailscale', 'rtc-relay', 'ipv4'],
      relayDevices: [
        makeRelayDevice({
          deviceId: 'relay-device-a',
          deviceName: 'relay-mac',
          daemon: {
            connected: true,
            lastSeenAt: '2026-06-28T00:00:00.000Z',
            hostId: 'relay-daemon-a',
            version: '0.1.3',
            endpoints: [
              {
                id: 'direct:tailscale:relay-daemon-a',
                kind: 'tailscale',
                host: 'relay-mac.tailnet.ts.net',
                port: 3333,
                authRequired: true,
                lastSeenAt: '2026-06-28T00:00:00.000Z',
              },
              {
                id: 'relay-rtc:relay-daemon-a',
                kind: 'relay-rtc',
                relayHostId: 'relay-daemon-a',
                authRequired: true,
                lastSeenAt: '2026-06-28T00:00:00.000Z',
              },
            ],
            sessions: [
              {
                name: 'main',
                updatedAt: '2026-06-28T00:00:00.000Z',
              },
            ],
          },
        }),
      ],
      hosts: [],
      sessions: [],
      sessionGroups: [],
    });

    expect(groups[0]?.routeDiagnostics).toMatchObject({
      badge: 'Route Relay RTC',
      selectedPath: 'rtc-relay',
      selectedCandidateId: 'relay-rtc:relay-daemon-a',
      selectedRttLabel: '132ms',
      lastSuccessLabel: 'just now',
      lastErrorLabel: 'timeout · just now',
    });
    expect(groups[0]?.routeDiagnostics?.attempts.find((item) => item.candidateId === 'direct:tailscale:relay-daemon-a')).toMatchObject({
      selectable: false,
      health: { status: 'failure' },
    });
    vi.useRealTimers();
  });

  it('removes stale offline account daemon zombies when they have no child sessions', () => {
    const groups = buildConnectionsServerGroups({
      relayDevices: [
        makeRelayDevice({
          deviceId: 'remote-smoke-device',
          deviceName: 'remote-smoke-daemon',
          daemon: {
            connected: false,
            lastSeenAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
            hostId: 'remote-smoke-daemon',
            version: '0.1.2',
          },
        }),
      ],
      hosts: [],
      sessions: [],
      sessionGroups: [],
    });

    expect(groups).toEqual([]);
  });

  it('merges a stale bridge-only history group into an existing daemon-owned host group for the same saved session instead of showing a second stale card', () => {
    const groups = buildConnectionsServerGroups({
      hosts: [
        makeHost({
          id: 'host-main',
          name: 'Fresh Main Host',
          bridgeHost: '100.127.23.27',
          bridgePort: 4444,
          daemonHostId: 'daemon-host-1',
          authToken: 'token-fresh',
          sessionName: 'main',
          lastConnected: 100,
        }),
      ],
      sessions: [],
      sessionGroups: [
        makeGroup({
          id: 'bridge:100.64.0.10::3333',
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          authToken: 'token-stale',
          sessionNames: ['main'],
          lastOpenedAt: 99,
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: 'daemon:daemon-host-1',
      daemonHostId: 'daemon-host-1',
      bridgeHost: '100.127.23.27',
      bridgePort: 4444,
    });
    expect(groups[0]?.sessions).toHaveLength(1);
    expect(groups[0]?.sessions[0]).toMatchObject({
      sessionName: 'main',
      source: 'saved',
      host: expect.objectContaining({
        id: 'host-main',
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
      }),
    });
  });


  it('prefers the saved host candidate that matches the current daemon target for the same session row', () => {
    const groups = buildConnectionsServerGroups({
      hosts: [
        makeHost({
          id: 'host-stale',
          name: 'Old Main Host',
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          daemonHostId: 'daemon-host-1',
          authToken: 'token-stale',
          sessionName: 'main',
          lastConnected: 200,
        }),
        makeHost({
          id: 'host-fresh',
          name: 'Fresh Main Host',
          bridgeHost: '100.127.23.27',
          bridgePort: 4444,
          daemonHostId: 'daemon-host-1',
          authToken: 'token-fresh',
          sessionName: 'main',
          lastConnected: 100,
        }),
      ],
      sessions: [],
      sessionGroups: [
        makeGroup({
          daemonHostId: 'daemon-host-1',
          bridgeHost: '100.127.23.27',
          bridgePort: 4444,
          authToken: 'token-fresh',
          sessionNames: ['main'],
          lastOpenedAt: 99,
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions[0]).toMatchObject({
      sessionName: 'main',
      source: 'saved',
      host: expect.objectContaining({
        id: 'host-fresh',
        name: 'Fresh Main Host',
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
        authToken: 'token-fresh',
      }),
    });
    expect(groups[0]?.defaultSessionNames).toEqual(['main']);
    expect(groups[0]?.openableSessions).toEqual(['main']);
  });


  it('keeps the fresh matching row host even when a stale saved host is processed later in the hosts list', () => {
    const groups = buildConnectionsServerGroups({
      hosts: [
        makeHost({
          id: 'host-fresh',
          name: 'Fresh Main Host',
          bridgeHost: '100.127.23.27',
          bridgePort: 4444,
          daemonHostId: 'daemon-host-1',
          authToken: 'token-fresh',
          sessionName: 'main',
          lastConnected: 100,
        }),
        makeHost({
          id: 'host-stale',
          name: 'Old Main Host',
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          daemonHostId: 'daemon-host-1',
          authToken: 'token-stale',
          sessionName: 'main',
          lastConnected: 200,
        }),
      ],
      sessions: [],
      sessionGroups: [
        makeGroup({
          daemonHostId: 'daemon-host-1',
          bridgeHost: '100.127.23.27',
          bridgePort: 4444,
          authToken: 'token-fresh',
          sessionNames: ['main'],
          lastOpenedAt: 99,
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions[0]?.host).toMatchObject({
      id: 'host-fresh',
      name: 'Fresh Main Host',
      bridgeHost: '100.127.23.27',
      bridgePort: 4444,
      authToken: 'token-fresh',
    });
  });

  it('marks history-only groups as not openable', () => {
    const groups = buildConnectionsServerGroups({
      hosts: [],
      sessions: [],
      sessionGroups: [
        makeGroup({
          daemonHostId: 'daemon-host-1',
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          sessionNames: ['gone-a', 'gone-b'],
          lastOpenedAt: Date.now() - 60_000,
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.openableSessions).toEqual([]);
    expect(groups[0]?.sessions.map((entry) => entry.source)).toEqual(['history', 'history']);
  });
});
