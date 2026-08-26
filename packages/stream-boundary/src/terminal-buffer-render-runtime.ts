export interface TerminalRenderCell {
  readonly char: number;
  readonly fg: number;
  readonly bg: number;
  readonly flags: number;
  readonly width: number;
}

export interface TerminalBufferFrameChunk {
  readonly revision: number;
  readonly frameStartIndex: number;
  readonly frameEndIndex: number;
  readonly frameChunkIndex: number;
  readonly frameChunkCount: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly generatedAt: number;
  readonly cols: number;
  readonly rows: number;
  readonly cursor: { readonly rowIndex: number; readonly col: number; readonly visible: boolean } | null;
  readonly lines: readonly {
    readonly index: number;
    readonly cells: readonly TerminalRenderCell[];
  }[];
}

export interface TerminalBufferGapRange {
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface TerminalBufferSnapshot {
  readonly revision: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly cols: number;
  readonly rows: number;
  readonly cursor: TerminalBufferFrameChunk['cursor'];
  readonly lines: readonly (readonly TerminalRenderCell[] | null)[];
  readonly gapRanges: readonly TerminalBufferGapRange[];
}

export interface TerminalRenderWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly lines: readonly (readonly TerminalRenderCell[] | null)[];
  readonly gapRanges: readonly TerminalBufferGapRange[];
}

export type TerminalBufferApplyResult =
  | { readonly kind: 'pending'; readonly repairRange: null }
  | { readonly kind: 'committed'; readonly snapshot: TerminalBufferSnapshot; readonly repairRange: null }
  | {
      readonly kind: 'rejected';
      readonly error: 'invalid-frame' | 'invalid-lines' | 'stale-frame' | 'interleaved-frame' | 'conflicting-frame';
      readonly repairRange: TerminalBufferGapRange | null;
    };

interface PendingFrame {
  readonly revision: number;
  readonly frameStartIndex: number;
  readonly frameEndIndex: number;
  readonly frameChunkCount: number;
  readonly generatedAt: number;
  readonly cols: number;
  readonly rows: number;
  readonly chunks: Map<number, TerminalBufferFrameChunk>;
}

const isInteger = (value: number) => Number.isSafeInteger(value);

function cloneCells(cells: readonly TerminalRenderCell[]): readonly TerminalRenderCell[] {
  return cells.map((cell) => ({ ...cell }));
}

function cellsEqual(left: readonly TerminalRenderCell[], right: readonly TerminalRenderCell[]) {
  return left.length === right.length && left.every((cell, index) => {
    const other = right[index];
    return Boolean(other)
      && cell.char === other.char
      && cell.fg === other.fg
      && cell.bg === other.bg
      && cell.flags === other.flags
      && cell.width === other.width;
  });
}

function metadataEqual(left: TerminalBufferFrameChunk, right: TerminalBufferFrameChunk) {
  return left.revision === right.revision
    && left.frameStartIndex === right.frameStartIndex
    && left.frameEndIndex === right.frameEndIndex
    && left.frameChunkCount === right.frameChunkCount
    && left.generatedAt === right.generatedAt
    && left.cols === right.cols
    && left.rows === right.rows;
}

function chunksEqual(left: TerminalBufferFrameChunk, right: TerminalBufferFrameChunk) {
  return metadataEqual(left, right)
    && left.startIndex === right.startIndex
    && left.endIndex === right.endIndex
    && left.lines.length === right.lines.length
    && left.lines.every((line, index) => {
      const other = right.lines[index];
      return Boolean(other) && line.index === other.index && cellsEqual(line.cells, other.cells);
    });
}

function rangeOf(frame: Pick<TerminalBufferFrameChunk, 'frameStartIndex' | 'frameEndIndex'>) {
  return { startIndex: frame.frameStartIndex, endIndex: frame.frameEndIndex };
}

function validFrameRange(chunk: TerminalBufferFrameChunk): TerminalBufferGapRange | null {
  return isInteger(chunk.frameStartIndex)
    && isInteger(chunk.frameEndIndex)
    && chunk.frameStartIndex >= 0
    && chunk.frameEndIndex > chunk.frameStartIndex
    ? rangeOf(chunk)
    : null;
}

function validChunk(chunk: TerminalBufferFrameChunk): boolean {
  return isInteger(chunk.revision)
    && chunk.revision > 0
    && isInteger(chunk.frameStartIndex)
    && chunk.frameStartIndex >= 0
    && isInteger(chunk.frameEndIndex)
    && chunk.frameEndIndex > chunk.frameStartIndex
    && isInteger(chunk.frameChunkCount)
    && chunk.frameChunkCount > 0
    && isInteger(chunk.frameChunkIndex)
    && chunk.frameChunkIndex >= 0
    && chunk.frameChunkIndex < chunk.frameChunkCount
    && isInteger(chunk.startIndex)
    && chunk.startIndex >= chunk.frameStartIndex
    && isInteger(chunk.endIndex)
    && chunk.endIndex > chunk.startIndex
    && chunk.endIndex <= chunk.frameEndIndex
    && isInteger(chunk.generatedAt)
    && chunk.generatedAt > 0
    && isInteger(chunk.cols)
    && chunk.cols > 0
    && isInteger(chunk.rows)
    && chunk.rows > 0
    && chunk.lines.length === chunk.endIndex - chunk.startIndex
    && chunk.lines.every((line, offset) => line.index === chunk.startIndex + offset);
}

function gapsFor(
  startIndex: number,
  lines: readonly (readonly TerminalRenderCell[] | null)[],
): readonly TerminalBufferGapRange[] {
  const gaps: TerminalBufferGapRange[] = [];
  let gapStart: number | null = null;
  lines.forEach((line, offset) => {
    if (line === null && gapStart === null) {
      gapStart = startIndex + offset;
    }
    if (line !== null && gapStart !== null) {
      gaps.push({ startIndex: gapStart, endIndex: startIndex + offset });
      gapStart = null;
    }
  });
  if (gapStart !== null) {
    gaps.push({ startIndex: gapStart, endIndex: startIndex + lines.length });
  }
  return gaps;
}

export interface TerminalBufferRenderRuntime {
  applyFrameChunk(chunk: TerminalBufferFrameChunk): TerminalBufferApplyResult;
  getSnapshot(): TerminalBufferSnapshot;
  projectRenderWindow(startIndex: number, endIndex: number): TerminalRenderWindow;
}

export function createTerminalBufferRenderRuntime(): TerminalBufferRenderRuntime {
  let revision = 0;
  let cols = 0;
  let rows = 0;
  let cursor: TerminalBufferFrameChunk['cursor'] = null;
  let startIndex = 0;
  let endIndex = 0;
  let lines = new Map<number, readonly TerminalRenderCell[]>();
  let pending: PendingFrame | null = null;

  function readLines(windowStart: number, windowEnd: number) {
    return Array.from({ length: windowEnd - windowStart }, (_, offset) => (
      lines.get(windowStart + offset) ?? null
    ));
  }

  function snapshot(): TerminalBufferSnapshot {
    const projected = readLines(startIndex, endIndex);
    return {
      revision,
      startIndex,
      endIndex,
      cols,
      rows,
      cursor: cursor ? { ...cursor } : null,
      lines: projected,
      gapRanges: gapsFor(startIndex, projected),
    };
  }

  function reject(
    error: Extract<TerminalBufferApplyResult, { kind: 'rejected' }>['error'],
    repairRange: TerminalBufferGapRange | null,
  ): TerminalBufferApplyResult {
    return { kind: 'rejected', error, repairRange };
  }

  function commitFrame(frame: TerminalBufferFrameChunk): TerminalBufferApplyResult {
    const chunks = Array.from(pending?.chunks.values() ?? [frame]).sort(
      (left, right) => left.frameChunkIndex - right.frameChunkIndex,
    );
    let expectedIndex = frame.frameStartIndex;
    const nextLines = new Map<number, readonly TerminalRenderCell[]>();
    for (const [position, chunk] of chunks.entries()) {
      if (
        chunk.frameChunkIndex !== position
        || chunk.startIndex !== expectedIndex
        || !metadataEqual(frame, chunk)
      ) {
        pending = null;
        return reject('invalid-lines', rangeOf(frame));
      }
      for (const line of chunk.lines) {
        nextLines.set(line.index, cloneCells(line.cells));
      }
      expectedIndex = chunk.endIndex;
    }
    if (chunks.length !== frame.frameChunkCount || expectedIndex !== frame.frameEndIndex) {
      return { kind: 'pending', repairRange: null };
    }

    const nextStore = new Map(lines);
    for (let index = frame.frameStartIndex; index < frame.frameEndIndex; index += 1) {
      nextStore.delete(index);
    }
    for (const [index, cells] of nextLines) {
      nextStore.set(index, cells);
    }
    lines = nextStore;
    revision = frame.revision;
    cols = frame.cols;
    rows = frame.rows;
    cursor = frame.cursor ? { ...frame.cursor } : null;
    if (endIndex === startIndex) {
      startIndex = frame.frameStartIndex;
      endIndex = frame.frameEndIndex;
    } else {
      startIndex = Math.min(startIndex, frame.frameStartIndex);
      endIndex = Math.max(endIndex, frame.frameEndIndex);
    }
    pending = null;
    return { kind: 'committed', snapshot: snapshot(), repairRange: null };
  }

  function applyFrameChunk(chunk: TerminalBufferFrameChunk): TerminalBufferApplyResult {
    const incomingRange = validFrameRange(chunk);
    if (!validChunk(chunk)) {
      pending = null;
      return reject('invalid-frame', incomingRange);
    }
    if (chunk.revision < revision) {
      return reject('stale-frame', null);
    }
    if (
      pending
      && (
        pending.revision !== chunk.revision
        || pending.frameStartIndex !== chunk.frameStartIndex
        || pending.frameEndIndex !== chunk.frameEndIndex
        || pending.frameChunkCount !== chunk.frameChunkCount
        || pending.generatedAt !== chunk.generatedAt
        || pending.cols !== chunk.cols
        || pending.rows !== chunk.rows
      )
    ) {
      const previousRange = rangeOf(pending);
      if (chunk.revision < pending.revision) {
        return reject('stale-frame', null);
      }
      if (chunk.revision === pending.revision) {
        pending = null;
        return reject('interleaved-frame', previousRange);
      }
      pending = null;
      if (chunk.frameChunkCount === 1) {
        return commitFrame(chunk);
      }
      pending = {
        revision: chunk.revision,
        frameStartIndex: chunk.frameStartIndex,
        frameEndIndex: chunk.frameEndIndex,
        frameChunkCount: chunk.frameChunkCount,
        generatedAt: chunk.generatedAt,
        cols: chunk.cols,
        rows: chunk.rows,
        chunks: new Map([[chunk.frameChunkIndex, chunk]]),
      };
      return { kind: 'pending', repairRange: null };
    }
    if (chunk.frameChunkCount === 1) {
      if (pending) {
        const previousRange = rangeOf(pending);
        pending = null;
        return reject('interleaved-frame', previousRange);
      }
      if (chunk.revision === revision) {
        const current = snapshot();
        const incoming = chunk.lines.map((line) => line.cells);
        const same = current.startIndex === chunk.startIndex
          && current.endIndex === chunk.endIndex
          && current.lines.every((line, index) => line !== null && cellsEqual(line, incoming[index] ?? []));
        return same
          ? { kind: 'committed', snapshot: current, repairRange: null }
          : reject('conflicting-frame', incomingRange);
      }
      return commitFrame(chunk);
    }
    if (pending && pending.chunks.has(chunk.frameChunkIndex)) {
      const prior = pending.chunks.get(chunk.frameChunkIndex)!;
      if (!chunksEqual(prior, chunk)) {
        const repairRange = rangeOf(pending);
        pending = null;
        return reject('conflicting-frame', repairRange);
      }
      return { kind: 'pending', repairRange: null };
    }
    if (!pending) {
      pending = {
        revision: chunk.revision,
        frameStartIndex: chunk.frameStartIndex,
        frameEndIndex: chunk.frameEndIndex,
        frameChunkCount: chunk.frameChunkCount,
        generatedAt: chunk.generatedAt,
        cols: chunk.cols,
        rows: chunk.rows,
        chunks: new Map(),
      };
    }
    pending.chunks.set(chunk.frameChunkIndex, chunk);
    return pending.chunks.size === pending.frameChunkCount
      ? commitFrame(chunk)
      : { kind: 'pending', repairRange: null };
  }

  function projectRenderWindow(windowStartIndex: number, windowEndIndex: number): TerminalRenderWindow {
    if (!isInteger(windowStartIndex) || !isInteger(windowEndIndex) || windowStartIndex < 0 || windowEndIndex <= windowStartIndex) {
      throw new TypeError('render window must be a non-empty range');
    }
    const projected = readLines(windowStartIndex, windowEndIndex);
    return {
      startIndex: windowStartIndex,
      endIndex: windowEndIndex,
      lines: projected,
      gapRanges: gapsFor(windowStartIndex, projected),
    };
  }

  return {
    applyFrameChunk,
    getSnapshot: snapshot,
    projectRenderWindow,
  };
}
