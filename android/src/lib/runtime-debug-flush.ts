import type { ClientMessage } from './types';
import { collectClientDebugSnapshot } from './client-debug-snapshot';
import {
  drainRuntimeDebugEntries,
  getPendingRuntimeDebugEntryCount,
  isRuntimeDebugEnabled,
} from './runtime-debug';
import type { BridgeTransportSocket } from './traversal/types';

export const CLIENT_RUNTIME_DEBUG_FLUSH_INTERVAL_MS = 1200;
export const CLIENT_RUNTIME_DEBUG_SNAPSHOT_INTERVAL_MS = 2500;

const lastSnapshotSentAtBySession = new Map<string, number>();

export function resetRuntimeDebugTransportFlushStateForTests() {
  lastSnapshotSentAtBySession.clear();
}

export function flushRuntimeDebugLogsToSessionTransport(input: {
  activeSessionId: string | null;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  if (!isRuntimeDebugEnabled()) {
    return false;
  }

  const activeSessionId = input.activeSessionId;
  if (!activeSessionId) {
    return false;
  }

  const ws = input.readSessionTransportSocket(activeSessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  let flushed = false;
  if (getPendingRuntimeDebugEntryCount() > 0) {
    const entries = drainRuntimeDebugEntries();
    if (entries.length > 0) {
      const logFrame = JSON.stringify({
        type: 'debug-log',
        payload: { entries },
      } satisfies ClientMessage);
      input.sendSocketPayload(activeSessionId, ws, logFrame);
      flushed = true;
    }
  }

  const now = Date.now();
  const previousSnapshotSentAt = lastSnapshotSentAtBySession.get(activeSessionId) || 0;
  if (now - previousSnapshotSentAt >= CLIENT_RUNTIME_DEBUG_SNAPSHOT_INTERVAL_MS) {
    const snapshotFrame = JSON.stringify({
      type: 'debug-snapshot',
      payload: {
        snapshot: collectClientDebugSnapshot({
          source: 'session-transport-runtime-debug',
          sessionId: activeSessionId,
        }),
      },
    } satisfies ClientMessage);
    input.sendSocketPayload(activeSessionId, ws, snapshotFrame);
    lastSnapshotSentAtBySession.set(activeSessionId, now);
    flushed = true;
  }

  return flushed;
}
