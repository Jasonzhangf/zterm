import type {
  SessionBufferState,
  TerminalBufferPayload,
  TerminalCell,
  TerminalGapRange,
  TerminalIndexedLine,
} from './types';

const EMPTY_ROW: TerminalCell[] = [];

function cloneGapRanges(gapRanges: TerminalGapRange[]) {
  return gapRanges.map((range) => ({ ...range }));
}

function textLineToCells(line: string): TerminalCell[] {
  return Array.from(line).map((char) => ({
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  }));
}

export function cellsToLine(cells: TerminalCell[]) {
  let line = '';
  for (const cell of cells) {
    if (cell.width === 0) {
      continue;
    }
    line += cell.char >= 32 ? String.fromCodePoint(cell.char) : ' ';
  }
  return line.replace(/\s+$/u, '');
}

export function normalizeBufferLines(lines: Array<TerminalCell[] | string>, cacheLines: number) {
  const normalized = lines.map((line) => {
    if (Array.isArray(line)) {
      return line;
    }
    return textLineToCells(typeof line === 'string' ? line : String(line ?? ''));
  });

  if (normalized.length <= cacheLines) {
    return normalized;
  }

  return normalized.slice(normalized.length - cacheLines);
}

function normalizeIndexedLines(lines: TerminalIndexedLine[]) {
  return lines
    .filter((line) => line && Number.isFinite(line.index))
    .map((line) => ({
      index: Math.max(0, Math.floor(line.index)),
      cells: line.cells || EMPTY_ROW,
    }))
    .sort((left, right) => left.index - right.index);
}

function rowsEqual(left: TerminalCell[], right: TerminalCell[]) {
  if (left.length !== right.length) {
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

function isGapIndex(gapRanges: TerminalGapRange[], absoluteIndex: number) {
  for (const range of gapRanges) {
    if (absoluteIndex >= range.startIndex && absoluteIndex < range.endIndex) {
      return true;
    }
  }
  return false;
}

function collectGapRanges(rows: Array<TerminalCell[] | undefined>, startIndex: number) {
  const gapRanges: TerminalGapRange[] = [];
  let gapStartOffset: number | null = null;

  for (let offset = 0; offset < rows.length; offset += 1) {
    if (rows[offset] === undefined) {
      if (gapStartOffset === null) {
        gapStartOffset = offset;
      }
      continue;
    }

    if (gapStartOffset !== null) {
      gapRanges.push({
        startIndex: startIndex + gapStartOffset,
        endIndex: startIndex + offset,
      });
      gapStartOffset = null;
    }
  }

  if (gapStartOffset !== null) {
    gapRanges.push({
      startIndex: startIndex + gapStartOffset,
      endIndex: startIndex + rows.length,
    });
  }

  return gapRanges;
}

function trimToCache(
  startIndex: number,
  lines: TerminalCell[][],
  gapRanges: TerminalGapRange[],
  cacheLines: number,
  viewportEndIndex: number,
  viewportRows: number,
) {
  const safeStartIndex = Math.max(0, Math.floor(startIndex));
  const safeCacheLines = Math.max(1, Math.floor(cacheLines || 1));
  if (lines.length <= safeCacheLines) {
    return {
      startIndex: safeStartIndex,
      lines,
      gapRanges: cloneGapRanges(gapRanges),
    };
  }

  const safeEndIndex = safeStartIndex + lines.length;
  const safeViewportEndIndex = Math.max(
    safeStartIndex,
    Math.min(safeEndIndex, Math.floor(viewportEndIndex || safeEndIndex)),
  );
  const safeViewportRows = Math.max(1, Math.min(safeCacheLines, Math.floor(viewportRows || 1)));
  const trailingContextRows = Math.min(safeViewportRows, Math.max(0, safeCacheLines - safeViewportRows));

  let nextEndIndex = Math.min(safeEndIndex, safeViewportEndIndex + trailingContextRows);
  let nextStartIndex = Math.max(safeStartIndex, nextEndIndex - safeCacheLines);

  if (nextEndIndex - nextStartIndex < safeCacheLines) {
    nextEndIndex = Math.min(safeEndIndex, nextStartIndex + safeCacheLines);
    nextStartIndex = Math.max(safeStartIndex, nextEndIndex - safeCacheLines);
  }

  const sliceStart = Math.max(0, nextStartIndex - safeStartIndex);
  const sliceEnd = Math.max(sliceStart, Math.min(lines.length, sliceStart + safeCacheLines));
  const nextGapRanges = gapRanges
    .map((range) => ({
      startIndex: Math.max(nextStartIndex, range.startIndex),
      endIndex: Math.min(nextEndIndex, range.endIndex),
    }))
    .filter((range) => range.endIndex > range.startIndex);

  return {
    startIndex: nextStartIndex,
    lines: lines.slice(sliceStart, sliceEnd),
    gapRanges: nextGapRanges,
  };
}

function buildSessionBufferState(options: {
  lines: TerminalCell[][];
  gapRanges: TerminalGapRange[];
  startIndex: number;
  bufferHeadStartIndex: number;
  bufferTailEndIndex: number;
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  revision: number;
  cacheLines: number;
  updateKind: SessionBufferState['updateKind'];
}): SessionBufferState {
  const trimmed = trimToCache(
    options.startIndex,
    options.lines,
    options.gapRanges,
    options.cacheLines,
    options.bufferTailEndIndex,
    options.rows,
  );
  const endIndex = trimmed.startIndex + trimmed.lines.length;

  return {
    lines: trimmed.lines,
    gapRanges: trimmed.gapRanges,
    startIndex: trimmed.startIndex,
    endIndex,
    bufferHeadStartIndex: Math.max(0, Math.min(trimmed.startIndex, Math.floor(options.bufferHeadStartIndex))),
    bufferTailEndIndex: Math.max(trimmed.startIndex, Math.min(endIndex, Math.floor(options.bufferTailEndIndex))),
    cols: Math.max(1, Math.floor(options.cols || 80)),
    rows: Math.max(1, Math.floor(options.rows || 24)),
    cursorKeysApp: Boolean(options.cursorKeysApp),
    updateKind: options.updateKind,
    revision: Math.max(0, Math.floor(options.revision || 0)),
  };
}

export function createSessionBufferState(options: {
  lines?: Array<TerminalCell[] | string>;
  startIndex?: number;
  endIndex?: number;
  bufferHeadStartIndex?: number;
  bufferTailEndIndex?: number;
  cols?: number;
  rows?: number;
  cursorKeysApp?: boolean;
  revision?: number;
  cacheLines: number;
}): SessionBufferState {
  const startIndex = Number.isFinite(options.startIndex) ? Math.max(0, Math.floor(options.startIndex!)) : 0;
  const normalizedLines = normalizeBufferLines(options.lines || [], options.cacheLines);
  const requestedEndIndex = Number.isFinite(options.endIndex)
    ? Math.max(startIndex, Math.floor(options.endIndex!))
    : startIndex + normalizedLines.length;
  const expectedLineCount = Math.max(0, requestedEndIndex - startIndex);
  const lines = normalizedLines.slice(Math.max(0, normalizedLines.length - expectedLineCount));
  const effectiveStartIndex = Math.max(0, requestedEndIndex - lines.length);

  return buildSessionBufferState({
    lines,
    gapRanges: [],
    startIndex: effectiveStartIndex,
    bufferHeadStartIndex: Number.isFinite(options.bufferHeadStartIndex)
      ? Math.floor(options.bufferHeadStartIndex!)
      : effectiveStartIndex,
    bufferTailEndIndex: Number.isFinite(options.bufferTailEndIndex) ? Math.floor(options.bufferTailEndIndex!) : requestedEndIndex,
    cols: options.cols || 80,
    rows: options.rows || 24,
    cursorKeysApp: Boolean(options.cursorKeysApp),
    revision: options.revision ?? 0,
    cacheLines: options.cacheLines,
    updateKind: 'replace',
  });
}

function payloadToSparseWindow(payload: TerminalBufferPayload) {
  const normalizedLines = normalizeIndexedLines(payload.lines || []);
  const expectedStartIndex = Math.max(0, Math.floor(payload.startIndex || 0));
  const expectedEndIndex = Math.max(expectedStartIndex, Math.floor(payload.endIndex || expectedStartIndex));

  const rowsByIndex = new Map<number, TerminalCell[]>();
  for (const line of normalizedLines) {
    if (line.index < expectedStartIndex || line.index >= expectedEndIndex) {
      return {
        ok: false as const,
        reason: `buffer-sync lines exceed payload window: window ${expectedStartIndex}-${expectedEndIndex}, got ${line.index}`,
      };
    }
    rowsByIndex.set(line.index, line.cells);
  }

  return {
    ok: true as const,
    startIndex: expectedStartIndex,
    endIndex: expectedEndIndex,
    rowsByIndex,
  };
}

function buildPatchedWindowFromCurrent(
  current: SessionBufferState | undefined,
  sparseWindow: {
    startIndex: number;
    endIndex: number;
    rowsByIndex: Map<number, TerminalCell[]>;
  },
) {
  const nextLength = Math.max(0, sparseWindow.endIndex - sparseWindow.startIndex);
  const nextRows: Array<TerminalCell[] | undefined> = Array.from({ length: nextLength }, () => undefined);

  if (current && current.lines.length > 0) {
    const overlapStart = Math.max(current.startIndex, sparseWindow.startIndex);
    const overlapEnd = Math.min(current.endIndex, sparseWindow.endIndex);

    for (let absoluteIndex = overlapStart; absoluteIndex < overlapEnd; absoluteIndex += 1) {
      if (isGapIndex(current.gapRanges, absoluteIndex)) {
        continue;
      }
      const currentOffset = absoluteIndex - current.startIndex;
      const nextOffset = absoluteIndex - sparseWindow.startIndex;
      nextRows[nextOffset] = current.lines[currentOffset] || EMPTY_ROW;
    }
  }

  for (const [absoluteIndex, row] of sparseWindow.rowsByIndex.entries()) {
    const nextOffset = absoluteIndex - sparseWindow.startIndex;
    if (nextOffset < 0 || nextOffset >= nextRows.length) {
      continue;
    }
    nextRows[nextOffset] = row;
  }

  const gapRanges = collectGapRanges(nextRows, sparseWindow.startIndex);
  const lines = nextRows.map((row) => (row ? row : EMPTY_ROW));

  return {
    startIndex: sparseWindow.startIndex,
    lines,
    gapRanges,
  };
}

function detectUpdateKind(
  current: SessionBufferState | undefined,
  next: { startIndex: number; endIndex: number },
) {
  if (!current) {
    return 'replace' as const;
  }
  if (next.startIndex >= current.endIndex) {
    return 'append' as const;
  }
  if (next.endIndex <= current.startIndex) {
    return 'prepend' as const;
  }
  return 'patch' as const;
}

export function applyBufferSyncToSessionBuffer(
  current: SessionBufferState | undefined,
  payload: TerminalBufferPayload,
  cacheLines: number,
) {
  const revision = Number.isFinite(payload.revision) ? Math.max(0, Math.floor(payload.revision)) : 0;
  if (current && revision < current.revision) {
    return current;
  }

  const sparseWindow = payloadToSparseWindow(payload);
  if (!sparseWindow.ok) {
    console.error(`[terminal-buffer] rejected malformed buffer-sync: ${sparseWindow.reason}`);
    return current || createSessionBufferState({
      lines: [],
      startIndex: 0,
      endIndex: 0,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 0,
      cols: payload.cols,
      rows: payload.rows,
      cursorKeysApp: payload.cursorKeysApp,
      revision,
      cacheLines,
    });
  }

  const patched = buildPatchedWindowFromCurrent(current, sparseWindow);

  return buildSessionBufferState({
    lines: patched.lines,
    gapRanges: patched.gapRanges,
    startIndex: patched.startIndex,
    bufferHeadStartIndex: Number.isFinite(payload.availableStartIndex)
      ? Math.floor(payload.availableStartIndex!)
      : current?.bufferHeadStartIndex ?? sparseWindow.startIndex,
    bufferTailEndIndex: Number.isFinite(payload.viewportEndIndex) ? Math.floor(payload.viewportEndIndex) : sparseWindow.endIndex,
    cols: payload.cols,
    rows: payload.rows,
    cursorKeysApp: payload.cursorKeysApp,
    revision,
    cacheLines,
    updateKind: detectUpdateKind(current, sparseWindow),
  });
}

export function sessionBufferToHistory(buffer: SessionBufferState, cacheLines: number) {
  const materializedLines = buffer.lines.map((cells, offset) => (
    isGapIndex(buffer.gapRanges, buffer.startIndex + offset) ? '' : cellsToLine(cells)
  ));

  if (materializedLines.length <= cacheLines) {
    return materializedLines.join('\n');
  }
  return materializedLines.slice(-cacheLines).join('\n');
}

export function sessionBuffersEqual(left: SessionBufferState, right: SessionBufferState) {
  if (
    left.startIndex !== right.startIndex
    || left.endIndex !== right.endIndex
    || left.bufferHeadStartIndex !== right.bufferHeadStartIndex
    || left.bufferTailEndIndex !== right.bufferTailEndIndex
    || left.cols !== right.cols
    || left.rows !== right.rows
    || left.cursorKeysApp !== right.cursorKeysApp
    || left.lines.length !== right.lines.length
    || left.gapRanges.length !== right.gapRanges.length
  ) {
    return false;
  }

  for (let index = 0; index < left.gapRanges.length; index += 1) {
    if (
      left.gapRanges[index]?.startIndex !== right.gapRanges[index]?.startIndex
      || left.gapRanges[index]?.endIndex !== right.gapRanges[index]?.endIndex
    ) {
      return false;
    }
  }

  for (let index = 0; index < left.lines.length; index += 1) {
    if (!rowsEqual(left.lines[index], right.lines[index])) {
      return false;
    }
  }

  return true;
}
