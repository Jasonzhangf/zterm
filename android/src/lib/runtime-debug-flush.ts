import type { ClientMessage } from './types';
import { collectClientDebugSnapshot } from './client-debug-snapshot';
import {
  drainRuntimeDebugEntries,
  getPendingRuntimeDebugEntryCount,
  isRuntimeDebugEnabled,
} from './runtime-debug';

// Debug channel observes only: it declares the minimal structural shape it
// needs instead of importing connection-owner types (no debug -> connection edge).
export interface RuntimeDebugFlushSocket {
  readonly readyState: number;
}

export interface RuntimeDebugFlushConnection<TSocket extends RuntimeDebugFlushSocket = RuntimeDebugFlushSocket> {
  readSessionSocket(sessionId: string): TSocket | null;
}

export const CLIENT_RUNTIME_DEBUG_FLUSH_INTERVAL_MS = 1200;
export const CLIENT_RUNTIME_DEBUG_SNAPSHOT_INTERVAL_MS = 2500;

const lastSnapshotSentAtBySession = new Map<string, number>();

export function resetRuntimeDebugTransportFlushStateForTests() {
  lastSnapshotSentAtBySession.clear();
}

// Force flush is disabled by default in production runtime.
// Enabling this continuously on hot paths can amplify input latency under weak network.
function isForceFlushEnabled() { return false; }

export function flushRuntimeDebugLogsToSessionTransport<TSocket extends RuntimeDebugFlushSocket>(input: {
  activeSessionId: string | null;
  daemonConnection?: RuntimeDebugFlushConnection<TSocket>;
  readSessionTransportSocket: (sessionId: string) => TSocket | null;
  sendSocketPayload: (sessionId: string, ws: TSocket, data: string | ArrayBuffer) => void;
}) {
  const debugEnabled = isRuntimeDebugEnabled();
  const pendingEntryCount = getPendingRuntimeDebugEntryCount();
  if (!debugEnabled && !isForceFlushEnabled()) {
    return false;
  }

  const activeSessionId = input.activeSessionId;
  if (!activeSessionId) {
    return false;
  }

  const ws = input.daemonConnection
    ? input.daemonConnection.readSessionSocket(activeSessionId)
    : input.readSessionTransportSocket(activeSessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  let flushed = false;
  if (pendingEntryCount > 0) {
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
  if (debugEnabled && now - previousSnapshotSentAt >= CLIENT_RUNTIME_DEBUG_SNAPSHOT_INTERVAL_MS) {
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
