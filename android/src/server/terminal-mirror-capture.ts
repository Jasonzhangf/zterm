import { WasmBridge } from '@jsonstudio/wtermmod-core';
import type { TerminalCursorState } from '../lib/types';
import {
  normalizeMirrorCaptureLines,
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
    const [paneIdRaw, tmuxAvailableLineCountRaw, rowsRaw, colsRaw, alternateOnRaw] = result.stdout.trim().split('\t');
    const paneRows = Number.parseInt(rowsRaw ?? '', 10);
    const paneCols = Number.parseInt(colsRaw ?? '', 10);
    if (!Number.isFinite(paneRows) || paneRows <= 0 || !Number.isFinite(paneCols) || paneCols <= 0) {
      throw new Error(`tmux returned invalid pane metrics for ${sessionName}: rows=${rowsRaw ?? ''} cols=${colsRaw ?? ''}`);
    }
    return {
      paneId: paneIdRaw?.trim() || sessionName,
      tmuxAvailableLineCountHint: Math.max(0, Number.parseInt(tmuxAvailableLineCountRaw ?? '', 10) || 0),
      paneRows,
      paneCols,
      alternateOn: alternateOnRaw === '1',
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
    const captureResult = deps.runTmux(options.alternateOn
      ? [
          'capture-pane',
          '-M',
          '-p',
          '-e',
          '-N',
          '-t',
          target,
          '-S',
          '0',
          '-E',
          `${Math.max(0, safePaneRows - 1)}`,
        ]
      : [
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
    if (options.alternateOn || normalizedLines.length <= safeMaxLines) {
      return normalizedLines;
    }
    return normalizedLines.slice(-safeMaxLines);
  }

  async function captureMirrorAuthoritativeBufferFromTmux(mirror: SessionMirror) {
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
    const nextBufferStartIndex = Math.max(0, totalAvailableLines - nextBufferLines.length);

    mirror.rows = metrics.paneRows;
    mirror.cols = metrics.paneCols;
    mirror.cursorKeysApp = cursor.cursorKeysApp;
    mirror.lastScrollbackCount = Math.max(0, nextBufferLines.length - metrics.paneRows);
    const trimmed = trimCanonicalBufferWindow(
      nextBufferStartIndex,
      nextBufferLines,
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
      `[${deps.logTimePrefix()}] [mirror:${mirror.sessionName}] tmux capture sync captured=${capturedLines.length} canonical=${nextBufferLines.length} total=${totalAvailableLines} rows=${metrics.paneRows} cols=${metrics.paneCols} buffer=${mirror.bufferStartIndex}-${availableEndIndex} visible=${visibleTopIndex}-${availableEndIndex}`,
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
