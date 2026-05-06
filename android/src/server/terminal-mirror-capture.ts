import { WasmBridge } from '@jsonstudio/wtermmod-core';
import type { TerminalCell, TerminalCursorState } from '../lib/types';
import {
  normalizeMirrorCaptureLines,
  rowsEqual,
  resolveCanonicalAvailableLineCount,
  trimCanonicalBufferWindow,
} from './canonical-buffer';
import { canonicalizeCapturedMirrorLines } from './mirror-line-canonicalizer';
import type { SessionMirror, TmuxCursorState, TmuxPaneMetrics } from './terminal-runtime-types';

export interface TerminalMirrorCaptureDeps {
  resolveMirrorCacheLines: (rows: number) => number;
  runTmux: (args: string[]) => { ok: true; stdout: string };
  logTimePrefix: () => string;
}

export interface TerminalMirrorCaptureRuntime {
  readTmuxStatusLineCount: () => number;
  resolveRequestedTmuxRows: (contentRows: number) => number;
  readTmuxPaneMetrics: (sessionName: string) => TmuxPaneMetrics;
  readTmuxPaneCurrentPath: (sessionName: string) => string;
  captureMirrorAuthoritativeBufferFromTmux: (mirror: SessionMirror) => Promise<boolean>;
}

type MirrorCanonicalLines = TerminalCell[][];
const MIRROR_CAPTURE_STABILIZE_MAX_ATTEMPTS = 4;

interface ResolvedMirrorCaptureSnapshot {
  rows: number;
  cols: number;
  cursorKeysApp: boolean;
  lastScrollbackCount: number;
  bufferStartIndex: number;
  bufferLines: TerminalCell[][];
  cursor: TerminalCursorState | null;
  capturedLineCount: number;
  canonicalLineCount: number;
  totalAvailableLines: number;
  visibleTopIndex: number;
}

function normalizeMirrorCursor(options: {
  bufferStartIndex: number;
  availableEndIndex: number;
  paneRows: number;
  cursor: TmuxCursorState;
}): TerminalCursorState | null {
  const safePaneRows = Math.max(1, Math.floor(options.paneRows || 1));
  const safeBufferStartIndex = Math.max(0, Math.floor(options.bufferStartIndex || 0));
  const safeAvailableEndIndex = Math.max(safeBufferStartIndex, Math.floor(options.availableEndIndex || 0));
  if (safeAvailableEndIndex <= safeBufferStartIndex) {
    return null;
  }
  const visibleTopIndex = Math.max(safeBufferStartIndex, safeAvailableEndIndex - safePaneRows);
  const rowIndex = Math.max(
    visibleTopIndex,
    Math.min(safeAvailableEndIndex - 1, visibleTopIndex + Math.max(0, Math.floor(options.cursor.row || 0))),
  );
  return {
    rowIndex,
    col: Math.max(0, Math.floor(options.cursor.col || 0)),
    visible: Boolean(options.cursor.visible),
  };
}

function getMirrorAvailableEndIndex(mirror: SessionMirror) {
  return mirror.bufferStartIndex + mirror.bufferLines.length;
}

function cursorStatesEqual(
  left: TerminalCursorState | null | undefined,
  right: TerminalCursorState | null | undefined,
) {
  return (
    (left?.rowIndex ?? null) === (right?.rowIndex ?? null)
    && (left?.col ?? null) === (right?.col ?? null)
    && (left?.visible ?? null) === (right?.visible ?? null)
  );
}

function mirrorCaptureSnapshotsEqual(
  left: ResolvedMirrorCaptureSnapshot,
  right: ResolvedMirrorCaptureSnapshot,
) {
  if (
    left.rows !== right.rows
    || left.cols !== right.cols
    || left.cursorKeysApp !== right.cursorKeysApp
    || left.lastScrollbackCount !== right.lastScrollbackCount
    || left.bufferStartIndex !== right.bufferStartIndex
    || !cursorStatesEqual(left.cursor, right.cursor)
    || left.bufferLines.length !== right.bufferLines.length
  ) {
    return false;
  }

  for (let index = 0; index < left.bufferLines.length; index += 1) {
    if (!rowsEqual(left.bufferLines[index], right.bufferLines[index])) {
      return false;
    }
  }

  return true;
}

function currentMirrorMatchesSnapshot(
  mirror: SessionMirror,
  snapshot: ResolvedMirrorCaptureSnapshot,
) {
  return mirrorCaptureSnapshotsEqual(
    {
      rows: mirror.rows,
      cols: mirror.cols,
      cursorKeysApp: mirror.cursorKeysApp,
      lastScrollbackCount: mirror.lastScrollbackCount,
      bufferStartIndex: mirror.bufferStartIndex,
      bufferLines: mirror.bufferLines,
      cursor: mirror.cursor,
      capturedLineCount: mirror.bufferLines.length,
      canonicalLineCount: mirror.bufferLines.length,
      totalAvailableLines: getMirrorAvailableEndIndex(mirror),
      visibleTopIndex: Math.max(mirror.bufferStartIndex, getMirrorAvailableEndIndex(mirror) - mirror.rows),
    },
    snapshot,
  );
}

function applyMirrorCaptureSnapshot(
  mirror: SessionMirror,
  snapshot: ResolvedMirrorCaptureSnapshot,
) {
  mirror.rows = snapshot.rows;
  mirror.cols = snapshot.cols;
  mirror.cursorKeysApp = snapshot.cursorKeysApp;
  mirror.lastScrollbackCount = snapshot.lastScrollbackCount;
  mirror.bufferStartIndex = snapshot.bufferStartIndex;
  mirror.bufferLines = snapshot.bufferLines;
  mirror.cursor = snapshot.cursor;
}

export async function resolveStableMirrorCaptureSnapshot(options: {
  readSnapshot: () => Promise<ResolvedMirrorCaptureSnapshot>;
  currentMirror?: SessionMirror | null;
  maxAttempts?: number;
}) {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts || MIRROR_CAPTURE_STABILIZE_MAX_ATTEMPTS));
  const firstSnapshot = await options.readSnapshot();
  if (options.currentMirror && currentMirrorMatchesSnapshot(options.currentMirror, firstSnapshot)) {
    return {
      snapshot: firstSnapshot,
      attempts: 1,
      stabilized: true,
      stabilizedAgainst: 'current-mirror' as const,
    };
  }

  let previousSnapshot = firstSnapshot;
  for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
    const nextSnapshot = await options.readSnapshot();
    if (mirrorCaptureSnapshotsEqual(previousSnapshot, nextSnapshot)) {
      return {
        snapshot: nextSnapshot,
        attempts: attempt,
        stabilized: true,
        stabilizedAgainst: 'consecutive-capture' as const,
      };
    }
    previousSnapshot = nextSnapshot;
  }

  throw new Error(`tmux capture remained unstable after ${maxAttempts} attempts`);
}

export function resolveAuthoritativeMirrorCaptureWindow(options: {
  nextLines: MirrorCanonicalLines;
  computedStartIndex: number;
}) {
  const nextLines = options.nextLines;
  const safeComputedStartIndex = Math.max(0, Math.floor(options.computedStartIndex || 0));
  return {
    startIndex: safeComputedStartIndex,
    lines: nextLines,
    continuity: 'authoritative-replace' as const,
    matchedRows: 0,
  };
}

export function createTerminalMirrorCaptureRuntime(
  deps: TerminalMirrorCaptureDeps,
): TerminalMirrorCaptureRuntime {
  function readTmuxStatusLineCount() {
    try {
      const result = deps.runTmux(['display-message', '-p', '#{?status,1,0}']);
      return result.stdout.trim() === '1' ? 1 : 0;
    } catch (error) {
      console.warn(
        `[${deps.logTimePrefix()}] failed to read tmux status line count; defaulting to 0: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  function resolveRequestedTmuxRows(contentRows: number) {
    const safeContentRows = Math.max(1, Math.floor(contentRows));
    return safeContentRows + readTmuxStatusLineCount();
  }

  function readTmuxPaneMetrics(sessionName: string): TmuxPaneMetrics {
    const result = deps.runTmux([
      'display-message',
      '-p',
      '-t',
      sessionName,
      '#{pane_id}\t#{history_size}\t#{pane_height}\t#{pane_width}\t#{alternate_on}',
    ]);
    const [paneIdRaw, tmuxHistorySizeRaw, rowsRaw, colsRaw, alternateOnRaw] = result.stdout.trim().split('\t');
    const paneRows = Number.parseInt(rowsRaw ?? '', 10);
    const paneCols = Number.parseInt(colsRaw ?? '', 10);
    if (!Number.isFinite(paneRows) || paneRows <= 0 || !Number.isFinite(paneCols) || paneCols <= 0) {
      throw new Error(`tmux returned invalid pane metrics for ${sessionName}: rows=${rowsRaw ?? ''} cols=${colsRaw ?? ''}`);
    }
    const historySize = Math.max(0, Number.parseInt(tmuxHistorySizeRaw ?? '', 10) || 0);
    const alternateOn = alternateOnRaw === '1';
    return {
      paneId: paneIdRaw?.trim() || sessionName,
      // tmux history_size only counts scrollback; the visible pane rows are separate.
      // Session mirror truth must stay continuous even when alternate_on flips on.
      tmuxAvailableLineCountHint: historySize + paneRows,
      paneRows,
      paneCols,
      alternateOn,
    };
  }

  function readTmuxPaneCurrentPath(sessionName: string) {
    const result = deps.runTmux(['display-message', '-p', '-t', sessionName, '#{pane_current_path}']);
    const currentPath = result.stdout.trim();
    if (!currentPath) {
      throw new Error(`tmux returned empty pane_current_path for ${sessionName}`);
    }
    return currentPath;
  }

  function readTmuxCursorState(target: string): TmuxCursorState {
    const result = deps.runTmux([
      'display-message',
      '-p',
      '-t',
      target,
      '#{cursor_x} #{cursor_y} #{cursor_flag} #{keypad_cursor_flag}',
    ]);
    const [colRaw = '0', rowRaw = '0', visibleRaw = '0', cursorKeysAppRaw = '0'] = result.stdout.trim().split(/\s+/u);
    return {
      col: Math.max(0, Number.parseInt(colRaw, 10) || 0),
      row: Math.max(0, Number.parseInt(rowRaw, 10) || 0),
      visible: visibleRaw === '1',
      cursorKeysApp: cursorKeysAppRaw === '1',
    };
  }

  function captureTmuxMirrorLines(
    target: string,
    options: {
      paneRows: number;
      maxLines: number;
      alternateOn: boolean;
    },
  ) {
    const safePaneRows = Math.max(1, Math.floor(options.paneRows));
    const safeMaxLines = Math.max(1, Math.floor(options.maxLines));
    const captureResult = deps.runTmux([
      'capture-pane',
      '-p',
      '-e',
      '-N',
      '-t',
      target,
      '-S',
      `-${safeMaxLines}`,
      '-E',
      `${Math.max(0, safePaneRows - 1)}`,
    ]);

    const normalizedLines = normalizeMirrorCaptureLines(captureResult.stdout, {
      paneRows: safePaneRows,
      alternateOn: options.alternateOn,
    });
    if (normalizedLines.length <= safeMaxLines) {
      return normalizedLines;
    }
    return normalizedLines.slice(-safeMaxLines);
  }

  async function captureTmuxMirrorSnapshot(mirror: SessionMirror): Promise<ResolvedMirrorCaptureSnapshot> {
    const metrics = readTmuxPaneMetrics(mirror.sessionName);
    const cursor = readTmuxCursorState(metrics.paneId);
    const maxLines = deps.resolveMirrorCacheLines(metrics.paneRows);
    const capturedLines = captureTmuxMirrorLines(metrics.paneId, {
      paneRows: metrics.paneRows,
      maxLines,
      alternateOn: metrics.alternateOn,
    });

    const scratchBridge = mirror.scratchBridge ?? await WasmBridge.load();
    mirror.scratchBridge = scratchBridge;
    const nextBufferLines = await canonicalizeCapturedMirrorLines(capturedLines, metrics.paneCols, scratchBridge);

    const totalAvailableLines = resolveCanonicalAvailableLineCount({
      paneRows: metrics.paneRows,
      tmuxAvailableLineCountHint: metrics.tmuxAvailableLineCountHint,
      capturedLineCount: capturedLines.length,
      scratchLineCount: nextBufferLines.length,
    });
    const computedStartIndex = Math.max(0, totalAvailableLines - nextBufferLines.length);
    const authoritativeWindow = resolveAuthoritativeMirrorCaptureWindow({
      nextLines: nextBufferLines,
      computedStartIndex,
    });

    const trimmed = trimCanonicalBufferWindow(
      authoritativeWindow.startIndex,
      authoritativeWindow.lines,
      deps.resolveMirrorCacheLines(metrics.paneRows),
    );
    const availableEndIndex = trimmed.startIndex + trimmed.lines.length;
    const normalizedCursor = normalizeMirrorCursor({
      bufferStartIndex: trimmed.startIndex,
      availableEndIndex,
      paneRows: metrics.paneRows,
      cursor,
    });
    const visibleTopIndex = Math.max(trimmed.startIndex, availableEndIndex - metrics.paneRows);

    return {
      rows: metrics.paneRows,
      cols: metrics.paneCols,
      cursorKeysApp: cursor.cursorKeysApp,
      lastScrollbackCount: Math.max(0, authoritativeWindow.lines.length - metrics.paneRows),
      bufferStartIndex: trimmed.startIndex,
      bufferLines: trimmed.lines,
      cursor: normalizedCursor,
      capturedLineCount: capturedLines.length,
      canonicalLineCount: nextBufferLines.length,
      totalAvailableLines,
      visibleTopIndex,
    };
  }

  async function captureMirrorAuthoritativeBufferFromTmux(mirror: SessionMirror) {
    const snapshot = await captureTmuxMirrorSnapshot(mirror);
    const currentMirrorMatched = currentMirrorMatchesSnapshot(mirror, snapshot);

    if (currentMirrorMatched) {
      mirror.pendingStableCaptureSnapshot = null;
      console.log(
        `[${deps.logTimePrefix()}] [mirror:${mirror.sessionName}] tmux capture sync captured=${snapshot.capturedLineCount} canonical=${snapshot.canonicalLineCount} continuity=authoritative-replace matched=0 total=${snapshot.totalAvailableLines} rows=${snapshot.rows} cols=${snapshot.cols} buffer=${mirror.bufferStartIndex}-${getMirrorAvailableEndIndex(mirror)} visible=${snapshot.visibleTopIndex}-${getMirrorAvailableEndIndex(mirror)} stabilizeAttempts=1 stabilizeMode=current-mirror`,
      );
      return true;
    }

    applyMirrorCaptureSnapshot(mirror, snapshot);
    mirror.pendingStableCaptureSnapshot = null;

    console.log(
      `[${deps.logTimePrefix()}] [mirror:${mirror.sessionName}] tmux capture sync captured=${snapshot.capturedLineCount} canonical=${snapshot.canonicalLineCount} continuity=authoritative-replace matched=0 total=${snapshot.totalAvailableLines} rows=${snapshot.rows} cols=${snapshot.cols} buffer=${mirror.bufferStartIndex}-${getMirrorAvailableEndIndex(mirror)} visible=${snapshot.visibleTopIndex}-${getMirrorAvailableEndIndex(mirror)} stabilizeAttempts=1 stabilizeMode=single-capture-authoritative`,
    );

    return true;
  }

  return {
    readTmuxStatusLineCount,
    resolveRequestedTmuxRows,
    readTmuxPaneMetrics,
    readTmuxPaneCurrentPath,
    captureMirrorAuthoritativeBufferFromTmux,
  };
}
