import { describe, expect, it } from 'vitest';
import { buildBridgeServerPresetViews } from './bridge-server-presets-view';
import type { BridgeServerPreset } from './bridge-settings';

describe('buildBridgeServerPresetViews', () => {
  it('sorts presets and derives a single display projection for each server', () => {
    const servers: BridgeServerPreset[] = [
      {
        id: 'server-b',
        name: 'B',
        targetHost: '100.127.23.27',
        targetPort: 40807,
        relayHostId: 'daemon-b',
        authToken: '',
      },
      {
        id: 'server-a',
        name: 'A',
        targetHost: '100.64.0.10',
        targetPort: 3333,
        relayHostId: 'daemon-a',
        authToken: 'token-a',
      },
    ];

    expect(buildBridgeServerPresetViews(servers)).toEqual([
      expect.objectContaining({
        server: expect.objectContaining({ id: 'server-a' }),
        daemonHostId: 'daemon-a',
        bridgeLabel: 'Bridge · 100.64.0.10:3333',
        daemonLabel: 'Daemon · daemon-a',
        authLabel: 'Auth on',
      }),
      expect.objectContaining({
        server: expect.objectContaining({ id: 'server-b' }),
        daemonHostId: 'daemon-b',
        bridgeLabel: 'Bridge · 100.127.23.27:40807',
        daemonLabel: 'Daemon · daemon-b',
        authLabel: 'No token',
      }),
    ]);
  });
});
