import type {
  SessionBufferState,
  TerminalBufferPayload,
  TerminalCell,
  TerminalIndexedLine,
} from './types';

function cloneCell(cell: TerminalCell): TerminalCell {
  return { ...cell };
}

function cloneRow(row: TerminalCell[]): TerminalCell[] {
  return row.map(cloneCell);
}

function cloneRows(rows: TerminalCell[][]): TerminalCell[][] {
  return rows.map(cloneRow);
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
      return cloneRow(line);
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
      cells: cloneRow(line.cells || []),
    }))
    .sort((left, right) => left.index - right.index);
}

function trimToCacheWindow(startIndex: number, endIndex: number, cacheLines: number) {
  const normalizedEnd = Math.max(startIndex, endIndex);
  const normalizedStart = Math.max(0, startIndex);
  if (normalizedEnd - normalizedStart <= cacheLines) {
    return {
      startIndex: normalizedStart,
      endIndex: normalizedEnd,
    };
  }

  return {
    startIndex: Math.max(normalizedStart, normalizedEnd - cacheLines),
    endIndex: normalizedEnd,
  };
}

function mapToContiguousRange(linesByIndex: Map<number, TerminalCell[]>, startIndex: number, endIndex: number) {
  const normalizedStart = Math.max(0, startIndex);
  const normalizedEnd = Math.max(normalizedStart, endIndex);

  if (normalizedEnd <= normalizedStart) {
    return {
      startIndex: normalizedStart,
      endIndex: normalizedStart,
      lines: [] as TerminalCell[][],
    };
  }

  const lines: TerminalCell[][] = [];
  let cursor = normalizedEnd - 1;
  while (cursor >= normalizedStart && linesByIndex.has(cursor)) {
    lines.unshift(cloneRow(linesByIndex.get(cursor)!));
    cursor -= 1;
  }

  const contiguousStart = normalizedEnd - lines.length;
  return {
    startIndex: contiguousStart,
    endIndex: normalizedEnd,
    lines,
  };
}

function bufferToMap(current?: SessionBufferState) {
  const map = new Map<number, TerminalCell[]>();
  if (!current) {
    return map;
  }

  current.lines.forEach((line, offset) => {
    map.set(current.startIndex + offset, cloneRow(line));
  });
  return map;
}

function mergeBufferPayload(
  current: SessionBufferState | undefined,
  payload: TerminalBufferPayload,
  cacheLines: number,
  updateKind: SessionBufferState['updateKind'],
): SessionBufferState {
  const normalizedLines = normalizeIndexedLines(payload.lines || []);
  const targetRange = trimToCacheWindow(
    Number.isFinite(payload.startIndex) ? Math.max(0, Math.floor(payload.startIndex)) : 0,
    Number.isFinite(payload.endIndex) ? Math.max(0, Math.floor(payload.endIndex)) : 0,
    cacheLines,
  );

  const linesByIndex = bufferToMap(current);
  for (const line of normalizedLines) {
    linesByIndex.set(line.index, line.cells);
  }

  for (const index of [...linesByIndex.keys()]) {
    if (index < targetRange.startIndex || index >= targetRange.endIndex) {
      linesByIndex.delete(index);
    }
  }

  const contiguous = mapToContiguousRange(linesByIndex, targetRange.startIndex, targetRange.endIndex);
  const finalRange = trimToCacheWindow(contiguous.startIndex, contiguous.endIndex, cacheLines);
  const finalLines =
    contiguous.startIndex === finalRange.startIndex && contiguous.endIndex === finalRange.endIndex
      ? contiguous.lines
      : contiguous.lines.slice(Math.max(0, finalRange.startIndex - contiguous.startIndex));

  return {
    lines: cloneRows(finalLines),
    startIndex: finalRange.startIndex,
    endIndex: finalRange.startIndex + finalLines.length,
    cols: Number.isFinite(payload.cols) ? Math.max(1, Math.floor(payload.cols)) : current?.cols || 80,
    rows: Number.isFinite(payload.rows) ? Math.max(1, Math.floor(payload.rows)) : current?.rows || 24,
    cursorRow: Number.isFinite(payload.cursorRow) ? Math.max(0, Math.floor(payload.cursorRow)) : current?.cursorRow || 0,
    cursorCol: Number.isFinite(payload.cursorCol) ? Math.max(0, Math.floor(payload.cursorCol)) : current?.cursorCol || 0,
    cursorVisible: Boolean(payload.cursorVisible),
    cursorKeysApp: Boolean(payload.cursorKeysApp),
    updateKind,
    revision: (current?.revision || 0) + 1,
  };
}

export function createSessionBufferState(options: {
  lines?: Array<TerminalCell[] | string>;
  startIndex?: number;
  endIndex?: number;
  cols?: number;
  rows?: number;
  cursorRow?: number;
  cursorCol?: number;
  cursorVisible?: boolean;
  cursorKeysApp?: boolean;
  updateKind?: SessionBufferState['updateKind'];
  revision?: number;
  cacheLines: number;
}): SessionBufferState {
  const lines = normalizeBufferLines(options.lines || [], options.cacheLines);
  const startIndex = Number.isFinite(options.startIndex) ? Math.max(0, Math.floor(options.startIndex!)) : 0;
  const endIndex =
    Number.isFinite(options.endIndex) && Math.floor(options.endIndex!) >= startIndex
      ? Math.floor(options.endIndex!)
      : startIndex + lines.length;
  const trimmed = trimToCacheWindow(startIndex, endIndex, options.cacheLines);
  const sliceOffset = Math.max(0, trimmed.startIndex - startIndex);
  const trimmedLines = cloneRows(lines.slice(sliceOffset, sliceOffset + (trimmed.endIndex - trimmed.startIndex)));

  return {
    lines: trimmedLines,
    startIndex: trimmed.startIndex,
    endIndex: trimmed.startIndex + trimmedLines.length,
    cols: Math.max(1, Math.floor(options.cols || 80)),
    rows: Math.max(1, Math.floor(options.rows || 24)),
    cursorRow: Math.max(0, Math.floor(options.cursorRow ?? Math.max(trimmed.startIndex, trimmed.endIndex - 1))),
    cursorCol: Math.max(0, Math.floor(options.cursorCol || 0)),
    cursorVisible: Boolean(options.cursorVisible),
    cursorKeysApp: Boolean(options.cursorKeysApp),
    updateKind: options.updateKind || 'replace',
    revision: options.revision ?? 0,
  };
}

export function applyBufferSyncToSessionBuffer(
  current: SessionBufferState | undefined,
  payload: TerminalBufferPayload,
  cacheLines: number,
) {
  return mergeBufferPayload(current, payload, cacheLines, 'replace');
}

export function applyBufferDeltaToSessionBuffer(
  current: SessionBufferState,
  payload: TerminalBufferPayload,
  cacheLines: number,
) {
  return mergeBufferPayload(current, payload, cacheLines, 'delta');
}

export function applyBufferRangeToSessionBuffer(
  current: SessionBufferState,
  payload: TerminalBufferPayload,
  cacheLines: number,
) {
  return mergeBufferPayload(current, payload, cacheLines, 'range');
}

export function replaceSessionBufferLines(
  current: SessionBufferState | undefined,
  lines: Array<TerminalCell[] | string>,
  cacheLines: number,
): SessionBufferState {
  return createSessionBufferState({
    lines,
    startIndex: current?.startIndex,
    endIndex: current?.startIndex !== undefined ? current.startIndex + lines.length : undefined,
    cols: current?.cols,
    rows: current?.rows,
    cursorRow: current?.cursorRow,
    cursorCol: current?.cursorCol,
    cursorVisible: current?.cursorVisible,
    cursorKeysApp: current?.cursorKeysApp,
    cacheLines,
  });
}

export function sessionBufferToHistory(buffer: SessionBufferState, cacheLines: number) {
  if (buffer.lines.length <= cacheLines) {
    return buffer.lines.map(cellsToLine).join('\n');
  }
  return buffer.lines.slice(-cacheLines).map(cellsToLine).join('\n');
}
