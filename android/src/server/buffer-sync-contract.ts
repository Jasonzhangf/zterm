import type {
  BufferHeadPayload,
  BufferSyncRequestPayload,
  TerminalBufferPayload,
  TerminalCell,
  TerminalIndexedLine,
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
    lines: lines.map((line) => ({ index: line.index, cells: line.cells })),
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
