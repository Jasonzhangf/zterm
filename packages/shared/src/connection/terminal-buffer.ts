import type {
  SessionBufferState,
  TerminalBufferPayload,
  TerminalCell,
  TerminalGapRange,
  TerminalIndexedLine,
  CompactIndexedLine,
  WireIndexedLine,
} from './types';

const EMPTY_ROW: TerminalCell[] = [];

const COMPACT_DEFAULT_FG = 256;
const COMPACT_DEFAULT_BG = 256;
const COMPACT_DEFAULT_FLAGS = 0;

export function isCompactLine(line: WireIndexedLine): line is CompactIndexedLine {
  return typeof (line as CompactIndexedLine).t === 'string';
}

/**
 * Expand a CompactIndexedLine back to TerminalCell[] for client consumption.
 */
export function expandCompactLine(
  line: CompactIndexedLine,
  cols: number,
): TerminalCell[] {
  const spanLookup = new Map<number, { fg: number; bg: number; flags: number }>();

  if (line.s) {
    for (const [start, end, fg, bg, flags] of line.s) {
      for (let c = start; c < end; c++) {
        spanLookup.set(c, { fg, bg, flags: flags ?? 0 });
      }
    }
  }

  const cells: TerminalCell[] = Array.from({ length: cols }, (_, c) => {
    const style = spanLookup.get(c);
    return {
      char: 32,
      fg: style?.fg ?? COMPACT_DEFAULT_FG,
      bg: style?.bg ?? COMPACT_DEFAULT_BG,
      flags: style?.flags ?? COMPACT_DEFAULT_FLAGS,
      width: 1,
    };
  });

  const codePoints = [...line.t];
  const widths = Array.isArray(line.w) ? line.w : [];
  let col = 0;
  for (let i = 0; i < codePoints.length && col < cols; i++) {
    const cp = codePoints[i]!.codePointAt(0)!;
    const w = widths[i] === 2 ? 2 : 1;
    const style = spanLookup.get(col);
    cells[col] = {
      char: cp,
      fg: style?.fg ?? COMPACT_DEFAULT_FG,
      bg: style?.bg ?? COMPACT_DEFAULT_BG,
      flags: style?.flags ?? COMPACT_DEFAULT_FLAGS,
      width: w,
    };
    if (w === 2 && col + 1 < cols) {
      cells[col + 1] = {
        char: 32,
        fg: style?.fg ?? COMPACT_DEFAULT_FG,
        bg: style?.bg ?? COMPACT_DEFAULT_BG,
        flags: style?.flags ?? COMPACT_DEFAULT_FLAGS,
        width: 0,
      };
    }
    col += w;
  }

  return cells;
}

export function normalizeWireLines(lines: WireIndexedLine[], cols: number): TerminalIndexedLine[] {
  const result: TerminalIndexedLine[] = [];
  for (const line of lines) {
    if (isCompactLine(line)) {
      const index = Math.max(0, Math.floor(line.i));
      const cells = expandCompactLine(line, cols);
      result.push({ index, cells });
    } else {
      const legacy = line as TerminalIndexedLine;
      if (legacy && Number.isFinite(legacy.index)) {
        result.push({
          index: Math.max(0, Math.floor(legacy.index)),
          cells: legacy.cells || EMPTY_ROW,
        });
      }
    }
  }
  return result.sort((left, right) => left.index - right.index);
}

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

export function replayBufferSyncHistory(options: {
  history: Array<{ type: string; payload: TerminalBufferPayload }>;
  rows: number;
  cols: number;
  cacheLines: number;
}): SessionBufferState {
  let buffer = createSessionBufferState({
    cacheLines: options.cacheLines,
    lines: [],
    rows: options.rows,
    cols: options.cols,
  });

  for (const item of options.history) {
    if (item.type !== 'buffer-sync') {
      continue;
    }
    const nextRevision = Math.max(0, Math.floor(item.payload.revision || 0));
    if (nextRevision < Math.max(0, Math.floor(buffer.revision || 0))) {
      buffer = createSessionBufferState({
        cacheLines: options.cacheLines,
        lines: [],
        rows: item.payload.rows || buffer.rows || options.rows,
        cols: item.payload.cols || buffer.cols || options.cols,
        cursorKeysApp: item.payload.cursorKeysApp,
        revision: 0,
      });
    }
    buffer = applyBufferSyncToSessionBuffer(buffer, item.payload, options.cacheLines);
  }

  return buffer;
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
  options?: {
    preferredStartIndex?: number;
    preferredEndIndex?: number;
  },
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
  let nextEndIndex = safeEndIndex;
  let nextStartIndex = Math.max(safeStartIndex, nextEndIndex - safeCacheLines);

  if (Number.isFinite(options?.preferredStartIndex)) {
    const candidateStartIndex = Math.max(
      safeStartIndex,
      Math.min(Math.floor(options!.preferredStartIndex!), Math.max(safeStartIndex, safeEndIndex - safeCacheLines)),
    );
    nextStartIndex = candidateStartIndex;
    nextEndIndex = Math.min(safeEndIndex, candidateStartIndex + safeCacheLines);
  } else if (Number.isFinite(options?.preferredEndIndex)) {
    const candidateEndIndex = Math.min(
      safeEndIndex,
      Math.max(Math.floor(options!.preferredEndIndex!), Math.min(safeEndIndex, safeStartIndex + safeCacheLines)),
    );
    nextEndIndex = candidateEndIndex;
    nextStartIndex = Math.max(safeStartIndex, candidateEndIndex - safeCacheLines);
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
  preferredStartIndex?: number;
  preferredEndIndex?: number;
  bufferHeadStartIndex: number;
  bufferTailEndIndex: number;
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  cursor?: import('./types').TerminalCursorState | null;
  revision: number;
  cacheLines: number;
  updateKind: SessionBufferState['updateKind'];
}): SessionBufferState {
  const trimmed = trimToCache(
    options.startIndex,
    options.lines,
    options.gapRanges,
    options.cacheLines,
    {
      preferredStartIndex: options.preferredStartIndex,
      preferredEndIndex: options.preferredEndIndex,
    },
  );
  const endIndex = trimmed.startIndex + trimmed.lines.length;

  return {
    lines: trimmed.lines,
    gapRanges: trimmed.gapRanges,
    startIndex: trimmed.startIndex,
    endIndex,
    bufferHeadStartIndex: Math.max(0, Math.min(trimmed.startIndex, Math.floor(options.bufferHeadStartIndex))),
    bufferTailEndIndex: Math.max(0, Math.floor(options.bufferTailEndIndex)),
    cols: Math.max(1, Math.floor(options.cols || 80)),
    rows: Math.max(1, Math.floor(options.rows || 24)),
    cursorKeysApp: Boolean(options.cursorKeysApp),
    cursor: options.cursor ?? null,
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
  cursor?: import('./types').TerminalCursorState | null;
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
    cursor: options.cursor ?? null,
    revision: options.revision ?? 0,
    cacheLines: options.cacheLines,
    updateKind: 'replace',
  });
}

function payloadToSparseWindow(payload: TerminalBufferPayload) {
  const normalizedLines = normalizeWireLines(payload.lines || [], payload.cols || 80);
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
    coversWholeWindow: rowsByIndex.size === Math.max(0, expectedEndIndex - expectedStartIndex),
    rowsByIndex,
  };
}

function resolveAuthoritativeHeadStartIndex(
  current: SessionBufferState | undefined,
  sparseWindow: { startIndex: number },
  payload: TerminalBufferPayload,
) {
  if (Number.isFinite(payload.availableStartIndex)) {
    return Math.max(0, Math.floor(payload.availableStartIndex!));
  }
  if (!current || current.endIndex <= current.startIndex) {
    return Math.max(0, sparseWindow.startIndex);
  }
  return Math.max(0, Math.min(current.bufferHeadStartIndex ?? sparseWindow.startIndex, sparseWindow.startIndex));
}

function resolveAuthoritativeTailEndIndex(
  current: SessionBufferState | undefined,
  sparseWindow: { endIndex: number },
  payload: TerminalBufferPayload,
) {
  if (Number.isFinite(payload.availableEndIndex)) {
    return Math.max(0, Math.floor(payload.availableEndIndex!));
  }
  return Math.max(
    current?.bufferTailEndIndex ?? 0,
    sparseWindow.endIndex,
  );
}

function clampWindowToBounds(options: {
  desiredStartIndex: number;
  desiredEndIndex: number;
  authoritativeHeadStartIndex: number;
  authoritativeTailEndIndex: number;
  cacheLines: number;
}) {
  const safeHead = Math.max(0, Math.floor(options.authoritativeHeadStartIndex));
  const safeTail = Math.max(safeHead, Math.floor(options.authoritativeTailEndIndex));
  const safeCacheLines = Math.max(1, Math.floor(options.cacheLines || 1));
  let startIndex = Math.max(safeHead, Math.floor(options.desiredStartIndex));
  let endIndex = Math.max(startIndex, Math.floor(options.desiredEndIndex));

  startIndex = Math.min(startIndex, safeTail);
  endIndex = Math.min(endIndex, safeTail);

  if (endIndex - startIndex > safeCacheLines) {
    endIndex = Math.min(safeTail, Math.max(startIndex, startIndex + safeCacheLines));
    startIndex = Math.max(safeHead, endIndex - safeCacheLines);
  }

  if (endIndex < startIndex) {
    endIndex = startIndex;
  }

  return {
    startIndex,
    endIndex,
  };
}

function resolveDesiredLocalWindow(options: {
  current: SessionBufferState | undefined;
  sparseWindow: { startIndex: number; endIndex: number };
  authoritativeHeadStartIndex: number;
  authoritativeTailEndIndex: number;
  cacheLines: number;
  preserveCurrentWindow?: boolean;
}) {
  const safeHead = Math.max(0, Math.floor(options.authoritativeHeadStartIndex));
  const safeTail = Math.max(safeHead, Math.floor(options.authoritativeTailEndIndex));
  const safeCacheLines = Math.max(1, Math.floor(options.cacheLines || 1));

  const currentHasWindow = Boolean(options.current && options.current.endIndex > options.current.startIndex);
  if (!currentHasWindow) {
    return clampWindowToBounds({
      desiredStartIndex: Math.max(safeHead, options.sparseWindow.endIndex - safeCacheLines),
      desiredEndIndex: options.sparseWindow.endIndex,
      authoritativeHeadStartIndex: safeHead,
      authoritativeTailEndIndex: safeTail,
      cacheLines: safeCacheLines,
    });
  }

  const current = options.current!;
  if (options.preserveCurrentWindow) {
    return clampWindowToBounds({
      desiredStartIndex: current.startIndex,
      desiredEndIndex: current.endIndex,
      authoritativeHeadStartIndex: safeHead,
      authoritativeTailEndIndex: safeTail,
      cacheLines: safeCacheLines,
    });
  }

  let desiredStartIndex = current.startIndex;
  let desiredEndIndex = current.endIndex;

  if (options.sparseWindow.startIndex < current.startIndex) {
    desiredStartIndex = options.sparseWindow.startIndex;
    desiredEndIndex = desiredStartIndex + safeCacheLines;
  } else if (options.sparseWindow.endIndex > current.endIndex) {
    desiredEndIndex = options.sparseWindow.endIndex;
    desiredStartIndex = desiredEndIndex - safeCacheLines;
  }

  return clampWindowToBounds({
    desiredStartIndex,
    desiredEndIndex,
    authoritativeHeadStartIndex: safeHead,
    authoritativeTailEndIndex: safeTail,
    cacheLines: safeCacheLines,
  });
}

function buildPatchedWindowFromCurrent(
  current: SessionBufferState | undefined,
  sparseWindow: {
    startIndex: number;
    endIndex: number;
    rowsByIndex: Map<number, TerminalCell[]>;
  },
  desiredWindow: {
    startIndex: number;
    endIndex: number;
  },
) {
  const nextStartIndex = Math.max(0, Math.floor(desiredWindow.startIndex));
  const nextEndIndex = Math.max(nextStartIndex, Math.floor(desiredWindow.endIndex));
  const nextLength = Math.max(0, nextEndIndex - nextStartIndex);
  const nextRows: Array<TerminalCell[] | undefined> = Array.from({ length: nextLength }, () => undefined);

  if (current && current.lines.length > 0) {
    for (let absoluteIndex = current.startIndex; absoluteIndex < current.endIndex; absoluteIndex += 1) {
      if (absoluteIndex < nextStartIndex || absoluteIndex >= nextEndIndex) {
        continue;
      }
      if (isGapIndex(current.gapRanges, absoluteIndex)) {
        continue;
      }
      const currentOffset = absoluteIndex - current.startIndex;
      const nextOffset = absoluteIndex - nextStartIndex;
      nextRows[nextOffset] = current.lines[currentOffset] || EMPTY_ROW;
    }
  }

  for (const [absoluteIndex, row] of sparseWindow.rowsByIndex.entries()) {
    const nextOffset = absoluteIndex - nextStartIndex;
    if (nextOffset < 0 || nextOffset >= nextRows.length) {
      continue;
    }
    nextRows[nextOffset] = row;
  }

  const gapRanges = collectGapRanges(nextRows, nextStartIndex);
  const lines = nextRows.map((row) => (row ? row : EMPTY_ROW));

  return {
    startIndex: nextStartIndex,
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
      cursor: payload.cursor ?? null,
      revision,
      cacheLines,
    });
  }

  const authoritativeHeadStartIndex = resolveAuthoritativeHeadStartIndex(current, sparseWindow, payload);
  const authoritativeTailEndIndex = resolveAuthoritativeTailEndIndex(current, sparseWindow, payload);
  const preserveCurrentWindow = Boolean(
    current
    && revision === current.revision
    && current.endIndex >= authoritativeTailEndIndex
    && sparseWindow.startIndex < current.startIndex
    && sparseWindow.endIndex <= current.endIndex
  );
  const desiredWindow = resolveDesiredLocalWindow({
    current,
    sparseWindow,
    authoritativeHeadStartIndex,
    authoritativeTailEndIndex,
    cacheLines,
    preserveCurrentWindow,
  });
  const patched = buildPatchedWindowFromCurrent(current, sparseWindow, desiredWindow);

  return buildSessionBufferState({
    lines: patched.lines,
    gapRanges: patched.gapRanges,
    startIndex: patched.startIndex,
    bufferHeadStartIndex: authoritativeHeadStartIndex,
    bufferTailEndIndex: authoritativeTailEndIndex,
    cols: payload.cols,
    rows: payload.rows,
    cursorKeysApp: payload.cursorKeysApp,
    cursor: payload.cursor ?? null,
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
    left.revision !== right.revision
    || left.updateKind !== right.updateKind
    || left.startIndex !== right.startIndex
    || left.endIndex !== right.endIndex
    || left.bufferHeadStartIndex !== right.bufferHeadStartIndex
    || left.bufferTailEndIndex !== right.bufferTailEndIndex
    || left.cols !== right.cols
    || left.rows !== right.rows
    || left.cursorKeysApp !== right.cursorKeysApp
    || left.cursor?.rowIndex !== right.cursor?.rowIndex
    || left.cursor?.col !== right.cursor?.col
    || left.cursor?.visible !== right.cursor?.visible
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
