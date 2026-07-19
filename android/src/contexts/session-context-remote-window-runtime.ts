import type {
  RemoteWindowStreamIceCandidate,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamTargetManifest,
  Session,
  RemoteWindowStreamTargetsResponsePayload,
} from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { BridgeSettings } from '../lib/bridge-settings';
import { buildTraversalPlan } from '../lib/traversal/config';
import type { RemoteWindowReceiverStartResult } from '../lib/remote-window-receiver-runtime';

interface RemoteWindowCatalogMessageRuntimeLike {
  requestTargets: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      request?: { includeAppWindows?: boolean; includeIterm2?: boolean };
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => Promise<RemoteWindowStreamTargetsResponsePayload>;
}

interface RemoteWindowStreamMessageRuntimeLike extends RemoteWindowCatalogMessageRuntimeLike {
  requestStreamStart: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      streamId: string;
      target: RemoteWindowStreamTargetManifest;
      offer: { type: 'offer'; sdp: string };
      iceServers?: Array<Record<string, unknown>>;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => Promise<RemoteWindowStreamStartedPayload>;
  sendStreamIceCandidate: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      streamId: string;
      candidate: RemoteWindowStreamIceCandidate;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => void;
  stopStream: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      streamId: string;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => void;
  sendInputEvent: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      payload: Omit<RemoteWindowInputEventPayload, 'requestId'>;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => void;
}

interface RemoteWindowReceiverRuntimeLike {
  startStream: (options: {
    streamId: string;
    target: RemoteWindowStreamTargetManifest;
    iceServers?: RTCIceServer[];
    sendIceCandidate: (candidate: RemoteWindowStreamIceCandidate) => void;
    startRemote: (offer: { type: 'offer'; sdp: string }) => Promise<RemoteWindowStreamStartedPayload>;
  }) => Promise<RemoteWindowReceiverStartResult>;
  stopStream: (streamId: string) => boolean;
}

function formatSocketReadyState(ws: BridgeTransportSocket | null) {
  if (!ws) {
    return 'missing';
  }
  switch (ws.readyState) {
    case WebSocket.CONNECTING:
      return 'connecting';
    case WebSocket.OPEN:
      return 'open';
    case WebSocket.CLOSING:
      return 'closing';
    case WebSocket.CLOSED:
      return 'closed';
    default:
      return `unknown:${ws.readyState}`;
  }
}

function resolveRemoteWindowTransport(options: {
  sessionId: string;
  sessions: Session[];
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  operationLabel: 'catalog' | 'stream';
}) {
  const targetSessionId = options.sessionId.trim();
  const session = options.sessions.find((item) => item.id === targetSessionId) || null;
  if (!session) {
    throw new Error(`Remote window ${options.operationLabel} session no longer exists`);
  }
  const ws = options.readSessionTransportSocket(targetSessionId) || null;
  if (ws && ws.readyState === WebSocket.OPEN) {
    return ws;
  }
  throw new Error(
    `Remote window ${options.operationLabel} transport is not open (session=${session.state || 'missing'}, socket=${formatSocketReadyState(ws)})`,
  );
}

function normalizeRemoteWindowIceServers(
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>,
): RTCIceServer[] | undefined {
  const normalized = iceServers
    .map((server) => ({
      urls: server.urls,
      ...(server.username ? { username: server.username } : {}),
      ...(server.credential ? { credential: server.credential } : {}),
    }))
    .filter((server) => (
      typeof server.urls === 'string'
        ? server.urls.trim().length > 0
        : Array.isArray(server.urls) && server.urls.some((url) => url.trim().length > 0)
    ));
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveRemoteWindowStreamIceServers(options: {
  session: Session;
  ws?: BridgeTransportSocket | null;
  bridgeSettings?: BridgeSettings | null;
}): RTCIceServer[] | undefined {
  const resolvedPath = (() => {
    try {
      return options.ws?.getDiagnostics?.().resolvedPath || options.session.resolvedPath;
    } catch {
      return options.session.resolvedPath;
    }
  })();
  if (resolvedPath !== 'rtc-direct' && resolvedPath !== 'rtc-relay') {
    return undefined;
  }
  if (!options.bridgeSettings) {
    return undefined;
  }
  const plan = buildTraversalPlan({
    bridgeHost: options.session.bridgeHost || '',
    bridgePort: options.session.bridgePort || 0,
    authToken: options.session.authToken,
    daemonHostId: options.session.daemonHostId,
    transportMode: 'auto',
  }, options.bridgeSettings);
  const candidate = plan.candidates.find((item) => (
    item.kind === 'rtc'
    && item.path === resolvedPath
  ));
  return candidate && candidate.kind === 'rtc'
    ? normalizeRemoteWindowIceServers(candidate.iceServers)
    : undefined;
}

export function resolveRemoteWindowCatalogTransport(options: {
  sessionId: string;
  sessions: Session[];
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
}) {
  return resolveRemoteWindowTransport({
    ...options,
    operationLabel: 'catalog',
  });
}

export function resolveRemoteWindowStreamTransport(options: {
  sessionId: string;
  sessions: Session[];
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
}) {
  return resolveRemoteWindowTransport({
    ...options,
    operationLabel: 'stream',
  });
}

export async function requestRemoteWindowTargetsRuntime(options: {
  sessionId: string;
  sessions: Session[];
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  remoteWindowMessageRuntime: RemoteWindowCatalogMessageRuntimeLike;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    throw new Error('No target session for remote window catalog');
  }

  const ws = resolveRemoteWindowCatalogTransport({
    sessionId: targetSessionId,
    sessions: options.sessions,
    readSessionTransportSocket: options.readSessionTransportSocket,
  });
  return options.remoteWindowMessageRuntime.requestTargets(targetSessionId, {
    ws,
    sendSocketPayload: options.sendSocketPayload,
  });
}

export async function requestRemoteWindowStreamStartRuntime(options: {
  sessionId: string;
  streamId: string;
  target: RemoteWindowStreamTargetManifest;
  iceServers?: RTCIceServer[];
  bridgeSettings?: BridgeSettings | null;
  sessions: Session[];
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  remoteWindowMessageRuntime: RemoteWindowStreamMessageRuntimeLike;
  remoteWindowReceiverRuntime: RemoteWindowReceiverRuntimeLike;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}): Promise<RemoteWindowReceiverStartResult> {
  const targetSessionId = options.sessionId.trim();
  const streamId = options.streamId.trim();
  if (!targetSessionId || !streamId) {
    throw new Error('Remote window stream start requires sessionId and streamId');
  }

  const ws = resolveRemoteWindowStreamTransport({
    sessionId: targetSessionId,
    sessions: options.sessions,
    readSessionTransportSocket: options.readSessionTransportSocket,
  });
  const session = options.sessions.find((item) => item.id === targetSessionId)!;
  const iceServers = options.iceServers
    ?? resolveRemoteWindowStreamIceServers({
      session,
      ws,
      bridgeSettings: options.bridgeSettings,
    });
  return options.remoteWindowReceiverRuntime.startStream({
    streamId,
    target: options.target,
    iceServers,
    sendIceCandidate: (candidate) => {
      options.remoteWindowMessageRuntime.sendStreamIceCandidate(targetSessionId, {
        ws,
        streamId,
        candidate,
        sendSocketPayload: options.sendSocketPayload,
      });
    },
    startRemote: (offer) => options.remoteWindowMessageRuntime.requestStreamStart(targetSessionId, {
      ws,
      streamId,
      target: options.target,
      offer,
      iceServers: iceServers?.map((server) => ({ ...server })) as Array<Record<string, unknown>> | undefined,
      sendSocketPayload: options.sendSocketPayload,
    }),
  });
}

export function stopRemoteWindowStreamRuntime(options: {
  sessionId: string;
  streamId: string;
  sessions: Session[];
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  remoteWindowMessageRuntime: RemoteWindowStreamMessageRuntimeLike;
  remoteWindowReceiverRuntime: RemoteWindowReceiverRuntimeLike;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const targetSessionId = options.sessionId.trim();
  const streamId = options.streamId.trim();
  if (!targetSessionId || !streamId) {
    throw new Error('Remote window stream stop requires sessionId and streamId');
  }
  const localStopped = options.remoteWindowReceiverRuntime.stopStream(streamId);
  const ws = resolveRemoteWindowStreamTransport({
    sessionId: targetSessionId,
    sessions: options.sessions,
    readSessionTransportSocket: options.readSessionTransportSocket,
  });
  options.remoteWindowMessageRuntime.stopStream(targetSessionId, {
    ws,
    streamId,
    sendSocketPayload: options.sendSocketPayload,
  });
  return localStopped;
}

export function sendRemoteWindowInputRuntime(options: {
  sessionId: string;
  payload: Omit<RemoteWindowInputEventPayload, 'requestId'>;
  sessions: Session[];
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  remoteWindowMessageRuntime: RemoteWindowStreamMessageRuntimeLike;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    throw new Error('Remote window input requires sessionId');
  }
  const ws = resolveRemoteWindowStreamTransport({
    sessionId: targetSessionId,
    sessions: options.sessions,
    readSessionTransportSocket: options.readSessionTransportSocket,
  });
  options.remoteWindowMessageRuntime.sendInputEvent(targetSessionId, {
    ws,
    payload: options.payload,
    sendSocketPayload: options.sendSocketPayload,
  });
}
