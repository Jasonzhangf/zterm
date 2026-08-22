import type { Session, TerminalInputAckPayload, TerminalReliableInputPayload } from '../types';
import type { BridgeTransportSocket } from '../traversal/types';
import type { SessionTransportResource } from '../session-transport-runtime';
import type { ClientDaemonConnection } from '../client-daemon-connection';
import {
  getTerminalInputUtf8ByteLength,
} from '@zterm/shared/terminal/input-chunking';

export interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

export const TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES = 128 * 1024;
export const TERMINAL_RELIABLE_INPUT_RETRY_MS = 500;
export const TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS = 5000;

export interface SendInputTransportOptions {
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
  sentTargetKey: string | null;
  sentTransportSocket: BridgeTransportSocket | null;
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

export function readDaemonConnectionSessionResource(options: {
  daemonConnection: ClientDaemonConnection;
}, sessionId: string) {
  return options.daemonConnection.readSessionResource(sessionId);
}

export function readDaemonConnectionSessionSocket(options: {
  daemonConnection: ClientDaemonConnection;
}, sessionId: string) {
  return options.daemonConnection.readSessionSocket(sessionId);
}

export function isSessionMessageTransportReady(
  resource: SessionTransportResource,
  ws: BridgeTransportSocket | null,
): ws is BridgeTransportSocket {
  return Boolean(ws)
    && ws?.readyState === WebSocket.OPEN
    && (!resource.channel || resource.channel.state === 'open');
}

export function readSocketReadyState(ws: BridgeTransportSocket | null) {
  return ws ? ws.readyState : null;
}

export function scheduleInputHeadRefresh(options: {
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

function scheduleReliableInputFlush(queue: ReliableInputSessionQueue, delayMs = TERMINAL_RELIABLE_INPUT_RETRY_MS) {
  clearReliableInputTimer(queue);
  queue.timer = globalThis.setTimeout(() => {
    queue.timer = null;
    flushReliableInputQueue(queue.sessionId);
  }, delayMs);
}

function isReliableInputInFlight(item: ReliableInputQueueItem) {
  return item.sentAt !== null;
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
  item.sentTargetKey = resource.targetKey;
  item.sentTransportSocket = ws;
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
    scheduleReliableInputFlush(queue);
    return;
  }

  const item = queue.items[0];
  if (!item) {
    clearReliableInputTimer(queue);
    reliableInputQueues.delete(sessionId);
    return;
  }
  if (isReliableInputInFlight(item)) {
    const retryDecision = shouldRetryReliableInputInFlight(item, resource);
    if (!retryDecision.retry) {
      queue.options.runtimeDebug('session.input.reliable-wait.ack', {
        sessionId,
        seq: item.seq,
        attempt: item.attempt,
        queueDepth: queue.items.length,
      });
      scheduleReliableInputFlush(queue, retryDecision.delayMs);
      return;
    }
    queue.options.runtimeDebug('session.input.reliable-retry.in-flight', {
      sessionId,
      seq: item.seq,
      attempt: item.attempt,
      reason: retryDecision.reason,
      queueDepth: queue.items.length,
      resourceTargetKey: resource.targetKey,
      transportSocketChanged: item.sentTransportSocket !== resource.socket,
    });
    item.sentAt = null;
  }
  sendReliableInputFrame(queue, item, ws, resource);
  scheduleReliableInputFlush(queue);
}

export function enqueueReliableInputChunks(options: SendInputTransportOptions, sessionId: string, inputChunks: string[]) {
  const queue = getReliableInputQueue(sessionId, options);
  for (const chunk of inputChunks) {
    queue.items.push({
      seq: buildReliableInputSeq(sessionId),
      data: chunk,
      bytes: getTerminalInputUtf8ByteLength(chunk),
      attempt: 0,
      sentAt: null,
      sentTargetKey: null,
      sentTransportSocket: null,
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

function computeReliableInputRetryDelayMs(attempt: number, baseMs = TERMINAL_RELIABLE_INPUT_RETRY_MS, capMs = 2000) {
  // 2026-08-09 BUG #2 fix: exponential backoff for reliable input retry.
  // 1st retry (attempt=1) is immediate (0ms) so an ack-timeout is acted on
  // without an extra beat of latency. Subsequent retries (attempt=2,3,4,...)
  // grow exponentially: 500ms → 1000ms → 2000ms (cap). Without this, a daemon
  // stall keeps triggering retry loops at a fixed 500ms cadence, so backoff
  // bounds repeated attempts while the transport drains.
  const safeBase = Math.max(50, baseMs);
  const safeCap = Math.max(safeBase, capMs);
  const attemptClamped = Math.min(8, Math.max(0, attempt | 0));
  if (attemptClamped <= 1) {
    return 0;
  }
  const shift = attemptClamped - 2;
  const delay = Math.min(safeCap, safeBase * (1 << shift));
  return delay;
}

function shouldRetryReliableInputInFlight(item: ReliableInputQueueItem, resource: SessionTransportResource) {
  if (item.sentAt === null) {
    return { retry: false, delayMs: computeReliableInputRetryDelayMs(item.attempt), reason: null };
  }
  const ageMs = Math.max(0, Date.now() - item.sentAt);
  const transportChanged = item.sentTargetKey !== resource.targetKey
    || item.sentTransportSocket !== resource.socket;
  if (transportChanged) {
    return {
      retry: true,
      delayMs: computeReliableInputRetryDelayMs(item.attempt + 1),
      reason: 'transport-generation-changed',
    };
  }
  if (ageMs >= TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS) {
    return {
      retry: true,
      delayMs: computeReliableInputRetryDelayMs(item.attempt + 1),
      reason: 'ack-timeout',
    };
  }
  return {
    retry: false,
    delayMs: computeReliableInputRetryDelayMs(item.attempt),
    reason: null,
  };
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
    const item = queue.items[index];
    if (item) {
      item.sentAt = null;
    }
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
