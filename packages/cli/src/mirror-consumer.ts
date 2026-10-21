import type {
  BridgeServerMessage,
} from '../../shared/src/connection/protocol.js';
import {
  applyBufferSyncToSessionBuffer,
  createSessionBufferState,
  sessionBuffersEqual,
} from '../../shared/src/connection/terminal-buffer.js';
import type {
  BufferHeadPayload,
  BufferSyncRequestPayload,
  SessionBufferState,
  TerminalBufferPayload,
  TerminalCell,
  TerminalCursorState,
  TerminalGapRange,
} from '../../shared/src/connection/types.js';
import {
  TERMINAL_BUFFER_SYNC_FRAME_MAX_AGE_MS,
} from '../../shared/src/connection/types.js';
import {
  assembleBufferSyncFrameChunk,
  clearPendingBufferSyncFrameAssembly,
  expireBufferSyncFrameAssembly,
  hasBufferFrameRepairDispatch,
  recordBufferFrameRepairDispatch,
  resetBufferSyncFrameAssemblyEpoch,
  type BufferFrameAssemblyError,
  type BufferFrameAssemblyRepairRange,
  type BufferFrameAssemblyResourceState,
  type BufferSyncIn03SparseApplyInput,
} from '../../shared/src/terminal/buffer-frame-assembly/session-buffer-frame-assembly.js';
import {
  hasLocalWindow,
} from '../../shared/src/terminal/buffer-head-state.js';
import {
  shouldPullFollowBuffer,
} from '../../shared/src/terminal/buffer-sync-planner.js';
import {
  resolveTailRefreshWindow,
} from '../../shared/src/terminal/buffer-sync-request-planner.js';
import {
  computeVisibleRangeRepairRanges,
} from '../../shared/src/terminal/gap-repair-planner.js';
import {
  resolveRequestedBufferWindow,
} from '../../shared/src/terminal/gap-utils.js';
import {
  resolveTerminalRequestWindowLines,
} from '../../shared/src/terminal/viewport-utils.js';
import type {
  RendererVisibleRangeDemand,
} from './renderer-window.js';

export type MirrorBufferHeadRequest = {
  type: 'buffer-head-request';
};

export type MirrorBufferSyncRequest = {
  type: 'buffer-sync-request';
  payload: BufferSyncRequestPayload;
};

export type MirrorRequestMessage =
  | MirrorBufferHeadRequest
  | MirrorBufferSyncRequest;

export interface MirrorMetadataEvent {
  sessionId: string;
  head: BufferHeadPayload;
  cursor: TerminalCursorState | null;
}

export interface MirrorCommitEvent {
  sessionId: string;
  snapshot: MirrorBodySnapshot;
  metadata: {
    revision: number;
    cursorKeysApp: boolean;
    cursor: TerminalCursorState | null;
    headCursor: TerminalCursorState | null;
  };
}

export interface MirrorBodySnapshot {
  revision: number;
  startIndex: number;
  endIndex: number;
  lines: ReadonlyMap<number, readonly TerminalCell[]>;
  gapRanges: readonly TerminalGapRange[];
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  cursor: TerminalCursorState | null;
}

export interface MirrorSessionSnapshot {
  epoch: number;
  cacheLines: number;
  head: {
    revision: number;
    latestEndIndex: number;
    availableStartIndex: number;
    availableEndIndex: number;
  } | null;
  cursor: TerminalCursorState | null;
  body: MirrorBodySnapshot;
  visibleDemand: RendererVisibleRangeDemand | null;
  requestState: {
    lastRequestedAt: number;
    lastRequest: MirrorRequestMessage | null;
  };
  frameAssembly: {
    pending: {
      revision: number;
      receivedChunkCount: number;
      chunkCount: number;
      frameKey: string;
    } | null;
    error: {
      error: BufferFrameAssemblyError;
      revision: number | null;
      repair: {
        status: 'not-required' | 'unavailable' | 'pending' | 'dispatched';
        range: BufferFrameAssemblyRepairRange | null;
      };
    } | null;
    repairDispatchedRevisions: readonly number[];
  };
}

export interface MirrorConsumerOptions {
  cacheLines?: number;
  visibleRows?: number;
  visibleCols?: number;
  headRequestDebounceMs?: number;
  sendRequest: (message: MirrorRequestMessage) => boolean;
  onCommit?: (event: MirrorCommitEvent) => void;
  onMetadata?: (event: MirrorMetadataEvent) => void;
}

interface SessionRuntime {
  sessionId: string;
  epoch: number;
  cacheLines: number;
  head: {
    revision: number;
    latestEndIndex: number;
    availableStartIndex: number;
    availableEndIndex: number;
  } | null;
  cursor: TerminalCursorState | null;
  body: SessionBufferState;
  visibleDemand: RendererVisibleRangeDemand | null;
  frameAssembly: BufferFrameAssemblyResourceState;
  rejectedEpochRevisionCeiling: number | null;
  epochResetPending: boolean;
  lastHeadRequestAt: number;
  lastRequestAt: number;
  lastRequest: MirrorRequestMessage | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_CACHE_LINES = 1000;
const DEFAULT_VISIBLE_ROWS = 24;
const DEFAULT_VISIBLE_COLS = 80;
const HEAD_REQUEST_DEBOUNCE_MS = 33;

function safeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function toPositiveInteger(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function nonNegativeInteger(value: unknown) {
  const integer = safeInteger(value);
  return integer === null ? 0 : Math.max(0, integer);
}

function readTerminalCursor(cursor: TerminalBufferPayload['cursor']): TerminalCursorState | null {
  if (!cursor) {
    return null;
  }
  const rowIndex = safeInteger(cursor.rowIndex);
  const col = safeInteger(cursor.col);
  if (rowIndex === null || col === null) {
    return null;
  }
  return {
    rowIndex: Math.max(0, rowIndex),
    col: Math.max(0, col),
    visible: Boolean(cursor.visible),
  };
}

function cloneCursor(cursor: TerminalCursorState | null): TerminalCursorState | null {
  return cursor ? { ...cursor } : null;
}

function immutableCells(cells: readonly TerminalCell[]): readonly TerminalCell[] {
  return Object.freeze(cells.map((cell) => Object.freeze({ ...cell })));
}

function cloneGapRanges(gapRanges: readonly TerminalGapRange[]): readonly TerminalGapRange[] {
  return Object.freeze(gapRanges.map((range) => Object.freeze({ ...range })));
}

function isGapIndex(gapRanges: readonly TerminalGapRange[], absoluteIndex: number) {
  for (const range of gapRanges) {
    if (absoluteIndex >= range.startIndex && absoluteIndex < range.endIndex) {
      return true;
    }
  }
  return false;
}

function bufferToBodySnapshot(buffer: SessionBufferState): MirrorBodySnapshot {
  const lines = new Map<number, readonly TerminalCell[]>();
  for (let absoluteIndex = buffer.startIndex; absoluteIndex < buffer.endIndex; absoluteIndex += 1) {
    const offset = absoluteIndex - buffer.startIndex;
    if (!isGapIndex(buffer.gapRanges, absoluteIndex)) {
      lines.set(absoluteIndex, immutableCells(buffer.lines[offset] || []));
    }
  }
  return {
    revision: buffer.revision,
    startIndex: buffer.startIndex,
    endIndex: buffer.endIndex,
    lines,
    gapRanges: cloneGapRanges(buffer.gapRanges),
    cols: buffer.cols,
    rows: buffer.rows,
    cursorKeysApp: buffer.cursorKeysApp,
    cursor: cloneCursor(buffer.cursor),
  };
}

function headBounds(session: SessionRuntime) {
  return {
    daemonHeadRevision: session.head?.revision ?? 0,
    daemonHeadEndIndex: session.head?.latestEndIndex ?? 0,
    availableStartIndex: session.head?.availableStartIndex ?? 0,
    availableEndIndex: session.head?.availableEndIndex ?? 0,
  };
}

function createFrameAssemblyResource(): BufferFrameAssemblyResourceState {
  return {
    pending: null,
    error: null,
    repairDispatchedRevisions: [],
  };
}

function visibleGapRanges(session: SessionRuntime): TerminalGapRange[] {
  const visibleDemand = session.visibleDemand;
  if (!visibleDemand || visibleDemand.endIndex <= visibleDemand.startIndex) {
    return [];
  }
  return computeVisibleRangeRepairRanges({
    visibleStartIndex: visibleDemand.startIndex,
    visibleEndIndex: visibleDemand.endIndex,
    localStartIndex: session.body.startIndex,
    localEndIndex: session.body.endIndex,
    localGapRanges: session.body.gapRanges,
  });
}

function resolveRequestEndIndex(session: SessionRuntime, demand: RendererVisibleRangeDemand) {
  const availableEndIndex = session.head?.availableEndIndex;
  if (typeof availableEndIndex === 'number' && Number.isFinite(availableEndIndex)) {
    return Math.min(demand.endIndex, Math.max(0, Math.floor(availableEndIndex)));
  }
  return demand.endIndex;
}

function buildTailRefreshRequest(session: SessionRuntime): MirrorBufferSyncRequest | null {
  const visibleDemand = session.visibleDemand;
  if (!visibleDemand) {
    return null;
  }
  const head = headBounds(session);
  const viewportEndIndex = resolveRequestEndIndex(session, visibleDemand);
  const requestWindowLines = resolveTerminalRequestWindowLines(visibleDemand.visibleRows);
  const localHasWindow = hasLocalWindow(session.body.startIndex, session.body.endIndex, session.body.revision);
  const distanceToHead = Math.max(0, viewportEndIndex - session.body.endIndex);
  const sameEndRevisionAdvanced = (
    localHasWindow
    && distanceToHead === 0
    && head.daemonHeadRevision > session.body.revision
  );
  const window = resolveTailRefreshWindow({
    authoritativeHeadStartIndex: head.availableStartIndex,
    viewportEndIndex,
    viewportRows: visibleDemand.visibleRows,
    cacheLines: requestWindowLines,
    localHasWindow,
    distanceToHead,
    sameEndRevisionAdvanced,
    sameEndWindowHasLocalGaps: visibleGapRanges(session).length > 0,
    invalidLocalWindow: false,
    requestWindowOverride: null,
  });
  return {
    type: 'buffer-sync-request',
    payload: {
      knownRevision: session.body.revision,
      localStartIndex: session.body.startIndex,
      localEndIndex: session.body.endIndex,
      requestStartIndex: window.requestStartIndex,
      requestEndIndex: window.requestEndIndex,
      targetHeadRevision: head.daemonHeadRevision,
    },
  };
}

function buildReadingRepairRequest(session: SessionRuntime): MirrorBufferSyncRequest | null {
  const visibleDemand = session.visibleDemand;
  if (!visibleDemand) {
    return null;
  }
  const missingRanges = visibleGapRanges(session);
  if (missingRanges.length === 0) {
    return null;
  }
  const head = headBounds(session);
  const viewportEndIndex = resolveRequestEndIndex(session, visibleDemand);
  const window = resolveRequestedBufferWindow(
    viewportEndIndex,
    visibleDemand.visibleRows,
    resolveTerminalRequestWindowLines(visibleDemand.visibleRows),
    head.availableStartIndex,
  );
  return {
    type: 'buffer-sync-request',
    payload: {
      knownRevision: session.body.revision,
      localStartIndex: session.body.startIndex,
      localEndIndex: session.body.endIndex,
      requestStartIndex: window.requestStartIndex,
      requestEndIndex: window.requestEndIndex,
      targetHeadRevision: head.daemonHeadRevision,
      missingRanges: missingRanges.map((range) => ({ ...range })),
    },
  };
}

function shouldRequestTail(session: SessionRuntime) {
  const visibleDemand = session.visibleDemand;
  if (!visibleDemand) {
    return false;
  }
  const head = headBounds(session);
  const viewportEndIndex = resolveRequestEndIndex(session, visibleDemand);
  return shouldPullFollowBuffer({
    localHasWindow: hasLocalWindow(session.body.startIndex, session.body.endIndex, session.body.revision),
    distanceToHead: Math.max(0, viewportEndIndex - session.body.endIndex),
    cacheLines: resolveTerminalRequestWindowLines(visibleDemand.visibleRows),
    localEndIndex: session.body.endIndex,
    desiredEndIndex: viewportEndIndex,
    daemonRevision: head.daemonHeadRevision,
    localRevision: session.body.revision,
  });
}

function recordAcceptedRequest(
  session: SessionRuntime,
  request: MirrorRequestMessage,
  now: number,
) {
  session.lastRequestAt = now;
  session.lastRequest = request;
}

function dispatchRequest(
  session: SessionRuntime,
  request: MirrorBufferSyncRequest | null,
  options: {
    sendRequest: (message: MirrorRequestMessage) => boolean;
    now: number;
  },
) {
  if (!request) {
    return false;
  }
  if (!options.sendRequest(request)) {
    return false;
  }
  recordAcceptedRequest(session, request, options.now);
  return true;
}

function requestHead(
  session: SessionRuntime,
  options: {
    headRequestDebounceMs: number;
    sendRequest: (message: MirrorRequestMessage) => boolean;
    now: number;
  },
) {
  if (options.now - session.lastHeadRequestAt < options.headRequestDebounceMs) {
    return false;
  }
  const request: MirrorBufferHeadRequest = { type: 'buffer-head-request' };
  if (!options.sendRequest(request)) {
    return false;
  }
  session.lastHeadRequestAt = options.now;
  recordAcceptedRequest(session, request, options.now);
  return true;
}

function requestVisibleBuffer(
  session: SessionRuntime,
  options: {
    headRequestDebounceMs: number;
    sendRequest: (message: MirrorRequestMessage) => boolean;
    now: number;
  },
) {
  if (!session.visibleDemand) {
    return false;
  }
  if (!session.head) {
    return requestHead(session, options);
  }
  if (shouldRequestTail(session)) {
    return dispatchRequest(session, buildTailRefreshRequest(session), options);
  }
  return dispatchRequest(session, buildReadingRepairRequest(session), options);
}

function createEmptyBody(options: {
  cacheLines: number;
  cols: number;
  rows: number;
}) {
  return createSessionBufferState({
    lines: [],
    startIndex: 0,
    endIndex: 0,
    bufferHeadStartIndex: 0,
    bufferTailEndIndex: 0,
    cols: options.cols,
    rows: options.rows,
    cursorKeysApp: false,
    cursor: null,
    revision: 0,
    cacheLines: options.cacheLines,
  });
}

function copyRequest(request: MirrorRequestMessage | null): MirrorRequestMessage | null {
  if (!request) {
    return null;
  }
  if (request.type === 'buffer-head-request') {
    return { type: 'buffer-head-request' };
  }
  return {
    type: 'buffer-sync-request',
    payload: {
      ...request.payload,
      ...(request.payload.missingRanges
        ? { missingRanges: request.payload.missingRanges.map((range) => ({ ...range })) }
        : {}),
    },
  };
}

function copyRepairRange(range: BufferFrameAssemblyRepairRange | null) {
  return range ? { ...range } : null;
}

function coveredWithoutGaps(
  body: SessionBufferState,
  range: BufferFrameAssemblyRepairRange,
) {
  if (body.startIndex > range.startIndex || body.endIndex < range.endIndex) {
    return false;
  }
  for (let index = range.startIndex; index < range.endIndex; index += 1) {
    if (isGapIndex(body.gapRanges, index)) {
      return false;
    }
  }
  return true;
}

function reconcileFrameRepair(
  session: SessionRuntime,
  body: SessionBufferState,
) {
  const error = session.frameAssembly.error;
  const repair = error?.repair;
  if (!error || !repair?.range) {
    return;
  }
  const targetRevision = error.revision;
  if (targetRevision !== null && body.revision < targetRevision) {
    return;
  }
  if (!coveredWithoutGaps(body, repair.range)) {
    return;
  }
  session.frameAssembly = {
    ...session.frameAssembly,
    error: null,
  };
}

function buildRepairRequest(
  session: SessionRuntime,
  range: BufferFrameAssemblyRepairRange,
  targetRevision: number,
): MirrorBufferSyncRequest {
  return {
    type: 'buffer-sync-request',
    payload: {
      knownRevision: session.body.revision,
      localStartIndex: session.body.startIndex,
      localEndIndex: session.body.endIndex,
      requestStartIndex: range.startIndex,
      requestEndIndex: range.endIndex,
      targetHeadRevision: targetRevision,
      missingRanges: [{ ...range }],
    },
  };
}

function dispatchPendingFrameRepair(
  session: SessionRuntime,
  options: {
    sendRequest: (message: MirrorRequestMessage) => boolean;
    now: number;
  },
) {
  const error = session.frameAssembly.error;
  if (!error || error.repair.status !== 'pending' || !error.repair.range) {
    return false;
  }
  const targetRevision = error.revision;
  if (targetRevision === null) {
    session.frameAssembly = {
      ...session.frameAssembly,
      error: {
        ...error,
        repair: {
          status: 'unavailable',
          range: copyRepairRange(error.repair.range),
        },
      },
    };
    return false;
  }
  if (hasBufferFrameRepairDispatch(
    session.frameAssembly.repairDispatchedRevisions,
    targetRevision,
  )) {
    session.frameAssembly = {
      ...session.frameAssembly,
      error: {
        ...error,
        repair: {
          status: 'dispatched',
          range: copyRepairRange(error.repair.range),
        },
      },
    };
    return false;
  }
  const request = buildRepairRequest(session, error.repair.range, targetRevision);
  if (!options.sendRequest(request)) {
    return false;
  }
  session.frameAssembly = {
    ...session.frameAssembly,
    error: {
      ...error,
      repair: {
        status: 'dispatched',
        range: copyRepairRange(error.repair.range),
      },
    },
    repairDispatchedRevisions: recordBufferFrameRepairDispatch(
      session.frameAssembly.repairDispatchedRevisions,
      targetRevision,
    ),
  };
  recordAcceptedRequest(session, request, options.now);
  return true;
}

function projectFrameRejection(
  session: SessionRuntime,
  rejection: {
    error: BufferFrameAssemblyError;
    state: BufferFrameAssemblyResourceState['pending'];
    repairRange: BufferFrameAssemblyRepairRange | null;
    repairRevision: number | null;
  },
  options: {
    sendRequest: (message: MirrorRequestMessage) => boolean;
    now: number;
  },
) {
  const current = session.frameAssembly;
  if (rejection.error === 'stale-frame') {
    session.frameAssembly = {
      ...current,
      pending: rejection.state,
    };
    return;
  }
  if (
    current.error
    && current.error.revision !== null
    && rejection.repairRevision !== null
    && rejection.repairRevision < current.error.revision
  ) {
    session.frameAssembly = {
      ...current,
      pending: rejection.state,
    };
    return;
  }

  const targetRevision = rejection.repairRevision
    ?? (session.head && session.head.revision > 0 ? session.head.revision : null);
  const repairRange = copyRepairRange(rejection.repairRange);
  const dispatched = targetRevision !== null
    && hasBufferFrameRepairDispatch(
      current.repairDispatchedRevisions,
      targetRevision,
    );
  session.frameAssembly = {
    pending: rejection.state,
    error: {
      error: rejection.error,
      revision: targetRevision,
      repair: repairRange
        ? {
            status: dispatched ? 'dispatched' : 'pending',
            range: repairRange,
          }
        : {
            status: 'unavailable',
            range: null,
          },
    },
    repairDispatchedRevisions: current.repairDispatchedRevisions,
  };
  dispatchPendingFrameRepair(session, options);
}

function expirePendingFrames(
  session: SessionRuntime,
  options: {
    sendRequest: (message: MirrorRequestMessage) => boolean;
    now: number;
  },
) {
  const pending = session.frameAssembly.pending;
  const expired = expireBufferSyncFrameAssembly(pending, options.now);
  if (expired?.kind === 'rejected') {
    projectFrameRejection(session, expired, options);
  }
}

function normalizeHead(payload: BufferHeadPayload) {
  const revision = nonNegativeInteger(payload.revision);
  const latestEndIndex = nonNegativeInteger(payload.latestEndIndex);
  const availableStartIndex = nonNegativeInteger(payload.availableStartIndex);
  const rawAvailableEndIndex = payload.availableEndIndex === undefined
    ? Math.max(availableStartIndex, latestEndIndex)
    : nonNegativeInteger(payload.availableEndIndex);
  return {
    revision,
    latestEndIndex,
    availableStartIndex,
    availableEndIndex: Math.max(availableStartIndex, rawAvailableEndIndex),
  };
}

function handleHead(
  session: SessionRuntime,
  payload: BufferHeadPayload,
  options: {
    headRequestDebounceMs: number;
    sendRequest: (message: MirrorRequestMessage) => boolean;
    onMetadata?: (event: MirrorMetadataEvent) => void;
    now: number;
  },
) {
  const previousHead = session.head;
  const nextHead = normalizeHead(payload);
  const resetBoundary = previousHead?.revision ?? session.body.revision;
  const startsNewEpoch = nextHead.revision < resetBoundary;

  if (startsNewEpoch) {
    const pendingRevision = session.frameAssembly.pending?.revision ?? 0;
    const errorRevision = session.frameAssembly.error?.revision ?? 0;
    const ceiling = Math.max(
      session.body.revision,
      previousHead?.revision ?? 0,
      pendingRevision,
      errorRevision,
    );
    session.epoch += 1;
    session.frameAssembly = resetBufferSyncFrameAssemblyEpoch(session.frameAssembly)
      ?? createFrameAssemblyResource();
    session.rejectedEpochRevisionCeiling = ceiling > 0 ? ceiling : null;
    session.epochResetPending = true;
    session.cursor = payload.cursor === undefined
      ? null
      : readTerminalCursor(payload.cursor);
  } else {
    expirePendingFrames(session, {
      sendRequest: options.sendRequest,
      now: options.now,
    });
    if (payload.cursor !== undefined) {
      session.cursor = readTerminalCursor(payload.cursor);
    }
    if (
      session.rejectedEpochRevisionCeiling !== null
      && nextHead.revision > session.rejectedEpochRevisionCeiling
    ) {
      session.rejectedEpochRevisionCeiling = null;
      session.epochResetPending = false;
    }
  }

  session.head = nextHead;
  const metadataHead: BufferHeadPayload = {
    sessionId: payload.sessionId,
    ...nextHead,
    ...(payload.cursorKeysApp === undefined
      ? {}
      : { cursorKeysApp: payload.cursorKeysApp }),
    cursor: cloneCursor(session.cursor),
  };
  options.onMetadata?.({
    sessionId: session.sessionId,
    head: metadataHead,
    cursor: cloneCursor(session.cursor),
  });
  dispatchPendingFrameRepair(session, {
    sendRequest: options.sendRequest,
    now: options.now,
  });
  requestVisibleBuffer(session, {
    headRequestDebounceMs: options.headRequestDebounceMs,
    sendRequest: options.sendRequest,
    now: options.now,
  });
}

function isRejectedEpochPayload(session: SessionRuntime, revision: number) {
  const ceiling = session.rejectedEpochRevisionCeiling;
  if (ceiling === null || !session.head) {
    return false;
  }
  return revision > session.head.revision && revision <= ceiling;
}

function handleBufferSync(
  session: SessionRuntime,
  payload: TerminalBufferPayload,
  options: {
    sendRequest: (message: MirrorRequestMessage) => boolean;
    onCommit?: (event: MirrorCommitEvent) => void;
    onVisibleDemandChange: () => void;
    now: number;
  },
) {
  const revision = nonNegativeInteger(payload.revision);
  if (isRejectedEpochPayload(session, revision)) {
    return;
  }
  if (
    session.rejectedEpochRevisionCeiling !== null
    && revision > session.rejectedEpochRevisionCeiling
  ) {
    session.rejectedEpochRevisionCeiling = null;
    session.epochResetPending = false;
  }

  const result = assembleBufferSyncFrameChunk(
    session.frameAssembly.pending,
    payload,
    options.now,
  );
  if (result.kind === 'pending') {
    session.frameAssembly = {
      ...session.frameAssembly,
      pending: result.state,
    };
    return;
  }
  if (result.kind === 'rejected') {
    projectFrameRejection(session, result, {
      sendRequest: options.sendRequest,
      now: options.now,
    });
    return;
  }

  session.frameAssembly = clearPendingBufferSyncFrameAssembly(session.frameAssembly)
    ?? createFrameAssemblyResource();
  const resolvedPayload: BufferSyncIn03SparseApplyInput = result.payload;
  const payloadRevision = nonNegativeInteger(resolvedPayload.revision);
  if (
    session.epochResetPending
    && session.head
    && payloadRevision > 0
    && payloadRevision <= session.head.revision
  ) {
    session.body = createEmptyBody({
      cacheLines: session.cacheLines,
      cols: session.body.cols,
      rows: session.body.rows,
    });
    session.epochResetPending = false;
    session.rejectedEpochRevisionCeiling = null;
  }
  const nextBody = applyBufferSyncToSessionBuffer(
    session.body,
    resolvedPayload,
    session.cacheLines,
  );
  const bodyChanged = !sessionBuffersEqual(session.body, nextBody);
  if (bodyChanged) {
    session.body = nextBody;
  }
  reconcileFrameRepair(session, nextBody);
  if (!bodyChanged) {
    return;
  }

  const snapshot = bufferToBodySnapshot(nextBody);
  options.onCommit?.({
    sessionId: session.sessionId,
    snapshot,
    metadata: {
      revision: nextBody.revision,
      cursorKeysApp: nextBody.cursorKeysApp,
      cursor: cloneCursor(nextBody.cursor),
      headCursor: cloneCursor(session.cursor),
    },
  });
  options.onVisibleDemandChange();
}

function normalizeVisibleDemand(
  demand: RendererVisibleRangeDemand,
): RendererVisibleRangeDemand {
  const endIndex = Math.max(0, Math.floor(demand.endIndex));
  return {
    startIndex: Math.max(0, Math.min(endIndex, Math.floor(demand.startIndex))),
    endIndex,
    visibleRows: Math.max(1, Math.floor(demand.visibleRows)),
    mode: demand.mode,
  };
}

function visibleDemandEqual(
  left: RendererVisibleRangeDemand | null,
  right: RendererVisibleRangeDemand,
) {
  return Boolean(
    left
    && left.startIndex === right.startIndex
    && left.endIndex === right.endIndex
    && left.visibleRows === right.visibleRows
    && left.mode === right.mode
  );
}

export interface MirrorConsumer {
  registerSession(
    sessionId: string,
    options?: {
      cacheLines?: number;
      cols?: number;
      rows?: number;
    },
  ): void;
  handleMessage(sessionId: string, message: BridgeServerMessage): void;
  setVisibleDemand(sessionId: string, demand: RendererVisibleRangeDemand): void;
  snapshot(sessionId: string): MirrorSessionSnapshot | null;
  close(sessionId: string): void;
  dispose(): void;
}

export function createMirrorConsumer(options: MirrorConsumerOptions): MirrorConsumer {
  const sessions = new Map<string, SessionRuntime>();
  const defaultCacheLines = toPositiveInteger(options.cacheLines, DEFAULT_CACHE_LINES);
  const defaultVisibleRows = toPositiveInteger(options.visibleRows, DEFAULT_VISIBLE_ROWS);
  const defaultVisibleCols = toPositiveInteger(options.visibleCols, DEFAULT_VISIBLE_COLS);
  const headRequestDebounceMs = toPositiveInteger(
    options.headRequestDebounceMs,
    HEAD_REQUEST_DEBOUNCE_MS,
  );
  const sendRequest = options.sendRequest;
  const onCommit = options.onCommit;
  const onMetadata = options.onMetadata;

  function scheduleExpiry(session: SessionRuntime) {
    const pending = session.frameAssembly.pending;
    if (!pending) {
      if (session.timer) {
        clearTimeout(session.timer);
        session.timer = null;
      }
      return;
    }
    if (session.timer) {
      return;
    }
    const dueAt = pending.firstReceivedAt + TERMINAL_BUFFER_SYNC_FRAME_MAX_AGE_MS + 1;
    session.timer = setTimeout(() => {
      session.timer = null;
      expirePendingFrames(session, {
        sendRequest,
        now: Date.now(),
      });
      scheduleExpiry(session);
    }, Math.max(0, dueAt - Date.now()));
  }

  function createSession(
    sessionId: string,
    sessionOptions: {
      cacheLines?: number;
      cols?: number;
      rows?: number;
    } = {},
  ): SessionRuntime {
    const cacheLines = toPositiveInteger(sessionOptions.cacheLines, defaultCacheLines);
    const cols = toPositiveInteger(sessionOptions.cols, defaultVisibleCols);
    const rows = toPositiveInteger(sessionOptions.rows, defaultVisibleRows);
    return {
      sessionId,
      epoch: 0,
      cacheLines,
      head: null,
      cursor: null,
      body: createEmptyBody({ cacheLines, cols, rows }),
      visibleDemand: null,
      frameAssembly: createFrameAssemblyResource(),
      rejectedEpochRevisionCeiling: null,
      epochResetPending: false,
      lastHeadRequestAt: 0,
      lastRequestAt: 0,
      lastRequest: null,
      timer: null,
    };
  }

  function requestVisibleForSession(session: SessionRuntime) {
    requestVisibleBuffer(session, {
      headRequestDebounceMs,
      sendRequest,
      now: Date.now(),
    });
  }

  return {
    registerSession(sessionId, sessionOptions = {}) {
      const existing = sessions.get(sessionId);
      if (existing) {
        existing.cacheLines = toPositiveInteger(sessionOptions.cacheLines, existing.cacheLines);
        return;
      }
      sessions.set(sessionId, createSession(sessionId, sessionOptions));
    },
    handleMessage(sessionId, message) {
      const session = sessions.get(sessionId);
      if (!session) {
        return;
      }
      const now = Date.now();
      if (message.type === 'buffer-head') {
        handleHead(session, message.payload, {
          headRequestDebounceMs,
          sendRequest,
          onMetadata,
          now,
        });
        scheduleExpiry(session);
        return;
      }
      if (message.type === 'buffer-sync') {
        handleBufferSync(session, message.payload, {
          sendRequest,
          onCommit,
          onVisibleDemandChange: () => requestVisibleForSession(session),
          now,
        });
        scheduleExpiry(session);
      }
    },
    setVisibleDemand(sessionId, demand) {
      const session = sessions.get(sessionId);
      if (!session) {
        return;
      }
      const nextDemand = normalizeVisibleDemand(demand);
      if (visibleDemandEqual(session.visibleDemand, nextDemand)) {
        return;
      }
      session.visibleDemand = nextDemand;
      requestVisibleForSession(session);
    },
    snapshot(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return null;
      }
      const pending = session.frameAssembly.pending;
      return {
        epoch: session.epoch,
        cacheLines: session.cacheLines,
        head: session.head ? { ...session.head } : null,
        cursor: cloneCursor(session.cursor),
        body: bufferToBodySnapshot(session.body),
        visibleDemand: session.visibleDemand ? { ...session.visibleDemand } : null,
        requestState: {
          lastRequestedAt: session.lastRequestAt,
          lastRequest: copyRequest(session.lastRequest),
        },
        frameAssembly: {
          pending: pending
            ? {
                revision: pending.revision,
                receivedChunkCount: pending.chunks.size,
                chunkCount: pending.frameChunkCount,
                frameKey: pending.frameKey,
              }
            : null,
          error: session.frameAssembly.error
            ? {
                error: session.frameAssembly.error.error,
                revision: session.frameAssembly.error.revision,
                repair: {
                  status: session.frameAssembly.error.repair.status,
                  range: copyRepairRange(session.frameAssembly.error.repair.range),
                },
              }
            : null,
          repairDispatchedRevisions: [...session.frameAssembly.repairDispatchedRevisions],
        },
      };
    },
    close(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return;
      }
      if (session.timer) {
        clearTimeout(session.timer);
      }
      sessions.delete(sessionId);
    },
    dispose() {
      for (const session of sessions.values()) {
        if (session.timer) {
          clearTimeout(session.timer);
        }
      }
      sessions.clear();
    },
  };
}
