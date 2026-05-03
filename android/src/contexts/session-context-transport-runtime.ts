import type { Host, HostConfigMessage, ServerMessage } from '../lib/types';
import { getResolvedSessionName } from '../lib/connection-target';
import {
  clearSessionSupersededSockets,
  getSessionTargetControlTransport,
  getSessionTargetTransportRuntime,
  getSessionTransportHost,
  getSessionTransportRuntime,
  getSessionTransportSocket,
  getSessionTransportTargetKey,
  moveSessionTransportSocketToSuperseded,
  removeSessionTransportRuntime,
  setSessionTargetControlTransport,
  setSessionTransportSocket,
  upsertSessionTransportRuntime,
  type SessionTransportRuntimeStore,
} from '../lib/session-transport-runtime';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { PendingSessionTransportOpenIntent } from './session-sync-helpers';

type PendingSessionTransportWireIntent = PendingSessionTransportOpenIntent & {
  hostConfigPayload: HostConfigMessage;
};

export interface SessionContextTransportAccessors {
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportHost: (sessionId: string) => Host | null;
  readSessionTransportRuntime: (sessionId: string) => ReturnType<typeof getSessionTransportRuntime>;
  readSessionTargetRuntime: (sessionId: string) => ReturnType<typeof getSessionTargetTransportRuntime>;
  readSessionTargetKey: (sessionId: string) => string | null;
  readSessionTargetControlSocket: (sessionId: string) => BridgeTransportSocket | null;
  writeSessionTransportHost: (sessionId: string, host: Host) => ReturnType<typeof upsertSessionTransportRuntime>;
  writeSessionTransportSocket: (sessionId: string, socket: BridgeTransportSocket | null) => ReturnType<typeof setSessionTransportSocket>;
  writeSessionTargetControlSocket: (sessionId: string, socket: BridgeTransportSocket | null) => ReturnType<typeof setSessionTargetControlTransport>;
  moveSessionTransportSocketAside: (sessionId: string) => ReturnType<typeof moveSessionTransportSocketToSuperseded>;
  clearSessionTransportRuntime: (sessionId: string) => ReturnType<typeof removeSessionTransportRuntime>;
  drainSessionSupersededSockets: (sessionId: string) => ReturnType<typeof clearSessionSupersededSockets>;
}

interface SessionTransportRuntimeStoreRef {
  current: SessionTransportRuntimeStore;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

export function createSessionContextTransportAccessors(
  storeRef: SessionTransportRuntimeStoreRef,
): SessionContextTransportAccessors {
  return {
    readSessionTransportSocket: (sessionId) => getSessionTransportSocket(storeRef.current, sessionId),
    readSessionTransportHost: (sessionId) => getSessionTransportHost(storeRef.current, sessionId),
    readSessionTransportRuntime: (sessionId) => getSessionTransportRuntime(storeRef.current, sessionId),
    readSessionTargetRuntime: (sessionId) => getSessionTargetTransportRuntime(storeRef.current, sessionId),
    readSessionTargetKey: (sessionId) => getSessionTransportTargetKey(storeRef.current, sessionId),
    readSessionTargetControlSocket: (sessionId) => getSessionTargetControlTransport(storeRef.current, sessionId),
    writeSessionTransportHost: (sessionId, host) => upsertSessionTransportRuntime(storeRef.current, sessionId, host),
    writeSessionTransportSocket: (sessionId, socket) => setSessionTransportSocket(storeRef.current, sessionId, socket),
    writeSessionTargetControlSocket: (sessionId, socket) => setSessionTargetControlTransport(storeRef.current, sessionId, socket),
    moveSessionTransportSocketAside: (sessionId) => moveSessionTransportSocketToSuperseded(storeRef.current, sessionId),
    clearSessionTransportRuntime: (sessionId) => removeSessionTransportRuntime(storeRef.current, sessionId),
    drainSessionSupersededSockets: (sessionId) => clearSessionSupersededSockets(storeRef.current, sessionId),
  };
}

export function cleanupControlTransportSocket(options: {
  sessionId: string;
  shouldClose?: boolean;
  readSessionTargetControlSocket: (sessionId: string) => BridgeTransportSocket | null;
  writeSessionTargetControlSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
}) {
  const controlSocket = options.readSessionTargetControlSocket(options.sessionId);
  if (!controlSocket) {
    return;
  }
  controlSocket.onopen = null;
  controlSocket.onmessage = null;
  controlSocket.onerror = null;
  controlSocket.onclose = null;
  if (options.shouldClose && controlSocket.readyState < WebSocket.CLOSING) {
    controlSocket.close();
  }
  options.writeSessionTargetControlSocket(options.sessionId, null);
}

export function failPendingControlTargetIntents(options: {
  sessionId: string;
  message: string;
  retryable: boolean;
  readSessionTargetRuntime: (sessionId: string) => { sessionIds: string[] } | null;
  pendingSessionTransportOpenIntentsRef: { current: Map<string, PendingSessionTransportOpenIntent> };
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  writeSessionTransportToken: (sessionId: string, token: string | null) => unknown;
}) {
  const targetRuntime = options.readSessionTargetRuntime(options.sessionId);
  const targetSessionIds = targetRuntime?.sessionIds || [options.sessionId];
  for (const targetSessionId of targetSessionIds) {
    const pending = options.pendingSessionTransportOpenIntentsRef.current.get(targetSessionId) || null;
    if (!pending) {
      continue;
    }
    options.clearSessionHandshakeTimeout(targetSessionId);
    options.pendingSessionTransportOpenIntentsRef.current.delete(targetSessionId);
    options.writeSessionTransportToken(targetSessionId, null);
    pending.finalizeFailure(options.message, options.retryable);
  }
}

export function handleControlTransportMessage(options: {
  sessionId: string;
  openSessionTransportByIntent: ((intent: PendingSessionTransportOpenIntent) => void) | null;
  pendingSessionTransportOpenIntentsRef: { current: Map<string, PendingSessionTransportOpenIntent> };
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  writeSessionTransportToken: (sessionId: string, token: string | null) => unknown;
}, msg: ServerMessage) {
  switch (msg.type) {
    case 'session-ticket': {
      const payload = msg.payload;
      const intent = options.pendingSessionTransportOpenIntentsRef.current.get(payload.clientSessionId) || null;
      if (!intent) {
        return;
      }
      if (payload.clientSessionId !== intent.sessionId) {
        return;
      }
      options.clearSessionHandshakeTimeout(payload.clientSessionId);
      options.writeSessionTransportToken(payload.clientSessionId, payload.sessionTransportToken);
      options.pendingSessionTransportOpenIntentsRef.current.delete(payload.clientSessionId);
      options.openSessionTransportByIntent?.(intent);
      return;
    }
    case 'session-open-failed': {
      const payload = msg.payload;
      const intent = options.pendingSessionTransportOpenIntentsRef.current.get(payload.clientSessionId) || null;
      if (!intent) {
        return;
      }
      options.clearSessionHandshakeTimeout(payload.clientSessionId);
      options.pendingSessionTransportOpenIntentsRef.current.delete(payload.clientSessionId);
      options.writeSessionTransportToken(payload.clientSessionId, null);
      intent.finalizeFailure(payload.message, false);
      return;
    }
    case 'error': {
      const intent = options.pendingSessionTransportOpenIntentsRef.current.get(options.sessionId) || null;
      if (!intent) {
        return;
      }
      options.clearSessionHandshakeTimeout(options.sessionId);
      options.pendingSessionTransportOpenIntentsRef.current.delete(options.sessionId);
      options.writeSessionTransportToken(options.sessionId, null);
      intent.finalizeFailure(msg.payload.message, msg.payload.code !== 'unauthorized');
      return;
    }
    case 'pong':
      return;
    default:
      return;
  }
}

export function ensureControlTransportForSessionOpen(options: {
  intent: PendingSessionTransportWireIntent;
  readSessionTargetControlSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTargetRuntime: (sessionId: string) => { sessionIds: string[] } | null;
  readSessionTargetKey: (sessionId: string) => string | null;
  pendingSessionTransportOpenIntentsRef: { current: Map<string, PendingSessionTransportOpenIntent> };
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  setSessionHandshakeTimeout: (sessionId: string, callback: () => void, delayMs: number) => number;
  failPendingControlTargetIntents: (sessionId: string, message: string, retryable: boolean) => void;
  buildTraversalSocketForHost: (host: Host, transportRole?: 'control' | 'session') => BridgeTransportSocket;
  writeSessionTargetControlSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  applyTransportDiagnostics: (sessionId: string, socket: BridgeTransportSocket) => void;
  runtimeDebug: RuntimeDebugFn;
  recordSessionRx: (sessionId: string, data: string | ArrayBuffer) => void;
  handleControlTransportMessage: (options: { sessionId: string }, msg: ServerMessage) => void;
  cleanupControlSocket: (sessionId: string, shouldClose?: boolean) => void;
  sessionHandshakeTimeoutMs: number;
}) {
  const { sessionId, host } = options.intent;
  const existingControlSocket = options.readSessionTargetControlSocket(sessionId);

  const flushPendingSessionOpens = (anchorSessionId: string, socket: BridgeTransportSocket) => {
    const targetRuntime = options.readSessionTargetRuntime(anchorSessionId);
    const targetSessionIds = targetRuntime?.sessionIds || [anchorSessionId];
    for (const targetSessionId of targetSessionIds) {
      const pendingIntent = options.pendingSessionTransportOpenIntentsRef.current.get(targetSessionId) as PendingSessionTransportWireIntent | null;
      if (!pendingIntent) {
        continue;
      }
      options.sendSocketPayload(targetSessionId, socket, JSON.stringify({
        type: 'session-open',
        payload: pendingIntent.hostConfigPayload,
      }));
      options.runtimeDebug('session.control.session-open-sent', {
        sessionId: targetSessionId,
        targetKey: options.readSessionTargetKey(targetSessionId),
        sessionName: pendingIntent.resolvedSessionName,
      });
      options.clearSessionHandshakeTimeout(targetSessionId);
      options.setSessionHandshakeTimeout(targetSessionId, () => {
        options.failPendingControlTargetIntents(targetSessionId, 'session open timeout', true);
      }, options.sessionHandshakeTimeoutMs);
    }
  };

  if (existingControlSocket && existingControlSocket.readyState === WebSocket.OPEN) {
    flushPendingSessionOpens(sessionId, existingControlSocket);
    return;
  }

  if (existingControlSocket && existingControlSocket.readyState === WebSocket.CONNECTING) {
    return;
  }

  const controlSocket = options.buildTraversalSocketForHost(host, 'control');
  options.writeSessionTargetControlSocket(sessionId, controlSocket);
  options.runtimeDebug('session.control.opening', {
    sessionId,
    targetKey: options.readSessionTargetKey(sessionId),
    host: host.bridgeHost,
    port: host.bridgePort,
    sessionName: getResolvedSessionName(host),
  });
  controlSocket.onopen = () => {
    options.applyTransportDiagnostics(sessionId, controlSocket);
    options.runtimeDebug('session.control.open', {
      sessionId,
      targetKey: options.readSessionTargetKey(sessionId),
    });
    flushPendingSessionOpens(sessionId, controlSocket);
  };
  controlSocket.onmessage = (event) => {
    try {
      options.recordSessionRx(sessionId, event.data);
      if (typeof event.data !== 'string') {
        return;
      }
      const msg = JSON.parse(event.data) as ServerMessage;
      options.handleControlTransportMessage({ sessionId }, msg);
    } catch (error) {
      options.failPendingControlTargetIntents(
        sessionId,
        error instanceof Error ? error.message : 'control transport parse error',
        true,
      );
    }
  };
  controlSocket.onerror = () => {
    options.cleanupControlSocket(sessionId);
    options.failPendingControlTargetIntents(
      sessionId,
      controlSocket.getDiagnostics().reason || 'control transport error',
      true,
    );
  };
  controlSocket.onclose = () => {
    options.cleanupControlSocket(sessionId);
    options.failPendingControlTargetIntents(
      sessionId,
      controlSocket.getDiagnostics().reason || 'control transport closed',
      true,
    );
  };
}

export function openSocketConnectHandshake(options: {
  sessionId: string;
  host: Host;
  resolvedSessionName: string;
  ws: BridgeTransportSocket;
  debugScope: 'connect' | 'reconnect';
  activate?: boolean;
  readActiveSessionId: () => string | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  connectMessagePayload: HostConfigMessage;
  runtimeDebug: RuntimeDebugFn;
  flushRuntimeDebugLogs: () => void;
  startSocketHeartbeat: (
    sessionId: string,
    ws: BridgeTransportSocket,
    finalizeFailure: (message: string, retryable: boolean) => void,
  ) => void;
  finalizeFailure: (message: string, retryable: boolean) => void;
  onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
}) {
  const sessionName = options.resolvedSessionName;
  options.runtimeDebug(`session.ws.${options.debugScope}.onopen`, {
    sessionId: options.sessionId,
    activeSessionId: options.readActiveSessionId(),
    ...(options.debugScope === 'connect'
      ? { activate: Boolean(options.activate) }
      : { targetSessionName: sessionName }),
  });
  options.onBeforeConnectSend?.({ sessionName });
  options.sendSocketPayload(options.sessionId, options.ws, JSON.stringify({
    type: 'connect',
    payload: options.connectMessagePayload,
  }));
  options.runtimeDebug(`session.ws.${options.debugScope}.connect-sent`, {
    sessionId: options.sessionId,
    tmuxViewportFromUiShell: false,
  });
  options.flushRuntimeDebugLogs();
  options.startSocketHeartbeat(options.sessionId, options.ws, options.finalizeFailure);
}

export function bindSessionTransportSocketLifecycle(options: {
  sessionId: string;
  host: Host;
  resolvedSessionName: string;
  ws: BridgeTransportSocket;
  debugScope: 'connect' | 'reconnect';
  activate?: boolean;
  readActiveSessionId: () => string | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  connectMessagePayload: HostConfigMessage;
  runtimeDebug: RuntimeDebugFn;
  flushRuntimeDebugLogs: () => void;
  startSocketHeartbeat: (
    sessionId: string,
    ws: BridgeTransportSocket,
    finalizeFailure: (message: string, retryable: boolean) => void,
  ) => void;
  applyTransportDiagnostics: (sessionId: string, socket: BridgeTransportSocket) => void;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  setSessionHandshakeTimeout: (sessionId: string, callback: () => void, delayMs: number) => number;
  recordSessionRx: (sessionId: string, data: string | ArrayBuffer) => void;
  handleSocketServerMessage: (params: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
  }, msg: ServerMessage) => void;
  finalizeFailure: (message: string, retryable: boolean) => void;
  onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
  onConnected: () => void;
  sessionHandshakeTimeoutMs: number;
}) {
  const { sessionId, host, ws, debugScope, activate, finalizeFailure, onBeforeConnectSend, onConnected } = options;

  ws.onopen = () => {
    options.applyTransportDiagnostics(sessionId, ws);
    openSocketConnectHandshake({
      sessionId,
      host,
      resolvedSessionName: options.resolvedSessionName,
      ws,
      debugScope,
      activate,
      readActiveSessionId: options.readActiveSessionId,
      sendSocketPayload: options.sendSocketPayload,
      connectMessagePayload: options.connectMessagePayload,
      runtimeDebug: options.runtimeDebug,
      flushRuntimeDebugLogs: options.flushRuntimeDebugLogs,
      startSocketHeartbeat: options.startSocketHeartbeat,
      finalizeFailure,
      onBeforeConnectSend,
    });
    options.clearSessionHandshakeTimeout(sessionId);
    options.setSessionHandshakeTimeout(sessionId, () => {
      finalizeFailure('session handshake timeout', true);
    }, options.sessionHandshakeTimeoutMs);
  };

  ws.onmessage = (event) => {
    try {
      options.recordSessionRx(sessionId, event.data);
      if (typeof event.data !== 'string') {
        return;
      }
      const msg: ServerMessage = JSON.parse(event.data);
      options.handleSocketServerMessage({
        sessionId,
        host,
        ws,
        debugScope,
        onConnected,
        onFailure: finalizeFailure,
      }, msg);
    } catch (error) {
      finalizeFailure(error instanceof Error ? error.message : 'parse error', true);
    }
  };

  ws.onerror = () => finalizeFailure(ws.getDiagnostics().reason || 'transport error', true);
  ws.onclose = () => finalizeFailure(ws.getDiagnostics().reason || 'socket closed', true);
}
