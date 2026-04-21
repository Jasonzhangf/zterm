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

function trimRangeToCache(startIndex: number, endIndex: number, cacheLines: number) {
  const normalizedStart = Math.max(0, Math.floor(startIndex));
  const normalizedEnd = Math.max(normalizedStart, Math.floor(endIndex));
  if (normalizedEnd - normalizedStart <= cacheLines) {
    return {
      startIndex: normalizedStart,
      endIndex: normalizedEnd,
    };
  }

  return {
    startIndex: Math.max(0, normalizedEnd - cacheLines),
    endIndex: normalizedEnd,
  };
}

function buildRangeMap(buffer?: SessionBufferState) {
  const map = new Map<number, TerminalCell[]>();
  if (!buffer) {
    return map;
  }

  buffer.lines.forEach((line, offset) => {
    map.set(buffer.startIndex + offset, cloneRow(line));
  });

  return map;
}

function isAdjacentOrOverlapping(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) {
  return rightStart <= leftEnd && rightEnd >= leftStart;
}

function collectContiguousWindow(linesByIndex: Map<number, TerminalCell[]>, startIndex: number, endIndex: number) {
  const normalizedStart = Math.max(0, startIndex);
  const normalizedEnd = Math.max(normalizedStart, endIndex);
  const lines: TerminalCell[][] = [];

  for (let index = normalizedStart; index < normalizedEnd; index += 1) {
    const row = linesByIndex.get(index);
    if (!row) {
      return null;
    }
    lines.push(cloneRow(row));
  }

  return {
    startIndex: normalizedStart,
    endIndex: normalizedEnd,
    lines,
  };
}

function contiguousIncomingWindow(lines: TerminalIndexedLine[]) {
  if (lines.length === 0) {
    return null;
  }

  const ordered = normalizeIndexedLines(lines);
  if (ordered.length === 0) {
    return null;
  }

  const startIndex = ordered[0].index;
  const endIndex = ordered[ordered.length - 1].index + 1;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].index !== ordered[index - 1].index + 1) {
      return null;
    }
  }

  return {
    startIndex,
    endIndex,
    lines: ordered.map((line) => cloneRow(line.cells)),
  };
}

function normalizeAvailableIndices(payload: TerminalBufferPayload) {
  const availableStartIndex = Number.isFinite(payload.startIndex)
    ? Math.max(0, Math.floor(payload.startIndex))
    : 0;
  const availableEndIndex = Number.isFinite(payload.endIndex)
    ? Math.max(availableStartIndex, Math.floor(payload.endIndex))
    : availableStartIndex;
  const viewportStartIndex = Number.isFinite(payload.viewportStartIndex)
    ? Math.max(availableStartIndex, Math.floor(payload.viewportStartIndex))
    : Math.max(availableStartIndex, availableEndIndex - Math.max(1, Math.floor(payload.rows || 24)));
  const viewportEndIndex = Number.isFinite(payload.viewportEndIndex)
    ? Math.max(viewportStartIndex, Math.floor(payload.viewportEndIndex))
    : Math.max(viewportStartIndex, viewportStartIndex + Math.max(1, Math.floor(payload.rows || 24)));

  return {
    availableStartIndex,
    availableEndIndex,
    viewportStartIndex,
    viewportEndIndex,
  };
}

function withMetadata(
  current: SessionBufferState | undefined,
  options: {
    lines: TerminalCell[][];
    startIndex: number;
    endIndex: number;
    payload: TerminalBufferPayload;
    updateKind: SessionBufferState['updateKind'];
  },
): SessionBufferState {
  const indices = normalizeAvailableIndices(options.payload);
  return {
    lines: cloneRows(options.lines),
    startIndex: options.startIndex,
    endIndex: options.endIndex,
    availableStartIndex: indices.availableStartIndex,
    availableEndIndex: indices.availableEndIndex,
    viewportStartIndex: indices.viewportStartIndex,
    viewportEndIndex: indices.viewportEndIndex,
    cols: Number.isFinite(options.payload.cols) ? Math.max(1, Math.floor(options.payload.cols)) : current?.cols || 80,
    rows: Number.isFinite(options.payload.rows) ? Math.max(1, Math.floor(options.payload.rows)) : current?.rows || 24,
    cursorRow: Number.isFinite(options.payload.cursorRow) ? Math.max(0, Math.floor(options.payload.cursorRow)) : current?.cursorRow || 0,
    cursorCol: Number.isFinite(options.payload.cursorCol) ? Math.max(0, Math.floor(options.payload.cursorCol)) : current?.cursorCol || 0,
    cursorVisible: Boolean(options.payload.cursorVisible),
    cursorKeysApp: Boolean(options.payload.cursorKeysApp),
    updateKind: options.updateKind,
    revision: (current?.revision || 0) + 1,
  };
}

function mergeBufferPayload(
  current: SessionBufferState | undefined,
  payload: TerminalBufferPayload,
  cacheLines: number,
  updateKind: SessionBufferState['updateKind'],
): SessionBufferState {
  const normalizedIncoming = normalizeIndexedLines(payload.lines || []);
  const contiguousIncoming = contiguousIncomingWindow(normalizedIncoming);
  const indices = normalizeAvailableIndices(payload);

  if (!current || current.lines.length === 0) {
    const initialLines = contiguousIncoming?.lines || [];
    const initialStart = contiguousIncoming?.startIndex ?? indices.viewportStartIndex;
    const initialEnd = contiguousIncoming?.endIndex ?? initialStart;
    const trimmed = trimRangeToCache(initialStart, initialEnd, cacheLines);
    const sliceOffset = Math.max(0, trimmed.startIndex - initialStart);
    const nextLines = initialLines.slice(sliceOffset, sliceOffset + (trimmed.endIndex - trimmed.startIndex));
    return withMetadata(current, {
      lines: nextLines,
      startIndex: trimmed.startIndex,
      endIndex: trimmed.startIndex + nextLines.length,
      payload,
      updateKind,
    });
  }

  if (normalizedIncoming.length === 0) {
    return withMetadata(current, {
      lines: current.lines,
      startIndex: current.startIndex,
      endIndex: current.endIndex,
      payload,
      updateKind,
    });
  }

  const linesByIndex = buildRangeMap(current);
  normalizedIncoming.forEach((line) => {
    linesByIndex.set(line.index, cloneRow(line.cells));
  });

  const incomingStart = normalizedIncoming[0].index;
  const incomingEnd = normalizedIncoming[normalizedIncoming.length - 1].index + 1;

  let nextStart = current.startIndex;
  let nextEnd = current.endIndex;

  if (isAdjacentOrOverlapping(current.startIndex, current.endIndex, incomingStart, incomingEnd)) {
    nextStart = Math.min(current.startIndex, incomingStart);
    nextEnd = Math.max(current.endIndex, incomingEnd);
  } else if (updateKind === 'replace' && contiguousIncoming) {
    nextStart = contiguousIncoming.startIndex;
    nextEnd = contiguousIncoming.endIndex;
    linesByIndex.clear();
    contiguousIncoming.lines.forEach((line, offset) => {
      linesByIndex.set(contiguousIncoming.startIndex + offset, cloneRow(line));
    });
  }

  let collected = collectContiguousWindow(linesByIndex, nextStart, nextEnd);
  if (!collected) {
    const fallback = collectContiguousWindow(linesByIndex, current.startIndex, current.endIndex);
    if (fallback) {
      collected = fallback;
    } else if (contiguousIncoming) {
      collected = contiguousIncoming;
    } else {
      collected = {
        startIndex: current.startIndex,
        endIndex: current.endIndex,
        lines: cloneRows(current.lines),
      };
    }
  }

  const trimmed = trimRangeToCache(collected.startIndex, collected.endIndex, cacheLines);
  const sliceOffset = Math.max(0, trimmed.startIndex - collected.startIndex);
  const nextLines = collected.lines.slice(sliceOffset, sliceOffset + (trimmed.endIndex - trimmed.startIndex));

  return withMetadata(current, {
    lines: nextLines,
    startIndex: trimmed.startIndex,
    endIndex: trimmed.startIndex + nextLines.length,
    payload,
    updateKind,
  });
}

export function createSessionBufferState(options: {
  lines?: Array<TerminalCell[] | string>;
  startIndex?: number;
  endIndex?: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  viewportStartIndex?: number;
  viewportEndIndex?: number;
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
  const requestedEndIndex =
    Number.isFinite(options.endIndex) && Math.floor(options.endIndex!) >= startIndex
      ? Math.floor(options.endIndex!)
      : startIndex + lines.length;
  const trimmed = trimRangeToCache(startIndex, requestedEndIndex, options.cacheLines);
  const sliceOffset = Math.max(0, trimmed.startIndex - startIndex);
  const trimmedLines = cloneRows(lines.slice(sliceOffset, sliceOffset + (trimmed.endIndex - trimmed.startIndex)));
  const endIndex = trimmed.startIndex + trimmedLines.length;
  const availableStartIndex = Number.isFinite(options.availableStartIndex)
    ? Math.max(0, Math.floor(options.availableStartIndex!))
    : trimmed.startIndex;
  const availableEndIndex = Number.isFinite(options.availableEndIndex)
    ? Math.max(availableStartIndex, Math.floor(options.availableEndIndex!))
    : endIndex;
  const rows = Math.max(1, Math.floor(options.rows || 24));
  const viewportEndIndex = Number.isFinite(options.viewportEndIndex)
    ? Math.max(0, Math.floor(options.viewportEndIndex!))
    : endIndex;
  const viewportStartIndex = Number.isFinite(options.viewportStartIndex)
    ? Math.max(0, Math.floor(options.viewportStartIndex!))
    : Math.max(trimmed.startIndex, viewportEndIndex - rows);

  return {
    lines: trimmedLines,
    startIndex: trimmed.startIndex,
    endIndex,
    availableStartIndex,
    availableEndIndex,
    viewportStartIndex,
    viewportEndIndex: Math.max(viewportStartIndex, viewportEndIndex),
    cols: Math.max(1, Math.floor(options.cols || 80)),
    rows,
    cursorRow: Math.max(0, Math.floor(options.cursorRow ?? Math.max(viewportStartIndex, endIndex - 1))),
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
    availableStartIndex: current?.availableStartIndex,
    availableEndIndex: current?.availableEndIndex,
    viewportStartIndex: current?.viewportStartIndex,
    viewportEndIndex: current?.viewportEndIndex,
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

export function sessionBuffersEqual(left: SessionBufferState, right: SessionBufferState) {
  if (
    left.startIndex !== right.startIndex
    || left.endIndex !== right.endIndex
    || left.availableStartIndex !== right.availableStartIndex
    || left.availableEndIndex !== right.availableEndIndex
    || left.viewportStartIndex !== right.viewportStartIndex
    || left.viewportEndIndex !== right.viewportEndIndex
    || left.cols !== right.cols
    || left.rows !== right.rows
    || left.cursorRow !== right.cursorRow
    || left.cursorCol !== right.cursorCol
    || left.cursorVisible !== right.cursorVisible
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
