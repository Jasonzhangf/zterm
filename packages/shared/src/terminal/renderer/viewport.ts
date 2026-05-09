import type { TerminalWidthMode } from '../../connection/bridge-settings';

export interface TerminalMeasuredViewport {
  cols: number;
  rows: number;
  resolvedRowHeight: string;
  resolvedCellWidthPx: number;
}

export interface TerminalMeasuredViewportState {
  viewportClientHeightPx: number;
  resolvedRowHeight: string;
  resolvedCellWidthPx: number;
  viewportRows: number;
}

export interface TerminalWidthModeSignalState {
  mode: TerminalWidthMode;
  cols: number | null;
}

export function buildTerminalMeasuredViewportState(
  nextViewport: TerminalMeasuredViewport,
  nextClientHeight: number,
): TerminalMeasuredViewportState {
  return {
    viewportClientHeightPx: nextClientHeight,
    resolvedRowHeight: nextViewport.resolvedRowHeight,
    resolvedCellWidthPx: nextViewport.resolvedCellWidthPx,
    viewportRows: nextViewport.rows,
  };
}

export function hasTerminalViewportLayoutChanged(options: {
  nextViewport: TerminalMeasuredViewport;
  nextClientHeight: number;
  viewportRows: number;
  viewportClientHeightPx: number;
}) {
  return options.nextViewport.rows !== options.viewportRows
    || options.nextClientHeight !== options.viewportClientHeightPx;
}

export function resolveTerminalWidthModeSignal(options: {
  refreshActive: boolean;
  sessionId: string | null;
  hasWidthModeHandler: boolean;
  widthMode: TerminalWidthMode;
  nextViewport: TerminalMeasuredViewport;
  previousWidthSignal: TerminalWidthModeSignalState | null;
}) {
  if (!options.refreshActive || !options.sessionId || !options.hasWidthModeHandler) {
    return null;
  }
  const cols = options.widthMode === 'adaptive-phone' ? options.nextViewport.cols : null;
  if (
    options.previousWidthSignal
    && options.previousWidthSignal.mode === options.widthMode
    && options.previousWidthSignal.cols === cols
  ) {
    return null;
  }
  return {
    mode: options.widthMode,
    cols,
  } satisfies TerminalWidthModeSignalState;
}

export function resolveTerminalResizeCommitPlan(options: {
  sessionId: string | null;
  widthMode: TerminalWidthMode;
  previousViewport: { cols: number; rows: number } | null;
  nextViewport: TerminalMeasuredViewport;
}) {
  if (!options.sessionId) {
    return { action: 'skip' as const };
  }

  const nextViewportSize = {
    cols: options.nextViewport.cols,
    rows: options.nextViewport.rows,
  };

  if (
    options.previousViewport
    && options.previousViewport.cols === nextViewportSize.cols
    && options.previousViewport.rows === nextViewportSize.rows
  ) {
    return { action: 'skip' as const };
  }

  if (options.widthMode === 'mirror-fixed') {
    return {
      action: 'store-only' as const,
      viewport: nextViewportSize,
    };
  }

  if (
    options.previousViewport
    && options.previousViewport.cols === nextViewportSize.cols
    && options.previousViewport.rows !== nextViewportSize.rows
  ) {
    return {
      action: 'store-only' as const,
      viewport: nextViewportSize,
    };
  }

  return {
    action: 'emit-resize' as const,
    viewport: nextViewportSize,
  };
}
