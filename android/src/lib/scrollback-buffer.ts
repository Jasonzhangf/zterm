export interface IndexedScrollbackRange<TLine = string> {
  lines: TLine[];
  startIndex?: number;
}

export interface AbsoluteScrollbackCursorState {
  lastScrollbackCount: number;
  nextIndex: number;
}

export function toContiguousLatestRange<TLine>(entries: Array<[index: number, line: TLine]>): IndexedScrollbackRange<TLine> {
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
    lines: ordered.slice(sliceStart).map(([, line]) => line),
  };
}

export function mergeIndexedScrollbackRanges<TLine>(
  current: IndexedScrollbackRange<TLine>,
  incoming: IndexedScrollbackRange<TLine>,
): IndexedScrollbackRange<TLine> {
  if (incoming.lines.length === 0) {
    return {
      lines: current.lines.slice(),
      startIndex: current.startIndex,
    };
  }

  if (incoming.startIndex === undefined) {
    return {
      lines: incoming.lines.slice(),
      startIndex: undefined,
    };
  }

  if (current.lines.length === 0 || current.startIndex === undefined) {
    return {
      lines: incoming.lines.slice(),
      startIndex: incoming.startIndex,
    };
  }

  const merged = new Map<number, TLine>();
  current.lines.forEach((line, offset) => merged.set(current.startIndex! + offset, line));
  incoming.lines.forEach((line, offset) => merged.set(incoming.startIndex! + offset, line));
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
