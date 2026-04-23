import type { TerminalCell, TerminalIndexedLine } from '../lib/types';

const FLAG_REVERSE = 0x20;

export function cloneCell(cell: TerminalCell): TerminalCell {
  return { ...cell };
}

export function cloneRow(row: TerminalCell[]): TerminalCell[] {
  return row.map(cloneCell);
}

export function cloneRows(rows: TerminalCell[][]): TerminalCell[][] {
  return rows.map(cloneRow);
}

export function rowsEqual(left: TerminalCell[] | null | undefined, right: TerminalCell[] | null | undefined) {
  if (!left || !right || left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) {
      return false;
    }
    if (a.char !== b.char || a.fg !== b.fg || a.bg !== b.bg || a.flags !== b.flags || a.width !== b.width) {
      return false;
    }
  }

  return true;
}

export function resolveCursorPaintColumn(row: TerminalCell[], preferredCol: number) {
  if (row.length === 0) {
    return -1;
  }

  const clamped = Math.max(0, Math.min(row.length - 1, Math.floor(preferredCol)));
  if (row[clamped]?.width !== 0) {
    return clamped;
  }

  for (let col = clamped - 1; col >= 0; col -= 1) {
    if (row[col]?.width !== 0) {
      return col;
    }
  }

  return clamped;
}

export function paintCursorOnRow(row: TerminalCell[], cursorCol: number) {
  if (row.length === 0) {
    return row;
  }

  const nextRow = cloneRow(row);
  const paintCol = resolveCursorPaintColumn(nextRow, cursorCol);
  if (paintCol < 0 || !nextRow[paintCol]) {
    return nextRow;
  }

  nextRow[paintCol] = {
    ...nextRow[paintCol],
    flags: nextRow[paintCol].flags | FLAG_REVERSE,
  };
  return nextRow;
}

export function paintCursorIntoViewport(
  viewport: TerminalCell[][],
  cursorRowInViewport: number,
  cursorCol: number,
  cursorVisible: boolean,
) {
  if (!cursorVisible) {
    return cloneRows(viewport);
  }

  return viewport.map((row, index) => (
    index === cursorRowInViewport ? paintCursorOnRow(row, cursorCol) : cloneRow(row)
  ));
}

export function trimCanonicalBufferWindow(bufferStartIndex: number, bufferLines: TerminalCell[][], maxLines: number) {
  const safeMaxLines = Math.max(1, Math.floor(maxLines));
  if (bufferLines.length <= safeMaxLines) {
    return {
      startIndex: bufferStartIndex,
      lines: bufferLines,
    };
  }

  const trimCount = bufferLines.length - safeMaxLines;
  return {
    startIndex: bufferStartIndex + trimCount,
    lines: bufferLines.slice(trimCount),
  };
}

export function toIndexedLines(startIndex: number, lines: TerminalCell[][]): TerminalIndexedLine[] {
  return lines.map((cells, offset) => ({
    index: startIndex + offset,
    cells,
  }));
}

export function sliceIndexedLines(
  bufferStartIndex: number,
  bufferLines: TerminalCell[][],
  startIndex: number,
  endIndex: number,
) {
  const actualStart = Math.max(bufferStartIndex, Math.floor(startIndex));
  const actualEnd = Math.max(actualStart, Math.min(bufferStartIndex + bufferLines.length, Math.floor(endIndex)));
  const startOffset = actualStart - bufferStartIndex;
  const endOffset = actualEnd - bufferStartIndex;
  return toIndexedLines(actualStart, bufferLines.slice(startOffset, endOffset));
}

export function findChangedIndexedRange(options: {
  previousStartIndex: number;
  previousLines: TerminalCell[][];
  nextStartIndex: number;
  nextLines: TerminalCell[][];
}) {
  const nextEndIndex = options.nextStartIndex + options.nextLines.length;

  let firstChangedIndex: number | null = null;
  for (let index = options.nextStartIndex; index < nextEndIndex; index += 1) {
    const previousOffset = index - options.previousStartIndex;
    const nextOffset = index - options.nextStartIndex;
    const previousRow =
      previousOffset >= 0 && previousOffset < options.previousLines.length
        ? options.previousLines[previousOffset]
        : null;
    const nextRow =
      nextOffset >= 0 && nextOffset < options.nextLines.length
        ? options.nextLines[nextOffset]
        : null;

    if (!rowsEqual(previousRow, nextRow)) {
      firstChangedIndex = index;
      break;
    }
  }

  if (firstChangedIndex === null) {
    return null;
  }

  let lastChangedIndex = firstChangedIndex;
  for (let index = nextEndIndex - 1; index >= firstChangedIndex; index -= 1) {
    const previousOffset = index - options.previousStartIndex;
    const nextOffset = index - options.nextStartIndex;
    const previousRow =
      previousOffset >= 0 && previousOffset < options.previousLines.length
        ? options.previousLines[previousOffset]
        : null;
    const nextRow =
      nextOffset >= 0 && nextOffset < options.nextLines.length
        ? options.nextLines[nextOffset]
        : null;

    if (!rowsEqual(previousRow, nextRow)) {
      lastChangedIndex = index;
      break;
    }
  }

  return {
    startIndex: firstChangedIndex,
    endIndex: lastChangedIndex + 1,
  };
}

export function resolveIncrementalSyncRange(options: {
  changedRange: { startIndex: number; endIndex: number } | null;
  bufferStartIndex: number;
  bufferEndIndex: number;
  viewportEndIndex: number;
  viewportRows: number;
}) {
  if (!options.changedRange) {
    return null;
  }

  const safeBufferStart = Math.max(0, Math.floor(options.bufferStartIndex));
  const safeBufferEnd = Math.max(safeBufferStart, Math.floor(options.bufferEndIndex));
  if (safeBufferEnd <= safeBufferStart) {
    return null;
  }

  const changedStart = Math.max(safeBufferStart, Math.min(safeBufferEnd, Math.floor(options.changedRange.startIndex)));
  const changedEnd = Math.max(changedStart, Math.min(safeBufferEnd, Math.floor(options.changedRange.endIndex)));
  if (changedEnd <= changedStart) {
    return null;
  }

  return {
    startIndex: changedStart,
    endIndex: changedEnd,
  };
}

export function resolveClientIncrementalPatchRange(options: {
  knownRevision: number;
  currentRevision: number;
  lastDeltaFromRevision: number;
  lastDeltaToRevision: number;
  lastDeltaRange: { startIndex: number; endIndex: number } | null;
  bufferStartIndex: number;
  bufferEndIndex: number;
  localStartIndex: number;
  localEndIndex: number;
  viewportEndIndex: number;
  viewportRows: number;
}) {
  const safeBufferStart = Math.max(0, Math.floor(options.bufferStartIndex));
  const safeBufferEnd = Math.max(safeBufferStart, Math.floor(options.bufferEndIndex));
  if (safeBufferEnd <= safeBufferStart || !options.lastDeltaRange) {
    return null;
  }

  const safeKnownRevision = Math.max(0, Math.floor(options.knownRevision));
  const safeCurrentRevision = Math.max(0, Math.floor(options.currentRevision));
  const safeDeltaFromRevision = Math.max(0, Math.floor(options.lastDeltaFromRevision));
  const safeDeltaToRevision = Math.max(0, Math.floor(options.lastDeltaToRevision));

  if (
    safeKnownRevision >= safeCurrentRevision
    || safeKnownRevision !== safeDeltaFromRevision
    || safeCurrentRevision !== safeDeltaToRevision
  ) {
    return null;
  }

  const safeLocalStart = Math.max(0, Math.floor(options.localStartIndex));
  const safeLocalEnd = Math.max(safeLocalStart, Math.floor(options.localEndIndex));
  const overlapStart = Math.max(safeBufferStart, safeLocalStart);
  const overlapEnd = Math.min(safeBufferEnd, safeLocalEnd);
  if (overlapEnd <= overlapStart) {
    return null;
  }

  const changedStart = Math.max(
    safeBufferStart,
    Math.min(safeBufferEnd, Math.floor(options.lastDeltaRange.startIndex)),
  );
  const changedEnd = Math.max(
    changedStart,
    Math.min(safeBufferEnd, Math.floor(options.lastDeltaRange.endIndex)),
  );
  if (changedEnd <= changedStart) {
    return null;
  }

  return resolveIncrementalSyncRange({
    changedRange: {
      startIndex: changedStart,
      endIndex: changedEnd,
    },
    bufferStartIndex: safeBufferStart,
    bufferEndIndex: safeBufferEnd,
    viewportEndIndex: options.viewportEndIndex,
    viewportRows: options.viewportRows,
  });
}

function mergeIndexedRanges(ranges: Array<{ startIndex: number; endIndex: number }>) {
  const merged: Array<{ startIndex: number; endIndex: number }> = [];
  const sorted = [...ranges]
    .filter((range) => range.endIndex > range.startIndex)
    .sort((left, right) => left.startIndex - right.startIndex);

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.startIndex > last.endIndex) {
      merged.push({ ...range });
      continue;
    }
    last.endIndex = Math.max(last.endIndex, range.endIndex);
  }

  return merged;
}

export function resolveFollowTailSyncPlan(options: {
  knownRevision: number;
  currentRevision: number;
  lastDeltaFromRevision: number;
  lastDeltaToRevision: number;
  lastDeltaRange: { startIndex: number; endIndex: number } | null;
  bufferStartIndex: number;
  bufferEndIndex: number;
  localStartIndex: number;
  localEndIndex: number;
  viewportRows: number;
  cacheLines: number;
}) {
  const safeBufferStart = Math.max(0, Math.floor(options.bufferStartIndex));
  const safeBufferEnd = Math.max(safeBufferStart, Math.floor(options.bufferEndIndex));
  if (safeBufferEnd <= safeBufferStart) {
    return null;
  }

  const viewportRows = Math.max(1, Math.floor(options.viewportRows || 1));
  const cacheLines = Math.max(viewportRows, Math.floor(options.cacheLines || viewportRows));
  const windowStartIndex = Math.max(safeBufferStart, safeBufferEnd - cacheLines);
  const windowEndIndex = safeBufferEnd;
  const safeLocalStart = Math.max(0, Math.floor(options.localStartIndex || 0));
  const safeLocalEnd = Math.max(safeLocalStart, Math.floor(options.localEndIndex || safeLocalStart));
  const localCoversTail = safeLocalStart <= windowStartIndex && safeLocalEnd >= windowEndIndex;

  let deltaRange: { startIndex: number; endIndex: number } | null = null;
  const safeKnownRevision = Math.max(0, Math.floor(options.knownRevision || 0));
  const safeCurrentRevision = Math.max(0, Math.floor(options.currentRevision || 0));
  const safeDeltaFromRevision = Math.max(0, Math.floor(options.lastDeltaFromRevision || 0));
  const safeDeltaToRevision = Math.max(0, Math.floor(options.lastDeltaToRevision || 0));
  if (
    options.lastDeltaRange
    && safeKnownRevision < safeCurrentRevision
    && safeKnownRevision === safeDeltaFromRevision
    && safeCurrentRevision === safeDeltaToRevision
  ) {
    const startIndex = Math.max(windowStartIndex, Math.floor(options.lastDeltaRange.startIndex || 0));
    const endIndex = Math.min(windowEndIndex, Math.floor(options.lastDeltaRange.endIndex || 0));
    if (endIndex > startIndex) {
      deltaRange = { startIndex, endIndex };
    }
  }

  if (localCoversTail && deltaRange) {
    return {
      windowStartIndex,
      windowEndIndex,
      ranges: [deltaRange],
    };
  }

  const ranges: Array<{ startIndex: number; endIndex: number }> = [];
  if (safeLocalStart > windowStartIndex) {
    ranges.push({
      startIndex: windowStartIndex,
      endIndex: Math.min(safeLocalStart, windowEndIndex),
    });
  }
  if (safeLocalEnd < windowEndIndex) {
    ranges.push({
      startIndex: Math.max(safeLocalEnd, windowStartIndex),
      endIndex: windowEndIndex,
    });
  }
  if (deltaRange) {
    ranges.push(deltaRange);
  }

  const mergedRanges = mergeIndexedRanges(ranges);
  if (mergedRanges.length > 0) {
    return {
      windowStartIndex,
      windowEndIndex,
      ranges: mergedRanges,
    };
  }

  return {
    windowStartIndex,
    windowEndIndex,
    ranges: [{ startIndex: windowStartIndex, endIndex: windowEndIndex }],
  };
}

export function advanceKnownLocalWindowRange(options: {
  localStartIndex: number;
  localEndIndex: number;
  payloadStartIndex: number;
  payloadEndIndex: number;
}) {
  const localStartIndex = Math.max(0, Math.floor(options.localStartIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(options.localEndIndex || localStartIndex));
  const payloadStartIndex = Math.max(0, Math.floor(options.payloadStartIndex || 0));
  const payloadEndIndex = Math.max(payloadStartIndex, Math.floor(options.payloadEndIndex || payloadStartIndex));

  if (payloadEndIndex <= payloadStartIndex) {
    return {
      startIndex: localStartIndex,
      endIndex: localEndIndex,
    };
  }

  if (localEndIndex <= localStartIndex) {
    return {
      startIndex: payloadStartIndex,
      endIndex: payloadEndIndex,
    };
  }

  const overlapsOrTouches = payloadStartIndex <= localEndIndex && payloadEndIndex >= localStartIndex;
  if (!overlapsOrTouches) {
    return {
      startIndex: payloadStartIndex,
      endIndex: payloadEndIndex,
    };
  }

  return {
    startIndex: Math.min(localStartIndex, payloadStartIndex),
    endIndex: Math.max(localEndIndex, payloadEndIndex),
  };
}

export function resolveCanonicalAvailableLineCount(options: {
  paneRows: number;
  historySize: number;
  capturedLineCount: number;
  scratchLineCount: number;
}) {
  return Math.max(
    Math.max(1, Math.floor(options.paneRows)),
    Math.max(0, Math.floor(options.historySize)),
    Math.max(0, Math.floor(options.capturedLineCount)),
    Math.max(0, Math.floor(options.scratchLineCount)),
  );
}
