import type {
  TerminalCell,
  TerminalCursorState,
} from '../../shared/src/connection/types.js';

export type RendererMode = 'follow' | 'reading';

export interface AbsoluteBufferSnapshot {
  revision: number;
  startIndex: number;
  endIndex: number;
  cols: number;
  rows: number;
  lines: ReadonlyMap<number, readonly TerminalCell[]>;
  cursor?: TerminalCursorState | null;
}

export interface RendererWindowState {
  mode: RendererMode;
  renderBottomIndex: number;
  visibleRows: number;
  visibleCols: number;
  horizontalOffset: number;
  tailEndIndex: number;
  revision: number;
}

export interface RendererVisibleRangeDemand {
  startIndex: number;
  endIndex: number;
  visibleRows: number;
  mode: RendererMode;
}

export interface RendererVisibleRow {
  absoluteIndex: number;
  screenRow: number;
  cells: readonly TerminalCell[];
  gap: boolean;
}

export interface RendererCursorProjection {
  rowIndex: number;
  col: number;
  visible: boolean;
  screenRow: number | null;
  screenCol: number | null;
}

export interface RendererSnapshot {
  revision: number;
  state: RendererWindowState;
  visibleDemand: RendererVisibleRangeDemand;
  rows: readonly RendererVisibleRow[];
  cursor: RendererCursorProjection | null;
}

export type RendererCommit = RendererSnapshot;

export interface RendererWindowOptions {
  visibleRows?: number;
  visibleCols?: number;
  horizontalOffset?: number;
}

export interface RendererWindow {
  commit(buffer: AbsoluteBufferSnapshot): RendererCommit;
  setViewport(viewport: { visibleRows?: number; visibleCols?: number }): RendererCommit;
  scrollLines(delta: number): RendererCommit;
  scrollPages(delta: number): RendererCommit;
  panColumns(delta: number): RendererCommit;
  follow(): RendererCommit;
  noteRemoteInput(): RendererCommit;
  snapshot(): RendererWindowState;
}

function positiveInteger(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function nonNegativeInteger(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function normalizeBuffer(buffer: AbsoluteBufferSnapshot): AbsoluteBufferSnapshot {
  return {
    revision: nonNegativeInteger(buffer.revision),
    startIndex: nonNegativeInteger(buffer.startIndex),
    endIndex: nonNegativeInteger(buffer.endIndex),
    cols: positiveInteger(buffer.cols, 1),
    rows: positiveInteger(buffer.rows, 1),
    lines: buffer.lines,
    cursor: buffer.cursor ?? null,
  };
}

function childCell(input: TerminalCell): TerminalCell {
  return {
    char: input.char,
    fg: input.fg,
    bg: input.bg,
    flags: input.flags,
    width: input.width,
  };
}

function cropVisibleCells(
  cells: readonly TerminalCell[],
  requestedOffset: number,
  visibleCols: number,
) {
  const safeOffset = Math.min(cells.length, nonNegativeInteger(requestedOffset));
  let sourceStartOffset = safeOffset;
  while (sourceStartOffset > 0 && cells[sourceStartOffset]?.width === 0) {
    sourceStartOffset -= 1;
  }

  const output: TerminalCell[] = [];
  let usedColumns = 0;
  for (let index = sourceStartOffset; index < cells.length && usedColumns < visibleCols; index += 1) {
    const input = cells[index];
    if (!input || input.width === 0) continue;
    const width = input.width === 2 ? 2 : 1;
    if (width === 2 && usedColumns + width > visibleCols) break;
    output.push(childCell(input));
    usedColumns += width;
  }

  return {
    cells: output,
    sourceStartOffset,
    usedColumns,
  };
}

export function createRendererWindow(options: RendererWindowOptions = {}): RendererWindow {
  let state: RendererWindowState = {
    mode: 'follow',
    renderBottomIndex: 0,
    visibleRows: positiveInteger(options.visibleRows, 24),
    visibleCols: positiveInteger(options.visibleCols, 80),
    horizontalOffset: nonNegativeInteger(options.horizontalOffset),
    tailEndIndex: 0,
    revision: 0,
  };
  let currentBuffer: AbsoluteBufferSnapshot | null = null;

  function clampHorizontalOffset(buffer: AbsoluteBufferSnapshot | null) {
    const maxOffset = Math.max(0, (buffer?.cols || state.visibleCols) - state.visibleCols);
    state.horizontalOffset = Math.min(state.horizontalOffset, maxOffset);
  }

  function clampReadingBottom() {
    state.renderBottomIndex = Math.min(
      state.tailEndIndex,
      Math.max(0, state.renderBottomIndex),
    );
    if (state.renderBottomIndex >= state.tailEndIndex) {
      state.mode = 'follow';
    }
  }

  function buildSnapshot(): RendererSnapshot {
    clampHorizontalOffset(currentBuffer);
    if (state.mode === 'follow') {
      state.renderBottomIndex = state.tailEndIndex;
    } else {
      clampReadingBottom();
    }

    const startIndex = Math.max(0, state.renderBottomIndex - state.visibleRows);
    const rows: RendererVisibleRow[] = [];
    let cursor: RendererCursorProjection | null = null;
    const sourceCursor = currentBuffer?.cursor;

    for (let screenRow = 0; screenRow < state.visibleRows; screenRow += 1) {
      const absoluteIndex = startIndex + screenRow;
      const sourceCells = currentBuffer?.lines.get(absoluteIndex);
      const gap = !sourceCells || absoluteIndex >= state.tailEndIndex;
      const cropped = gap
        ? { cells: [], sourceStartOffset: state.horizontalOffset, usedColumns: 0 }
        : cropVisibleCells(sourceCells, state.horizontalOffset, state.visibleCols);

      rows.push({
        absoluteIndex,
        screenRow,
        cells: cropped.cells,
        gap,
      });

      if (
        sourceCursor
        && sourceCursor.visible
        && sourceCursor.rowIndex === absoluteIndex
      ) {
        const screenCol = sourceCursor.col - cropped.sourceStartOffset;
        cursor = {
          rowIndex: sourceCursor.rowIndex,
          col: sourceCursor.col,
          visible: screenCol >= 0 && screenCol < state.visibleCols,
          screenRow,
          screenCol: screenCol >= 0 && screenCol < state.visibleCols ? screenCol : null,
        };
      }
    }

    if (!cursor && sourceCursor) {
      cursor = {
        rowIndex: sourceCursor.rowIndex,
        col: sourceCursor.col,
        visible: false,
        screenRow: null,
        screenCol: null,
      };
    }

    return {
      revision: state.revision,
      state: { ...state },
      visibleDemand: {
        startIndex,
        endIndex: state.renderBottomIndex,
        visibleRows: state.visibleRows,
        mode: state.mode,
      },
      rows,
      cursor,
    };
  }

  function commit(input: AbsoluteBufferSnapshot) {
    const buffer = normalizeBuffer(input);
    currentBuffer = buffer;
    state.revision = buffer.revision;
    state.tailEndIndex = buffer.endIndex;
    if (state.mode === 'follow') {
      state.renderBottomIndex = state.tailEndIndex;
    }
    return buildSnapshot();
  }

  function setViewport(viewport: { visibleRows?: number; visibleCols?: number }) {
    if (viewport.visibleRows !== undefined) {
      state.visibleRows = positiveInteger(viewport.visibleRows, state.visibleRows);
    }
    if (viewport.visibleCols !== undefined) {
      state.visibleCols = positiveInteger(viewport.visibleCols, state.visibleCols);
    }
    return buildSnapshot();
  }

  function moveToBottomOrReading(nextBottomIndex: number) {
    const next = Math.min(state.tailEndIndex, Math.max(0, nextBottomIndex));
    state.renderBottomIndex = next;
    state.mode = next >= state.tailEndIndex ? 'follow' : 'reading';
    return buildSnapshot();
  }

  function scrollLines(delta: number) {
    const safeDelta = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    return moveToBottomOrReading(state.renderBottomIndex + safeDelta);
  }

  function scrollPages(delta: number) {
    const safeDelta = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    return moveToBottomOrReading(state.renderBottomIndex + (safeDelta * state.visibleRows));
  }

  function panColumns(delta: number) {
    const safeDelta = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    state.horizontalOffset = Math.max(0, state.horizontalOffset + safeDelta);
    return buildSnapshot();
  }

  function follow() {
    state.mode = 'follow';
    state.renderBottomIndex = state.tailEndIndex;
    return buildSnapshot();
  }

  function noteRemoteInput() {
    if (state.mode === 'reading') {
      return follow();
    }
    return buildSnapshot();
  }

  return {
    commit,
    setViewport,
    scrollLines,
    scrollPages,
    panColumns,
    follow,
    noteRemoteInput,
    snapshot: () => ({ ...state }),
  };
}
