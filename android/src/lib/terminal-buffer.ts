import type {
  SessionBufferState,
  TerminalCell,
  TerminalScrollbackUpdate,
  TerminalSnapshot,
  TerminalViewportUpdate,
} from './types';
import { mergeIndexedScrollbackRanges } from './scrollback-buffer';

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

function trimBufferWithLineStart(
  lines: string[],
  lineStartIndex: number | undefined,
  cacheLines: number,
) {
  const normalized = lines.map((line) => (typeof line === 'string' ? line : String(line ?? '')));
  if (normalized.length <= cacheLines) {
    return {
      lines: normalized,
      lineStartIndex,
    };
  }

  const trimmedCount = normalized.length - cacheLines;
  return {
    lines: normalized.slice(trimmedCount),
    lineStartIndex: lineStartIndex !== undefined ? lineStartIndex + trimmedCount : undefined,
  };
}

function resolveSnapshotLineStart(snapshot: TerminalSnapshot) {
  if (snapshot.scrollbackLines && snapshot.scrollbackLines.length > 0) {
    return snapshot.scrollbackStartIndex;
  }
  return snapshot.viewportStartIndex;
}

function resolveBufferLineStart(current: SessionBufferState | undefined) {
  if (!current) {
    return undefined;
  }
  if (current.lineStartIndex !== undefined) {
    return current.lineStartIndex;
  }
  if (current.remoteSnapshot) {
    return resolveSnapshotLineStart(current.remoteSnapshot);
  }
  return current.scrollbackStartIndex;
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
    viewportStartIndex: update.viewportStartIndex,
    cursor: update.cursor,
    cursorKeysApp: update.cursorKeysApp,
    scrollbackLines: previous?.scrollbackLines,
    scrollbackStartIndex: previous?.scrollbackStartIndex,
  };
}

function applyViewportUpdateToLines(
  current: SessionBufferState,
  nextSnapshot: TerminalSnapshot,
  update: TerminalViewportUpdate,
  cacheLines: number,
) {
  if (update.rowsPatch.length === 0) {
    return {
      lines: current.lines,
      lineStartIndex: resolveBufferLineStart(current),
    };
  }

  const previousSnapshot = current.remoteSnapshot;
  if (!previousSnapshot) {
    return linesFromSnapshot(nextSnapshot, cacheLines);
  }

  if (
    previousSnapshot.rows !== nextSnapshot.rows
    || previousSnapshot.cols !== nextSnapshot.cols
    || current.lines.length < nextSnapshot.rows
  ) {
    return linesFromSnapshot(nextSnapshot, cacheLines);
  }

  const lineStartIndex = resolveBufferLineStart(current);
  if (lineStartIndex === undefined) {
    return linesFromSnapshot(nextSnapshot, cacheLines);
  }
  let nextLines = current.lines;

  for (const patch of update.rowsPatch) {
    const absoluteLineIndex = update.viewportStartIndex + patch.row;
    const lineIndex = absoluteLineIndex - lineStartIndex;
    if (lineIndex < 0 || lineIndex >= current.lines.length) {
      return linesFromSnapshot(nextSnapshot, cacheLines);
    }

    const nextLine = cellsToLine(nextSnapshot.viewport[patch.row] || patch.cells);
    if (nextLines[lineIndex] === nextLine) {
      continue;
    }

    if (nextLines === current.lines) {
      nextLines = current.lines.slice();
    }
    nextLines[lineIndex] = nextLine;
  }

  return {
    lines: nextLines,
    lineStartIndex,
  };
}

function linesFromSnapshot(snapshot: TerminalSnapshot, cacheLines: number) {
  const viewportLines = snapshot.viewport.map(cellsToLine);
  return trimBufferWithLineStart(
    [...(snapshot.scrollbackLines || []), ...viewportLines],
    resolveSnapshotLineStart(snapshot),
    cacheLines,
  );
}

function nextRevision(current?: SessionBufferState) {
  return (current?.revision || 0) + 1;
}

export function createSessionBufferState(options: {
  lines?: string[];
  lineStartIndex?: number;
  scrollbackStartIndex?: number;
  remoteSnapshot?: TerminalSnapshot;
  updateKind?: SessionBufferState['updateKind'];
  revision?: number;
  cacheLines: number;
}): SessionBufferState {
  const derivedLineStartIndex =
    options.lineStartIndex
    ?? (options.remoteSnapshot ? resolveSnapshotLineStart(options.remoteSnapshot) : undefined)
    ?? options.scrollbackStartIndex;
  const nextBuffer = trimBufferWithLineStart(options.lines || [], derivedLineStartIndex, options.cacheLines);
  return {
    lines: nextBuffer.lines,
    lineStartIndex: nextBuffer.lineStartIndex,
    scrollbackStartIndex: options.scrollbackStartIndex,
    remoteSnapshot: options.remoteSnapshot,
    updateKind: options.updateKind || 'replace',
    revision: options.revision ?? 0,
  };
}

export function getSessionBufferScrollbackRange(buffer: SessionBufferState) {
  const lineStartIndex = resolveBufferLineStart(buffer);
  const viewportStartIndex = buffer.remoteSnapshot?.viewportStartIndex;
  if (lineStartIndex === undefined || viewportStartIndex === undefined || viewportStartIndex <= lineStartIndex) {
    return null;
  }
  return {
    startIndex: lineStartIndex,
    endIndex: viewportStartIndex,
  };
}

export function isScrollbackUpdateContiguous(
  current: SessionBufferState,
  update: TerminalScrollbackUpdate,
) {
  if (update.mode === 'reset' || update.startIndex === undefined) {
    return true;
  }

  const currentRange = getSessionBufferScrollbackRange(current);
  if (!currentRange) {
    return false;
  }

  if (update.mode === 'append') {
    return update.startIndex === currentRange.endIndex;
  }

  if (update.mode === 'prepend') {
    return update.startIndex + update.lines.length === currentRange.startIndex;
  }

  return true;
}

export function buildScrollbackRecoveryRange(
  current: SessionBufferState,
  update: TerminalScrollbackUpdate,
  cacheLines: number,
) {
  if (update.startIndex === undefined) {
    return null;
  }

  const incomingStart = Math.max(0, Math.floor(update.startIndex));
  const incomingEnd = incomingStart + update.lines.length;
  const currentRange = getSessionBufferScrollbackRange(current);

  if (!currentRange) {
    return {
      startIndex: Math.max(0, incomingEnd - cacheLines),
      endIndex: incomingEnd,
    };
  }

  let startIndex = currentRange.startIndex;
  let endIndex = currentRange.endIndex;

  if (update.mode === 'prepend') {
    startIndex = Math.min(currentRange.startIndex, incomingStart);
  } else {
    endIndex = Math.max(currentRange.endIndex, incomingEnd);
  }

  if (endIndex - startIndex > cacheLines) {
    if (update.mode === 'prepend') {
      endIndex = startIndex + cacheLines;
    } else {
      startIndex = Math.max(0, endIndex - cacheLines);
    }
  }

  return {
    startIndex,
    endIndex: Math.max(startIndex, endIndex),
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
    lineStartIndex: nextBuffer.lineStartIndex,
    scrollbackStartIndex: snapshot.scrollbackStartIndex,
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
  nextSnapshot.scrollbackStartIndex = current.remoteSnapshot?.scrollbackStartIndex;
  const nextBuffer = applyViewportUpdateToLines(current, nextSnapshot, update, cacheLines);
  return {
    lines: nextBuffer.lines,
    lineStartIndex: nextBuffer.lineStartIndex,
    scrollbackStartIndex: nextSnapshot.scrollbackStartIndex,
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
  const currentScrollback = current.remoteSnapshot?.scrollbackLines?.slice() || [];

  let nextScrollback = currentScrollback;
  let nextScrollbackStartIndex = current.remoteSnapshot?.scrollbackStartIndex;
  let updateKind: SessionBufferState['updateKind'] = 'append';

  if (update.mode === 'reset') {
    nextScrollback = update.lines.slice();
    nextScrollbackStartIndex = update.startIndex;
    updateKind = 'replace';
  } else {
    const merged = mergeIndexedScrollbackRanges(
      {
        lines: currentScrollback,
        startIndex: current.remoteSnapshot?.scrollbackStartIndex,
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

  const nextSnapshot = current.remoteSnapshot
    ? {
        ...current.remoteSnapshot,
        scrollbackLines: nextScrollback,
        scrollbackStartIndex: nextScrollbackStartIndex,
      }
    : current.remoteSnapshot;
  const nextBuffer = nextSnapshot
    ? linesFromSnapshot(nextSnapshot, cacheLines)
    : trimBufferWithLineStart(nextScrollback, nextScrollbackStartIndex, cacheLines);

  return {
    lines: nextBuffer.lines,
    lineStartIndex: nextBuffer.lineStartIndex,
    scrollbackStartIndex: nextSnapshot?.scrollbackStartIndex,
    remoteSnapshot: nextSnapshot,
    updateKind,
    revision: nextRevision(current),
  };
}

export function replaceSessionBufferLines(
  current: SessionBufferState | undefined,
  lines: string[],
  cacheLines: number,
): SessionBufferState {
  const nextBuffer = trimBufferWithLineStart(lines, resolveBufferLineStart(current), cacheLines);
  return {
    lines: nextBuffer.lines,
    lineStartIndex: nextBuffer.lineStartIndex,
    scrollbackStartIndex: current?.remoteSnapshot?.scrollbackStartIndex,
    remoteSnapshot: current?.remoteSnapshot,
    updateKind: 'replace',
    revision: nextRevision(current),
  };
}
