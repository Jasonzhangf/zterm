import { describe, expect, it } from 'vitest';
import { buildCleanDraft, buildDraftFromTmuxSession, normalizeBridgeTarget, type BridgeTarget } from './session-picker';
import type { BridgeServerPreset } from './bridge-settings';
import type { Host } from './types';

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

  it('reuses persisted host relay binding when existing host already matches target/session', () => {
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
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
        daemonHostId: 'daemon-host-a',
        relayHostId: 'daemon-host-a',
        relayDeviceId: 'daemon-device-old',
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
});
