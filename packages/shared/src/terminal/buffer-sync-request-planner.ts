/**
 * buffer-sync-request-planner.ts — Pure functions for computing buffer sync request windows.
 *
 * These functions resolve the request window (requestStartIndex, requestEndIndex)
 * for tail-refresh and reading-repair buffer sync payloads.
 * All inputs are plain numbers, booleans, and TerminalGapRange[].
 * No dependency on Android Session/SessionBufferState types.
 */

import type { TerminalGapRange } from '../connection/types';
import { collectIntersectingGapRanges } from './gap-utils';
import { resolveRequestedBufferWindow } from './gap-utils';

export interface ResolveTailRefreshWindowParams {
  /** Start index of the authoritative available range from daemon head. */
  authoritativeHeadStartIndex: number;
  /** Target end index (clamped by authoritative available end or tail target). */
  viewportEndIndex: number;
  /** Number of visible viewport rows. */
  viewportRows: number;
  /** Pre-computed cache lines = 3x viewportRows. */
  cacheLines: number;
  /** Whether the local buffer has any cached content. */
  localHasWindow: boolean;
  /** Distance from local end index to viewport end index. */
  distanceToHead: number;
  /** Whether local and remote share the same end index but remote revision is newer. */
  sameEndRevisionAdvanced: boolean;
  /** Whether same-end revision window has local gaps. */
  sameEndWindowHasLocalGaps: boolean;
  /** Whether the local window is considered invalid. */
  invalidLocalWindow: boolean;
  /** Whether caller explicitly requires a full same-end refresh after resume/re-entry. */
  forceSameEndRefresh?: boolean;
  /** Explicit same-end refresh scope override. */
  sameEndRefreshMode?: 'auto' | 'visible-window' | 'full-cache';
  /** Optional override for the request window range. */
  requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
}

export interface ResolvedWindow {
  requestStartIndex: number;
  requestEndIndex: number;
}

/**
 * Resolve the request window for a tail-refresh buffer sync.
 *
 * This is the 5-branch decision:
 * 1. requestWindowOverride → use it (clamped to authoritative head start)
 * 2. !localHasWindow || invalidLocalWindow || distanceToHead > cacheLines → full window
 * 3. localEndIndex < viewportEndIndex → incremental from local end
 * 4. sameEndRevisionAdvanced && sameEndWindowHasLocalGaps → visible window with gaps
 * 5. sameEndRevisionAdvanced → full window (revision changed, no gaps visible)
 * 6. (default) → incremental from local end
 */
export function resolveTailRefreshWindow(
  params: ResolveTailRefreshWindowParams,
): ResolvedWindow {
  const {
    authoritativeHeadStartIndex,
    viewportEndIndex,
    viewportRows,
    cacheLines,
    localHasWindow,
    distanceToHead,
    sameEndRevisionAdvanced,
    sameEndWindowHasLocalGaps,
    invalidLocalWindow,
    forceSameEndRefresh,
    sameEndRefreshMode,
    requestWindowOverride,
  } = params;

  // Branch 1: explicit override
  if (requestWindowOverride) {
    return {
      requestStartIndex: Math.max(
        authoritativeHeadStartIndex,
        Math.floor(requestWindowOverride.requestStartIndex || 0),
      ),
      requestEndIndex: Math.max(
        authoritativeHeadStartIndex,
        Math.floor(requestWindowOverride.requestEndIndex || 0),
      ),
    };
  }

  // Branch 2: no local window, invalid, or too far from head → full cache
  if (!localHasWindow || invalidLocalWindow || distanceToHead > cacheLines) {
    return resolveRequestedBufferWindow(
      viewportEndIndex,
      viewportRows,
      cacheLines,
      authoritativeHeadStartIndex,
    );
  }

  // Branch 3: behind head → incremental from local end
  if (distanceToHead > 0) {
    // Note: distanceToHead > 0 means localEndIndex < viewportEndIndex
    // (distanceToHead = max(0, viewportEndIndex - localEndIndex))
    return {
      requestStartIndex: Math.max(authoritativeHeadStartIndex, viewportEndIndex - distanceToHead),
      requestEndIndex: viewportEndIndex,
    };
  }

  // At this point: localHasWindow && !invalidLocalWindow && distanceToHead === 0
  const normalizedSameEndRefreshMode = sameEndRefreshMode || 'auto';

  // Branch 4: explicit same-end refresh request → full cache window
  if (
    sameEndRevisionAdvanced
    && (forceSameEndRefresh || normalizedSameEndRefreshMode === 'full-cache')
  ) {
    return resolveRequestedBufferWindow(
      viewportEndIndex,
      viewportRows,
      cacheLines,
      authoritativeHeadStartIndex,
    );
  }

  // Branch 4.5: explicit visible repaint request or same-end gaps in visible window
  if (sameEndRevisionAdvanced && normalizedSameEndRefreshMode === 'visible-window') {
    return {
      requestStartIndex: Math.max(
        authoritativeHeadStartIndex,
        viewportEndIndex - viewportRows,
      ),
      requestEndIndex: viewportEndIndex,
    };
  }

  if (sameEndRevisionAdvanced && sameEndWindowHasLocalGaps) {
    return {
      requestStartIndex: Math.max(
        authoritativeHeadStartIndex,
        viewportEndIndex - viewportRows,
      ),
      requestEndIndex: viewportEndIndex,
    };
  }

  // Branch 5: same end, revision advanced, no gaps → full window refresh
  if (sameEndRevisionAdvanced) {
    return resolveRequestedBufferWindow(
      viewportEndIndex,
      viewportRows,
      cacheLines,
      authoritativeHeadStartIndex,
    );
  }

  // Branch 6: default incremental
  return {
    requestStartIndex: Math.max(authoritativeHeadStartIndex, viewportEndIndex - cacheLines),
    requestEndIndex: viewportEndIndex,
  };
}

/**
 * Resolve the missing ranges for a reading-repair buffer sync request.
 *
 * Computes visibleStartIndex/endIndex from the viewport and local buffer,
 * then returns the gap ranges that need repair.
 */
export function resolveReadingRepairMissingRanges(params: {
  visibleStartIndex: number;
  visibleEndIndex: number;
  localStartIndex: number;
  localEndIndex: number;
  localGapRanges: TerminalGapRange[];
}): TerminalGapRange[] {
  const {
    visibleStartIndex,
    visibleEndIndex,
    localStartIndex,
    localEndIndex,
    localGapRanges,
  } = params;

  if (visibleEndIndex <= visibleStartIndex) {
    return [];
  }

  // Gap before local buffer
  const missingBefore = localStartIndex > visibleStartIndex
    ? [{ startIndex: visibleStartIndex, endIndex: Math.min(localStartIndex, visibleEndIndex) }]
    : [];

  // Gap after local buffer
  const missingAfter = localEndIndex < visibleEndIndex
    ? [{ startIndex: Math.max(localEndIndex, visibleStartIndex), endIndex: visibleEndIndex }]
    : [];

  // Gaps inside local buffer
  const innerGaps = collectIntersectingGapRanges(
    localGapRanges,
    visibleStartIndex,
    visibleEndIndex,
  );

  return [...missingBefore, ...innerGaps, ...missingAfter];
}
