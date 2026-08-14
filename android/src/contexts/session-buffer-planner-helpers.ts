import type {
  BufferSyncRequestPayload,
  SessionBufferState,
  TerminalGapRange,
} from '../lib/types';
import type { SessionPullPurpose } from '../lib/session-pull-state-helpers';
import { collectIntersectingGapRanges, resolveRequestedBufferWindow as sharedResolveRequestedBufferWindow } from '@zterm/shared/terminal/gap-utils';
import { resolveHeadAvailableBounds as sharedResolveHeadAvailableBounds, hasImpossibleLocalWindow as sharedHasImpossibleLocalWindow, resolveAuthoritativeAvailableEndIndex as sharedResolveAuthoritativeAvailableEndIndex, hasLocalWindow as sharedHasLocalWindow } from '@zterm/shared/terminal/buffer-head-state';
import { resolveTailTargetEndIndex as sharedResolveTailTargetEndIndex } from '@zterm/shared/terminal/visible-range';
import { shouldPullFollowBuffer as sharedShouldPullFollowBuffer, shouldCatchUpFollowTailAfterBufferApply as sharedShouldCatchUpFollowTailAfterBufferApply } from '@zterm/shared/terminal/buffer-sync-planner';
import { computeVisibleRangeRepairRanges as sharedComputeVisibleRangeRepairRanges } from '@zterm/shared/terminal/gap-repair-planner';
import {
  resolveVisibleRangeEndIndex,
  resolveVisibleRangeViewportRows,
  type SessionDaemonHeadView,
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
  buffer: SessionBufferState | null | undefined,
): boolean {
  if (!buffer) {
    return false;
  }
  return sharedHasLocalWindow(
    buffer.startIndex ?? 0,
    buffer.endIndex ?? 0,
    buffer.revision ?? 0,
  );
}

function buildBaseBufferSyncRequestPayload(
  head: SessionDaemonHeadView,
  buffer: SessionBufferState,
): Pick<BufferSyncRequestPayload, 'knownRevision' | 'localStartIndex' | 'localEndIndex' | 'targetHeadRevision'> {
  return {
    knownRevision: Math.max(0, Math.floor(buffer.revision || 0)),
    localStartIndex: Math.max(0, Math.floor(buffer.startIndex || 0)),
    localEndIndex: Math.max(0, Math.floor(buffer.endIndex || 0)),
    targetHeadRevision: Math.max(0, Math.floor(head.daemonHeadRevision || 0)),
  };
}

function resolveRequestedBufferWindow(
  endIndex: number,
  viewportRows: number,
  minStartIndex = 0,
) {
  const safeViewportRows = Math.max(1, Math.floor(viewportRows || 1));
  return sharedResolveRequestedBufferWindow(endIndex, safeViewportRows, safeViewportRows, minStartIndex);
}

function resolveAuthoritativeAvailableEndIndex(
  head: SessionDaemonHeadView,
  liveHead: SessionBufferHeadState | null | undefined,
  buffer: SessionBufferState,
): number | null {
  return sharedResolveAuthoritativeAvailableEndIndex(
    liveHead?.availableEndIndex,
    liveHead?.latestEndIndex ?? 0,
    Math.max(0, Math.floor(head.daemonHeadRevision || 0)),
    Math.max(0, Math.floor(head.daemonHeadEndIndex || 0)),
    Math.max(0, Math.floor(buffer.bufferTailEndIndex || 0)),
    Math.max(0, Math.floor(buffer.endIndex || 0)),
  );
}

function resolveTailTargetEndIndex(
  head: SessionDaemonHeadView,
  visibleRange: SessionVisibleRangeState | undefined,
  buffer: SessionBufferState,
): number {
  const fallbackEndIndex = resolveVisibleRangeEndIndex(head, visibleRange, buffer);
  return sharedResolveTailTargetEndIndex(head.daemonHeadEndIndex, fallbackEndIndex);
}



function collectVisibleRangeRepairRanges(
  head: SessionDaemonHeadView,
  visibleRange: SessionVisibleRangeState | undefined,
  liveHead: SessionBufferHeadState | null | undefined,
  buffer: SessionBufferState,
): TerminalGapRange[] {
  if (!visibleRange) {
    return [] as TerminalGapRange[];
  }
  const viewportRows = resolveVisibleRangeViewportRows(visibleRange, buffer);
  const viewportEndIndex = resolveVisibleRangeEndIndex(head, visibleRange, buffer);
  const { availableStartIndex } = resolveHeadAvailableBounds(liveHead, buffer);
  const authoritativeAvailableEndIndex = resolveAuthoritativeAvailableEndIndex(head, liveHead, buffer);
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
  head: SessionDaemonHeadView,
  buffer: SessionBufferState,
  visibleRange?: SessionVisibleRangeState,
  options?: {
    liveHead?: SessionBufferHeadState | null;
    forceSameEndRefresh?: boolean;
    sameEndRefreshMode?: 'auto' | 'visible-window' | 'full-cache';
    invalidLocalWindow?: boolean;
    requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
  },
): BufferSyncRequestPayload {
  const viewportRows = resolveVisibleRangeViewportRows(visibleRange, buffer);
  const authoritativeAvailableEndIndex = resolveAuthoritativeAvailableEndIndex(
    head,
    options?.liveHead,
    buffer,
  );
  const viewportEndIndex = (
    authoritativeAvailableEndIndex === null
      ? resolveTailTargetEndIndex(head, visibleRange, buffer)
      : Math.min(
          resolveTailTargetEndIndex(head, visibleRange, buffer),
          authoritativeAvailableEndIndex,
        )
  );
  const cacheLines = viewportRows;
  const { availableStartIndex } = resolveHeadAvailableBounds(options?.liveHead, buffer);
  const authoritativeHeadStartIndex = availableStartIndex;
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  const daemonRevision = Math.max(0, Math.floor(head.daemonHeadRevision || 0));
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
    ...buildBaseBufferSyncRequestPayload(head, buffer),
    requestStartIndex: window.requestStartIndex,
    requestEndIndex: window.requestEndIndex,
  };
}

function buildReadingBufferSyncRequestPayload(
  head: SessionDaemonHeadView,
  buffer: SessionBufferState,
  visibleRange?: SessionVisibleRangeState,
  options?: {
    liveHead?: SessionBufferHeadState | null;
    missingRangesOverride?: TerminalGapRange[] | null;
    requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
  },
): BufferSyncRequestPayload {
  const viewportRows = resolveVisibleRangeViewportRows(visibleRange, buffer);
  const viewportEndIndex = resolveVisibleRangeEndIndex(head, visibleRange, buffer);
  const { availableStartIndex } = resolveHeadAvailableBounds(options?.liveHead, buffer);
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
    ...buildBaseBufferSyncRequestPayload(head, buffer),
    requestStartIndex: window.requestStartIndex,
    requestEndIndex: window.requestEndIndex,
    missingRanges: options?.missingRangesOverride
      ? options.missingRangesOverride.map((range) => ({ ...range }))
      : collectVisibleRangeRepairRanges(head, visibleRange, options?.liveHead, buffer),
  };
}

export function buildSessionBufferSyncRequestPayload(
  head: SessionDaemonHeadView,
  buffer: SessionBufferState,
  visibleRange?: SessionVisibleRangeState,
  options?: {
    purpose?: SessionPullPurpose;
    forceSameEndRefresh?: boolean;
    sameEndRefreshMode?: 'auto' | 'visible-window' | 'full-cache';
    liveHead?: SessionBufferHeadState | null;
    invalidLocalWindow?: boolean;
    requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
    requestMissingRangesOverride?: TerminalGapRange[] | null;
  },
): BufferSyncRequestPayload {
  const purpose = options?.purpose || 'tail-refresh';
  return purpose === 'reading-repair'
    ? buildReadingBufferSyncRequestPayload(
        head,
        buffer,
        visibleRange,
        {
          liveHead: options?.liveHead,
          missingRangesOverride: options?.requestMissingRangesOverride ?? null,
          requestWindowOverride: options?.requestWindowOverride ?? null,
        },
      )
    : buildTailRefreshBufferSyncRequestPayload(head, buffer, visibleRange, options);
}

export function shouldPullFollowBuffer(
  head: SessionDaemonHeadView,
  visibleRange: SessionVisibleRangeState | undefined,
  buffer: SessionBufferState,
) {
  const viewportRows = resolveVisibleRangeViewportRows(visibleRange, buffer);
  const desiredEndIndex = resolveTailTargetEndIndex(head, visibleRange, buffer);
  const daemonRevision = Math.max(0, Math.floor(head.daemonHeadRevision || 0));
  const localRevision = Math.max(0, Math.floor(buffer.revision || 0));
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  const localHasWindow = localEndIndex > localStartIndex;
  const cacheLines = viewportRows;
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
  head: SessionDaemonHeadView,
  buffer: SessionBufferState,
  visibleRange?: SessionVisibleRangeState,
  options?: {
    forceSameEndRefresh?: boolean;
  },
) {
  const viewportRows = resolveVisibleRangeViewportRows(visibleRange, buffer);
  const desiredEndIndex = resolveTailTargetEndIndex(head, visibleRange, buffer);
  const daemonRevision = Math.max(0, Math.floor(head.daemonHeadRevision || 0));
  const localRevision = Math.max(0, Math.floor(buffer.revision || 0));
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  const localHasWindow = localEndIndex > localStartIndex;
  const cacheLines = viewportRows;
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
  head: SessionDaemonHeadView,
  visibleRange: SessionVisibleRangeState | undefined,
  liveHead: SessionBufferHeadState | null | undefined,
  buffer: SessionBufferState,
) {
  return collectVisibleRangeRepairRanges(head, visibleRange, liveHead, buffer).length > 0;
}

export function resolveHeadAvailableBounds(
  liveHead: SessionBufferHeadState | null | undefined,
  buffer: SessionBufferState,
): { availableStartIndex: number; availableEndIndex: number } {
  const result = sharedResolveHeadAvailableBounds(liveHead, buffer);
  return {
    availableStartIndex: result.availableStartIndex ?? 0,
    availableEndIndex: result.availableEndIndex ?? 0,
  };
}

export function hasImpossibleLocalWindow(
  liveHead: SessionBufferHeadState | null | undefined,
  buffer: SessionBufferState,
): boolean {
  return sharedHasImpossibleLocalWindow(liveHead, buffer);
}
