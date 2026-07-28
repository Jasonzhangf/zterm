import { describe, expect, it, vi } from 'vitest';
import {
  ClientControlDirectoryRuntime,
  mergeHostWithClientControlDirectory,
} from './client-control-directory-runtime';
import type { TraversalRelayDeviceSnapshot } from './types';

function makeDevice(host: string, endpointHost: string): TraversalRelayDeviceSnapshot {
  return {
    deviceId: 'device-1',
    deviceName: 'Mac Studio',
    platform: 'darwin',
    appVersion: '0.1.3',
    updatedAt: '2026-07-28T07:00:00.000Z',
    client: {
      connected: false,
      lastSeenAt: '2026-07-28T07:00:00.000Z',
    },
    daemon: {
      connected: true,
      lastSeenAt: '2026-07-28T07:00:00.000Z',
      hostId: host,
      version: '0.1.3',
      endpoints: [{
        id: `lan:${endpointHost}:3333`,
        kind: 'lan',
        host: endpointHost,
        port: 3333,
        authRequired: true,
        lastSeenAt: '2026-07-28T07:00:00.000Z',
      }],
      sessions: [],
    },
  };
}

describe('client control directory runtime', () => {
  it('replaces endpoint truth by stable daemon id and increments generation', () => {
    const runtime = new ClientControlDirectoryRuntime();
    runtime.replaceFromDevices([makeDevice('mac-studio', '192.168.1.20')]);
    expect(runtime.read('mac-studio')).toMatchObject({
      generation: 1,
      endpoints: [expect.objectContaining({ host: '192.168.1.20' })],
    });

    runtime.replaceFromDevices([makeDevice('mac-studio', '192.168.1.21')]);
    expect(runtime.read('mac-studio')).toMatchObject({
      generation: 2,
      endpoints: [expect.objectContaining({ host: '192.168.1.21' })],
    });
  });

  it('updates future connection candidates without touching an existing terminal socket', () => {
    const runtime = new ClientControlDirectoryRuntime();
    const terminalSocket = { readyState: WebSocket.OPEN, close: vi.fn() };
    runtime.replaceFromDevices([makeDevice('mac-studio', '192.168.1.20')]);

    const host = {
      id: 'host-1',
      createdAt: 1,
      name: 'Mac Studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      daemonHostId: 'mac-studio',
      sessionName: 'main',
      authType: 'password' as const,
      tags: [],
      pinned: false,
    };
    const first = mergeHostWithClientControlDirectory(host, runtime);
    runtime.replaceFromDevices([makeDevice('mac-studio', '192.168.1.21')]);
    const second = mergeHostWithClientControlDirectory(host, runtime);

    expect(first.relayEndpointCandidates).toEqual([
      expect.objectContaining({ host: '192.168.1.20' }),
    ]);
    expect(second.relayEndpointCandidates).toEqual([
      expect.objectContaining({ host: '192.168.1.21' }),
    ]);
    expect(terminalSocket.readyState).toBe(WebSocket.OPEN);
    expect(terminalSocket.close).not.toHaveBeenCalled();
  });

  it('does not bind disconnected daemon projections as connectable endpoint truth', () => {
    const runtime = new ClientControlDirectoryRuntime();
    const disconnected = makeDevice('mac-studio', '192.168.1.20');
    disconnected.daemon.connected = false;

    runtime.replaceFromDevices([disconnected]);

    expect(runtime.read('mac-studio')).toBeNull();
  });
});
