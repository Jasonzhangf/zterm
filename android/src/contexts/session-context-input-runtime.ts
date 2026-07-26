import type { Session, TerminalInputAckPayload, TerminalReliableInputPayload } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { SessionTransportResource } from '../lib/session-transport-runtime';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';
import {
  TERMINAL_INPUT_CHUNK_BYTES,
  getTerminalInputUtf8ByteLength,
  splitTerminalInputUtf8Chunks,
} from '@zterm/shared/terminal/input-chunking';

interface MutableRefObject<T> {
  current: T;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

const TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES = 128 * 1024;
export const TERMINAL_RELIABLE_INPUT_RETRY_MS = 500;

interface SendInputTransportOptions {
  sessionId: string;
  data: string;
  refs: {
    sessionsRef: { current: Array<Pick<Session, 'id' | 'reliableInputSupported'>> };
    stateRef: { current: { activeSessionId: string | null } };
  };
  runtimeDebug: RuntimeDebugFn;
  daemonConnection: ClientDaemonConnection;
  isReconnectInFlight: (sessionId: string) => boolean;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  markPendingInputTailRefresh: (sessionId: string, localRevision: number) => boolean;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number };
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isPendingSessionTransportOpenStale: (sessionId: string) => boolean;
  scheduleReconnect?: (
    sessionId: string,
    message: string,
    retryable?: boolean,
    options?: { immediate?: boolean; resetAttempt?: boolean; force?: boolean },
  ) => void;
}

interface ReliableInputQueueItem {
  seq: string;
  data: string;
  bytes: number;
  attempt: number;
  sentAt: number | null;
  headRefreshMarked: boolean;
}

interface ReliableInputSessionQueue {
  sessionId: string;
  items: ReliableInputQueueItem[];
  timer: ReturnType<typeof globalThis.setTimeout> | null;
  options: SendInputTransportOptions;
}

const reliableInputQueues = new Map<string, ReliableInputSessionQueue>();
let reliableInputSequence = 0;

const pendingInputHeadRefreshes = new Map<string, {
  daemonConnection: ClientDaemonConnection;
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
}>();

function readDaemonConnectionSessionResource(options: {
  daemonConnection: ClientDaemonConnection;
}, sessionId: string) {
  return options.daemonConnection.readSessionResource(sessionId);
}

function readDaemonConnectionSessionSocket(options: {
  daemonConnection: ClientDaemonConnection;
}, sessionId: string) {
  return options.daemonConnection.readSessionSocket(sessionId);
}

function isSessionMessageTransportReady(
  resource: SessionTransportResource,
  ws: BridgeTransportSocket | null,
): ws is BridgeTransportSocket {
  return Boolean(ws)
    && ws?.readyState === WebSocket.OPEN
    && (!resource.channel || resource.channel.state === 'open');
}

function readSocketReadyState(ws: BridgeTransportSocket | null) {
  return ws ? ws.readyState : null;
}

function scheduleInputHeadRefresh(options: {
  sessionId: string;
  daemonConnection: ClientDaemonConnection;
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
}) {
  const alreadyPending = pendingInputHeadRefreshes.has(options.sessionId);
  pendingInputHeadRefreshes.set(options.sessionId, {
    daemonConnection: options.daemonConnection,
    requestSessionBufferHead: options.requestSessionBufferHead,
  });
  if (alreadyPending) {
    return;
  }
  queueMicrotask(() => {
    const pending = pendingInputHeadRefreshes.get(options.sessionId) || null;
    pendingInputHeadRefreshes.delete(options.sessionId);
    if (!pending) {
      return;
    }
    const currentWs = readDaemonConnectionSessionSocket(pending, options.sessionId);
    pending.requestSessionBufferHead(
      options.sessionId,
      currentWs,
      { force: true },
    );
  });
}

function buildReliableInputSeq(sessionId: string) {
  reliableInputSequence += 1;
  return `${sessionId}:input:${Date.now()}:${reliableInputSequence}`;
}

function clearReliableInputTimer(queue: ReliableInputSessionQueue) {
  if (queue.timer !== null) {
    globalThis.clearTimeout(queue.timer);
    queue.timer = null;
  }
}

function scheduleReliableInputFlush(queue: ReliableInputSessionQueue) {
  clearReliableInputTimer(queue);
  queue.timer = globalThis.setTimeout(() => {
    queue.timer = null;
    flushReliableInputQueue(queue.sessionId);
  }, TERMINAL_RELIABLE_INPUT_RETRY_MS);
}

function getReliableInputQueue(sessionId: string, options: SendInputTransportOptions) {
  const current = reliableInputQueues.get(sessionId);
  if (current) {
    current.options = options;
    return current;
  }
  const next: ReliableInputSessionQueue = {
    sessionId,
    items: [],
    timer: null,
    options,
  };
  reliableInputQueues.set(sessionId, next);
  return next;
}

function sendReliableInputFrame(
  queue: ReliableInputSessionQueue,
  item: ReliableInputQueueItem,
  ws: BridgeTransportSocket,
  resource: SessionTransportResource,
) {
  const localRevision = queue.options.readSessionBufferSnapshot(queue.sessionId).revision;
  item.attempt += 1;
  item.sentAt = Date.now();
  const payload: TerminalReliableInputPayload = {
    version: 1,
    seq: item.seq,
    data: item.data,
    sentAt: item.sentAt,
    attempt: item.attempt,
  };
  queue.options.sendSocketPayload(
    queue.sessionId,
    ws,
    JSON.stringify({ type: 'input', payload }),
  );
  if (!item.headRefreshMarked) {
    item.headRefreshMarked = true;
    const isFirstPendingInputTailRefresh = queue.options.markPendingInputTailRefresh(
      queue.sessionId,
      localRevision,
    );
    if (isFirstPendingInputTailRefresh) {
      scheduleInputHeadRefresh({
        sessionId: queue.sessionId,
        daemonConnection: queue.options.daemonConnection,
        requestSessionBufferHead: queue.options.requestSessionBufferHead,
      });
    }
  }
  queue.options.runtimeDebug('session.input.reliable-send', {
    sessionId: queue.sessionId,
    seq: item.seq,
    bytes: item.bytes,
    attempt: item.attempt,
    queueDepth: queue.items.length,
    resourceTargetKey: resource.targetKey,
    resourceSocketState: resource.socketState,
  });
}

function flushReliableInputQueue(sessionId: string) {
  const queue = reliableInputQueues.get(sessionId);
  if (!queue || queue.items.length === 0) {
    if (queue) {
      clearReliableInputTimer(queue);
      reliableInputQueues.delete(sessionId);
    }
    return;
  }

  const session = queue.options.refs.sessionsRef.current.find((item) => item.id === sessionId) || null;
  if (!session) {
    clearReliableInputTimer(queue);
    reliableInputQueues.delete(sessionId);
    queue.options.runtimeDebug('session.input.reliable-drop.missing-session', {
      sessionId,
      queueDepth: queue.items.length,
    });
    return;
  }

  const resource = readDaemonConnectionSessionResource(queue.options, sessionId);
  const ws = readDaemonConnectionSessionSocket(queue.options, sessionId);
  const wsReadyState = readSocketReadyState(ws);
  const reconnectInFlight = queue.options.isReconnectInFlight(sessionId);
  if (!isSessionMessageTransportReady(resource, ws)) {
    queue.options.runtimeDebug('session.input.reliable-wait.transport-unavailable', {
      sessionId,
      queueDepth: queue.items.length,
      wsReadyState,
      reconnectInFlight,
      resourceTargetKey: resource.targetKey,
      resourceSocketState: resource.socketState,
      channelState: resource.channel?.state ?? null,
    });
    scheduleReliableInputFlush(queue);
    return;
  }

  const bufferedBytes = Number.isFinite(ws.bufferedAmount)
    ? Math.max(0, Math.floor(ws.bufferedAmount || 0))
    : 0;
  if (bufferedBytes >= TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES) {
    queue.options.runtimeDebug('session.input.reliable-wait.backpressured-transport', {
      sessionId,
      queueDepth: queue.items.length,
      bufferedBytes,
      thresholdBytes: TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES,
      reconnectInFlight,
    });
    if (ws.readyState < WebSocket.CLOSING) {
      ws.close(4000, 'input backpressure');
    }
    scheduleReliableInputFlush(queue);
    return;
  }

  const item = queue.items[0];
  if (!item) {
    clearReliableInputTimer(queue);
    reliableInputQueues.delete(sessionId);
    return;
  }
  sendReliableInputFrame(queue, item, ws, resource);
  scheduleReliableInputFlush(queue);
}

function enqueueReliableInputChunks(options: SendInputTransportOptions, sessionId: string, inputChunks: string[]) {
  const queue = getReliableInputQueue(sessionId, options);
  for (const chunk of inputChunks) {
    queue.items.push({
      seq: buildReliableInputSeq(sessionId),
      data: chunk,
      bytes: getTerminalInputUtf8ByteLength(chunk),
      attempt: 0,
      sentAt: null,
      headRefreshMarked: false,
    });
  }
  options.runtimeDebug('session.input.reliable-enqueue', {
    sessionId,
    chunks: inputChunks.length,
    queueDepth: queue.items.length,
  });
  flushReliableInputQueue(sessionId);
}

function isRetryableReliableInputNack(payload: TerminalInputAckPayload) {
  return payload.accepted === false && (
    payload.error === 'input_stale_transport'
    || payload.error === 'session_required'
    || payload.error === 'transport_unavailable'
    || payload.error === 'input_transport_unavailable'
  );
}

export function handleTerminalInputAck(sessionId: string, payload: TerminalInputAckPayload) {
  if (!payload || payload.version !== 1 || typeof payload.seq !== 'string') {
    return;
  }
  const queue = reliableInputQueues.get(sessionId);
  if (!queue) {
    return;
  }
  const index = queue.items.findIndex((item) => item.seq === payload.seq);
  if (index < 0) {
    queue.options.runtimeDebug('session.input.reliable-ack.unknown', {
      sessionId,
      seq: payload.seq,
      accepted: payload.accepted,
      error: payload.error,
    });
    return;
  }
  if (isRetryableReliableInputNack(payload)) {
    queue.options.runtimeDebug('session.input.reliable-nack.retry', {
      sessionId,
      seq: payload.seq,
      accepted: payload.accepted,
      bytes: payload.bytes,
      error: payload.error,
      queueDepth: queue.items.length,
    });
    scheduleReliableInputFlush(queue);
    return;
  }
  queue.items.splice(index, 1);
  queue.options.runtimeDebug(payload.accepted ? 'session.input.reliable-ack' : 'session.input.reliable-nack', {
    sessionId,
    seq: payload.seq,
    accepted: payload.accepted,
    bytes: payload.bytes,
    error: payload.error,
    queueDepth: queue.items.length,
  });
  if (queue.items.length === 0) {
    clearReliableInputTimer(queue);
    reliableInputQueues.delete(sessionId);
    return;
  }
  flushReliableInputQueue(sessionId);
}

export function resetTerminalReliableInputRuntimeForTests() {
  for (const queue of reliableInputQueues.values()) {
    clearReliableInputTimer(queue);
  }
  reliableInputQueues.clear();
  reliableInputSequence = 0;
}

export function sendInputThroughSessionTransport(options: SendInputTransportOptions) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    options.runtimeDebug('session.input.skip', {
      why: 'no-target-session',
      size: options.data.length,
    });
    return;
  }

  const session = options.refs.sessionsRef.current.find((item) => item.id === targetSessionId) || null;
  if (!session) {
    options.runtimeDebug('session.input.skip', {
      why: 'missing-session',
      sessionId: targetSessionId,
      size: options.data.length,
    });
    return;
  }

  const resource = readDaemonConnectionSessionResource(options, targetSessionId);
  const ws = readDaemonConnectionSessionSocket(options, targetSessionId);
  const wsReadyState = readSocketReadyState(ws);
  const runtimeActiveSessionId = options.refs.stateRef.current.activeSessionId;
  const isActiveTarget = runtimeActiveSessionId === targetSessionId;
  const isExplicitInputTarget = true;
  const reconnectInFlight = options.isReconnectInFlight(targetSessionId);
  const inputChunks = splitTerminalInputUtf8Chunks(options.data, TERMINAL_INPUT_CHUNK_BYTES);

  if (session.reliableInputSupported === true) {
    options.runtimeDebug('session.input.reliable-send-request', {
      sessionId: targetSessionId,
      size: options.data.length,
      bytes: getTerminalInputUtf8ByteLength(options.data),
      chunks: inputChunks.length,
      maxChunkBytes: TERMINAL_INPUT_CHUNK_BYTES,
      preview: options.data.slice(0, 32),
      resourceTargetKey: resource.targetKey,
      resourceSocketState: resource.socketState,
      wsReadyState,
      reconnectInFlight,
    });
    enqueueReliableInputChunks(options, targetSessionId, inputChunks);
    if (
      (!ws || ws.readyState !== WebSocket.OPEN)
      && isActiveTarget
      && !reconnectInFlight
    ) {
      options.scheduleReconnect?.(targetSessionId, 'input transport unavailable', true, {
        immediate: true,
        resetAttempt: true,
        force: true,
      });
    }
    return;
  }

  if (isSessionMessageTransportReady(resource, ws)) {
    const bufferedBytes = Number.isFinite(ws.bufferedAmount)
      ? Math.max(0, Math.floor(ws.bufferedAmount || 0))
      : 0;
    if (bufferedBytes >= TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES) {
      options.runtimeDebug('session.input.drop.backpressured-transport', {
        sessionId: targetSessionId,
        size: options.data.length,
        bufferedBytes,
        thresholdBytes: TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES,
        reconnectInFlight,
      });
      if (ws.readyState < WebSocket.CLOSING) {
        ws.close(4000, 'input backpressure');
      }
      return;
    }
    const localRevision = options.readSessionBufferSnapshot(targetSessionId).revision;
    options.runtimeDebug('session.input.send', {
      sessionId: targetSessionId,
      size: options.data.length,
      bytes: getTerminalInputUtf8ByteLength(options.data),
      chunks: inputChunks.length,
      maxChunkBytes: TERMINAL_INPUT_CHUNK_BYTES,
      preview: options.data.slice(0, 32),
      resourceTargetKey: resource.targetKey,
      resourceSocketState: resource.socketState,
    });
    const isFirstPendingInputTailRefresh = options.markPendingInputTailRefresh(
      targetSessionId,
      localRevision,
    );
    for (const chunk of inputChunks) {
      options.sendSocketPayload(
        targetSessionId,
        ws,
        JSON.stringify({ type: 'input', payload: chunk }),
      );
    }
    if (isFirstPendingInputTailRefresh) {
      scheduleInputHeadRefresh({
        sessionId: targetSessionId,
        daemonConnection: options.daemonConnection,
        requestSessionBufferHead: options.requestSessionBufferHead,
      });
    }
    // Input path keeps transport input synchronous and moves head refresh to a
    // coalesced microtask so refresh work cannot block key dispatch.
    return;
  }

  options.runtimeDebug('session.input.transport-unavailable', {
    sessionId: targetSessionId,
    why: 'transport-unavailable',
    size: options.data.length,
    preview: options.data.slice(0, 32),
    isActiveTarget,
    runtimeActiveSessionId,
    explicitInputTarget: isExplicitInputTarget,
    reconnectInFlight,
    resourceTargetKey: resource.targetKey,
    resourceSocketState: resource.socketState,
    wsReadyState,
    channelState: resource.channel?.state ?? null,
  });
  const pendingTransportOpen = options.hasPendingSessionTransportOpen(targetSessionId);
  const pendingTransportOpenStale = pendingTransportOpen
    ? options.isPendingSessionTransportOpenStale(targetSessionId)
    : false;
  if (pendingTransportOpen) {
    options.runtimeDebug('session.input.drop.pending-transport-open', {
      sessionId: targetSessionId,
      size: options.data.length,
      preview: options.data.slice(0, 32),
      wsReadyState,
      reconnectInFlight,
      pendingTransportOpenStale,
      resourceTargetKey: resource.targetKey,
      resourceSocketState: resource.socketState,
    });
    return;
  }
  if (isActiveTarget && !reconnectInFlight) {
    options.scheduleReconnect?.(targetSessionId, 'input transport unavailable', true, {
      immediate: true,
      resetAttempt: true,
      force: true,
    });
  }
}

export async function ensureSessionReadyForTransfer(options: {
  sessionId: string;
  timeoutMs: number;
  sessionsRef: MutableRefObject<Session[]>;
  daemonConnection: ClientDaemonConnection;
}) {
  const readReadyState = () => {
    const session = options.sessionsRef.current.find((item) => item.id === options.sessionId) || null;
    const ws = options.daemonConnection.readSessionSocket(options.sessionId) || null;
    const ready =
      Boolean(session)
      && session?.state === 'connected'
      && Boolean(ws)
      && ws?.readyState === WebSocket.OPEN;
    return {
      session,
      ws,
      ready,
    };
  };

  const initial = readReadyState();
  if (initial.ready && initial.ws) {
    return initial.ws;
  }

  if (!initial.session) {
    throw new Error('Active session no longer exists');
  }

  if (initial.session.state !== 'connecting' && initial.session.state !== 'reconnecting') {
    throw new Error(`Active session is not ready yet (${initial.session.state || 'missing'})`);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    const current = readReadyState();
    if (current.ready && current.ws) {
      return current.ws;
    }
  }

  const latest = readReadyState();
  const stateLabel = latest.session?.state || 'missing';
  throw new Error(`Active session is not ready yet (${stateLabel})`);
}
