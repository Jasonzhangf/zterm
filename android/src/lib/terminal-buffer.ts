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

function trimToCache(startIndex: number, lines: TerminalCell[][], cacheLines: number) {
  const safeStartIndex = Math.max(0, Math.floor(startIndex));
  const safeCacheLines = Math.max(1, Math.floor(cacheLines || 1));
  if (lines.length <= safeCacheLines) {
    return {
      startIndex: safeStartIndex,
      lines: cloneRows(lines),
    };
  }

  const trimCount = lines.length - safeCacheLines;
  return {
    startIndex: safeStartIndex + trimCount,
    lines: cloneRows(lines.slice(trimCount)),
  };
}

function buildSessionBufferState(options: {
  lines: TerminalCell[][];
  startIndex: number;
  viewportEndIndex: number;
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  revision: number;
  cacheLines: number;
}): SessionBufferState {
  const trimmed = trimToCache(options.startIndex, options.lines, options.cacheLines);
  const endIndex = trimmed.startIndex + trimmed.lines.length;

  return {
    lines: trimmed.lines,
    startIndex: trimmed.startIndex,
    endIndex,
    viewportEndIndex: Math.max(trimmed.startIndex, Math.floor(options.viewportEndIndex)),
    cols: Math.max(1, Math.floor(options.cols || 80)),
    rows: Math.max(1, Math.floor(options.rows || 24)),
    cursorKeysApp: Boolean(options.cursorKeysApp),
    updateKind: 'replace',
    revision: Math.max(0, Math.floor(options.revision || 0)),
  };
}

export function createSessionBufferState(options: {
  lines?: Array<TerminalCell[] | string>;
  startIndex?: number;
  endIndex?: number;
  viewportEndIndex?: number;
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
    startIndex: effectiveStartIndex,
    viewportEndIndex: Number.isFinite(options.viewportEndIndex) ? Math.floor(options.viewportEndIndex!) : requestedEndIndex,
    cols: options.cols || 80,
    rows: options.rows || 24,
    cursorKeysApp: Boolean(options.cursorKeysApp),
    revision: options.revision ?? 0,
    cacheLines: options.cacheLines,
  });
}

function payloadToContiguousRows(payload: TerminalBufferPayload) {
  const normalizedLines = normalizeIndexedLines(payload.lines || []);
  if (normalizedLines.length === 0) {
    return {
      ok: true as const,
      startIndex: Math.max(0, Math.floor(payload.startIndex || 0)),
      lines: [] as TerminalCell[][],
    };
  }

  const expectedStartIndex = Math.max(0, Math.floor(payload.startIndex || 0));
  const expectedEndIndex = Math.max(expectedStartIndex, Math.floor(payload.endIndex || expectedStartIndex));
  const firstIndex = normalizedLines[0]!.index;
  const lastIndex = normalizedLines[normalizedLines.length - 1]!.index + 1;

  if (firstIndex !== expectedStartIndex || lastIndex !== expectedEndIndex) {
    return {
      ok: false as const,
      reason: `buffer-sync lines do not match payload window: expected ${expectedStartIndex}-${expectedEndIndex}, got ${firstIndex}-${lastIndex}`,
    };
  }

  for (let index = 1; index < normalizedLines.length; index += 1) {
    if (normalizedLines[index]!.index !== normalizedLines[index - 1]!.index + 1) {
      return {
        ok: false as const,
        reason: `buffer-sync lines are not contiguous around ${normalizedLines[index - 1]!.index}-${normalizedLines[index]!.index}`,
      };
    }
  }

  return {
    ok: true as const,
    startIndex: expectedStartIndex,
    lines: normalizedLines.map((line) => cloneRow(line.cells)),
  };
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

  const contiguous = payloadToContiguousRows(payload);
  if (!contiguous.ok) {
    console.error(`[terminal-buffer] rejected malformed buffer-sync: ${contiguous.reason}`);
    return current || createSessionBufferState({
      lines: [],
      startIndex: 0,
      endIndex: 0,
      viewportEndIndex: 0,
      cols: payload.cols,
      rows: payload.rows,
      cursorKeysApp: payload.cursorKeysApp,
      revision,
      cacheLines,
    });
  }

  return buildSessionBufferState({
    lines: contiguous.lines,
    startIndex: contiguous.startIndex,
    viewportEndIndex: Number.isFinite(payload.viewportEndIndex) ? Math.floor(payload.viewportEndIndex) : contiguous.startIndex + contiguous.lines.length,
    cols: payload.cols,
    rows: payload.rows,
    cursorKeysApp: payload.cursorKeysApp,
    revision,
    cacheLines,
  });
}

export function sessionBufferToHistory(buffer: SessionBufferState, cacheLines: number) {
  if (buffer.lines.length <= cacheLines) {
    return buffer.lines.map(cellsToLine).join('\n');
  }
  return buffer.lines.slice(-cacheLines).map(cellsToLine).join('\n');
}

export function sessionBuffersEqual(left: SessionBufferState, right: SessionBufferState) {
  if (
    left.startIndex !== right.startIndex
    || left.endIndex !== right.endIndex
    || left.viewportEndIndex !== right.viewportEndIndex
    || left.cols !== right.cols
    || left.rows !== right.rows
    || left.cursorKeysApp !== right.cursorKeysApp
    || left.lines.length !== right.lines.length
  ) {
    return false;
  }

  for (let index = 0; index < left.lines.length; index += 1) {
    if (!rowsEqual(left.lines[index], right.lines[index])) {
      return false;
    }
  }

  return true;
}
