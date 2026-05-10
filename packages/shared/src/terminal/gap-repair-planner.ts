/**
 * gap-repair-planner.ts – Pure functions for computing visible gap repair ranges.
 */

import type { TerminalGapRange } from '../connection/types';
import { mergeGapRanges, collectIntersectingGapRanges } from './gap-utils';

export interface ResolvedBufferWindow {
  requestStartIndex: number;
  requestEndIndex: number;
}

export interface VisibleRangeRepairParams {
  visibleStartIndex: number;
  visibleEndIndex: number;
  localStartIndex: number;
  localEndIndex: number;
  localGapRanges: TerminalGapRange[];
}

/**
 * Compute the missing gap ranges for a given visible window and buffer content.
 * Returns a merged list of ranges that are not yet present in the local buffer.
 */
export function computeVisibleRangeRepairRanges(
  params: VisibleRangeRepairParams,
): TerminalGapRange[] {
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

  const missingRanges: TerminalGapRange[] = [];

  // Gap at the beginning (visibleStart .. localStart)
  if (localStartIndex > visibleStartIndex) {
    missingRanges.push({
      startIndex: visibleStartIndex,
      endIndex: Math.min(localStartIndex, visibleEndIndex),
    });
  }

  // Gaps inside the visible window (existing gaps in local buffer)
  missingRanges.push(...collectIntersectingGapRanges(
    localGapRanges,
    visibleStartIndex,
    visibleEndIndex,
  ));

  // Gap at the end (localEnd .. visibleEnd)
  if (localEndIndex < visibleEndIndex) {
    missingRanges.push({
      startIndex: Math.max(localEndIndex, visibleStartIndex),
      endIndex: visibleEndIndex,
    });
  }

  return mergeGapRanges(missingRanges);
}
