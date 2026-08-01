import { describe, expect, it } from 'vitest';
import {
  hasRelayRtcCandidate,
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
  return {
    deviceId: 'device-mac',
    deviceName: 'Mac Studio Relay',
    platform: 'darwin',
    appVersion: '0.1.3',
    updatedAt: '2026-07-16T10:00:00.000Z',
    client: {
      connected: false,
      lastSeenAt: '2026-07-16T10:00:00.000Z',
    },
    daemon: {
      connected: true,
      lastSeenAt: '2026-07-16T10:00:00.000Z',
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
          lastSeenAt: '2026-07-16T10:00:00.000Z',
        },
        {
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
          authToken: 'daemon-token',
          authRequired: true,
          lastSeenAt: '2026-07-16T10:00:00.000Z',
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
      lastSeenAt: '2026-07-16T10:00:00.000Z',
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
});
