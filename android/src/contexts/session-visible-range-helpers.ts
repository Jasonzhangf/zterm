import type {
  Session,
  SessionBufferState,
  TerminalVisibleRange,
} from '../lib/types';

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
) {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  if (
    typeof visibleRange?.viewportRows === 'number'
    && Number.isFinite(visibleRange.viewportRows)
    && visibleRange.viewportRows > 0
  ) {
    return Math.max(1, Math.floor(visibleRange.viewportRows));
  }
  if (typeof buffer.rows === 'number' && Number.isFinite(buffer.rows) && buffer.rows > 0) {
    return Math.max(1, Math.floor(buffer.rows));
  }
  throw new Error(`Session ${session.id} is missing viewportRows truth for buffer request`);
}

export function resolveVisibleRangeEndIndex(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  bufferOverride?: SessionBufferState | null,
) {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  if (typeof visibleRange?.endIndex === 'number' && Number.isFinite(visibleRange.endIndex)) {
    return Math.max(0, Math.floor(visibleRange.endIndex));
  }
  return Math.max(0, Math.floor(
    session.daemonHeadEndIndex
    || buffer.bufferTailEndIndex
    || buffer.endIndex
    || 0,
  ));
}

export function buildDefaultSessionVisibleRange(
  session: Session,
  previousVisibleRange?: SessionVisibleRangeState,
  bufferOverride?: SessionBufferState | null,
): SessionVisibleRangeState {
  const viewportRows =
    typeof previousVisibleRange?.viewportRows === 'number'
      && Number.isFinite(previousVisibleRange.viewportRows)
      && previousVisibleRange.viewportRows > 0
      ? Math.max(1, Math.floor(previousVisibleRange.viewportRows))
      : resolveVisibleRangeViewportRows(session, undefined, bufferOverride);
  const endIndex = resolveVisibleRangeEndIndex(session, undefined, bufferOverride);
  return {
    startIndex: Math.max(0, endIndex - viewportRows),
    endIndex,
    viewportRows,
  };
}

export function normalizeSessionVisibleRangeState(
  visibleRange: SessionVisibleRangeState,
): SessionVisibleRangeState {
  const viewportRows = Math.max(1, Math.floor(visibleRange.viewportRows || 1));
  const endIndex = Math.max(0, Math.floor(visibleRange.endIndex || 0));
  return {
    startIndex: Math.max(0, Math.min(endIndex, Math.floor(visibleRange.startIndex || 0))),
    endIndex,
    viewportRows,
  };
}

export function visibleRangeStatesEqual(
  left?: SessionVisibleRangeState,
  right?: SessionVisibleRangeState,
) {
  if (!left || !right) {
    return false;
  }
  return (
    left.startIndex === right.startIndex
    && left.endIndex === right.endIndex
    && left.viewportRows === right.viewportRows
  );
}
