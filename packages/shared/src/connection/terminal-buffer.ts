import type {
  SessionBufferState,
  TerminalCell,
  TerminalScrollbackUpdate,
  TerminalSnapshot,
  TerminalViewportUpdate,
} from './types';

function trimOutputHistory(history: string, cacheLines: number) {
  const lines = history.split('\n');
  if (lines.length <= cacheLines) {
    return history;
  }
  return lines.slice(lines.length - cacheLines).join('\n');
}

export function normalizeBufferLines(lines: string[], cacheLines: number) {
  const normalized = lines.map((line) => (typeof line === 'string' ? line : String(line ?? '')));
  if (normalized.length <= cacheLines) {
    return normalized;
  }
  return normalized.slice(normalized.length - cacheLines);
}

function trimBufferWithScrollbackStart(
  lines: string[],
  scrollbackStartIndex: number | undefined,
  viewportRows: number,
  cacheLines: number,
) {
  const normalized = lines.map((line) => (typeof line === 'string' ? line : String(line ?? '')));
  const normalizedViewportRows = Math.max(0, viewportRows);
  if (normalized.length <= cacheLines) {
    return {
      lines: normalized,
      scrollbackStartIndex:
        scrollbackStartIndex !== undefined && normalized.length > normalizedViewportRows
          ? scrollbackStartIndex
          : undefined,
    };
  }

  const trimmedCount = normalized.length - cacheLines;
  const nextLines = normalized.slice(trimmedCount);
  const scrollbackCount = Math.max(0, normalized.length - normalizedViewportRows);
  const removedScrollbackCount = Math.min(trimmedCount, scrollbackCount);
  const nextScrollbackCount = Math.max(0, nextLines.length - normalizedViewportRows);

  return {
    lines: nextLines,
    scrollbackStartIndex:
      scrollbackStartIndex !== undefined && nextScrollbackCount > 0
        ? scrollbackStartIndex + removedScrollbackCount
        : undefined,
  };
}

function mergeIndexedScrollbackRanges(
  current: { lines: string[]; startIndex?: number },
  incoming: { lines: string[]; startIndex?: number },
) {
  if (incoming.startIndex === undefined || current.startIndex === undefined) {
    return {
      lines: [...current.lines, ...incoming.lines],
      startIndex: incoming.startIndex ?? current.startIndex,
    };
  }

  const merged = new Map<number, string>();

  current.lines.forEach((line, index) => {
    merged.set(current.startIndex! + index, line);
  });
  incoming.lines.forEach((line, index) => {
    merged.set(incoming.startIndex! + index, line);
  });

  const indexes = [...merged.keys()].sort((a, b) => a - b);
  return {
    startIndex: indexes[0],
    lines: indexes.map((index) => merged.get(index) || ''),
  };
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

function createBlankCell(): TerminalCell {
  return {
    char: 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  };
}

function applyViewportUpdate(previous: TerminalSnapshot | undefined, update: TerminalViewportUpdate): TerminalSnapshot {
  const viewport =
    previous && previous.cols === update.cols && previous.rows === update.rows
      ? previous.viewport.slice()
      : Array.from({ length: update.rows }, () =>
          Array.from({ length: update.cols }, () => createBlankCell()),
        );

  for (const patch of update.rowsPatch) {
    if (patch.row < 0 || patch.row >= viewport.length) {
      continue;
    }
    viewport[patch.row] = patch.cells.map((cell) => ({ ...cell }));
  }

  return {
    cols: update.cols,
    rows: update.rows,
    viewport,
    cursor: update.cursor,
    cursorKeysApp: update.cursorKeysApp,
    scrollbackLines: previous?.scrollbackLines,
    scrollbackStartIndex: previous?.scrollbackStartIndex,
  };
}

function linesFromSnapshot(snapshot: TerminalSnapshot, cacheLines: number) {
  const viewportLines = snapshot.viewport.map(cellsToLine);
  if (snapshot.scrollbackLines) {
    return trimBufferWithScrollbackStart(
      [...snapshot.scrollbackLines, ...viewportLines],
      snapshot.scrollbackStartIndex,
      snapshot.rows,
      cacheLines,
    );
  }

  return trimBufferWithScrollbackStart(viewportLines, undefined, snapshot.rows, cacheLines);
}

function nextRevision(current?: SessionBufferState) {
  return (current?.revision || 0) + 1;
}

export function createSessionBufferState(options: {
  lines?: string[];
  scrollbackStartIndex?: number;
  remoteSnapshot?: TerminalSnapshot;
  updateKind?: SessionBufferState['updateKind'];
  revision?: number;
  cacheLines: number;
}): SessionBufferState {
  const lines = normalizeBufferLines(options.lines || [], options.cacheLines);
  return {
    lines,
    scrollbackStartIndex: options.scrollbackStartIndex,
    remoteSnapshot: options.remoteSnapshot,
    updateKind: options.updateKind || 'replace',
    revision: options.revision ?? 0,
  };
}

export function sessionBufferToHistory(buffer: SessionBufferState, cacheLines: number) {
  return trimOutputHistory(buffer.lines.join('\n'), cacheLines);
}

export function applySnapshotToSessionBuffer(
  current: SessionBufferState | undefined,
  snapshot: TerminalSnapshot,
  cacheLines: number,
): SessionBufferState {
  const nextBuffer = linesFromSnapshot(snapshot, cacheLines);
  return {
    lines: nextBuffer.lines,
    scrollbackStartIndex: nextBuffer.scrollbackStartIndex,
    remoteSnapshot: snapshot,
    updateKind: 'replace',
    revision: nextRevision(current),
  };
}

export function applyViewportUpdateToSessionBuffer(
  current: SessionBufferState,
  update: TerminalViewportUpdate,
  cacheLines: number,
): SessionBufferState {
  const currentScrollbackLines = current.remoteSnapshot?.scrollbackLines?.slice() || [];
  const nextSnapshot = applyViewportUpdate(current.remoteSnapshot, update);
  nextSnapshot.scrollbackLines = currentScrollbackLines;
  nextSnapshot.scrollbackStartIndex = current.scrollbackStartIndex;
  const nextBuffer = linesFromSnapshot(nextSnapshot, cacheLines);
  return {
    lines: nextBuffer.lines,
    scrollbackStartIndex: nextBuffer.scrollbackStartIndex,
    remoteSnapshot: nextSnapshot,
    updateKind: 'viewport',
    revision: nextRevision(current),
  };
}

export function applyScrollbackUpdateToSessionBuffer(
  current: SessionBufferState,
  update: TerminalScrollbackUpdate,
  cacheLines: number,
): SessionBufferState {
  const viewportLineCount = current.remoteSnapshot?.rows || 0;
  const currentScrollback = current.remoteSnapshot?.scrollbackLines?.slice() || [];
  const viewportLines = current.remoteSnapshot?.viewport?.map(cellsToLine) || [];

  let nextScrollback = currentScrollback;
  let nextScrollbackStartIndex = current.scrollbackStartIndex;
  let updateKind: SessionBufferState['updateKind'] = 'append';

  if (update.mode === 'reset') {
    nextScrollback = update.lines.slice();
    nextScrollbackStartIndex = update.startIndex;
    updateKind = 'replace';
  } else {
    const merged = mergeIndexedScrollbackRanges(
      {
        lines: currentScrollback,
        startIndex: current.scrollbackStartIndex,
      },
      {
        lines: update.lines,
        startIndex: update.startIndex,
      },
    );
    nextScrollback = merged.lines;
    nextScrollbackStartIndex = merged.startIndex;
    updateKind = update.mode === 'prepend' ? 'prepend' : 'append';
  }

  if (update.startIndex === undefined) {
    if (update.mode === 'prepend') {
      nextScrollback = [...update.lines, ...currentScrollback];
      updateKind = 'prepend';
    } else if (update.mode === 'append') {
      nextScrollback = [...currentScrollback, ...update.lines];
      updateKind = 'append';
    }
    nextScrollbackStartIndex = undefined;
  }

  const nextBuffer = trimBufferWithScrollbackStart(
    [...nextScrollback, ...viewportLines],
    nextScrollbackStartIndex,
    viewportLineCount,
    cacheLines,
  );

  return {
    lines: nextBuffer.lines,
    scrollbackStartIndex: nextBuffer.scrollbackStartIndex,
    remoteSnapshot: current.remoteSnapshot
      ? {
          ...current.remoteSnapshot,
          scrollbackLines: nextScrollback,
          scrollbackStartIndex: nextScrollbackStartIndex,
        }
      : current.remoteSnapshot,
    updateKind,
    revision: nextRevision(current),
  };
}

export function replaceSessionBufferLines(
  current: SessionBufferState | undefined,
  lines: string[],
  cacheLines: number,
): SessionBufferState {
  const nextBuffer = trimBufferWithScrollbackStart(lines, undefined, 0, cacheLines);
  return {
    lines: nextBuffer.lines,
    scrollbackStartIndex: nextBuffer.scrollbackStartIndex,
    remoteSnapshot: current?.remoteSnapshot,
    updateKind: 'replace',
    revision: nextRevision(current),
  };
}

export function appendTerminalDataToSessionBuffer(
  current: SessionBufferState | undefined,
  chunk: string,
  cacheLines: number,
): SessionBufferState {
  const baseLines = current?.lines?.length ? [...current.lines] : [''];
  const normalizedChunk = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const pieces = normalizedChunk.split('\n');

  if (baseLines.length === 0) {
    baseLines.push('');
  }

  const nextLines = [...baseLines];
  nextLines[nextLines.length - 1] += pieces[0] || '';
  for (let index = 1; index < pieces.length; index += 1) {
    nextLines.push(pieces[index] || '');
  }

  const trimmed = normalizeBufferLines(nextLines, cacheLines);
  return {
    lines: trimmed,
    scrollbackStartIndex: current?.scrollbackStartIndex,
    remoteSnapshot: current?.remoteSnapshot,
    updateKind: 'append',
    revision: nextRevision(current),
  };
}
