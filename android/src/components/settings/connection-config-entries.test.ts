import { describe, expect, it } from 'vitest';
import { buildConnectionConfigEntries } from './ConnectionConfigSection';
import { DEFAULT_BRIDGE_SETTINGS, type BridgeSettings } from '../../lib/bridge-settings';
import type { TraversalRelayDeviceSnapshot } from '../../lib/types';

const baseSettings: BridgeSettings = {
  ...DEFAULT_BRIDGE_SETTINGS,
  targetHost: '',
  targetPort: 3333,
  targetAuthToken: '',
  defaultServerId: 'preset-1',
  servers: [
    {
      id: 'preset-1',
      name: 'Mac Studio Direct',
      targetHost: '100.66.1.82',
      targetPort: 3333,
      authToken: 'token-a',
      relayHostId: 'mac-studio',
    },
    {
      id: 'preset-2',
      name: 'Emulator',
      targetHost: '10.0.2.2',
      targetPort: 3333,
      authToken: 'token-b',
    },
  ],
};

function makeRelayDevice(
  overrides: Partial<{
    deviceId: string;
    deviceName: string;
    hostId: string;
    connected: boolean;
  }> = {},
): TraversalRelayDeviceSnapshot {
  const now = new Date().toISOString();
  return {
    deviceId: overrides.deviceId || 'device-a',
    deviceName: overrides.deviceName || 'Mac Studio Relay',
    platform: 'darwin',
    appVersion: '0.1.3',
    updatedAt: now,
    client: { connected: true, lastSeenAt: now },
    daemon: {
      connected: overrides.connected !== false,
      lastSeenAt: now,
      hostId: overrides.hostId || 'mac-studio',
      version: '0.1.3',
      endpoints: [
        {
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc',
          relayHostId: overrides.hostId || 'mac-studio',
          authRequired: true,
          lastSeenAt: now,
        },
      ],
      sessions: [],
    },
  };
}

describe('buildConnectionConfigEntries', () => {
  it('returns one entry per preset when no relay devices are online', () => {
    const entries = buildConnectionConfigEntries(baseSettings, []);
    expect(entries).toHaveLength(2);
    expect(entries.filter((entry) => entry.kind === 'bridge-preset')).toHaveLength(2);
    expect(entries.filter((entry) => entry.kind === 'relay-online')).toHaveLength(0);
  });

  it('deduplicates the same daemon hostId across multiple devices into one entry', () => {
    const devices = [
      makeRelayDevice({ deviceId: 'd-1' }),
      makeRelayDevice({ deviceId: 'd-2' }),
    ];
    const entries = buildConnectionConfigEntries(baseSettings, devices);
    const relayEntries = entries.filter((entry) => entry.kind === 'relay-online');
    expect(relayEntries).toHaveLength(1);
    const presets = entries.filter((entry) => entry.kind === 'bridge-preset');
    expect(presets).toHaveLength(1);
    // Preset with relayHostId 'mac-studio' is subsumed by the relay-online entry
    expect(presets[0]?.server.id).toBe('preset-2');
  });

  it('keeps disconnected relay devices out of the unified list', () => {
    const devices = [makeRelayDevice({ connected: false })];
    const entries = buildConnectionConfigEntries(baseSettings, devices);
    expect(entries.filter((entry) => entry.kind === 'relay-online')).toHaveLength(0);
    expect(entries).toHaveLength(2);
  });

  it('keeps the preset entry when no matching relay device exists for that daemon', () => {
    const settings: BridgeSettings = {
      ...baseSettings,
      servers: [
        {
          id: 'preset-1',
          name: 'Linux',
          targetHost: '192.168.0.10',
          targetPort: 3333,
          authToken: 'token-linux',
          relayHostId: 'linux-box',
        },
      ],
    };
    const devices = [makeRelayDevice({ hostId: 'mac-studio' })];
    const entries = buildConnectionConfigEntries(settings, devices);
    expect(entries.filter((entry) => entry.kind === 'relay-online')).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === 'bridge-preset')).toHaveLength(1);
    expect(entries.find((entry) => entry.kind === 'bridge-preset')).toMatchObject({
      server: { id: 'preset-1' },
      daemonHostId: 'linux-box',
    });
  });

  it('reports bound preset identity for the unified relay-online entry', () => {
    const entries = buildConnectionConfigEntries(baseSettings, [makeRelayDevice()]);
    const relayEntries = entries.filter((entry) => entry.kind === 'relay-online');
    expect(relayEntries).toHaveLength(1);
    const entry = relayEntries[0]!;
    if (entry.kind !== 'relay-online') throw new Error('expected relay-online');
    expect(entry.canonicalHostId).toBe('mac-studio');
    expect(entry.boundBridgePreset).toMatchObject({
      id: 'preset-1',
      targetHost: '100.66.1.82',
      authToken: 'token-a',
    });
  });
});
