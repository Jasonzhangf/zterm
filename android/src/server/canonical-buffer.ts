import type { TerminalCell, TerminalIndexedLine } from '../lib/types';

const FLAG_REVERSE = 0x20;
const DEFAULT_COLOR = 256;

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

function isTrailingDefaultBlankCell(cell: TerminalCell | null | undefined) {
  return Boolean(
    cell
    && cell.width === 1
    && cell.char === 32
    && cell.fg === DEFAULT_COLOR
    && cell.bg === DEFAULT_COLOR
    && cell.flags === 0,
  );
}

export function trimTrailingDefaultCells(row: TerminalCell[]) {
  let end = row.length;
  while (end > 0 && isTrailingDefaultBlankCell(row[end - 1])) {
    end -= 1;
  }
  return end === row.length ? row : row.slice(0, end);
}

export function normalizeCapturedLineBlock(raw: string, expectedLineCount?: number) {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  if (typeof expectedLineCount === 'number' && Number.isFinite(expectedLineCount)) {
    const targetCount = Math.max(0, Math.floor(expectedLineCount));
    let nextLines = lines;
    if (nextLines.length > targetCount && nextLines[nextLines.length - 1] === '') {
      nextLines = nextLines.slice(0, -1);
    }
    if (nextLines.length > targetCount) {
      nextLines = nextLines.slice(0, targetCount);
    }
    while (nextLines.length < targetCount) {
      nextLines = [...nextLines, ''];
    }
    return nextLines;
  }

  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
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

type IndexedRange = { startIndex: number; endIndex: number };

export function findChangedIndexedRanges(options: {
  previousStartIndex: number;
  previousLines: TerminalCell[][];
  nextStartIndex: number;
  nextLines: TerminalCell[][];
}) {
  const nextEndIndex = options.nextStartIndex + options.nextLines.length;

  const changedRanges: IndexedRange[] = [];
  let activeRangeStart: number | null = null;

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
      if (activeRangeStart === null) {
        activeRangeStart = index;
      }
      continue;
    }

    if (activeRangeStart !== null) {
      changedRanges.push({
        startIndex: activeRangeStart,
        endIndex: index,
      });
      activeRangeStart = null;
    }
  }

  if (activeRangeStart !== null) {
    changedRanges.push({
      startIndex: activeRangeStart,
      endIndex: nextEndIndex,
    });
  }

  return changedRanges;
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
