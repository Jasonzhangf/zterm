export interface IndexedScrollbackRange {
  lines: string[];
  startIndex?: number;
}

export interface AbsoluteScrollbackCursorState {
  lastScrollbackCount: number;
  nextIndex: number;
}

function normalizeLine(line: unknown) {
  return typeof line === 'string' ? line : String(line ?? '');
}

export function toContiguousLatestRange(entries: Array<[index: number, line: string]>): IndexedScrollbackRange {
  if (entries.length === 0) {
    return { lines: [], startIndex: undefined };
  }

  const ordered = entries
    .filter(([index]) => Number.isFinite(index))
    .sort((left, right) => left[0] - right[0]);

  if (ordered.length === 0) {
    return { lines: [], startIndex: undefined };
  }

  let sliceStart = ordered.length - 1;
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    if (ordered[index - 1][0] !== ordered[index][0] - 1) {
      break;
    }
    sliceStart = index - 1;
  }

  return {
    startIndex: ordered[sliceStart][0],
    lines: ordered.slice(sliceStart).map(([, line]) => normalizeLine(line)),
  };
}

export function mergeIndexedScrollbackRanges(
  current: IndexedScrollbackRange,
  incoming: IndexedScrollbackRange,
): IndexedScrollbackRange {
  if (incoming.lines.length === 0) {
    return {
      lines: current.lines.map(normalizeLine),
      startIndex: current.startIndex,
    };
  }

  if (incoming.startIndex === undefined) {
    return {
      lines: incoming.lines.map(normalizeLine),
      startIndex: undefined,
    };
  }

  if (current.lines.length === 0 || current.startIndex === undefined) {
    return {
      lines: incoming.lines.map(normalizeLine),
      startIndex: incoming.startIndex,
    };
  }

  const merged = new Map<number, string>();
  current.lines.forEach((line, offset) => merged.set(current.startIndex! + offset, normalizeLine(line)));
  incoming.lines.forEach((line, offset) => merged.set(incoming.startIndex! + offset, normalizeLine(line)));
  return toContiguousLatestRange([...merged.entries()]);
}

export function reconcileAbsoluteScrollbackRange(
  state: AbsoluteScrollbackCursorState,
  currentScrollbackCount: number,
) {
  const normalizedCount = Math.max(0, Math.floor(currentScrollbackCount));

  if (state.lastScrollbackCount < 0) {
    const nextIndex = Math.max(state.nextIndex, normalizedCount);
    return {
      startIndex: Math.max(0, nextIndex - normalizedCount),
      nextIndex,
    };
  }

  const delta = normalizedCount - state.lastScrollbackCount;
  const nextIndex = delta >= 0
    ? state.nextIndex + delta
    : Math.max(state.nextIndex, normalizedCount);

  return {
    startIndex: Math.max(0, nextIndex - normalizedCount),
    nextIndex,
  };
}
