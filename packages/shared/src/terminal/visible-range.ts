export interface VisibleRangeState {
  startIndex: number;
  endIndex: number;
  viewportRows: number;
}

export function resolveVisibleRangeViewportRows(
  bufferRows: number,
  visibleRange?: VisibleRangeState,
): number {
  if (
    typeof visibleRange?.viewportRows === 'number' &&
    Number.isFinite(visibleRange.viewportRows) &&
    visibleRange.viewportRows > 0
  ) {
    return Math.max(1, Math.floor(visibleRange.viewportRows));
  }
  if (typeof bufferRows === 'number' && Number.isFinite(bufferRows) && bufferRows > 0) {
    return Math.max(1, Math.floor(bufferRows));
  }
  throw new Error(`Missing viewportRows truth: bufferRows=${bufferRows}`);
}

export function resolveVisibleRangeEndIndex(
  daemonHeadEndIndex: number,
  bufferTailEndIndex: number,
  bufferEndIndex: number,
  visibleRange?: VisibleRangeState,
): number {
  if (typeof visibleRange?.endIndex === 'number' && Number.isFinite(visibleRange.endIndex)) {
    return Math.max(0, Math.floor(visibleRange.endIndex));
  }
  return Math.max(
    0,
    Math.floor(daemonHeadEndIndex || bufferTailEndIndex || bufferEndIndex || 0),
  );
}

export function buildDefaultVisibleRange(
  bufferRows: number,
  daemonHeadEndIndex: number,
  bufferTailEndIndex: number,
  bufferEndIndex: number,
  previousVisibleRange?: VisibleRangeState,
): VisibleRangeState {
  const viewportRows =
    typeof previousVisibleRange?.viewportRows === 'number' &&
    Number.isFinite(previousVisibleRange.viewportRows) &&
    previousVisibleRange.viewportRows > 0
      ? Math.max(1, Math.floor(previousVisibleRange.viewportRows))
      : resolveVisibleRangeViewportRows(bufferRows, undefined);
  const endIndex = resolveVisibleRangeEndIndex(
    daemonHeadEndIndex,
    bufferTailEndIndex,
    bufferEndIndex,
    undefined,
  );
  return {
    startIndex: Math.max(0, endIndex - viewportRows),
    endIndex,
    viewportRows,
  };
}

export function normalizeVisibleRange(
  visibleRange: VisibleRangeState,
): VisibleRangeState {
  const viewportRows = Math.max(1, Math.floor(visibleRange.viewportRows || 1));
  const endIndex = Math.max(0, Math.floor(visibleRange.endIndex || 0));
  return {
    startIndex: Math.max(0, Math.min(endIndex, Math.floor(visibleRange.startIndex || 0))),
    endIndex,
    viewportRows,
  };
}

export function visibleRangesEqual(
  left?: VisibleRangeState,
  right?: VisibleRangeState,
): boolean {
  if (!left || !right) return false;
  return (
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex &&
    left.viewportRows === right.viewportRows
  );
}
