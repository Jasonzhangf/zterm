import type { SessionBufferState, TerminalVisibleRange } from '../lib/types';
import {
  resolveVisibleRangeViewportRows as sharedResolveViewportRows,
  resolveVisibleRangeEndIndex as sharedResolveEndIndex,
  buildDefaultVisibleRange as sharedBuildDefaultRange,
  normalizeVisibleRange as sharedNormalize,
  visibleRangesEqual as sharedEqual,
} from '@zterm/shared/terminal/visible-range';

export type SessionVisibleRangeState = TerminalVisibleRange;

/** Daemon head truth view read from the session head store (single truth source). */
export interface SessionDaemonHeadView {
  daemonHeadRevision: number;
  daemonHeadEndIndex: number;
}

export const EMPTY_SESSION_DAEMON_HEAD_VIEW: SessionDaemonHeadView = {
  daemonHeadRevision: 0,
  daemonHeadEndIndex: 0,
};

export function resolveVisibleRangeViewportRows(
  visibleRange: SessionVisibleRangeState | undefined,
  buffer: SessionBufferState,
): number {
  const bufferRows = buffer.rows;
  return sharedResolveViewportRows(bufferRows, visibleRange);
}

export function resolveVisibleRangeEndIndex(
  head: SessionDaemonHeadView,
  visibleRange: SessionVisibleRangeState | undefined,
  buffer: SessionBufferState,
): number {
  const daemonHeadEndIndex = head.daemonHeadEndIndex ?? 0;
  const bufferTailEndIndex = buffer.bufferTailEndIndex ?? 0;
  const bufferEndIndex = buffer.endIndex ?? 0;
  return sharedResolveEndIndex(daemonHeadEndIndex, bufferTailEndIndex, bufferEndIndex, visibleRange);
}

export function buildDefaultSessionVisibleRange(
  head: SessionDaemonHeadView,
  previousVisibleRange: SessionVisibleRangeState | undefined,
  buffer: SessionBufferState,
): SessionVisibleRangeState {
  const bufferRows = buffer.rows;
  const daemonHeadEndIndex = head.daemonHeadEndIndex ?? 0;
  const bufferTailEndIndex = buffer.bufferTailEndIndex ?? 0;
  const bufferEndIndex = buffer.endIndex ?? 0;
  return sharedBuildDefaultRange(
    bufferRows,
    daemonHeadEndIndex,
    bufferTailEndIndex,
    bufferEndIndex,
    previousVisibleRange,
  );
}

export function normalizeSessionVisibleRangeState(
  visibleRange: SessionVisibleRangeState,
): SessionVisibleRangeState {
  return sharedNormalize(visibleRange);
}

export function visibleRangeStatesEqual(
  left?: SessionVisibleRangeState,
  right?: SessionVisibleRangeState,
): boolean {
  return sharedEqual(left, right);
}
