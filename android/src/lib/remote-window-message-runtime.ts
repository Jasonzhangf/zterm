import type {
  ClientMessage,
  RemoteWindowStreamIceCandidate,
  RemoteWindowStreamIceCandidatePayload,
  RemoteWindowInputDeliveryControl,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamStartedOfferV2Payload,
  RemoteWindowStreamAnswerV2Payload,
  RemoteWindowStreamStartRequestV2Payload,
  RemoteWindowStreamStatusPayload,
  RemoteWindowStreamCleanupResult,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamRequestPayload,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowBrowserUserAgent,
  RemoteWindowBrowserUserAgentResultPayload,
  RemoteWindowStreamPurpose,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowVideoProfile,
  RemoteWindowCloseRequestPayload,
  RemoteWindowCloseResultPayload,
  ServerMessage,
} from './types';
import type { BridgeTransportSocket } from './traversal/types';

export type RemoteWindowControlMessage = Extract<
  ServerMessage,
  | { type: 'remote-window-targets-response' }
  | { type: 'remote-window-stream-started' }
  | { type: 'remote-window-stream-offer-v2' }
  | { type: 'remote-window-stream-ice-candidate' }
  | { type: 'remote-window-stream-status' }
  | { type: 'remote-window-stream-focus-result' }
  | { type: 'remote-window-stream-quality-result' }
  | { type: 'remote-window-input-ack' }
  | { type: 'remote-window-error' }
  | { type: 'remote-window-browser-user-agent-result' }
  | { type: 'remote-window-close-result' }
>;

type RemoteWindowInputClientMessage = Extract<ClientMessage, { type: 'remote-window-input' }>;

interface PendingRemoteWindowReliableInput {
  sessionId: string;
  ws: BridgeTransportSocket;
  payload: RemoteWindowInputEventPayload;
  control: RemoteWindowInputDeliveryControl;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  /** True once this record has been handed to the physical socket at least once (even if send threw). */
  dispatchedToSocket?: boolean;
}

interface PendingRemoteWindowContinuousInput extends PendingRemoteWindowReliableInput {
  control: RemoteWindowInputDeliveryControl & { lane: 'continuous' };
}

interface PendingRemoteWindowTargetsRequest {
  kind: 'targets';
  streamId?: undefined;
  timeoutId: number | null;
  resolve: (payload: RemoteWindowStreamTargetsResponsePayload) => void;
  reject: (error: Error) => void;
}

interface PendingRemoteWindowStreamStartRequest {
  kind: 'stream-start';
  streamId: string;
  timeoutId: number | null;
  resolve: (payload: RemoteWindowStreamStartedPayload | RemoteWindowStreamStartedOfferV2Payload) => void;
  reject: (error: Error) => void;
}

interface PendingRemoteWindowStreamStopRequest {
  kind: 'stream-stop';
  streamId: string;
  timeoutId: number | null;
  resolve: (payload: RemoteWindowStreamStatusPayload) => void;
  reject: (error: Error) => void;
}

interface PendingRemoteWindowStreamCloseRequest {
  kind: 'stream-close';
  sessionId: string;
  streamId: string;
  targetId: string;
  timeoutId: number | null;
  resolve: (payload: RemoteWindowCloseResultPayload) => void;
  reject: (error: Error) => void;
}

interface PendingRemoteWindowStreamQualityRequest {
  kind: 'stream-quality';
  streamId: string;
  streamGroupId: string;
  revision: number;
  timeoutId: number | null;
  resolve: (payload: RemoteWindowStreamQualityResultPayload) => void;
  reject: (error: Error) => void;
}

interface PendingRemoteWindowBrowserUserAgentRequest {
  timeoutId: number | null;
  resolve: (payload: RemoteWindowBrowserUserAgentResultPayload) => void;
  reject: (error: Error) => void;
}

type PendingRemoteWindowRequest =
  | PendingRemoteWindowTargetsRequest
  | PendingRemoteWindowStreamStartRequest
  | PendingRemoteWindowStreamStopRequest
  | PendingRemoteWindowStreamCloseRequest
  | PendingRemoteWindowStreamQualityRequest;
type RemoteWindowMessageSubscriber = (msg: RemoteWindowControlMessage) => void | Promise<unknown>;

export type RemoteWindowInputDeliveryOutcomeStatusV1 = 'delivered' | 'failed' | 'cancelled';
export type RemoteWindowInputDeliveryOutcomeSourceV1 =
  | 'daemon-ack'
  | 'client-send'
  | 'client-timeout'
  | 'client-teardown';
export type RemoteWindowInputDeliveryOutcomeExecutionV1 = 'confirmed' | 'not-dispatched' | 'unconfirmed';

/**
 * Client-local result of one reliable remote-window input delivery. This is the only settle result for a
 * reliable delivery record and is intentionally NOT part of `RemoteWindowControlMessage`, `ServerMessage`
 * or any shared wire union; it never travels on the wire.
 */
export interface RemoteWindowInputDeliveryOutcomeV1 {
  sequence: string;
  streamId: string;
  targetId: string;
  status: RemoteWindowInputDeliveryOutcomeStatusV1;
  source: RemoteWindowInputDeliveryOutcomeSourceV1;
  execution: RemoteWindowInputDeliveryOutcomeExecutionV1;
  error?: { code: string; message: string };
}

type RemoteWindowInputOutcomeSubscriber = (outcome: RemoteWindowInputDeliveryOutcomeV1) => void | Promise<unknown>;
type RemoteWindowListenerPhase = 'ice-candidate' | 'status' | 'input-outcome' | 'input-send';

// Daemon rejects these before any injection attempt, so a NACK carrying one of these codes proves zero submission.
const REMOTE_WINDOW_INPUT_NOT_DISPATCHED_NACK_CODES = new Set([
  'remote_window_input_delivery_invalid',
  'remote_window_input_stream_missing',
]);

export const REMOTE_WINDOW_TARGETS_REQUEST_TIMEOUT_MS = 15000;
export const REMOTE_WINDOW_STREAM_START_REQUEST_TIMEOUT_MS = 40_000;
export const REMOTE_WINDOW_STREAM_STOP_REQUEST_TIMEOUT_MS = 15_000;
export const REMOTE_WINDOW_STREAM_CLOSE_REQUEST_TIMEOUT_MS = 20_000;
export const REMOTE_WINDOW_STREAM_QUALITY_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Project the daemon-typed cleanup report from a stop status. Only an explicit `released` from the daemon is a
 * terminal success; an older server that reports no `cleanup` is an explicit `unverified`, never a manufactured
 * `released`. A `cleanup_failed`/`failed`/`unverified` report is preserved verbatim (remaining resources + errors).
 */
export function projectRemoteWindowCleanupResult(
  status: Pick<RemoteWindowStreamStatusPayload, 'phase' | 'cleanup'>,
): RemoteWindowStreamCleanupResult {
  const cleanup = status.cleanup;
  if (!cleanup) {
    return {
      status: 'unverified',
      remainingResources: [],
      errors: [{
        code: 'remote_window_cleanup_unreported',
        message: 'Daemon did not report remote resource cleanup for this stream',
      }],
    };
  }
  return {
    status: cleanup.status,
    remainingResources: [...cleanup.remainingResources],
    errors: cleanup.errors.map((error) => ({ ...error })),
  };
}

export function isRemoteWindowStreamCleanupReleased(cleanup: RemoteWindowStreamCleanupResult) {
  return cleanup.status === 'released';
}
export const REMOTE_WINDOW_INPUT_RELIABLE_MAX_ATTEMPTS = 2;
export const REMOTE_WINDOW_INPUT_RELIABLE_ACK_TIMEOUT_MS = 4_000;
// Action validity must outlive one ACK timeout, otherwise the single retry is always already expired.
export const REMOTE_WINDOW_INPUT_ACTION_DEADLINE_MS =
  REMOTE_WINDOW_INPUT_RELIABLE_ACK_TIMEOUT_MS * REMOTE_WINDOW_INPUT_RELIABLE_MAX_ATTEMPTS;
export const REMOTE_WINDOW_INPUT_SMOOTH_FLUSH_INTERVAL_MS = Math.ceil(1_000 / 45);

export function isRemoteWindowControlMessage(msg: ServerMessage): msg is RemoteWindowControlMessage {
  return msg.type === 'remote-window-targets-response'
    || msg.type === 'remote-window-stream-started'
    || msg.type === 'remote-window-stream-offer-v2'
    || msg.type === 'remote-window-stream-ice-candidate'
    || msg.type === 'remote-window-stream-status'
    || msg.type === 'remote-window-stream-focus-result'
    || msg.type === 'remote-window-stream-quality-result'
  || msg.type === 'remote-window-input-ack'
  || msg.type === 'remote-window-error'
  || msg.type === 'remote-window-browser-user-agent-result'
  || msg.type === 'remote-window-close-result';
}

function buildRemoteWindowError(payload: RemoteWindowStreamErrorPayload) {
  const message = payload.message || payload.code || 'remote window request failed';
  const error = new Error(message) as Error & {
    failureStage?: RemoteWindowStreamErrorPayload['failureStage'];
  };
  error.name = payload.code || 'remote_window_error';
  if (payload.failureStage) {
    error.failureStage = payload.failureStage;
  }
  return error;
}

export function createRemoteWindowMessageRuntime(input?: {
  timeoutMs?: number;
  setTimeoutFn?: typeof window.setTimeout;
  clearTimeoutFn?: typeof window.clearTimeout;
  now?: () => number;
  onStreamIceCandidate?: (payload: RemoteWindowStreamIceCandidatePayload) => void | Promise<unknown>;
  onStreamStatus?: (payload: RemoteWindowStreamStatusPayload) => void | Promise<unknown>;
  onListenerError?: (phase: RemoteWindowListenerPhase, error: unknown) => void;
}) {
  const pendingRequests = new Map<string, PendingRemoteWindowTargetsRequest>();
  const pendingStreamStarts = new Map<string, PendingRemoteWindowStreamStartRequest>();
  const pendingStreamStops = new Map<string, PendingRemoteWindowStreamStopRequest>();
  const pendingStreamCloses = new Map<string, PendingRemoteWindowStreamCloseRequest>();
  const pendingStreamQuality = new Map<string, PendingRemoteWindowStreamQualityRequest>();
  const pendingBrowserUserAgent = new Map<string, PendingRemoteWindowBrowserUserAgentRequest>();
  const pendingContinuousInput = new Map<string, PendingRemoteWindowContinuousInput>();
  const reliableInputQueue: PendingRemoteWindowReliableInput[] = [];
  let reliableInputInFlight: PendingRemoteWindowReliableInput | null = null;
  let reliableInputAckTimer: number | null = null;
  let continuousFlushTimer: number | null = null;
  let nextInputSequence = 1;
  const subscribers = new Set<RemoteWindowMessageSubscriber>();
  const inputOutcomeSubscribers = new Set<RemoteWindowInputOutcomeSubscriber>();
  const targetsTimeoutMs = input?.timeoutMs ?? REMOTE_WINDOW_TARGETS_REQUEST_TIMEOUT_MS;
  const streamStartTimeoutMs = input?.timeoutMs ?? REMOTE_WINDOW_STREAM_START_REQUEST_TIMEOUT_MS;
  const streamStopTimeoutMs = input?.timeoutMs ?? REMOTE_WINDOW_STREAM_STOP_REQUEST_TIMEOUT_MS;
  const streamCloseTimeoutMs = input?.timeoutMs ?? REMOTE_WINDOW_STREAM_CLOSE_REQUEST_TIMEOUT_MS;
  const streamQualityTimeoutMs = input?.timeoutMs ?? REMOTE_WINDOW_STREAM_QUALITY_REQUEST_TIMEOUT_MS;
  const setTimeoutFn = input?.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn = input?.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
  const now = input?.now ?? (() => Date.now());
  const dispatchListener = <TPayload,>(
    phase: RemoteWindowListenerPhase,
    handler: ((payload: TPayload) => void | Promise<unknown>) | undefined,
    payload: TPayload,
  ) => {
    if (!handler) {
      return false;
    }
    try {
      void Promise.resolve(handler(payload)).catch((error) => {
        input?.onListenerError?.(phase, error);
      });
    } catch (error) {
      input?.onListenerError?.(phase, error);
    }
    return true;
  };
  const notifyInputOutcomeSubscribers = (outcome: RemoteWindowInputDeliveryOutcomeV1) => {
    inputOutcomeSubscribers.forEach((handler) => {
      dispatchListener('input-outcome', handler, outcome);
    });
  };
  const notifySubscribers = (msg: RemoteWindowControlMessage) => {
    if (subscribers.size === 0) {
      return false;
    }
    subscribers.forEach((handler) => {
      dispatchListener('status', handler, msg);
    });
    return true;
  };

  const clearPendingTimeout = (pending: PendingRemoteWindowRequest) => {
    if (pending.timeoutId !== null) {
      clearTimeoutFn(pending.timeoutId);
      pending.timeoutId = null;
    }
  };

  const armPendingTimeout = (requestId: string) => {
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return false;
    }
    clearPendingTimeout(pending);
    pending.timeoutId = setTimeoutFn(() => {
      const activePending = pendingRequests.get(requestId);
      if (!activePending) {
        return;
      }
      pendingRequests.delete(requestId);
      activePending.timeoutId = null;
      activePending.reject(new Error('Remote window target catalog timed out'));
    }, targetsTimeoutMs) as unknown as number;
    return true;
  };

  const armPendingStreamTimeout = (requestId: string) => {
    const pending = pendingStreamStarts.get(requestId);
    if (!pending) {
      return false;
    }
    clearPendingTimeout(pending);
    pending.timeoutId = setTimeoutFn(() => {
      const activePending = pendingStreamStarts.get(requestId);
      if (!activePending) {
        return;
      }
      pendingStreamStarts.delete(requestId);
      activePending.timeoutId = null;
      activePending.reject(new Error('Remote window stream start timed out'));
    }, streamStartTimeoutMs) as unknown as number;
    return true;
  };

  const armPendingStreamStopTimeout = (requestId: string) => {
    const pending = pendingStreamStops.get(requestId);
    if (!pending) {
      return false;
    }
    clearPendingTimeout(pending);
    pending.timeoutId = setTimeoutFn(() => {
      const activePending = pendingStreamStops.get(requestId);
      if (!activePending) {
        return;
      }
      pendingStreamStops.delete(requestId);
      activePending.timeoutId = null;
      activePending.reject(new Error('Remote window stream stop timed out'));
    }, streamStopTimeoutMs) as unknown as number;
    return true;
  };

  const armPendingStreamQualityTimeout = (requestId: string) => {
    const pending = pendingStreamQuality.get(requestId);
    if (!pending) {
      return false;
    }
    clearPendingTimeout(pending);
    pending.timeoutId = setTimeoutFn(() => {
      const activePending = pendingStreamQuality.get(requestId);
      if (!activePending) {
        return;
      }
      pendingStreamQuality.delete(requestId);
      activePending.timeoutId = null;
      activePending.reject(new Error('Remote window stream quality timed out'));
    }, streamQualityTimeoutMs) as unknown as number;
    return true;
  };

  const armPendingStreamCloseTimeout = (requestId: string) => {
    const pending = pendingStreamCloses.get(requestId);
    if (!pending) {
      return false;
    }
    clearPendingTimeout(pending);
    pending.timeoutId = setTimeoutFn(() => {
      const activePending = pendingStreamCloses.get(requestId);
      if (!activePending) {
        return;
      }
      pendingStreamCloses.delete(requestId);
      activePending.timeoutId = null;
      activePending.reject(new Error('Remote window close result timed out'));
    }, streamCloseTimeoutMs) as unknown as number;
    return true;
  };

  const sendClientMessage = (
    sessionId: string,
    ws: BridgeTransportSocket,
    sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void,
    message: ClientMessage,
  ) => {
    sendSocketPayload(sessionId, ws, JSON.stringify(message));
  };

  const sendRemoteWindowInputMessage = (pending: PendingRemoteWindowReliableInput) => {
    pending.dispatchedToSocket = true;
    pending.control = {
      ...pending.control,
      sentAtMs: now(),
    };
    const message: RemoteWindowInputClientMessage = {
      type: 'remote-window-input',
      control: pending.control,
      payload: pending.payload,
    };
    sendClientMessage(pending.sessionId, pending.ws, pending.sendSocketPayload, message);
  };

  const clearReliableInputAckTimer = () => {
    if (reliableInputAckTimer !== null) {
      clearTimeoutFn(reliableInputAckTimer);
      reliableInputAckTimer = null;
    }
  };

  /**
   * The single settle exit for one reliable delivery record: remove it from pending state before emitting the
   * client-local outcome, so a repeated/late ACK can never settle the same `streamId + sequence` twice.
   */
  const settleReliableInput = (
    pending: PendingRemoteWindowReliableInput,
    result: {
      status: RemoteWindowInputDeliveryOutcomeStatusV1;
      source: RemoteWindowInputDeliveryOutcomeSourceV1;
      execution: RemoteWindowInputDeliveryOutcomeExecutionV1;
      error?: { code: string; message: string };
    },
  ) => {
    const queuedIndex = reliableInputQueue.indexOf(pending);
    const wasInFlight = reliableInputInFlight === pending;
    if (queuedIndex === -1 && !wasInFlight) {
      return false;
    }
    if (queuedIndex !== -1) {
      reliableInputQueue.splice(queuedIndex, 1);
    }
    if (wasInFlight) {
      clearReliableInputAckTimer();
      reliableInputInFlight = null;
    }
    notifyInputOutcomeSubscribers({
      sequence: pending.control.sequence,
      streamId: pending.payload.streamId,
      targetId: pending.payload.targetId,
      status: result.status,
      source: result.source,
      execution: result.execution,
      ...(result.error ? { error: result.error } : {}),
    });
    return true;
  };

  const retryReliableInput = (pending: PendingRemoteWindowReliableInput) => {
    pending.control = {
      ...pending.control,
      attempt: pending.control.attempt + 1,
      sentAtMs: now(),
    };
    sendReliableInput(pending);
  };

  const sendReliableInput = (pending: PendingRemoteWindowReliableInput, immediateSequence?: string) => {
    try {
      sendRemoteWindowInputMessage(pending);
    } catch (error) {
      settleReliableInput(pending, {
        status: 'failed',
        source: 'client-send',
        execution: 'unconfirmed',
        error: {
          code: 'remote_window_input_send_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      });
      if (pending.control.sequence === immediateSequence) {
        throw error;
      }
      pumpReliableInput();
      return;
    }
    if (reliableInputInFlight === pending) {
      armReliableInputAckTimeout(pending);
    }
  };

  const armReliableInputAckTimeout = (pending: PendingRemoteWindowReliableInput) => {
    clearReliableInputAckTimer();
    reliableInputAckTimer = setTimeoutFn(() => {
      reliableInputAckTimer = null;
      if (reliableInputInFlight !== pending) {
        return;
      }
      if (pending.control.attempt < REMOTE_WINDOW_INPUT_RELIABLE_MAX_ATTEMPTS) {
        retryReliableInput(pending);
        return;
      }
      settleReliableInput(pending, {
        status: 'failed',
        source: 'client-timeout',
        execution: 'unconfirmed',
        error: {
          code: 'remote_window_input_ack_timeout',
          message: 'Remote window input ACK timed out',
        },
      });
      pumpReliableInput();
    }, REMOTE_WINDOW_INPUT_RELIABLE_ACK_TIMEOUT_MS) as unknown as number;
  };

  const clearContinuousFlushTimer = () => {
    if (continuousFlushTimer !== null) {
      clearTimeoutFn(continuousFlushTimer);
      continuousFlushTimer = null;
    }
  };

  const flushContinuousInput = (_force = false) => {
    clearContinuousFlushTimer();
    const pendingKeys = [...pendingContinuousInput.keys()];
    pendingKeys.forEach((key) => {
      const sample = pendingContinuousInput.get(key);
      if (!sample) return;
      pendingContinuousInput.delete(key);
      try {
        sendRemoteWindowInputMessage(sample);
      } catch (error) {
        // Continuous samples are best-effort and never produce a reliable outcome; surface the send failure
        // through the typed listener-error channel instead of fabricating a daemon ACK.
        input?.onListenerError?.('input-send', error);
      }
    });
    return pendingKeys.length > 0;
  };

  const pumpReliableInput = (immediateSequence?: string) => {
    if (reliableInputInFlight) {
      return;
    }
    const next = reliableInputQueue.shift();
    if (!next) {
      flushContinuousInput();
      return;
    }
    reliableInputInFlight = next;
    flushContinuousInput(true);
    if (reliableInputInFlight === next) {
      sendReliableInput(next, immediateSequence);
    }
  };

  const scheduleContinuousInputFlush = () => {
    if (continuousFlushTimer !== null || reliableInputQueue.length > 0) {
      return;
    }
    continuousFlushTimer = setTimeoutFn(() => {
      continuousFlushTimer = null;
      flushContinuousInput();
    }, REMOTE_WINDOW_INPUT_SMOOTH_FLUSH_INTERVAL_MS) as unknown as number;
  };

  const buildInputSequence = () => `rw-input-${now()}-${nextInputSequence++}`;

  const enqueueRemoteWindowInput = (pending: Omit<PendingRemoteWindowReliableInput, 'control'>) => {
    const event = pending.payload.event;
    const continuous = event.kind === 'scroll' || (event.kind === 'pointer' && event.phase === 'move');
    const sampledAtMs = pending.payload.sampledAtMs ?? now();
    const payload: RemoteWindowInputEventPayload = {
      ...pending.payload,
      deliveryKind: continuous ? 'sample' : 'action',
      sampledAtMs,
      ...(continuous ? {} : {
        deadlineMs: pending.payload.deadlineMs ?? sampledAtMs + REMOTE_WINDOW_INPUT_ACTION_DEADLINE_MS,
      }),
    };
    const control: RemoteWindowInputDeliveryControl = {
      version: 1,
      sequence: buildInputSequence(),
      lane: continuous ? 'continuous' : 'reliable',
      attempt: 1,
      sentAtMs: now(),
    };
    if (!continuous) {
      reliableInputQueue.push({ ...pending, payload, control });
      pumpReliableInput(control.sequence);
      return control.sequence;
    }
    const key = [
      pending.sessionId,
      pending.payload.streamId,
      pending.payload.targetId,
      pending.payload.layoutGeneration ?? '',
      event.kind,
    ].join('|');
    const existing = pendingContinuousInput.get(key);
    const mergedPayload = existing && event.kind === 'scroll' && existing.payload.event.kind === 'scroll'
      ? {
          ...payload,
          event: {
            ...event,
            deltaX: (existing.payload.event.deltaX ?? 0) + (event.deltaX ?? 0),
            deltaY: (existing.payload.event.deltaY ?? 0) + (event.deltaY ?? 0),
          },
        }
      : payload;
    pendingContinuousInput.set(key, {
      ...pending,
      payload: mergedPayload,
      control: { ...control, lane: 'continuous' },
    });
    scheduleContinuousInputFlush();
    return control.sequence;
  };

  const acceptRemoteWindowInputAck = (
    message: Extract<RemoteWindowControlMessage, { type: 'remote-window-input-ack' }>,
  ) => {
    const control = message.control;
    const inFlight = reliableInputInFlight;
    const carriesGeometry = Boolean(message.payload.target || message.payload.capture);
    if (!inFlight || inFlight.control.sequence !== control.sequence) {
      return notifySubscribers(message);
    }
    if (message.payload.streamId !== inFlight.payload.streamId
      || message.payload.targetId !== inFlight.payload.targetId
      || (carriesGeometry && inFlight.payload.event.kind !== 'window-resize')
      || (message.payload.target && message.payload.target.streamTargetId !== inFlight.payload.targetId)) {
      return false;
    }
    clearReliableInputAckTimer();
    if (
      !control.accepted
      && control.retryable
      && inFlight.control.attempt < REMOTE_WINDOW_INPUT_RELIABLE_MAX_ATTEMPTS
    ) {
      retryReliableInput(inFlight);
      return true;
    }
    const nackCode = control.accepted ? undefined : control.error?.code;
    settleReliableInput(inFlight, {
      status: control.accepted ? 'delivered' : 'failed',
      source: 'daemon-ack',
      execution: control.accepted
        ? 'confirmed'
        : (nackCode && REMOTE_WINDOW_INPUT_NOT_DISPATCHED_NACK_CODES.has(nackCode)
          ? 'not-dispatched'
          : 'unconfirmed'),
      ...(control.accepted || !control.error
        ? {}
        : { error: { code: control.error.code, message: control.error.message } }),
    });
    notifySubscribers(message);
    pumpReliableInput();
    return true;
  };

  const settleReliableInputAsCancelled = (pending: PendingRemoteWindowReliableInput) => {
    settleReliableInput(pending, {
      status: 'cancelled',
      source: 'client-teardown',
      execution: pending.dispatchedToSocket ? 'unconfirmed' : 'not-dispatched',
    });
  };

  const cancelStreamInput = (streamId: string) => {
    [...reliableInputQueue]
      .filter((pending) => pending.payload.streamId === streamId)
      .forEach((pending) => settleReliableInputAsCancelled(pending));
    if (reliableInputInFlight?.payload.streamId === streamId) {
      settleReliableInputAsCancelled(reliableInputInFlight);
    }
    for (const [key, pending] of pendingContinuousInput) {
      if (pending.payload.streamId === streamId) {
        pendingContinuousInput.delete(key);
      }
    }
    if (pendingContinuousInput.size === 0) {
      clearContinuousFlushTimer();
    }
    pumpReliableInput();
  };

  const cancelSessionInput = (sessionId: string) => {
    [...reliableInputQueue]
      .filter((pending) => pending.sessionId === sessionId)
      .forEach((pending) => settleReliableInputAsCancelled(pending));
    if (reliableInputInFlight?.sessionId === sessionId) {
      settleReliableInputAsCancelled(reliableInputInFlight);
    }
    for (const [key, pending] of pendingContinuousInput) {
      if (pending.sessionId === sessionId) {
        pendingContinuousInput.delete(key);
      }
    }
    if (pendingContinuousInput.size === 0) {
      clearContinuousFlushTimer();
    }
    pumpReliableInput();
  };

  const runtime = {
    requestTargets(sessionId: string, options: {
      ws: BridgeTransportSocket;
      request?: Omit<RemoteWindowStreamRequestPayload, 'requestId'>;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    }) {
      const targetSessionId = sessionId.trim();
      if (!targetSessionId) {
        throw new Error('No target session for remote window catalog');
      }
      const requestId = `rw-${now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<RemoteWindowStreamTargetsResponsePayload>((resolve, reject) => {
        const pending: PendingRemoteWindowTargetsRequest = {
          kind: 'targets',
          timeoutId: null,
          resolve,
          reject,
        };
        pendingRequests.set(requestId, pending);
        armPendingTimeout(requestId);

        try {
          const payload: RemoteWindowStreamRequestPayload = {
            requestId,
            includeAppWindows: options.request?.includeAppWindows ?? true,
            includeIterm2: options.request?.includeIterm2 ?? true,
          };
          sendClientMessage(targetSessionId, options.ws, options.sendSocketPayload, {
            type: 'remote-window-targets-request',
            payload,
          });
        } catch (error) {
          pendingRequests.delete(requestId);
          clearPendingTimeout(pending);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    requestStreamStart(sessionId: string, options: {
      ws: BridgeTransportSocket;
      streamId: string;
      revision?: number;
      target: RemoteWindowStreamTargetManifest;
      purpose?: RemoteWindowStreamPurpose;
      mediaPlan: RemoteWindowStreamStartRequestV2Payload['mediaPlan'];
      mediaPlanVersion: 2;
      iceServers?: Array<Record<string, unknown>>;
      videoProfile: RemoteWindowVideoProfile;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    }) {
      const targetSessionId = sessionId.trim();
      if (!targetSessionId) {
        throw new Error('No target session for remote window stream');
      }
      const streamId = options.streamId.trim();
      if (!streamId) {
        throw new Error('Remote window stream start requires streamId');
      }
      const requestId = `rw-start-${now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<RemoteWindowStreamStartedPayload | RemoteWindowStreamStartedOfferV2Payload>((resolve, reject) => {
        const pending: PendingRemoteWindowStreamStartRequest = {
          kind: 'stream-start',
          streamId,
          timeoutId: null,
          resolve,
          reject,
        };
        pendingStreamStarts.set(requestId, pending);
        armPendingStreamTimeout(requestId);

        try {
          sendClientMessage(targetSessionId, options.ws, options.sendSocketPayload, {
            type: 'remote-window-stream-start-v2-request',
            payload: {
              requestId,
              streamId,
              ...(options.purpose ? { purpose: options.purpose } : {}),
              mediaPlan: options.mediaPlan,
              mediaPlanVersion: 2,
              target: options.target,
              ...(options.iceServers ? { iceServers: options.iceServers } : {}),
              videoProfile: options.videoProfile,
            } satisfies RemoteWindowStreamStartRequestV2Payload,
          });
        } catch (error) {
          pendingStreamStarts.delete(requestId);
          clearPendingTimeout(pending);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    sendStreamAnswerV2(sessionId: string, options: {
      ws: BridgeTransportSocket;
      payload: RemoteWindowStreamAnswerV2Payload;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    }) {
      const targetSessionId = sessionId.trim();
      if (!targetSessionId || !options.payload.streamId || !options.payload.requestId) {
        throw new Error('Remote window v2 answer requires sessionId, streamId, and requestId');
      }
      sendClientMessage(targetSessionId, options.ws, options.sendSocketPayload, {
        type: 'remote-window-stream-answer-v2',
        payload: options.payload,
      });
    },

    sendStreamQuality(sessionId: string, options: {
      ws: BridgeTransportSocket;
      payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    }) {
      const targetSessionId = sessionId.trim();
      const streamId = options.payload.streamId.trim();
      const targetId = options.payload.targetId.trim();
      if (!targetSessionId || !streamId || !targetId) {
        throw new Error('Remote window stream quality requires sessionId, streamId, and targetId');
      }
      const requestId = `rw-quality-${now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<RemoteWindowStreamQualityResultPayload>((resolve, reject) => {
        const pending: PendingRemoteWindowStreamQualityRequest = {
          kind: 'stream-quality',
          streamId,
          streamGroupId: options.payload.streamGroupId,
          revision: options.payload.revision,
          timeoutId: null,
          resolve,
          reject,
        };
        pendingStreamQuality.set(requestId, pending);
        armPendingStreamQualityTimeout(requestId);
        try {
          sendClientMessage(targetSessionId, options.ws, options.sendSocketPayload, {
            type: 'remote-window-stream-quality-request',
            payload: {
              ...options.payload,
              streamId,
              targetId,
              requestId,
            },
          });
        } catch (error) {
          pendingStreamQuality.delete(requestId);
          clearPendingTimeout(pending);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    sendBrowserUserAgent(sessionId: string, options: {
      ws: BridgeTransportSocket;
      target: RemoteWindowStreamTargetManifest;
      userAgent: RemoteWindowBrowserUserAgent;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    }) {
      const targetSessionId = sessionId.trim();
      if (!targetSessionId || !options.target.streamTargetId) {
        throw new Error('Browser user-agent requires sessionId and target');
      }
      const requestId = `rw-browser-ua-${now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<RemoteWindowBrowserUserAgentResultPayload>((resolve, reject) => {
        const timeoutId = setTimeoutFn(() => {
          pendingBrowserUserAgent.delete(requestId);
          reject(new Error('Browser user-agent request timed out'));
        }, streamQualityTimeoutMs) as unknown as number;
        pendingBrowserUserAgent.set(requestId, { timeoutId, resolve, reject });
        try {
          sendClientMessage(targetSessionId, options.ws, options.sendSocketPayload, {
            type: 'remote-window-browser-user-agent-request',
            payload: { requestId, target: options.target, userAgent: options.userAgent },
          });
        } catch (error) {
          pendingBrowserUserAgent.delete(requestId);
          clearTimeoutFn(timeoutId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    sendStreamUpdateFocus(sessionId: string, options: {
      ws: BridgeTransportSocket;
      streamId: string;
      revision?: number;
      target: RemoteWindowStreamTargetManifest;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    }) {
      const targetSessionId = sessionId.trim();
      const streamId = options.streamId.trim();
      if (!targetSessionId || !streamId) {
        throw new Error('Remote window stream update focus requires sessionId and streamId');
      }
      sendClientMessage(targetSessionId, options.ws, options.sendSocketPayload, {
        type: 'remote-window-stream-update-focus',
        payload: {
          requestId: `rw-focus-${now()}-${Math.random().toString(36).slice(2, 8)}`,
          streamId,
          revision: options.revision ?? 1,
          target: options.target,
        },
      });
    },

    sendStreamIceCandidate(sessionId: string, options: {
      ws: BridgeTransportSocket;
      streamId: string;
      requestId?: string;
      purpose?: RemoteWindowStreamPurpose;
      candidate: RemoteWindowStreamIceCandidate;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    }) {
      const targetSessionId = sessionId.trim();
      const streamId = options.streamId.trim();
      if (!targetSessionId || !streamId) {
        throw new Error('Remote window stream candidate requires sessionId and streamId');
      }
      sendClientMessage(targetSessionId, options.ws, options.sendSocketPayload, {
        type: 'remote-window-stream-ice-candidate',
        payload: {
          streamId,
          ...(options.requestId ? { requestId: options.requestId } : {}),
          ...(options.purpose ? { purpose: options.purpose } : {}),
          candidate: options.candidate,
        },
      });
    },

    stopStream(sessionId: string, options: {
      ws: BridgeTransportSocket;
      streamId: string;
      purpose?: RemoteWindowStreamPurpose;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    }) {
      const targetSessionId = sessionId.trim();
      const streamId = options.streamId.trim();
      if (!targetSessionId || !streamId) {
        throw new Error('Remote window stream stop requires sessionId and streamId');
      }
      const requestId = `rw-stop-${now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Close this stream's client input admission and settle every queued/in-flight record before the stop request.
      cancelStreamInput(streamId);
      return new Promise<RemoteWindowStreamStatusPayload>((resolve, reject) => {
        const pending: PendingRemoteWindowStreamStopRequest = {
          kind: 'stream-stop',
          streamId,
          timeoutId: null,
          resolve,
          reject,
        };
        pendingStreamStops.set(requestId, pending);
        armPendingStreamStopTimeout(requestId);

        try {
          sendClientMessage(targetSessionId, options.ws, options.sendSocketPayload, {
            type: 'remote-window-stream-stop-request',
            payload: {
              requestId,
              streamId,
              ...(options.purpose ? { purpose: options.purpose } : {}),
            },
          });
        } catch (error) {
          pendingStreamStops.delete(requestId);
          clearPendingTimeout(pending);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    requestStreamClose(sessionId: string, options: {
      ws: BridgeTransportSocket;
      streamId: string;
      targetId: string;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    }) {
      const targetSessionId = sessionId.trim();
      const streamId = options.streamId.trim();
      const targetId = options.targetId.trim();
      if (!targetSessionId || !streamId || !targetId) {
        throw new Error('Remote window close requires sessionId, streamId, and targetId');
      }
      const requestId = `rw-close-${now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<RemoteWindowCloseResultPayload>((resolve, reject) => {
        const pending: PendingRemoteWindowStreamCloseRequest = {
          kind: 'stream-close',
          sessionId: targetSessionId,
          streamId,
          targetId,
          timeoutId: null,
          resolve,
          reject,
        };
        pendingStreamCloses.set(requestId, pending);
        armPendingStreamCloseTimeout(requestId);

        try {
          const payload: RemoteWindowCloseRequestPayload = {
            requestId,
            sessionId: targetSessionId,
            streamId,
            targetId,
          };
          sendClientMessage(targetSessionId, options.ws, options.sendSocketPayload, {
            type: 'remote-window-close-request',
            payload,
          });
        } catch (error) {
          pendingStreamCloses.delete(requestId);
          clearPendingTimeout(pending);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    sendInputEvent(sessionId: string, options: {
      ws: BridgeTransportSocket;
      payload: RemoteWindowInputEventPayload;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    }) {
      const targetSessionId = sessionId.trim();
      const streamId = options.payload.streamId.trim();
      if (!targetSessionId || !streamId || !options.payload.targetId.trim()) {
        throw new Error('Remote window input requires sessionId, streamId, and targetId');
      }
      return enqueueRemoteWindowInput({
        sessionId: targetSessionId,
        ws: options.ws,
        payload: {
          ...options.payload,
          streamId,
          targetId: options.payload.targetId.trim(),
        },
        sendSocketPayload: options.sendSocketPayload,
      });
    },

    sendWindowResizeEvent(sessionId: string, options: {
      ws: BridgeTransportSocket;
      payload: RemoteWindowInputEventPayload;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    }) {
      const targetSessionId = sessionId.trim();
      const streamId = options.payload.streamId.trim();
      if (
        !targetSessionId
        || !streamId
        || !options.payload.targetId.trim()
        || options.payload.event.kind !== 'window-resize'
      ) {
        throw new Error('Remote window resize requires sessionId, streamId, targetId, and window-resize event');
      }
      return enqueueRemoteWindowInput({
        sessionId: targetSessionId,
        ws: options.ws,
        payload: {
          ...options.payload,
          streamId,
          targetId: options.payload.targetId.trim(),
        },
        sendSocketPayload: options.sendSocketPayload,
      });
    },

    handleTargetsResponse(payload: RemoteWindowStreamTargetsResponsePayload) {
      const pending = pendingRequests.get(payload.requestId);
      if (!pending) {
        return false;
      }
      pendingRequests.delete(payload.requestId);
      clearPendingTimeout(pending);
      pending.resolve(payload);
      return true;
    },

    handleStreamStarted(payload: RemoteWindowStreamStartedPayload) {
      const pending = pendingStreamStarts.get(payload.requestId);
      if (!pending || pending.streamId !== payload.streamId) {
        return false;
      }
      pendingStreamStarts.delete(payload.requestId);
      clearPendingTimeout(pending);
      pending.resolve(payload);
      return true;
    },

    handleStreamOfferV2(payload: RemoteWindowStreamStartedOfferV2Payload) {
      const pending = pendingStreamStarts.get(payload.requestId);
      if (!pending || pending.streamId !== payload.streamId) {
        return false;
      }
      pendingStreamStarts.delete(payload.requestId);
      clearPendingTimeout(pending);
      pending.resolve(payload);
      return true;
    },

    handleError(payload: RemoteWindowStreamErrorPayload) {
      const pending = pendingRequests.get(payload.requestId);
      if (pending) {
        pendingRequests.delete(payload.requestId);
        clearPendingTimeout(pending);
        pending.reject(buildRemoteWindowError(payload));
        return true;
      }
      const streamPending = pendingStreamStarts.get(payload.requestId);
      if (streamPending && (!payload.streamId || payload.streamId === streamPending.streamId)) {
        pendingStreamStarts.delete(payload.requestId);
        clearPendingTimeout(streamPending);
        streamPending.reject(buildRemoteWindowError(payload));
        return true;
      }
      const stopPending = pendingStreamStops.get(payload.requestId);
      if (stopPending && (!payload.streamId || payload.streamId === stopPending.streamId)) {
        pendingStreamStops.delete(payload.requestId);
        clearPendingTimeout(stopPending);
        stopPending.reject(buildRemoteWindowError(payload));
        return true;
      }
      const closePending = pendingStreamCloses.get(payload.requestId);
      if (closePending && (!payload.streamId || payload.streamId === closePending.streamId)) {
        pendingStreamCloses.delete(payload.requestId);
        clearPendingTimeout(closePending);
        closePending.reject(buildRemoteWindowError(payload));
        return true;
      }
      const qualityPending = pendingStreamQuality.get(payload.requestId);
      if (qualityPending && (!payload.streamId || payload.streamId === qualityPending.streamId)) {
        pendingStreamQuality.delete(payload.requestId);
        clearPendingTimeout(qualityPending);
        qualityPending.reject(buildRemoteWindowError(payload));
        return true;
      }
      return false;
    },

    dispatch(msg: RemoteWindowControlMessage) {
      if (msg.type === 'remote-window-targets-response') {
        return runtime.handleTargetsResponse(msg.payload);
      }
      if (msg.type === 'remote-window-stream-started') {
        return runtime.handleStreamStarted(msg.payload);
      }
      if (msg.type === 'remote-window-stream-offer-v2') {
        return runtime.handleStreamOfferV2(msg.payload);
      }
      if (msg.type === 'remote-window-stream-ice-candidate') {
        return dispatchListener('ice-candidate', input?.onStreamIceCandidate, msg.payload);
      }
      if (msg.type === 'remote-window-stream-status') {
        if (msg.payload.requestId) {
          const pending = pendingStreamStops.get(msg.payload.requestId);
          if (pending && pending.streamId === msg.payload.streamId) {
            pendingStreamStops.delete(msg.payload.requestId);
            clearPendingTimeout(pending);
            pending.resolve(msg.payload);
            notifySubscribers(msg);
            return true;
          }
        }
        const handled = dispatchListener('status', input?.onStreamStatus, msg.payload);
        const observed = notifySubscribers(msg);
        return handled || observed;
      }
      if (msg.type === 'remote-window-close-result') {
        const pending = pendingStreamCloses.get(msg.payload.requestId);
        let handled = false;
        if (
          pending
          && pending.sessionId === msg.payload.sessionId
          && pending.streamId === msg.payload.streamId
          && pending.targetId === msg.payload.targetId
        ) {
          handled = true;
          pendingStreamCloses.delete(msg.payload.requestId);
          clearPendingTimeout(pending);
          pending.resolve(msg.payload);
        }
        const observed = notifySubscribers(msg);
        return handled || observed;
      }
      if (msg.type === 'remote-window-stream-quality-result') {
        const pending = pendingStreamQuality.get(msg.payload.requestId);
        let handled = false;
        if (
          pending
          && pending.streamId === msg.payload.streamId
          && pending.streamGroupId === msg.payload.streamGroupId
          && pending.revision === msg.payload.revision
        ) {
          handled = true;
          pendingStreamQuality.delete(msg.payload.requestId);
          clearPendingTimeout(pending);
          if (msg.payload.status === 'applied') {
            pending.resolve(msg.payload);
          } else {
            const error = new Error(msg.payload.error?.message || 'Remote window stream quality rejected');
            error.name = msg.payload.error?.code || 'remote_window_stream_quality_rejected';
            pending.reject(error);
          }
        }
        const observed = notifySubscribers(msg);
        return handled || observed;
      }
      if (msg.type === 'remote-window-stream-focus-result') {
        return notifySubscribers(msg);
      }
      if (msg.type === 'remote-window-input-ack') {
        return acceptRemoteWindowInputAck(msg);
      }
      if (msg.type === 'remote-window-browser-user-agent-result') {
        const pending = pendingBrowserUserAgent.get(msg.payload.requestId);
        if (pending) {
          pendingBrowserUserAgent.delete(msg.payload.requestId);
          if (pending.timeoutId !== null) clearTimeoutFn(pending.timeoutId);
          if (msg.payload.status === 'applied') pending.resolve(msg.payload);
          else {
            const error = new Error(msg.payload.error?.message || 'Browser user-agent rejected');
            error.name = msg.payload.error?.code || 'remote_window_browser_cdp_failed';
            pending.reject(error);
          }
        }
        return notifySubscribers(msg) || Boolean(pending);
      }
      const handled = runtime.handleError(msg.payload);
      const observed = notifySubscribers(msg);
      return handled || observed;
    },

    subscribe(handler: RemoteWindowMessageSubscriber) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    subscribeInputOutcome(handler: RemoteWindowInputOutcomeSubscriber) {
      inputOutcomeSubscribers.add(handler);
      return () => {
        inputOutcomeSubscribers.delete(handler);
      };
    },

    /**
     * Settle reliable input that can no longer be delivered because its physical transport is gone.
     * The real per-session transport close owner is outside this runtime; callers pass the owning sessionId.
     */
    teardownTransport(sessionId: string, _reason = 'Remote window transport torn down') {
      const targetSessionId = sessionId.trim();
      if (!targetSessionId) {
        return;
      }
      cancelSessionInput(targetSessionId);
    },

    dispose(reason = 'Session provider disposed before remote window request completed') {
      for (const pending of pendingRequests.values()) {
        clearPendingTimeout(pending);
        pending.reject(new Error(reason));
      }
      pendingRequests.clear();
      for (const pending of pendingStreamStarts.values()) {
        clearPendingTimeout(pending);
        pending.reject(new Error(reason));
      }
      pendingStreamStarts.clear();
      for (const pending of pendingStreamStops.values()) {
        clearPendingTimeout(pending);
        pending.reject(new Error(reason));
      }
      pendingStreamStops.clear();
      for (const pending of pendingStreamCloses.values()) {
        clearPendingTimeout(pending);
        pending.reject(new Error(reason));
      }
      pendingStreamCloses.clear();
      for (const pending of pendingStreamQuality.values()) {
        clearPendingTimeout(pending);
        pending.reject(new Error(reason));
      }
      pendingStreamQuality.clear();
      for (const pending of pendingBrowserUserAgent.values()) {
        if (pending.timeoutId !== null) clearTimeoutFn(pending.timeoutId);
        pending.reject(new Error(reason));
      }
      pendingBrowserUserAgent.clear();
      // Settle queued/in-flight reliable input (notifying still-registered consumers) before clearing
      // timers and subscriptions.
      [...reliableInputQueue].forEach((pending) => settleReliableInputAsCancelled(pending));
      if (reliableInputInFlight) {
        settleReliableInputAsCancelled(reliableInputInFlight);
      }
      clearContinuousFlushTimer();
      pendingContinuousInput.clear();
      clearReliableInputAckTimer();
      reliableInputQueue.splice(0);
      reliableInputInFlight = null;
      subscribers.clear();
      inputOutcomeSubscribers.clear();
    },

    getPendingCount() {
      return pendingRequests.size + pendingStreamStarts.size + pendingStreamStops.size + pendingStreamCloses.size + pendingStreamQuality.size + pendingBrowserUserAgent.size;
    },

    getPendingRequestIds() {
      return [...pendingRequests.keys(), ...pendingStreamStarts.keys(), ...pendingStreamStops.keys(), ...pendingStreamCloses.keys(), ...pendingStreamQuality.keys(), ...pendingBrowserUserAgent.keys()];
    },
  };

  return runtime;
}

export type RemoteWindowMessageRuntime = ReturnType<typeof createRemoteWindowMessageRuntime>;
