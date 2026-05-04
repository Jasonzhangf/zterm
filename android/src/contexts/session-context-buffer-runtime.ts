import {
  applyBufferSyncToSessionBuffer,
  createSessionBufferState,
  sessionBuffersEqual,
} from '../lib/terminal-buffer';
import type {
  ClientMessage,
  Session,
  SessionBufferState,
  TerminalBufferPayload,
  TerminalCursorState,
  TerminalVisibleRange,
} from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import {
  buildDefaultSessionVisibleRange,
  buildSessionBufferSyncRequestPayload,
  doesSessionPullStateCoverRequest,
  doesSessionPullStateMatchExactLocalSnapshot,
  shouldCatchUpFollowTailAfterBufferApply,
  shouldPullFollowBuffer,
  shouldPullVisibleRangeBuffer,
  hasImpossibleLocalWindow,
  normalizeTerminalCursorState,
  type SessionBufferHeadState,
  type SessionPullPurpose,
  type SessionPullStates,
} from './session-sync-helpers';

interface MutableRefObject<T> {
  current: T;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

interface SessionDebugMetricsRecorder {
  recordRefreshRequest: (sessionId: string) => void;
}

interface RevisionResetExpectation {
  revision: number;
  latestEndIndex: number;
  seenAt: number;
}

export function handleBufferHeadRuntime(options: {
  sessionId: string;
  latestRevision: number;
  latestEndIndex: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  cursor?: TerminalCursorState | null;
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    sessionBufferHeadsRef: MutableRefObject<Map<string, SessionBufferHeadState>>;
    lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
    sessionRevisionResetRef: MutableRefObject<Map<string, RevisionResetExpectation>>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, TerminalVisibleRange>>;
    sessionBufferStoreRef: MutableRefObject<{ setBuffer: (sessionId: string, buffer: SessionBufferState) => void }>;
    sessionHeadStoreRef: MutableRefObject<{ setHead: (sessionId: string, head: { daemonHeadRevision: number; daemonHeadEndIndex: number }) => boolean }>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  commitSessionBufferUpdate: (sessionId: string, nextBuffer: SessionBufferState) => boolean;
  scheduleSessionRenderCommit: (sessionId: string) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
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
  const ws = options.readSessionTransportSocket(options.sessionId);
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
  if (!activeTransport) {
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
  const cursorChanged = (
    (localBuffer.cursor?.rowIndex ?? null) !== (normalizedCursor?.rowIndex ?? null)
    || (localBuffer.cursor?.col ?? null) !== (normalizedCursor?.col ?? null)
    || (localBuffer.cursor?.visible ?? null) !== (normalizedCursor?.visible ?? null)
  );
  if (cursorChanged) {
    const nextBuffer = {
      ...localBuffer,
      cursor: normalizedCursor,
    };
    const changed = options.commitSessionBufferUpdate(options.sessionId, nextBuffer);
    if (changed) {
      options.scheduleSessionRenderCommit(options.sessionId);
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
  if (headChanged) {
    options.scheduleSessionRenderCommit(options.sessionId);
  }
  const liveHead = options.refs.sessionBufferHeadsRef.current.get(options.sessionId) || null;

  const plannerBuffer = cursorChanged
    ? {
        ...localBuffer,
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
  const visibleRange = options.refs.sessionVisibleRangeRef.current.get(options.sessionId)
    || buildDefaultSessionVisibleRange(session, undefined, plannerBuffer);
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
  };
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, TerminalVisibleRange>>;
    sessionBufferHeadsRef: MutableRefObject<Map<string, SessionBufferHeadState>>;
    sessionPullStateRef: MutableRefObject<Map<string, SessionPullStates>>;
    pendingInputTailRefreshRef: MutableRefObject<Map<string, { requestedAt: number; localRevision: number }>>;
    pendingConnectTailRefreshRef: MutableRefObject<Set<string>>;
    pendingResumeTailRefreshRef: MutableRefObject<Set<string>>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
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
    },
  ) => void;
  runtimeDebug: RuntimeDebugFn;
}) {
  const session = options.requestOptions?.sessionOverride
    || options.refs.stateRef.current.sessions.find((item) => item.id === options.sessionId)
    || null;
  const activeWs = options.readSessionTransportSocket(options.sessionId);
  const requestedWs = options.requestOptions?.ws || null;
  if (requestedWs && activeWs !== requestedWs) {
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
      forceSameEndRefresh:
        options.refs.pendingInputTailRefreshRef.current.has(options.sessionId)
        || options.refs.pendingConnectTailRefreshRef.current.has(options.sessionId)
        || options.refs.pendingResumeTailRefreshRef.current.has(options.sessionId),
      liveHead: options.requestOptions?.liveHead || liveHead || null,
      invalidLocalWindow: Boolean(options.requestOptions?.invalidLocalWindow),
      requestWindowOverride: options.requestOptions?.requestWindowOverride || null,
      bufferOverride: localBuffer,
    },
  );
  const inFlightPull = (options.refs.sessionPullStateRef.current.get(options.sessionId) || null)?.[requestPurpose] || null;
  if (inFlightPull) {
    const authoritativeHeadKnown = Boolean(
      (options.requestOptions?.liveHead && Number.isFinite(options.requestOptions.liveHead.latestEndIndex))
      || Math.max(0, Math.floor(effectiveSession.daemonHeadRevision || 0)) > 0
      || Math.max(0, Math.floor(effectiveSession.daemonHeadEndIndex || 0)) > 0
    );
    if (doesSessionPullStateMatchExactLocalSnapshot(inFlightPull, payload)) {
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

  options.runtimeDebug('session.buffer.request', {
    sessionId: options.sessionId,
    activeSessionId: options.refs.stateRef.current.activeSessionId,
    reason: options.requestOptions?.reason || null,
    purpose: requestPurpose,
    payload,
  });
  const requestTargetStartIndex = Math.max(0, Math.floor(payload.requestStartIndex || 0));
  const requestTargetEndIndex = Math.max(requestTargetStartIndex, Math.floor(
    requestPurpose === 'reading-repair'
      ? (payload.requestEndIndex || 0)
      : (
        effectiveSession.daemonHeadEndIndex
        || payload.requestEndIndex
        || localBuffer.bufferTailEndIndex
        || localBuffer.endIndex
        || 0
      ),
  ));
  options.sendSocketPayload(options.sessionId, targetWs, JSON.stringify({
    type: 'buffer-sync-request',
    payload,
  } satisfies ClientMessage), {
    pullPurpose: requestPurpose,
    targetHeadRevision: Math.max(0, Math.floor(effectiveSession.daemonHeadRevision || 0)),
    targetStartIndex: requestTargetStartIndex,
    targetEndIndex: requestTargetEndIndex,
    requestKnownRevision: Math.max(0, Math.floor(payload.knownRevision || 0)),
    requestLocalStartIndex: Math.max(0, Math.floor(payload.localStartIndex || 0)),
    requestLocalEndIndex: Math.max(0, Math.floor(payload.localEndIndex || 0)),
  });
  return true;
}

export function requestSessionBufferHeadRuntime(options: {
  sessionId: string;
  ws?: BridgeTransportSocket | null;
  force?: boolean;
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[] }>;
    lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
    sessionDebugMetricsStoreRef: MutableRefObject<SessionDebugMetricsRecorder>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  resolveTerminalRefreshCadence: () => { headTickMs: number };
}) {
  const activeWs = options.readSessionTransportSocket(options.sessionId) || null;
  if (options.ws && activeWs !== options.ws) {
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
    sessionVisibleRangeRef: MutableRefObject<Map<string, TerminalVisibleRange>>;
  };
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  resolveSessionCacheLines: (rows?: number | null) => number;
  summarizeBufferPayload: (payload: TerminalBufferPayload) => Record<string, unknown>;
  runtimeDebug: RuntimeDebugFn;
  commitSessionBufferUpdate: (sessionId: string, nextBuffer: SessionBufferState) => boolean;
  scheduleSessionRenderCommit: (sessionId: string) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
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
  const session = options.refs.stateRef.current.sessions.find((item) => item.id === options.sessionId) || null;
  if (!session) {
    return;
  }
  const localBuffer = options.readSessionBufferSnapshot(options.sessionId);
  const activeTransport = options.isSessionTransportActive(options.sessionId);
  if (!activeTransport) {
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

  nextBuffer = applyBufferSyncToSessionBuffer(
    nextBuffer,
    options.payload,
    options.resolveSessionCacheLines(options.payload.rows || nextBuffer.rows),
  );

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
  options.scheduleSessionRenderCommit(options.sessionId);

  const nextSession: Session = {
    ...session,
    buffer: nextBuffer,
    daemonHeadRevision: liveHead?.revision ?? session.daemonHeadRevision,
    daemonHeadEndIndex: liveHead?.latestEndIndex ?? session.daemonHeadEndIndex,
  };
  const visibleRange = options.refs.sessionVisibleRangeRef.current.get(options.sessionId)
    || buildDefaultSessionVisibleRange(nextSession);

  if (shouldCatchUpFollowTailAfterBufferApply(nextSession, visibleRange, {
    forceSameEndRefresh:
      options.refs.pendingInputTailRefreshRef.current.has(options.sessionId)
      || options.refs.pendingConnectTailRefreshRef.current.has(options.sessionId)
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
