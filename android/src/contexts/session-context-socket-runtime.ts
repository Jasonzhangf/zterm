import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { SessionHeartbeatStore } from '../lib/session-heartbeat-store';
import type { SessionReconnectStore } from '../lib/session-reconnect-store';
import type { SessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import { buildTerminalMuxPing } from '@zterm/shared/protocol';
import {
  clearPendingBufferSyncFrameAssembly,
  type BufferFrameAssemblyResourceState,
} from './session-buffer-frame-assembly';

interface MutableRefObject<T> {
  current: T;
}

export const CLIENT_TRANSPORT_HEARTBEAT_INTERVAL_MS = 30_000;
export const CLIENT_TRANSPORT_HEARTBEAT_MAX_MISSES = 3;

export function clearSessionHeartbeat(options: {
  sessionId: string;
  heartbeatKey?: string;
  heartbeatStore: SessionHeartbeatStore;
}) {
  const heartbeatKey = resolveSocketHeartbeatKey(options.sessionId, options.heartbeatKey);
  options.heartbeatStore.deleteSession(heartbeatKey);
}

export function clearSessionHandshakeTimeout(options: {
  sessionId: string;
  handshakeTimeoutsRef: MutableRefObject<Map<string, number>>;
}) {
  const timerId = options.handshakeTimeoutsRef.current.get(options.sessionId);
  if (typeof timerId === 'number') {
    window.clearTimeout(timerId);
    options.handshakeTimeoutsRef.current.delete(options.sessionId);
  }
}

export function setSessionHandshakeTimeout(options: {
  sessionId: string;
  callback: () => void;
  delayMs: number;
  handshakeTimeoutsRef: MutableRefObject<Map<string, number>>;
}) {
  clearSessionHandshakeTimeout({
    sessionId: options.sessionId,
    handshakeTimeoutsRef: options.handshakeTimeoutsRef,
  });
  const timerId = window.setTimeout(() => {
    options.handshakeTimeoutsRef.current.delete(options.sessionId);
    options.callback();
  }, options.delayMs);
  options.handshakeTimeoutsRef.current.set(options.sessionId, timerId);
  return timerId;
}

export function clearTailRefreshRuntime(options: {
  sessionId: string;
  sessionHeadStoreRef: MutableRefObject<{ clearLiveHead: (sessionId: string) => void }>;
  sessionRevisionResetRef: MutableRefObject<Map<string, { revision: number; latestEndIndex: number; seenAt: number }>>;
  lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
  tailRefreshStore?: SessionTailRefreshStore;
  bufferFrameAssemblyRef: MutableRefObject<Map<string, BufferFrameAssemblyResourceState>>;
}) {
  options.sessionHeadStoreRef.current.clearLiveHead(options.sessionId);
  options.lastHeadRequestAtRef.current.delete(options.sessionId);
  options.tailRefreshStore?.clearPendingTailRefreshMarks(options.sessionId);
  const retainedFrameResource = clearPendingBufferSyncFrameAssembly(
    options.bufferFrameAssemblyRef.current.get(options.sessionId) || null,
  );
  if (retainedFrameResource) {
    options.bufferFrameAssemblyRef.current.set(options.sessionId, retainedFrameResource);
  }
}

export function startSocketHeartbeat(options: {
  sessionId: string;
  heartbeatKey?: string;
  ws: BridgeTransportSocket;
  finalizeFailure: (message: string, retryable: boolean) => void;
  heartbeatStore: SessionHeartbeatStore;
  clientPingIntervalMs: number;
  maxConsecutiveMisses: number;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const heartbeatKey = resolveSocketHeartbeatKey(options.sessionId, options.heartbeatKey);
  options.heartbeatStore.clearPingInterval(heartbeatKey);
  let lastObservedServerActivityAt = Math.max(
    options.heartbeatStore.readLastServerActivityAt(heartbeatKey),
    options.heartbeatStore.readLastPongAt(heartbeatKey),
    Date.now(),
  );
  let consecutiveMisses = 0;
  let failureFinalized = false;
  const pingInterval = setInterval(() => {
    if (options.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const currentServerActivityAt = Math.max(
      options.heartbeatStore.readLastServerActivityAt(heartbeatKey),
      options.heartbeatStore.readLastPongAt(heartbeatKey),
    );
    if (currentServerActivityAt > lastObservedServerActivityAt) {
      lastObservedServerActivityAt = currentServerActivityAt;
      consecutiveMisses = 0;
    } else {
      consecutiveMisses += 1;
    }

    if (consecutiveMisses >= options.maxConsecutiveMisses) {
      if (!failureFinalized) {
        failureFinalized = true;
        options.finalizeFailure('heartbeat server activity timeout', true);
        options.heartbeatStore.clearPingInterval(heartbeatKey);
        if (options.ws.readyState < WebSocket.CLOSING) {
          options.ws.close();
        }
      }
      return;
    }

    const pingFrame = heartbeatKey.startsWith('target:')
      ? buildTerminalMuxPing(Date.now())
      : { type: 'ping' as const };
    options.sendSocketPayload(options.sessionId, options.ws, JSON.stringify(pingFrame));
  }, options.clientPingIntervalMs);
  options.heartbeatStore.setPingInterval(heartbeatKey, pingInterval);
}

export function buildTargetTransportHeartbeatKey(targetKey: string) {
  return `target:${targetKey.trim()}`;
}

function resolveSocketHeartbeatKey(sessionId: string, heartbeatKey?: string) {
  const normalizedHeartbeatKey = typeof heartbeatKey === 'string' ? heartbeatKey.trim() : '';
  return normalizedHeartbeatKey || sessionId;
}

export function clearSupersededSockets(options: {
  sessionId: string;
  shouldClose?: boolean;
  drainSessionSupersededSockets: (sessionId: string) => BridgeTransportSocket[];
}) {
  const superseded = options.drainSessionSupersededSockets(options.sessionId);
  if (superseded.length === 0) {
    return;
  }
  if (options.shouldClose === false) {
    return;
  }
  for (const ws of superseded) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (ws.readyState < WebSocket.CLOSING) {
      ws.close();
    }
  }
}

export function cleanupSocket(options: {
  sessionId: string;
  shouldClose?: boolean;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  moveSessionTransportSocketAside: (sessionId: string) => BridgeTransportSocket | null;
  writeSessionTransportSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  clearSupersededSockets: (sessionId: string, shouldClose?: boolean) => void;
  clearHeartbeat: (sessionId: string) => void;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  clearTailRefreshRuntime: (sessionId: string) => void;
  clearSessionPullState: (sessionId: string) => void;
  reconnectStore: SessionReconnectStore;
}) {
  const shouldClose = options.shouldClose === true;
  const ws = options.readSessionTransportSocket(options.sessionId);
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (shouldClose && ws.readyState < WebSocket.CLOSING) {
      ws.close();
    } else if (!shouldClose) {
      options.moveSessionTransportSocketAside(options.sessionId);
    }
    options.writeSessionTransportSocket(options.sessionId, null);
  }

  if (shouldClose) {
    options.clearSupersededSockets(options.sessionId, true);
  }

  options.clearHeartbeat(options.sessionId);
  options.clearSessionHandshakeTimeout(options.sessionId);
  options.clearTailRefreshRuntime(options.sessionId);
  options.clearSessionPullState(options.sessionId);
  options.reconnectStore.clearStaleTransportProbe(options.sessionId);
}

export function clearReconnectRuntime(options: {
  sessionId: string;
  reconnectStore: SessionReconnectStore;
}) {
  options.reconnectStore.deleteRuntime(options.sessionId);
}
