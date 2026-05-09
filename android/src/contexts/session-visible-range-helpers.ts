import type { Session, SessionBufferState, TerminalVisibleRange } from '../lib/types';
import {
  resolveVisibleRangeViewportRows as sharedResolveViewportRows,
  resolveVisibleRangeEndIndex as sharedResolveEndIndex,
  buildDefaultVisibleRange as sharedBuildDefaultRange,
  normalizeVisibleRange as sharedNormalize,
  visibleRangesEqual as sharedEqual,
} from '@zterm/shared/terminal/visible-range';

export type SessionVisibleRangeState = TerminalVisibleRange;

export function resolveSessionBufferView(
  session: Session,
  bufferOverride?: SessionBufferState | null,
): SessionBufferState {
  return bufferOverride || session.buffer;
}

export function resolveVisibleRangeViewportRows(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  bufferOverride?: SessionBufferState | null,
): number {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  const bufferRows = buffer.rows;
  return sharedResolveViewportRows(bufferRows, visibleRange);
}

export function resolveVisibleRangeEndIndex(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  bufferOverride?: SessionBufferState | null,
): number {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  const daemonHeadEndIndex = session.daemonHeadEndIndex ?? 0;
  const bufferTailEndIndex = buffer.bufferTailEndIndex ?? 0;
  const bufferEndIndex = buffer.endIndex ?? 0;
  return sharedResolveEndIndex(daemonHeadEndIndex, bufferTailEndIndex, bufferEndIndex, visibleRange);
}

export function buildDefaultSessionVisibleRange(
  session: Session,
  previousVisibleRange?: SessionVisibleRangeState,
  bufferOverride?: SessionBufferState | null,
): SessionVisibleRangeState {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  const bufferRows = buffer.rows;
  const daemonHeadEndIndex = session.daemonHeadEndIndex ?? 0;
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
