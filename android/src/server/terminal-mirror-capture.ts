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

const MIN_MIRROR_CONTINUITY_MATCH_ROWS = 8;
const MIN_MIRROR_CONTINUITY_MEANINGFUL_ROWS = 3;
type MirrorCanonicalLines = TerminalCell[][];

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

function isMeaningfulRow(row: TerminalCell[] | undefined) {
  return Array.isArray(row) && row.length > 0;
}

function countAlignedMatches(
  previous: MirrorCanonicalLines,
  next: MirrorCanonicalLines,
  previousOffset: number,
  nextOffset: number,
  length: number,
) {
  let meaningfulMatches = 0;
  for (let index = 0; index < length; index += 1) {
    if (!rowsEqual(previous[previousOffset + index] || [], next[nextOffset + index] || [])) {
      return { ok: false as const, meaningfulMatches: 0 };
    }
    if (isMeaningfulRow(next[nextOffset + index])) {
      meaningfulMatches += 1;
    }
  }
  return { ok: true as const, meaningfulMatches };
}

function shouldAcceptContinuityMatch(length: number, meaningfulMatches: number) {
  return (
    length >= Math.min(MIN_MIRROR_CONTINUITY_MATCH_ROWS, Math.max(1, length))
    && meaningfulMatches >= Math.min(MIN_MIRROR_CONTINUITY_MEANINGFUL_ROWS, Math.max(1, meaningfulMatches))
  );
}

function resolveContinuousMirrorCaptureWindow(options: {
  previousStartIndex: number;
  previousLines: MirrorCanonicalLines;
  nextLines: MirrorCanonicalLines;
  computedStartIndex: number;
}) {
  const previousLines = options.previousLines;
  const nextLines = options.nextLines;
  const previousLength = previousLines.length;
  const nextLength = nextLines.length;
  if (previousLength <= 0 || nextLength <= 0) {
    return {
      startIndex: Math.max(0, Math.floor(options.computedStartIndex || 0)),
      lines: nextLines,
      continuity: 'replace' as const,
      matchedRows: 0,
    };
  }

  const previousEndIndex = Math.max(0, Math.floor(options.previousStartIndex || 0)) + previousLength;

  let best:
    | {
        startIndex: number;
        previousPrefixLength: number;
        matchedRows: number;
        continuity: 'patch-tail-window' | 'append-tail-window';
      }
    | null = null;

  if (previousLength >= nextLength) {
    const previousOffset = previousLength - nextLength;
    const sameTail = countAlignedMatches(previousLines, nextLines, previousOffset, 0, nextLength);
    if (sameTail.ok && shouldAcceptContinuityMatch(nextLength, sameTail.meaningfulMatches)) {
      best = {
        startIndex: previousEndIndex - nextLength,
        previousPrefixLength: previousOffset,
        matchedRows: nextLength,
        continuity: 'patch-tail-window',
      };
    }
  }

  const maxOverlap = Math.min(previousLength, nextLength);
  for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
    const previousOffset = previousLength - overlap;
    const overlapMatch = countAlignedMatches(previousLines, nextLines, previousOffset, 0, overlap);
    if (!overlapMatch.ok || !shouldAcceptContinuityMatch(overlap, overlapMatch.meaningfulMatches)) {
      continue;
    }
    if (!best || overlap > best.matchedRows) {
      best = {
        startIndex: previousEndIndex - overlap,
        previousPrefixLength: previousOffset,
        matchedRows: overlap,
        continuity: 'append-tail-window',
      };
    }
    break;
  }

  if (!best) {
    return {
      startIndex: Math.max(0, Math.floor(options.computedStartIndex || 0)),
      lines: nextLines,
      continuity: 'replace' as const,
      matchedRows: 0,
    };
  }

  return {
    startIndex: best.startIndex,
    lines: previousLines.slice(0, best.previousPrefixLength).concat(nextLines),
    continuity: best.continuity,
    matchedRows: best.matchedRows,
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

  async function captureMirrorAuthoritativeBufferFromTmux(mirror: SessionMirror) {
    const metrics = readTmuxPaneMetrics(mirror.sessionName);
    const cursor = readTmuxCursorState(metrics.paneId);
    const maxLines = deps.resolveMirrorCacheLines(metrics.paneRows);
    const previousBufferStartIndex = mirror.bufferStartIndex;
    const previousBufferLines = mirror.bufferLines;
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
    const continuousWindow = resolveContinuousMirrorCaptureWindow({
      previousStartIndex: previousBufferStartIndex,
      previousLines: previousBufferLines,
      nextLines: nextBufferLines,
      computedStartIndex,
    });

    mirror.rows = metrics.paneRows;
    mirror.cols = metrics.paneCols;
    mirror.cursorKeysApp = cursor.cursorKeysApp;
    mirror.lastScrollbackCount = Math.max(0, continuousWindow.lines.length - metrics.paneRows);
    const trimmed = trimCanonicalBufferWindow(
      continuousWindow.startIndex,
      continuousWindow.lines,
      deps.resolveMirrorCacheLines(mirror.rows),
    );
    mirror.bufferStartIndex = trimmed.startIndex;
    mirror.bufferLines = trimmed.lines;
    const availableEndIndex = getMirrorAvailableEndIndex(mirror);
    mirror.cursor = normalizeMirrorCursor({
      bufferStartIndex: mirror.bufferStartIndex,
      availableEndIndex,
      paneRows: mirror.rows,
      cursor,
    });
    const visibleTopIndex = Math.max(mirror.bufferStartIndex, availableEndIndex - mirror.rows);

    console.log(
      `[${deps.logTimePrefix()}] [mirror:${mirror.sessionName}] tmux capture sync captured=${capturedLines.length} canonical=${nextBufferLines.length} continuity=${continuousWindow.continuity} matched=${continuousWindow.matchedRows} total=${totalAvailableLines} rows=${metrics.paneRows} cols=${metrics.paneCols} buffer=${mirror.bufferStartIndex}-${availableEndIndex} visible=${visibleTopIndex}-${availableEndIndex}`,
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
