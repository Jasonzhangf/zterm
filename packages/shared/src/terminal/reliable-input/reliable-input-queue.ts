import type { TerminalInputAckPayload } from '../../connection/protocol';
import {
  getTerminalInputUtf8ByteLength,
  splitTerminalInputUtf8Chunks,
  TERMINAL_INPUT_CHUNK_BYTES,
} from '../input-chunking';

export const TERMINAL_RELIABLE_INPUT_RETRY_MS = 500;
export const TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS = 5000;
export const TERMINAL_RELIABLE_INPUT_SETTLED_HISTORY_MAX = 256;

export type ReliableInputItemState =
  | 'queued'
  | 'sent'
  | 'accepted'
  | 'rejected'
  | 'uncertain'
  | 'cancelled';

export type ReliableInputFailureStage =
  | 'ack'
  | 'nack'
  | 'timeout'
  | 'send'
  | 'generation'
  | 'protocol';

export interface ReliableInputFailure {
  stage: ReliableInputFailureStage;
  code: string;
  message: string;
  ack?: TerminalInputAckPayload;
}

export interface ReliableInputItemSnapshot {
  seq: string;
  data: string;
  bytes: number;
  attempt: number;
  state: ReliableInputItemState;
  sentAt: number | null;
  channel: string | null;
  generation: string | null;
  failure?: ReliableInputFailure;
}

export interface ReliableInputTransportSnapshot {
  available: boolean;
  ready: boolean;
  backpressured: boolean;
  channel: string | null;
  generation: string | null;
  closed?: boolean;
}

export interface ReliableInputAckContext {
  channel: string | null;
  generation: string | null;
}

export interface ReliableInputSendItem {
  seq: string;
  data: string;
  bytes: number;
  attempt: number;
  sentAt: number;
  channel: string;
  generation: string;
}

export type ReliableInputPolicyEvent =
  | {
      kind: 'ack';
      item: ReliableInputItemSnapshot;
      ack: TerminalInputAckPayload;
    }
  | {
      kind: 'timeout';
      item: ReliableInputItemSnapshot;
    }
  | {
      kind: 'generation-change';
      item: ReliableInputItemSnapshot;
      current: ReliableInputAckContext;
    }
  | {
      kind: 'send-error';
      item: ReliableInputItemSnapshot;
      error: unknown;
    }
  | {
      kind: 'protocol-error';
      item: ReliableInputItemSnapshot;
      ack: TerminalInputAckPayload;
      reason: string;
    };

export type ReliableInputPolicyAction =
  | { action: 'accept' }
  | { action: 'retry'; delayMs: number }
  | {
      action: 'drop';
      outcome: 'rejected';
      error?: ReliableInputFailure;
    }
  | {
      action: 'stop';
      outcome: 'rejected' | 'uncertain';
      error: ReliableInputFailure;
    };

export interface ReliableInputPolicy {
  maxInFlight: number;
  initialAttempt: 0 | 1;
  decide(event: ReliableInputPolicyEvent): ReliableInputPolicyAction;
  acknowledgePollDelayMs?(item: ReliableInputItemSnapshot): number;
}

export interface ReliableInputSettlement {
  item: ReliableInputItemSnapshot;
  outcome: 'accepted' | 'rejected' | 'uncertain' | 'cancelled';
  error?: ReliableInputFailure;
}

export interface ReliableInputQueueSnapshot {
  closed: boolean;
  activeDepth: number;
  items: readonly ReliableInputItemSnapshot[];
}

export interface ReliableInputEnqueueResult {
  enqueued: number;
  depth: number;
}

export interface ReliableInputAckResult {
  kind: 'ignored' | 'retried' | 'settled' | 'closed';
  reason?: string;
}

export type ReliableInputRuntimeEvent =
  | { kind: 'enqueue'; count: number; depth: number }
  | { kind: 'send'; item: ReliableInputItemSnapshot }
  | {
      kind: 'wait';
      reason: 'transport-unavailable' | 'backpressure' | 'ack';
      item: ReliableInputItemSnapshot | null;
    }
  | {
      kind: 'retry';
      event: ReliableInputPolicyEvent;
      item: ReliableInputItemSnapshot;
      delayMs: number;
    }
  | { kind: 'ack-ignored'; seq: string; reason: string }
  | { kind: 'settled'; settlement: ReliableInputSettlement }
  | { kind: 'idle' };

export interface ReliableInputQueueOptions {
  policy: ReliableInputPolicy;
  readTransport(): ReliableInputTransportSnapshot;
  send(item: ReliableInputSendItem): void | Promise<void>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelTimer?: (handle: unknown) => void;
  onSettled?(settlement: ReliableInputSettlement): void;
  onEvent?(event: ReliableInputRuntimeEvent): void;
  connectionId?: string;
  retryIntervalMs?: number;
  ackTimeoutMs?: number;
}

export interface ReliableInputQueue {
  enqueueChunks(chunks: readonly string[]): ReliableInputEnqueueResult;
  enqueueText(text: string, maxChunkBytes?: number): ReliableInputEnqueueResult;
  handleAck(payload: TerminalInputAckPayload, context: ReliableInputAckContext): ReliableInputAckResult;
  pump(): void;
  close(): void;
  snapshot(): ReliableInputQueueSnapshot;
}

interface ReliableInputItem {
  seq: string;
  data: string;
  bytes: number;
  attempt: number;
  state: ReliableInputItemState;
  sentAt: number | null;
  channel: string | null;
  generation: string | null;
  failure?: ReliableInputFailure;
  ackWaitLogAt: number | null;
}

function failure(
  stage: ReliableInputFailureStage,
  code: string,
  message: string,
  ack?: TerminalInputAckPayload,
): ReliableInputFailure {
  return { stage, code, message, ...(ack ? { ack } : {}) };
}

function failureFromUnknown(stage: 'send', error: unknown): ReliableInputFailure {
  if (error instanceof Error) {
    return failure(stage, 'input_send_failed', error.message);
  }
  return failure(stage, 'input_send_failed', String(error));
}

export const cliNoReplayPolicy: ReliableInputPolicy = {
  maxInFlight: 1,
  initialAttempt: 0,
  decide(event) {
    if (event.kind === 'ack' && event.ack.accepted === true) {
      return { action: 'accept' };
    }
    if (event.kind === 'ack') {
      return {
        action: 'stop',
        outcome: 'uncertain',
        error: failure(
          'nack',
          event.ack.error || 'input_rejected',
          'input write result is unconfirmed',
          event.ack,
        ),
      };
    }
    if (event.kind === 'timeout') {
      return {
        action: 'stop',
        outcome: 'uncertain',
        error: failure(
          'timeout',
          'input_ack_timeout',
          'input ACK was not received before the deadline',
        ),
      };
    }
    if (event.kind === 'generation-change') {
      return {
        action: 'stop',
        outcome: 'uncertain',
        error: failure(
          'generation',
          'input_transport_generation_changed',
          'transport channel or generation changed after send',
        ),
      };
    }
    if (event.kind === 'send-error') {
      return {
        action: 'stop',
        outcome: 'uncertain',
        error: failureFromUnknown('send', event.error),
      };
    }
    return {
      action: 'stop',
      outcome: 'uncertain',
      error: failure(
        'protocol',
        event.reason,
        'input ACK protocol fields conflicted with the sent item',
        event.ack,
      ),
    };
  },
  acknowledgePollDelayMs() {
    return TERMINAL_RELIABLE_INPUT_RETRY_MS;
  },
};

function normalizeDelay(value: number, fallback: number) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function toSnapshot(item: ReliableInputItem): ReliableInputItemSnapshot {
  return {
    seq: item.seq,
    data: item.data,
    bytes: item.bytes,
    attempt: item.attempt,
    state: item.state,
    sentAt: item.sentAt,
    channel: item.channel,
    generation: item.generation,
    ...(item.failure ? { failure: item.failure } : {}),
  };
}

function activeItem(item: ReliableInputItem) {
  return item.state === 'queued' || item.state === 'sent';
}

function contextMatches(
  left: ReliableInputAckContext,
  right: ReliableInputAckContext,
) {
  return Boolean(left.channel)
    && Boolean(left.generation)
    && left.channel === right.channel
    && left.generation === right.generation;
}

function createConnectionId() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.randomUUID !== 'function') {
    throw new Error('reliable input requires crypto.randomUUID');
  }
  return cryptoApi.randomUUID();
}

export function createReliableInputQueue(
  options: ReliableInputQueueOptions,
): ReliableInputQueue {
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancelTimer = options.cancelTimer ?? ((handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  });
  const retryIntervalMs = normalizeDelay(
    options.retryIntervalMs ?? TERMINAL_RELIABLE_INPUT_RETRY_MS,
    TERMINAL_RELIABLE_INPUT_RETRY_MS,
  );
  const ackTimeoutMs = normalizeDelay(
    options.ackTimeoutMs ?? TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS,
    TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS,
  );
  if (!Number.isSafeInteger(options.policy.maxInFlight) || options.policy.maxInFlight <= 0) {
    throw new TypeError('reliable input maxInFlight must be a positive safe integer');
  }
  if (options.policy.initialAttempt !== 0 && options.policy.initialAttempt !== 1) {
    throw new TypeError('reliable input initialAttempt must be 0 or 1');
  }

  const connectionId = options.connectionId ?? createConnectionId();
  const activeItems: ReliableInputItem[] = [];
  const settledItems: ReliableInputItem[] = [];
  let sequence = 0;
  let timer: unknown = null;
  let closed = false;

  const emit = (event: ReliableInputRuntimeEvent) => {
    options.onEvent?.(event);
  };

  const clearTimer = () => {
    if (timer !== null) {
      cancelTimer(timer);
      timer = null;
    }
  };

  const scheduleNext = (delayMs: number) => {
    clearTimer();
    if (closed || activeItems.length === 0) {
      if (!closed) {
        emit({ kind: 'idle' });
      }
      return;
    }
    const safeDelay = normalizeDelay(delayMs, retryIntervalMs);
    timer = schedule(() => {
      timer = null;
      pump();
    }, safeDelay);
  };

  const settle = (
    item: ReliableInputItem,
    outcome: ReliableInputSettlement['outcome'],
    error?: ReliableInputFailure,
  ) => {
    if (!activeItem(item)) {
      return;
    }
    item.state = outcome;
    if (error) {
      item.failure = error;
    }
    const index = activeItems.indexOf(item);
    if (index >= 0) {
      activeItems.splice(index, 1);
    }
    settledItems.push(item);
    if (settledItems.length > TERMINAL_RELIABLE_INPUT_SETTLED_HISTORY_MAX) {
      settledItems.splice(0, settledItems.length - TERMINAL_RELIABLE_INPUT_SETTLED_HISTORY_MAX);
    }
    const settlement: ReliableInputSettlement = {
      item: toSnapshot(item),
      outcome,
      ...(error ? { error } : {}),
    };
    emit({ kind: 'settled', settlement });
    options.onSettled?.(settlement);
  };

  const closeRemaining = (except?: ReliableInputItem) => {
    closed = true;
    clearTimer();
    const remaining = [...activeItems];
    for (const item of remaining) {
      if (item === except) {
        continue;
      }
      if (item.state === 'sent') {
        settle(
          item,
          'uncertain',
          failure('generation', 'input_queue_closed', 'input queue closed with an unconfirmed send'),
        );
      } else {
        settle(item, 'cancelled');
      }
    }
  };

  const stop = (
    item: ReliableInputItem,
    outcome: 'rejected' | 'uncertain',
    error: ReliableInputFailure,
  ) => {
    closed = true;
    clearTimer();
    settle(item, outcome, error);
    closeRemaining();
  };

  const readTransportSafely = (): ReliableInputTransportSnapshot => {
    try {
      return options.readTransport();
    } catch {
      return {
        available: false,
        ready: false,
        backpressured: false,
        channel: null,
        generation: null,
      };
    }
  };

  const applyRetry = (event: ReliableInputPolicyEvent, item: ReliableInputItem, delayMs: number) => {
    item.attempt += 1;
    item.state = 'queued';
    item.sentAt = null;
    item.channel = null;
    item.generation = null;
    item.ackWaitLogAt = null;
    const safeDelay = normalizeDelay(delayMs, retryIntervalMs);
    emit({
      kind: 'retry',
      event,
      item: toSnapshot(item),
      delayMs: safeDelay,
    });
    return safeDelay;
  };

  const applyPolicy = (
    event: ReliableInputPolicyEvent,
    item: ReliableInputItem,
  ): { retryDelayMs: number | null; continuePump: boolean } => {
    const action = options.policy.decide(event);
    if (action.action === 'accept') {
      settle(item, 'accepted');
      return { retryDelayMs: null, continuePump: true };
    }
    if (action.action === 'retry') {
      return {
        retryDelayMs: applyRetry(event, item, action.delayMs),
        continuePump: false,
      };
    }
    if (action.action === 'drop') {
      settle(item, action.outcome, action.error);
      return { retryDelayMs: null, continuePump: true };
    }
    stop(item, action.outcome, action.error);
    return { retryDelayMs: null, continuePump: false };
  };

  const handleSendFailure = (item: ReliableInputItem, error: unknown) => {
    if (closed || item.state !== 'sent') {
      return;
    }
    applyPolicy({ kind: 'send-error', item: toSnapshot(item), error }, item);
  };

  const sendItem = (
    item: ReliableInputItem,
    transport: ReliableInputTransportSnapshot,
  ) => {
    if (!transport.channel || !transport.generation) {
      return false;
    }
    item.sentAt = now();
    item.channel = transport.channel;
    item.generation = transport.generation;
    item.state = 'sent';
    item.ackWaitLogAt = item.sentAt;
    const snapshot = toSnapshot(item);
    emit({ kind: 'send', item: snapshot });
    try {
      const result = options.send({
        seq: item.seq,
        data: item.data,
        bytes: item.bytes,
        attempt: item.attempt,
        sentAt: item.sentAt,
        channel: item.channel,
        generation: item.generation,
      });
      if (result && typeof result.then === 'function') {
        void result.catch((error) => handleSendFailure(item, error));
      }
      return true;
    } catch (error) {
      handleSendFailure(item, error);
      return false;
    }
  };

  const pump = () => {
    if (closed) {
      return;
    }
    clearTimer();
    if (activeItems.length === 0) {
      emit({ kind: 'idle' });
      return;
    }

    const transport = readTransportSafely();
    if (transport.closed) {
      closeRemaining();
      return;
    }

    const sentItems = activeItems.filter((item) => item.state === 'sent');
    for (const item of sentItems) {
      if (
        item.channel === transport.channel
        && item.generation === transport.generation
      ) {
        continue;
      }
      const event: ReliableInputPolicyEvent = {
        kind: 'generation-change',
        item: toSnapshot(item),
        current: {
          channel: transport.channel,
          generation: transport.generation,
        },
      };
      const decision = applyPolicy(event, item);
      if (closed) {
        return;
      }
      if (decision.retryDelayMs !== null) {
        if (decision.retryDelayMs === 0) {
          pump();
        } else {
          scheduleNext(decision.retryDelayMs);
        }
        return;
      }
    }

    if (!transport.available || !transport.ready) {
      emit({
        kind: 'wait',
        reason: 'transport-unavailable',
        item: sentItems.length > 0 ? toSnapshot(sentItems[0]!) : null,
      });
      scheduleNext(retryIntervalMs);
      return;
    }
    if (transport.backpressured) {
      emit({
        kind: 'wait',
        reason: 'backpressure',
        item: sentItems.length > 0 ? toSnapshot(sentItems[0]!) : null,
      });
      scheduleNext(retryIntervalMs);
      return;
    }

    const oldestSent = activeItems.find((item) => item.state === 'sent') ?? null;
    if (oldestSent && oldestSent.sentAt !== null) {
      const ageMs = Math.max(0, now() - oldestSent.sentAt);
      if (ageMs >= ackTimeoutMs) {
        const decision = applyPolicy({
          kind: 'timeout',
          item: toSnapshot(oldestSent),
        }, oldestSent);
        if (closed) {
          return;
        }
        if (decision.retryDelayMs !== null) {
          if (decision.retryDelayMs === 0) {
            pump();
          } else {
            scheduleNext(decision.retryDelayMs);
          }
          return;
        }
      }
    }

    let inFlight = activeItems.reduce(
      (count, item) => count + (item.state === 'sent' ? 1 : 0),
      0,
    );
    let sentInPump = 0;
    for (const item of activeItems) {
      if (inFlight >= options.policy.maxInFlight) {
        break;
      }
      if (item.state !== 'queued') {
        continue;
      }
      if (!sendItem(item, transport)) {
        return;
      }
      inFlight += 1;
      sentInPump += 1;
      const afterSend = readTransportSafely();
      if (
        afterSend.closed
        || !afterSend.available
        || !afterSend.ready
        || afterSend.backpressured
      ) {
        break;
      }
    }

    if (closed) {
      return;
    }
    if (activeItems.length === 0) {
      scheduleNext(0);
      return;
    }
    const nextSent = activeItems.find((item) => item.state === 'sent') ?? null;
    if (!nextSent) {
      scheduleNext(sentInPump > 0 ? retryIntervalMs : 0);
      return;
    }
    const configuredDelay = options.policy.acknowledgePollDelayMs?.(toSnapshot(nextSent))
      ?? retryIntervalMs;
    const safeDelay = normalizeDelay(configuredDelay, retryIntervalMs);
    const currentTime = now();
    const ageMs = Math.max(0, currentTime - (nextSent.sentAt ?? currentTime));
    const remainingAckMs = Math.max(0, ackTimeoutMs - ageMs);
    if (
      nextSent.ackWaitLogAt === null
      || currentTime - nextSent.ackWaitLogAt >= safeDelay
    ) {
      emit({ kind: 'wait', reason: 'ack', item: toSnapshot(nextSent) });
      nextSent.ackWaitLogAt = currentTime;
    }
    scheduleNext(Math.min(retryIntervalMs, safeDelay, remainingAckMs));
  };

  const enqueueChunks = (chunks: readonly string[]): ReliableInputEnqueueResult => {
    if (closed) {
      return { enqueued: 0, depth: settledItems.length };
    }
    let enqueued = 0;
    for (const data of chunks) {
      if (typeof data !== 'string' || data.length === 0) {
        continue;
      }
      sequence += 1;
      activeItems.push({
        seq: `${connectionId}:input:${sequence}`,
        data,
        bytes: getTerminalInputUtf8ByteLength(data),
        attempt: options.policy.initialAttempt,
        state: 'queued',
        sentAt: null,
        channel: null,
        generation: null,
        ackWaitLogAt: null,
      });
      enqueued += 1;
    }
    const result = { enqueued, depth: activeItems.length };
    if (enqueued > 0) {
      emit({ kind: 'enqueue', count: enqueued, depth: activeItems.length });
      pump();
    }
    return result;
  };

  const handleAck = (
    payload: TerminalInputAckPayload,
    context: ReliableInputAckContext,
  ): ReliableInputAckResult => {
    if (!payload || typeof payload.seq !== 'string') {
      return { kind: 'ignored', reason: 'invalid-payload' };
    }
    const item = activeItems.find(
      (candidate) => candidate.seq === payload.seq && candidate.state === 'sent',
    );
    if (!item) {
      emit({ kind: 'ack-ignored', seq: payload.seq, reason: 'unknown-seq' });
      return { kind: 'ignored', reason: 'unknown-seq' };
    }
    if (!contextMatches(context, {
      channel: item.channel,
      generation: item.generation,
    })) {
      emit({ kind: 'ack-ignored', seq: payload.seq, reason: 'stale-context' });
      return { kind: 'ignored', reason: 'stale-context' };
    }
    if (
      payload.version !== 1
      || typeof payload.accepted !== 'boolean'
      || !Number.isSafeInteger(payload.bytes)
      || payload.bytes < 0
    ) {
      const decision = applyPolicy({
        kind: 'protocol-error',
        item: toSnapshot(item),
        ack: payload,
        reason: 'input_ack_protocol_conflict',
      }, item);
      return decision.continuePump
        ? { kind: 'settled', reason: 'protocol-error' }
        : { kind: closed ? 'closed' : 'settled', reason: 'protocol-error' };
    }
    if (payload.accepted === true && payload.bytes !== item.bytes) {
      const decision = applyPolicy({
        kind: 'protocol-error',
        item: toSnapshot(item),
        ack: payload,
        reason: 'input_ack_bytes_mismatch',
      }, item);
      return decision.continuePump
        ? { kind: 'settled', reason: 'bytes-mismatch' }
        : { kind: closed ? 'closed' : 'settled', reason: 'bytes-mismatch' };
    }

    const decision = applyPolicy({
      kind: 'ack',
      item: toSnapshot(item),
      ack: payload,
    }, item);
    if (closed) {
      return {
        kind: 'closed',
        reason: payload.accepted ? 'accepted' : payload.error || 'rejected',
      };
    }
    if (decision.retryDelayMs !== null) {
      scheduleNext(decision.retryDelayMs);
      return {
        kind: 'retried',
        reason: payload.error || 'retry',
      };
    }
    pump();
    return {
      kind: 'settled',
      reason: payload.accepted ? 'accepted' : payload.error || 'rejected',
    };
  };

  return {
    enqueueChunks,
    enqueueText(text, maxChunkBytes = TERMINAL_INPUT_CHUNK_BYTES) {
      return enqueueChunks(splitTerminalInputUtf8Chunks(text, maxChunkBytes));
    },
    handleAck,
    pump,
    close() {
      closeRemaining();
    },
    snapshot() {
      return {
        closed,
        activeDepth: activeItems.length,
        items: [...settledItems, ...activeItems].map(toSnapshot),
      };
    },
  };
}
