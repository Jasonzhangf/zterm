import { describe, expect, it, vi } from 'vitest';
import { ClientControlDirectoryRuntime } from './client-control-directory-runtime';
import { ClientControlPlaneTransport } from './client-control-plane-transport';
import type { BridgeTransportSocket } from './traversal/types';
import type { TraversalRelayDeviceSnapshot } from './types';

function makeDevice(): TraversalRelayDeviceSnapshot {
  return {
    deviceId: 'mac-studio',
    deviceName: 'Mac Studio',
    platform: 'darwin',
    appVersion: '0.1.3',
    updatedAt: '2026-08-01T00:00:00.000Z',
    client: { connected: false, lastSeenAt: '' },
    daemon: {
      connected: true,
      lastSeenAt: '2026-08-01T00:00:00.000Z',
      hostId: 'mac-studio',
      version: '0.1.3',
      endpoints: [{
        id: 'rtc-direct:mac-studio',
        kind: 'rtc-direct',
        relayHostId: 'mac-studio',
        authRequired: true,
        lastSeenAt: '2026-08-01T00:00:00.000Z',
      }],
      sessions: [],
    },
  };
}

function makeInnerSocket(): BridgeTransportSocket {
  return {
    readyState: WebSocket.CONNECTING,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: vi.fn(),
    close: vi.fn(),
    reportFailure: vi.fn(),
    getDiagnostics: vi.fn(() => ({ mode: 'auto', stage: 'connecting', attempts: [] })),
  };
}

describe('ClientControlPlaneTransport', () => {
  it('opens exactly one data transport only after server-confirmed directory truth', async () => {
    const directoryRuntime = new ClientControlDirectoryRuntime();
    const inner = makeInnerSocket();
    const openConfirmedTransport = vi.fn(() => inner);
    const transport = new ClientControlPlaneTransport({
      daemonHostId: 'mac-studio',
      mode: 'auto',
      directoryRuntime,
      openConfirmedTransport,
    });

    await Promise.resolve();
    expect(transport.readyState).toBe(WebSocket.CONNECTING);
    expect(transport.getDiagnostics()).toMatchObject({
      stage: 'connecting',
      reason: 'waiting for control directory generation 0 for target mac-studio',
    });
    expect(openConfirmedTransport).not.toHaveBeenCalled();

    directoryRuntime.replaceFromDevices([makeDevice()]);
    directoryRuntime.replaceFromDevices([makeDevice()]);

    expect(openConfirmedTransport).toHaveBeenCalledTimes(1);
    expect(transport.readyState).toBe(WebSocket.CONNECTING);
  });

  it('does not let a late control snapshot open a replaced waiting generation', async () => {
    const directoryRuntime = new ClientControlDirectoryRuntime();
    const openConfirmedTransport = vi.fn(() => makeInnerSocket());
    const transport = new ClientControlPlaneTransport({
      daemonHostId: 'mac-studio',
      mode: 'auto',
      directoryRuntime,
      openConfirmedTransport,
    });

    transport.close(1000, 'replaced by newer generation');
    directoryRuntime.replaceFromDevices([makeDevice()]);
    await Promise.resolve();

    expect(openConfirmedTransport).not.toHaveBeenCalled();
    expect(transport.readyState).toBe(WebSocket.CLOSED);
  });

  it('reports a confirmed missing target without starting signaling', () => {
    const directoryRuntime = new ClientControlDirectoryRuntime();
    const openConfirmedTransport = vi.fn(() => makeInnerSocket());
    const transport = new ClientControlPlaneTransport({
      daemonHostId: 'missing-host',
      mode: 'auto',
      directoryRuntime,
      openConfirmedTransport,
    });
    const onclose = vi.fn();
    transport.onclose = onclose;

    directoryRuntime.replaceFromDevices([makeDevice()]);

    expect(openConfirmedTransport).not.toHaveBeenCalled();
    expect(onclose).toHaveBeenCalledWith({
      code: 4404,
      reason: 'confirmed control directory has no target missing-host',
    });
  });

  it('fails a waiting generation explicitly when control confirmation never arrives', () => {
    vi.useFakeTimers();
    try {
      const directoryRuntime = new ClientControlDirectoryRuntime();
      const openConfirmedTransport = vi.fn(() => makeInnerSocket());
      const transport = new ClientControlPlaneTransport({
        daemonHostId: 'mac-studio',
        mode: 'auto',
        directoryRuntime,
        openConfirmedTransport,
        confirmationTimeoutMs: 100,
      });
      const onclose = vi.fn();
      transport.onclose = onclose;

      vi.advanceTimersByTime(100);

      expect(openConfirmedTransport).not.toHaveBeenCalled();
      expect(transport.readyState).toBe(WebSocket.CLOSED);
      expect(onclose).toHaveBeenCalledWith({
        code: 4408,
        reason: 'control directory confirmation timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
