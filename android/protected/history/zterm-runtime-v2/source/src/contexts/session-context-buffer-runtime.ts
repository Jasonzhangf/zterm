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
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';
import type { SessionReconnectStore } from '../lib/session-reconnect-store';
import type { SessionBufferStoreCommitOptions } from '../lib/session-buffer-store';
import {
  buildDefaultSessionVisibleRange,
  type SessionDaemonHeadView,
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
} from '../lib/session-pull-state-helpers';
import { normalizeTerminalCursorState } from '../lib/wire-ingress/buffer-wire-normalize';
import type { SessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import { buildBufferSyncRepairSignature } from '@zterm/shared/terminal/pull-state-planner';
import {
  assembleBufferSyncFrameChunk,
  clearPendingBufferSyncFrameAssembly,
  expireBufferSyncFrameAssembly,
  hasBufferFrameRepairDispatch,
  recordBufferFrameRepairDispatch,
  resetBufferSyncFrameAssemblyEpoch,
  type BufferFrameAssemblyError,
  type BufferFrameAssemblyResult,
  type BufferFrameAssemblyResourceState,
  type BufferSyncIn03SparseApplyInput,
} from '../lib/buffer-frame-assembly/session-buffer-frame-assembly';

interface MutableRefObject<T> {
  current: T;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

interface SessionDebugMetricsRecorder {
  recordRefreshRequest: (sessionId: string) => void;
}

interface BufferRuntimeTransportAccessors {
  daemonConnection?: ClientDaemonConnection;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportResource?: (sessionId: string) => { socket?: BridgeTransportSocket | null } | null;
}

function readBufferRuntimeSocket(
  options: BufferRuntimeTransportAccessors,
  sessionId: string,
) {
  if (options.daemonConnection) {
    return options.daemonConnection.readSessionSocket(sessionId);
  }
  return options.readSessionTransportResource?.(sessionId)?.socket
    || options.readSessionTransportSocket(sessionId);
}

const SESSION_SYNC_REQUEST_DEBOUNCE_MS = 33;

interface RevisionResetExpectation {
  revision: number;
  latestEndIndex: number;
  seenAt: number;
}

export type { BufferFrameAssemblyResourceState } from '../lib/buffer-frame-assembly/session-buffer-frame-assembly';

const REPAIRABLE_BUFFER_FRAME_ERRORS = new Set<BufferFrameAssemblyError>([
  'invalid-frame-metadata',
  'invalid-chunk-lines',
  'conflicting-duplicate-chunk',
  'interleaved-same-revision-frame',
  'inconsistent-frame-metadata',
  'non-contiguous-frame',
  'frame-assembly-expired',
]);

type RequestSessionBufferSyncFn = (
  sessionId: string,
  requestOptions?: {
    reason?: string;
    purpose?: SessionPullPurpose;
    headOverride?: SessionDaemonHeadView | null;
    liveHead?: SessionBufferHeadState | null;
    invalidLocalWindow?: boolean;
    requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
    requestMissingRangesOverride?: Array<{ startIndex: number; endIndex: number }> | null;
  },
) => boolean;

function dispatchPendingBufferFrameRepair(options: {
  sessionId: string;
  frameAssemblyStore: Map<string, BufferFrameAssemblyResourceState>;
  tailRefreshStore: SessionTailRefreshStore;
  liveHead: SessionBufferHeadState | null;
  requestSessionBufferSync: RequestSessionBufferSyncFn;
  runtimeDebug: RuntimeDebugFn;
}) {
  const resource = options.frameAssemblyStore.get(options.sessionId) || null;
  const errorTruth = resource?.error || null;
  if (!resource || !errorTruth || errorTruth.repair.status !== 'pending' || !errorTruth.repair.range) {
    return false;
  }
  const { startIndex, endIndex } = errorTruth.repair.range;
  const liveHeadRevision = options.liveHead?.revision;
  const repairRevision = errorTruth.revision
    ?? (Number.isSafeInteger(liveHeadRevision) && Number(liveHeadRevision) > 0
      ? Number(liveHeadRevision)
      : null);
  if (repairRevision === null) {
    options.runtimeDebug('session.buffer.frame.repair-awaiting-head', {
      sessionId: options.sessionId,
      error: errorTruth.error,
      repairRange: errorTruth.repair.range,
    });
    return false;
  }
  if (hasBufferFrameRepairDispatch(resource.repairDispatchedRevisions, repairRevision)) {
    options.frameAssemblyStore.set(options.sessionId, {
      ...resource,
      error: {
        ...errorTruth,
        revision: repairRevision,
        repair: {
          status: 'dispatched',
          range: errorTruth.repair.range,
        },
      },
    });
    options.runtimeDebug('session.buffer.frame.repair-already-dispatched', {
      sessionId: options.sessionId,
      revision: repairRevision,
      error: errorTruth.error,
      repairRange: errorTruth.repair.range,
    });
    return false;
  }
  if (errorTruth.revision === null) {
    options.frameAssemblyStore.set(options.sessionId, {
      ...resource,
      error: { ...errorTruth, revision: repairRevision },
    });
  }
  options.tailRefreshStore.clearSyncRequest(options.sessionId, 'tail-refresh');
  const dispatched = options.requestSessionBufferSync(options.sessionId, {
    reason: `buffer-sync-frame-${errorTruth.error}`,
    purpose: 'tail-refresh',
    headOverride: {
      daemonHeadRevision: repairRevision,
      daemonHeadEndIndex: endIndex,
    },
    liveHead: options.liveHead,
    requestWindowOverride: {
      requestStartIndex: startIndex,
      requestEndIndex: endIndex,
    },
  });
  if (!dispatched) {
    options.runtimeDebug('session.buffer.frame.repair-pending', {
      sessionId: options.sessionId,
      revision: repairRevision,
      error: errorTruth.error,
      repairRange: errorTruth.repair.range,
    });
    return false;
  }
  options.frameAssemblyStore.set(options.sessionId, {
    ...(options.frameAssemblyStore.get(options.sessionId) || resource),
    error: {
      ...errorTruth,
      revision: repairRevision,
      repair: {
        status: 'dispatched',
        range: errorTruth.repair.range,
      },
    },
    repairDispatchedRevisions: recordBufferFrameRepairDispatch(
      resource.repairDispatchedRevisions,
      repairRevision,
    ),
  });
  options.runtimeDebug('session.buffer.frame.repair-dispatched', {
    sessionId: options.sessionId,
    revision: repairRevision,
    error: errorTruth.error,
    repairRange: errorTruth.repair.range,
  });
  return true;
}

type RejectedBufferFrameAssemblyResult = Extract<BufferFrameAssemblyResult, { kind: 'rejected' }>;

function projectRejectedBufferFrameRuntime(options: {
  sessionId: string;
  rejection: RejectedBufferFrameAssemblyResult;
  currentResource: BufferFrameAssemblyResourceState | null;
  frameAssemblyStore: Map<string, BufferFrameAssemblyResourceState>;
  tailRefreshStore: SessionTailRefreshStore;
  liveHead: SessionBufferHeadState | null;
  requestSessionBufferSync: RequestSessionBufferSyncFn;
  runtimeDebug: RuntimeDebugFn;
  incomingSummary?: Record<string, unknown>;
}) {
  const incomingRevision = options.rejection.repairRevision;
  const retainedRevision = Math.max(
    options.currentResource?.pending?.revision ?? -1,
    options.currentResource?.error?.revision ?? -1,
  );
  if (incomingRevision !== null && retainedRevision >= 0 && incomingRevision < retainedRevision) {
    options.runtimeDebug('session.buffer.frame.stale-rejection-observed', {
      sessionId: options.sessionId,
      error: options.rejection.error,
      incomingRevision,
      retainedRevision,
      retainedPendingRevision: options.currentResource?.pending?.revision ?? null,
      retainedErrorRevision: options.currentResource?.error?.revision ?? null,
      incoming: options.incomingSummary ?? null,
    });
    return;
  }
  const repairAlreadyDispatched = incomingRevision !== null
    && hasBufferFrameRepairDispatch(
      options.currentResource?.repairDispatchedRevisions ?? [],
      incomingRevision,
    );
  const repairEligible = REPAIRABLE_BUFFER_FRAME_ERRORS.has(options.rejection.error);
  const repair = repairAlreadyDispatched
    ? { status: 'dispatched' as const, range: options.rejection.repairRange }
    : options.rejection.error === 'stale-frame'
      ? { status: 'not-required' as const, range: null }
      : repairEligible && options.rejection.repairRange
        ? { status: 'pending' as const, range: options.rejection.repairRange }
        : { status: 'unavailable' as const, range: options.rejection.repairRange };
  const errorTruth = {
    error: options.rejection.error,
    revision: incomingRevision,
    repair,
  };
  options.frameAssemblyStore.set(options.sessionId, {
    pending: options.rejection.state,
    error: errorTruth,
    repairDispatchedRevisions: options.currentResource?.repairDispatchedRevisions ?? [],
  });
  options.runtimeDebug('session.buffer.frame.rejected', {
    sessionId: options.sessionId,
    error: options.rejection.error,
    errorTruth,
    incoming: options.incomingSummary ?? null,
  });
  if (repair.status === 'pending') {
    dispatchPendingBufferFrameRepair({
      sessionId: options.sessionId,
      frameAssemblyStore: options.frameAssemblyStore,
      tailRefreshStore: options.tailRefreshStore,
      liveHead: options.liveHead,
      requestSessionBufferSync: options.requestSessionBufferSync,
      runtimeDebug: options.runtimeDebug,
    });
  }
}

function settleBufferFrameResourceAfterResolvedPayload(options: {
  sessionId: string;
  currentResource: BufferFrameAssemblyResourceState | null;
  frameAssemblyStore: Map<string, BufferFrameAssemblyResourceState>;
}) {
  const repairDispatchedRevisions = options.currentResource?.repairDispatchedRevisions ?? [];
  if (repairDispatchedRevisions.length > 0) {
    options.frameAssemblyStore.set(options.sessionId, {
      pending: null,
      error: null,
      repairDispatchedRevisions,
    });
    return;
  }
  options.frameAssemblyStore.delete(options.sessionId);
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
  let lastConflictIndex: number | null = null;
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
      lastConflictIndex = line.index;
    }
  }

  if (conflictCount === 0) {
    return null;
  }
  return {
    conflictCount,
    firstConflictIndex,
    lastConflictIndex,
    incomingStartIndex: startIndex,
    incomingEndIndex: endIndex,
  };
}

function resolvePendingSameRevisionRefreshPurpose(options: {
  sessionId: string;
  payload: TerminalBufferPayload;
  localBuffer: SessionBufferState;
  conflictRange?: { startIndex: number; endIndex: number } | null;
  refs: {
    tailRefreshStoreRef?: MutableRefObject<SessionTailRefreshStore>;
  };
}): SessionPullPurpose | null {
  const tailRefreshStore = options.refs.tailRefreshStoreRef?.current;
  if (!tailRefreshStore) {
    return null;
  }
  const incomingRevision = Math.max(0, Math.floor(options.payload.revision || 0));
  const incomingStartIndex = Math.max(0, Math.floor(options.payload.startIndex || 0));
  const incomingEndIndex = Math.max(incomingStartIndex, Math.floor(options.payload.endIndex || incomingStartIndex));
  const effectiveStartIndex = options.conflictRange
    ? Math.max(0, Math.floor(options.conflictRange.startIndex || 0))
    : incomingStartIndex;
  const effectiveEndIndex = options.conflictRange
    ? Math.max(effectiveStartIndex, Math.floor(options.conflictRange.endIndex || effectiveStartIndex))
    : incomingEndIndex;
  const localRevision = Math.max(0, Math.floor(options.localBuffer.revision || 0));
  for (const purpose of ['tail-refresh', 'reading-repair'] as const) {
    const pending = tailRefreshStore.readSyncRequest(options.sessionId, purpose);
    if (!pending) {
      continue;
    }
    const pendingStart = Math.max(0, Math.floor(pending.requestStartIndex || 0));
    const pendingEnd = Math.max(pendingStart, Math.floor(pending.requestEndIndex || pendingStart));
    const isWithinPendingWindow = effectiveStartIndex >= pendingStart && effectiveEndIndex <= pendingEnd;
    if (
      isWithinPendingWindow
      && Math.max(0, Math.floor(pending.targetHeadRevision || 0)) === incomingRevision
      && Math.max(0, Math.floor(pending.knownRevision || 0)) === localRevision
    ) {
      return purpose;
    }
  }
  return null;
}

function resolvePostApplyVisibleRange(options: {
  head: SessionDaemonHeadView;
  previousBuffer: SessionBufferState;
  nextBuffer: SessionBufferState;
  visibleRange: TerminalVisibleRange | null;
}) {
  const visibleRange = options.visibleRange;
  if (!visibleRange) {
    return buildDefaultSessionVisibleRange(options.head, undefined, options.nextBuffer);
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
  return buildDefaultSessionVisibleRange(options.head, visibleRange, options.nextBuffer);
}

function resolveVisibleNonGapRepairRequestAfterSparseAdvance(options: {
  payload: TerminalBufferPayload;
  previousBuffer: SessionBufferState;
  nextBuffer: SessionBufferState;
  visibleRange: TerminalVisibleRange | null;
}) {
  const visibleRange = options.visibleRange;
  if (!visibleRange) {
    return null;
  }
  const previousRevision = Math.max(0, Math.floor(options.previousBuffer.revision || 0));
  const nextRevision = Math.max(0, Math.floor(options.nextBuffer.revision || 0));
  const incomingRevision = Math.max(0, Math.floor(options.payload.revision || 0));
  if (incomingRevision <= previousRevision || nextRevision <= previousRevision) {
    return null;
  }

  const previousTailEndIndex = Math.max(
    0,
    Math.floor(options.previousBuffer.bufferTailEndIndex || options.previousBuffer.endIndex || 0),
  );
  const nextTailEndIndex = Math.max(
    0,
    Math.floor(options.nextBuffer.bufferTailEndIndex || options.nextBuffer.endIndex || 0),
  );
  if (nextTailEndIndex !== previousTailEndIndex) {
    return null;
  }

  const visibleEndIndex = Math.max(0, Math.floor(visibleRange.endIndex || 0));
  const viewportRows = Math.max(1, Math.floor(visibleRange.viewportRows || options.nextBuffer.rows || 1));
  const visibleStartIndex = Math.max(
    0,
    Math.min(
      Math.floor(visibleRange.startIndex || 0),
      Math.max(0, visibleEndIndex - viewportRows),
    ),
  );
  if (visibleEndIndex <= visibleStartIndex || visibleEndIndex < nextTailEndIndex - 1) {
    return null;
  }

  const availableStartIndex = Number.isFinite(options.payload.availableStartIndex)
    ? Math.max(0, Math.floor(options.payload.availableStartIndex || 0))
    : Math.max(0, Math.floor(options.nextBuffer.bufferHeadStartIndex || options.nextBuffer.startIndex || 0));
  const availableEndIndex = Number.isFinite(options.payload.availableEndIndex)
    ? Math.max(availableStartIndex, Math.floor(options.payload.availableEndIndex || availableStartIndex))
    : Math.max(availableStartIndex, Math.floor(options.nextBuffer.bufferTailEndIndex || options.nextBuffer.endIndex || availableStartIndex));
  const requestStartIndex = Math.max(availableStartIndex, visibleStartIndex);
  const requestEndIndex = Math.min(availableEndIndex, visibleEndIndex);
  if (requestEndIndex <= requestStartIndex) {
    return null;
  }

  const coveredLineIndexes = new Set<number>();
  for (const line of options.payload.lines || []) {
    const index = getWireLineIndex(line);
    if (index !== null && index >= requestStartIndex && index < requestEndIndex) {
      coveredLineIndexes.add(index);
    }
  }
  for (let index = requestStartIndex; index < requestEndIndex; index += 1) {
    if (!coveredLineIndexes.has(index)) {
      return {
        requestStartIndex,
        requestEndIndex,
      };
    }
  }
  return null;
}

const VISIBLE_NON_GAP_REPAIR_STALE_MS = 2000;

function shouldSuppressRecentVisibleNonGapRepair(options: {
  sessionId: string;
  requestStartIndex: number;
  requestEndIndex: number;
  tailEndIndex: number;
  tailRefreshStore: SessionTailRefreshStore;
  now?: number;
}) {
  const previous = options.tailRefreshStore
    .listVisibleNonGapRepairs(options.sessionId)
    .filter((entry) => (
      Math.max(0, Math.floor(entry.requestStartIndex || 0)) === Math.max(0, Math.floor(options.requestStartIndex || 0))
      && Math.max(0, Math.floor(entry.requestEndIndex || entry.requestStartIndex || 0)) === Math.max(0, Math.floor(options.requestEndIndex || options.requestStartIndex || 0))
      && Math.max(0, Math.floor(entry.tailEndIndex || 0)) === Math.max(0, Math.floor(options.tailEndIndex || 0))
    ))
    .sort((left, right) => right.requestedAt - left.requestedAt)[0] || null;
  if (!previous) {
    return false;
  }
  if (previous.status === 'fulfilled' || previous.status === 'superseded') {
    return false;
  }
  if (previous.status === 'pending') {
    return false;
  }
  if (previous.status !== 'dispatched') {
    return false;
  }
  const now = options.now ?? Date.now();
  const ageMs = now - Math.max(0, Math.floor(previous.lastDispatchAt || 0));
  return ageMs >= 0 && ageMs < VISIBLE_NON_GAP_REPAIR_STALE_MS;
}

function fulfillVisibleNonGapRepairLedgerIfAuthoritative(options: {
  sessionId: string;
  payload: TerminalBufferPayload;
  nextBuffer: SessionBufferState;
  tailRefreshStore: SessionTailRefreshStore;
  visibleRange: TerminalVisibleRange | null;
}) {
  const payloadRevision = Math.max(0, Math.floor(options.payload.revision || 0));
  const coveredLineIndexes = new Set<number>();
  for (const line of options.payload.lines || []) {
    const index = getWireLineIndex(line);
    if (index !== null) {
      coveredLineIndexes.add(index);
    }
  }
  for (const entry of options.tailRefreshStore.listVisibleNonGapRepairs(options.sessionId)) {
    if (entry.status === 'fulfilled') {
      continue;
    }
    if (payloadRevision < Math.max(0, Math.floor(entry.targetRevision || 0))) {
      continue;
    }
    if (Math.max(0, Math.floor(entry.tailEndIndex || 0)) !== Math.max(0, Math.floor(options.nextBuffer.bufferTailEndIndex || 0))) {
      continue;
    }
    let fullyCovered = true;
    for (let index = entry.requestStartIndex; index < entry.requestEndIndex; index += 1) {
      if (!coveredLineIndexes.has(index)) {
        fullyCovered = false;
        break;
      }
    }
    if (!fullyCovered) continue;
    options.tailRefreshStore.markVisibleNonGapRepairFulfilled(options.sessionId, {
      requestStartIndex: entry.requestStartIndex,
      requestEndIndex: entry.requestEndIndex,
      tailEndIndex: entry.tailEndIndex,
      targetRevision: entry.targetRevision,
    });
  }

  if (!options.visibleRange) {
    return;
  }
  const visibleStartIndex = Math.max(0, Math.floor(options.visibleRange.startIndex || 0));
  const visibleEndIndex = Math.max(visibleStartIndex, Math.floor(options.visibleRange.endIndex || visibleStartIndex));
  if (visibleEndIndex > visibleStartIndex) {
    let visibleWindowCovered = true;
    for (let index = visibleStartIndex; index < visibleEndIndex; index += 1) {
      if (!coveredLineIndexes.has(index)) {
        visibleWindowCovered = false;
        break;
      }
    }
    if (visibleWindowCovered) {
      options.tailRefreshStore.markVisibleNonGapRepairFulfilled(options.sessionId, {
        requestStartIndex: visibleStartIndex,
        requestEndIndex: visibleEndIndex,
        tailEndIndex: Math.max(
          0,
          Math.floor(options.nextBuffer.bufferTailEndIndex || options.nextBuffer.endIndex || 0),
        ),
        targetRevision: payloadRevision,
      });
    }
  }
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
    stateRef: MutableRefObject<{
      sessions: Session[];
      activeSessionId: string | null;
      liveSessionIds?: string[];
    }>;
    lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
    sessionRevisionResetRef: MutableRefObject<Map<string, RevisionResetExpectation>>;
    tailRefreshStoreRef: MutableRefObject<SessionTailRefreshStore>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, TerminalVisibleRange>>;
    sessionBufferStoreRef: MutableRefObject<{ commitBuffer: (sessionId: string, buffer: SessionBufferState) => boolean }>;
    bufferFrameAssemblyRef: MutableRefObject<Map<string, BufferFrameAssemblyResourceState>>;
    sessionHeadStoreRef: MutableRefObject<{
      setLiveHead: (
        sessionId: string,
        head: SessionBufferHeadState,
        setOptions?: { publishRenderer?: boolean },
      ) => boolean;
      getLiveHead: (sessionId: string) => SessionBufferHeadState | null;
    }>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportResource?: (sessionId: string) => { socket?: BridgeTransportSocket | null } | null;
  daemonConnection?: ClientDaemonConnection;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  commitSessionBufferUpdate: (sessionId: string, nextBuffer: SessionBufferState, options?: SessionBufferStoreCommitOptions) => boolean;
  scheduleSessionRenderCommit: (sessionId: string) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
  shouldAcceptSessionLiveBuffer?: (sessionId: string) => boolean;
  runtimeDebug: RuntimeDebugFn;
  requestSessionBufferSync: RequestSessionBufferSyncFn;
}) {
  const session = options.refs.stateRef.current.sessions.find((item) => item.id === options.sessionId) || null;
  const ws = readBufferRuntimeSocket(options, options.sessionId);
  if (
    !session
    || (session.state !== 'connected' && session.state !== 'connecting' && session.state !== 'reconnecting')
    || !ws
    || ws.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  const incomingHead: SessionBufferHeadState = {
    revision: options.latestRevision,
    latestEndIndex: options.latestEndIndex,
    availableStartIndex: Number.isFinite(options.availableStartIndex)
      ? Math.max(0, Math.floor(options.availableStartIndex || 0))
      : undefined,
    availableEndIndex: Number.isFinite(options.availableEndIndex)
      ? Math.max(0, Math.floor(options.availableEndIndex || 0))
      : undefined,
    seenAt: Date.now(),
  };
  options.refs.lastHeadRequestAtRef.current.set(options.sessionId, Date.now());


  const activeTransport = options.isSessionTransportActive(options.sessionId);
  const shouldAcceptLiveBuffer = activeTransport
    || Boolean(options.shouldAcceptSessionLiveBuffer?.(options.sessionId));
  if (!shouldAcceptLiveBuffer) {
    options.refs.sessionHeadStoreRef.current.setLiveHead(options.sessionId, incomingHead, {
      publishRenderer: false,
    });
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
    }
  }

  const headChanged = options.refs.sessionHeadStoreRef.current.setLiveHead(options.sessionId, incomingHead);
  void headChanged;
  const liveHead = options.refs.sessionHeadStoreRef.current.getLiveHead(options.sessionId);
  const plannerBuffer = cursorChanged
    ? {
        ...localBuffer,
        cursorKeysApp: normalizedCursorKeysApp,
        cursor: normalizedCursor,
      }
    : localBuffer;
  const localRevision = Math.max(0, Math.floor(plannerBuffer.revision || 0));
  const localEndIndex = Math.max(0, Math.floor(plannerBuffer.endIndex || 0));
  const localWindowInvalid = hasImpossibleLocalWindow(liveHead, plannerBuffer);
  const revisionResetDetected = options.latestRevision < localRevision;
  const priorRevisionResetExpectation = options.refs.sessionRevisionResetRef.current.get(options.sessionId) || null;
  if (revisionResetDetected) {
    options.refs.sessionRevisionResetRef.current.set(options.sessionId, {
      revision: options.latestRevision,
      latestEndIndex: options.latestEndIndex,
      seenAt: Date.now(),
    });
    if (!priorRevisionResetExpectation) {
      const resetFrameResource = resetBufferSyncFrameAssemblyEpoch(
        options.refs.bufferFrameAssemblyRef.current.get(options.sessionId) || null,
      );
      if (resetFrameResource) {
        options.refs.bufferFrameAssemblyRef.current.set(options.sessionId, resetFrameResource);
      }
    }
    options.runtimeDebug('session.buffer.revision-reset.detected', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      latestRevision: options.latestRevision,
      latestEndIndex: options.latestEndIndex,
      localRevision,
      localEndIndex,
      frameRepairEpochReset: !priorRevisionResetExpectation,
    });
  } else {
    options.refs.sessionRevisionResetRef.current.delete(options.sessionId);
  }

  const currentFrameResource = options.refs.bufferFrameAssemblyRef.current.get(options.sessionId) || null;
  const expiredFrame = expireBufferSyncFrameAssembly(
    currentFrameResource?.pending || null,
    incomingHead.seenAt,
  );
  if (expiredFrame?.kind === 'rejected') {
    projectRejectedBufferFrameRuntime({
      sessionId: options.sessionId,
      rejection: expiredFrame,
      currentResource: currentFrameResource,
      frameAssemblyStore: options.refs.bufferFrameAssemblyRef.current,
      tailRefreshStore: options.refs.tailRefreshStoreRef.current,
      liveHead,
      requestSessionBufferSync: options.requestSessionBufferSync,
      runtimeDebug: options.runtimeDebug,
    });
  }
  dispatchPendingBufferFrameRepair({
    sessionId: options.sessionId,
    frameAssemblyStore: options.refs.bufferFrameAssemblyRef.current,
    tailRefreshStore: options.refs.tailRefreshStoreRef.current,
    liveHead,
    requestSessionBufferSync: options.requestSessionBufferSync,
    runtimeDebug: options.runtimeDebug,
  });

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

  const demandHead: SessionDaemonHeadView = {
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
    const isLiveSession = Boolean(
      Array.isArray(options.refs.stateRef.current.liveSessionIds)
      && options.refs.stateRef.current.liveSessionIds.includes(options.sessionId),
    );
    if ((isActiveSession || isLiveSession) && liveHead) {
      const isPassiveLiveSession = isLiveSession && !isActiveSession;
      const viewportRows = Math.max(1, Math.floor(plannerBuffer.rows || 24));
      const passiveTailEndIndex = Math.max(0, Math.floor(options.latestEndIndex || liveHead.latestEndIndex || 0));
      const passiveTailStartIndex = Math.max(
        Math.max(0, Math.floor(liveHead.availableStartIndex || 0)),
        passiveTailEndIndex - viewportRows,
      );
      const passiveTailHasGap = isPassiveLiveSession && (plannerBuffer.gapRanges || []).some((range) => (
        range.startIndex < passiveTailEndIndex && range.endIndex > passiveTailStartIndex
      ));
      const passiveHeadUnchanged = (
        isPassiveLiveSession
        && !revisionResetDetected
        && !localWindowInvalid
        && !passiveTailHasGap
        && options.latestRevision <= localRevision
        && options.latestEndIndex <= localEndIndex
      );
      if (passiveHeadUnchanged) {
        options.runtimeDebug('session.buffer.head.no-visible-range-passive-unchanged-skip', {
          sessionId: options.sessionId,
          activeSessionId: options.refs.stateRef.current.activeSessionId,
          latestRevision: options.latestRevision,
          latestEndIndex: options.latestEndIndex,
          localRevision,
          localEndIndex,
        });
        return;
      }
      const bootstrapRows = isPassiveLiveSession ? viewportRows : viewportRows * 3;
      const requestEndIndex = Math.max(0, Math.floor(options.latestEndIndex || liveHead.latestEndIndex || 0));
      const requestStartIndex = Math.max(
        Math.max(0, Math.floor(liveHead.availableStartIndex || 0)),
        requestEndIndex - bootstrapRows,
      );
      options.runtimeDebug(
        isPassiveLiveSession
          ? 'session.buffer.head.no-visible-range-passive-tail-bootstrap'
          : 'session.buffer.head.no-visible-range-active-tail-bootstrap',
        {
          sessionId: options.sessionId,
          activeSessionId: options.refs.stateRef.current.activeSessionId,
          isLiveSession,
          isPassiveLiveSession,
          latestRevision: options.latestRevision,
          latestEndIndex: options.latestEndIndex,
          localRevision,
          localStartIndex: plannerBuffer.startIndex,
          localEndIndex: plannerBuffer.endIndex,
          requestStartIndex,
          requestEndIndex,
          viewportRows,
          bootstrapRows,
        },
      );
      options.requestSessionBufferSync(options.sessionId, {
        reason: isPassiveLiveSession
          ? 'buffer-head-no-visible-range-passive-bootstrap'
          : 'buffer-head-no-visible-range-active-bootstrap',
        purpose: 'tail-refresh',
        headOverride: demandHead,
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
    || shouldPullFollowBuffer(demandHead, visibleRange, plannerBuffer)
  );
  if (needsTailRefresh) {
    options.requestSessionBufferSync(options.sessionId, {
      reason:
        revisionResetDetected ? 'buffer-head-revision-reset'
          : localWindowInvalid ? 'buffer-head-invalid-local-window'
            : 'buffer-head-update',
      purpose: 'tail-refresh',
      headOverride: demandHead,
      liveHead,
      invalidLocalWindow: localWindowInvalid,
    });
    return;
  }

  const needsReadingRepair = shouldPullVisibleRangeBuffer(demandHead, visibleRange, liveHead, plannerBuffer);
  if (!needsReadingRepair) {
    return;
  }

  options.requestSessionBufferSync(options.sessionId, {
    reason: 'buffer-head-visible-range-repair',
    purpose: 'reading-repair',
    headOverride: demandHead,
  });
}

export function requestSessionBufferSyncRuntime(options: {
  sessionId: string;
  requestOptions?: {
    ws?: BridgeTransportSocket | null;
    reason?: string;
    purpose?: SessionPullPurpose;
    headOverride?: SessionDaemonHeadView | null;
    liveHead?: SessionBufferHeadState | null;
    invalidLocalWindow?: boolean;
    requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
    requestMissingRangesOverride?: Array<{ startIndex: number; endIndex: number }> | null;
  };
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, TerminalVisibleRange>>;
    sessionHeadStoreRef: MutableRefObject<{ getLiveHead: (sessionId: string) => SessionBufferHeadState | null }>;
    sessionPullStateRef: MutableRefObject<Map<string, SessionPullStates>>;
    tailRefreshStoreRef: MutableRefObject<SessionTailRefreshStore>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportResource?: (sessionId: string) => { socket?: BridgeTransportSocket | null } | null;
  daemonConnection?: ClientDaemonConnection;
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
  const session = options.refs.stateRef.current.sessions.find((item) => item.id === options.sessionId) || null;
  const activeWs = readBufferRuntimeSocket(options, options.sessionId);
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
  const liveHead = options.refs.sessionHeadStoreRef.current.getLiveHead(options.sessionId);
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
  const effectiveHead: SessionDaemonHeadView = options.requestOptions?.headOverride
    ? options.requestOptions.headOverride
    : liveHead
      ? {
          daemonHeadRevision: liveHead.revision,
          daemonHeadEndIndex: liveHead.latestEndIndex,
        }
      : {
          daemonHeadRevision: 0,
          daemonHeadEndIndex: 0,
        };
  const payload = buildSessionBufferSyncRequestPayload(
    effectiveHead,
    localBuffer,
    visibleRange,
    {
      purpose: options.requestOptions?.purpose,
      sameEndRefreshMode:
        options.refs.tailRefreshStoreRef.current.hasPendingConnectTailRefresh(options.sessionId)
        || options.refs.tailRefreshStoreRef.current.hasPendingResumeTailRefresh(options.sessionId)
          ? 'visible-window'
          : options.refs.tailRefreshStoreRef.current.hasPendingInputTailRefresh(options.sessionId)
            ? 'visible-window'
            : 'auto',
      forceSameEndRefresh: false,
      liveHead: options.requestOptions?.liveHead || liveHead || null,
      invalidLocalWindow: Boolean(options.requestOptions?.invalidLocalWindow),
      requestWindowOverride: explicitWindowOverride,
      requestMissingRangesOverride: explicitMissingRangesOverride,
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
      || Math.max(0, Math.floor(effectiveHead.daemonHeadRevision || 0)) > 0
      || Math.max(0, Math.floor(effectiveHead.daemonHeadEndIndex || 0)) > 0
    );
    if (doesSessionPullStateMatchExactLocalSnapshot(
      inFlightPull,
      payload,
      Math.max(0, Math.floor(effectiveHead.daemonHeadRevision || 0)),
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
        targetHeadRevision: Math.max(0, Math.floor(effectiveHead.daemonHeadRevision || 0)),
        requestStartIndex: payload.requestStartIndex,
        requestEndIndex: payload.requestEndIndex,
      },
    });
    options.clearSessionPullState(options.sessionId, requestPurpose);
    }
  }

  const now = Date.now();
  const previousSyncRequest = options.refs.tailRefreshStoreRef.current.readSyncRequest(options.sessionId, requestPurpose);
  const targetHeadRevision = Math.max(0, Math.floor(effectiveHead.daemonHeadRevision || 0));
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
        effectiveHead.daemonHeadEndIndex
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
  options.refs.tailRefreshStoreRef.current.recordSyncRequest(options.sessionId, requestPurpose, {
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
    reconnectStore?: SessionReconnectStore;
    sessionDebugMetricsStoreRef: MutableRefObject<SessionDebugMetricsRecorder>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportResource?: (sessionId: string) => { socket?: BridgeTransportSocket | null } | null;
  daemonConnection?: ClientDaemonConnection;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  resolveTerminalRefreshCadence: () => { headTickMs: number };
}) {
  const activeWs = readBufferRuntimeSocket(options, options.sessionId) || null;
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
  if (options.trackProbe !== false) {
    options.refs.reconnectStore?.markStaleTransportProbeIfAbsent(options.sessionId, now);
  }
  options.refs.sessionDebugMetricsStoreRef.current.recordRefreshRequest(options.sessionId);
  options.sendSocketPayload(options.sessionId, targetWs, JSON.stringify({
    type: 'buffer-head-request',
  } satisfies ClientMessage));
  return true;
}

interface ApplyIncomingBufferSyncRuntimeOptions {
  sessionId: string;
  payload: TerminalBufferPayload;
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    sessionRevisionResetRef: MutableRefObject<Map<string, RevisionResetExpectation>>;
    sessionHeadStoreRef: MutableRefObject<{ getLiveHead: (sessionId: string) => SessionBufferHeadState | null }>;
    tailRefreshStoreRef: MutableRefObject<SessionTailRefreshStore>;
    bufferFrameAssemblyRef: MutableRefObject<Map<string, BufferFrameAssemblyResourceState>>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, TerminalVisibleRange>>;
  };
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  resolveSessionCacheLines: (rows?: number | null) => number;
  summarizeBufferPayload: (payload: TerminalBufferPayload) => Record<string, unknown>;
  runtimeDebug: RuntimeDebugFn;
  commitSessionBufferUpdate: (sessionId: string, nextBuffer: SessionBufferState, options?: SessionBufferStoreCommitOptions) => boolean;
  scheduleSessionRenderCommit: (sessionId: string) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
  shouldAcceptSessionLiveBuffer?: (sessionId: string) => boolean;
  requestSessionBufferSync: RequestSessionBufferSyncFn;
}

type ApplyResolvedBufferSyncPayloadRuntimeOptions = Omit<
  ApplyIncomingBufferSyncRuntimeOptions,
  'payload'
> & {
  payload: BufferSyncIn03SparseApplyInput;
};

export function applyIncomingBufferSyncRuntime(options: ApplyIncomingBufferSyncRuntimeOptions) {
  const session = options.refs.stateRef.current.sessions.find((item) => item.id === options.sessionId) || null;
  if (!session) {
    return;
  }
  const localBuffer = options.readSessionBufferSnapshot(options.sessionId);
  const activeTransport = options.isSessionTransportActive(options.sessionId);
  const shouldAcceptLiveBuffer = activeTransport
    || Boolean(options.shouldAcceptSessionLiveBuffer?.(options.sessionId));
  if (!shouldAcceptLiveBuffer) {
    options.refs.tailRefreshStoreRef.current.clearPendingTailRefreshMarks(options.sessionId);
    const retainedFrameResource = clearPendingBufferSyncFrameAssembly(
      options.refs.bufferFrameAssemblyRef.current.get(options.sessionId) || null,
    );
    if (retainedFrameResource) {
      options.refs.bufferFrameAssemblyRef.current.set(options.sessionId, retainedFrameResource);
    }
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

  const frameAssemblyStore = options.refs.bufferFrameAssemblyRef.current;
  const currentFrameResource = frameAssemblyStore.get(options.sessionId) || null;
  const frameAssembly = assembleBufferSyncFrameChunk(
    currentFrameResource?.pending || null,
    options.payload,
    Date.now(),
  );
  if (frameAssembly.kind === 'pending') {
    const retainedError = currentFrameResource?.error || null;
    const errorSuperseded = retainedError !== null && (
      frameAssembly.supersededFrameKey !== undefined
      || retainedError.revision === null
      || retainedError.revision < frameAssembly.state.revision
    );
    frameAssemblyStore.set(options.sessionId, {
      pending: frameAssembly.state,
      error: errorSuperseded ? null : retainedError,
      repairDispatchedRevisions: currentFrameResource?.repairDispatchedRevisions ?? [],
    });
    options.runtimeDebug('session.buffer.frame.pending', {
      sessionId: options.sessionId,
      frameKey: frameAssembly.state.frameKey,
      revision: frameAssembly.state.revision,
      receivedChunkCount: frameAssembly.state.chunks.size,
      frameChunkCount: frameAssembly.state.frameChunkCount,
      supersededFrameKey: frameAssembly.supersededFrameKey ?? null,
    });
    return;
  }
  if (frameAssembly.kind === 'rejected') {
    projectRejectedBufferFrameRuntime({
      sessionId: options.sessionId,
      rejection: frameAssembly,
      currentResource: currentFrameResource,
      frameAssemblyStore,
      tailRefreshStore: options.refs.tailRefreshStoreRef.current,
      liveHead: options.refs.sessionHeadStoreRef.current.getLiveHead(options.sessionId),
      requestSessionBufferSync: options.requestSessionBufferSync,
      runtimeDebug: options.runtimeDebug,
      incomingSummary: options.summarizeBufferPayload(options.payload),
    });
    return;
  }
  if (frameAssembly.kind === 'complete') {
    options.runtimeDebug('session.buffer.frame.complete', {
      sessionId: options.sessionId,
      revision: frameAssembly.payload.revision,
      frameStartIndex: frameAssembly.payload.startIndex,
      frameEndIndex: frameAssembly.payload.endIndex,
      lineCount: frameAssembly.payload.lines.length,
    });
    const accepted = applyResolvedBufferSyncPayloadRuntime({
      ...options,
      payload: frameAssembly.payload,
    });
    if (accepted) {
      settleBufferFrameResourceAfterResolvedPayload({
        sessionId: options.sessionId,
        currentResource: currentFrameResource,
        frameAssemblyStore,
      });
    }
    return;
  }

  const accepted = applyResolvedBufferSyncPayloadRuntime({
    ...options,
    payload: frameAssembly.payload,
  });
  if (accepted) {
    settleBufferFrameResourceAfterResolvedPayload({
      sessionId: options.sessionId,
      currentResource: currentFrameResource,
      frameAssemblyStore,
    });
  }
}

function applyResolvedBufferSyncPayloadRuntime(options: ApplyResolvedBufferSyncPayloadRuntimeOptions) {
  const localBuffer = options.readSessionBufferSnapshot(options.sessionId);
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
    options.refs.tailRefreshStoreRef.current.clearSyncRequest(options.sessionId, 'tail-refresh');
    options.requestSessionBufferSync(options.sessionId, {
      reason: 'revision-reset-empty-payload-retry',
      purpose: 'tail-refresh',
      headOverride: {
        daemonHeadRevision: revisionResetExpectation.revision,
        daemonHeadEndIndex: revisionResetExpectation.latestEndIndex,
      },
      liveHead: options.refs.sessionHeadStoreRef.current.getLiveHead(options.sessionId) || {
        revision: revisionResetExpectation.revision,
        latestEndIndex: revisionResetExpectation.latestEndIndex,
        seenAt: revisionResetExpectation.seenAt,
      },
    });
    return false;
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
    const liveHead = options.refs.sessionHeadStoreRef.current.getLiveHead(options.sessionId) || {
      revision: localRevision,
      latestEndIndex: Math.max(0, Math.floor(localBuffer.bufferTailEndIndex || localBuffer.endIndex || 0)),
      availableStartIndex: Math.max(0, Math.floor(localBuffer.bufferHeadStartIndex || localBuffer.startIndex || 0)),
      availableEndIndex: Math.max(0, Math.floor(localBuffer.bufferTailEndIndex || localBuffer.endIndex || 0)),
      seenAt: Date.now(),
    };
    options.refs.tailRefreshStoreRef.current.clearSyncRequest(options.sessionId, 'tail-refresh');
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
      headOverride: {
        daemonHeadRevision: liveHead.revision,
        daemonHeadEndIndex: liveHead.latestEndIndex,
      },
      liveHead,
    });
    return false;
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
  const pendingSameRevisionRefreshPurpose = sameRevisionOverwrite
    ? resolvePendingSameRevisionRefreshPurpose({
        sessionId: options.sessionId,
        payload: options.payload,
        localBuffer,
        refs: options.refs,
        conflictRange: {
          startIndex: sameRevisionOverwrite.firstConflictIndex ?? sameRevisionOverwrite.incomingStartIndex,
          endIndex: (sameRevisionOverwrite.lastConflictIndex ?? (sameRevisionOverwrite.incomingEndIndex - 1)) + 1,
        },
      })
    : null;
  if (sameRevisionOverwrite && !pendingSameRevisionRefreshPurpose) {
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
    return false;
  }
  if (sameRevisionOverwrite && pendingSameRevisionRefreshPurpose) {
    options.refs.tailRefreshStoreRef.current.clearSyncRequest(options.sessionId, pendingSameRevisionRefreshPurpose);
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
    const liveHead = options.refs.sessionHeadStoreRef.current.getLiveHead(options.sessionId) || {
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
    options.refs.tailRefreshStoreRef.current.clearSyncRequest(options.sessionId, 'tail-refresh');
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
      headOverride: {
        daemonHeadRevision: liveHead.revision,
        daemonHeadEndIndex: liveHead.latestEndIndex,
      },
      liveHead,
    });
    return false;
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

  const liveHead = options.refs.sessionHeadStoreRef.current.getLiveHead(options.sessionId);
  const inputTailRefresh = options.refs.tailRefreshStoreRef.current.readPendingInputTailRefresh(options.sessionId);
  if (
    inputTailRefresh
    && (
      nextBuffer.revision > Math.max(0, Math.floor(inputTailRefresh.localRevision || 0))
      && (!liveHead || nextBuffer.revision >= Math.max(0, Math.floor(liveHead.revision || 0)))
    )
  ) {
    options.refs.tailRefreshStoreRef.current.clearPendingInputTailRefresh(options.sessionId);
  }
  if (
    options.refs.tailRefreshStoreRef.current.hasPendingConnectTailRefresh(options.sessionId)
    && (
      nextBuffer.endIndex !== localBuffer.endIndex
      || nextBuffer.revision > Math.max(0, Math.floor(localBuffer.revision || 0))
      || (liveHead && nextBuffer.revision >= Math.max(0, Math.floor(liveHead.revision || 0)))
    )
  ) {
    options.refs.tailRefreshStoreRef.current.clearPendingConnectTailRefresh(options.sessionId);
  }
  if (
    options.refs.tailRefreshStoreRef.current.hasPendingResumeTailRefresh(options.sessionId)
    && (
      nextBuffer.endIndex !== localBuffer.endIndex
      || nextBuffer.revision > Math.max(0, Math.floor(localBuffer.revision || 0))
      || (liveHead && nextBuffer.revision >= Math.max(0, Math.floor(liveHead.revision || 0)))
    )
  ) {
    options.refs.tailRefreshStoreRef.current.clearPendingResumeTailRefresh(options.sessionId);
  }

  const payloadRevision = Math.max(0, Math.floor(options.payload.revision || 0));
  const payloadAvailableEndIndex = Number.isFinite(options.payload.availableEndIndex)
    ? Math.max(0, Math.floor(options.payload.availableEndIndex || 0))
    : 0;
  const nextHead: SessionDaemonHeadView = {
    daemonHeadRevision: Math.max(
      liveHead?.revision ?? 0,
      payloadRevision,
      Math.max(0, Math.floor(nextBuffer.revision || 0)),
    ),
    daemonHeadEndIndex: Math.max(
      liveHead?.latestEndIndex ?? 0,
      payloadAvailableEndIndex,
      Math.max(0, Math.floor(nextBuffer.bufferTailEndIndex || nextBuffer.endIndex || 0)),
    ),
  };
  const visibleRange = resolvePostApplyVisibleRange({
    head: nextHead,
    previousBuffer: localBuffer,
    nextBuffer,
    visibleRange: options.refs.sessionVisibleRangeRef.current.get(options.sessionId) || null,
  });

  if (sessionBuffersEqual(localBuffer, nextBuffer)) {
    fulfillVisibleNonGapRepairLedgerIfAuthoritative({
      sessionId: options.sessionId,
      payload: options.payload,
      nextBuffer,
      tailRefreshStore: options.refs.tailRefreshStoreRef.current,
      visibleRange,
    });
    options.runtimeDebug('session.buffer.apply.noop', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      incoming: options.summarizeBufferPayload(options.payload),
      localRevision: localBuffer.revision,
      localStartIndex: localBuffer.startIndex,
      localEndIndex: localBuffer.endIndex,
    });
    return true;
  }

  const changed = options.commitSessionBufferUpdate(options.sessionId, nextBuffer, { skipEqualCheck: true });
  if (!changed) {
    return false;
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

  fulfillVisibleNonGapRepairLedgerIfAuthoritative({
    sessionId: options.sessionId,
    payload: options.payload,
    nextBuffer,
    tailRefreshStore: options.refs.tailRefreshStoreRef.current,
    visibleRange,
  });

  if (shouldCatchUpFollowTailAfterBufferApply(nextHead, nextBuffer, visibleRange, {
    forceSameEndRefresh:
      options.refs.tailRefreshStoreRef.current.hasPendingConnectTailRefresh(options.sessionId)
      || options.refs.tailRefreshStoreRef.current.hasPendingResumeTailRefresh(options.sessionId),
  })) {
    options.requestSessionBufferSync(options.sessionId, {
      reason: 'buffer-sync-catchup',
      purpose: 'tail-refresh',
      headOverride: nextHead,
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
    return true;
  }

  const visibleNonGapRepairRequest = resolveVisibleNonGapRepairRequestAfterSparseAdvance({
    payload: options.payload,
    previousBuffer: localBuffer,
    nextBuffer,
    visibleRange,
  });
  if (visibleNonGapRepairRequest) {
    const repairRange = {
      startIndex: visibleNonGapRepairRequest.requestStartIndex,
      endIndex: visibleNonGapRepairRequest.requestEndIndex,
    };
    if (shouldSuppressRecentVisibleNonGapRepair({
      sessionId: options.sessionId,
      requestStartIndex: repairRange.startIndex,
      requestEndIndex: repairRange.endIndex,
      tailEndIndex: nextBuffer.bufferTailEndIndex,
      tailRefreshStore: options.refs.tailRefreshStoreRef.current,
    })) {
      options.runtimeDebug('session.buffer.sync.visible-stale-non-gap-repair-suppressed', {
        sessionId: options.sessionId,
        activeSessionId: options.refs.stateRef.current.activeSessionId,
        previousRevision: localBuffer.revision,
        nextRevision: nextBuffer.revision,
        requestStartIndex: repairRange.startIndex,
        requestEndIndex: repairRange.endIndex,
        tailEndIndex: nextBuffer.bufferTailEndIndex,
        staleMs: VISIBLE_NON_GAP_REPAIR_STALE_MS,
      });
      return true;
    }
    options.runtimeDebug('session.buffer.sync.visible-stale-non-gap-repair-request', {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      previousRevision: localBuffer.revision,
      nextRevision: nextBuffer.revision,
      tailEndIndex: nextBuffer.bufferTailEndIndex,
      incoming: options.summarizeBufferPayload(options.payload),
      requestStartIndex: repairRange.startIndex,
      requestEndIndex: repairRange.endIndex,
    });
    const requested = options.requestSessionBufferSync(options.sessionId, {
      reason: 'buffer-sync-visible-stale-non-gap-repair',
      purpose: 'reading-repair',
      headOverride: nextHead,
      liveHead,
      requestWindowOverride: {
        requestStartIndex: repairRange.startIndex,
        requestEndIndex: repairRange.endIndex,
      },
      requestMissingRangesOverride: [repairRange],
    });
    const ledgerKey = {
      requestStartIndex: repairRange.startIndex,
      requestEndIndex: repairRange.endIndex,
      tailEndIndex: nextBuffer.bufferTailEndIndex,
      targetRevision: nextBuffer.revision,
    };
    if (requested) {
      options.refs.tailRefreshStoreRef.current.recordVisibleNonGapRepairRequest(options.sessionId, {
        requestedAt: Date.now(),
        ...ledgerKey,
      });
    } else if (!options.refs.tailRefreshStoreRef.current.readVisibleNonGapRepair(options.sessionId, ledgerKey)) {
      options.refs.tailRefreshStoreRef.current.markVisibleNonGapRepairPending(options.sessionId, ledgerKey);
    }
    return true;
  }

  if (!shouldPullVisibleRangeBuffer(nextHead, visibleRange, liveHead, nextBuffer)) {
    return true;
  }

  options.requestSessionBufferSync(options.sessionId, {
    reason: 'buffer-sync-visible-range-repair-catchup',
    purpose: 'reading-repair',
    headOverride: nextHead,
  });
  return true;
}
