import { describe, expect, it } from 'vitest';
import {
  hasRelayRtcCandidate,
  mergeHostWithLatestProjection,
  projectHomeSavedConnections,
} from './home-connection-projection';
import { DEFAULT_BRIDGE_SETTINGS, type BridgeSettings } from './bridge-settings';
import { buildTraversalPlan } from './traversal/config';
import { buildBridgeTargetFromHost } from './session-picker';
import type { Host, TraversalRelayDeviceSnapshot } from './types';

function makeSavedHost(overrides: Partial<Host> = {}): Host {
  return {
    id: overrides.id || 'saved-mac',
    createdAt: overrides.createdAt || 1,
    name: overrides.name || 'Mac Studio',
    bridgeHost: overrides.bridgeHost ?? '100.66.1.82',
    bridgePort: overrides.bridgePort ?? 3333,
    daemonHostId: overrides.daemonHostId ?? 'mac-studio',
    relayHostId: overrides.relayHostId,
    relayDeviceId: overrides.relayDeviceId,
    sessionName: overrides.sessionName ?? '',
    authToken: overrides.authToken ?? 'token-a',
    relayEndpointCandidates: overrides.relayEndpointCandidates ?? [],
    transportMode: overrides.transportMode,
    authType: 'password',
    password: undefined,
    privateKey: undefined,
    tags: overrides.tags ?? ['tailscale'],
    pinned: overrides.pinned ?? false,
    lastConnected: overrides.lastConnected ?? 10,
    autoCommand: '',
  };
}

function makeRelayDevice(): TraversalRelayDeviceSnapshot {
  const now = new Date().toISOString();
  return {
    deviceId: 'device-mac',
    deviceName: 'Mac Studio Relay',
    platform: 'darwin',
    appVersion: '0.1.3',
    updatedAt: now,
    client: {
      connected: false,
      lastSeenAt: now,
    },
    daemon: {
      connected: true,
      lastSeenAt: now,
      hostId: 'mac-studio',
      version: '0.1.3',
      endpoints: [
        {
          id: 'direct:tailscale:mac-studio',
          kind: 'tailscale',
          host: 'mac-studio.tailnet.ts.net',
          port: 3333,
          authToken: 'daemon-token',
          authRequired: true,
          lastSeenAt: now,
        },
        {
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
          authToken: 'daemon-token',
          authRequired: true,
          lastSeenAt: now,
        },
      ],
      sessions: [],
    },
  };
}

function makeDisconnectedStaleRelayDevice(): TraversalRelayDeviceSnapshot {
  return {
    ...makeRelayDevice(),
    deviceId: 'rtc-device-1784267569532',
    deviceName: 'rtc-device-1784267569532',
    daemon: {
      connected: false,
      lastSeenAt: '2026-07-16T10:00:00.000Z',
      hostId: 'rtc-verify-1784267569532',
      version: '0.1.3',
      endpoints: [{
        id: 'relay-rtc:rtc-verify-1784267569532',
        kind: 'relay-rtc',
        relayHostId: 'rtc-verify-1784267569532',
        authRequired: true,
        lastSeenAt: '2026-07-16T10:00:00.000Z',
      }],
      sessions: [{
        name: 'stale-session',
        updatedAt: '2026-07-16T10:00:00.000Z',
      }],
    },
  };
}

const bridgeSettings: BridgeSettings = {
  ...DEFAULT_BRIDGE_SETTINGS,
  servers: [],
  targetHost: '',
  targetPort: 3333,
  targetAuthToken: '',
};

describe('home connection projection relay route visibility', () => {
  it('merges relay directory candidates into the saved direct row for the same daemon', () => {
    const projected = projectHomeSavedConnections(
      [makeSavedHost()],
      bridgeSettings,
      [makeRelayDevice()],
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]).toEqual(expect.objectContaining({
      id: 'saved-mac',
      name: 'Mac Studio',
      bridgeHost: '100.66.1.82',
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      relayDeviceId: 'device-mac',
    }));
    expect(projected[0].relayEndpointCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tailscale', host: 'mac-studio.tailnet.ts.net' }),
      expect.objectContaining({ kind: 'relay-rtc', relayHostId: 'mac-studio' }),
    ]));
    expect(hasRelayRtcCandidate(projected[0])).toBe(true);
  });

  it('replaces stale saved daemon identity and auth with current exact-endpoint Relay directory truth', () => {
    const projected = projectHomeSavedConnections(
      [makeSavedHost({
        id: 'saved-stale-zterm',
        bridgeHost: 'mac-studio.tailnet.ts.net',
        daemonHostId: 'daemon-old',
        relayHostId: 'daemon-old',
        sessionName: 'zterm',
        authToken: 'token-old',
      })],
      bridgeSettings,
      [makeRelayDevice()],
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]).toEqual(expect.objectContaining({
      id: 'saved-stale-zterm',
      bridgeHost: 'mac-studio.tailnet.ts.net',
      bridgePort: 3333,
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      relayDeviceId: 'device-mac',
      sessionName: 'zterm',
      authToken: 'daemon-token',
    }));
    expect(projected[0].relayEndpointCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'relay-rtc', relayHostId: 'mac-studio' }),
    ]));
  });

  it('projects one canonical Home row when stored bridge presets still use a stale relay host id', () => {
    const relayDevice: TraversalRelayDeviceSnapshot = {
      ...makeRelayDevice(),
      daemon: {
        ...makeRelayDevice().daemon,
        endpoints: (makeRelayDevice().daemon.endpoints || []).map((endpoint) => ({
          ...endpoint,
          authToken: 'token-a',
        })),
      },
    };
    const settings: BridgeSettings = {
      ...bridgeSettings,
      servers: [
        {
          id: '10.0.2.2:3333::daemon:daemon-old',
          name: 'Emulator bridge',
          targetHost: '10.0.2.2',
          targetPort: 3333,
          authToken: 'token-a',
          relayHostId: 'daemon-old',
        },
        {
          id: '192.168.0.3:3333::daemon:mac-studio',
          name: 'Mac Studio',
          targetHost: '192.168.0.3',
          targetPort: 3333,
          authToken: 'token-a',
          relayHostId: 'mac-studio',
          relayDeviceId: 'mac-studio',
        },
      ],
    };

    const projected = projectHomeSavedConnections([], settings, [relayDevice]);

    expect(projected).toHaveLength(1);
    expect(projected[0]).toEqual(expect.objectContaining({
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      relayDeviceId: 'device-mac',
      bridgeHost: '192.168.0.3',
    }));
  });

  it('opens the merged Home server target through the automatic route order', () => {
    const projected = projectHomeSavedConnections(
      [makeSavedHost()],
      bridgeSettings,
      [makeRelayDevice()],
    );

    expect(projected[0]).toEqual(expect.objectContaining({
      id: 'saved-mac',
      name: 'Mac Studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      relayDeviceId: 'device-mac',
    }));
    expect(projected[0].relayEndpointCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tailscale', host: 'mac-studio.tailnet.ts.net' }),
      expect.objectContaining({ kind: 'relay-rtc', relayHostId: 'mac-studio' }),
    ]));
    const routePaths = buildTraversalPlan(
      buildBridgeTargetFromHost(projected[0] as Host),
      {
        ...DEFAULT_BRIDGE_SETTINGS,
        signalUrl: 'wss://relay.example.test/relay/ws/client',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: {
          relayBaseUrl: 'https://relay.example.test/relay/',
          accessToken: 'access-1',
          userId: 'user-1',
          username: 'jason',
          deviceId: 'tablet-1',
          deviceName: 'Jason Tablet',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.example.test/relay/ws/devices',
          wsHostUrl: 'wss://relay.example.test/relay/ws/host',
          wsClientUrl: 'wss://relay.example.test/relay/ws/client',
          turnUrl: 'turn:turn.example.com:3478?transport=udp',
          turnUsername: 'alice',
          turnCredential: 'secret',
          updatedAt: 1,
        },
      },
    ).candidates.map((candidate) => candidate.path);
    expect(routePaths.slice(0, 2)).toEqual(['tailscale', 'tailscale']);
    expect(routePaths.slice(2)).toEqual(['rtc-direct', 'rtc-relay']);
  });

  it('projects logged-in relay directory daemon as Auto route with direct auth on a new device', () => {
    const projected = projectHomeSavedConnections(
      [],
      bridgeSettings,
      [makeRelayDevice()],
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]).toEqual(expect.objectContaining({
      id: 'relay-device:device-mac:mac-studio',
      bridgeHost: 'mac-studio.tailnet.ts.net',
      authToken: 'daemon-token',
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      relayDeviceId: 'device-mac',
      transportMode: 'auto',
    }));
    const plan = buildTraversalPlan(
      buildBridgeTargetFromHost(projected[0] as Host),
      {
        ...DEFAULT_BRIDGE_SETTINGS,
        traversalRelay: {
          relayBaseUrl: 'https://relay.example.test/relay/',
          accessToken: 'access-1',
          userId: 'user-1',
          username: 'jason',
          deviceId: 'tablet-1',
          deviceName: 'Jason Tablet',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.example.test/relay/ws/devices',
          wsHostUrl: 'wss://relay.example.test/relay/ws/host',
          wsClientUrl: 'wss://relay.example.test/relay/ws/client',
          turnUrl: 'turn:turn.example.com:3478?transport=udp',
          turnUsername: 'alice',
          turnCredential: 'secret',
          updatedAt: 1,
        },
      },
    );
    expect(plan.candidates[0]).toMatchObject({
      path: 'tailscale',
      url: 'ws://mac-studio.tailnet.ts.net:3333/?token=daemon-token',
    });
    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([
      'tailscale',
      'rtc-direct',
      'rtc-relay',
    ]);
  });

  it('replaces stale endpoint auth when relay directory rotates the same endpoint id', () => {
    const projected = projectHomeSavedConnections(
      [makeSavedHost({
        authToken: '',
        relayEndpointCandidates: [{
          id: 'direct:tailscale:mac-studio',
          kind: 'tailscale',
          host: 'mac-studio.tailnet.ts.net',
          port: 3333,
          authToken: 'stale-token',
          authRequired: true,
          lastSeenAt: '2026-07-16T09:00:00.000Z',
        }],
      })],
      bridgeSettings,
      [makeRelayDevice()],
    );

    const directCandidates = (projected[0].relayEndpointCandidates || [])
      .filter((candidate) => candidate.id === 'direct:tailscale:mac-studio');
    expect(directCandidates).toHaveLength(1);
    expect(directCandidates[0]).toEqual(expect.objectContaining({
      authToken: 'daemon-token',
    }));
  });

  it('does not expose a Relay target when the row has no relay-rtc route', () => {
    const host = makeSavedHost({
      relayEndpointCandidates: [{
        id: 'direct:tailscale:mac-studio',
        kind: 'tailscale',
        host: 'mac-studio.tailnet.ts.net',
        port: 3333,
        authRequired: true,
        lastSeenAt: '2026-07-16T10:00:00.000Z',
      }],
    });

    expect(hasRelayRtcCandidate(host)).toBe(false);
  });

  it('does not project disconnected stale relay daemon devices as Home server rows', () => {
    const projected = projectHomeSavedConnections(
      [],
      bridgeSettings,
      [makeDisconnectedStaleRelayDevice()],
    );

    expect(projected).toEqual([]);
  });

  it('keeps one canonical daemon row when a direct preset gains daemon identity before an auxiliary preset', () => {
    const projected = projectHomeSavedConnections(
      [],
      {
        ...bridgeSettings,
        targetHost: '100.66.1.82',
        targetPort: 4333,
        targetAuthToken: 'file-transfer-token',
        defaultServerId: 'mac-file-transfer',
        servers: [
          {
            id: 'mac-direct',
            name: 'Mac Studio',
            targetHost: '100.66.1.82',
            targetPort: 3333,
            authToken: 'daemon-token',
          },
          {
            id: 'mac-daemon',
            name: 'Mac Studio Auto',
            targetHost: '100.66.1.82',
            targetPort: 3333,
            authToken: 'daemon-token',
            relayHostId: 'mac-studio',
          },
          {
            id: 'mac-file-transfer',
            name: 'File Transfer',
            targetHost: '100.66.1.82',
            targetPort: 4333,
            authToken: 'file-transfer-token',
            relayHostId: 'mac-studio',
          },
        ],
      },
      [makeRelayDevice()],
    );

    const daemonRows = projected.filter((host) => host.daemonHostId === 'mac-studio');
    expect(daemonRows).toHaveLength(1);
    expect(daemonRows[0]).toEqual(expect.objectContaining({
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      authToken: 'daemon-token',
    }));
    expect(daemonRows[0].relayEndpointCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'relay-rtc', relayHostId: 'mac-studio' }),
    ]));
  });
});

describe('mergeHostWithLatestProjection', () => {
  it('refreshes stale direct endpoints from the freshest projection for the same daemon', () => {
    const staleHost = {
      ...makeSavedHost({
        id: 'relay-device:dev-1:mac-studio',
        bridgeHost: '192.168.1.50',
      }),
      tailscaleHost: '100.66.1.82',
      ipv4Host: '203.0.113.10',
    } as Host;
    const freshestHost = {
      ...makeSavedHost({
        id: 'relay-device:dev-1:mac-studio',
        bridgeHost: '192.168.1.99',
      }),
      tailscaleHost: '100.99.2.1',
      ipv4Host: '198.51.100.7',
    } as Host;

    const merged = mergeHostWithLatestProjection(staleHost, [freshestHost]);

    expect(merged.tailscaleHost).toBe('100.99.2.1');
    expect(merged.ipv4Host).toBe('198.51.100.7');
    expect(merged.bridgeHost).toBe('192.168.1.99');
  });

  it('keeps the cached direct bridge host when the freshest entry is relay-only (empty bridgeHost)', () => {
    const staleHost = {
      ...makeSavedHost({
        id: 'relay-device:dev-1:mac-studio',
        bridgeHost: '192.168.1.50',
      }),
      tailscaleHost: '100.66.1.82',
    } as Host;
    const relayOnlyFresh = {
      ...makeSavedHost({
        id: 'relay-device:dev-1:mac-studio',
        bridgeHost: '',
      }),
      relayEndpointCandidates: [{ kind: 'relay-rtc', relayHostId: 'mac-studio', endpoint: 'x' } as never],
    } as Host;

    const merged = mergeHostWithLatestProjection(staleHost, [relayOnlyFresh]);

    expect(merged.bridgeHost).toBe('192.168.1.50');
    expect(merged.tailscaleHost).toBe('100.66.1.82');
  });

  it('returns the host unchanged when no fresher entry matches daemon or id', () => {
    const staleHost = {
      ...makeSavedHost({ id: 'saved-mac', daemonHostId: 'mac-studio' }),
    } as Host;
    const otherDaemon = {
      ...makeSavedHost({ id: 'other', daemonHostId: 'other-studio', bridgeHost: '10.0.0.9' }),
    } as Host;

    expect(mergeHostWithLatestProjection(staleHost, [otherDaemon])).toBe(staleHost);
  });
});
