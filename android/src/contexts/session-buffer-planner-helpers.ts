import type {
  BufferSyncRequestPayload,
  Session,
  SessionBufferState,
  TerminalGapRange,
} from '../lib/types';
import { resolveTerminalRequestWindowLines } from '../lib/mobile-config';
import type { SessionPullPurpose } from './session-pull-state-helpers';
import {
  resolveSessionBufferView,
  resolveVisibleRangeEndIndex,
  resolveVisibleRangeViewportRows,
  type SessionVisibleRangeState,
} from './session-visible-range-helpers';

export interface SessionBufferHeadState {
  revision: number;
  latestEndIndex: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  seenAt: number;
}

export function hasSessionLocalWindow(
  session: Session | null | undefined,
  bufferOverride?: SessionBufferState | null,
) {
  if (!session) {
    return false;
  }
  const buffer = resolveSessionBufferView(session, bufferOverride);
  return (
    Math.max(0, Math.floor(buffer.endIndex || 0))
      > Math.max(0, Math.floor(buffer.startIndex || 0))
    && Math.max(0, Math.floor(buffer.revision || 0)) > 0
  );
}

function buildBaseBufferSyncRequestPayload(
  session: Session,
  bufferOverride?: SessionBufferState | null,
): Pick<BufferSyncRequestPayload, 'knownRevision' | 'localStartIndex' | 'localEndIndex'> {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  return {
    knownRevision: Math.max(0, Math.floor(buffer.revision || 0)),
    localStartIndex: Math.max(0, Math.floor(buffer.startIndex || 0)),
    localEndIndex: Math.max(0, Math.floor(buffer.endIndex || 0)),
  };
}

function resolveRequestedBufferWindow(
  endIndex: number,
  viewportRows: number,
  minStartIndex = 0,
) {
  const safeViewportRows = Math.max(1, Math.floor(viewportRows || 1));
  const safeEndIndex = Math.max(0, Math.floor(endIndex || 0));
  const safeMinStartIndex = Math.max(0, Math.floor(minStartIndex || 0));
  const cacheLines = resolveTerminalRequestWindowLines(safeViewportRows);
  const requestEndIndex = Math.max(safeMinStartIndex, safeEndIndex);
  const requestStartIndex = Math.max(safeMinStartIndex, requestEndIndex - cacheLines);
  return {
    requestStartIndex,
    requestEndIndex,
  };
}

function resolveAuthoritativeAvailableEndIndex(
  session: Session,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
) {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  if (
    typeof liveHead?.availableEndIndex === 'number'
    && Number.isFinite(liveHead.availableEndIndex)
  ) {
    return Math.max(0, Math.floor(liveHead.availableEndIndex));
  }
  if (typeof liveHead?.latestEndIndex === 'number' && Number.isFinite(liveHead.latestEndIndex)) {
    return Math.max(0, Math.floor(liveHead.latestEndIndex));
  }
  if (
    Math.max(0, Math.floor(session.daemonHeadRevision || 0)) > 0
    || Math.max(0, Math.floor(session.daemonHeadEndIndex || 0)) > 0
  ) {
    return Math.max(0, Math.floor(session.daemonHeadEndIndex || 0));
  }
  if (Math.max(0, Math.floor(buffer.bufferTailEndIndex || 0)) > 0) {
    return Math.max(0, Math.floor(buffer.bufferTailEndIndex || 0));
  }
  if (Math.max(0, Math.floor(buffer.endIndex || 0)) > 0) {
    return Math.max(0, Math.floor(buffer.endIndex || 0));
  }
  return null;
}

function resolveTailTargetEndIndex(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  bufferOverride?: SessionBufferState | null,
) {
  if (
    typeof session.daemonHeadEndIndex === 'number'
    && Number.isFinite(session.daemonHeadEndIndex)
  ) {
    return Math.max(0, Math.floor(session.daemonHeadEndIndex));
  }
  return resolveVisibleRangeEndIndex(session, visibleRange, bufferOverride);
}

function mergeGapRanges(ranges: TerminalGapRange[]) {
  if (ranges.length <= 1) {
    return ranges;
  }
  const sorted = [...ranges]
    .map((range) => ({
      startIndex: Math.max(0, Math.floor(range.startIndex || 0)),
      endIndex: Math.max(0, Math.floor(range.endIndex || 0)),
    }))
    .filter((range) => range.endIndex > range.startIndex)
    .sort((left, right) => left.startIndex - right.startIndex);
  const merged: TerminalGapRange[] = [];
  for (const range of sorted) {
    const current = merged[merged.length - 1];
    if (!current || range.startIndex > current.endIndex) {
      merged.push({ ...range });
      continue;
    }
    current.endIndex = Math.max(current.endIndex, range.endIndex);
  }
  return merged;
}

function collectIntersectingGapRanges(
  gapRanges: TerminalGapRange[],
  startIndex: number,
  endIndex: number,
) {
  if (endIndex <= startIndex) {
    return [] as TerminalGapRange[];
  }
  return gapRanges
    .map((range) => ({
      startIndex: Math.max(startIndex, range.startIndex),
      endIndex: Math.min(endIndex, range.endIndex),
    }))
    .filter((range) => range.endIndex > range.startIndex);
}

function collectVisibleRangeRepairRanges(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
) {
  if (!visibleRange) {
    return [] as TerminalGapRange[];
  }
  const buffer = resolveSessionBufferView(session, bufferOverride);
  const viewportRows = resolveVisibleRangeViewportRows(session, visibleRange, buffer);
  const viewportEndIndex = resolveVisibleRangeEndIndex(session, visibleRange, buffer);
  const { availableStartIndex } = resolveHeadAvailableBounds(session, liveHead, buffer);
  const authoritativeAvailableEndIndex = resolveAuthoritativeAvailableEndIndex(session, liveHead, buffer);
  const requestWindow = resolveRequestedBufferWindow(
    viewportEndIndex,
    viewportRows,
    availableStartIndex,
  );
  const visibleStartIndex = requestWindow.requestStartIndex;
  const visibleEndIndex = Math.max(
    visibleStartIndex,
    authoritativeAvailableEndIndex === null
      ? requestWindow.requestEndIndex
      : Math.min(authoritativeAvailableEndIndex, requestWindow.requestEndIndex),
  );
  if (visibleEndIndex <= visibleStartIndex) {
    return [] as TerminalGapRange[];
  }
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  const missingRanges: TerminalGapRange[] = [];

  if (localStartIndex > visibleStartIndex) {
    missingRanges.push({
      startIndex: visibleStartIndex,
      endIndex: Math.min(localStartIndex, visibleEndIndex),
    });
  }

  missingRanges.push(...collectIntersectingGapRanges(
    buffer.gapRanges,
    visibleStartIndex,
    visibleEndIndex,
  ));

  if (localEndIndex < visibleEndIndex) {
    missingRanges.push({
      startIndex: Math.max(localEndIndex, visibleStartIndex),
      endIndex: visibleEndIndex,
    });
  }

  return mergeGapRanges(missingRanges);
}

function buildTailRefreshBufferSyncRequestPayload(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  options?: {
    liveHead?: SessionBufferHeadState | null;
    forceSameEndRefresh?: boolean;
    invalidLocalWindow?: boolean;
    requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
    bufferOverride?: SessionBufferState | null;
  },
): BufferSyncRequestPayload {
  const buffer = resolveSessionBufferView(session, options?.bufferOverride);
  const viewportRows = resolveVisibleRangeViewportRows(session, visibleRange, buffer);
  const authoritativeAvailableEndIndex = resolveAuthoritativeAvailableEndIndex(
    session,
    options?.liveHead,
    buffer,
  );
  const viewportEndIndex = (
    authoritativeAvailableEndIndex === null
      ? resolveTailTargetEndIndex(session, visibleRange, buffer)
      : Math.min(
          resolveTailTargetEndIndex(session, visibleRange, buffer),
          authoritativeAvailableEndIndex,
        )
  );
  const cacheLines = resolveTerminalRequestWindowLines(viewportRows);
  const { availableStartIndex } = resolveHeadAvailableBounds(session, options?.liveHead, buffer);
  const authoritativeHeadStartIndex = availableStartIndex;
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  const daemonRevision = Math.max(0, Math.floor(session.daemonHeadRevision || 0));
  const localRevision = Math.max(0, Math.floor(buffer.revision || 0));
  const localHasWindow = localEndIndex > localStartIndex;
  const distanceToHead = Math.max(0, viewportEndIndex - localEndIndex);
  const invalidLocalWindow = Boolean(options?.invalidLocalWindow);
  const sameEndRevisionAdvanced = (
    localHasWindow
    && distanceToHead === 0
    && daemonRevision > localRevision
  );
  const sameEndWindowHasLocalGaps = (
    sameEndRevisionAdvanced
    && collectIntersectingGapRanges(
      buffer.gapRanges,
      Math.max(authoritativeHeadStartIndex, viewportEndIndex - viewportRows),
      viewportEndIndex,
    ).length > 0
  );
  let window: { requestStartIndex: number; requestEndIndex: number };

  if (options?.requestWindowOverride) {
    window = {
      requestStartIndex: Math.max(
        authoritativeHeadStartIndex,
        Math.floor(options.requestWindowOverride.requestStartIndex || 0),
      ),
      requestEndIndex: Math.max(
        authoritativeHeadStartIndex,
        Math.floor(options.requestWindowOverride.requestEndIndex || 0),
      ),
    };
  } else if (!localHasWindow || invalidLocalWindow || distanceToHead > cacheLines) {
    window = resolveRequestedBufferWindow(
      viewportEndIndex,
      viewportRows,
      authoritativeHeadStartIndex,
    );
  } else if (localEndIndex < viewportEndIndex) {
    window = {
      requestStartIndex: Math.max(authoritativeHeadStartIndex, localEndIndex),
      requestEndIndex: viewportEndIndex,
    };
  } else if (sameEndRevisionAdvanced && sameEndWindowHasLocalGaps) {
    window = {
      requestStartIndex: Math.max(authoritativeHeadStartIndex, viewportEndIndex - viewportRows),
      requestEndIndex: viewportEndIndex,
    };
  } else if (sameEndRevisionAdvanced) {
    window = resolveRequestedBufferWindow(
      viewportEndIndex,
      viewportRows,
      authoritativeHeadStartIndex,
    );
  } else {
    window = {
      requestStartIndex: Math.max(authoritativeHeadStartIndex, localEndIndex),
      requestEndIndex: viewportEndIndex,
    };
  }
  return {
    ...buildBaseBufferSyncRequestPayload(session, buffer),
    requestStartIndex: window.requestStartIndex,
    requestEndIndex: window.requestEndIndex,
  };
}

function buildReadingBufferSyncRequestPayload(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
): BufferSyncRequestPayload {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  const viewportRows = resolveVisibleRangeViewportRows(session, visibleRange, buffer);
  const viewportEndIndex = resolveVisibleRangeEndIndex(session, visibleRange, buffer);
  const { availableStartIndex } = resolveHeadAvailableBounds(session, liveHead, buffer);
  const window = resolveRequestedBufferWindow(
    viewportEndIndex,
    viewportRows,
    availableStartIndex,
  );
  return {
    ...buildBaseBufferSyncRequestPayload(session, buffer),
    requestStartIndex: window.requestStartIndex,
    requestEndIndex: window.requestEndIndex,
    missingRanges: collectVisibleRangeRepairRanges(session, visibleRange, liveHead, buffer),
  };
}

export function buildSessionBufferSyncRequestPayload(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  options?: {
    purpose?: SessionPullPurpose;
    forceSameEndRefresh?: boolean;
    liveHead?: SessionBufferHeadState | null;
    invalidLocalWindow?: boolean;
    requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
    bufferOverride?: SessionBufferState | null;
  },
): BufferSyncRequestPayload {
  const purpose = options?.purpose || 'tail-refresh';
  return purpose === 'reading-repair'
    ? buildReadingBufferSyncRequestPayload(
        session,
        visibleRange,
        options?.liveHead,
        options?.bufferOverride,
      )
    : buildTailRefreshBufferSyncRequestPayload(session, visibleRange, options);
}

export function shouldPullFollowBuffer(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  bufferOverride?: SessionBufferState | null,
) {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  const viewportRows = resolveVisibleRangeViewportRows(session, visibleRange, buffer);
  const desiredEndIndex = resolveTailTargetEndIndex(session, visibleRange, buffer);
  const daemonRevision = Math.max(0, Math.floor(session.daemonHeadRevision || 0));
  const localRevision = Math.max(0, Math.floor(buffer.revision || 0));
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  const localHasWindow = localEndIndex > localStartIndex;
  const cacheLines = resolveTerminalRequestWindowLines(viewportRows);
  const distanceToHead = Math.max(0, desiredEndIndex - localEndIndex);
  const sameEndRevisionAdvanced = (
    localHasWindow
    && distanceToHead === 0
    && daemonRevision > localRevision
  );

  if (!localHasWindow || distanceToHead > cacheLines || localEndIndex < desiredEndIndex) {
    return true;
  }
  return sameEndRevisionAdvanced;
}

export function shouldCatchUpFollowTailAfterBufferApply(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  options?: {
    forceSameEndRefresh?: boolean;
    bufferOverride?: SessionBufferState | null;
  },
) {
  const buffer = resolveSessionBufferView(session, options?.bufferOverride);
  const viewportRows = resolveVisibleRangeViewportRows(session, visibleRange, buffer);
  const desiredEndIndex = resolveTailTargetEndIndex(session, visibleRange, buffer);
  const daemonRevision = Math.max(0, Math.floor(session.daemonHeadRevision || 0));
  const localRevision = Math.max(0, Math.floor(buffer.revision || 0));
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  const localHasWindow = localEndIndex > localStartIndex;
  const cacheLines = resolveTerminalRequestWindowLines(viewportRows);
  const distanceToHead = Math.max(0, desiredEndIndex - localEndIndex);
  const sameEndRevisionAdvanced = (
    localHasWindow
    && distanceToHead === 0
    && daemonRevision > localRevision
  );

  return (
    !localHasWindow
    || distanceToHead > cacheLines
    || localEndIndex < desiredEndIndex
    || sameEndRevisionAdvanced
    || (Boolean(options?.forceSameEndRefresh) && daemonRevision > localRevision)
  );
}

export function shouldPullVisibleRangeBuffer(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
) {
  return collectVisibleRangeRepairRanges(session, visibleRange, liveHead, bufferOverride).length > 0;
}

export function resolveHeadAvailableBounds(
  session: Session,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
) {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  const availableEndIndex = Math.max(0, Math.floor(
    resolveAuthoritativeAvailableEndIndex(session, liveHead, buffer)
    ?? 0,
  ));
  const authoritativeAvailableStartIndex = (
    typeof liveHead?.availableStartIndex === 'number' && Number.isFinite(liveHead.availableStartIndex)
      ? Math.floor(liveHead.availableStartIndex)
      : 0
  );
  const availableStartIndex = Math.max(0, Math.min(
    availableEndIndex,
    authoritativeAvailableStartIndex,
  ));
  return {
    availableStartIndex,
    availableEndIndex,
  };
}

export function hasImpossibleLocalWindow(
  session: Session,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
) {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  const { availableEndIndex } = resolveHeadAvailableBounds(session, liveHead, buffer);
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(0, Math.floor(buffer.endIndex || 0));
  const localHeadStartIndex = Math.max(0, Math.floor(buffer.bufferHeadStartIndex || 0));
  const localTailEndIndex = Math.max(0, Math.floor(buffer.bufferTailEndIndex || 0));

  return (
    localStartIndex > availableEndIndex
    || localEndIndex > availableEndIndex
    || localHeadStartIndex > availableEndIndex
    || localTailEndIndex > availableEndIndex
  );
}
