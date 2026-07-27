import type { Host, HostConfigMessage, ServerMessage } from '../lib/types';
import type { SessionTerminalChannelRuntime } from '../lib/session-transport-runtime';
import {
  clearSessionSupersededSockets,
  ensureSessionTerminalChannel,
  getOpeningSessionTerminalChannelsForTarget,
  getSessionIdForTerminalChannel,
  getSessionRequestedTerminalGeometry,
  getSessionTargetControlTransport,
  getSessionTargetTerminalMuxReady,
  getSessionTargetTerminalTransport,
  getSessionTargetTransportRuntime,
  getSessionTerminalChannel,
  getSessionTransportHost,
  getSessionTransportResource,
  getSessionTransportRuntime,
  getSessionTransportSocket,
  getSessionTransportTargetKey,
  moveSessionTransportSocketToSuperseded,
  removeSessionTransportRuntime,
  setSessionTargetTerminalMuxReady,
  setSessionTargetTerminalTransport,
  setSessionRequestedTerminalGeometry,
  setSessionTargetControlTransport,
  setSessionTransportSocket,
  updateSessionTerminalChannelState,
  upsertSessionTransportRuntime,
  type SessionTransportRuntimeStore,
} from '../lib/session-transport-runtime';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import {
  buildTerminalMuxChannelMessage,
  buildTerminalMuxChannelOpen,
  buildTerminalMuxHello,
  isTerminalMuxServerFrame,
  type TerminalMuxTargetServerMessage,
  type TerminalMuxServerFrame,
} from '@zterm/shared/protocol';

function estimateIncomingFrameBytes(data: string | ArrayBuffer) {
  if (typeof data !== 'string') {
    return data.byteLength;
  }
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(data).byteLength;
  }
  return data.length;
}

export interface SessionContextTransportAccessors {
  readSessionTransportResource: (sessionId: string) => ReturnType<typeof getSessionTransportResource>;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportHost: (sessionId: string) => Host | null;
  readSessionTransportRuntime: (sessionId: string) => ReturnType<typeof getSessionTransportRuntime>;
  readSessionTargetRuntime: (sessionId: string) => ReturnType<typeof getSessionTargetTransportRuntime>;
  readSessionTargetKey: (sessionId: string) => string | null;
  readSessionTargetControlSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTargetTerminalSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTargetTerminalMuxReady: (sessionId: string) => boolean;
  readSessionTerminalChannel: (sessionId: string) => ReturnType<typeof getSessionTerminalChannel>;
  readSessionIdForTerminalChannel: (anchorSessionId: string, channelId: string) => string | null;
  readOpeningSessionTerminalChannelsForTarget: (anchorSessionId: string) => ReturnType<typeof getOpeningSessionTerminalChannelsForTarget>;
  readSessionRequestedTerminalGeometry: (sessionId: string) => ReturnType<typeof getSessionRequestedTerminalGeometry>;
  writeSessionTransportHost: (sessionId: string, host: Host) => ReturnType<typeof upsertSessionTransportRuntime>;
  writeSessionTransportSocket: (sessionId: string, socket: BridgeTransportSocket | null) => ReturnType<typeof setSessionTransportSocket>;
  writeSessionTargetControlSocket: (sessionId: string, socket: BridgeTransportSocket | null) => ReturnType<typeof setSessionTargetControlTransport>;
  writeSessionTargetTerminalSocket: (sessionId: string, socket: BridgeTransportSocket | null) => ReturnType<typeof setSessionTargetTerminalTransport>;
  writeSessionTargetTerminalMuxReady: (sessionId: string, ready: boolean) => ReturnType<typeof setSessionTargetTerminalMuxReady>;
  ensureSessionTerminalChannel: (sessionId: string, options?: Parameters<typeof ensureSessionTerminalChannel>[2]) => ReturnType<typeof ensureSessionTerminalChannel>;
  writeSessionTerminalChannelState: (sessionId: string, state: Parameters<typeof updateSessionTerminalChannelState>[2]) => ReturnType<typeof updateSessionTerminalChannelState>;
  writeSessionRequestedTerminalGeometry: (
    sessionId: string,
    geometry: { cols?: number | null; rows?: number | null; widthMode?: 'adaptive-phone' | 'mirror-fixed' } | null,
  ) => ReturnType<typeof setSessionRequestedTerminalGeometry>;
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

function resolveIncomingMessageTypeFast(data: string): string | null {
  const match = /"type"\s*:\s*"([^"]+)"/.exec(data);
  if (!match || typeof match[1] !== 'string') {
    return null;
  }
  return match[1];
}

export function buildSessionMuxChannelOpenFrame(options: {
  channel: Pick<SessionTerminalChannelRuntime, 'channelId' | 'sessionName' | 'bodySubscribed'>;
  sessionName?: string;
  host?: Pick<Host, 'autoCommand'>;
  geometry?: { cols?: number | null; rows?: number | null; widthMode?: 'adaptive-phone' | 'mirror-fixed' } | null;
}) {
  const geometry = options.geometry || null;
  return buildTerminalMuxChannelOpen({
    channelId: options.channel.channelId,
    sessionName: options.sessionName || options.channel.sessionName,
    ...(Number.isFinite(geometry?.cols) ? { cols: Math.max(1, Math.floor(geometry?.cols || 0)) } : {}),
    ...(Number.isFinite(geometry?.rows) ? { rows: Math.max(1, Math.floor(geometry?.rows || 0)) } : {}),
    ...(geometry?.widthMode ? { widthMode: geometry.widthMode } : {}),
    ...(typeof options.host?.autoCommand === 'string' && options.host.autoCommand.trim() ? { autoCommand: options.host.autoCommand.trim() } : {}),
    bodySubscribed: options.channel.bodySubscribed,
  });
}

export function sendSessionMuxChannelOpenRuntime(options: {
  sessionId: string;
  ws: BridgeTransportSocket;
  channel: Pick<SessionTerminalChannelRuntime, 'channelId' | 'sessionName' | 'bodySubscribed'>;
  sessionName?: string;
  host?: Pick<Host, 'autoCommand'>;
  geometry?: { cols?: number | null; rows?: number | null; widthMode?: 'adaptive-phone' | 'mirror-fixed' } | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  options.sendSocketPayload(
    options.sessionId,
    options.ws,
    JSON.stringify(buildSessionMuxChannelOpenFrame({
      channel: options.channel,
      sessionName: options.sessionName,
      host: options.host,
      geometry: options.geometry,
    })),
  );
}

export function createSessionContextTransportAccessors(
  storeRef: SessionTransportRuntimeStoreRef,
): SessionContextTransportAccessors {
  return {
    readSessionTransportResource: (sessionId) => getSessionTransportResource(storeRef.current, sessionId),
    readSessionTransportSocket: (sessionId) => getSessionTransportSocket(storeRef.current, sessionId),
    readSessionTransportHost: (sessionId) => getSessionTransportHost(storeRef.current, sessionId),
    readSessionTransportRuntime: (sessionId) => getSessionTransportRuntime(storeRef.current, sessionId),
    readSessionTargetRuntime: (sessionId) => getSessionTargetTransportRuntime(storeRef.current, sessionId),
    readSessionTargetKey: (sessionId) => getSessionTransportTargetKey(storeRef.current, sessionId),
    readSessionTargetControlSocket: (sessionId) => getSessionTargetControlTransport(storeRef.current, sessionId),
    readSessionTargetTerminalSocket: (sessionId) => getSessionTargetTerminalTransport(storeRef.current, sessionId),
    readSessionTargetTerminalMuxReady: (sessionId) => getSessionTargetTerminalMuxReady(storeRef.current, sessionId),
    readSessionTerminalChannel: (sessionId) => getSessionTerminalChannel(storeRef.current, sessionId),
    readSessionIdForTerminalChannel: (anchorSessionId, channelId) => {
      const targetKey = getSessionTransportTargetKey(storeRef.current, anchorSessionId);
      return targetKey ? getSessionIdForTerminalChannel(storeRef.current, targetKey, channelId) : null;
    },
    readOpeningSessionTerminalChannelsForTarget: (anchorSessionId) => {
      const targetKey = getSessionTransportTargetKey(storeRef.current, anchorSessionId);
      return targetKey ? getOpeningSessionTerminalChannelsForTarget(storeRef.current, targetKey, anchorSessionId) : [];
    },
    readSessionRequestedTerminalGeometry: (sessionId) => getSessionRequestedTerminalGeometry(storeRef.current, sessionId),
    writeSessionTransportHost: (sessionId, host) => upsertSessionTransportRuntime(storeRef.current, sessionId, host),
    writeSessionTransportSocket: (sessionId, socket) => setSessionTransportSocket(storeRef.current, sessionId, socket),
    writeSessionTargetControlSocket: (sessionId, socket) => setSessionTargetControlTransport(storeRef.current, sessionId, socket),
    writeSessionTargetTerminalSocket: (sessionId, socket) => setSessionTargetTerminalTransport(storeRef.current, sessionId, socket),
    writeSessionTargetTerminalMuxReady: (sessionId, ready) => setSessionTargetTerminalMuxReady(storeRef.current, sessionId, ready),
    ensureSessionTerminalChannel: (sessionId, options) => ensureSessionTerminalChannel(storeRef.current, sessionId, options),
    writeSessionTerminalChannelState: (sessionId, state) => updateSessionTerminalChannelState(storeRef.current, sessionId, state),
    writeSessionRequestedTerminalGeometry: (sessionId, geometry) => setSessionRequestedTerminalGeometry(storeRef.current, sessionId, geometry),
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

export function handleTargetMuxServerFrameRuntime(options: {
  anchorSessionId: string;
  host: Host;
  ws: BridgeTransportSocket;
  debugScope: 'connect' | 'reconnect';
  rawFrameBytes?: number;
  frame: TerminalMuxServerFrame;
  resolveSessionIdForChannel: (channelId: string) => string | null;
  readSessionTerminalChannelBodySubscribed?: (sessionId: string) => boolean | null;
  updateSessionTerminalChannelState: (sessionId: string, state: 'opening' | 'open' | 'closing' | 'closed') => unknown;
  sendSocketPayload?: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  handleSocketServerMessage: (params: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    rawFrameBytes?: number;
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
    onClosed: (reason?: string) => void;
  }, msg: ServerMessage) => void;
  buildChannelCallbacks: (sessionId: string) => {
    onChannelAllocated?: () => void;
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
    onClosed: (reason?: string) => void;
  };
  handleTargetMuxMessage?: (payload: { requestId?: string; message: TerminalMuxTargetServerMessage }) => boolean;
  recordSessionRx?: (sessionId: string, data: string | ArrayBuffer) => void;
  rawFrameData?: string;
  runtimeDebug: RuntimeDebugFn;
}) {
  const recordChannelActivity = (sessionId: string) => {
    options.recordSessionRx?.(
      sessionId,
      options.rawFrameData || JSON.stringify(options.frame),
    );
  };

  const dispatchChannelMessage = (channelId: string, message: ServerMessage) => {
    const sessionId = options.resolveSessionIdForChannel(channelId);
    if (!sessionId) {
      options.runtimeDebug('session.mux.channel-message.unknown-channel', {
        anchorSessionId: options.anchorSessionId,
        channelId,
        messageType: message.type,
      });
      return;
    }
    if (message.type !== 'pong') {
      recordChannelActivity(sessionId);
    }
    if (message.type === 'closed') {
      options.updateSessionTerminalChannelState(sessionId, 'closed');
    }
    const callbacks = options.buildChannelCallbacks(sessionId);
    options.handleSocketServerMessage({
      sessionId,
      host: options.host,
      ws: options.ws,
      debugScope: options.debugScope,
      rawFrameBytes: options.rawFrameBytes,
      onConnected: callbacks.onConnected,
      onFailure: callbacks.onFailure,
      onClosed: callbacks.onClosed,
    }, message);
  };

  switch (options.frame.type) {
    case 'mux-channel-message':
      dispatchChannelMessage(options.frame.payload.channelId, options.frame.payload.message as ServerMessage);
      return;
    case 'mux-channel-opened': {
      const sessionId = options.resolveSessionIdForChannel(options.frame.payload.channelId);
      if (!sessionId) {
        options.runtimeDebug('session.mux.channel-opened.unknown-channel', {
          anchorSessionId: options.anchorSessionId,
          channelId: options.frame.payload.channelId,
          sessionName: options.frame.payload.sessionName,
        });
        return;
      }
      recordChannelActivity(sessionId);
      options.updateSessionTerminalChannelState(sessionId, 'open');
      options.buildChannelCallbacks(sessionId).onChannelAllocated?.();
      const bodySubscribed = options.readSessionTerminalChannelBodySubscribed?.(sessionId);
      if (typeof bodySubscribed === 'boolean') {
        options.sendSocketPayload?.(sessionId, options.ws, JSON.stringify(buildTerminalMuxChannelMessage(
          options.frame.payload.channelId,
          {
            type: 'body-subscription',
            payload: {
              version: 1,
              subscribed: bodySubscribed,
            },
          },
        )));
      }
      return;
    }
    case 'mux-channel-closed': {
      const sessionId = options.resolveSessionIdForChannel(options.frame.payload.channelId);
      if (!sessionId) {
        options.runtimeDebug('session.mux.channel-closed.unknown-channel', {
          anchorSessionId: options.anchorSessionId,
          channelId: options.frame.payload.channelId,
          reason: options.frame.payload.reason,
        });
        return;
      }
      recordChannelActivity(sessionId);
      options.updateSessionTerminalChannelState(sessionId, 'closed');
      options.buildChannelCallbacks(sessionId).onClosed(options.frame.payload.reason);
      return;
    }
    case 'mux-error': {
      const channelId = typeof options.frame.payload.channelId === 'string' ? options.frame.payload.channelId : '';
      if (!channelId) {
        options.runtimeDebug('session.mux.target-error', {
          anchorSessionId: options.anchorSessionId,
          code: options.frame.payload.code,
          message: options.frame.payload.message,
        });
        return;
      }
      dispatchChannelMessage(channelId, {
        type: 'error',
        payload: {
          code: options.frame.payload.code,
          message: options.frame.payload.message,
        },
      });
      return;
    }
    case 'mux-target-message':
      if (options.handleTargetMuxMessage?.(options.frame.payload)) {
        return;
      }
      options.runtimeDebug('session.mux.target-frame', {
        anchorSessionId: options.anchorSessionId,
        type: options.frame.type,
      });
      return;
    case 'mux-ready':
    case 'mux-pong':
      options.runtimeDebug('session.mux.target-frame', {
        anchorSessionId: options.anchorSessionId,
        type: options.frame.type,
      });
      return;
  }
}

export function bindTargetMuxTransportSocketLifecycleRuntime(options: {
  sessionId: string;
  targetHeartbeatKey: string;
  host: Host;
  ws: BridgeTransportSocket;
  debugScope: 'connect' | 'reconnect';
  readSessionTargetTerminalSocket: (sessionId: string) => BridgeTransportSocket | null;
  readRequestedTerminalGeometry: (
    sessionId: string,
  ) => { cols?: number | null; rows?: number | null; widthMode?: 'adaptive-phone' | 'mirror-fixed' } | null;
  getOpeningSessionTerminalChannelsForTarget: (sessionId: string) => SessionTerminalChannelRuntime[];
  setSessionTargetMuxReady: (sessionId: string, ready: boolean) => unknown;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  handleTargetMuxServerFrame: (
    frame: TerminalMuxServerFrame,
    rawFrameBytes?: number,
    rawFrameData?: string,
  ) => void;
  applyTransportDiagnostics: (sessionId: string, socket: BridgeTransportSocket) => void;
  startSocketHeartbeat?: (
    sessionId: string,
    ws: BridgeTransportSocket,
    finalizeFailure: (message: string, retryable: boolean) => void,
    heartbeatOptions?: { heartbeatKey?: string },
  ) => void;
  recordTargetServerActivity?: (heartbeatKey: string) => void;
  recordTargetPong?: (heartbeatKey: string) => void;
  runtimeDebug: RuntimeDebugFn;
  finalizeFailure: (message: string, retryable: boolean) => void;
}) {
  const isCurrentTargetSocket = () => options.readSessionTargetTerminalSocket(options.sessionId) === options.ws;
  let targetFailureFinalized = false;
  const finalizeTargetFailure = (message: string, retryable = true) => {
    if (targetFailureFinalized) {
      return;
    }
    targetFailureFinalized = true;
    options.finalizeFailure(message, retryable);
  };

  options.ws.onopen = () => {
    if (!isCurrentTargetSocket()) {
      return;
    }
    options.applyTransportDiagnostics(options.sessionId, options.ws);
    options.sendSocketPayload(
      options.sessionId,
      options.ws,
      JSON.stringify(buildTerminalMuxHello(options.sessionId)),
    );
    options.runtimeDebug(`session.mux.${options.debugScope}.hello-sent`, {
      sessionId: options.sessionId,
    });
    if (!options.targetHeartbeatKey.trim()) {
      finalizeTargetFailure('missing terminal mux target heartbeat key', true);
      return;
    }
    options.startSocketHeartbeat?.(options.sessionId, options.ws, finalizeTargetFailure, {
      heartbeatKey: options.targetHeartbeatKey,
    });
  };

  options.ws.onmessage = (event) => {
    if (!isCurrentTargetSocket()) {
      return;
    }
    try {
      if (typeof event.data !== 'string') {
        finalizeTargetFailure('invalid terminal mux frame', true);
        return;
      }
      const rawFrameBytes = estimateIncomingFrameBytes(event.data);
      const parsed = JSON.parse(event.data) as unknown;
      if (!isTerminalMuxServerFrame(parsed)) {
        finalizeTargetFailure('invalid terminal mux frame', true);
        return;
      }
      options.recordTargetServerActivity?.(options.targetHeartbeatKey);
      if (parsed.type === 'mux-pong') {
        options.recordTargetPong?.(options.targetHeartbeatKey);
      }
      if (parsed.type === 'mux-ready') {
        options.setSessionTargetMuxReady(options.sessionId, true);
        options.runtimeDebug(`session.mux.${options.debugScope}.ready`, {
          sessionId: options.sessionId,
        });
        for (const channel of options.getOpeningSessionTerminalChannelsForTarget(options.sessionId)) {
          sendSessionMuxChannelOpenRuntime({
            sessionId: channel.sessionId,
            ws: options.ws,
            channel,
            host: options.host,
            geometry: options.readRequestedTerminalGeometry(channel.sessionId),
            sendSocketPayload: options.sendSocketPayload,
          });
        }
        return;
      }
      options.handleTargetMuxServerFrame(parsed, rawFrameBytes, event.data);
    } catch (error) {
      finalizeTargetFailure(error instanceof Error ? error.message : 'terminal mux parse error', true);
    }
  };

  options.ws.onerror = () => {
    if (!isCurrentTargetSocket()) {
      return;
    }
    options.setSessionTargetMuxReady(options.sessionId, false);
    finalizeTargetFailure(options.ws.getDiagnostics().reason || 'terminal mux transport error', true);
  };

  options.ws.onclose = () => {
    if (!isCurrentTargetSocket()) {
      return;
    }
    options.setSessionTargetMuxReady(options.sessionId, false);
    finalizeTargetFailure(options.ws.getDiagnostics().reason || 'terminal mux transport closed', true);
  };
}

export function openSocketConnectHandshake(options: {
  sessionId: string;
  host: Host;
  resolvedSessionName: string;
  ws: BridgeTransportSocket;
  debugScope: 'connect' | 'reconnect';
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
    targetSessionName: sessionName,
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
  readActiveSessionId: () => string | null;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
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
  isSessionTransportActive?: (sessionId: string) => boolean;
  shouldAcceptSessionLiveBuffer?: (sessionId: string) => boolean;
  handleSocketServerMessage: (params: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    rawFrameBytes?: number;
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
    onClosed: (reason?: string) => void;
  }, msg: ServerMessage) => void;
  finalizeFailure: (message: string, retryable: boolean) => void;
  onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
  onConnected: () => void;
  onClosed?: (reason?: string) => void;
  sessionHandshakeTimeoutMs: number;
}) {
  const { sessionId, host, ws, debugScope, finalizeFailure, onBeforeConnectSend, onConnected } = options;
  const isCurrentActiveSocket = () => options.readSessionTransportSocket(sessionId) === ws;

  ws.onopen = () => {
    if (!isCurrentActiveSocket()) {
      return;
    }
    options.applyTransportDiagnostics(sessionId, ws);
    openSocketConnectHandshake({
      sessionId,
      host,
      resolvedSessionName: options.resolvedSessionName,
      ws,
      debugScope,
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
    if (!isCurrentActiveSocket()) {
      return;
    }
    try {
      options.recordSessionRx(sessionId, event.data);
      if (typeof event.data !== 'string') {
        return;
      }
      const fastMessageType = resolveIncomingMessageTypeFast(event.data);
      if (fastMessageType === 'buffer-sync' && options.isSessionTransportActive && !options.isSessionTransportActive(sessionId)) {
        if (!options.shouldAcceptSessionLiveBuffer?.(sessionId)) {
          options.runtimeDebug?.(`session.ws.${debugScope}.buffer-sync.preparse-inactive-drop`, {
            sessionId,
          });
          return;
        }
      }
      const msg: ServerMessage = JSON.parse(event.data);
      options.handleSocketServerMessage({
        sessionId,
        host,
        ws,
        debugScope,
        rawFrameBytes: estimateIncomingFrameBytes(event.data),
        onConnected,
        onFailure: finalizeFailure,
        onClosed: (reason) => {
          options.onClosed?.(reason);
        },
      }, msg);
    } catch (error) {
      finalizeFailure(error instanceof Error ? error.message : 'parse error', true);
    }
  };

  ws.onerror = () => {
    if (!isCurrentActiveSocket()) {
      return;
    }
    finalizeFailure(ws.getDiagnostics().reason || 'transport error', true);
  };
  ws.onclose = () => {
    if (!isCurrentActiveSocket()) {
      return;
    }
    finalizeFailure(ws.getDiagnostics().reason || 'socket closed', true);
  };
}
