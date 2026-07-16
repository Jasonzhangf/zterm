import { describe, expect, it } from 'vitest';
import {
  buildBridgeTargetFromHost,
  buildCleanDraft,
  buildDraftFromTmuxSession,
  normalizeBridgeTarget,
  resolveRelayDeviceBridgeTarget,
  type BridgeTarget,
} from './session-picker';
import type { BridgeServerPreset } from './bridge-settings';
import type { Host, TraversalRelayDeviceSnapshot } from './types';

const presets: BridgeServerPreset[] = [
  {
    id: 'server-1',
    name: 'MacStudio',
    targetHost: '100.64.0.10',
    targetPort: 3333,
    authToken: 'token-a',
    relayHostId: 'daemon-host-a',
    relayDeviceId: 'daemon-device-a',
    relayDeviceName: 'MacStudio Daemon',
  },
];

describe('session-picker relay truth', () => {
  it('normalizes relayDeviceId from target input', () => {
    expect(
      normalizeBridgeTarget({
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        authToken: 'token-a',
        relayHostId: 'daemon-host-claw',
        relayDeviceId: 'daemon-device-1',
      }),
    ).toEqual(
      expect.objectContaining({
        relayHostId: 'daemon-host-claw',
        relayDeviceId: 'daemon-device-1',
      }),
    );
  });

  it('builds a tmux session draft carrying relayHostId and relayDeviceId', () => {
    const target: BridgeTarget = {
      bridgeHost: '100.64.0.10',
      bridgePort: 3333,
      authToken: 'token-a',
      relayHostId: 'daemon-host-claw',
      relayDeviceId: 'daemon-device-1',
      transportMode: 'webrtc',
    };

    const draft = buildDraftFromTmuxSession([], presets, target, 'main');
    expect(draft).toEqual(
      expect.objectContaining({
        relayHostId: 'daemon-host-claw',
        relayDeviceId: 'daemon-device-1',
        sessionName: 'main',
      }),
    );
  });

  it('uses the current picker target transport truth when an existing host matches the same daemon/session', () => {
    const existingHost: Host = {
      id: 'host-1',
      createdAt: 1,
      name: 'Main',
      bridgeHost: '100.127.23.27',
      bridgePort: 4444,
      daemonHostId: 'daemon-host-a',
      sessionName: 'main',
      authToken: 'token-a',
      relayHostId: 'daemon-host-a',
      relayDeviceId: 'daemon-device-old',
      authType: 'password',
      tags: [],
      pinned: false,
    };

    const draft = buildDraftFromTmuxSession([existingHost], presets, {
      bridgeHost: '100.64.0.10',
      bridgePort: 3333,
      authToken: 'token-a',
      daemonHostId: 'daemon-host-a',
      relayHostId: 'daemon-host-a',
      relayDeviceId: 'daemon-device-new',
    }, 'main');

    expect(draft).toEqual(
      expect.objectContaining({
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        authToken: 'token-a',
        daemonHostId: 'daemon-host-a',
        relayHostId: 'daemon-host-a',
        relayDeviceId: 'daemon-device-new',
      }),
    );
  });

  it('does not reuse persisted host from a different daemon even when endpoint and session match', () => {
    const existingHost: Host = {
      id: 'host-2',
      createdAt: 1,
      name: 'Main',
      bridgeHost: '100.64.0.10',
      bridgePort: 3333,
      daemonHostId: 'daemon-host-old',
      sessionName: 'main',
      authToken: 'token-a',
      relayHostId: 'daemon-host-old',
      relayDeviceId: 'daemon-device-old',
      authType: 'password',
      tags: [],
      pinned: false,
    };

    const draft = buildDraftFromTmuxSession([existingHost], presets, {
      bridgeHost: '100.64.0.10',
      bridgePort: 3333,
      authToken: 'token-a',
      daemonHostId: 'daemon-host-new',
      relayHostId: 'daemon-host-new',
      relayDeviceId: 'daemon-device-new',
    }, 'main');

    expect(draft).toEqual(
      expect.objectContaining({
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-new',
        relayHostId: 'daemon-host-new',
        relayDeviceId: 'daemon-device-new',
      }),
    );
  });

  it('builds a clean draft carrying relay binding', () => {
    const draft = buildCleanDraft({
      bridgeHost: '100.64.0.10',
      bridgePort: 3333,
      authToken: 'token-a',
      relayHostId: 'daemon-host-claw',
      relayDeviceId: 'daemon-device-1',
    });

    expect(draft).toEqual(
      expect.objectContaining({
        relayHostId: 'daemon-host-claw',
        relayDeviceId: 'daemon-device-1',
      }),
    );
  });

  it('resolves relay device to mapped bridge target when preset exists', () => {
    const device: TraversalRelayDeviceSnapshot = {
      deviceId: 'daemon-device-a',
      deviceName: 'MacStudio Daemon',
      platform: 'darwin',
      appVersion: '0.1.0',
      client: {
        connected: true,
        lastSeenAt: '2026-05-07T00:00:00.000Z',
      },
      daemon: {
        hostId: 'daemon-host-a',
        connected: true,
        lastSeenAt: '2026-05-07T00:00:00.000Z',
        version: '0.1.0',
      },
      updatedAt: '2026-05-07T00:00:00.000Z',
    };

    expect(resolveRelayDeviceBridgeTarget(presets, device)).toEqual(
      expect.objectContaining({
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        relayHostId: 'daemon-host-a',
        relayDeviceId: 'daemon-device-a',
        authToken: 'token-a',
      }),
    );
  });

  it('falls back to daemon identity when relay device has no mapped bridge preset yet', () => {
    const device: TraversalRelayDeviceSnapshot = {
      deviceId: 'daemon-device-b',
      deviceName: 'Unmapped Daemon',
      platform: 'darwin',
      appVersion: '0.1.0',
      client: {
        connected: true,
        lastSeenAt: '2026-05-07T00:00:00.000Z',
      },
      daemon: {
        hostId: 'daemon-host-b',
        connected: true,
        lastSeenAt: '2026-05-07T00:00:00.000Z',
        version: '0.1.0',
      },
      updatedAt: '2026-05-07T00:00:00.000Z',
    };

    expect(resolveRelayDeviceBridgeTarget(presets, device)).toEqual(
      expect.objectContaining({
        bridgeHost: '',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-b',
        relayHostId: 'daemon-host-b',
        relayDeviceId: 'daemon-device-b',
        authToken: '',
      }),
    );
  });

  it('resolves an unmapped relay directory device into an openable route target with endpoint candidates and sessions', () => {
    const device: TraversalRelayDeviceSnapshot = {
      deviceId: 'daemon-device-c',
      deviceName: 'Directory Daemon',
      platform: 'darwin',
      appVersion: '0.1.0',
      client: {
        connected: true,
        lastSeenAt: '2026-06-28T00:00:00.000Z',
      },
      daemon: {
        hostId: 'daemon-host-c',
        connected: true,
        lastSeenAt: '2026-06-28T00:00:00.000Z',
        version: '0.1.0',
        endpoints: [
          {
            id: 'direct:tailscale:daemon-host-c',
            kind: 'tailscale',
            host: 'mac.tailnet.ts.net',
            port: 3333,
            authRequired: true,
            lastSeenAt: '2026-06-28T00:00:00.000Z',
          },
          {
            id: 'relay-rtc:daemon-host-c',
            kind: 'relay-rtc',
            relayHostId: 'daemon-host-c',
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
      updatedAt: '2026-06-28T00:00:00.000Z',
    };

    expect(resolveRelayDeviceBridgeTarget([], device)).toEqual(
      expect.objectContaining({
        bridgeHost: 'mac.tailnet.ts.net',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-c',
        relayHostId: 'daemon-host-c',
        relayDeviceId: 'daemon-device-c',
        relayEndpointCandidates: device.daemon.endpoints,
        relayTmuxSessions: device.daemon.sessions,
      }),
    );
  });

  it('resolves a relay directory Home host row to its direct endpoint candidate before opening', () => {
    const target = buildBridgeTargetFromHost({
      id: 'relay-device:daemon-device-c:daemon-host-c',
      createdAt: 1,
      name: 'Directory Daemon',
      bridgeHost: '',
      bridgePort: 3333,
      daemonHostId: 'daemon-host-c',
      relayHostId: 'daemon-host-c',
      relayDeviceId: 'daemon-device-c',
      sessionName: '',
      authType: 'password',
      tags: ['relay-directory'],
      pinned: false,
      relayEndpointCandidates: [
        {
          id: 'direct:tailscale:daemon-host-c',
          kind: 'tailscale',
          host: 'mac.tailnet.ts.net',
          port: 3333,
          authRequired: true,
          lastSeenAt: '2026-06-28T00:00:00.000Z',
        },
        {
          id: 'relay-rtc:daemon-host-c',
          kind: 'relay-rtc',
          relayHostId: 'daemon-host-c',
          authRequired: true,
          lastSeenAt: '2026-06-28T00:00:00.000Z',
        },
      ],
    });

    expect(target).toEqual(expect.objectContaining({
      bridgeHost: 'mac.tailnet.ts.net',
      bridgePort: 3333,
      daemonHostId: 'daemon-host-c',
      relayHostId: 'daemon-host-c',
      relayDeviceId: 'daemon-device-c',
      relayEndpointCandidates: expect.arrayContaining([
        expect.objectContaining({ kind: 'tailscale', host: 'mac.tailnet.ts.net' }),
        expect.objectContaining({ kind: 'relay-rtc', relayHostId: 'daemon-host-c' }),
      ]),
    }));
  });
});
