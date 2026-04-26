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

/** Default terminal cell values — rows using only these need no style spans. */
const DEFAULT_FG = 15;
const DEFAULT_BG = 0;
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
  let spans: [number, number, number, number][] | undefined;
  let runStart = 0;
  let runFg = DEFAULT_FG;
  let runBg = DEFAULT_BG;
  let runFlags = DEFAULT_FLAGS;
  let col = 0;
  let hasNonDefault = false;

  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    if (cell.width > 0) {
      text += String.fromCodePoint(cell.char);
    }

    // Check if this cell starts a new style run
    const isDefault = cell.fg === DEFAULT_FG && cell.bg === DEFAULT_BG && cell.flags === DEFAULT_FLAGS;
    if (!isDefault) {
      hasNonDefault = true;
    }

    if (c === 0) {
      runFg = cell.fg;
      runBg = cell.bg;
      runFlags = cell.flags;
      runStart = 0;
    } else if (cell.fg !== runFg || cell.bg !== runBg || cell.flags !== runFlags) {
      // Flush previous run
      if (spans === undefined) spans = [];
      spans.push([runStart, col, runFg, runBg]);
      runStart = col;
      runFg = cell.fg;
      runBg = cell.bg;
      runFlags = cell.flags;
    }

    if (cell.width > 0) {
      col++;
    }
  }

  // Flush final run
  if (cells.length > 0) {
    if (spans === undefined) spans = [];
    spans.push([runStart, col, runFg, runBg]);
  }

  const result: CompactIndexedLine = { i: index, t: text };

  // Only attach spans if there is at least one non-default cell
  if (hasNonDefault && spans && spans.length > 0) {
    // Filter out default-only spans to keep the array minimal
    const nonDefaultSpans = spans.filter(
      ([, , fg, bg]) => fg !== DEFAULT_FG || bg !== DEFAULT_BG,
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
  const cells: TerminalCell[] = new Array(cols);
  const spanLookup = new Map<string, { fg: number; bg: number }>();

  // Build span lookup from sparse style array
  if (line.s) {
    for (const [start, end, fg, bg] of line.s) {
      for (let c = start; c < end; c++) {
        spanLookup.set(`${c}`, { fg, bg });
      }
    }
  }

  let col = 0;
  const codePoints = [...line.t];
  for (let c = 0; c < cols; c++) {
    const style = spanLookup.get(`${c}`);
    const fg = style?.fg ?? DEFAULT_FG;
    const bg = style?.bg ?? DEFAULT_BG;

    if (col < codePoints.length) {
      const cp = codePoints[col].codePointAt(0)!;
      cells[c] = { char: cp, fg, bg, flags: 0, width: 1 };
      col++;
    } else {
      // Pad remaining cols with default space
      cells[c] = { char: 32, fg: DEFAULT_FG, bg: DEFAULT_BG, flags: 0, width: 1 };
    }
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
