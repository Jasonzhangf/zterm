import type {
  TerminalPerformanceTraceRecord,
} from '@zterm/shared/terminal/performance-trace';
import type {
  BridgeServerMessage as ServerMessage,
} from '@zterm/shared/protocol';
import type {
  TerminalBufferPayload,
  TerminalCell,
  TerminalCursorState,
} from '@zterm/shared/types';
import { summarizeIndexedLinesForDebug } from '@zterm/shared/terminal-buffer';
import { buildLiveTailBufferSyncPayload } from './buffer-sync-contract';
import { sliceIndexedLines } from './canonical-buffer';
import { detachMirrorSubscriber, releaseMirrorSubscribers } from './mirror-lifecycle';
import { resolveTerminalLiveSyncDelay } from './terminal-performance-scheduler';
import { readTerminalTransportBackpressureSnapshot } from './terminal-transport-runtime';
import type {
  TerminalSession,
  SessionMirror,
  TerminalAttachPayload,
  TerminalAbsoluteRange,
  TerminalGeometry,
  TerminalSubscriberBufferSyncResyncReason,
  TerminalSubscriberBufferSyncState,
  TmuxPaneMetrics,
} from './terminal-runtime-types';

export interface TerminalMirrorRuntimeDeps {
  defaultViewport: { cols: number; rows: number };
  sessions: Map<string, TerminalSession>;
  mirrors: Map<string, SessionMirror>;
  sendMessage: (session: TerminalSession, message: ServerMessage) => void;
  sendText: (transport: import('./terminal-runtime-types').TerminalSessionTransport | null | undefined, text: string) => void;
  recordPerformanceTrace?: (record: TerminalPerformanceTraceRecord) => void;
  sendScheduleStateToSession: (session: TerminalSession, sessionName?: string) => void;
  buildConnectedPayload: (
    sessionId: string,
    requestOrigin?: string,
  ) => Extract<ServerMessage, { type: 'connected' }>['payload'];
  buildBufferHeadPayload: (
    sessionId: string,
    mirror: SessionMirror,
  ) => Extract<ServerMessage, { type: 'buffer-head' }>['payload'];
  buildChangedRangesBufferSyncPayload: (
    mirror: SessionMirror,
    changedRanges: Array<{ startIndex: number; endIndex: number }>,
  ) => Extract<ServerMessage, { type: 'buffer-sync' }>['payload'] | null;
  sanitizeSessionName: (input?: string) => string;
  getMirrorKey: (sessionName: string) => string;
  normalizeTerminalCols: (cols: number | undefined) => number;
  normalizeTerminalRows: (rows: number | undefined) => number;
  resolveAttachGeometry: (options: {
    requestedGeometry: TerminalGeometry | null;
    currentMirrorGeometry: TerminalGeometry | null;
    existingTmuxGeometry: TerminalGeometry | null;
    previousSessionGeometry: TerminalGeometry;
  }) => TerminalGeometry;
  readTmuxPaneMetrics: (sessionName: string) => TmuxPaneMetrics;
  assertTmuxSessionExists: (sessionName: string) => void;
  captureMirrorAuthoritativeBufferFromTmux: (mirror: SessionMirror) => Promise<boolean>;
  mirrorBufferChanged: (
    mirror: SessionMirror,
    previousStartIndex: number,
    previousLines: TerminalCell[][],
  ) => Array<{ startIndex: number; endIndex: number }>;
  mirrorCursorEqual: (
    left: TerminalCursorState | null | undefined,
    right: TerminalCursorState | null | undefined,
  ) => boolean;
  writeToLiveMirror: (sessionName: string, payload: string, appendEnter: boolean) => boolean;
  enqueueLiveMirrorInput: (
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    shouldWrite?: () => boolean,
  ) => Promise<boolean>;
  disposeLiveMirrorInputBatch: (sessionName: string, reason: string) => number;
  writeToTmuxSession: (sessionName: string, payload: string, appendEnter: boolean) => void;
  autoCommandDelayMs: number;
  waitMs: (delayMs: number) => Promise<void>;
  logTimePrefix: () => string;
  runTmux: (args: string[]) => { ok: true; stdout: string };
  closeTransportSubscriber: (session: TerminalSession, reason: string, notifyClient?: boolean) => void;
  getSessionMirror: (session: TerminalSession) => SessionMirror | null;
}

export interface TerminalMirrorRuntime {
  createMirror: (sessionName: string) => SessionMirror;
  destroyMirror: (
    mirror: SessionMirror,
    reason: string,
    options?: { closeTransportSubscribers?: boolean; notifyClientClose?: boolean; releaseCode?: string },
  ) => void;
  ensureSessionReady: (session: TerminalSession, mirror: SessionMirror) => void;
  sendBufferHeadToSession: (session: TerminalSession, mirror: SessionMirror) => void;
  flushPendingSubscriberBufferSync: (
    mirror: SessionMirror,
    sessionId: string,
  ) => 'sent'
    | 'no-pending'
    | 'missing-subscriber'
    | 'transport-not-open'
    | 'backpressured'
    | 'send-error'
    | 'stale-transport';
  refreshMirrorHeadForSession: (session: TerminalSession, mirror: SessionMirror) => Promise<boolean>;
  syncMirrorCanonicalBuffer: (mirror: SessionMirror, options?: { forceRevision?: boolean }) => Promise<boolean>;
  scheduleMirrorLiveSync: (mirror: SessionMirror, delayMs?: number) => void;
  resolveMirrorLiveSyncDelayForSubscriber: (
    mirror: SessionMirror,
    sessionId: string,
    sessions: Map<string, TerminalSession>,
    now: number,
    requestedDelayMs?: number,
  ) => { delayMs: number; lane: string; reason: string };
  startMirror: (mirror: SessionMirror, options?: { cols?: number; rows?: number; autoCommand?: string }) => Promise<void>;
  attachTmux: (session: TerminalSession, payload: TerminalAttachPayload) => Promise<void>;
  handleAdaptiveResize: (
    session: TerminalSession,
    payload: { cols?: number; widthMode?: 'adaptive-phone' | 'mirror-fixed' },
  ) => { ok: true } | { ok: false; code: 'session_not_ready' | 'adaptive_width_cols_invalid'; message: string };
  restorePersistedAdaptiveWidthBaselines: (sessionNames: string[]) => number;
  refreshAdaptiveWidthLeaseHeartbeat: (session: TerminalSession) => void;
  releaseAdaptiveWidthLease: (session: TerminalSession, reason: string) => void;
  handleInput: (session: TerminalSession, data: string, shouldWrite?: () => boolean) => Promise<boolean>;
  disposeLiveMirrorInputBatch: (sessionName: string, reason: string) => number;
}

const MIRROR_LIVE_SYNC_ACTIVE_MS = 33;
const MIRROR_LIVE_SYNC_IDLE_MS = 120;
const ADAPTIVE_WIDTH_LEASE_TTL_MS = 65000;
const SUBSCRIBER_PENDING_RANGE_LIMIT = 64;
const SUBSCRIBER_PENDING_SPAN_LINE_LIMIT = 4096;
const SUBSCRIBER_PENDING_AGE_LIMIT_MS = 15_000;
const SUBSCRIBER_BUFFER_SYNC_MAX_BYTES = 128_000;

function getWireLineAbsoluteIndex(line: TerminalBufferPayload['lines'][number]) {
  if (!line) {
    return null;
  }
  if ('i' in line && Number.isFinite(line.i)) {
    return Math.max(0, Math.floor(line.i));
  }
  if ('index' in line && Number.isFinite(line.index)) {
    return Math.max(0, Math.floor(line.index));
  }
  return null;
}

function buildBufferSyncMessageText(payload: TerminalBufferPayload) {
  return JSON.stringify({ type: 'buffer-sync', payload });
}

function splitBufferSyncPayloadMessages(payload: TerminalBufferPayload, maxBytes: number) {
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const fullText = buildBufferSyncMessageText(payload);
  if (Buffer.byteLength(fullText, 'utf8') <= maxBytes || lines.length <= 1) {
    return [{ payload, text: fullText }];
  }

  const messages: Array<{ payload: TerminalBufferPayload; text: string }> = [];
  let chunkLines: TerminalBufferPayload['lines'] = [];
  let chunkStartIndex: number | null = null;
  let chunkEndIndex: number | null = null;
  const frameStartIndex = Math.max(0, Math.floor(payload.startIndex || 0));
  const frameEndIndex = Math.max(frameStartIndex, Math.floor(payload.endIndex || frameStartIndex));
  const buildChunkPayload = (
    startIndex: number,
    endIndex: number,
    nextLines: TerminalBufferPayload['lines'],
    chunkIndex: number,
    chunkCount: number,
  ): TerminalBufferPayload => ({
    ...payload,
    startIndex,
    endIndex,
    frameStartIndex,
    frameEndIndex,
    frameChunkIndex: chunkIndex,
    frameChunkCount: chunkCount,
    lines: nextLines,
  });

  const flushChunk = () => {
    if (chunkLines.length === 0 || chunkStartIndex === null || chunkEndIndex === null) {
      return;
    }
    const chunkPayload = buildChunkPayload(chunkStartIndex, chunkEndIndex, chunkLines, messages.length, 9999);
    messages.push({ payload: chunkPayload, text: buildBufferSyncMessageText(chunkPayload) });
    chunkLines = [];
    chunkStartIndex = null;
    chunkEndIndex = null;
  };

  for (const line of lines) {
    const lineIndex = getWireLineAbsoluteIndex(line);
    if (lineIndex === null) {
      continue;
    }
    const candidateStartIndex: number = chunkStartIndex === null ? lineIndex : chunkStartIndex;
    const candidateEndIndex: number = Math.max(chunkEndIndex === null ? lineIndex + 1 : chunkEndIndex, lineIndex + 1);
    const candidateLines: TerminalBufferPayload['lines'] = [...chunkLines, line];
    const candidatePayload = buildChunkPayload(candidateStartIndex, candidateEndIndex, candidateLines, messages.length, 9999);
    const candidateText = buildBufferSyncMessageText(candidatePayload);
    if (chunkLines.length > 0 && Buffer.byteLength(candidateText, 'utf8') > maxBytes) {
      flushChunk();
      chunkStartIndex = lineIndex;
      chunkEndIndex = lineIndex + 1;
      chunkLines = [line];
      continue;
    }
    chunkStartIndex = candidateStartIndex;
    chunkEndIndex = candidateEndIndex;
    chunkLines = candidateLines;
  }
  flushChunk();

  if (messages.length <= 1) {
    return messages.length > 0 ? messages : [{ payload, text: fullText }];
  }

  return messages.map((message, index) => {
    const chunkPayload = buildChunkPayload(
      message.payload.startIndex,
      message.payload.endIndex,
      message.payload.lines,
      index,
      messages.length,
    );
    return { payload: chunkPayload, text: buildBufferSyncMessageText(chunkPayload) };
  });
}

export function resolvePerSubscriberTransportSnapshot(
  sessions: Map<string, TerminalSession>,
  sessionId: string,
) {
  const session = sessions.get(sessionId);
  return readTerminalTransportBackpressureSnapshot(session?.transport);
}

export function resolveMirrorLiveSyncDelayForSubscriber(
  mirror: SessionMirror,
  sessionId: string,
  sessions: Map<string, TerminalSession>,
  now: number,
  requestedDelayMs?: number,
) {
  const snapshot = resolvePerSubscriberTransportSnapshot(sessions, sessionId);
  return resolveTerminalLiveSyncDelay({
    requestedDelayMs,
    activeDelayMs: MIRROR_LIVE_SYNC_ACTIVE_MS,
    idleDelayMs: MIRROR_LIVE_SYNC_IDLE_MS,
    now,
    lastLiveActivityAt: mirror.lastLiveActivityAt || 0,
    consecutiveFailures: mirror.consecutiveFailures,
    subscriberCount: snapshot?.ready ? 1 : 0,
    transportBufferedBytes: snapshot?.bufferedBytes || 0,
    transportBackpressureCount: snapshot?.backpressureCount || 0,
    lastCaptureDurationMs: mirror.lastCaptureDurationMs || 0,
    lastCanonicalizeDurationMs: mirror.lastCanonicalizeDurationMs || 0,
    flushInFlight: mirror.flushInFlight,
  });
}

export function createTerminalMirrorRuntime(deps: TerminalMirrorRuntimeDeps): TerminalMirrorRuntime {
  const sessions = deps.sessions;
  const mirrors = deps.mirrors;
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
      pendingAllowOversizedTailSeed: false,
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
    options?: { allowOversizedTailSeed?: boolean },
  ) {
    const state = ensureSubscriberBufferSyncState(session);
    const hadPendingRanges = state.pendingChangedAbsoluteRanges.length > 0;
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
    state.pendingAllowOversizedTailSeed = Boolean(options?.allowOversizedTailSeed) && !hadPendingRanges;
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
      state.pendingAllowOversizedTailSeed = false;
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
      state.pendingAllowOversizedTailSeed = false;
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
    state.pendingAllowOversizedTailSeed = false;
  }

  function isTmuxSessionUnavailableError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /no server running|can(?:'t| not) find session|no such session|session .*not found|wezterm session not found/i.test(message);
  }

  function writeMirrorBaselineGeometry(mirror: SessionMirror, geometry: { cols: number; rows: number }) {
    mirror.baselineCols = deps.normalizeTerminalCols(geometry.cols);
    mirror.baselineRows = deps.normalizeTerminalRows(geometry.rows);
  }

  function stopMirrorLiveSync(mirror: SessionMirror) {
    if (mirror.liveSyncTimer) {
      clearTimeout(mirror.liveSyncTimer);
      mirror.liveSyncTimer = null;
    }
  }

  function resolveMirrorLiveSyncDelay(mirror: SessionMirror, requestedDelayMs?: number) {
    const now = Date.now();
    return resolveTerminalLiveSyncDelay({
      requestedDelayMs,
      activeDelayMs: MIRROR_LIVE_SYNC_ACTIVE_MS,
      idleDelayMs: MIRROR_LIVE_SYNC_IDLE_MS,
      now,
      lastLiveActivityAt: mirror.lastLiveActivityAt || 0,
      consecutiveFailures: mirror.consecutiveFailures,
      subscriberCount: countReadyBodySubscribedSubscribers(mirror),
      // Backpressure is handled per-subscriber in broadcastChangedRangesBufferSyncToSubscribers.
      // Mirror-level capture cadence must not be dragged down by a single slow subscriber.
      transportBufferedBytes: 0,
      transportBackpressureCount: 0,
      lastCaptureDurationMs: mirror.lastCaptureDurationMs || 0,
      lastCanonicalizeDurationMs: mirror.lastCanonicalizeDurationMs || 0,
      flushInFlight: mirror.flushInFlight,
    }).delayMs;
  }

  function countReadyBodySubscribedSubscribers(mirror: SessionMirror) {
    let count = 0;
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session || session.bodySubscribed === false) {
        continue;
      }
      if (!session.transport || session.transport.readyState !== 1) {
        continue;
      }
      count += 1;
    }
    return count;
  }

  function createMirror(sessionName: string): SessionMirror {
    const mirror: SessionMirror = {
      key: sessionName,
      sessionName,
      scratchBridge: null,
      lifecycle: 'idle',
      cols: deps.defaultViewport.cols,
      rows: deps.defaultViewport.rows,
      baselineCols: deps.defaultViewport.cols,
      baselineRows: deps.defaultViewport.rows,
      cursorKeysApp: false,
      revision: 0,
      lastScrollbackCount: -1,
      bufferStartIndex: 0,
      bufferLines: [],
      cursor: null,
      lastFlushStartedAt: 0,
      lastFlushCompletedAt: 0,
      lastLiveActivityAt: 0,
      lastHeadBroadcastAt: 0,
      lastCaptureDurationMs: 0,
      lastCanonicalizeDurationMs: 0,
      flushInFlight: false,
      flushPromise: null,
      pendingStableCaptureSnapshot: null,
      pendingPerformanceTraceCapture: null,
      adaptiveWidthBaselineGeometry: null,
      adaptiveWidthAppliedCols: null,
      adaptiveWidthLeaseTimer: null,
      liveSyncTimer: null,
      consecutiveFailures: 0,
      subscribers: new Set(),
    };
    mirrors.set(sessionName, mirror);
    return mirror;
  }

  function releaseMirrorForSubscribers(
    mirror: SessionMirror,
    reason: string,
    code = 'tmux_session_unavailable',
  ) {
    const releasedSessionIds = releaseMirrorSubscribers(sessions, mirror.subscribers);
    for (const sessionId of releasedSessionIds) {
      const client = sessions.get(sessionId);
      if (!client) {
        continue;
      }
      client.pendingPasteImage = null;
      client.pendingAttachFile = null;
      deps.sendMessage(client, { type: 'error', payload: { message: reason, code } });
    }
  }

  function destroyMirror(
    mirror: SessionMirror,
    reason: string,
    options?: {
      closeTransportSubscribers?: boolean;
      notifyClientClose?: boolean;
      releaseCode?: string;
    },
  ) {
    if (mirror.lifecycle === 'destroyed') {
      return;
    }

    // R3: drop any pending input items for the dying mirror before subscribers
    // are released or the mirror record is removed. Items already in flight
    // resolve through their own tmux spawn; queued items must NOT survive.
    deps.disposeLiveMirrorInputBatch(mirror.sessionName, `destroy:${reason}`);

    mirror.lifecycle = 'destroyed';

    if (options?.closeTransportSubscribers) {
      const subscriberIds = Array.from(mirror.subscribers);
      for (const sessionId of subscriberIds) {
        const client = sessions.get(sessionId);
        if (!client) {
          continue;
        }
        deps.closeTransportSubscriber(client, reason, Boolean(options.notifyClientClose));
      }
    } else {
      releaseMirrorForSubscribers(mirror, reason, options?.releaseCode || 'tmux_session_unavailable');
    }
    mirror.subscribers.clear();
    mirror.scratchBridge = null;
    mirror.bufferLines = [];
    mirror.bufferStartIndex = 0;
    mirror.cursor = null;
    mirror.lastFlushStartedAt = 0;
    mirror.lastFlushCompletedAt = 0;
    mirror.lastLiveActivityAt = 0;
    mirror.lastHeadBroadcastAt = 0;
    mirror.lastCaptureDurationMs = 0;
    mirror.lastCanonicalizeDurationMs = 0;
    mirror.lastScrollbackCount = -1;
    mirror.flushInFlight = false;
    mirror.flushPromise = null;
    mirror.pendingStableCaptureSnapshot = null;
    mirror.pendingPerformanceTraceCapture = null;
    if (mirror.adaptiveWidthLeaseTimer) {
      clearTimeout(mirror.adaptiveWidthLeaseTimer);
      mirror.adaptiveWidthLeaseTimer = null;
    }
    mirror.adaptiveWidthBaselineGeometry = null;
    mirror.adaptiveWidthAppliedCols = null;
    stopMirrorLiveSync(mirror);
    mirrors.delete(mirror.key);
  }

  function ensureSessionReady(session: TerminalSession, mirror: SessionMirror) {
    session.sessionName = mirror.sessionName;
    if (!session.transport || session.connectedSent) {
      return;
    }
    session.connectedSent = true;
    session.transport.connectedSent = true;
    deps.sendMessage(session, {
      type: 'connected',
      payload: deps.buildConnectedPayload(session.id, session.transport.requestOrigin),
    });
    deps.sendScheduleStateToSession(session, mirror.sessionName);
    deps.sendMessage(session, { type: 'title', payload: mirror.sessionName });
  }
  function announceMirrorSubscribersReady(mirror: SessionMirror) {
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session) {
        continue;
      }
      ensureSessionReady(session, mirror);
    }
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
      ensureSessionReady(session, mirror);
      deps.sendMessage(session, {
        type: 'buffer-head',
        payload: deps.buildBufferHeadPayload(session.id, mirror),
      });
    }
  }

  function broadcastChangedRangesBufferSyncToSubscribers(
    mirror: SessionMirror,
    changedRanges: Array<{ startIndex: number; endIndex: number }>,
    options?: { allowOversizedTailSeed?: boolean },
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
        continue;
      }
      queueSubscriberPendingBufferSync(session, mirror, normalizedRanges, now, options);
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
      return 'no-pending';
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
    let messages = splitBufferSyncPayloadMessages(payload, SUBSCRIBER_BUFFER_SYNC_MAX_BYTES);
    if (
      messages.length > 1
      && state.pendingAllowOversizedTailSeed
    ) {
      const tailPayload = buildLiveTailBufferSyncPayload(mirror, { viewportRows: mirror.rows });
      messages = [{ payload: tailPayload, text: buildBufferSyncMessageText(tailPayload) }];
    }
    const traceId = `${session.id}:${Math.max(0, Math.floor(payload.revision || 0))}`;
    const traceBase = {
      sessionId: session.id,
      traceId,
      mirrorRevision: Math.max(0, Math.floor(payload.revision || 0)),
      subscriberId: session.id,
      transportKind: session.transport.kind,
    };
    try {
      ensureSessionReady(session, mirror);
      for (const message of messages) {
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
    clearSubscriberPendingBufferSync(state, payload.revision);
    return 'sent';
  }

  function flushPendingBufferSyncToSubscribers(mirror: SessionMirror) {
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (session?.bodySubscribed === false) {
        continue;
      }
      flushPendingSubscriberBufferSync(mirror, sessionId);
    }
  }

  function sendBufferHeadToSession(session: TerminalSession, mirror: SessionMirror) {
    if (!session.transport || session.transport.readyState !== 1) {
      return;
    }
    const cached = mirrorHeadBroadcastCache.get(mirror);
    if (cached?.revision !== mirror.revision) {
      // R1+R2: the first head probe for a fresh revision fans out once to all
      // subscribers so N subs do not each trigger their own full head path.
      // Later probes on the same revision can reply only to the requester.
      broadcastBufferHeadToSubscribers(mirror);
      return;
    }
    deps.sendMessage(session, {
      type: 'buffer-head',
      payload: deps.buildBufferHeadPayload(session.id, mirror),
    });
  }

  async function refreshMirrorHeadForSession(session: TerminalSession, mirror: SessionMirror) {
    if (mirror.lifecycle !== 'ready') {
      return false;
    }
    const captured = await syncMirrorCanonicalBuffer(mirror);
    if (!captured) {
      return false;
    }
    sendBufferHeadToSession(session, mirror);
    return true;
  }

  async function syncMirrorCanonicalBuffer(
    mirror: SessionMirror,
    options?: { forceRevision?: boolean },
  ) {
    if (mirror.lifecycle !== 'ready') {
      return false;
    }
    if (mirror.flushPromise) {
      return mirror.flushPromise;
    }

    const previousStartIndex = mirror.bufferStartIndex;
    const previousLines = mirror.bufferLines.slice();
    const previousCursor = mirror.cursor ? { ...mirror.cursor } : null;
    const previousCursorKeysApp = mirror.cursorKeysApp;
    const forceRevision = Boolean(options?.forceRevision);

    mirror.lastFlushStartedAt = Date.now();
    mirror.flushInFlight = true;
    const capturePromise = deps.captureMirrorAuthoritativeBufferFromTmux(mirror)
      .then((captured) => {
        if (!captured) {
          throw new Error('tmux capture returned no canonical buffer');
        }
        writeMirrorBaselineGeometry(mirror, {
          cols: mirror.cols,
          rows: mirror.rows,
        });
        mirror.consecutiveFailures = 0;
        const changedRanges = deps.mirrorBufferChanged(mirror, previousStartIndex, previousLines);
        const cursorChanged = !deps.mirrorCursorEqual(previousCursor, mirror.cursor);
        const cursorKeysAppChanged = previousCursorKeysApp !== mirror.cursorKeysApp;
        const hasLiveActivity = forceRevision || changedRanges.length > 0 || cursorChanged || cursorKeysAppChanged;
        if (hasLiveActivity) {
          mirror.revision += 1;
          mirror.lastLiveActivityAt = Date.now();
        }
        if (hasLiveActivity) {
          const captureTrace = mirror.pendingPerformanceTraceCapture;
          const committedAt = Date.now();
          for (const subscriberId of mirror.subscribers) {
            const traceBase = {
              sessionId: subscriberId,
              traceId: `${subscriberId}:${Math.max(0, Math.floor(mirror.revision || 0))}`,
              mirrorRevision: Math.max(0, Math.floor(mirror.revision || 0)),
              subscriberId,
            };
            if (captureTrace) {
              deps.recordPerformanceTrace?.({
                ...traceBase,
                stage: 'capture-start',
                at: captureTrace.captureStartedAt,
                lineCount: captureTrace.capturedLineCount,
              });
              deps.recordPerformanceTrace?.({
                ...traceBase,
                stage: 'capture-done',
                at: captureTrace.captureDoneAt,
                lineCount: captureTrace.capturedLineCount,
              });
              deps.recordPerformanceTrace?.({
                ...traceBase,
                stage: 'canonicalize-done',
                at: captureTrace.canonicalizeDoneAt,
                lineCount: captureTrace.canonicalLineCount,
              });
            }
            deps.recordPerformanceTrace?.({
              ...traceBase,
              stage: 'mirror-commit',
              at: committedAt,
              lineCount: mirror.bufferLines.length,
            });
          }
        }
        if (changedRanges.length > 0 || cursorChanged || cursorKeysAppChanged || forceRevision) {
          const firstRange = changedRanges[0] || null;
          const lastRange = changedRanges[changedRanges.length - 1] || null;
          console.debug(`[${deps.logTimePrefix()}] mirror.flush.inspect`, {
            sessionName: mirror.sessionName,
            revision: mirror.revision,
            previousStartIndex,
            previousEndIndex: previousStartIndex + previousLines.length,
            nextStartIndex: mirror.bufferStartIndex,
            nextEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
            changedRangeCount: changedRanges.length,
            firstChangedRange: firstRange,
            lastChangedRange: lastRange,
            cursorChanged,
            cursorKeysAppChanged,
            forceRevision,
            changedLinePreview: firstRange
              ? summarizeIndexedLinesForDebug(
                  sliceIndexedLines(
                    mirror.bufferStartIndex,
                    mirror.bufferLines,
                    firstRange.startIndex,
                    Math.min(firstRange.endIndex, firstRange.startIndex + 6),
                  ),
                )
              : [],
          });
        }
        if (changedRanges.length > 0 || forceRevision) {
          broadcastChangedRangesBufferSyncToSubscribers(
            mirror,
            forceRevision
              ? [{ startIndex: mirror.bufferStartIndex, endIndex: mirror.bufferStartIndex + mirror.bufferLines.length }]
              : changedRanges,
            { allowOversizedTailSeed: forceRevision && changedRanges.length === 0 },
          );
          return true;
        }
        if (cursorChanged || cursorKeysAppChanged) {
          broadcastBufferHeadToSubscribers(mirror);
        }
        flushPendingBufferSyncToSubscribers(mirror);
        return true;
      })
      .catch((error) => {
        mirror.consecutiveFailures += 1;
        const isInvalidTarget = isTmuxSessionUnavailableError(error);
        const failureMsg = `[${deps.logTimePrefix()}] canonical mirror refresh failed for ${mirror.sessionName} (streak=${mirror.consecutiveFailures}): ${
          error instanceof Error ? error.message : String(error)
        }`;
        if (isInvalidTarget) {
          console.error(`${failureMsg} -> mirror released (code=tmux_session_unavailable)`);
          destroyMirror(
            mirror,
            `Tmux session unavailable: ${error instanceof Error ? error.message : String(error)}`,
            {
              closeTransportSubscribers: false,
              releaseCode: 'tmux_session_unavailable',
            },
          );
          return false;
        }
        if (mirror.consecutiveFailures >= 10) {
          mirror.lifecycle = 'failed';
          stopMirrorLiveSync(mirror);
          console.error(`${failureMsg} -> mirror isolated (lifecycle=failed)`);
        } else {
          console.error(failureMsg);
        }
        return false;
      })
      .finally(() => {
        mirror.lastFlushCompletedAt = Date.now();
        mirror.flushInFlight = false;
        mirror.flushPromise = null;
      });

    mirror.flushPromise = capturePromise;
    return capturePromise;
  }

  function scheduleMirrorLiveSync(mirror: SessionMirror, delayMs = MIRROR_LIVE_SYNC_ACTIVE_MS) {
    if (mirror.lifecycle !== 'ready') {
      return;
    }
    if (countReadyBodySubscribedSubscribers(mirror) === 0) {
      stopMirrorLiveSync(mirror);
      return;
    }
    const effectiveDelay = resolveMirrorLiveSyncDelay(mirror, delayMs);
    stopMirrorLiveSync(mirror);
    mirror.liveSyncTimer = setTimeout(() => {
      mirror.liveSyncTimer = null;
      if (mirror.lifecycle !== 'ready' || countReadyBodySubscribedSubscribers(mirror) === 0) {
        return;
      }
      void syncMirrorCanonicalBuffer(mirror).finally(() => {
        if (
          mirror.lifecycle !== 'ready'
          || mirror.liveSyncTimer
          || countReadyBodySubscribedSubscribers(mirror) === 0
        ) {
          return;
        }
        scheduleMirrorLiveSync(mirror, MIRROR_LIVE_SYNC_ACTIVE_MS);
      });
    }, Math.max(0, effectiveDelay));
  }

  function resolveActiveAdaptiveWidthLeases(mirror: SessionMirror, now = Date.now()) {
    const leases: Array<{ subscriberId: string; cols: number; expiresAt: number }> = [];
    for (const subscriberId of mirror.subscribers) {
      const subscriber = sessions.get(subscriberId);
      if (!subscriber || !subscriber.transport || subscriber.transport.readyState !== 1) {
        continue;
      }
      if (!subscriber.adaptiveWidthCols || subscriber.adaptiveWidthCols <= 0) {
        continue;
      }
      const expiresAt = (subscriber.adaptiveWidthHeartbeatAt || 0) + ADAPTIVE_WIDTH_LEASE_TTL_MS;
      if (expiresAt <= now) {
        continue;
      }
      leases.push({
        subscriberId,
        cols: deps.normalizeTerminalCols(subscriber.adaptiveWidthCols),
        expiresAt,
      });
    }
    leases.sort((left, right) => left.cols - right.cols || left.expiresAt - right.expiresAt);
    return leases;
  }

  function scheduleAdaptiveWidthLeaseExpiry(mirror: SessionMirror) {
    if (mirror.adaptiveWidthLeaseTimer) {
      clearTimeout(mirror.adaptiveWidthLeaseTimer);
      mirror.adaptiveWidthLeaseTimer = null;
    }
    const leases = resolveActiveAdaptiveWidthLeases(mirror);
    if (leases.length === 0) {
      return;
    }
    const nextExpiresAt = Math.min(...leases.map((lease) => lease.expiresAt));
    const delayMs = Math.max(1, nextExpiresAt - Date.now() + 1);
    mirror.adaptiveWidthLeaseTimer = setTimeout(() => {
      mirror.adaptiveWidthLeaseTimer = null;
      reconcileAdaptiveWidthLeases(mirror, 'lease-expired');
    }, delayMs);
    mirror.adaptiveWidthLeaseTimer.unref?.();
  }

  function clearAdaptiveWidthLeaseAggregate(mirror: SessionMirror, reason = 'clear') {
    if (mirror.adaptiveWidthLeaseTimer) {
      clearTimeout(mirror.adaptiveWidthLeaseTimer);
      mirror.adaptiveWidthLeaseTimer = null;
    }
    if (mirror.adaptiveWidthAppliedCols !== null) {
      releaseAdaptiveTmuxWidth(mirror, reason);
    }
    mirror.adaptiveWidthAppliedCols = null;
    mirror.adaptiveWidthBaselineGeometry = null;
  }

  function readCurrentTmuxGeometry(sessionName: string): TerminalGeometry | null {
    try {
      const metrics = deps.readTmuxPaneMetrics(sessionName);
      return {
        cols: deps.normalizeTerminalCols(metrics.paneCols),
        rows: deps.normalizeTerminalRows(metrics.paneRows),
      };
    } catch (error) {
      console.error(
        `[${deps.logTimePrefix()}] adaptive width failed to read tmux geometry for ${sessionName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  function applyAdaptiveTmuxWidth(mirror: SessionMirror, targetCols: number, reason: string) {
    const cols = deps.normalizeTerminalCols(targetCols);
    if (!mirror.adaptiveWidthBaselineGeometry) {
      mirror.adaptiveWidthBaselineGeometry =
        readCurrentTmuxGeometry(mirror.sessionName) || {
          cols: deps.normalizeTerminalCols(mirror.baselineCols || mirror.cols),
          rows: deps.normalizeTerminalRows(mirror.baselineRows || mirror.rows),
        };
    }
    if (mirror.adaptiveWidthAppliedCols === cols) {
      return;
    }
    deps.runTmux(['resize-window', '-t', mirror.sessionName, '-x', String(cols)]);
    mirror.adaptiveWidthAppliedCols = cols;
    console.log(`[${deps.logTimePrefix()}] adaptive width applied`, {
      sessionName: mirror.sessionName,
      cols,
      reason,
    });
  }

  function releaseAdaptiveTmuxWidth(mirror: SessionMirror, reason: string) {
    const baseline = mirror.adaptiveWidthBaselineGeometry;
    if (baseline) {
      deps.runTmux(['resize-window', '-t', mirror.sessionName, '-x', String(deps.normalizeTerminalCols(baseline.cols))]);
    }
    deps.runTmux(['set-window-option', '-u', '-t', mirror.sessionName, 'window-size']);
    console.log(`[${deps.logTimePrefix()}] adaptive width released`, {
      sessionName: mirror.sessionName,
      restoredCols: baseline?.cols ?? null,
      reason,
    });
  }

  function reconcileAdaptiveWidthLeases(mirror: SessionMirror, reason: string) {
    void reason;
    const now = Date.now();
    for (const subscriberId of mirror.subscribers) {
      const subscriber = sessions.get(subscriberId);
      if (!subscriber?.adaptiveWidthCols) {
        continue;
      }
      const expiresAt = (subscriber.adaptiveWidthHeartbeatAt || 0) + ADAPTIVE_WIDTH_LEASE_TTL_MS;
      if (expiresAt <= now) {
        subscriber.adaptiveWidthCols = null;
        subscriber.adaptiveWidthHeartbeatAt = 0;
      }
    }
    const leases = resolveActiveAdaptiveWidthLeases(mirror);
    if (leases.length === 0) {
      clearAdaptiveWidthLeaseAggregate(mirror, reason);
      return;
    }

    const targetCols = leases[0].cols;
    if (mirror.adaptiveWidthAppliedCols !== targetCols) {
      if (mirror.lifecycle === 'ready') {
        applyAdaptiveTmuxWidth(mirror, targetCols, reason);
        scheduleMirrorLiveSync(mirror, 0);
      }
    }
    scheduleAdaptiveWidthLeaseExpiry(mirror);
  }

  function updateAdaptiveWidthLease(
    session: TerminalSession,
    mirror: SessionMirror,
    payload: { cols?: number; widthMode?: 'adaptive-phone' | 'mirror-fixed' },
    reason: string,
  ): { ok: true } | { ok: false; code: 'adaptive_width_cols_invalid'; message: string } {
    if (payload.widthMode !== 'adaptive-phone') {
      releaseAdaptiveWidthLease(session, reason);
      return { ok: true };
    }
    if (typeof payload.cols !== 'number' || !Number.isFinite(payload.cols) || payload.cols <= 0) {
      releaseAdaptiveWidthLease(session, `${reason}-invalid-cols`);
      return {
        ok: false,
        code: 'adaptive_width_cols_invalid',
        message: 'adaptive-phone width lease requires finite positive cols',
      };
    }
    const cols = deps.normalizeTerminalCols(payload.cols);
    session.adaptiveWidthCols = cols;
    session.adaptiveWidthHeartbeatAt = Date.now();
    reconcileAdaptiveWidthLeases(mirror, reason);
    return { ok: true };
  }

  function restorePersistedAdaptiveWidthBaselines(sessionNames: string[]) {
    void sessionNames;
    return 0;
  }

  async function startMirror(
    mirror: SessionMirror,
    options?: { cols?: number; rows?: number; autoCommand?: string },
  ) {
    if (mirror.lifecycle === 'ready' || mirror.lifecycle === 'booting') {
      return;
    }

    mirror.lifecycle = 'booting';

    try {
      deps.assertTmuxSessionExists(mirror.sessionName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mirror.lifecycle = 'failed';
      for (const sessionId of mirror.subscribers) {
        const session = sessions.get(sessionId);
        if (!session) {
          continue;
        }
        deps.sendMessage(session, {
          type: 'error',
          payload: { message: `Tmux session unavailable: ${message}`, code: 'tmux_session_unavailable' },
        });
      }
      return;
    }

    mirror.lifecycle = 'ready';
    reconcileAdaptiveWidthLeases(mirror, 'mirror-ready');

    if (countReadyBodySubscribedSubscribers(mirror) === 0) {
      announceMirrorSubscribersReady(mirror);
      return;
    }

    try {
      await deps.waitMs(80);
      const captured = await syncMirrorCanonicalBuffer(mirror, { forceRevision: true });
      if (!captured) {
        if (!mirrors.has(mirror.key)) {
          return;
        }
        throw new Error('Failed to capture canonical tmux buffer during initial sync');
      }
      announceMirrorSubscribersReady(mirror);
      scheduleMirrorLiveSync(mirror, MIRROR_LIVE_SYNC_ACTIVE_MS);
    } catch (error) {
      if (isTmuxSessionUnavailableError(error)) {
        console.error(
          `[${deps.logTimePrefix()}] initial buffer sync released unavailable tmux target for ${mirror.sessionName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        destroyMirror(
          mirror,
          `Tmux session unavailable: ${error instanceof Error ? error.message : String(error)}`,
          {
            closeTransportSubscribers: false,
            releaseCode: 'tmux_session_unavailable',
          },
        );
        return;
      }
      mirror.lifecycle = 'failed';
      console.error(
        `[${deps.logTimePrefix()}] initial buffer sync failed for ${mirror.sessionName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      for (const sessionId of mirror.subscribers) {
        const subscriber = sessions.get(sessionId);
        if (!subscriber) {
          continue;
        }
        deps.sendMessage(subscriber, {
          type: 'error',
          payload: {
            message: `Initial canonical sync failed: ${error instanceof Error ? error.message : String(error)}`,
            code: 'initial_buffer_sync_failed',
          },
        });
      }
    }

    if (options?.autoCommand?.trim()) {
      const command = options.autoCommand.endsWith('\r') ? options.autoCommand.slice(0, -1) : options.autoCommand;
      setTimeout(() => {
        if (mirror.lifecycle === 'ready') {
          deps.writeToTmuxSession(mirror.sessionName, command, true);
          scheduleMirrorLiveSync(mirror, 0);
        }
      }, deps.autoCommandDelayMs);
    }
  }

  async function attachTmux(session: TerminalSession, payload: TerminalAttachPayload) {
    const nextSessionName = deps.sanitizeSessionName(payload.sessionName);
    const nextMirrorKey = deps.getMirrorKey(nextSessionName);
    const existingMirror = mirrors.get(nextMirrorKey) || null;
    const existingTmuxGeometry = existingMirror
      ? null
      : (() => {
        try {
          const metrics = deps.readTmuxPaneMetrics(nextSessionName);
          return {
            cols: metrics.paneCols,
            rows: metrics.paneRows,
          };
        } catch (metricsError) {
          console.warn(
            '[server] readTmuxPaneMetrics failed:',
            metricsError instanceof Error ? metricsError.message : metricsError,
          );
          return null;
        }
      })();
    const requestedGeometry = deps.resolveAttachGeometry({
      requestedGeometry: payload.widthMode === 'adaptive-phone'
        ? null
        : typeof payload.cols === 'number'
          && Number.isFinite(payload.cols)
          && payload.cols > 0
          ? {
              cols: payload.cols,
              rows: typeof payload.rows === 'number' ? payload.rows : deps.defaultViewport.rows,
            }
          : null,
      currentMirrorGeometry: existingMirror
        ? { cols: existingMirror.cols, rows: existingMirror.rows }
        : null,
      existingTmuxGeometry,
      previousSessionGeometry: deps.defaultViewport,
    });
    const requestedCols = deps.normalizeTerminalCols(requestedGeometry.cols);
    const requestedRows = deps.normalizeTerminalRows(requestedGeometry.rows);

    const previousMirror = deps.getSessionMirror(session);
    const movingBetweenMirrors = Boolean(previousMirror && previousMirror.key !== nextMirrorKey);
    if (previousMirror) {
      if (movingBetweenMirrors) {
        releaseAdaptiveWidthLease(session, 'move-mirror');
      }
      const detachResult = detachMirrorSubscriber(previousMirror.subscribers, session.id);
      previousMirror.subscribers = detachResult.nextSubscribers;
      if (movingBetweenMirrors) {
        scheduleMirrorLiveSync(previousMirror, MIRROR_LIVE_SYNC_ACTIVE_MS);
      }
    }

    session.sessionName = nextSessionName;
    session.mirrorKey = nextMirrorKey;
    session.connectedSent = false;
    if (session.transport) {
      session.transport.connectedSent = false;
    }

    let mirror = existingMirror;
    if (!mirror) {
      mirror = createMirror(nextSessionName);
    }
    mirror.subscribers.add(session.id);
    if (payload.widthMode === 'adaptive-phone') {
      const leaseResult = updateAdaptiveWidthLease(session, mirror, payload, 'attach');
      if (!leaseResult.ok) {
        deps.sendMessage(session, {
          type: 'error',
          payload: { message: leaseResult.message, code: leaseResult.code },
        });
      }
    } else {
      releaseAdaptiveWidthLease(session, 'attach-non-adaptive');
    }
    deps.sendMessage(session, { type: 'title', payload: mirror.sessionName });

    if (mirror.lifecycle === 'ready') {
      ensureSessionReady(session, mirror);
      scheduleMirrorLiveSync(mirror, 0);
      return;
    }

    await startMirror(mirror, { cols: requestedCols, rows: requestedRows, autoCommand: payload.autoCommand });
  }

  function handleAdaptiveResize(
    session: TerminalSession,
    payload: { cols?: number; widthMode?: 'adaptive-phone' | 'mirror-fixed' },
  ): { ok: true } | { ok: false; code: 'session_not_ready' | 'adaptive_width_cols_invalid'; message: string } {
    const mirror = deps.getSessionMirror(session);
    if (!mirror) {
      return {
        ok: false,
        code: 'session_not_ready',
        message: 'resize requires an attached mirror',
      };
    }
    const leaseResult = updateAdaptiveWidthLease(session, mirror, payload, 'resize');
    if (!leaseResult.ok) {
      return leaseResult;
    }
    scheduleMirrorLiveSync(mirror, 0);
    return { ok: true };
  }

  function refreshAdaptiveWidthLeaseHeartbeat(session: TerminalSession) {
    if (!session.adaptiveWidthCols || !session.mirrorKey) {
      return;
    }
    const mirror = deps.getSessionMirror(session);
    if (!mirror) {
      return;
    }
    session.adaptiveWidthHeartbeatAt = Date.now();
    scheduleAdaptiveWidthLeaseExpiry(mirror);
  }

  function releaseAdaptiveWidthLease(session: TerminalSession, reason: string) {
    const mirror = deps.getSessionMirror(session);
    const hadLease = Boolean(session.adaptiveWidthCols);
    session.adaptiveWidthCols = null;
    session.adaptiveWidthHeartbeatAt = 0;
    if (!mirror || !hadLease) {
      return;
    }
    reconcileAdaptiveWidthLeases(mirror, reason);
  }

  async function handleInput(
    session: TerminalSession,
    data: string,
    shouldWrite?: () => boolean,
  ) {
    const mirror = deps.getSessionMirror(session);
    if (!mirror) {
      return false;
    }
    if (mirror.lifecycle === 'failed') {
      mirror.lifecycle = 'ready';
      mirror.consecutiveFailures = 0;
      console.log(`[${deps.logTimePrefix()}] mirror ${mirror.sessionName} recovered from failed by input`);
    }
    if (mirror.lifecycle === 'ready') {
      mirror.consecutiveFailures = 0;
      const wrote = await deps.enqueueLiveMirrorInput(mirror.sessionName, data, false, shouldWrite);
      if (wrote) {
        mirror.lastLiveActivityAt = Date.now();
        scheduleMirrorLiveSync(mirror, 0);
        return true;
      }
    }
    return false;
  }

  return {
    createMirror,
    destroyMirror,
    ensureSessionReady,
    sendBufferHeadToSession,
    flushPendingSubscriberBufferSync,
    refreshMirrorHeadForSession,
    syncMirrorCanonicalBuffer,
    scheduleMirrorLiveSync,
    resolveMirrorLiveSyncDelayForSubscriber,
    startMirror,
    attachTmux,
    handleAdaptiveResize,
    restorePersistedAdaptiveWidthBaselines,
    refreshAdaptiveWidthLeaseHeartbeat,
    releaseAdaptiveWidthLease,
    handleInput,
    disposeLiveMirrorInputBatch: (sessionName, reason) =>
      deps.disposeLiveMirrorInputBatch(sessionName, `destroy:${reason}`),
  };
}
