import type { Host, ServerMessage, TerminalWidthMode } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import { buildSessionConnectPayload, buildSessionOpenPayload, buildSessionResizePayload } from './session-context-transport-wire-runtime';
import {
  bindSessionTransportSocketLifecycle as bindSessionTransportSocketLifecycleBaseRuntime,
  cleanupControlTransportSocket as cleanupControlTransportSocketBaseRuntime,
  ensureControlTransportForSessionOpen as ensureControlTransportForSessionOpenBaseRuntime,
  failPendingControlTargetIntents as failPendingControlTargetIntentsBaseRuntime,
  handleControlTransportMessage as handleControlTransportMessageBaseRuntime,
  openSocketConnectHandshake as openSocketConnectHandshakeBaseRuntime,
  type SessionContextTransportAccessors,
  createSessionContextTransportAccessors,
} from './session-context-transport-runtime';
import type { PendingSessionTransportOpenIntent } from './session-transport-open-helpers';
import type { SessionTransportRuntimeStore } from '../lib/session-transport-runtime';

interface MutableRefObject<T> {
  current: T;
}

export function createTransportAccessorsRuntime(
  storeRef: { current: SessionTransportRuntimeStore },
): SessionContextTransportAccessors {
  return createSessionContextTransportAccessors(storeRef);
}

export function cleanupControlSocketOrchestrationRuntime(options: {
  sessionId: string;
  shouldClose?: boolean;
  readSessionTargetControlSocket: (sessionId: string) => BridgeTransportSocket | null;
  writeSessionTargetControlSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
}) {
  cleanupControlTransportSocketBaseRuntime(options);
}

export function handleControlTransportMessageOrchestrationRuntime(options: {
  sessionId: string;
  openSessionTransportByIntent: ((intent: PendingSessionTransportOpenIntent) => void) | null;
  pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, PendingSessionTransportOpenIntent>>;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  writeSessionTransportToken: (sessionId: string, token: string | null) => unknown;
  failPendingControlTargetIntents?: (sessionId: string, message: string, retryable: boolean) => void;
  msg: ServerMessage;
}) {
  handleControlTransportMessageBaseRuntime({
    sessionId: options.sessionId,
    openSessionTransportByIntent: options.openSessionTransportByIntent,
    pendingSessionTransportOpenIntentsRef: options.pendingSessionTransportOpenIntentsRef,
    clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
    writeSessionTransportToken: options.writeSessionTransportToken,
    failPendingControlTargetIntents: options.failPendingControlTargetIntents,
  }, options.msg);
}

export function failPendingControlTargetIntentsOrchestrationRuntime(options: {
  sessionId: string;
  message: string;
  retryable: boolean;
  readSessionTargetRuntime: (sessionId: string) => { sessionIds: string[] } | null;
  pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, PendingSessionTransportOpenIntent>>;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  writeSessionTransportToken: (sessionId: string, token: string | null) => unknown;
}) {
  failPendingControlTargetIntentsBaseRuntime(options);
}

export function ensureControlTransportForSessionOpenOrchestrationRuntime(options: {
  intent: PendingSessionTransportOpenIntent;
  readSessionTargetControlSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTargetRuntime: (sessionId: string) => { sessionIds: string[] } | null;
  readSessionTargetKey: (sessionId: string) => string | null;
  pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, PendingSessionTransportOpenIntent>>;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  setSessionHandshakeTimeout: (sessionId: string, callback: () => void, delayMs: number) => number;
  failPendingControlTargetIntents: (sessionId: string, message: string, retryable: boolean) => void;
  buildTraversalSocketForHost: (host: Host, transportRole?: 'control' | 'session') => BridgeTransportSocket;
  writeSessionTargetControlSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  applyTransportDiagnostics: (sessionId: string, socket: BridgeTransportSocket) => void;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  recordControlTransportRxBytes: (sessionId: string, data: string | ArrayBuffer) => void;
  handleControlTransportMessage: (options: { sessionId: string }, msg: ServerMessage) => void;
  cleanupControlSocket: (sessionId: string, shouldClose?: boolean) => void;
  sessionHandshakeTimeoutMs: number;
  readRequestedTerminalGeometry?: (sessionId: string) => { cols?: number | null; rows?: number | null; widthMode?: TerminalWidthMode } | null;
}) {
  ensureControlTransportForSessionOpenBaseRuntime({
    ...options,
    intent: {
      ...options.intent,
      hostConfigPayload: buildSessionOpenPayload({
        host: options.intent.host,
        resolvedSessionName: options.intent.resolvedSessionName,
        sessionId: options.intent.sessionId,
        openRequestId: options.intent.openRequestId,
        geometry: options.readRequestedTerminalGeometry?.(options.intent.sessionId) || null,
      }),
    },
  });
}

export function primeSessionTransportSocketRuntime(options: {
  sessionId: string;
  ws: BridgeTransportSocket;
  writeSessionTransportSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  updateSessionSync: (id: string, updates: Partial<{ ws: null }>) => void;
  lastPongAtRef: MutableRefObject<Map<string, number>>;
}) {
  options.writeSessionTransportSocket(options.sessionId, options.ws);
  options.updateSessionSync(options.sessionId, { ws: null });
  options.lastPongAtRef.current.set(options.sessionId, Date.now());
}

export function bindSessionTransportSocketLifecycleOrchestrationRuntime(options: {
  sessionId: string;
  openRequestId: string;
  host: Host;
  resolvedSessionName: string;
  ws: BridgeTransportSocket;
  debugScope: 'connect' | 'reconnect';
  activate?: boolean;
  readActiveSessionId: () => string | null;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportToken: (sessionId: string) => string | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
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
  isSessionTransportActive?: (sessionId: string) => boolean;
  shouldAcceptSessionLiveBuffer?: (sessionId: string) => boolean;
  handleSocketServerMessage: (params: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
    onClosed: (reason?: string) => void;
  }, msg: ServerMessage) => void;
  finalizeFailure: (message: string, retryable: boolean) => void;
  onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
  onConnected: () => void;
  onClosed?: (reason?: string) => void;
  sessionHandshakeTimeoutMs: number;
  readRequestedTerminalGeometry?: (sessionId: string) => { cols?: number | null; rows?: number | null; widthMode?: TerminalWidthMode } | null;
}) {
  bindSessionTransportSocketLifecycleBaseRuntime({
    ...options,
    shouldAcceptSessionLiveBuffer: options.shouldAcceptSessionLiveBuffer,
    connectMessagePayload: buildSessionConnectPayload({
      host: options.host,
      resolvedSessionName: options.resolvedSessionName,
      sessionId: options.sessionId,
      openRequestId: options.openRequestId,
      sessionTransportToken: options.readSessionTransportToken(options.sessionId),
      geometry: options.readRequestedTerminalGeometry?.(options.sessionId) || null,
    }),
    onClosed: options.onClosed,
  });
}

export function sendTerminalResizeRuntime(options: {
  sessionId: string;
  ws: BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  writeRequestedTerminalGeometry: (
    sessionId: string,
    geometry: { cols?: number | null; rows?: number | null; widthMode?: TerminalWidthMode } | null,
  ) => unknown;
  cols?: number | null;
  rows?: number | null;
  widthMode?: TerminalWidthMode;
}) {
  const normalizedWidthMode = options.widthMode === 'adaptive-phone' ? 'adaptive-phone' : 'mirror-fixed';
  const adaptiveCols = Number.isFinite(options.cols) ? Math.max(1, Math.floor(options.cols || 0)) : undefined;
  if (normalizedWidthMode === 'adaptive-phone' && !adaptiveCols) {
    return false;
  }
  const geometry: { cols?: number | null; rows?: number | null; widthMode?: TerminalWidthMode } = normalizedWidthMode === 'adaptive-phone'
    ? {
        cols: adaptiveCols,
        widthMode: normalizedWidthMode,
      }
    : {
        widthMode: normalizedWidthMode,
      };
  options.writeRequestedTerminalGeometry(options.sessionId, geometry);
  if (!options.ws || options.ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  options.sendSocketPayload(options.sessionId, options.ws, JSON.stringify({
    type: 'resize',
    payload: buildSessionResizePayload({
      cols: options.cols,
      rows: options.rows,
      widthMode: options.widthMode,
    }),
  }));
  return true;
}

export function openSocketConnectHandshakeOrchestrationRuntime(options: Parameters<typeof openSocketConnectHandshakeBaseRuntime>[0]) {
  openSocketConnectHandshakeBaseRuntime(options);
}
