import { WasmBridge } from '@jsonstudio/wtermmod-core';
import type {
  TerminalCell,
  TerminalCursorState,
} from '@zterm/shared/types';
// R8: module-level bridge promise so multiple mirrors share a single WASM
// instance. WasmBridge.load() is expensive (compile + bind) and previously
// each mirror paid the cost on first capture.
let sharedScratchBridgePromise: Promise<WasmBridge> | null = null;
function loadSharedScratchBridge() {
  if (!sharedScratchBridgePromise) {
    sharedScratchBridgePromise = WasmBridge.load();
  }
  return sharedScratchBridgePromise;
}
import {
  normalizeMirrorCaptureLines,
  rowsEqual,
  resolveCanonicalAvailableLineCount,
  trimCanonicalBufferWindow,
} from './canonical-buffer';
import { canonicalizeCapturedMirrorLines } from './mirror-line-canonicalizer';
import type { SessionMirror, TmuxCursorState, TmuxPaneMetrics } from './terminal-runtime-types';
import type { WezTermBackendRuntime } from './wezterm-backend';

export interface TerminalMirrorCaptureDeps {
  resolveMirrorCacheLines: (rows: number) => number;
  runTmux: (args: string[]) => { ok: true; stdout: string };
  runTmuxAsync: (args: string[]) => Promise<{ ok: true; stdout: string }>;
  buildExactTmuxPaneTarget: (sessionName: string) => string;
  logTimePrefix: () => string;
  wezTermBackend?: WezTermBackendRuntime | null;
  terminalBackendKind?: 'tmux' | 'wezterm' | 'herdr';
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
  captureDurationMs: number;
  canonicalizeDurationMs: number;
  captureStartedAt?: number;
  captureDoneAt?: number;
  canonicalizeDoneAt?: number;
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

function mirrorCaptureSnapshotWindowEqual(
  left: ResolvedMirrorCaptureSnapshot,
  right: ResolvedMirrorCaptureSnapshot,
) {
  return (
    left.rows === right.rows
    && left.cols === right.cols
    && left.cursorKeysApp === right.cursorKeysApp
    && left.lastScrollbackCount === right.lastScrollbackCount
    && left.bufferStartIndex === right.bufferStartIndex
    && left.bufferLines.length === right.bufferLines.length
    && left.capturedLineCount === right.capturedLineCount
    && left.canonicalLineCount === right.canonicalLineCount
    && left.totalAvailableLines === right.totalAvailableLines
    && left.visibleTopIndex === right.visibleTopIndex
  );
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
      captureDurationMs: mirror.lastCaptureDurationMs || 0,
      canonicalizeDurationMs: mirror.lastCanonicalizeDurationMs || 0,
      captureStartedAt: 0,
      captureDoneAt: 0,
      canonicalizeDoneAt: 0,
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
    if (mirrorCaptureSnapshotWindowEqual(previousSnapshot, nextSnapshot)) {
      return {
        snapshot: nextSnapshot,
        attempts: attempt,
        stabilized: true,
        stabilizedAgainst: 'consecutive-window' as const,
      };
    }
    previousSnapshot = nextSnapshot;
  }

  // The screen keeps changing every capture (e.g. a live status bar or input
  // area at the bottom of the buffer). That is exactly a LIVE session, not a
  // stopped one: accept the latest snapshot instead of failing. Failing here
  // used to drive capture-failure streaks that misreported busy sessions as
  // stopped (their buffer content changed every frame so stabilization never
  // converged).
  return {
    snapshot: previousSnapshot,
    attempts: maxAttempts,
    stabilized: false,
    stabilizedAgainst: 'unstable-accepted' as const,
  };
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
    if (deps.wezTermBackend) {
      const session = deps.wezTermBackend.listSessions().find((entry) => entry.sessionName === sessionName);
      if (!session) {
        throw new Error(`wezterm session not found: ${sessionName}`);
      }
      return {
        paneId: String(session.paneId),
        // Herdr does not expose a tmux history-size equivalent. Its absolute
        // range must come from the canonical snapshot, never from a derived
        // geometry value.
        tmuxAvailableLineCountHint: deps.terminalBackendKind === 'herdr' ? 0 : session.rows + session.cols,
        paneRows: session.rows,
        paneCols: session.cols,
        alternateOn: false,
      };
    }
    const result = deps.runTmux([
      'display-message',
      '-p',
      '-t',
      deps.buildExactTmuxPaneTarget(sessionName),
      '#{pane_id}\t#{history_size}\t#{pane_height}\t#{pane_width}\t#{alternate_on}\t#{pane_dead}',
    ]);
    const [paneIdRaw, tmuxHistorySizeRaw, rowsRaw, colsRaw, alternateOnRaw, paneDeadRaw] = result.stdout.trim().split('\t');
    const paneRows = Number.parseInt(rowsRaw ?? '', 10);
    const paneCols = Number.parseInt(colsRaw ?? '', 10);
    if (!Number.isFinite(paneRows) || paneRows <= 0 || !Number.isFinite(paneCols) || paneCols <= 0) {
      throw new Error(`tmux returned invalid pane metrics for ${sessionName}: rows=${rowsRaw ?? ''} cols=${colsRaw ?? ''}`);
    }
    if (paneDeadRaw === '1') {
      throw new Error(`tmux returned invalid pane metrics for ${sessionName}: pane is dead`);
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
    if (deps.wezTermBackend) {
      return deps.wezTermBackend.readCurrentPath(sessionName);
    }
    const result = deps.runTmux([
      'display-message', '-p', '-t', deps.buildExactTmuxPaneTarget(sessionName), '#{pane_current_path}',
    ]);
    const currentPath = result.stdout.trim();
    if (!currentPath) {
      throw new Error(`tmux returned empty pane_current_path for ${sessionName}`);
    }
    return currentPath;
  }

  async function readTmuxCursorStateAsync(target: string): Promise<TmuxCursorState> {
    const result = await deps.runTmuxAsync([
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

  async function captureTmuxMirrorLinesAsync(
    target: string,
    options: {
      paneRows: number;
      maxLines: number;
      alternateOn: boolean;
    },
  ) {
    const safePaneRows = Math.max(1, Math.floor(options.paneRows));
    const safeMaxLines = Math.max(1, Math.floor(options.maxLines));
    const captureResult = await deps.runTmuxAsync([
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

  async function readTmuxPaneMetricsAsync(sessionName: string): Promise<TmuxPaneMetrics> {
    const result = await deps.runTmuxAsync([
      'display-message',
      '-p',
      '-t',
      deps.buildExactTmuxPaneTarget(sessionName),
      '#{pane_id}\t#{history_size}\t#{pane_height}\t#{pane_width}\t#{alternate_on}\t#{pane_dead}',
    ]);
    const [paneIdRaw, tmuxHistorySizeRaw, rowsRaw, colsRaw, alternateOnRaw, paneDeadRaw] = result.stdout.trim().split('\t');
    const paneRows = Number.parseInt(rowsRaw ?? '', 10);
    const paneCols = Number.parseInt(colsRaw ?? '', 10);
    if (!Number.isFinite(paneRows) || paneRows <= 0 || !Number.isFinite(paneCols) || paneCols <= 0) {
      throw new Error(`tmux returned invalid pane metrics for ${sessionName}: rows=${rowsRaw ?? ''} cols=${colsRaw ?? ''}`);
    }
    if (paneDeadRaw === '1') {
      throw new Error(`tmux returned invalid pane metrics for ${sessionName}: pane is dead`);
    }
    const historySize = Math.max(0, Number.parseInt(tmuxHistorySizeRaw ?? '', 10) || 0);
    const alternateOn = alternateOnRaw === '1';
    return {
      paneId: paneIdRaw?.trim() || sessionName,
      tmuxAvailableLineCountHint: historySize + paneRows,
      paneRows,
      paneCols,
      alternateOn,
    };
  }

  async function captureTmuxMirrorSnapshot(mirror: SessionMirror): Promise<ResolvedMirrorCaptureSnapshot> {
    const captureStartedAt = Date.now();
    const metrics = await readTmuxPaneMetricsAsync(mirror.sessionName);
    const cursor = await readTmuxCursorStateAsync(metrics.paneId);
    const maxLines = deps.resolveMirrorCacheLines(metrics.paneRows);
    const capturedLines = await captureTmuxMirrorLinesAsync(metrics.paneId, {
      paneRows: metrics.paneRows,
      maxLines,
      alternateOn: metrics.alternateOn,
    });
    const captureDoneAt = Date.now();

    const scratchBridge = mirror.scratchBridge ?? await loadSharedScratchBridge();
    mirror.scratchBridge = scratchBridge;
    const canonicalizeStartedAt = Date.now();
    const nextBufferLines = await canonicalizeCapturedMirrorLines(capturedLines, metrics.paneCols, scratchBridge);
    const canonicalizeDoneAt = Date.now();

    const resolvedAvailableLineCount = resolveCanonicalAvailableLineCount({
      paneRows: metrics.paneRows,
      tmuxAvailableLineCountHint: metrics.tmuxAvailableLineCountHint,
      capturedLineCount: capturedLines.length,
      scratchLineCount: nextBufferLines.length,
    });
    const totalAvailableLines = Math.max(
      resolvedAvailableLineCount,
      getMirrorAvailableEndIndex(mirror),
    );
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
      captureDurationMs: Math.max(0, captureDoneAt - captureStartedAt),
      canonicalizeDurationMs: Math.max(0, canonicalizeDoneAt - canonicalizeStartedAt),
      captureStartedAt,
      captureDoneAt,
      canonicalizeDoneAt,
    };
  }

  async function captureMirrorAuthoritativeBufferFromTmux(mirror: SessionMirror) {
    if (deps.wezTermBackend) {
      const snapshot = await deps.wezTermBackend.readSnapshot(mirror.sessionName);
      applyMirrorCaptureSnapshot(mirror, {
        rows: snapshot.rows,
        cols: snapshot.cols,
        cursorKeysApp: snapshot.cursorKeysApp,
        lastScrollbackCount: Math.max(0, snapshot.bufferLines.length - snapshot.rows),
        bufferStartIndex: snapshot.bufferStartIndex,
        bufferLines: snapshot.bufferLines,
        cursor: snapshot.cursor,
        capturedLineCount: snapshot.bufferLines.length,
        canonicalLineCount: snapshot.bufferLines.length,
        totalAvailableLines: snapshot.bufferStartIndex + snapshot.bufferLines.length,
        visibleTopIndex: Math.max(snapshot.bufferStartIndex, snapshot.bufferStartIndex + snapshot.bufferLines.length - snapshot.rows),
        captureDurationMs: 0,
        canonicalizeDurationMs: 0,
        captureStartedAt: Date.now(),
        captureDoneAt: Date.now(),
        canonicalizeDoneAt: Date.now(),
      });
      mirror.lastCaptureDurationMs = 0;
      mirror.lastCanonicalizeDurationMs = 0;
      mirror.pendingStableCaptureSnapshot = null;
      mirror.pendingPerformanceTraceCapture = null;
      return true;
    }
    const stableCapture = await resolveStableMirrorCaptureSnapshot({
      readSnapshot: () => captureTmuxMirrorSnapshot(mirror),
      currentMirror: mirror,
    });
    const snapshot = stableCapture.snapshot;
    applyMirrorCaptureSnapshot(mirror, snapshot);
    mirror.lastCaptureDurationMs = snapshot.captureDurationMs;
    mirror.lastCanonicalizeDurationMs = snapshot.canonicalizeDurationMs;
    mirror.pendingStableCaptureSnapshot = null;
    mirror.pendingPerformanceTraceCapture = {
      captureStartedAt: snapshot.captureStartedAt ?? Date.now(),
      captureDoneAt: snapshot.captureDoneAt ?? Date.now(),
      canonicalizeDoneAt: snapshot.canonicalizeDoneAt ?? Date.now(),
      capturedLineCount: snapshot.capturedLineCount,
      canonicalLineCount: snapshot.canonicalLineCount,
    };

    console.log(
      `[${deps.logTimePrefix()}] [mirror:${mirror.sessionName}] tmux capture sync captured=${snapshot.capturedLineCount} canonical=${snapshot.canonicalLineCount} continuity=authoritative-replace matched=0 total=${snapshot.totalAvailableLines} rows=${snapshot.rows} cols=${snapshot.cols} buffer=${mirror.bufferStartIndex}-${getMirrorAvailableEndIndex(mirror)} visible=${snapshot.visibleTopIndex}-${getMirrorAvailableEndIndex(mirror)} stabilizeAttempts=${stableCapture.attempts} stabilizeMode=${stableCapture.stabilizedAgainst}`,
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
