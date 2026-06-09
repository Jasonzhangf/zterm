import { describe, expect, it } from 'vitest';
import { resolveTerminalRefreshCadence } from './mobile-config';
import { resolveSessionRuntimeTransportCadenceInput } from './session-runtime-cadence';
import type { BridgeTransportSocket } from './traversal/types';

function socket(bufferedAmount: number): BridgeTransportSocket {
  return {
    readyState: 1,
    bufferedAmount,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: () => {},
    close: () => {},
    getDiagnostics: () => ({ stage: 'open', mode: 'websocket', attempts: [] }),
  };
}

describe('session-runtime-cadence', () => {
  it('maps active session socket and metrics into fast-lane cadence input', () => {
    const runtimeTransport = resolveSessionRuntimeTransportCadenceInput({
      socket: socket(0),
      metrics: {
        uplinkBps: 400,
        downlinkBps: 1200,
        renderHz: 20,
        pullHz: 20,
        transportBufferedBytes: 0,
        transportBackpressured: false,
        lastRenderCommitAt: 0,
        bufferPullActive: false,
        status: 'waiting',
        active: true,
        updatedAt: 1000,
      },
    });

    expect(runtimeTransport).toMatchObject({
      bufferedBytes: 0,
      backpressure: false,
      recentPayloadBytes: 1200,
      hasRecentProgress: true,
    });
    expect(resolveTerminalRefreshCadence({ runtimeTransport }).renderCommitMs).toBe(16);
  });

  it('maps socket backlog into slow-lane cadence input without changing payload semantics', () => {
    const runtimeTransport = resolveSessionRuntimeTransportCadenceInput({
      socket: socket(512 * 1024),
      metrics: {
        uplinkBps: 400,
        downlinkBps: 1200,
        renderHz: 20,
        pullHz: 20,
        transportBufferedBytes: 512 * 1024,
        transportBackpressured: true,
        lastRenderCommitAt: 0,
        bufferPullActive: false,
        status: 'refreshing',
        active: true,
        updatedAt: 1000,
      },
    });

    expect(runtimeTransport).toMatchObject({
      bufferedBytes: 512 * 1024,
      backpressure: true,
    });
    expect(resolveTerminalRefreshCadence({ runtimeTransport }).headTickMs).toBeGreaterThanOrEqual(120);
  });
});
