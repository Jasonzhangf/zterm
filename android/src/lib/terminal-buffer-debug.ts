import { cellsToLine } from './terminal-buffer';
import type {
  SessionBufferState,
  SessionRenderBufferSnapshot,
  TerminalCell,
  TerminalCursorState,
  TerminalGapRange,
  TerminalIndexedLine,
  WireIndexedLine,
} from './types';
import { normalizeWireLines } from './terminal-buffer';

function summarizeCursor(cursor: TerminalCursorState | null | undefined) {
  if (!cursor) {
    return null;
  }
  return {
    rowIndex: cursor.rowIndex,
    col: cursor.col,
    visible: cursor.visible,
  };
}

function summarizeGapRanges(gapRanges: TerminalGapRange[] | null | undefined) {
  if (!Array.isArray(gapRanges) || gapRanges.length === 0) {
    return [];
  }
  const first = gapRanges[0];
  const last = gapRanges[gapRanges.length - 1];
  return gapRanges.length <= 4
    ? gapRanges.map((range) => ({ startIndex: range.startIndex, endIndex: range.endIndex }))
    : [
        { startIndex: first?.startIndex ?? 0, endIndex: first?.endIndex ?? 0 },
        { startIndex: last?.startIndex ?? 0, endIndex: last?.endIndex ?? 0 },
        { omitted: gapRanges.length - 2 } as unknown as { startIndex: number; endIndex: number },
      ];
}

function summarizeTextWindow(lines: TerminalCell[][], startIndex: number) {
  const materialized = lines.map((row, offset) => ({
    index: startIndex + offset,
    text: cellsToLine(row),
  }));
  if (materialized.length <= 6) {
    return materialized;
  }
  return [
    ...materialized.slice(0, 3),
    { index: -1, text: `… ${materialized.length - 6} omitted …` },
    ...materialized.slice(-3),
  ];
}

export function summarizeSessionBufferForDebug(buffer: SessionBufferState) {
  return {
    revision: buffer.revision,
    updateKind: buffer.updateKind,
    startIndex: buffer.startIndex,
    endIndex: buffer.endIndex,
    bufferHeadStartIndex: buffer.bufferHeadStartIndex,
    bufferTailEndIndex: buffer.bufferTailEndIndex,
    cols: buffer.cols,
    rows: buffer.rows,
    gapRanges: summarizeGapRanges(buffer.gapRanges),
    cursor: summarizeCursor(buffer.cursor),
    lines: summarizeTextWindow(buffer.lines, buffer.startIndex),
  };
}

export function summarizeRenderBufferForDebug(buffer: SessionRenderBufferSnapshot) {
  return {
    revision: buffer.revision,
    startIndex: buffer.startIndex,
    endIndex: buffer.endIndex,
    bufferHeadStartIndex: buffer.bufferHeadStartIndex,
    bufferTailEndIndex: buffer.bufferTailEndIndex,
    daemonHeadRevision: buffer.daemonHeadRevision,
    daemonHeadEndIndex: buffer.daemonHeadEndIndex,
    cols: buffer.cols,
    rows: buffer.rows,
    gapRanges: summarizeGapRanges(buffer.gapRanges),
    cursor: summarizeCursor(buffer.cursor),
    lines: summarizeTextWindow(buffer.lines, buffer.startIndex),
  };
}

export function summarizeWireIndexedLinesForDebug(lines: WireIndexedLine[] | TerminalIndexedLine[], cols: number) {
  const normalized = normalizeWireLines(lines as WireIndexedLine[], cols);
  return summarizeIndexedLinesForDebug(normalized);
}

export function summarizeIndexedLinesForDebug(lines: TerminalIndexedLine[]) {
  const materialized = lines.map((line) => ({
    index: line.index,
    text: cellsToLine(line.cells),
  }));
  if (materialized.length <= 6) {
    return materialized;
  }
  return [
    ...materialized.slice(0, 3),
    { index: -1, text: `… ${materialized.length - 6} omitted …` },
    ...materialized.slice(-3),
  ];
}
