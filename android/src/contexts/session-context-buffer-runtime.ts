import {
  applyBufferSyncToSessionBuffer,
  createSessionBufferState,
  normalizeWireLines,
  sessionBuffersEqual,
} from '../lib/terminal-buffer';
import { runtimeDebugPrechecked, shouldCollectRuntimeDebugScope } from '../lib/runtime-debug';
import { summarizeSessionBufferForDebug } from '../lib/terminal-buffer-debug';
import type {
  ClientMessage,
  Session,
  SessionBufferState,
  TerminalBufferPayload,
  TerminalCell,
  TerminalCursorState,
  TerminalVisibleRange,
} from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import {
  buildDefaultSessionVisibleRange,
} from './session-visible-range-helpers';
import {
  buildSessionBufferSyncRequestPayload,
  hasImpossibleLocalWindow,
  shouldCatchUpFollowTailAfterBufferApply,
  shouldPullFollowBuffer,
  shouldPullVisibleRangeBuffer,
  type SessionBufferHeadState,
} from './session-buffer-planner-helpers';
import {
  doesSessionPullStateCoverRequest,
  doesSessionPullStateMatchExactLocalSnapshot,
  type SessionPullPurpose,
  type SessionPullStates,
} from './session-pull-state-helpers';
import { normalizeTerminalCursorState } from './session-wire-helpers';
import { buildBufferSyncRepairSignature } from '@zterm/shared/terminal/pull-state-planner';

interface MutableRefObject<T> {
  current: T;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

interface SessionDebugMetricsRecorder {
  recordRefreshRequest: (sessionId: string) => void;
}

interface SessionSyncRequestDebounceState {
  sentAt: number;
  requestStartIndex: number;
  requestEndIndex: number;
  knownRevision: number;
  localStartIndex: number;
  localEndIndex: number;
  targetHeadRevision: number;
  repairSignature: string;
}

const SESSION_SYNC_REQUEST_DEBOUNCE_MS = 33;

interface RevisionResetExpectation {
  revision: number;
  latestEndIndex: number;
  seenAt: number;
}

function getWireLineIndex(line: TerminalBufferPayload['lines'][number]) {
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

function isSparsePayloadWindow(payload: TerminalBufferPayload) {
  const startIndex = Math.max(0, Math.floor(payload.startIndex || 0));
  const endIndex = Math.max(startIndex, Math.floor(payload.endIndex || startIndex));
  const windowSize = Math.max(0, endIndex - startIndex);
  if (windowSize === 0) {
    return false;
  }
  const uniqueLineIndexes = new Set<number>();
  for (const line of payload.lines || []) {
    const index = getWireLineIndex(line);
    if (index === null || index < startIndex || index >= endIndex) {
      continue;
    }
    uniqueLineIndexes.add(index);
  }
  return uniqueLineIndexes.size < windowSize;
}

function terminalRowsEqual(left: TerminalCell[], right: TerminalCell[]) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) {
      return false;
    }
    if (a.char !== b.char || a.fg !== b.fg || a.bg !== b.bg || a.flags !== b.flags || a.width !== b.width) {
      return false;
    }
  }
  return true;
}

function localIndexIsGap(buffer: SessionBufferState, absoluteIndex: number) {
  for (const range of buffer.gapRanges || []) {
    if (absoluteIndex >= range.startIndex && absoluteIndex < range.endIndex) {
      return true;
    }
  }
  return false;
}

function detectSameRevisionNonGapOverwrite(options: {
  localBuffer: SessionBufferState;
  payload: TerminalBufferPayload;
}) {
  const startIndex = Math.max(0, Math.floor(options.payload.startIndex || 0));
  const endIndex = Math.max(startIndex, Math.floor(options.payload.endIndex || startIndex));

  let conflictCount = 0;
  let firstConflictIndex: number | null = null;
  for (const line of normalizeWireLines(options.payload.lines || [], options.payload.cols || options.localBuffer.cols || 80)) {
    if (line.index < options.localBuffer.startIndex || line.index >= options.localBuffer.endIndex) {
      continue;
    }
    if (localIndexIsGap(options.localBuffer, line.index)) {
      continue;
    }
    const localRow = options.localBuffer.lines[line.index - options.localBuffer.startIndex];
    if (localRow && !terminalRowsEqual(localRow, line.cells)) {
      conflictCount += 1;
      if (firstConflictIndex === null) {
        firstConflictIndex = line.index;
      }
    }
  }

  if (conflictCount === 0) {
    return null;
  }
  return {
    conflictCount,
    firstConflictIndex,
    incomingStartIndex: startIndex,
    incomingEndIndex: endIndex,
  };
}

function resolvePendingSameRevisionRefreshKey(options: {
  sessionId: string;
  payload: TerminalBufferPayload;
  localBuffer: SessionBufferState;
  refs: {
    lastSyncRequestAtRef?: MutableRefObject<Map<string, SessionSyncRequestDebounceState>>;
  };
}) {
  const requests = options.refs.lastSyncRequestAtRef?.current;
  if (!requests) {
    return null;
  }
  const incomingRevision = Math.max(0, Math.floor(options.payload.revision || 0));
  const incomingStartIndex = Math.max(0, Math.floor(options.payload.startIndex || 0));
  const incomingEndIndex = Math.max(incomingStartIndex, Math.floor(options.payload.endIndex || incomingStartIndex));
  const localRevision = Math.max(0, Math.floor(options.localBuffer.revision || 0));
  for (const purpose of ['tail-refresh', 'reading-repair'] as const) {
    const pending = requests.get(`${options.sessionId}:${purpose}`);
    if (!pending) {
      continue;
    }
    const pendingStart = Math.max(0, Math.floor(pending.requestStartIndex || 0));
    const pendingEnd = Math.max(pendingStart, Math.floor(pending.requestEndIndex || pendingStart));
    const isWithinPendingWindow = incomingStartIndex >= pendingStart && incomingEndIndex <= pendingEnd;
    if (
      isWithinPendingWindow
      && Math.max(0, Math.floor(pending.targetHeadRevision || 0)) === incomingRevision
      && Math.max(0, Math.floor(pending.knownRevision || 0)) === localRevision
    ) {
      return `${options.sessionId}:${purpose}`;
    }
  }
  return null;
}

function resolvePostApplyVisibleRange(options: {
  session: Session;
  previousBuffer: SessionBufferState;
  nextBuffer: SessionBufferState;
  visibleRange: TerminalVisibleRange | null;
}) {
  const visibleRange = options.visibleRange;
  if (!visibleRange) {
    return buildDefaultSessionVisibleRange(options.session, undefined, options.nextBuffer);
  }
  const previousTailEndIndex = Math.max(
    0,
    Math.floor(options.previousBuffer.bufferTailEndIndex || options.previousBuffer.endIndex || 0),
  );
  const previousHasLocalWindow = Math.max(
    0,
    Math.floor(options.previousBuffer.endIndex || 0),
  ) > Math.max(0, Math.floor(options.previousBuffer.startIndex || 0));
  const nextTailEndIndex = Math.max(
    0,
    Math.floor(options.nextBuffer.bufferTailEndIndex || options.nextBuffer.endIndex || 0),
  );
  const visibleEndIndex = Math.max(0, Math.floor(visibleRange.endIndex || 0));
  const wasFollowingPreviousTail = previousHasLocalWindow && visibleEndIndex >= previousTailEndIndex - 1;
  if (!wasFollowingPreviousTail || nextTailEndIndex === previousTailEndIndex) {
    return visibleRange;
  }
  return buildDefaultSessionVisibleRange(options.session, visibleRange, options.nextBuffer);
}

export function handleBufferHeadRuntime(options: {
  sessionId: string;
  latestRevision: number;
  latestEndIndex: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  cursor?: TerminalCursorState | null;
  cursorKeysApp?: boolean;
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    sessionBufferHeadsRef: MutableRefObject<Map<string, SessionBufferHeadState>>;
    lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
    sessionRevisionResetRef: MutableRefObject<Map<string, RevisionResetExpectation>>;
    lastSyncRequestAtRef: MutableRefObject<Map<string, SessionSyncRequestDebounceState>>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, TerminalVisibleRange>>;
    sessionBufferStoreRef: MutableRefObject<{ commitBuffer: (sessionId: string, buffer: SessionBufferState) => boolean }>;
    sessionHeadStoreRef: MutableRefObject<{ setHead: (sessionId: string, head: { daemonHeadRevision: number; daemonHeadEndIndex: number }) => boolean }>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportResource?: (sessionId: string) => { socket?: BridgeTransportSocket | null } | null;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  commitSessionBufferUpdate: (sessionId: string, nextBuffer: SessionBufferState) => boolean;
  scheduleSessionRenderCommit: (sessionId: string) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
  shouldAcceptSessionLiveBuffer?: (sessionId: string) => boolean;
  runtimeDebug: RuntimeDebugFn;
  requestSessionBufferSync: (
    sessionId: string,
    requestOptions?: {
      reason?: string;
      purpose?: SessionPullPurpose;
      sessionOverride?: Session | null;
      liveHead?: SessionBufferHeadState | null;
      invalidLocalWindow?: boolean;
      requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
    },
  ) => boolean;
}) {
  let session = options.refs.stateRef.current.sessions.find((item) => item.id === options.sessionId) || null;
  const ws = options.readSessionTransportResource?.(options.sessionId)?.socket
    || options.readSessionTransportSocket(options.sessionId);
  if (
    !session
    || (session.state !== 'connected' && session.state !== 'connecting' && session.state !== 'reconnecting')
    || !ws
    || ws.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  options.refs.sessionBufferHeadsRef.current.set(options.sessionId, {
    revision: options.latestRevision,
    latestEndIndex: options.latestEndIndex,
    availableStartIndex: Number.isFinite(options.availableStartIndex)
      ? Math.max(0, Math.floor(options.availableStartIndex || 0))
      : undefined,
    availableEndIndex: Number.isFinite(options.availableEndIndex)
      ? Math.max(0, Math.floor(options.availableEndIndex || 0))
      : undefined,
    seenAt: Date.now(),
  });
  options.refs.lastHeadRequestAtRef.current.set(options.sessionId, Date.now());


  const activeTransport = options.isSessionTransportActive(options.sessionId);
  const shouldAcceptLiveBuffer = activeTransport
    || Boolean(options.shouldAcceptSessionLiveBuffer?.(options.sessionId));
  if (!shouldAcceptLiveBuffer) {
    options.runtimeDebug('session.buffer.head.inactive-drop', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      latestRevision: options.latestRevision,
      latestEndIndex: options.latestEndIndex,
      availableStartIndex: options.availableStartIndex ?? null,
      availableEndIndex: options.availableEndIndex ?? null,
    });
    return;
  }

  const normalizedCursor = normalizeTerminalCursorState(options.cursor);
  const localBuffer = options.readSessionBufferSnapshot(options.sessionId);
  const normalizedCursorKeysApp = typeof options.cursorKeysApp === 'boolean'
    ? options.cursorKeysApp
    : localBuffer.cursorKeysApp;
  const cursorChanged = (
    (localBuffer.cursor?.rowIndex ?? null) !== (normalizedCursor?.rowIndex ?? null)
    || (localBuffer.cursor?.col ?? null) !== (normalizedCursor?.col ?? null)
    || (localBuffer.cursor?.visible ?? null) !== (normalizedCursor?.visible ?? null)
  );
  const cursorKeysAppChanged = localBuffer.cursorKeysApp !== normalizedCursorKeysApp;
  if (cursorChanged || cursorKeysAppChanged) {
    const nextBuffer = {
      ...localBuffer,
      cursorKeysApp: normalizedCursorKeysApp,
      cursor: normalizedCursor,
    };
    const changed = options.commitSessionBufferUpdate(options.sessionId, nextBuffer);
    if (changed) {
      options.runtimeDebug('session.buffer.head.cursor-metadata-applied-no-body-render', {
        sessionId: options.sessionId,
        activeSessionId: options.refs.stateRef.current.activeSessionId,
        latestRevision: options.latestRevision,
        latestEndIndex: options.latestEndIndex,
      });
      session = {
        ...session,
        buffer: nextBuffer,
      };
    }
  }

  const headChanged = options.refs.sessionHeadStoreRef.current.setHead(options.sessionId, {
    daemonHeadRevision: options.latestRevision,
    daemonHeadEndIndex: options.latestEndIndex,
  });
  void headChanged;
  const liveHead = options.refs.sessionBufferHeadsRef.current.get(options.sessionId) || null;

  const plannerBuffer = cursorChanged
    ? {
        ...localBuffer,
        cursorKeysApp: normalizedCursorKeysApp,
        cursor: normalizedCursor,
      }
    : localBuffer;
  const localRevision = Math.max(0, Math.floor(plannerBuffer.revision || 0));
  const localEndIndex = Math.max(0, Math.floor(plannerBuffer.endIndex || 0));
  const localWindowInvalid = hasImpossibleLocalWindow(session, liveHead, plannerBuffer);
  const revisionResetDetected = options.latestRevision < localRevision;
  if (revisionResetDetected) {
    options.refs.sessionRevisionResetRef.current.set(options.sessionId, {
      revision: options.latestRevision,
      latestEndIndex: options.latestEndIndex,
      seenAt: Date.now(),
    });
    options.runtimeDebug('session.buffer.revision-reset.detected', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      latestRevision: options.latestRevision,
      latestEndIndex: options.latestEndIndex,
      localRevision,
      localEndIndex,
    });
  } else {
    options.refs.sessionRevisionResetRef.current.delete(options.sessionId);
  }

  options.runtimeDebug('session.buffer.head', {
    sessionId: options.sessionId,
    activeSessionId: options.refs.stateRef.current.activeSessionId,
    latestRevision: options.latestRevision,
    latestEndIndex: options.latestEndIndex,
    availableStartIndex: liveHead?.availableStartIndex ?? null,
    availableEndIndex: liveHead?.availableEndIndex ?? null,
    cursor: normalizedCursor,
    cursorKeysApp: normalizedCursorKeysApp,
    localRevision,
    localEndIndex,
    localWindowInvalid,
    visibleRange: options.refs.sessionVisibleRangeRef.current.get(options.sessionId) || null,
  });

  const demandSession: Session = {
    ...session,
    daemonHeadRevision: options.latestRevision,
    daemonHeadEndIndex: options.latestEndIndex,
  };
  if (localWindowInvalid && liveHead) {
    options.runtimeDebug('session.buffer.window.invalid', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      latestRevision: options.latestRevision,
      latestEndIndex: options.latestEndIndex,
      availableStartIndex: liveHead.availableStartIndex ?? null,
      availableEndIndex: liveHead.availableEndIndex ?? null,
      localStartIndex: plannerBuffer.startIndex,
      localEndIndex: plannerBuffer.endIndex,
      localBufferHeadStartIndex: plannerBuffer.bufferHeadStartIndex,
      localBufferTailEndIndex: plannerBuffer.bufferTailEndIndex,
    });
  }
  const visibleRange = options.refs.sessionVisibleRangeRef.current.get(options.sessionId) || null;
  if (!visibleRange) {
    const isActiveSession = options.refs.stateRef.current.activeSessionId === options.sessionId;
    if (isActiveSession && liveHead) {
      const viewportRows = Math.max(1, Math.floor(plannerBuffer.rows || session.buffer?.rows || 24));
      const requestEndIndex = Math.max(0, Math.floor(options.latestEndIndex || liveHead.latestEndIndex || 0));
      const requestStartIndex = Math.max(
        Math.max(0, Math.floor(liveHead.availableStartIndex || 0)),
        requestEndIndex - viewportRows,
      );
      options.runtimeDebug('session.buffer.head.no-visible-range-active-tail-bootstrap', {
        sessionId: options.sessionId,
        activeSessionId: options.refs.stateRef.current.activeSessionId,
        latestRevision: options.latestRevision,
        latestEndIndex: options.latestEndIndex,
        localRevision,
        localStartIndex: plannerBuffer.startIndex,
        localEndIndex: plannerBuffer.endIndex,
        requestStartIndex,
        requestEndIndex,
        viewportRows,
      });
      options.requestSessionBufferSync(options.sessionId, {
        reason: 'buffer-head-no-visible-range-active-bootstrap',
        purpose: 'tail-refresh',
        sessionOverride: demandSession,
        liveHead,
        requestWindowOverride: {
          requestStartIndex,
          requestEndIndex,
        },
      });
      return;
    }
    options.runtimeDebug('session.buffer.head.no-visible-range-skip-body-pull', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      latestRevision: options.latestRevision,
      latestEndIndex: options.latestEndIndex,
      localRevision,
      localStartIndex: plannerBuffer.startIndex,
      localEndIndex: plannerBuffer.endIndex,
    });
    return;
  }
  const needsTailRefresh = (
    revisionResetDetected
    || localWindowInvalid
    || shouldPullFollowBuffer(demandSession, visibleRange, plannerBuffer)
  );
  if (needsTailRefresh) {
    options.requestSessionBufferSync(options.sessionId, {
      reason:
        revisionResetDetected ? 'buffer-head-revision-reset'
          : localWindowInvalid ? 'buffer-head-invalid-local-window'
            : 'buffer-head-update',
      purpose: 'tail-refresh',
      sessionOverride: demandSession,
      liveHead,
      invalidLocalWindow: localWindowInvalid,
    });
    return;
  }

  const needsReadingRepair = shouldPullVisibleRangeBuffer(demandSession, visibleRange, liveHead, plannerBuffer);
  if (!needsReadingRepair) {
    return;
  }

  options.requestSessionBufferSync(options.sessionId, {
    reason: 'buffer-head-visible-range-repair',
    purpose: 'reading-repair',
    sessionOverride: demandSession,
  });
}

export function requestSessionBufferSyncRuntime(options: {
  sessionId: string;
  requestOptions?: {
    ws?: BridgeTransportSocket | null;
    reason?: string;
    purpose?: SessionPullPurpose;
    sessionOverride?: Session | null;
    liveHead?: SessionBufferHeadState | null;
    invalidLocalWindow?: boolean;
    requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
    requestMissingRangesOverride?: Array<{ startIndex: number; endIndex: number }> | null;
  };
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, TerminalVisibleRange>>;
    sessionBufferHeadsRef: MutableRefObject<Map<string, SessionBufferHeadState>>;
    sessionPullStateRef: MutableRefObject<Map<string, SessionPullStates>>;
    lastSyncRequestAtRef: MutableRefObject<Map<string, SessionSyncRequestDebounceState>>;
    pendingInputTailRefreshRef: MutableRefObject<Map<string, { requestedAt: number; localRevision: number }>>;
    pendingConnectTailRefreshRef: MutableRefObject<Set<string>>;
    pendingResumeTailRefreshRef: MutableRefObject<Set<string>>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportResource?: (sessionId: string) => { socket?: BridgeTransportSocket | null } | null;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  clearSessionPullState: (sessionId: string, purpose?: SessionPullPurpose) => void;
  sendSocketPayload: (
    sessionId: string,
    ws: BridgeTransportSocket,
    data: string | ArrayBuffer,
    sendOptions?: {
      pullPurpose?: SessionPullPurpose;
      targetHeadRevision?: number;
      targetStartIndex?: number;
      targetEndIndex?: number;
      requestKnownRevision?: number;
      requestLocalStartIndex?: number;
      requestLocalEndIndex?: number;
      repairSignature?: string;
    },
  ) => void;
  runtimeDebug: RuntimeDebugFn;
  resolveTerminalRefreshCadence: () => {
    pullRequestStaleMs: number;
    minTailRefreshGapMs: number;
    readingSyncDelayMs: number;
  };
}) {
  const session = options.requestOptions?.sessionOverride
    || options.refs.stateRef.current.sessions.find((item) => item.id === options.sessionId)
    || null;
  const activeWs = options.readSessionTransportResource?.(options.sessionId)?.socket
    || options.readSessionTransportSocket(options.sessionId);
  const requestedWs = options.requestOptions?.ws || null;
  if (requestedWs && activeWs && activeWs !== requestedWs) {
    return false;
  }
  const targetWs = requestedWs || activeWs;
  if (!session || !targetWs || targetWs.readyState !== WebSocket.OPEN) {
    return false;
  }
  const localBuffer = options.readSessionBufferSnapshot(options.sessionId);
  const visibleRange = options.refs.sessionVisibleRangeRef.current.get(options.sessionId);
  const requestPurpose = options.requestOptions?.purpose || 'tail-refresh';
  const liveHead = options.refs.sessionBufferHeadsRef.current.get(options.sessionId) || null;
  const explicitWindowOverride = options.requestOptions?.requestWindowOverride || null;
  const explicitMissingRangesOverride = options.requestOptions?.requestMissingRangesOverride || null;
  if (!visibleRange && !explicitWindowOverride && !explicitMissingRangesOverride) {
    options.runtimeDebug('session.buffer.request.no-visible-range-skip', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      reason: options.requestOptions?.reason || null,
      purpose: requestPurpose,
    });
    return false;
  }
  const effectiveSession = liveHead
    ? {
        ...session,
        daemonHeadRevision: liveHead.revision,
        daemonHeadEndIndex: liveHead.latestEndIndex,
      }
    : session;
  const payload = buildSessionBufferSyncRequestPayload(
    effectiveSession,
    visibleRange,
    {
      purpose: options.requestOptions?.purpose,
      sameEndRefreshMode:
        options.refs.pendingConnectTailRefreshRef.current.has(options.sessionId)
        || options.refs.pendingResumeTailRefreshRef.current.has(options.sessionId)
          ? 'visible-window'
          : options.refs.pendingInputTailRefreshRef.current.has(options.sessionId)
            ? 'visible-window'
            : 'auto',
      forceSameEndRefresh: false,
      liveHead: options.requestOptions?.liveHead || liveHead || null,
      invalidLocalWindow: Boolean(options.requestOptions?.invalidLocalWindow),
      requestWindowOverride: explicitWindowOverride,
      requestMissingRangesOverride: explicitMissingRangesOverride,
      bufferOverride: localBuffer,
    },
  );
  const inFlightPull = (options.refs.sessionPullStateRef.current.get(options.sessionId) || null)?.[requestPurpose] || null;
  const cadence = options.resolveTerminalRefreshCadence();
  const debounceThresholdMs = SESSION_SYNC_REQUEST_DEBOUNCE_MS;
  if (inFlightPull) {
    const pullAgeMs = Math.max(0, Date.now() - Math.max(0, Math.floor(inFlightPull.startedAt || 0)));
    if (pullAgeMs >= cadence.pullRequestStaleMs) {
      options.runtimeDebug('session.buffer.pull.stale-expire', {
        sessionId: options.sessionId,
        activeSessionId: options.refs.stateRef.current.activeSessionId,
        reason: options.requestOptions?.reason || null,
        purpose: requestPurpose,
        pullAgeMs,
        thresholdMs: cadence.pullRequestStaleMs,
        stalePull: inFlightPull,
      });
      options.clearSessionPullState(options.sessionId, requestPurpose);
    } else {
    const authoritativeHeadKnown = Boolean(
      (options.requestOptions?.liveHead && Number.isFinite(options.requestOptions.liveHead.latestEndIndex))
      || Math.max(0, Math.floor(effectiveSession.daemonHeadRevision || 0)) > 0
      || Math.max(0, Math.floor(effectiveSession.daemonHeadEndIndex || 0)) > 0
    );
    if (doesSessionPullStateMatchExactLocalSnapshot(
      inFlightPull,
      payload,
      Math.max(0, Math.floor(effectiveSession.daemonHeadRevision || 0)),
    )) {
      return false;
    }
    if (
      requestPurpose === 'reading-repair'
      && !authoritativeHeadKnown
      && inFlightPull.requestKnownRevision === Math.max(0, Math.floor(payload.knownRevision || 0))
      && inFlightPull.requestLocalStartIndex === Math.max(0, Math.floor(payload.localStartIndex || 0))
      && inFlightPull.requestLocalEndIndex === Math.max(0, Math.floor(payload.localEndIndex || 0))
    ) {
      return false;
    }
    if (doesSessionPullStateCoverRequest(inFlightPull, payload)) {
      return false;
    }
    options.runtimeDebug('session.buffer.pull.superseded', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      reason: options.requestOptions?.reason || null,
      purpose: requestPurpose,
      previous: inFlightPull,
      next: {
        targetHeadRevision: Math.max(0, Math.floor(effectiveSession.daemonHeadRevision || 0)),
        requestStartIndex: payload.requestStartIndex,
        requestEndIndex: payload.requestEndIndex,
      },
    });
    options.clearSessionPullState(options.sessionId, requestPurpose);
    }
  }

  const now = Date.now();
  const debounceKey = `${options.sessionId}:${requestPurpose}`;
  const previousSyncRequest = options.refs.lastSyncRequestAtRef.current.get(debounceKey) || null;
  const targetHeadRevision = Math.max(0, Math.floor(effectiveSession.daemonHeadRevision || 0));
  const requestKnownRevision = Math.max(0, Math.floor(payload.knownRevision || 0));
  const requestLocalStartIndex = Math.max(0, Math.floor(payload.localStartIndex || 0));
  const requestLocalEndIndex = Math.max(0, Math.floor(payload.localEndIndex || 0));
  const repairSignature = buildBufferSyncRepairSignature(payload.missingRanges);
  const repairRanges = Array.isArray(payload.missingRanges)
    ? payload.missingRanges
      .map((range) => ({
        startIndex: Math.max(0, Math.floor(range?.startIndex ?? 0)),
        endIndex: Math.max(0, Math.floor(range?.endIndex ?? 0)),
      }))
      .filter((range) => range.endIndex > range.startIndex)
    : [];
  const repairTargetStartIndex = repairRanges.length > 0
    ? repairRanges[0]!.startIndex
    : null;
  const repairTargetEndIndex = repairRanges.length > 0
    ? repairRanges[repairRanges.length - 1]!.endIndex
    : null;
  const requestTargetStartIndex = requestPurpose === 'reading-repair' && repairTargetStartIndex !== null
    ? repairTargetStartIndex
    : Math.max(0, Math.floor(payload.requestStartIndex || 0));
  const requestTargetEndIndex = Math.max(requestTargetStartIndex, Math.floor(
    requestPurpose === 'reading-repair'
      ? (repairTargetEndIndex ?? payload.requestEndIndex ?? 0)
      : (
        effectiveSession.daemonHeadEndIndex
        || payload.requestEndIndex
        || localBuffer.bufferTailEndIndex
        || localBuffer.endIndex
        || 0
      ),
  ));
  const isSemanticDuplicateWithinDebounce = Boolean(
    previousSyncRequest
    && now - previousSyncRequest.sentAt < debounceThresholdMs
    && previousSyncRequest.targetHeadRevision === targetHeadRevision
    && previousSyncRequest.requestStartIndex === requestTargetStartIndex
    && previousSyncRequest.requestEndIndex === requestTargetEndIndex
    && previousSyncRequest.knownRevision === requestKnownRevision
    && previousSyncRequest.localStartIndex === requestLocalStartIndex
    && previousSyncRequest.localEndIndex === requestLocalEndIndex
    && previousSyncRequest.repairSignature === repairSignature
  );
  if (isSemanticDuplicateWithinDebounce) {
    options.runtimeDebug('session.buffer.request.debounced', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      reason: options.requestOptions?.reason || null,
      purpose: requestPurpose,
      debounceThresholdMs,
      previous: previousSyncRequest,
      next: {
        targetHeadRevision,
        requestStartIndex: requestTargetStartIndex,
        requestEndIndex: requestTargetEndIndex,
        requestKnownRevision,
        requestLocalStartIndex,
        requestLocalEndIndex,
        repairSignature,
      },
    });
    return false;
  }

  options.runtimeDebug('session.buffer.request', {
    sessionId: options.sessionId,
    activeSessionId: options.refs.stateRef.current.activeSessionId,
    reason: options.requestOptions?.reason || null,
    purpose: requestPurpose,
    payload,
  });
  options.refs.lastSyncRequestAtRef.current.set(debounceKey, {
    sentAt: now,
    requestStartIndex: requestTargetStartIndex,
    requestEndIndex: requestTargetEndIndex,
    knownRevision: requestKnownRevision,
    localStartIndex: requestLocalStartIndex,
    localEndIndex: requestLocalEndIndex,
    targetHeadRevision,
    repairSignature,
  });
  options.sendSocketPayload(options.sessionId, targetWs, JSON.stringify({
    type: 'buffer-sync-request',
    payload: {
      ...payload,
      requestedAt: now,
    },
  } satisfies ClientMessage), {
    pullPurpose: requestPurpose,
    targetHeadRevision,
    targetStartIndex: requestTargetStartIndex,
    targetEndIndex: requestTargetEndIndex,
    requestKnownRevision,
    requestLocalStartIndex,
    requestLocalEndIndex,
    repairSignature,
  });
  return true;
}

export function requestSessionBufferHeadRuntime(options: {
  sessionId: string;
  ws?: BridgeTransportSocket | null;
  force?: boolean;
  trackProbe?: boolean;
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[] }>;
    lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
    staleTransportProbeAtRef?: MutableRefObject<Map<string, number>>;
    sessionDebugMetricsStoreRef: MutableRefObject<SessionDebugMetricsRecorder>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportResource?: (sessionId: string) => { socket?: BridgeTransportSocket | null } | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  resolveTerminalRefreshCadence: () => { headTickMs: number };
}) {
  const activeWs = options.readSessionTransportResource?.(options.sessionId)?.socket
    || options.readSessionTransportSocket(options.sessionId)
    || null;
  if (options.ws && activeWs && activeWs !== options.ws) {
    return false;
  }
  const targetWs = options.ws || activeWs;
  const session = options.refs.stateRef.current.sessions.find((item) => item.id === options.sessionId) || null;
  if (
    !session
    || (session.state !== 'connected' && session.state !== 'connecting' && session.state !== 'reconnecting')
    || !targetWs
    || targetWs.readyState !== WebSocket.OPEN
  ) {
    return false;
  }
  const cadence = options.resolveTerminalRefreshCadence();
  const now = Date.now();
  const lastRequestedAt = options.refs.lastHeadRequestAtRef.current.get(options.sessionId) || 0;
  if (!options.force && now - lastRequestedAt < cadence.headTickMs) {
    return false;
  }
  options.refs.lastHeadRequestAtRef.current.set(options.sessionId, now);
  if (
    options.trackProbe !== false
    && !options.refs.staleTransportProbeAtRef?.current.has(options.sessionId)
  ) {
    options.refs.staleTransportProbeAtRef?.current.set(options.sessionId, now);
  }
  options.refs.sessionDebugMetricsStoreRef.current.recordRefreshRequest(options.sessionId);
  options.sendSocketPayload(options.sessionId, targetWs, JSON.stringify({
    type: 'buffer-head-request',
  } satisfies ClientMessage));
  return true;
}

export function applyIncomingBufferSyncRuntime(options: {
  sessionId: string;
  payload: TerminalBufferPayload;
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    sessionRevisionResetRef: MutableRefObject<Map<string, RevisionResetExpectation>>;
    sessionBufferHeadsRef: MutableRefObject<Map<string, SessionBufferHeadState>>;
    pendingInputTailRefreshRef: MutableRefObject<Map<string, { requestedAt: number; localRevision: number }>>;
    pendingConnectTailRefreshRef: MutableRefObject<Set<string>>;
    pendingResumeTailRefreshRef: MutableRefObject<Set<string>>;
    lastSyncRequestAtRef?: MutableRefObject<Map<string, SessionSyncRequestDebounceState>>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, TerminalVisibleRange>>;
  };
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  resolveSessionCacheLines: (rows?: number | null) => number;
  summarizeBufferPayload: (payload: TerminalBufferPayload) => Record<string, unknown>;
  runtimeDebug: RuntimeDebugFn;
  commitSessionBufferUpdate: (sessionId: string, nextBuffer: SessionBufferState) => boolean;
  scheduleSessionRenderCommit: (sessionId: string) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
  shouldAcceptSessionLiveBuffer?: (sessionId: string) => boolean;
  requestSessionBufferSync: (
    sessionId: string,
    requestOptions?: {
      reason?: string;
      purpose?: SessionPullPurpose;
      sessionOverride?: Session | null;
      liveHead?: SessionBufferHeadState | null;
      invalidLocalWindow?: boolean;
      requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
      requestMissingRangesOverride?: Array<{ startIndex: number; endIndex: number }> | null;
    },
  ) => boolean;
}) {
  const session = options.refs.stateRef.current.sessions.find((item) => item.id === options.sessionId) || null;
  if (!session) {
    return;
  }
  const localBuffer = options.readSessionBufferSnapshot(options.sessionId);
  const activeTransport = options.isSessionTransportActive(options.sessionId);
  const shouldAcceptLiveBuffer = activeTransport
    || Boolean(options.shouldAcceptSessionLiveBuffer?.(options.sessionId));
  if (!shouldAcceptLiveBuffer) {
    options.refs.pendingInputTailRefreshRef.current.delete(options.sessionId);
    options.refs.pendingConnectTailRefreshRef.current.delete(options.sessionId);
    options.refs.pendingResumeTailRefreshRef.current.delete(options.sessionId);
    options.runtimeDebug('session.buffer.sync.inactive-drop', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      incoming: options.summarizeBufferPayload(options.payload),
      localRevision: localBuffer.revision,
      localStartIndex: localBuffer.startIndex,
      localEndIndex: localBuffer.endIndex,
    });
    return;
  }
  const revisionResetExpectation = options.refs.sessionRevisionResetRef.current.get(options.sessionId) || null;
  const lowerRevisionPayload = revisionResetExpectation
    && Math.max(0, Math.floor(options.payload.revision || 0)) <= Math.max(0, Math.floor(localBuffer.revision || 0))
      ? options.payload
      : null;
  if (
    revisionResetExpectation
    && lowerRevisionPayload
    && localBuffer.lines.length > 0
    && lowerRevisionPayload.lines.length === 0
    && Math.max(0, Math.floor(lowerRevisionPayload.endIndex || 0)) <= Math.max(0, Math.floor(lowerRevisionPayload.startIndex || 0))
  ) {
    options.runtimeDebug('session.buffer.revision-reset.wait-for-nonempty-payload', {
      sessionId: options.sessionId,
      expectation: revisionResetExpectation,
      localRevision: localBuffer.revision,
      localStartIndex: localBuffer.startIndex,
      localEndIndex: localBuffer.endIndex,
      localLineCount: localBuffer.lines.length,
      incomingRevision: lowerRevisionPayload.revision,
      incomingStartIndex: lowerRevisionPayload.startIndex,
      incomingEndIndex: lowerRevisionPayload.endIndex,
      incomingLineCount: lowerRevisionPayload.lines.length,
    });
    options.refs.lastSyncRequestAtRef?.current.delete(`${options.sessionId}:tail-refresh`);
    options.requestSessionBufferSync(options.sessionId, {
      reason: 'revision-reset-empty-payload-retry',
      purpose: 'tail-refresh',
      sessionOverride: {
        ...session,
        daemonHeadRevision: revisionResetExpectation.revision,
        daemonHeadEndIndex: revisionResetExpectation.latestEndIndex,
      },
      liveHead: options.refs.sessionBufferHeadsRef.current.get(options.sessionId) || {
        revision: revisionResetExpectation.revision,
        latestEndIndex: revisionResetExpectation.latestEndIndex,
        seenAt: revisionResetExpectation.seenAt,
      },
    });
    return;
  }

  let nextBuffer = (
    revisionResetExpectation && lowerRevisionPayload
      ? createSessionBufferState({
          lines: [],
          startIndex: 0,
          endIndex: 0,
          bufferTailEndIndex: 0,
          cols: lowerRevisionPayload.cols,
          rows: lowerRevisionPayload.rows,
          cursorKeysApp: lowerRevisionPayload.cursorKeysApp,
          cursor: lowerRevisionPayload.cursor,
          revision: 0,
          cacheLines: options.resolveSessionCacheLines(lowerRevisionPayload.rows || localBuffer.rows),
        })
      : localBuffer
  );

  if (revisionResetExpectation && lowerRevisionPayload) {
    options.runtimeDebug('session.buffer.revision-reset.apply', {
      sessionId: options.sessionId,
      expectation: revisionResetExpectation,
      localRevision: localBuffer.revision,
      incomingRevision: lowerRevisionPayload.revision,
      incomingStartIndex: lowerRevisionPayload.startIndex,
      incomingEndIndex: lowerRevisionPayload.endIndex,
    });
  }

  const incomingRevision = Math.max(0, Math.floor(options.payload.revision || 0));
  const localRevision = Math.max(0, Math.floor(localBuffer.revision || 0));
  if (
    !revisionResetExpectation
    && localRevision > 0
    && incomingRevision < localRevision
  ) {
    const liveHead = options.refs.sessionBufferHeadsRef.current.get(options.sessionId) || {
      revision: localRevision,
      latestEndIndex: Math.max(0, Math.floor(localBuffer.bufferTailEndIndex || localBuffer.endIndex || 0)),
      availableStartIndex: Math.max(0, Math.floor(localBuffer.bufferHeadStartIndex || localBuffer.startIndex || 0)),
      availableEndIndex: Math.max(0, Math.floor(localBuffer.bufferTailEndIndex || localBuffer.endIndex || 0)),
      seenAt: Date.now(),
    };
    options.refs.lastSyncRequestAtRef?.current.delete(`${options.sessionId}:tail-refresh`);
    options.runtimeDebug('session.buffer.sync.stale-lower-revision-drop', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      localRevision,
      incomingRevision,
      localStartIndex: localBuffer.startIndex,
      localEndIndex: localBuffer.endIndex,
      incoming: options.summarizeBufferPayload(options.payload),
    });
    options.requestSessionBufferSync(options.sessionId, {
      reason: 'buffer-sync-stale-lower-revision-drop',
      purpose: 'tail-refresh',
      sessionOverride: {
        ...session,
        daemonHeadRevision: liveHead.revision,
        daemonHeadEndIndex: liveHead.latestEndIndex,
      },
      liveHead,
    });
    return;
  }
  const sameRevisionOverwrite = (
    !revisionResetExpectation
    && localRevision > 0
    && incomingRevision === localRevision
      ? detectSameRevisionNonGapOverwrite({
          localBuffer,
          payload: options.payload,
        })
      : null
  );
  const pendingSameRevisionRefreshKey = sameRevisionOverwrite
    ? resolvePendingSameRevisionRefreshKey({
        sessionId: options.sessionId,
        payload: options.payload,
        localBuffer,
        refs: options.refs,
      })
    : null;
  if (sameRevisionOverwrite && !pendingSameRevisionRefreshKey) {
    options.runtimeDebug('session.buffer.sync.stale-same-revision-drop', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      localRevision,
      incomingRevision,
      localStartIndex: localBuffer.startIndex,
      localEndIndex: localBuffer.endIndex,
      incomingStartIndex: sameRevisionOverwrite.incomingStartIndex,
      incomingEndIndex: sameRevisionOverwrite.incomingEndIndex,
      conflictCount: sameRevisionOverwrite.conflictCount,
      firstConflictIndex: sameRevisionOverwrite.firstConflictIndex,
      incoming: options.summarizeBufferPayload(options.payload),
    });
    return;
  }
  if (sameRevisionOverwrite && pendingSameRevisionRefreshKey) {
    options.refs.lastSyncRequestAtRef?.current.delete(pendingSameRevisionRefreshKey);
    options.runtimeDebug('session.buffer.sync.same-revision-requested-overwrite-apply', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      localRevision,
      incomingRevision,
      localStartIndex: localBuffer.startIndex,
      localEndIndex: localBuffer.endIndex,
      incomingStartIndex: sameRevisionOverwrite.incomingStartIndex,
      incomingEndIndex: sameRevisionOverwrite.incomingEndIndex,
      conflictCount: sameRevisionOverwrite.conflictCount,
      firstConflictIndex: sameRevisionOverwrite.firstConflictIndex,
      incoming: options.summarizeBufferPayload(options.payload),
    });
  }
  if (
    localRevision > 0
    && incomingRevision > localRevision + 1
    && isSparsePayloadWindow(options.payload)
  ) {
    const liveHead = options.refs.sessionBufferHeadsRef.current.get(options.sessionId) || {
      revision: incomingRevision,
      latestEndIndex: Number.isFinite(options.payload.availableEndIndex)
        ? Math.max(0, Math.floor(options.payload.availableEndIndex || 0))
        : Math.max(0, Math.floor(options.payload.endIndex || 0)),
      availableStartIndex: Number.isFinite(options.payload.availableStartIndex)
        ? Math.max(0, Math.floor(options.payload.availableStartIndex || 0))
        : undefined,
      availableEndIndex: Number.isFinite(options.payload.availableEndIndex)
        ? Math.max(0, Math.floor(options.payload.availableEndIndex || 0))
        : undefined,
      seenAt: Date.now(),
    };
    const incomingStartIndex = Math.max(0, Math.floor(options.payload.startIndex || 0));
    const incomingEndIndex = Math.max(incomingStartIndex, Math.floor(options.payload.endIndex || incomingStartIndex));
    options.refs.lastSyncRequestAtRef?.current.delete(`${options.sessionId}:tail-refresh`);
    options.runtimeDebug('session.buffer.sync.revision-gap-sparse-payload', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      localRevision,
      incomingRevision,
      incomingStartIndex,
      incomingEndIndex,
      incomingWindowSize: Math.max(0, incomingEndIndex - incomingStartIndex),
      incomingLineCount: Array.isArray(options.payload.lines) ? options.payload.lines.length : 0,
    });
    options.scheduleSessionRenderCommit(options.sessionId);
    options.requestSessionBufferSync(options.sessionId, {
      reason: 'buffer-sync-revision-gap-sparse-payload',
      purpose: 'tail-refresh',
      sessionOverride: {
        ...session,
        daemonHeadRevision: liveHead.revision,
        daemonHeadEndIndex: liveHead.latestEndIndex,
      },
      liveHead,
    });
    return;
  }

  nextBuffer = applyBufferSyncToSessionBuffer(
    nextBuffer,
    options.payload,
    options.resolveSessionCacheLines(options.payload.rows || nextBuffer.rows),
  );

  if (shouldCollectRuntimeDebugScope('session.buffer.apply.inspect')) {
    runtimeDebugPrechecked('session.buffer.apply.inspect', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      incoming: options.summarizeBufferPayload(options.payload),
      localBuffer: summarizeSessionBufferForDebug(localBuffer),
      nextBuffer: summarizeSessionBufferForDebug(nextBuffer),
    });
  }

  if (revisionResetExpectation && nextBuffer.revision >= 0) {
    options.refs.sessionRevisionResetRef.current.delete(options.sessionId);
  }

  const liveHead = options.refs.sessionBufferHeadsRef.current.get(options.sessionId) || null;
  const inputTailRefresh = options.refs.pendingInputTailRefreshRef.current.get(options.sessionId) || null;
  if (
    inputTailRefresh
    && (
      nextBuffer.revision > Math.max(0, Math.floor(inputTailRefresh.localRevision || 0))
      && (!liveHead || nextBuffer.revision >= Math.max(0, Math.floor(liveHead.revision || 0)))
    )
  ) {
    options.refs.pendingInputTailRefreshRef.current.delete(options.sessionId);
  }
  if (
    options.refs.pendingConnectTailRefreshRef.current.has(options.sessionId)
    && (
      nextBuffer.endIndex !== localBuffer.endIndex
      || nextBuffer.revision > Math.max(0, Math.floor(localBuffer.revision || 0))
      || (liveHead && nextBuffer.revision >= Math.max(0, Math.floor(liveHead.revision || 0)))
    )
  ) {
    options.refs.pendingConnectTailRefreshRef.current.delete(options.sessionId);
  }
  if (
    options.refs.pendingResumeTailRefreshRef.current.has(options.sessionId)
    && (
      nextBuffer.endIndex !== localBuffer.endIndex
      || nextBuffer.revision > Math.max(0, Math.floor(localBuffer.revision || 0))
      || (liveHead && nextBuffer.revision >= Math.max(0, Math.floor(liveHead.revision || 0)))
    )
  ) {
    options.refs.pendingResumeTailRefreshRef.current.delete(options.sessionId);
  }

  if (sessionBuffersEqual(localBuffer, nextBuffer)) {
    options.runtimeDebug('session.buffer.apply.noop', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      incoming: options.summarizeBufferPayload(options.payload),
      localRevision: localBuffer.revision,
      localStartIndex: localBuffer.startIndex,
      localEndIndex: localBuffer.endIndex,
    });
    return;
  }

  const changed = options.commitSessionBufferUpdate(options.sessionId, nextBuffer);
  if (!changed) {
    return;
  }
  options.runtimeDebug('session.buffer.applied', {
    sessionId: options.sessionId,
    activeSessionId: options.refs.stateRef.current.activeSessionId,
    previousRevision: localBuffer.revision,
    previousStartIndex: localBuffer.startIndex,
    previousEndIndex: localBuffer.endIndex,
    nextRevision: nextBuffer.revision,
    nextStartIndex: nextBuffer.startIndex,
    nextEndIndex: nextBuffer.endIndex,
    nextHeadStartIndex: nextBuffer.bufferHeadStartIndex,
    nextTailEndIndex: nextBuffer.bufferTailEndIndex,
    updateKind: nextBuffer.updateKind,
    gapRangeCount: nextBuffer.gapRanges.length,
    lineCount: nextBuffer.lines.length,
  });
  runtimeDebugPrechecked('terminal.performance.trace', {
    sessionId: options.sessionId,
    traceId: `${options.sessionId}:${Math.max(0, Math.floor(options.payload.revision || 0))}`,
    mirrorRevision: Math.max(0, Math.floor(options.payload.revision || 0)),
    subscriberId: options.sessionId,
    stage: 'buffer-apply-done',
    at: Date.now(),
    lineCount: Array.isArray(options.payload.lines) ? options.payload.lines.length : 0,
  });
  options.scheduleSessionRenderCommit(options.sessionId);

  const nextSession: Session = {
    ...session,
    buffer: nextBuffer,
    daemonHeadRevision: liveHead?.revision ?? session.daemonHeadRevision,
    daemonHeadEndIndex: liveHead?.latestEndIndex ?? session.daemonHeadEndIndex,
  };
  const visibleRange = resolvePostApplyVisibleRange({
    session: nextSession,
    previousBuffer: localBuffer,
    nextBuffer,
    visibleRange: options.refs.sessionVisibleRangeRef.current.get(options.sessionId) || null,
  });

  if (shouldCatchUpFollowTailAfterBufferApply(nextSession, visibleRange, {
    forceSameEndRefresh:
      options.refs.pendingConnectTailRefreshRef.current.has(options.sessionId)
      || options.refs.pendingResumeTailRefreshRef.current.has(options.sessionId),
    bufferOverride: nextBuffer,
  })) {
    options.requestSessionBufferSync(options.sessionId, {
      reason: 'buffer-sync-catchup',
      purpose: 'tail-refresh',
      sessionOverride: nextSession,
      requestWindowOverride:
        liveHead
        && nextBuffer.revision < Math.max(0, Math.floor(liveHead.revision || 0))
        && Math.max(0, Math.floor(options.payload.endIndex || 0)) >= Math.max(0, Math.floor(nextBuffer.endIndex || 0))
          ? {
              requestStartIndex: Math.max(0, Math.floor(options.payload.startIndex || 0)),
              requestEndIndex: Math.max(0, Math.floor(options.payload.endIndex || 0)),
            }
          : null,
    });
    return;
  }

  if (!shouldPullVisibleRangeBuffer(nextSession, visibleRange, liveHead, nextBuffer)) {
    return;
  }

  options.requestSessionBufferSync(options.sessionId, {
    reason: 'buffer-sync-visible-range-repair-catchup',
    purpose: 'reading-repair',
    sessionOverride: nextSession,
  });
}
