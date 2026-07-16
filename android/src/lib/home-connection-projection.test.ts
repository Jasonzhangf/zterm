import { describe, expect, it } from 'vitest';
import {
  buildHomeRelayConnectionHost,
  hasRelayRtcCandidate,
  projectHomeSavedConnections,
} from './home-connection-projection';
import { DEFAULT_BRIDGE_SETTINGS, type BridgeSettings } from './bridge-settings';
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
          authRequired: true,
          lastSeenAt: '2026-07-16T10:00:00.000Z',
        },
        {
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
          authRequired: true,
          lastSeenAt: '2026-07-16T10:00:00.000Z',
        },
      ],
      sessions: [],
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

  it('builds a webrtc-only Home Relay target without direct route candidates', () => {
    const projected = projectHomeSavedConnections(
      [makeSavedHost()],
      bridgeSettings,
      [makeRelayDevice()],
    );
    const relayHost = buildHomeRelayConnectionHost(projected[0]);

    expect(relayHost).toEqual(expect.objectContaining({
      id: 'relay-route:saved-mac',
      name: 'Mac Studio',
      bridgeHost: '',
      bridgePort: 3333,
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      relayDeviceId: 'device-mac',
      transportMode: 'webrtc',
    }));
    expect(relayHost?.relayEndpointCandidates).toEqual([
      expect.objectContaining({ kind: 'relay-rtc', relayHostId: 'mac-studio' }),
    ]);
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
    expect(buildHomeRelayConnectionHost(host)).toBeNull();
  });
});
