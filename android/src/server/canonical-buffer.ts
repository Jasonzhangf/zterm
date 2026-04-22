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
      lines: cloneRows(bufferLines),
    };
  }

  const trimCount = bufferLines.length - safeMaxLines;
  return {
    startIndex: bufferStartIndex + trimCount,
    lines: cloneRows(bufferLines.slice(trimCount)),
  };
}

export function toIndexedLines(startIndex: number, lines: TerminalCell[][]): TerminalIndexedLine[] {
  return lines.map((cells, offset) => ({
    index: startIndex + offset,
    cells: cloneRow(cells),
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
