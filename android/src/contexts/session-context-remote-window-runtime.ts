import type {
  RemoteWindowStreamIceCandidate,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamStatusPayload,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamStartedOfferV2Payload,
  RemoteWindowStreamAnswerV2Payload,
  RemoteWindowStreamPurpose,
  RemoteWindowStreamTargetManifest,
  RemoteWindowVideoProfile,
  Session,
  RemoteWindowStreamTargetsResponsePayload,
} from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { BridgeSettings } from '../lib/bridge-settings';
import { buildTraversalPlan } from '../lib/traversal/config';
import type { RemoteWindowReceiverStartResult } from '../lib/remote-window-receiver-runtime';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';

interface RemoteWindowCatalogMessageRuntimeLike {
  requestTargets: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      request?: { includeAppWindows?: boolean; includeIterm2?: boolean; forceRefresh?: boolean };
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => Promise<RemoteWindowStreamTargetsResponsePayload>;
}

interface RemoteWindowStreamMessageRuntimeLike extends RemoteWindowCatalogMessageRuntimeLike {
  requestStreamStart: (...args: any[]) => Promise<RemoteWindowStreamStartedPayload | RemoteWindowStreamStartedOfferV2Payload>;
  sendStreamAnswerV2?: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      payload: RemoteWindowStreamAnswerV2Payload;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => void;
  sendStreamQuality: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => Promise<RemoteWindowStreamQualityResultPayload>;
  sendStreamUpdateFocus: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      streamId: string;
      revision?: number;
      target: RemoteWindowStreamTargetManifest;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => void;
  sendStreamIceCandidate: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      streamId: string;
      requestId?: string;
      purpose?: RemoteWindowStreamPurpose;
      candidate: RemoteWindowStreamIceCandidate;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => void;
  stopStream: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      streamId: string;
      purpose?: RemoteWindowStreamPurpose;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => Promise<RemoteWindowStreamStatusPayload>;
  sendInputEvent: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      payload: Omit<RemoteWindowInputEventPayload, 'requestId'>;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => void;
  sendWindowResizeEvent?: (
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
    purpose?: RemoteWindowStreamPurpose;
    target: RemoteWindowStreamTargetManifest;
    iceServers?: RTCIceServer[];
    sendIceCandidate: (candidate: RemoteWindowStreamIceCandidate, requestId?: string) => void;
    startRemote: (offer: { type: 'offer'; sdp: string }) => Promise<RemoteWindowStreamStartedPayload | RemoteWindowStreamStartedOfferV2Payload>;
    protocolVersion?: 1 | 2;
    sendAnswer?: (answer: RemoteWindowStreamAnswerV2Payload) => void | Promise<void>;
  }) => Promise<RemoteWindowReceiverStartResult>;
  stopStream: (streamId: string) => boolean;
}

export const REMOTE_WINDOW_TARGET_CATALOG_CACHE_TTL_MS = 60_000;

export interface RemoteWindowTargetCatalogCacheEntry {
  cacheKey: string;
  updatedAt: number;
  payload: RemoteWindowStreamTargetsResponsePayload;
}

export type RemoteWindowTargetCatalogCacheStore = Map<string, RemoteWindowTargetCatalogCacheEntry>;

function buildRemoteWindowTargetCatalogCacheKey(session: Session) {
  return [
    session.daemonHostId || '',
    session.bridgeHost || '',
    session.bridgePort || 0,
    session.authToken || '',
  ].join('|');
}

function cloneRemoteWindowTargetsPayload(payload: RemoteWindowStreamTargetsResponsePayload): RemoteWindowStreamTargetsResponsePayload {
  return {
    requestId: payload.requestId,
    targets: [...payload.targets],
    ...(payload.errors ? { errors: [...payload.errors] } : {}),
  };
}

function resolveRemoteWindowTransport(options: {
  sessionId: string;
  sessions: Session[];
  daemonConnection: ClientDaemonConnection;
  operationLabel: 'catalog' | 'stream';
}) {
  const targetSessionId = options.sessionId.trim();
  const session = options.sessions.find((item) => item.id === targetSessionId) || null;
  if (!session) {
    throw new Error(`Remote window ${options.operationLabel} session no longer exists`);
  }
  return options.daemonConnection.readOpenSessionSocket(
    targetSessionId,
    `Remote window ${options.operationLabel}`,
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
  daemonConnection: ClientDaemonConnection;
}) {
  return resolveRemoteWindowTransport({
    ...options,
    operationLabel: 'catalog',
  });
}

export function resolveRemoteWindowStreamTransport(options: {
  sessionId: string;
  sessions: Session[];
  daemonConnection: ClientDaemonConnection;
}) {
  return resolveRemoteWindowTransport({
    ...options,
    operationLabel: 'stream',
  });
}

export async function requestRemoteWindowTargetsRuntime(options: {
  sessionId: string;
  sessions: Session[];
  daemonConnection: ClientDaemonConnection;
  remoteWindowMessageRuntime: RemoteWindowCatalogMessageRuntimeLike;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  targetCatalogCache?: RemoteWindowTargetCatalogCacheStore;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  now?: () => number;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    throw new Error('No target session for remote window catalog');
  }

  const session = options.sessions.find((item) => item.id === targetSessionId) || null;
  if (!session) {
    throw new Error('Remote window catalog session no longer exists');
  }
  const ws = resolveRemoteWindowCatalogTransport({
    sessionId: targetSessionId,
    sessions: options.sessions,
    daemonConnection: options.daemonConnection,
  });
  const cacheKey = buildRemoteWindowTargetCatalogCacheKey(session);
  const now = options.now?.() ?? Date.now();
  const cacheTtlMs = Math.max(0, Math.floor(options.cacheTtlMs ?? REMOTE_WINDOW_TARGET_CATALOG_CACHE_TTL_MS));
  const cached = options.targetCatalogCache?.get(cacheKey) || null;
  if (!options.forceRefresh && cached && now - cached.updatedAt >= 0 && now - cached.updatedAt < cacheTtlMs) {
    return cloneRemoteWindowTargetsPayload(cached.payload);
  }
  const payload = await options.remoteWindowMessageRuntime.requestTargets(targetSessionId, {
    ws,
    ...(options.forceRefresh ? { request: { forceRefresh: true } } : {}),
    sendSocketPayload: options.sendSocketPayload,
  });
  options.targetCatalogCache?.set(cacheKey, {
    cacheKey,
    updatedAt: now,
    payload: cloneRemoteWindowTargetsPayload(payload),
  });
  return payload;
}

export async function requestRemoteWindowStreamStartRuntime(options: {
  sessionId: string;
  streamId: string;
  purpose?: RemoteWindowStreamPurpose;
  target: RemoteWindowStreamTargetManifest;
  videoProfile: RemoteWindowVideoProfile;
  iceServers?: RTCIceServer[];
  bridgeSettings?: BridgeSettings | null;
  sessions: Session[];
  daemonConnection: ClientDaemonConnection;
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
    daemonConnection: options.daemonConnection,
  });
  const session = options.sessions.find((item) => item.id === targetSessionId)!;
  const iceServers = options.iceServers
    ?? resolveRemoteWindowStreamIceServers({
      session,
      ws,
      bridgeSettings: options.bridgeSettings,
    });
  const mediaPlan = (options.target.compositeWindows ?? []).length > 0
    ? 'overview-plus-focus' as const
    : 'single-focus' as const;
  return options.remoteWindowReceiverRuntime.startStream({
    streamId,
    purpose: options.purpose,
    target: options.target,
    iceServers,
    protocolVersion: 2,
    sendIceCandidate: (candidate, requestId) => {
      options.remoteWindowMessageRuntime.sendStreamIceCandidate(targetSessionId, {
        ws,
        streamId,
        purpose: options.purpose,
        requestId,
        candidate,
        sendSocketPayload: options.sendSocketPayload,
      });
    },
    startRemote: () => options.remoteWindowMessageRuntime.requestStreamStart(targetSessionId, {
      ws,
      streamId,
      purpose: options.purpose,
      mediaPlan,
      mediaPlanVersion: 2,
      target: options.target,
      iceServers: iceServers?.map((server) => ({ ...server })) as Array<Record<string, unknown>> | undefined,
      videoProfile: options.videoProfile,
      sendSocketPayload: options.sendSocketPayload,
    }),
    sendAnswer: (answer) => {
      if (!options.remoteWindowMessageRuntime.sendStreamAnswerV2) {
        throw new Error('Remote window v2 answer sender is unavailable');
      }
      options.remoteWindowMessageRuntime.sendStreamAnswerV2(targetSessionId, {
        ws,
        payload: answer,
        sendSocketPayload: options.sendSocketPayload,
      });
    },
  });
}

export function updateRemoteWindowStreamQualityRuntime(options: {
  sessionId: string;
  payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>;
  sessions: Session[];
  daemonConnection: ClientDaemonConnection;
  remoteWindowMessageRuntime: RemoteWindowStreamMessageRuntimeLike;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    throw new Error('No target session for remote window stream quality');
  }
  const ws = resolveRemoteWindowStreamTransport({
    sessionId: targetSessionId,
    sessions: options.sessions,
    daemonConnection: options.daemonConnection,
  });
  return options.remoteWindowMessageRuntime.sendStreamQuality(targetSessionId, {
    ws,
    payload: options.payload,
    sendSocketPayload: options.sendSocketPayload,
  });
}

export function updateRemoteWindowFocusRuntime(options: {
  sessionId: string;
  streamId: string;
  revision?: number;
  target: RemoteWindowStreamTargetManifest;
  sessions: Session[];
  daemonConnection: ClientDaemonConnection;
  remoteWindowMessageRuntime: RemoteWindowStreamMessageRuntimeLike;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const targetSessionId = options.sessionId.trim();
  const streamId = options.streamId.trim();
  if (!targetSessionId || !streamId) {
    throw new Error('Remote window stream update focus requires sessionId and streamId');
  }
  const ws = resolveRemoteWindowStreamTransport({
    sessionId: targetSessionId,
    sessions: options.sessions,
    daemonConnection: options.daemonConnection,
  });
  options.remoteWindowMessageRuntime.sendStreamUpdateFocus(targetSessionId, {
    ws,
    streamId,
    revision: options.revision ?? 1,
    target: options.target,
    sendSocketPayload: options.sendSocketPayload,
  });
}

export async function stopRemoteWindowStreamRuntime(options: {
  sessionId: string;
  streamId: string;
  purpose?: RemoteWindowStreamPurpose;
  sessions: Session[];
  daemonConnection: ClientDaemonConnection;
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
    daemonConnection: options.daemonConnection,
  });
  await options.remoteWindowMessageRuntime.stopStream(targetSessionId, {
    ws,
    streamId,
    purpose: options.purpose,
    sendSocketPayload: options.sendSocketPayload,
  });
  return localStopped;
}

export function sendRemoteWindowInputRuntime(options: {
  sessionId: string;
  payload: Omit<RemoteWindowInputEventPayload, 'requestId'>;
  sessions: Session[];
  daemonConnection: ClientDaemonConnection;
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
    daemonConnection: options.daemonConnection,
  });
  options.remoteWindowMessageRuntime.sendInputEvent(targetSessionId, {
    ws,
    payload: options.payload,
    sendSocketPayload: options.sendSocketPayload,
  });
}

export function resizeRemoteWindowTargetRuntime(options: {
  sessionId: string;
  payload: Omit<RemoteWindowInputEventPayload, 'requestId'>;
  sessions: Session[];
  daemonConnection: ClientDaemonConnection;
  remoteWindowMessageRuntime: RemoteWindowStreamMessageRuntimeLike;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId || options.payload.event.kind !== 'window-resize') {
    throw new Error('Remote window target resize requires sessionId and window-resize event');
  }
  const ws = resolveRemoteWindowStreamTransport({
    sessionId: targetSessionId,
    sessions: options.sessions,
    daemonConnection: options.daemonConnection,
  });
  const sendWindowResizeEvent = options.remoteWindowMessageRuntime.sendWindowResizeEvent
    || options.remoteWindowMessageRuntime.sendInputEvent;
  sendWindowResizeEvent(targetSessionId, {
    ws,
    payload: options.payload,
    sendSocketPayload: options.sendSocketPayload,
  });
}
