/**
 * buffer-head-state.ts — Pure functions for managing session buffer head state.
 *
 * SessionBufferHeadState captures the most recent head information from the server.
 * These functions operate on the head state and buffer state to answer common queries.
 */

import type { SessionBufferState } from '../connection/types';

export interface SessionBufferHeadState {
  revision: number;
  latestEndIndex: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  seenAt: number;
}

/**
 * Resolve the available bounds from the head state, falling back to the buffer's known bounds.
 * Returns { availableStartIndex, availableEndIndex } where each may be null.
 */
export function resolveHeadAvailableBounds(
  head: SessionBufferHeadState | null | undefined,
  buffer: SessionBufferState,
): { availableStartIndex: number | null; availableEndIndex: number | null } {
  let availableStartIndex: number | null = null;
  let availableEndIndex: number | null = null;

  if (head?.availableStartIndex !== undefined && Number.isFinite(head.availableStartIndex)) {
    availableStartIndex = Math.max(0, Math.floor(head.availableStartIndex));
  } else if (buffer.startIndex !== undefined && Number.isFinite(buffer.startIndex)) {
    availableStartIndex = Math.max(0, Math.floor(buffer.startIndex));
  }

  if (head?.availableEndIndex !== undefined && Number.isFinite(head.availableEndIndex)) {
    availableEndIndex = Math.max(0, Math.floor(head.availableEndIndex));
  } else if (head?.latestEndIndex !== undefined && Number.isFinite(head.latestEndIndex)) {
    availableEndIndex = Math.max(0, Math.floor(head.latestEndIndex));
  } else if (buffer.endIndex !== undefined && Number.isFinite(buffer.endIndex)) {
    availableEndIndex = Math.max(0, Math.floor(buffer.endIndex));
  }

  return { availableStartIndex, availableEndIndex };
}

/**
 * Check whether the local window is impossible given the head state.
 * A window is impossible when the local start index is greater than the head's latest end index,
 * or when the head's available end index is smaller than the buffer's start index.
 */
export function hasImpossibleLocalWindow(
  head: SessionBufferHeadState | null | undefined,
  buffer: SessionBufferState,
): boolean {
  const { availableEndIndex } = resolveHeadAvailableBounds(head, buffer);

  // If head has availableEndIndex and it's less than buffer.startIndex, we are beyond server.
  if (availableEndIndex !== null && buffer.startIndex > availableEndIndex) {
    return true;
  }

  return false;
}
