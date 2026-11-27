import type { Host, HostConfigMessage, ServerMessage } from '../lib/types';
import { buildBodySubscriptionMessage } from './session-wire-helpers';
import type { SessionTerminalChannelRuntime, SessionTerminalChannelState } from '../lib/terminal-channel-mux-runtime';
import {
  ensureSessionTerminalChannel,
  getOpeningSessionTerminalChannelsForTarget,
  getSessionIdForTerminalChannel,
  getSessionTerminalChannel,
  updateSessionTerminalChannelName,
  updateSessionTerminalChannelState,
  TerminalMuxChannelNotOpenError,
  markTerminalChannelConnected,
} from '../lib/terminal-channel-mux-runtime';
import {
  clearSessionSupersededSockets,
  listTargetTransportRuntimes,
  getTargetTransportRuntime,
  getTargetTerminalTransport,
  getSessionRequestedTerminalGeometry,
  getSessionTargetControlTransport,
  getSessionTargetTerminalMuxReady,
  getSessionTargetTerminalTransport,
  getSessionTargetTransportRuntime,
  getSessionTransportHost,
  getSessionTransportResource,
  getSessionTransportRuntime,
  getSessionTransportSocket,
  getSessionTransportTargetKey,
  getTargetTransportTraversalDiagnostics,
  moveSessionTransportSocketToSuperseded,
  removeSessionTransportRuntime,
  setSessionTargetTerminalMuxReady,
  setSessionTargetTerminalTransport,
  setTargetTerminalMuxReady,
  setTargetTerminalTransport,
  setSessionRequestedTerminalGeometry,
  setSessionTargetControlTransport,
  setSessionTransportSocket,
  upsertSessionTransportRuntime,
  type SessionTransportHost,
  type SessionTransportRuntimeStore,
} from '../lib/session-transport-runtime';
import type { BridgeTransportSocket, TraversalDiagnostics } from '../lib/traversal/types';
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
  readTargetTransportRuntimes: () => ReturnType<typeof listTargetTransportRuntimes>;
  readTargetTransportRuntime: (targetKey: string) => ReturnType<typeof getTargetTransportRuntime>;
  readTargetTerminalSocket: (targetKey: string) => BridgeTransportSocket | null;
  readSessionTransportResource: (sessionId: string) => ReturnType<typeof getSessionTransportResource>;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  /** Route and round-trip facts for the session's physical transport (A-2). */
  readSessionTraversalDiagnostics: (sessionId: string) => TraversalDiagnostics | null;
  readSessionTransportHost: (sessionId: string) => SessionTransportHost | null;
  readSessionTransportRuntime: (sessionId: string) => ReturnType<typeof getSessionTransportRuntime>;
  readSessionTargetRuntime: (sessionId: string) => ReturnType<typeof getSessionTargetTransportRuntime>;
  readSessionTargetKey: (sessionId: string) => string | null;
  readSessionTargetControlSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTargetTerminalSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTargetTerminalMuxReady: (sessionId: string) => boolean;
  readSessionTerminalChannel: (sessionId: string) => ReturnType<typeof getSessionTerminalChannel>;
  readSessionIdForTerminalChannel: (anchorSessionId: string, channelId: string) => string | null;
  readTargetSessionIdForTerminalChannel: (targetKey: string, channelId: string) => string | null;
  readOpeningSessionTerminalChannelsForTarget: (anchorSessionId: string) => ReturnType<typeof getOpeningSessionTerminalChannelsForTarget>;
  readOpeningTerminalChannelsForTarget: (
    targetKey: string,
    prioritySessionId?: string | null,
  ) => ReturnType<typeof getOpeningSessionTerminalChannelsForTarget>;
  readSessionRequestedTerminalGeometry: (sessionId: string) => ReturnType<typeof getSessionRequestedTerminalGeometry>;
  writeSessionTransportHost: (sessionId: string, host: SessionTransportHost) => ReturnType<typeof upsertSessionTransportRuntime>;
  writeSessionTransportSocket: (sessionId: string, socket: BridgeTransportSocket | null) => ReturnType<typeof setSessionTransportSocket>;
  writeSessionTargetControlSocket: (sessionId: string, socket: BridgeTransportSocket | null) => ReturnType<typeof setSessionTargetControlTransport>;
  writeSessionTargetTerminalSocket: (sessionId: string, socket: BridgeTransportSocket | null) => ReturnType<typeof setSessionTargetTerminalTransport>;
  writeSessionTargetTerminalMuxReady: (sessionId: string, ready: boolean) => ReturnType<typeof setSessionTargetTerminalMuxReady>;
  writeTargetTerminalSocket: (targetKey: string, socket: BridgeTransportSocket | null) => ReturnType<typeof setTargetTerminalTransport>;
  writeTargetTerminalMuxReady: (targetKey: string, ready: boolean) => ReturnType<typeof setTargetTerminalMuxReady>;
  ensureSessionTerminalChannel: (sessionId: string, options?: Parameters<typeof ensureSessionTerminalChannel>[2]) => ReturnType<typeof ensureSessionTerminalChannel>;
  writeSessionTerminalChannelName: (sessionId: string, sessionName: string) => ReturnType<typeof updateSessionTerminalChannelName>;
  writeSessionTerminalChannelState: (sessionId: string, state: SessionTerminalChannelState) => ReturnType<typeof updateSessionTerminalChannelState>;
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

export class SessionMuxOpenIntentError extends Error {
  constructor(public readonly reason: 'blank-identity' | 'missing-backend') {
    super(reason === 'blank-identity'
      ? 'terminal mux exact session identity is required'
      : 'terminal mux exact session backend is required');
  }
}

export interface InvalidSessionMuxOpenIntent {
  sessionId: string;
  channelId: string;
  ws: BridgeTransportSocket;
  invalidIntent: SessionMuxOpenIntentError;
}

export function buildSessionMuxChannelOpenFrame(options: {
  channel: Pick<SessionTerminalChannelRuntime, 'channelId' | 'sessionName' | 'bodySubscribed'>;
  sessionName?: string;
  host?: Pick<SessionTransportHost, 'autoCommand' | 'terminalBackend' | 'expectedSessionIdentity'>;
  geometry?: { cols?: number | null; rows?: number | null; widthMode?: 'adaptive-phone' | 'mirror-fixed' } | null;
}) {
  const geometry = options.geometry || null;
  const expectedSessionIdentity = options.host?.expectedSessionIdentity;
  if (typeof expectedSessionIdentity !== 'undefined') {
    if (!expectedSessionIdentity.trim()) {
      throw new SessionMuxOpenIntentError('blank-identity');
    }
    if (!options.host?.terminalBackend) {
      throw new SessionMuxOpenIntentError('missing-backend');
    }
  }
  return buildTerminalMuxChannelOpen({
    channelId: options.channel.channelId,
    sessionName: options.sessionName || options.channel.sessionName,
    ...(Number.isFinite(geometry?.cols) ? { cols: Math.max(1, Math.floor(geometry?.cols || 0)) } : {}),
    ...(Number.isFinite(geometry?.rows) ? { rows: Math.max(1, Math.floor(geometry?.rows || 0)) } : {}),
    ...(geometry?.widthMode ? { widthMode: geometry.widthMode } : {}),
    ...(options.host?.terminalBackend ? { backend: options.host.terminalBackend } : {}),
    ...(typeof expectedSessionIdentity !== 'undefined' ? {
      expectedSessionIdentity,
      existingOnly: true as const,
    } : {}),
    ...(typeof options.host?.autoCommand === 'string' && options.host.autoCommand.trim() ? { autoCommand: options.host.autoCommand.trim() } : {}),
    bodySubscribed: options.channel.bodySubscribed,
  });
}

export function sendSessionMuxChannelOpenRuntime(options: {
  sessionId: string;
  ws: BridgeTransportSocket;
  channel: Pick<SessionTerminalChannelRuntime, 'channelId' | 'sessionName' | 'bodySubscribed'>;
  sessionName?: string;
  host?: Pick<SessionTransportHost, 'autoCommand' | 'terminalBackend' | 'expectedSessionIdentity'>;
  geometry?: { cols?: number | null; rows?: number | null; widthMode?: 'adaptive-phone' | 'mirror-fixed' } | null;
  onInvalidOpenIntent?: (details: InvalidSessionMuxOpenIntent) => void;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  let frame: ReturnType<typeof buildSessionMuxChannelOpenFrame>;
  try {
    frame = buildSessionMuxChannelOpenFrame(options);
  } catch (error) {
    if (!(error instanceof SessionMuxOpenIntentError) || !options.onInvalidOpenIntent) throw error;
    options.onInvalidOpenIntent({ sessionId: options.sessionId, channelId: options.channel.channelId, ws: options.ws, invalidIntent: error });
    return null;
  }
  // Sending is outside invalid-intent classification. Transport errors retain
  // the caller's existing retryable failure owner.
  options.sendSocketPayload(options.sessionId, options.ws, JSON.stringify(frame));
  return frame;
}

export function createSessionContextTransportAccessors(
  storeRef: SessionTransportRuntimeStoreRef,
): SessionContextTransportAccessors {
  return {
    readTargetTransportRuntimes: () => listTargetTransportRuntimes(storeRef.current),
    readTargetTransportRuntime: (targetKey) => getTargetTransportRuntime(storeRef.current, targetKey),
    readTargetTerminalSocket: (targetKey) => getTargetTerminalTransport(storeRef.current, targetKey),
    readSessionTransportResource: (sessionId) => getSessionTransportResource(storeRef.current, sessionId),
    readSessionTransportSocket: (sessionId) => getSessionTransportSocket(storeRef.current, sessionId),
    readSessionTraversalDiagnostics: (sessionId) => {
      const targetKey = getSessionTransportTargetKey(storeRef.current, sessionId);
      return targetKey ? getTargetTransportTraversalDiagnostics(storeRef.current, targetKey) : null;
    },
    readSessionTransportHost: (sessionId) => getSessionTransportHost(storeRef.current, sessionId),
    readSessionTransportRuntime: (sessionId) => getSessionTransportRuntime(storeRef.current, sessionId),
    readSessionTargetRuntime: (sessionId) => getSessionTargetTransportRuntime(storeRef.current, sessionId),
    readSessionTargetKey: (sessionId) => getSessionTransportTargetKey(storeRef.current, sessionId),
    readSessionTargetControlSocket: (sessionId) => getSessionTargetControlTransport(storeRef.current, sessionId),
    readSessionTargetTerminalSocket: (sessionId) => getSessionTargetTerminalTransport(storeRef.current, sessionId),
    readSessionTargetTerminalMuxReady: (sessionId) => getSessionTargetTerminalMuxReady(storeRef.current, sessionId),
    readSessionTerminalChannel: (sessionId) => getSessionTerminalChannel(storeRef.current.terminalChannels, sessionId),
    readSessionIdForTerminalChannel: (anchorSessionId, channelId) => {
      const targetKey = getSessionTransportTargetKey(storeRef.current, anchorSessionId);
      return targetKey ? getSessionIdForTerminalChannel(storeRef.current.terminalChannels, targetKey, channelId) : null;
    },
    readTargetSessionIdForTerminalChannel: (targetKey, channelId) => (
      getSessionIdForTerminalChannel(storeRef.current.terminalChannels, targetKey, channelId)
    ),
    readOpeningSessionTerminalChannelsForTarget: (anchorSessionId) => {
      const targetKey = getSessionTransportTargetKey(storeRef.current, anchorSessionId);
      return targetKey ? getOpeningSessionTerminalChannelsForTarget(storeRef.current.terminalChannels, targetKey, anchorSessionId) : [];
    },
    readOpeningTerminalChannelsForTarget: (targetKey, prioritySessionId) => (
      getOpeningSessionTerminalChannelsForTarget(storeRef.current.terminalChannels, targetKey, prioritySessionId)
    ),
    readSessionRequestedTerminalGeometry: (sessionId) => getSessionRequestedTerminalGeometry(storeRef.current, sessionId),
    writeSessionTransportHost: (sessionId, host) => upsertSessionTransportRuntime(storeRef.current, sessionId, host),
    writeSessionTransportSocket: (sessionId, socket) => setSessionTransportSocket(storeRef.current, sessionId, socket),
    writeSessionTargetControlSocket: (sessionId, socket) => setSessionTargetControlTransport(storeRef.current, sessionId, socket),
    writeSessionTargetTerminalSocket: (sessionId, socket) => setSessionTargetTerminalTransport(storeRef.current, sessionId, socket),
    writeSessionTargetTerminalMuxReady: (sessionId, ready) => setSessionTargetTerminalMuxReady(storeRef.current, sessionId, ready),
    writeTargetTerminalSocket: (targetKey, socket) => setTargetTerminalTransport(storeRef.current, targetKey, socket),
    writeTargetTerminalMuxReady: (targetKey, ready) => setTargetTerminalMuxReady(storeRef.current, targetKey, ready),
    ensureSessionTerminalChannel: (sessionId, options) => ensureSessionTerminalChannel(storeRef.current.terminalChannels, sessionId, options),
    writeSessionTerminalChannelName: (sessionId, sessionName) => updateSessionTerminalChannelName(storeRef.current.terminalChannels, sessionId, sessionName),
    writeSessionTerminalChannelState: (sessionId, state) => updateSessionTerminalChannelState(storeRef.current.terminalChannels, sessionId, state),
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
  host: SessionTransportHost;
  ws: BridgeTransportSocket;
  debugScope: 'connect' | 'reconnect';
  rawFrameBytes?: number;
  frame: TerminalMuxServerFrame;
  resolveSessionIdForChannel: (channelId: string) => string | null;
  readSessionTransportHost?: (sessionId: string) => Pick<SessionTransportHost, 'expectedSessionIdentity' | 'terminalBackend'> | null;
  readSessionTerminalChannel?: (sessionId: string) => Pick<SessionTerminalChannelRuntime, 'channelId' | 'state' | 'inputReadiness' | 'terminalConnected'> | null;
  readSessionTerminalChannelBodySubscribed?: (sessionId: string) => boolean | null;
  readRequestedTerminalGeometry?: (
    sessionId: string,
  ) => { cols?: number | null; rows?: number | null; widthMode?: 'adaptive-phone' | 'mirror-fixed' } | null;
  updateSessionTerminalChannelState: (sessionId: string, state: 'opening' | 'open' | 'closing' | 'closed') => unknown;
  sendSocketPayload?: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  handleSocketServerMessage: (params: {
    sessionId: string;
    host: SessionTransportHost;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    rawFrameBytes?: number;
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
    onClosed: (reason?: string, code?: string) => void;
  }, msg: ServerMessage) => void;
  buildChannelCallbacks: (sessionId: string) => {
    onChannelAllocated?: () => void;
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
    onClosed: (reason?: string, code?: string) => void;
  };
  onExactChannelRejected?: (details: {
    sessionId: string;
    channelId: string;
    sessionName: string;
    expectedSessionIdentity: string;
    replySessionIdentity?: string;
  }) => void;
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

  const readCurrentChannel = (sessionId: string) => (
    options.readSessionTerminalChannel?.(sessionId) || null
  );

  const resolveExactAttempt = (sessionId: string, channelId: string) => {
    const channel = readCurrentChannel(sessionId);
    if (!channel || channel.channelId !== channelId || channel.state !== 'opening') {
      return null;
    }
    const expectedSessionIdentity = options.readSessionTransportHost?.(sessionId)?.expectedSessionIdentity;
    if (typeof expectedSessionIdentity !== 'string') {
      return null;
    }
    return { channel, expectedSessionIdentity };
  };

  const isCurrentExactChannelActive = (sessionId: string, channelId: string, allowOpening: boolean) => {
    const channel = readCurrentChannel(sessionId);
    return Boolean(
      channel
      && channel.channelId === channelId
      && (channel.state === 'open' || (allowOpening && channel.state === 'opening')),
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
    const sessionHost = options.readSessionTransportHost?.(sessionId);
    if (
      typeof sessionHost?.expectedSessionIdentity === 'string'
      && sessionHost.terminalBackend
    ) {
      const channel = readCurrentChannel(sessionId);
      if (!isCurrentExactChannelActive(sessionId, channelId, message.type === 'error' || message.type === 'closed')) {
        options.runtimeDebug('session.mux.channel-message.inactive-exact-channel', {
          anchorSessionId: options.anchorSessionId,
          sessionId,
          channelId,
          messageType: message.type,
          channelState: channel?.state || null,
        });
        return;
      }
    }
    if (message.type === 'connected') {
      const channel = readCurrentChannel(sessionId);
      if (channel?.channelId === channelId) markTerminalChannelConnected(channel);
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
      const exactAttempt = resolveExactAttempt(sessionId, options.frame.payload.channelId);
      const sessionHost = options.readSessionTransportHost?.(sessionId);
      const expectedSessionIdentity = sessionHost?.expectedSessionIdentity;
      if (typeof expectedSessionIdentity === 'string' && sessionHost?.terminalBackend) {
        if (!exactAttempt) {
          options.runtimeDebug('session.mux.channel-opened.retired-exact-channel', {
            anchorSessionId: options.anchorSessionId,
            sessionId,
            channelId: options.frame.payload.channelId,
            expectedSessionIdentity,
          });
          return;
        }
        if (options.frame.payload.stableId !== expectedSessionIdentity) {
          const rejection = {
            sessionId,
            channelId: options.frame.payload.channelId,
            sessionName: options.frame.payload.sessionName,
            expectedSessionIdentity,
            replySessionIdentity: options.frame.payload.stableId,
          };
          options.runtimeDebug('session.mux.channel-opened.exact-identity-mismatch', {
            anchorSessionId: options.anchorSessionId,
            sessionId,
            channelId: options.frame.payload.channelId,
            expectedSessionIdentity,
            replySessionIdentity: options.frame.payload.stableId,
          });
          options.onExactChannelRejected?.(rejection);
          return;
        }
      }
      options.updateSessionTerminalChannelState(sessionId, 'open');
      options.buildChannelCallbacks(sessionId).onChannelAllocated?.();
      const bodySubscribed = options.readSessionTerminalChannelBodySubscribed?.(sessionId);
      if (typeof bodySubscribed === 'boolean') {
        options.sendSocketPayload?.(sessionId, options.ws, JSON.stringify(buildTerminalMuxChannelMessage(
          options.frame.payload.channelId,
          buildBodySubscriptionMessage({
            subscribed: bodySubscribed,
            geometry: bodySubscribed
              ? options.readRequestedTerminalGeometry?.(sessionId) || null
              : null,
          }),
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
      const sessionHost = options.readSessionTransportHost?.(sessionId);
      if (
        typeof sessionHost?.expectedSessionIdentity === 'string'
        && sessionHost.terminalBackend
        && !isCurrentExactChannelActive(sessionId, options.frame.payload.channelId, true)
      ) {
        options.runtimeDebug('session.mux.channel-closed.retired-exact-channel', {
          anchorSessionId: options.anchorSessionId,
          sessionId,
          channelId: options.frame.payload.channelId,
          reason: options.frame.payload.reason,
        });
        return;
      }
      options.updateSessionTerminalChannelState(sessionId, 'closed');
      options.buildChannelCallbacks(sessionId).onClosed(
        options.frame.payload.reason,
        options.frame.payload.code,
      );
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
  onInvalidOpenIntent?: (details: InvalidSessionMuxOpenIntent) => void;
  sessionId: string;
  targetKey: string;
  targetHeartbeatKey: string;
  host: SessionTransportHost;
  ws: BridgeTransportSocket;
  debugScope: 'connect' | 'reconnect';
  /** Relay-assigned device id of this client; lets the daemon match
   *  pending-attachments pushes to this physical transport. */
  clientDeviceId?: string;
  readTargetTerminalSocket: (targetKey: string) => BridgeTransportSocket | null;
  readRequestedTerminalGeometry: (
    sessionId: string,
  ) => { cols?: number | null; rows?: number | null; widthMode?: 'adaptive-phone' | 'mirror-fixed' } | null;
  getOpeningTerminalChannelsForTarget: (
    targetKey: string,
    prioritySessionId: string,
  ) => SessionTerminalChannelRuntime[];
  readSessionTransportHost: (sessionId: string) => SessionTransportHost | null;
  readSessionTerminalChannel: (sessionId: string) => SessionTerminalChannelRuntime | null;
  writeSessionTerminalChannelState: (sessionId: string, state: SessionTerminalChannelState) => unknown;
  readPrioritySessionId: () => string | null;
  setTargetMuxReady: (targetKey: string, ready: boolean) => unknown;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  handleTargetMuxServerFrame: (
    frame: TerminalMuxServerFrame,
    rawFrameBytes?: number,
    rawFrameData?: string,
  ) => void;
  applyTransportDiagnostics: (sessionId: string, socket: BridgeTransportSocket) => void;
  startMuxHandshakeTimeout?: (sessionId: string) => void;
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
  const isCurrentTargetSocket = () => options.readTargetTerminalSocket(options.targetKey) === options.ws;
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
    if (options.ws.transportOwnership === 'service') {
      options.runtimeDebug(`session.mux.${options.debugScope}.service-ready`, {
        sessionId: options.sessionId,
      });
      return;
    }
    options.sendSocketPayload(
      options.sessionId,
      options.ws,
      JSON.stringify(buildTerminalMuxHello(options.sessionId, options.clientDeviceId)),
    );
    options.runtimeDebug(`session.mux.${options.debugScope}.hello-sent`, {
      sessionId: options.sessionId,
    });
    // Socket handshake is done (candidate selection no longer counts against
    // the mux negotiation budget): start the mux handshake timeout now so it
    // only covers hello -> mux-ready -> channel-open -> channel-allocated.
    options.startMuxHandshakeTimeout?.(options.sessionId);
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
        const prioritySessionId = options.readPrioritySessionId();
        if (!prioritySessionId?.trim()) {
          finalizeTargetFailure('missing active session for terminal mux channel priority', true);
          return;
        }
        const openingChannels = options.getOpeningTerminalChannelsForTarget(
          options.targetKey,
          prioritySessionId.trim(),
        );
        const priorityChannel = openingChannels.find(
          (channel) => channel.sessionId === prioritySessionId,
        );
        if (!priorityChannel && openingChannels.length === 0) {
          finalizeTargetFailure('active session is not opening on terminal mux target', true);
          return;
        }
        options.setTargetMuxReady(options.targetKey, true);
        options.ws.confirmTransportReady?.();
        if (parsed.payload.capabilities?.bulkChannel) {
          options.ws.enableBulkChannel?.();
        }
        options.runtimeDebug(`session.mux.${options.debugScope}.ready`, {
          sessionId: options.sessionId,
          prioritySessionId: priorityChannel?.sessionId || openingChannels[0]?.sessionId || null,
        });
        for (const channel of openingChannels) {
          const host = options.readSessionTransportHost(channel.sessionId);
          if (!host) {
            options.runtimeDebug('session.mux.channel-open.missing-session-host', {
              sessionId: channel.sessionId,
              channelId: channel.channelId,
            });
            continue;
          }
          sendSessionMuxChannelOpenRuntime({
            sessionId: channel.sessionId,
            ws: options.ws,
            channel,
            host,
            geometry: options.readRequestedTerminalGeometry(channel.sessionId),
            onInvalidOpenIntent: options.onInvalidOpenIntent,
            sendSocketPayload: options.sendSocketPayload,
          });
        }
        return;
      }
      options.handleTargetMuxServerFrame(parsed, rawFrameBytes, event.data);
    } catch (error) {
      if (error instanceof TerminalMuxChannelNotOpenError) {
        // A closed mux channel is a channel fact, not a physical transport
        // failure. The channel owner handles closure and reopening on the
        // same socket; retiring the target transport here leaves the session
        // with no socket while its state still says connected.
        options.runtimeDebug('session.mux.channel-frame.channel-not-open', {
          sessionId: options.sessionId,
          channelMessage: error.message,
        });
        return;
      }
      finalizeTargetFailure(error instanceof Error ? error.message : 'terminal mux parse error', true);
    }
  };

  options.ws.onerror = () => {
    if (!isCurrentTargetSocket()) {
      return;
    }
    options.setTargetMuxReady(options.targetKey, false);
    finalizeTargetFailure(options.ws.getDiagnostics().reason || 'terminal mux transport error', true);
  };

  options.ws.onclose = () => {
    if (!isCurrentTargetSocket()) {
      return;
    }
    options.setTargetMuxReady(options.targetKey, false);
    finalizeTargetFailure(options.ws.getDiagnostics().reason || 'terminal mux transport closed', true);
  };
}

export function openSocketConnectHandshake(options: {
  sessionId: string;
  host: SessionTransportHost;
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
    host: SessionTransportHost;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    rawFrameBytes?: number;
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
    onClosed: (reason?: string, code?: string) => void;
  }, msg: ServerMessage) => void;
  finalizeFailure: (message: string, retryable: boolean) => void;
  onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
  onConnected: () => void;
  onClosed?: (reason?: string, code?: string) => void;
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
        onClosed: (reason, code) => {
          options.onClosed?.(reason, code);
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
