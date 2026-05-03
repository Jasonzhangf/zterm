import type { ClientMessage } from './types';
import {
  drainRuntimeDebugEntries,
  getPendingRuntimeDebugEntryCount,
  isRuntimeDebugEnabled,
} from './runtime-debug';
import type { BridgeTransportSocket } from './traversal/types';

export const CLIENT_RUNTIME_DEBUG_FLUSH_INTERVAL_MS = 1200;

export function flushRuntimeDebugLogsToSessionTransport(input: {
  activeSessionId: string | null;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  if (!isRuntimeDebugEnabled() || getPendingRuntimeDebugEntryCount() === 0) {
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

  const entries = drainRuntimeDebugEntries();
  if (entries.length === 0) {
    return false;
  }

  const frame = JSON.stringify({
    type: 'debug-log',
    payload: { entries },
  } satisfies ClientMessage);
  input.sendSocketPayload(activeSessionId, ws, frame);
  return true;
}
