/**
 * gap-utils.ts — Pure utility functions for terminal buffer gap management.
 *
 * These functions operate solely on TerminalGapRange and numbers.
 * No dependency on Android Session/SessionBufferState types.
 * Safe to use in any platform context.
 */

import type { TerminalGapRange } from '../connection/types';

/**
 * Merge overlapping or adjacent gap ranges into minimal disjoint intervals.
 */
export function mergeGapRanges(ranges: TerminalGapRange[]): TerminalGapRange[] {
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

/**
 * Extract the portions of gapRanges that intersect with [startIndex, endIndex).
 */
export function collectIntersectingGapRanges(
  gapRanges: TerminalGapRange[],
  startIndex: number,
  endIndex: number,
): TerminalGapRange[] {
  if (endIndex <= startIndex) {
    return [];
  }

  return gapRanges
    .map((range) => ({
      startIndex: Math.max(startIndex, range.startIndex),
      endIndex: Math.min(endIndex, range.endIndex),
    }))
    .filter((range) => range.endIndex > range.startIndex);
}

/**
 * Compute the request window for a buffer sync given the desired end position
 * and viewport size, clamping to minStartIndex.
 */
export function resolveRequestedBufferWindow(
  endIndex: number,
  viewportRows: number,
  cacheLines: number,
  minStartIndex = 0,
): { requestStartIndex: number; requestEndIndex: number } {
  const safeViewportRows = Math.max(1, Math.floor(viewportRows || 1));
  const safeEndIndex = Math.max(0, Math.floor(endIndex || 0));
  const safeMinStartIndex = Math.max(0, Math.floor(minStartIndex || 0));
  const safeCacheLines = Math.max(safeViewportRows, Math.floor(cacheLines || safeViewportRows));
  const requestEndIndex = Math.max(safeMinStartIndex, safeEndIndex);
  const requestStartIndex = Math.max(safeMinStartIndex, requestEndIndex - safeCacheLines);
  return { requestStartIndex, requestEndIndex };
}
