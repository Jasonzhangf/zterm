import type {
  BufferSyncRequestPayload,
  Session,
  SessionBufferState,
  TerminalGapRange,
} from '../lib/types';
import { resolveTerminalRequestWindowLines } from '../lib/mobile-config';
import type { SessionPullPurpose } from './session-pull-state-helpers';
import { collectIntersectingGapRanges, resolveRequestedBufferWindow as sharedResolveRequestedBufferWindow } from '@zterm/shared/terminal/gap-utils';
import { resolveHeadAvailableBounds as sharedResolveHeadAvailableBounds, hasImpossibleLocalWindow as sharedHasImpossibleLocalWindow, resolveAuthoritativeAvailableEndIndex as sharedResolveAuthoritativeAvailableEndIndex, hasLocalWindow as sharedHasLocalWindow } from '@zterm/shared/terminal/buffer-head-state';
import { resolveTailTargetEndIndex as sharedResolveTailTargetEndIndex } from '@zterm/shared/terminal/visible-range';
import { shouldPullFollowBuffer as sharedShouldPullFollowBuffer, shouldCatchUpFollowTailAfterBufferApply as sharedShouldCatchUpFollowTailAfterBufferApply } from '@zterm/shared/terminal/buffer-sync-planner';
import { computeVisibleRangeRepairRanges as sharedComputeVisibleRangeRepairRanges } from '@zterm/shared/terminal/gap-repair-planner';
import {
  resolveSessionBufferView,
  resolveVisibleRangeEndIndex,
  resolveVisibleRangeViewportRows,
  type SessionVisibleRangeState,
} from './session-visible-range-helpers';
import { resolveTailRefreshWindow as sharedResolveTailRefreshWindow } from '@zterm/shared/terminal/buffer-sync-request-planner';

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
): boolean {
  if (!session) {
    return false;
  }
  const buffer = resolveSessionBufferView(session, bufferOverride);
  return sharedHasLocalWindow(
    buffer.startIndex ?? 0,
    buffer.endIndex ?? 0,
    buffer.revision ?? 0,
  );
}

function buildBaseBufferSyncRequestPayload(
  session: Session,
  bufferOverride?: SessionBufferState | null,
): Pick<BufferSyncRequestPayload, 'knownRevision' | 'localStartIndex' | 'localEndIndex' | 'targetHeadRevision'> {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  return {
    knownRevision: Math.max(0, Math.floor(buffer.revision || 0)),
    localStartIndex: Math.max(0, Math.floor(buffer.startIndex || 0)),
    localEndIndex: Math.max(0, Math.floor(buffer.endIndex || 0)),
    targetHeadRevision: Math.max(0, Math.floor(session.daemonHeadRevision || 0)),
  };
}

function resolveRequestedBufferWindow(
  endIndex: number,
  viewportRows: number,
  minStartIndex = 0,
) {
  const safeViewportRows = Math.max(1, Math.floor(viewportRows || 1));
  const cacheLines = resolveTerminalRequestWindowLines(safeViewportRows);
  return sharedResolveRequestedBufferWindow(endIndex, viewportRows, cacheLines, minStartIndex);
}

function resolveAuthoritativeAvailableEndIndex(
  session: Session,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
): number | null {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  return sharedResolveAuthoritativeAvailableEndIndex(
    liveHead?.availableEndIndex,
    liveHead?.latestEndIndex ?? 0,
    Math.max(0, Math.floor(session.daemonHeadRevision || 0)),
    Math.max(0, Math.floor(session.daemonHeadEndIndex || 0)),
    Math.max(0, Math.floor(buffer.bufferTailEndIndex || 0)),
    Math.max(0, Math.floor(buffer.endIndex || 0)),
  );
}

function resolveTailTargetEndIndex(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  bufferOverride?: SessionBufferState | null,
): number {
  const fallbackEndIndex = resolveVisibleRangeEndIndex(session, visibleRange, bufferOverride);
  return sharedResolveTailTargetEndIndex(session.daemonHeadEndIndex, fallbackEndIndex);
}



function collectVisibleRangeRepairRanges(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
): TerminalGapRange[] {
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
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  return sharedComputeVisibleRangeRepairRanges({
    visibleStartIndex,
    visibleEndIndex,
    localStartIndex,
    localEndIndex,
    localGapRanges: buffer.gapRanges,
  });
}

function buildTailRefreshBufferSyncRequestPayload(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  options?: {
    liveHead?: SessionBufferHeadState | null;
    forceSameEndRefresh?: boolean;
    sameEndRefreshMode?: 'auto' | 'visible-window' | 'full-cache';
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
  const window = sharedResolveTailRefreshWindow({
    authoritativeHeadStartIndex,
    viewportEndIndex,
    viewportRows,
    cacheLines,
    localHasWindow,
    distanceToHead,
    sameEndRevisionAdvanced,
    sameEndWindowHasLocalGaps,
    invalidLocalWindow,
    forceSameEndRefresh: Boolean(options?.forceSameEndRefresh),
    sameEndRefreshMode: options?.sameEndRefreshMode || 'auto',
    requestWindowOverride: options?.requestWindowOverride ?? null,
  });
  return {
    ...buildBaseBufferSyncRequestPayload(session, buffer),
    requestStartIndex: window.requestStartIndex,
    requestEndIndex: window.requestEndIndex,
  };
}

function buildReadingBufferSyncRequestPayload(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  options?: {
    liveHead?: SessionBufferHeadState | null;
    missingRangesOverride?: TerminalGapRange[] | null;
    requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
    bufferOverride?: SessionBufferState | null;
  },
): BufferSyncRequestPayload {
  const buffer = resolveSessionBufferView(session, options?.bufferOverride);
  const viewportRows = resolveVisibleRangeViewportRows(session, visibleRange, buffer);
  const viewportEndIndex = resolveVisibleRangeEndIndex(session, visibleRange, buffer);
  const { availableStartIndex } = resolveHeadAvailableBounds(session, options?.liveHead, buffer);
  const window = options?.requestWindowOverride
    ? {
        requestStartIndex: Math.max(
          availableStartIndex,
          Math.floor(options.requestWindowOverride.requestStartIndex || 0),
        ),
        requestEndIndex: Math.max(
          availableStartIndex,
          Math.floor(options.requestWindowOverride.requestEndIndex || 0),
        ),
      }
    : resolveRequestedBufferWindow(
        viewportEndIndex,
        viewportRows,
        availableStartIndex,
      );
  return {
    ...buildBaseBufferSyncRequestPayload(session, buffer),
    requestStartIndex: window.requestStartIndex,
    requestEndIndex: window.requestEndIndex,
    missingRanges: options?.missingRangesOverride
      ? options.missingRangesOverride.map((range) => ({ ...range }))
      : collectVisibleRangeRepairRanges(session, visibleRange, options?.liveHead, buffer),
  };
}

export function buildSessionBufferSyncRequestPayload(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  options?: {
    purpose?: SessionPullPurpose;
    forceSameEndRefresh?: boolean;
    sameEndRefreshMode?: 'auto' | 'visible-window' | 'full-cache';
    liveHead?: SessionBufferHeadState | null;
    invalidLocalWindow?: boolean;
    requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
    requestMissingRangesOverride?: TerminalGapRange[] | null;
    bufferOverride?: SessionBufferState | null;
  },
): BufferSyncRequestPayload {
  const purpose = options?.purpose || 'tail-refresh';
  return purpose === 'reading-repair'
    ? buildReadingBufferSyncRequestPayload(
        session,
        visibleRange,
        {
          liveHead: options?.liveHead,
          missingRangesOverride: options?.requestMissingRangesOverride ?? null,
          requestWindowOverride: options?.requestWindowOverride ?? null,
          bufferOverride: options?.bufferOverride,
        },
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
  return sharedShouldPullFollowBuffer({
    localHasWindow,
    distanceToHead,
    cacheLines,
    localEndIndex,
    desiredEndIndex,
    daemonRevision,
    localRevision,
  });
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
  return sharedShouldCatchUpFollowTailAfterBufferApply({
    localHasWindow,
    distanceToHead,
    cacheLines,
    localEndIndex,
    desiredEndIndex,
    daemonRevision,
    localRevision,
    forceSameEndRefresh: Boolean(options?.forceSameEndRefresh),
  });
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
): { availableStartIndex: number; availableEndIndex: number } {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  const result = sharedResolveHeadAvailableBounds(liveHead, buffer);
  return {
    availableStartIndex: result.availableStartIndex ?? 0,
    availableEndIndex: result.availableEndIndex ?? 0,
  };
}

export function hasImpossibleLocalWindow(
  session: Session,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
): boolean {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  return sharedHasImpossibleLocalWindow(liveHead, buffer);
}
