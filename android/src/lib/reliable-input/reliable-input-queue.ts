import type {
  Session,
  TerminalInputAckPayload,
  TerminalReliableInputPayload,
} from '../types';
import type { BridgeTransportSocket } from '../traversal/types';
import type { SessionTransportResource } from '../session-transport-runtime';
import type { ClientDaemonConnection } from '../client-daemon-connection';
import {
  createReliableInputQueue,
  type ReliableInputEnqueueResult,
  type ReliableInputFailure,
  type ReliableInputPolicy,
  type ReliableInputQueue,
  type ReliableInputRuntimeEvent,
  type ReliableInputTransportSnapshot,
} from '@zterm/shared/terminal/reliable-input/reliable-input-queue';

export interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

export const TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES = 128 * 1024;
export const TERMINAL_RELIABLE_INPUT_RETRY_MS = 500;
export const TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS = 5000;
export const TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT = 8;

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

interface AndroidReliableInputQueue {
  sessionId: string;
  options: SendInputTransportOptions;
  core: ReliableInputQueue;
  headRefreshMarked: boolean;
}

const reliableInputQueues = new Map<string, AndroidReliableInputQueue>();
let socketGenerationSequence = 0;
let socketGenerations = new WeakMap<object, string>();

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

function computeReliableInputRetryDelayMs(
  attempt: number,
  baseMs = TERMINAL_RELIABLE_INPUT_RETRY_MS,
  capMs = 2000,
) {
  const safeBase = Math.max(50, baseMs);
  const safeCap = Math.max(safeBase, capMs);
  const attemptClamped = Math.min(8, Math.max(0, attempt | 0));
  if (attemptClamped <= 1) {
    return 0;
  }
  const shift = attemptClamped - 2;
  return Math.min(safeCap, safeBase * (1 << shift));
}

function isRetryableReliableInputNack(payload: TerminalInputAckPayload) {
  return payload.accepted === false && (
    payload.error === 'input_stale_transport'
    || payload.error === 'session_required'
    || payload.error === 'transport_unavailable'
    || payload.error === 'input_transport_unavailable'
  );
}

function androidFailure(
  stage: ReliableInputFailure['stage'],
  code: string,
  message: string,
): ReliableInputFailure {
  return { stage, code, message };
}

const androidExistingPolicy: ReliableInputPolicy = {
  maxInFlight: TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT,
  initialAttempt: 1,
  decide(event) {
    if (event.kind === 'ack' && event.ack.accepted === true) {
      return { action: 'accept' };
    }
    if (event.kind === 'ack' && isRetryableReliableInputNack(event.ack)) {
      return { action: 'retry', delayMs: TERMINAL_RELIABLE_INPUT_RETRY_MS };
    }
    if (event.kind === 'ack') {
      return {
        action: 'drop',
        outcome: 'rejected',
        error: androidFailure(
          'nack',
          event.ack.error || 'input_rejected',
          'reliable input was rejected',
        ),
      };
    }
    if (event.kind === 'timeout' || event.kind === 'generation-change') {
      return { action: 'retry', delayMs: 0 };
    }
    if (event.kind === 'send-error') {
      return {
        action: 'stop',
        outcome: 'rejected',
        error: androidFailure('send', 'input_send_failed', String(event.error)),
      };
    }
    return {
      action: 'stop',
      outcome: 'uncertain',
      error: androidFailure('protocol', event.reason, 'input ACK fields conflicted'),
    };
  },
  acknowledgePollDelayMs(item) {
    return Math.max(
      TERMINAL_RELIABLE_INPUT_RETRY_MS,
      computeReliableInputRetryDelayMs(item.attempt),
    );
  },
};

function readSocketGeneration(ws: BridgeTransportSocket | null) {
  if (!ws) {
    return null;
  }
  let generation = socketGenerations.get(ws);
  if (!generation) {
    socketGenerationSequence += 1;
    generation = `socket:${socketGenerationSequence}`;
    socketGenerations.set(ws, generation);
  }
  return generation;
}

function readAndroidTransport(
  queue: AndroidReliableInputQueue,
): ReliableInputTransportSnapshot {
  const session = queue.options.refs.sessionsRef.current.find(
    (candidate) => candidate.id === queue.sessionId,
  );
  if (!session) {
    return {
      available: false,
      ready: false,
      backpressured: false,
      channel: null,
      generation: null,
      closed: true,
    };
  }
  const resource = readDaemonConnectionSessionResource(queue.options, queue.sessionId);
  const ws = readDaemonConnectionSessionSocket(queue.options, queue.sessionId);
  const socketGeneration = readSocketGeneration(ws);
  const targetKey = resource.targetKey || queue.sessionId;
  const generation = socketGeneration ? `${targetKey}:${socketGeneration}` : null;
  const channel = `${targetKey}:${resource.channel?.channelId ?? 'legacy'}`;
  const bufferedBytes = ws && Number.isFinite(ws.bufferedAmount)
    ? Math.max(0, Math.floor(ws.bufferedAmount || 0))
    : 0;
  return {
    available: true,
    ready: isSessionMessageTransportReady(resource, ws),
    backpressured: bufferedBytes >= TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES,
    channel,
    generation,
  };
}

function activeQueueDepth(queue: AndroidReliableInputQueue) {
  return queue.core.snapshot().activeDepth;
}

function logQueueEvent(
  queue: AndroidReliableInputQueue,
  event: ReliableInputRuntimeEvent,
) {
  const { options, sessionId } = queue;
  if (event.kind === 'enqueue') {
    options.runtimeDebug('session.input.reliable-enqueue', {
      sessionId,
      chunks: event.count,
      queueDepth: event.depth,
    });
    return;
  }
  if (event.kind === 'wait') {
    const resource = readDaemonConnectionSessionResource(options, sessionId);
    const ws = readDaemonConnectionSessionSocket(options, sessionId);
    const bufferedBytes = ws && Number.isFinite(ws.bufferedAmount)
      ? Math.max(0, Math.floor(ws.bufferedAmount || 0))
      : 0;
    if (event.reason === 'ack') {
      options.runtimeDebug('session.input.reliable-wait.ack', {
        sessionId,
        seq: event.item?.seq ?? null,
        attempt: event.item?.attempt ?? 0,
        queueDepth: activeQueueDepth(queue),
      });
    } else if (event.reason === 'backpressure') {
      options.runtimeDebug('session.input.reliable-wait.backpressured-transport', {
        sessionId,
        queueDepth: activeQueueDepth(queue),
        bufferedBytes,
        thresholdBytes: TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES,
        reconnectInFlight: options.isReconnectInFlight(sessionId),
      });
    } else {
      options.runtimeDebug('session.input.reliable-wait.transport-unavailable', {
        sessionId,
        queueDepth: activeQueueDepth(queue),
        wsReadyState: readSocketReadyState(ws),
        reconnectInFlight: options.isReconnectInFlight(sessionId),
        resourceTargetKey: resource.targetKey,
        resourceSocketState: resource.socketState,
        channelState: resource.channel?.state ?? null,
      });
    }
    return;
  }
  if (event.kind === 'retry') {
    if (event.event.kind === 'generation-change') {
      options.runtimeDebug('session.input.reliable-retry.transport-generation', {
        sessionId,
        queueDepth: activeQueueDepth(queue),
        resetCount: 1,
        resourceTargetKey: readDaemonConnectionSessionResource(options, sessionId).targetKey,
      });
    } else if (event.event.kind === 'ack') {
      options.runtimeDebug('session.input.reliable-nack.retry', {
        sessionId,
        seq: event.item.seq,
        accepted: event.event.ack.accepted,
        bytes: event.event.ack.bytes,
        error: event.event.ack.error,
        queueDepth: activeQueueDepth(queue),
      });
    } else {
      options.runtimeDebug('session.input.reliable-retry.in-flight', {
        sessionId,
        seq: event.item.seq,
        attempt: event.item.attempt,
        reason: event.event.kind,
        queueDepth: activeQueueDepth(queue),
      });
    }
    return;
  }
  if (event.kind === 'settled') {
    if (event.settlement.outcome === 'accepted') {
      options.runtimeDebug('session.input.reliable-ack', {
        sessionId,
        seq: event.settlement.item.seq,
        accepted: true,
        queueDepth: activeQueueDepth(queue),
      });
    } else if (
      event.settlement.error?.stage === 'nack'
      || event.settlement.error?.stage === 'protocol'
    ) {
      options.runtimeDebug('session.input.reliable-nack', {
        sessionId,
        seq: event.settlement.item.seq,
        accepted: false,
        bytes: event.settlement.error.ack?.bytes ?? 0,
        error: event.settlement.error.code,
        queueDepth: activeQueueDepth(queue),
      });
    }
    return;
  }
  if (event.kind === 'idle') {
    queue.headRefreshMarked = false;
    reliableInputQueues.delete(sessionId);
  }
}

function createAndroidQueue(
  sessionId: string,
  options: SendInputTransportOptions,
): AndroidReliableInputQueue {
  let queue: AndroidReliableInputQueue;
  const core = createReliableInputQueue({
    policy: androidExistingPolicy,
    readTransport: () => readAndroidTransport(queue),
    send: (item) => {
      const resource = readDaemonConnectionSessionResource(options, sessionId);
      const ws = readDaemonConnectionSessionSocket(options, sessionId);
      if (!isSessionMessageTransportReady(resource, ws)) {
        throw new Error('reliable input transport is not ready');
      }
      const localRevision = options.readSessionBufferSnapshot(sessionId).revision;
      const payload: TerminalReliableInputPayload = {
        version: 1,
        seq: item.seq,
        data: item.data,
        sentAt: item.sentAt,
        attempt: item.attempt,
      };
      options.sendSocketPayload(
        sessionId,
        ws,
        JSON.stringify({ type: 'input', payload }),
      );
      if (!queue.headRefreshMarked) {
        queue.headRefreshMarked = true;
        const isFirstPendingInputTailRefresh = options.markPendingInputTailRefresh(
          sessionId,
          localRevision,
        );
        if (isFirstPendingInputTailRefresh) {
          scheduleInputHeadRefresh({
            sessionId,
            daemonConnection: options.daemonConnection,
            requestSessionBufferHead: options.requestSessionBufferHead,
          });
        }
      }
      options.runtimeDebug('session.input.reliable-send', {
        sessionId,
        seq: item.seq,
        bytes: item.bytes,
        attempt: item.attempt,
        queueDepth: core.snapshot().activeDepth,
        resourceTargetKey: resource.targetKey,
        resourceSocketState: resource.socketState,
      });
    },
    onEvent: (event) => logQueueEvent(queue, event),
  });
  queue = {
    sessionId,
    options,
    core,
    headRefreshMarked: false,
  };
  return queue;
}

function getReliableInputQueue(
  sessionId: string,
  options: SendInputTransportOptions,
) {
  const current = reliableInputQueues.get(sessionId);
  if (current) {
    current.options = options;
    return current;
  }
  const next = createAndroidQueue(sessionId, options);
  reliableInputQueues.set(sessionId, next);
  return next;
}

export function enqueueReliableInputChunks(
  options: SendInputTransportOptions,
  sessionId: string,
  inputChunks: string[],
): ReliableInputEnqueueResult {
  const queue = getReliableInputQueue(sessionId, options);
  const result = queue.core.enqueueChunks(inputChunks);
  queue.core.pump();
  return result;
}

export function handleTerminalInputAck(
  sessionId: string,
  payload: TerminalInputAckPayload,
) {
  const queue = reliableInputQueues.get(sessionId);
  if (!queue) {
    return;
  }
  const transport = readAndroidTransport(queue);
  queue.core.handleAck(payload, {
    channel: transport.channel,
    generation: transport.generation,
  });
}

export function resetTerminalReliableInputRuntimeForTests() {
  for (const queue of reliableInputQueues.values()) {
    queue.core.close();
  }
  reliableInputQueues.clear();
  socketGenerationSequence = 0;
  socketGenerations = new WeakMap<object, string>();
}
