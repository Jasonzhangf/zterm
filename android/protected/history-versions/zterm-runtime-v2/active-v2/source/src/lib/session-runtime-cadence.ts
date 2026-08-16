import type { SessionDebugOverlayMetrics } from './types';
import type { BridgeTransportSocket } from './traversal/types';
import type { TerminalRefreshCadenceOptions } from './mobile-config';

export interface SessionRuntimeCadenceInput {
  socket?: BridgeTransportSocket | null;
  metrics?: SessionDebugOverlayMetrics | null;
}

export function resolveSessionRuntimeTransportCadenceInput(
  input: SessionRuntimeCadenceInput,
): TerminalRefreshCadenceOptions['runtimeTransport'] {
  const bufferedBytes = Number.isFinite(input.socket?.bufferedAmount)
    ? Math.max(0, Math.floor(input.socket?.bufferedAmount || 0))
    : 0;
  const downlinkBps = Number.isFinite(input.metrics?.downlinkBps)
    ? Math.max(0, Math.floor(input.metrics?.downlinkBps || 0))
    : 0;
  const uplinkBps = Number.isFinite(input.metrics?.uplinkBps)
    ? Math.max(0, Math.floor(input.metrics?.uplinkBps || 0))
    : 0;
  const backpressure = bufferedBytes >= 128 * 1024;
  if (!input.socket && !input.metrics) {
    return null;
  }
  return {
    bufferedBytes,
    backpressure,
    recentPayloadBytes: Math.max(downlinkBps, uplinkBps),
    hasRecentProgress: downlinkBps > 0 || uplinkBps > 0,
  };
}
