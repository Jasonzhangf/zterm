import type {
  BridgeServerMessage as ServerMessage,
} from '@zterm/shared/protocol';
import type {
  TerminalPerformanceTraceRecord,
} from '@zterm/shared/terminal/performance-trace';
import {
  TERMINAL_BUFFER_SYNC_FRAME_MAX_SPAN_LINES,
  TERMINAL_BUFFER_SYNC_MESSAGE_MAX_BYTES,
} from '@zterm/shared/types';
import {
  splitBufferSyncPayloadMessages,
} from './terminal-buffer-sync-wire';
import { readTerminalTransportBackpressureSnapshot } from './terminal-transport-runtime';
import type {
  SessionMirror,
  TerminalAbsoluteRange,
  TerminalSession,
  TerminalSessionTransport,
  TerminalSubscriberBufferSyncResyncReason,
  TerminalSubscriberBufferSyncState,
} from './terminal-runtime-types';
import type { TerminalBufferPayload } from '@zterm/shared/types';

const SUBSCRIBER_PENDING_RANGE_LIMIT = 64;
const SUBSCRIBER_PENDING_SPAN_LINE_LIMIT = TERMINAL_BUFFER_SYNC_FRAME_MAX_SPAN_LINES;
const SUBSCRIBER_PENDING_AGE_LIMIT_MS = 15_000;
const SUBSCRIBER_BUFFER_SYNC_MAX_BYTES = TERMINAL_BUFFER_SYNC_MESSAGE_MAX_BYTES;
const MAX_SYNC_CHUNKS_PER_FLUSH = 2;

export interface DaemonBufferPublisherDeps {
  sessions: Map<string, TerminalSession>;
  sendMessage: (session: TerminalSession, message: ServerMessage) => void;
  sendText: (
    transport: TerminalSessionTransport | null | undefined,
    text: string,
  ) => void;
  recordPerformanceTrace?: (record: TerminalPerformanceTraceRecord) => void;
  buildBufferHeadPayload: (
    sessionId: string,
    mirror: SessionMirror,
  ) => Extract<ServerMessage, { type: 'buffer-head' }>['payload'];
  buildChangedRangesBufferSyncPayload: (
    mirror: SessionMirror,
    changedRanges: Array<{ startIndex: number; endIndex: number }>,
  ) => Extract<ServerMessage, { type: 'buffer-sync' }>['payload'] | null;
  ensureSessionReady: (session: TerminalSession, mirror: SessionMirror) => void;
  buildRequestedRangeBufferPayload: (
    mirror: SessionMirror,
    request: import('@zterm/shared/types').BufferSyncRequestPayload,
  ) => TerminalBufferPayload;
}

export interface DaemonBufferPublisherRuntime {
  broadcastBufferHeadToSubscribers(mirror: SessionMirror): void;
  broadcastChangedRangesBufferSyncToSubscribers(
    mirror: SessionMirror,
    changedRanges: Array<{ startIndex: number; endIndex: number }>,
  ): void;
  flushPendingSubscriberBufferSync(
    mirror: SessionMirror,
    sessionId: string,
  ): 'sent'
    | 'no-pending'
    | 'missing-subscriber'
    | 'transport-not-open'
    | 'backpressured'
    | 'send-error'
    | 'stale-transport';
  flushPendingBufferSyncToSubscribers(mirror: SessionMirror): void;
  sendBufferHeadToSession(session: TerminalSession, mirror: SessionMirror): void;
  enqueueRangeBufferSyncResponse(
    session: TerminalSession,
    mirror: SessionMirror,
    request: import('@zterm/shared/types').BufferSyncRequestPayload,
  ): 'queued' | 'missing-subscriber' | 'transport-not-open';
}

export function createDaemonBufferPublisherRuntime(
  deps: DaemonBufferPublisherDeps,
): DaemonBufferPublisherRuntime {
  const sessions = deps.sessions;
  const mirrorHeadBroadcastCache = new WeakMap<SessionMirror, { revision: number }>();

  function createSubscriberBufferSyncState(): TerminalSubscriberBufferSyncState {
    return {
      lastSentRevision: 0,
      pendingLatestRevision: null,
      pendingChangedAbsoluteRanges: [],
      pendingSince: 0,
      pendingTransportId: null,
      highWaterActive: false,
      highWaterEnteredAt: 0,
      resyncRequired: false,
      resyncReason: null,
      pendingRangeResponses: [],
    };
  }

  function ensureSubscriberBufferSyncState(session: TerminalSession) {
    if (!session.bufferSyncState) {
      session.bufferSyncState = createSubscriberBufferSyncState();
    }
    return session.bufferSyncState;
  }

  function normalizeAbsoluteRanges(ranges: TerminalAbsoluteRange[]) {
    return ranges
      .map((range) => ({
        startIndex: Math.max(0, Math.floor(range.startIndex || 0)),
        endIndex: Math.max(0, Math.floor(range.endIndex || 0)),
      }))
      .filter((range) => range.endIndex > range.startIndex)
      .sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex);
  }

  function mergeAbsoluteRanges(ranges: TerminalAbsoluteRange[]) {
    const normalized = normalizeAbsoluteRanges(ranges);
    const merged: TerminalAbsoluteRange[] = [];
    for (const range of normalized) {
      const previous = merged[merged.length - 1];
      if (previous && range.startIndex <= previous.endIndex) {
        previous.endIndex = Math.max(previous.endIndex, range.endIndex);
        continue;
      }
      merged.push({ ...range });
    }
    return merged;
  }

  function collapseRangesToSpan(ranges: TerminalAbsoluteRange[]) {
    const normalized = normalizeAbsoluteRanges(ranges);
    if (normalized.length === 0) {
      return [];
    }
    return [{
      startIndex: normalized[0]!.startIndex,
      endIndex: normalized[normalized.length - 1]!.endIndex,
    }];
  }

  function pendingSpanLineCount(ranges: TerminalAbsoluteRange[]) {
    const normalized = normalizeAbsoluteRanges(ranges);
    if (normalized.length === 0) {
      return 0;
    }
    return normalized[normalized.length - 1]!.endIndex - normalized[0]!.startIndex;
  }

  function markSubscriberBufferSyncResyncRequired(
    state: TerminalSubscriberBufferSyncState,
    reason: TerminalSubscriberBufferSyncResyncReason,
    collapseToSpan: boolean,
  ) {
    state.resyncRequired = true;
    state.resyncReason = reason;
    if (collapseToSpan) {
      state.pendingChangedAbsoluteRanges = collapseRangesToSpan(state.pendingChangedAbsoluteRanges);
    }
  }

  function validateSubscriberPendingBounds(state: TerminalSubscriberBufferSyncState, now = Date.now()) {
    if (state.pendingChangedAbsoluteRanges.length > SUBSCRIBER_PENDING_RANGE_LIMIT) {
      markSubscriberBufferSyncResyncRequired(state, 'range-count', true);
      return;
    }
    if (pendingSpanLineCount(state.pendingChangedAbsoluteRanges) > SUBSCRIBER_PENDING_SPAN_LINE_LIMIT) {
      markSubscriberBufferSyncResyncRequired(state, 'span-lines', true);
      return;
    }
    if (
      state.pendingSince > 0
      && now - state.pendingSince > SUBSCRIBER_PENDING_AGE_LIMIT_MS
    ) {
      markSubscriberBufferSyncResyncRequired(state, 'age', false);
    }
  }

  function queueSubscriberPendingBufferSync(
    session: TerminalSession,
    mirror: SessionMirror,
    changedRanges: TerminalAbsoluteRange[],
    now = Date.now(),
  ) {
    const state = ensureSubscriberBufferSyncState(session);
    const nextRanges = mergeAbsoluteRanges([
      ...state.pendingChangedAbsoluteRanges,
      ...changedRanges,
    ]);
    if (nextRanges.length === 0) {
      return state;
    }
    state.pendingChangedAbsoluteRanges = nextRanges;
    state.pendingLatestRevision = mirror.revision;
    if (!state.pendingSince) {
      state.pendingSince = now;
    }
    state.pendingTransportId = session.transportId;
    const snapshot = readTerminalTransportBackpressureSnapshot(session.transport);
    if (snapshot?.backpressure) {
      state.highWaterActive = true;
      if (!state.highWaterEnteredAt) {
        state.highWaterEnteredAt = now;
      }
    }
    if (state.pendingChangedAbsoluteRanges.length > SUBSCRIBER_PENDING_RANGE_LIMIT) {
      state.pendingChangedAbsoluteRanges = [{
        startIndex: Math.max(0, Math.floor(mirror.bufferStartIndex || 0)),
        endIndex: Math.max(
          Math.max(0, Math.floor(mirror.bufferStartIndex || 0)),
          Math.floor((mirror.bufferStartIndex || 0) + mirror.bufferLines.length),
        ),
      }];
      markSubscriberBufferSyncResyncRequired(state, 'range-count', false);
      return state;
    }
    if (pendingSpanLineCount(state.pendingChangedAbsoluteRanges) > SUBSCRIBER_PENDING_SPAN_LINE_LIMIT) {
      state.pendingChangedAbsoluteRanges = [{
        startIndex: Math.max(0, Math.floor(mirror.bufferStartIndex || 0)),
        endIndex: Math.max(
          Math.max(0, Math.floor(mirror.bufferStartIndex || 0)),
          Math.floor((mirror.bufferStartIndex || 0) + mirror.bufferLines.length),
        ),
      }];
      markSubscriberBufferSyncResyncRequired(state, 'span-lines', false);
      return state;
    }
    validateSubscriberPendingBounds(state, now);
    return state;
  }

  function shouldHoldPendingForBackpressure(state: TerminalSubscriberBufferSyncState, session: TerminalSession) {
    const snapshot = readTerminalTransportBackpressureSnapshot(session.transport);
    if (!snapshot?.ready) {
      return true;
    }
    if (snapshot.backpressure) {
      state.highWaterActive = true;
      if (!state.highWaterEnteredAt) {
        state.highWaterEnteredAt = Date.now();
      }
      return true;
    }
    if (state.highWaterActive && !snapshot.lowWaterDrained) {
      return true;
    }
    return false;
  }

  function clearSubscriberPendingBufferSync(state: TerminalSubscriberBufferSyncState, sentRevision: number) {
    state.lastSentRevision = sentRevision;
    state.pendingLatestRevision = null;
    state.pendingChangedAbsoluteRanges = [];
    state.pendingSince = 0;
    state.pendingTransportId = null;
    state.highWaterActive = false;
    state.highWaterEnteredAt = 0;
    state.resyncRequired = false;
    state.resyncReason = null;
    state.pendingLiveChunkIndex = 0;
  }

  function enqueueRangeBufferSyncResponse(
    session: TerminalSession,
    mirror: SessionMirror,
    request: import('@zterm/shared/types').BufferSyncRequestPayload,
  ): 'queued' | 'missing-subscriber' | 'transport-not-open' {
    if (!sessions.has(session.id)) {
      return 'missing-subscriber';
    }
    const state = ensureSubscriberBufferSyncState(session);
    state.pendingRangeResponses ||= [];
    state.pendingRangeResponses.push({
      payload: deps.buildRequestedRangeBufferPayload(mirror, request),
      transportId: session.transportId,
      nextChunkIndex: 0,
    });
    const result = flushRangeBufferSyncResponse(mirror, session);
    return result === 'transport-not-open' ? 'transport-not-open' : 'queued';
  }

  function flushRangeBufferSyncResponse(
    mirror: SessionMirror,
    session: TerminalSession,
  ): 'sent' | 'no-pending' | 'transport-not-open' | 'backpressured' | 'send-error' {
    const state = ensureSubscriberBufferSyncState(session);
    const queue = state.pendingRangeResponses || [];
    const item = queue[0];
    if (!item) {
      return 'no-pending';
    }
    if (item.transportId !== session.transportId) {
      queue.splice(0, queue.length);
      return 'no-pending';
    }
    if (!session.transport || session.transport.readyState !== 1) {
      return 'transport-not-open';
    }
    if (shouldHoldPendingForBackpressure(state, session)) {
      return 'backpressured';
    }
    try {
      deps.ensureSessionReady(session, mirror);
      const messages = splitBufferSyncPayloadMessages(item.payload, SUBSCRIBER_BUFFER_SYNC_MAX_BYTES);
      const start = Math.max(0, item.nextChunkIndex || 0);
      const end = Math.min(messages.length, start + MAX_SYNC_CHUNKS_PER_FLUSH);
      for (let index = start; index < end; index += 1) {
        deps.sendText(session.transport, messages[index]!.text);
      }
      item.nextChunkIndex = end;
      if (end < messages.length) {
        return 'sent';
      }
    } catch {
      return 'send-error';
    }
    queue.shift();
    return 'sent';
  }

  function broadcastBufferHeadToSubscribers(mirror: SessionMirror) {
    const now = Date.now();
    mirror.lastHeadBroadcastAt = now;
    mirrorHeadBroadcastCache.set(mirror, { revision: mirror.revision });
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session || !session.transport || session.transport.readyState !== 1) {
        continue;
      }
      const snapshot = readTerminalTransportBackpressureSnapshot(session.transport);
      if (snapshot && snapshot.backpressure) {
        continue;
      }
      deps.ensureSessionReady(session, mirror);
      deps.sendMessage(session, {
        type: 'buffer-head',
        payload: deps.buildBufferHeadPayload(session.id, mirror),
      });
    }
  }

  function broadcastChangedRangesBufferSyncToSubscribers(
    mirror: SessionMirror,
    changedRanges: Array<{ startIndex: number; endIndex: number }>,
  ) {
    const normalizedRanges = normalizeAbsoluteRanges(changedRanges);
    if (normalizedRanges.length === 0) {
      return;
    }
    const now = Date.now();
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session) {
        continue;
      }
      if (session.bodySubscribed === false) {
        if (session.bufferSyncState?.pendingRangeResponses?.length) {
          flushRangeBufferSyncResponse(mirror, session);
        }
        continue;
      }
      queueSubscriberPendingBufferSync(session, mirror, normalizedRanges, now);
      flushPendingSubscriberBufferSync(mirror, sessionId);
    }
  }

  function flushPendingSubscriberBufferSync(
    mirror: SessionMirror,
    sessionId: string,
  ): 'sent'
    | 'no-pending'
    | 'missing-subscriber'
    | 'transport-not-open'
    | 'backpressured'
    | 'send-error'
    | 'stale-transport' {
    const session = sessions.get(sessionId);
    if (!session) {
      return 'missing-subscriber';
    }
    const state = ensureSubscriberBufferSyncState(session);
    if (state.pendingLatestRevision === null || state.pendingChangedAbsoluteRanges.length === 0) {
      const rangeResult = flushRangeBufferSyncResponse(mirror, session);
      return rangeResult === 'sent' ? 'sent' : 'no-pending';
    }
    if (state.pendingTransportId && state.pendingTransportId !== session.transportId) {
      markSubscriberBufferSyncResyncRequired(state, 'transport-generation', false);
      return 'stale-transport';
    }
    validateSubscriberPendingBounds(state);
    if (!session.transport || session.transport.readyState !== 1) {
      return 'transport-not-open';
    }
    if (shouldHoldPendingForBackpressure(state, session)) {
      return 'backpressured';
    }
    const payload = deps.buildChangedRangesBufferSyncPayload(
      mirror,
      state.pendingChangedAbsoluteRanges,
    );
    if (!payload) {
      clearSubscriberPendingBufferSync(state, Math.max(state.lastSentRevision, state.pendingLatestRevision));
      return 'no-pending';
    }
    const messages = splitBufferSyncPayloadMessages(payload, SUBSCRIBER_BUFFER_SYNC_MAX_BYTES);
    const traceId = `${session.id}:${Math.max(0, Math.floor(payload.revision || 0))}`;
    const traceBase = {
      sessionId: session.id,
      traceId,
      mirrorRevision: Math.max(0, Math.floor(payload.revision || 0)),
      subscriberId: session.id,
      transportKind: session.transport.kind,
    };
    const start = Math.max(0, state.pendingLiveChunkIndex || 0);
    const end = Math.min(messages.length, start + MAX_SYNC_CHUNKS_PER_FLUSH);
    try {
      deps.ensureSessionReady(session, mirror);
      for (let index = start; index < end; index += 1) {
        const message = messages[index]!;
        deps.recordPerformanceTrace?.({
          ...traceBase,
          stage: 'send-start',
          at: Date.now(),
          bytes: Buffer.byteLength(message.text, 'utf8'),
          lineCount: Array.isArray(message.payload.lines) ? message.payload.lines.length : 0,
        });
        deps.sendText(session.transport, message.text);
        deps.recordPerformanceTrace?.({
          ...traceBase,
          stage: 'send-done',
          at: Date.now(),
          bytes: Buffer.byteLength(message.text, 'utf8'),
          lineCount: Array.isArray(message.payload.lines) ? message.payload.lines.length : 0,
        });
      }
    } catch {
      return 'send-error';
    }
    if (end < messages.length) {
      state.pendingLiveChunkIndex = end;
      return 'sent';
    }
    clearSubscriberPendingBufferSync(state, payload.revision);
    flushRangeBufferSyncResponse(mirror, session);
    return 'sent';
  }

  function flushPendingBufferSyncToSubscribers(mirror: SessionMirror) {
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (session?.bodySubscribed === false) {
        if (session?.bufferSyncState?.pendingRangeResponses?.length) {
          flushRangeBufferSyncResponse(mirror, session);
        }
        continue;
      }
      flushPendingSubscriberBufferSync(mirror, sessionId);
      if (session) {
        flushRangeBufferSyncResponse(mirror, session);
      }
    }
  }

  function sendBufferHeadToSession(session: TerminalSession, mirror: SessionMirror) {
    if (!session.transport || session.transport.readyState !== 1) {
      return;
    }
    const cached = mirrorHeadBroadcastCache.get(mirror);
    if (cached?.revision !== mirror.revision) {
      broadcastBufferHeadToSubscribers(mirror);
      return;
    }
    deps.sendMessage(session, {
      type: 'buffer-head',
      payload: deps.buildBufferHeadPayload(session.id, mirror),
    });
  }

  return {
    broadcastBufferHeadToSubscribers,
    broadcastChangedRangesBufferSyncToSubscribers,
    flushPendingSubscriberBufferSync,
    flushPendingBufferSyncToSubscribers,
    sendBufferHeadToSession,
    enqueueRangeBufferSyncResponse,
  };
}
