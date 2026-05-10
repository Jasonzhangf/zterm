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

  // No head → endIndex is unknown, return null
  if (head == null) {
    return { availableStartIndex, availableEndIndex: null };
  }

  if (head.availableEndIndex !== undefined && Number.isFinite(head.availableEndIndex)) {
    availableEndIndex = Math.max(0, Math.floor(head.availableEndIndex));
  } else if (typeof head.latestEndIndex === 'number' && head.latestEndIndex > 0) {
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

/**
 * Resolve the authoritative available end index from head and buffer.
 * This is a pure decision function used to determine how far the server has data.
 *
 * @param headAvailableEndIndex - liveHead.availableEndIndex (may be undefined/null)
 * @param headLatestEndIndex - liveHead.latestEndIndex (may be 0 if not available)
 * @param daemonHeadRevision - session.daemonHeadRevision (0 if none)
 * @param daemonHeadEndIndex - session.daemonHeadEndIndex (0 if none)
 * @param bufferTailEndIndex - buffer.bufferTailEndIndex (0 if none)
 * @param bufferEndIndex - buffer.endIndex (0 if none)
 * @returns number or null if no authoritative end index can be determined
 */
export function resolveAuthoritativeAvailableEndIndex(
  headAvailableEndIndex: number | null | undefined,
  headLatestEndIndex: number,
  daemonHeadRevision: number,
  daemonHeadEndIndex: number,
  bufferTailEndIndex: number,
  bufferEndIndex: number,
): number | null {
  if (typeof headAvailableEndIndex === 'number' && Number.isFinite(headAvailableEndIndex)) {
    return Math.max(0, Math.floor(headAvailableEndIndex));
  }
  if (typeof headLatestEndIndex === 'number' && headLatestEndIndex > 0) {
    return Math.max(0, Math.floor(headLatestEndIndex));
  }
  if (daemonHeadRevision > 0 || daemonHeadEndIndex > 0) {
    return Math.max(0, Math.floor(daemonHeadEndIndex));
  }
  if (bufferTailEndIndex > 0) {
    return Math.max(0, Math.floor(bufferTailEndIndex));
  }
  if (bufferEndIndex > 0) {
    return Math.max(0, Math.floor(bufferEndIndex));
  }
  return null;
}

/**
 * Check if a buffer has a local window (non-empty range with valid revision).
 * Pure function: accepts primitive values, no session dependency.
 */
export function hasLocalWindow(
  startIndex: number,
  endIndex: number,
  revision: number,
): boolean {
  return (
    Math.max(0, Math.floor(endIndex)) > Math.max(0, Math.floor(startIndex))
    && Math.max(0, Math.floor(revision)) > 0
  );
}
