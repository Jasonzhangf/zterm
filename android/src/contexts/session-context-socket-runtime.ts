import type { SessionBufferHeadState } from './session-sync-helpers';
import type { BridgeTransportSocket } from '../lib/traversal/types';

interface MutableRefObject<T> {
  current: T;
}

export function clearSessionHeartbeat(options: {
  sessionId: string;
  pingIntervalsRef: MutableRefObject<Map<string, ReturnType<typeof setInterval>>>;
  lastPongAtRef: MutableRefObject<Map<string, number>>;
  lastServerActivityAtRef: MutableRefObject<Map<string, number>>;
}) {
  const heartbeat = options.pingIntervalsRef.current.get(options.sessionId);
  if (heartbeat) {
    clearInterval(heartbeat);
    options.pingIntervalsRef.current.delete(options.sessionId);
  }
  options.lastPongAtRef.current.delete(options.sessionId);
  options.lastServerActivityAtRef.current.delete(options.sessionId);
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
  sessionBufferHeadsRef: MutableRefObject<Map<string, SessionBufferHeadState>>;
  sessionRevisionResetRef: MutableRefObject<Map<string, { revision: number; latestEndIndex: number; seenAt: number }>>;
  lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
  pendingInputTailRefreshRef?: MutableRefObject<Map<string, { requestedAt: number; localRevision: number }>>;
  pendingConnectTailRefreshRef?: MutableRefObject<Set<string>>;
  pendingResumeTailRefreshRef?: MutableRefObject<Set<string>>;
}) {
  options.sessionBufferHeadsRef.current.delete(options.sessionId);
  options.sessionRevisionResetRef.current.delete(options.sessionId);
  options.lastHeadRequestAtRef.current.delete(options.sessionId);
  options.pendingInputTailRefreshRef?.current.delete(options.sessionId);
  options.pendingConnectTailRefreshRef?.current.delete(options.sessionId);
  options.pendingResumeTailRefreshRef?.current.delete(options.sessionId);
}

export function startSocketHeartbeat(options: {
  sessionId: string;
  ws: BridgeTransportSocket;
  finalizeFailure: (message: string, retryable: boolean) => void;
  pingIntervalsRef: MutableRefObject<Map<string, ReturnType<typeof setInterval>>>;
  lastPongAtRef: MutableRefObject<Map<string, number>>;
  clientPingIntervalMs: number;
  clientPongTimeoutMs: number;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const existingHeartbeat = options.pingIntervalsRef.current.get(options.sessionId);
  if (existingHeartbeat) {
    clearInterval(existingHeartbeat);
    options.pingIntervalsRef.current.delete(options.sessionId);
  }
  const pingInterval = setInterval(() => {
    if (options.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const lastPongAt = options.lastPongAtRef.current.get(options.sessionId) || 0;
    if (Date.now() - lastPongAt > options.clientPongTimeoutMs) {
      options.finalizeFailure('heartbeat timeout', true);
      if (options.ws.readyState < WebSocket.CLOSING) {
        options.ws.close();
      }
      return;
    }

    options.sendSocketPayload(options.sessionId, options.ws, JSON.stringify({ type: 'ping' }));
  }, options.clientPingIntervalMs);
  options.pingIntervalsRef.current.set(options.sessionId, pingInterval);
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
  staleTransportProbeAtRef: MutableRefObject<Map<string, number>>;
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
  options.staleTransportProbeAtRef.current.delete(options.sessionId);
}

export function clearReconnectRuntime(options: {
  sessionId: string;
  reconnectRuntimesRef: MutableRefObject<Map<string, { timer: number | null }>>;
}) {
  const reconnectRuntime = options.reconnectRuntimesRef.current.get(options.sessionId);
  if (!reconnectRuntime) {
    return;
  }
  if (reconnectRuntime.timer) {
    clearTimeout(reconnectRuntime.timer);
  }
  options.reconnectRuntimesRef.current.delete(options.sessionId);
}
