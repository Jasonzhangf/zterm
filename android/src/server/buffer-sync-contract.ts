import {
  BufferHeadPayload,
  BufferSyncRequestPayload,
  TerminalBufferPayload,
  TerminalCell,
  type CompactIndexedLine,
  type TerminalIndexedLine,
  type WireIndexedLine,
} from '../lib/types';
import { sliceIndexedLines } from './canonical-buffer';

export interface BufferSyncMirrorSnapshot {
  revision: number;
  bufferStartIndex: number;
  bufferLines: TerminalCell[][];
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
}

export interface BufferHeadMirrorSnapshot {
  revision: number;
  bufferStartIndex: number;
  bufferLines: TerminalCell[][];
}

/** Default terminal cell values — must match TerminalCell sentinel truth across app/runtime. */
const DEFAULT_FG = 256;
const DEFAULT_BG = 256;
const DEFAULT_FLAGS = 0;

/**
 * Serialize a TerminalCell[] row into the compact wire format.
 *
 * 1. Build text by concatenating codePoints of width > 0 cells (skip continuation).
 * 2. Walk cells col-by-col; merge runs with identical (fg,bg,flags) into spans.
 * 3. If the entire row is default style, omit `s` entirely → minimal payload.
 */
function compactLine(index: number, cells: TerminalCell[]): CompactIndexedLine {
  let text = '';
  let widths: number[] | undefined;
  let spans: [number, number, number, number, number][] | undefined;
  let runStart = 0;           // span boundary in output-column space
  let runFg = DEFAULT_FG;
  let runBg = DEFAULT_BG;
  let runFlags = DEFAULT_FLAGS;
  let hasNonDefault = false;
  let hasNonUnitWidth = false;
  let col = 0;                // output column (advances only for width > 0)
  let firstTextCell = true;
  let lastGridCol = 0;        // grid column of last cell with width > 0

  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];

    // Continuation / padding cells (width <= 0): skip entirely
    if (cell.width <= 0) continue;

    lastGridCol = c;

    // --- text + width tracking ---
    text += String.fromCodePoint(cell.char);
    if (widths || cell.width !== 1) {
      if (widths === undefined) {
        widths = new Array(Math.max(0, col)).fill(1);
      }
      widths.push(cell.width);
    }
    if (cell.width !== 1) hasNonUnitWidth = true;

    // --- style run tracking ---
    // Span boundaries use grid column 'c', matching expandCompactLine lookup.
    const isDefault =
      cell.fg === DEFAULT_FG &&
      cell.bg === DEFAULT_BG &&
      cell.flags === DEFAULT_FLAGS;
    if (!isDefault) hasNonDefault = true;

    if (firstTextCell) {
      runFg = cell.fg;
      runBg = cell.bg;
      runFlags = cell.flags;
      runStart = c;
      firstTextCell = false;
    } else if (cell.fg !== runFg || cell.bg !== runBg || cell.flags !== runFlags) {
      if (spans === undefined) spans = [];
      spans.push([runStart, c, runFg, runBg, runFlags]);
      runStart = c;
      runFg = cell.fg;
      runBg = cell.bg;
      runFlags = cell.flags;
    }

    col++;
  }

  // Flush final run — end is one past the last text cell's grid column
  if (col > 0) {
    if (spans === undefined) spans = [];
    spans.push([runStart, lastGridCol + 1, runFg, runBg, runFlags]);
  }

  const result: CompactIndexedLine = { i: index, t: text };
  if (hasNonUnitWidth && widths && widths.length > 0) {
    result.w = widths;
  }
  if (hasNonDefault && spans && spans.length > 0) {
    const nonDefaultSpans = spans.filter(
      ([, , fg, bg, flags]) =>
        fg !== DEFAULT_FG || bg !== DEFAULT_BG || flags !== DEFAULT_FLAGS,
    );
    if (nonDefaultSpans.length > 0) {
      result.s = nonDefaultSpans;
    }
  }
  return result;
}

function isCompactLine(line: WireIndexedLine): line is CompactIndexedLine {
  return typeof (line as CompactIndexedLine).t === 'string';
}

/**
 * Expand a CompactIndexedLine back to TerminalCell[] for client consumption.
 * Mirror-internal code continues to use TerminalCell[][].
 */
export function expandCompactLine(
 line: CompactIndexedLine,
 cols: number,
): TerminalCell[] {
  const spanLookup = new Map<number, { fg: number; bg: number; flags: number }>();

  // Build span lookup: spans reference output-column positions
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
      fg: style?.fg ?? DEFAULT_FG,
      bg: style?.bg ?? DEFAULT_BG,
      flags: style?.flags ?? DEFAULT_FLAGS,
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
      fg: style?.fg ?? DEFAULT_FG,
      bg: style?.bg ?? DEFAULT_BG,
      flags: style?.flags ?? DEFAULT_FLAGS,
      width: w,
    };
    if (w === 2 && col + 1 < cols) {
      cells[col + 1] = {
        char: 0,
        fg: style?.fg ?? DEFAULT_FG,
        bg: style?.bg ?? DEFAULT_BG,
        flags: style?.flags ?? DEFAULT_FLAGS,
        width: 0,
      };
    }
    col += w;
  }

  return cells;
}

export { isCompactLine, compactLine };

function getMirrorAvailableEndIndex(mirror: Pick<BufferHeadMirrorSnapshot, 'bufferStartIndex' | 'bufferLines'>) {
  return mirror.bufferStartIndex + mirror.bufferLines.length;
}

export function buildBufferHeadPayload(
  sessionId: string,
  mirror: BufferHeadMirrorSnapshot,
): BufferHeadPayload {
  const availableStartIndex = Math.max(0, Math.floor(mirror.bufferStartIndex || 0));
  const availableEndIndex = Math.max(availableStartIndex, getMirrorAvailableEndIndex(mirror));
  return {
    sessionId,
    revision: Math.max(0, Math.floor(mirror.revision || 0)),
    latestEndIndex: availableEndIndex,
    availableStartIndex,
    availableEndIndex,
  };
}

function normalizeRequestedMissingRanges(
  missingRanges: BufferSyncRequestPayload['missingRanges'],
  startIndex: number,
  endIndex: number,
) {
  if (!Array.isArray(missingRanges) || endIndex <= startIndex) {
    return [] as Array<{ startIndex: number; endIndex: number }>;
  }
  return missingRanges
    .map((range) => ({
      startIndex: Math.max(startIndex, Math.min(endIndex, Math.floor(range?.startIndex || 0))),
      endIndex: Math.max(startIndex, Math.min(endIndex, Math.floor(range?.endIndex || 0))),
    }))
    .filter((range) => range.endIndex > range.startIndex);
}

function buildBufferSyncPayload(
  mirror: BufferSyncMirrorSnapshot,
  requestStartIndex: number,
  requestEndIndex: number,
  lines: TerminalIndexedLine[],
): TerminalBufferPayload {
  const availableStartIndex = Math.max(0, Math.floor(mirror.bufferStartIndex || 0));
  const availableEndIndex = Math.max(availableStartIndex, getMirrorAvailableEndIndex(mirror));
  return {
    revision: Math.max(0, Math.floor(mirror.revision || 0)),
    startIndex: Math.max(0, Math.floor(requestStartIndex || 0)),
    endIndex: Math.max(0, Math.floor(requestEndIndex || 0)),
    availableStartIndex,
    availableEndIndex,
    cols: Math.max(1, Math.floor(mirror.cols || 80)),
    rows: Math.max(1, Math.floor(mirror.rows || 24)),
    cursorKeysApp: Boolean(mirror.cursorKeysApp),
    lines: lines.map((line) => compactLine(line.index, line.cells)),
  };
}

export function buildRequestedRangeBufferPayload(
  mirror: BufferSyncMirrorSnapshot,
  request: BufferSyncRequestPayload,
): TerminalBufferPayload {
  const mirrorStartIndex = Math.max(0, Math.floor(mirror.bufferStartIndex || 0));
  const mirrorEndIndex = Math.max(mirrorStartIndex, getMirrorAvailableEndIndex(mirror));

  const requestStartIndex = Math.max(
    mirrorStartIndex,
    Math.min(
      mirrorEndIndex,
      Number.isFinite(request.requestStartIndex)
        ? Math.floor(request.requestStartIndex)
        : mirrorStartIndex,
    ),
  );
  const requestEndIndex = Math.max(
    requestStartIndex,
    Math.min(
      mirrorEndIndex,
      Number.isFinite(request.requestEndIndex)
        ? Math.floor(request.requestEndIndex)
        : requestStartIndex,
    ),
  );

  if (mirrorEndIndex <= mirrorStartIndex || requestEndIndex <= requestStartIndex) {
    return buildBufferSyncPayload(mirror, requestStartIndex, requestEndIndex, []);
  }

  const requestedMissingRanges = normalizeRequestedMissingRanges(
    request.missingRanges,
    requestStartIndex,
    requestEndIndex,
  );
  const requestedRanges = requestedMissingRanges.length > 0
    ? requestedMissingRanges
    : [{ startIndex: requestStartIndex, endIndex: requestEndIndex }];
  const indexedLines = requestedRanges.flatMap((range) => sliceIndexedLines(
    mirror.bufferStartIndex,
    mirror.bufferLines,
    range.startIndex,
    range.endIndex,
  ));

  return buildBufferSyncPayload(mirror, requestStartIndex, requestEndIndex, indexedLines);
}
