import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getTerminalThemePreset, type TerminalThemePreset } from '@zterm/shared';
import type {
  TerminalCell,
  TerminalCursorState,
  TerminalGapRange,
  TerminalResizeHandler,
  TerminalViewportChangeHandler,
  TerminalWidthModeHandler,
  TerminalWidthMode,
} from '../lib/types';

interface TerminalViewProps {
  sessionId: string | null;
  initialBufferLines?: TerminalCell[][];
  bufferStartIndex?: number;
  bufferEndIndex?: number;
  bufferHeadStartIndex?: number;
  bufferTailEndIndex?: number;
  daemonHeadRevision?: number;
  daemonHeadEndIndex?: number;
  bufferGapRanges?: TerminalGapRange[];
  cursorKeysApp?: boolean;
  cursor?: TerminalCursorState | null;
  active?: boolean;
  bufferPullActive?: boolean;
  inputResetEpoch?: number;
  allowDomFocus?: boolean;
  domInputOffscreen?: boolean;
  onInput?: (sessionId: string, data: string) => void;
  onActivateInput?: (sessionId: string) => void;
  onResize?: TerminalResizeHandler;
  onWidthModeChange?: TerminalWidthModeHandler;
  onViewportChange?: TerminalViewportChangeHandler;
  onSwipeTab?: (sessionId: string, direction: 'previous' | 'next') => void;
  focusNonce?: number;
  fontSize?: number;
  rowHeight?: string;
  themeId?: string;
  widthMode?: TerminalWidthMode;
  showAbsoluteLineNumbers?: boolean;
}

const DEFAULT_ROWS = 24;
const DEFAULT_COLOR = 256;
const FLAG_BOLD = 0x01;
const FLAG_DIM = 0x02;
const FLAG_ITALIC = 0x04;
const FLAG_UNDERLINE = 0x08;
const FLAG_REVERSE = 0x20;
const FLAG_INVISIBLE = 0x40;
const FLAG_STRIKETHROUGH = 0x80;
const NORMAL_CURSOR_KEYS = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
} as const;
const APP_CURSOR_KEYS = {
  ArrowUp: '\x1bOA',
  ArrowDown: '\x1bOB',
  ArrowRight: '\x1bOC',
  ArrowLeft: '\x1bOD',
} as const;
const TERMINAL_FONT_STACK = [
  '"Sarasa Mono SC"',
  '"Sarasa Term SC"',
  '"Noto Sans Mono CJK SC"',
  '"SF Mono"',
  '"Monaco"',
  '"Roboto Mono"',
  '"Menlo"',
  '"Consolas"',
  'ui-monospace',
  'monospace',
].join(', ');
const XTERM_6X6_STEPS = [0, 95, 135, 175, 215, 255] as const;
const OVERSCAN_ROWS = 4;
const TAB_SWIPE_LOCK_THRESHOLD_PX = 18;
const TAB_SWIPE_TRIGGER_THRESHOLD_PX = 72;

function normalizeCell(cell: TerminalCell | null | undefined): TerminalCell {
  return {
    char: typeof cell?.char === 'number' && Number.isFinite(cell.char) ? cell.char : 32,
    fg: typeof cell?.fg === 'number' && Number.isFinite(cell.fg) ? cell.fg : DEFAULT_COLOR,
    bg: typeof cell?.bg === 'number' && Number.isFinite(cell.bg) ? cell.bg : DEFAULT_COLOR,
    flags: typeof cell?.flags === 'number' && Number.isFinite(cell.flags) ? cell.flags : 0,
    width: cell?.width === 0 || cell?.width === 2 ? cell.width : 1,
  };
}

function safeCodePointToString(code: number) {
  if (!Number.isInteger(code) || code < 32 || code > 0x10ffff) {
    return ' ';
  }

  try {
    return String.fromCodePoint(code);
  } catch (error) {
    console.warn('[TerminalView] Failed to render code point:', { code, error });
    return ' ';
  }
}

function colorToCSS(index: number, theme: TerminalThemePreset): string | null {
  if (index === DEFAULT_COLOR) {
    return null;
  }
  if (index < 16) {
    return theme.colors[index] || theme.foreground;
  }
  if (index < 232) {
    const n = index - 16;
    const r = XTERM_6X6_STEPS[Math.floor(n / 36)] ?? 0;
    const g = XTERM_6X6_STEPS[Math.floor(n / 6) % 6] ?? 0;
    const b = XTERM_6X6_STEPS[n % 6] ?? 0;
    return `rgb(${r},${g},${b})`;
  }
  const level = (index - 232) * 10 + 8;
  return `rgb(${level},${level},${level})`;
}

function resolveColors(inputCell: TerminalCell, theme: TerminalThemePreset, cursorActive = false) {
  const cell = normalizeCell(inputCell);
  let fg = cell.fg;
  let bg = cell.bg;
  const reverse = Boolean(cell.flags & FLAG_REVERSE) || cursorActive;

  if (reverse) {
    [fg, bg] = [bg, fg];
  }

  return {
    fg: fg === DEFAULT_COLOR
      ? (reverse ? theme.background : theme.foreground)
      : colorToCSS(fg, theme) || theme.foreground,
    bg: bg === DEFAULT_COLOR
      ? (reverse ? theme.foreground : 'transparent')
      : colorToCSS(bg, theme) || 'transparent',
  };
}

function cellStyle(
  inputCell: TerminalCell,
  rowHeight: string,
  cellWidthPx: number,
  theme: TerminalThemePreset,
  cursorActive = false,
) {
  const cell = normalizeCell(inputCell);
  const colors = resolveColors(cell, theme, cursorActive);
  const safeCellWidthPx = Math.max(1, Number.isFinite(cellWidthPx) ? cellWidthPx : 1);
  const style: Record<string, string> = {
    display: 'inline-block',
    height: rowHeight,
    lineHeight: rowHeight,
    verticalAlign: 'top',
    overflow: 'hidden',
    whiteSpace: 'pre',
    width: cell.width === 2 ? `${safeCellWidthPx * 2}px` : cell.width === 0 ? '0px' : `${safeCellWidthPx}px`,
    letterSpacing: '0',
    fontKerning: 'none',
    fontVariantLigatures: 'none',
    fontFeatureSettings: '"liga" 0, "calt" 0',
    textRendering: 'optimizeSpeed',
    boxSizing: 'border-box',
  };

  if (cell.width === 0) {
    return style;
  }

  style.color = colors.fg;
  style.background = colors.bg;
  if (cell.flags & FLAG_BOLD) style.fontWeight = '700';
  if (cell.flags & FLAG_DIM) style.opacity = '0.5';
  if (cell.flags & FLAG_ITALIC) style.fontStyle = 'italic';
  if (cell.flags & FLAG_INVISIBLE) style.visibility = 'hidden';

  const decorations: string[] = [];
  if (cell.flags & FLAG_UNDERLINE) decorations.push('underline');
  if (cell.flags & FLAG_STRIKETHROUGH) decorations.push('line-through');
  if (decorations.length > 0) {
    style.textDecoration = decorations.join(' ');
  }

  return style;
}

function measureViewport(host: HTMLDivElement, fontSize: number, rowHeight: string) {
  if (typeof document === 'undefined') {
    return {
      cols: 80,
      rows: DEFAULT_ROWS,
      resolvedRowHeight: rowHeight,
      resolvedCellWidthPx: Math.max(1, fontSize * 0.62),
    };
  }

  const measureProbeRect = (text: string) => {
    const probe = document.createElement('span');
    probe.textContent = text;
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.style.fontFamily = TERMINAL_FONT_STACK;
    probe.style.fontSize = `${fontSize}px`;
    probe.style.lineHeight = rowHeight;
    host.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    return rect;
  };

  const latinRect = measureProbeRect('W');
  const cjkRect = measureProbeRect('你');

  const latinWidthPx = Math.max(1, latinRect.width || fontSize * 0.62);
  const cjkHalfWidthPx = Math.max(1, (cjkRect.width || latinWidthPx * 2) / 2);
  const cellWidthPx = Math.max(latinWidthPx, cjkHalfWidthPx);
  const measuredRowHeight = Math.max(1, Math.ceil(latinRect.height || parseInt(rowHeight, 10) || 17));

  return {
    cols: Math.max(1, Math.floor(host.clientWidth / cellWidthPx)),
    rows: Math.max(1, Math.floor(host.clientHeight / measuredRowHeight)),
    resolvedRowHeight: `${measuredRowHeight}px`,
    resolvedCellWidthPx: cellWidthPx,
  };
}

function isGapIndex(gapRanges: TerminalGapRange[], absoluteIndex: number) {
  return gapRanges.some((range) => absoluteIndex >= range.startIndex && absoluteIndex < range.endIndex);
}

function hasDiscontinuousNeighbor(
  rows: Array<{ absoluteIndex: number }>,
  rowIndex: number,
) {
  const current = rows[rowIndex];
  if (!current) {
    return false;
  }
  const previous = rows[rowIndex - 1];
  const next = rows[rowIndex + 1];
  const brokenBefore = Boolean(previous) && previous.absoluteIndex + 1 !== current.absoluteIndex;
  const brokenAfter = Boolean(next) && current.absoluteIndex + 1 !== next.absoluteIndex;
  return brokenBefore || brokenAfter;
}

function resolveCursorCellColumn(row: TerminalCell[], preferredCol: number) {
  if (row.length === 0) {
    return -1;
  }

  const clamped = Math.max(0, Math.min(row.length - 1, Math.floor(preferredCol)));
  if (row[clamped]?.width !== 0) {
    return clamped;
  }

  for (let col = clamped - 1; col >= 0; col -= 1) {
    if (row[col]?.width !== 0) {
      return col;
    }
  }

  return clamped;
}

function resolveDomBottomScrollTop(host: HTMLDivElement, targetScrollTop: number) {
  const safeTargetScrollTop = Math.max(0, targetScrollTop);
  const domBottomScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
  return Math.min(domBottomScrollTop, safeTargetScrollTop);
}

function isScrollAtBottom(host: HTMLDivElement | null, scrollTop: number, localBottomScrollTop: number) {
  const safeScrollTop = Math.max(0, scrollTop);
  const safeLocalBottomScrollTop = Math.max(0, localBottomScrollTop);
  if (!host) {
    return safeScrollTop >= safeLocalBottomScrollTop - 1;
  }
  const domScrollHeight = host.scrollHeight;
  const domClientHeight = host.clientHeight;
  const domScrollable = Number.isFinite(domScrollHeight)
    && Number.isFinite(domClientHeight)
    && domScrollHeight > domClientHeight + 1;
  if (!domScrollable) {
    return safeScrollTop >= safeLocalBottomScrollTop - 1;
  }
  const domBottomDistance = Math.max(0, (domScrollHeight - domClientHeight) - safeScrollTop);
  return domBottomDistance <= 1 || safeScrollTop >= safeLocalBottomScrollTop - 1;
}

const VisibleRow = memo(function VisibleRow({
  row,
  rowIndex,
  absoluteIndex,
  rowHeight,
  cellWidthPx,
  isGap,
  theme,
  cursor,
  showAbsoluteLineNumbers = false,
  discontinuousLineNumber = false,
}: {
  row: TerminalCell[];
  rowIndex: number;
  absoluteIndex: number;
  rowHeight: string;
  cellWidthPx: number;
  isGap: boolean;
  theme: TerminalThemePreset;
  cursor: TerminalCursorState | null;
  showAbsoluteLineNumbers?: boolean;
  discontinuousLineNumber?: boolean;
}) {
  const lineNumberCell = showAbsoluteLineNumbers ? (
    <span
      data-terminal-line-number="true"
      data-terminal-line-discontinuous={discontinuousLineNumber ? 'true' : undefined}
      style={{
        display: 'inline-flex',
        width: '48px',
        minWidth: '48px',
        justifyContent: 'flex-end',
        paddingRight: '8px',
        boxSizing: 'border-box',
        color: discontinuousLineNumber ? '#ef4444' : theme.colors[8],
        opacity: 0.92,
        fontWeight: discontinuousLineNumber ? 700 : 500,
      }}
    >
      {absoluteIndex}
    </span>
  ) : null;

  if (isGap) {
    return (
      <div
        data-terminal-row="true"
        data-terminal-gap="true"
        data-terminal-index={absoluteIndex}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: rowHeight,
          lineHeight: rowHeight,
          whiteSpace: 'pre',
          color: theme.foreground,
          opacity: 0.88,
          background: 'rgba(239, 68, 68, 0.12)',
          borderTop: `1px dashed rgba(239, 68, 68, 0.42)`,
          borderBottom: `1px dashed rgba(239, 68, 68, 0.42)`,
        }}
      >
        {lineNumberCell}
        <span
          data-terminal-gap-fill="true"
          style={{
            display: 'block',
            minWidth: 0,
            flex: 1,
            height: '100%',
            background: 'rgba(239, 68, 68, 0.08)',
          }}
        />
      </div>
    );
  }

  const cursorColumn = cursor && cursor.visible && cursor.rowIndex === absoluteIndex
    ? resolveCursorCellColumn(row, cursor.col)
    : -1;

  return (
    <div
      data-terminal-row="true"
      data-terminal-index={absoluteIndex}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: rowHeight,
        lineHeight: rowHeight,
        whiteSpace: 'pre',
      }}
    >
      {lineNumberCell}
      <span style={{ display: 'inline-block', minWidth: 0, flex: 1 }}>
        {row.length > 0
          ? row.map((cell, cellIndex) => (
              <span
                key={`cell-${rowIndex}-${cellIndex}`}
                data-terminal-cursor={cursorColumn === cellIndex ? 'true' : undefined}
                style={cellStyle(cell, rowHeight, cellWidthPx, theme, cursorColumn === cellIndex)}
              >
                {cell.width === 0 ? '' : safeCodePointToString(cell.char)}
              </span>
            ))
          : ' '}
      </span>
    </div>
  );
}, (prev, next) => (
  prev.row === next.row
  && prev.rowHeight === next.rowHeight
  && prev.cellWidthPx === next.cellWidthPx
  && prev.isGap === next.isGap
  && prev.absoluteIndex === next.absoluteIndex
  && prev.theme === next.theme
  && prev.cursor?.rowIndex === next.cursor?.rowIndex
  && prev.cursor?.col === next.cursor?.col
  && prev.cursor?.visible === next.cursor?.visible
  && prev.showAbsoluteLineNumbers === next.showAbsoluteLineNumbers
  && prev.discontinuousLineNumber === next.discontinuousLineNumber
));

export function TerminalView({
  sessionId,
  initialBufferLines,
  bufferStartIndex = 0,
  bufferEndIndex,
  bufferHeadStartIndex: _bufferHeadStartIndex,
  bufferTailEndIndex,
  daemonHeadRevision = 0,
  daemonHeadEndIndex,
  bufferGapRanges = [],
  cursorKeysApp = false,
  cursor = null,
  active = false,
  bufferPullActive: _bufferPullActive = false,
  inputResetEpoch = 0,
  allowDomFocus = true,
  domInputOffscreen = false,
  onInput,
  onActivateInput,
  onResize,
  onWidthModeChange,
  onViewportChange,
  onSwipeTab,
  focusNonce = 0,
  fontSize = 14,
  rowHeight = '17px',
  themeId,
  widthMode = 'adaptive-phone',
  showAbsoluteLineNumbers = false,
}: TerminalViewProps) {
  const theme = getTerminalThemePreset(themeId);
  const swipeTabEnabled = widthMode !== 'mirror-fixed' && Boolean(onSwipeTab);
  const bufferLines = initialBufferLines || [];
  const effectiveBufferEndIndex = typeof bufferEndIndex === 'number' && Number.isFinite(bufferEndIndex)
    ? Math.max(bufferStartIndex, Math.floor(bufferEndIndex))
    : bufferStartIndex + bufferLines.length;
  const bufferTailAnchorEndIndex = typeof bufferTailEndIndex === 'number' && Number.isFinite(bufferTailEndIndex)
    ? Math.max(bufferStartIndex, Math.floor(bufferTailEndIndex))
    : effectiveBufferEndIndex;
  const daemonTailAnchorEndIndex = typeof daemonHeadEndIndex === 'number' && Number.isFinite(daemonHeadEndIndex)
    ? Math.max(bufferStartIndex, Math.floor(daemonHeadEndIndex))
    : bufferTailAnchorEndIndex;
  const followDemandAnchorEndIndex = Math.max(bufferTailAnchorEndIndex, daemonTailAnchorEndIndex);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastViewportRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastWidthModeSignalRef = useRef<{ mode: TerminalWidthMode; cols: number | null } | null>(null);
  const resizeCommitTimerRef = useRef<number | null>(null);
  const lastReportedViewportRef = useRef<string>('');
  const followScrollSyncTimerRef = useRef<number | null>(null);
  const recentViewportLayoutChangeTimerRef = useRef<number | null>(null);
  const pendingFollowRenderBottomIndexRef = useRef<number | null>(null);
  const pendingFollowScrollSyncRef = useRef(false);
  const pendingFollowViewportRealignRef = useRef(false);
  const recentViewportLayoutChangeRef = useRef(false);
  const ignoredProgrammaticScrollTopRef = useRef<number | null>(null);
  const lastSettledScrollTopRef = useRef(0);
  const hasSettledFollowFrameRef = useRef(false);
  const syncScrollHostToRenderBottomRef = useRef<(nextRenderBottomIndex: number) => void>(() => {});
  const readingModeRef = useRef(false);
  const suppressProgrammaticScrollRef = useRef(false);
  const wasActiveRef = useRef(active);
  const previousRefreshActiveRef = useRef(active);
  const previousRefreshSessionIdRef = useRef<string | null>(sessionId);
  const previousSessionIdRef = useRef<string | null>(sessionId);
  const previousInputResetEpochRef = useRef(inputResetEpoch);
  const previousFollowViewportMetricsRef = useRef<{
    viewportRows: number;
    rowHeightPx: number;
    clientHeightPx: number;
  } | null>(null);
  const touchGestureRef = useRef({
    active: false,
    pointerCaptured: false,
    axis: null as 'horizontal' | 'vertical' | null,
    startX: 0,
    startY: 0,
    deltaX: 0,
    deltaY: 0,
  });

  const [viewportRows, setViewportRows] = useState(DEFAULT_ROWS);
  const [resolvedRowHeight, setResolvedRowHeight] = useState(rowHeight);
  const [resolvedCellWidthPx, setResolvedCellWidthPx] = useState(Math.max(1, fontSize * 0.62));
  const [viewportClientHeightPx, setViewportClientHeightPx] = useState(0);
  const [renderBottomIndex, setRenderBottomIndex] = useState(effectiveBufferEndIndex);
  const [readingMode, setReadingMode] = useState(false);

  const rowHeightPx = Math.max(1, parseInt(resolvedRowHeight, 10) || parseInt(rowHeight, 10) || 17);
  const dataRowCount = Math.max(0, effectiveBufferEndIndex - bufferStartIndex);
  const minimumRenderBottomIndex = dataRowCount <= viewportRows
    ? effectiveBufferEndIndex
    : bufferStartIndex + viewportRows;
  const followVisualBottomIndex = Math.max(
    minimumRenderBottomIndex,
    Math.min(
      Math.max(minimumRenderBottomIndex, Math.floor(followDemandAnchorEndIndex || 0)),
      Math.max(minimumRenderBottomIndex, Math.floor(effectiveBufferEndIndex || 0)),
    ),
  );
  const maximumRenderBottomIndex = Math.max(minimumRenderBottomIndex, effectiveBufferEndIndex);
  const clampedRenderBottomIndex = Math.max(
    minimumRenderBottomIndex,
    Math.min(maximumRenderBottomIndex, Math.floor(renderBottomIndex || followVisualBottomIndex)),
  );
  const totalRows = Math.max(
    bufferLines.length,
    effectiveBufferEndIndex - bufferStartIndex,
    viewportRows,
  );
  const maxScrollTop = Math.max(0, (totalRows - viewportRows) * rowHeightPx);
  readingModeRef.current = readingMode;
  const followMode = !readingMode;
  const effectiveRenderBottomIndex = followMode ? followVisualBottomIndex : clampedRenderBottomIndex;
  const visibleWindowStartIndex = Math.max(bufferStartIndex, effectiveRenderBottomIndex - viewportRows);
  const visibleWindowEndIndex = Math.min(effectiveBufferEndIndex, Math.max(visibleWindowStartIndex, effectiveRenderBottomIndex));
  const visibleDataRows = Math.max(0, visibleWindowEndIndex - visibleWindowStartIndex);
  const leadingBlankRows = Math.max(0, viewportRows - visibleDataRows);
  const visibleStartOffset = Math.max(0, visibleWindowStartIndex - bufferStartIndex);
  const renderStartOffset = Math.max(0, visibleStartOffset - OVERSCAN_ROWS);
  const renderEndOffset = Math.min(totalRows, visibleStartOffset + viewportRows + OVERSCAN_ROWS);
  const visibleRows = useMemo(() => {
    const rows: Array<{ absoluteIndex: number; row: TerminalCell[]; isGap: boolean; viewportOffset: number }> = [];
    for (let dataOffset = 0; dataOffset < bufferLines.length; dataOffset += 1) {
      const viewportOffset = leadingBlankRows + dataOffset;
      if (viewportOffset < renderStartOffset || viewportOffset >= renderEndOffset) {
        continue;
      }
      const absoluteIndex = bufferStartIndex + dataOffset;
      const row = bufferLines[dataOffset] || [];
      rows.push({
        absoluteIndex,
        row,
        isGap: isGapIndex(bufferGapRanges, absoluteIndex),
        viewportOffset,
      });
    }
    return rows;
  }, [bufferGapRanges, bufferLines, bufferStartIndex, leadingBlankRows, renderEndOffset, renderStartOffset]);

  const renderRows = visibleRows;
  const termGridPaddingTopPx = renderRows.length > 0
    ? renderRows[0]!.viewportOffset * rowHeightPx
    : totalRows * rowHeightPx;
  const termGridPaddingBottomPx = renderRows.length > 0
    ? Math.max(0, totalRows - (renderRows[renderRows.length - 1]!.viewportOffset + 1)) * rowHeightPx
    : 0;

  const focusTerminal = useCallback(() => {
    if (!allowDomFocus) {
      return;
    }
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.disabled = false;
    input.readOnly = false;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [allowDomFocus]);

  const resolveScrollTopForRenderBottomIndex = useCallback((nextRenderBottomIndex: number) => {
    const topOffset = Math.max(
      0,
      Math.min(
        totalRows - viewportRows,
        Math.max(0, Math.floor(nextRenderBottomIndex) - bufferStartIndex - viewportRows),
      ),
    );
    return Math.max(0, Math.min(maxScrollTop, topOffset * rowHeightPx));
  }, [bufferStartIndex, maxScrollTop, rowHeightPx, totalRows, viewportRows]);

  const resolveRenderDemandFromScroll = useCallback((nextScrollTop: number, host?: HTMLDivElement | null) => {
    const clampedScrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
    const scrollHost = host ?? containerRef.current;
    const observedScrollTop = scrollHost ? scrollHost.scrollTop : clampedScrollTop;
    const visibleTopOffset = Math.max(0, Math.floor(clampedScrollTop / rowHeightPx));
    const nextWindowBottomIndex = dataRowCount <= viewportRows
      ? effectiveBufferEndIndex
      : Math.max(
          minimumRenderBottomIndex,
          Math.min(bufferTailAnchorEndIndex, bufferStartIndex + visibleTopOffset + viewportRows),
        );
    const nextMode: 'follow' | 'reading' = isScrollAtBottom(scrollHost, observedScrollTop, maxScrollTop)
      ? 'follow'
      : 'reading';
    const nextRenderBottomIndex = nextMode === 'follow'
      ? followVisualBottomIndex
      : nextWindowBottomIndex;
    return {
      clampedScrollTop: nextMode === 'follow'
        ? resolveScrollTopForRenderBottomIndex(nextRenderBottomIndex)
        : clampedScrollTop,
      nextMode,
      nextRenderBottomIndex,
    };
  }, [
    bufferStartIndex,
    dataRowCount,
    effectiveBufferEndIndex,
    followVisualBottomIndex,
    maxScrollTop,
    minimumRenderBottomIndex,
    resolveScrollTopForRenderBottomIndex,
    rowHeightPx,
    viewportRows,
  ]);

  const syncViewport = useCallback(() => {
    const host = containerRef.current;
    if (!host || !active || !sessionId) {
      return;
    }

    const nextViewport = measureViewport(host, fontSize, rowHeight);
    const nextClientHeight = Math.max(0, Math.round(host.clientHeight || 0));
    const viewportLayoutChanged = nextViewport.rows !== viewportRows || nextClientHeight !== viewportClientHeightPx;
    if (!readingModeRef.current && viewportLayoutChanged) {
      pendingFollowViewportRealignRef.current = true;
      if (viewportClientHeightPx > 0) {
        recentViewportLayoutChangeRef.current = true;
        if (recentViewportLayoutChangeTimerRef.current !== null) {
          window.clearTimeout(recentViewportLayoutChangeTimerRef.current);
        }
        recentViewportLayoutChangeTimerRef.current = window.setTimeout(() => {
          recentViewportLayoutChangeTimerRef.current = null;
          recentViewportLayoutChangeRef.current = false;
        }, 0);
      }
    }
    setViewportClientHeightPx((current) => {
      return current === nextClientHeight ? current : nextClientHeight;
    });
    setResolvedRowHeight((current) => current === nextViewport.resolvedRowHeight ? current : nextViewport.resolvedRowHeight);
    setResolvedCellWidthPx((current) => current === nextViewport.resolvedCellWidthPx ? current : nextViewport.resolvedCellWidthPx);
    setViewportRows((current) => current === nextViewport.rows ? current : nextViewport.rows);

    const previous = lastViewportRef.current;
    const widthSignalCols = widthMode === 'adaptive-phone' ? nextViewport.cols : null;
    const previousWidthSignal = lastWidthModeSignalRef.current;
    const shouldEmitWidthModeSignal = Boolean(
      active
      && sessionId
      && onWidthModeChange
      && (
        !previousWidthSignal
        || previousWidthSignal.mode !== widthMode
        || previousWidthSignal.cols !== widthSignalCols
      ),
    );

    if (shouldEmitWidthModeSignal) {
      lastWidthModeSignalRef.current = {
        mode: widthMode,
        cols: widthSignalCols,
      };
      onWidthModeChange?.(sessionId, widthMode, widthSignalCols);
    }

    if (previous && previous.cols === nextViewport.cols && previous.rows === nextViewport.rows) {
      return;
    }

    if (resizeCommitTimerRef.current) {
      window.clearTimeout(resizeCommitTimerRef.current);
    }

    if (widthMode === 'mirror-fixed') {
      lastViewportRef.current = { cols: nextViewport.cols, rows: nextViewport.rows };
      return;
    }

    if (previous && previous.cols === nextViewport.cols && previous.rows !== nextViewport.rows) {
      lastViewportRef.current = { cols: nextViewport.cols, rows: nextViewport.rows };
      return;
    }

    resizeCommitTimerRef.current = window.setTimeout(() => {
      lastViewportRef.current = { cols: nextViewport.cols, rows: nextViewport.rows };
      onResize?.(sessionId, nextViewport.cols, nextViewport.rows);
      resizeCommitTimerRef.current = null;
    }, 60);
  }, [active, fontSize, onResize, onWidthModeChange, rowHeight, sessionId, viewportClientHeightPx, viewportRows, widthMode]);

  const emitRenderDemand = useCallback((nextMode: 'follow' | 'reading', nextRenderBottomIndex: number, options?: {
    viewportEndIndex?: number;
  }) => {
    if (!active || !sessionId || !onViewportChange) {
      return;
    }

    const viewportEndIndex = typeof options?.viewportEndIndex === 'number'
      ? Math.max(bufferStartIndex, Math.floor(options.viewportEndIndex))
      : nextMode === 'follow'
      ? followDemandAnchorEndIndex
      : Math.max(bufferStartIndex, Math.floor(nextRenderBottomIndex));
    const key = `${nextMode}:${viewportEndIndex}:${viewportRows}`;
    if (lastReportedViewportRef.current === key) {
      return;
    }
    lastReportedViewportRef.current = key;
    onViewportChange(sessionId, {
      mode: nextMode,
      viewportEndIndex,
      viewportRows,
    });
  }, [active, bufferStartIndex, followDemandAnchorEndIndex, onViewportChange, sessionId, viewportRows]);

  const applyScrollState = useCallback((nextScrollTop: number, host?: HTMLDivElement | null) => {
    const { nextMode, nextRenderBottomIndex } = resolveRenderDemandFromScroll(nextScrollTop, host);
    readingModeRef.current = nextMode === 'reading';
    setRenderBottomIndex(nextRenderBottomIndex);
    setReadingMode(nextMode === 'reading');
    emitRenderDemand(nextMode, nextRenderBottomIndex);
  }, [emitRenderDemand, resolveRenderDemandFromScroll]);

  const syncScrollHostToRenderBottom = useCallback((nextRenderBottomIndex: number) => {
    const host = containerRef.current;
    if (!host) {
      pendingFollowScrollSyncRef.current = false;
      return;
    }

    const nextTarget = resolveDomBottomScrollTop(
      host,
      Math.max(0, resolveScrollTopForRenderBottomIndex(nextRenderBottomIndex)),
    );
    pendingFollowScrollSyncRef.current = false;
    pendingFollowViewportRealignRef.current = false;
    ignoredProgrammaticScrollTopRef.current = nextTarget;
    suppressProgrammaticScrollRef.current = true;
    if (Math.abs(host.scrollTop - nextTarget) > 1) {
      host.scrollTop = nextTarget;
    }
    suppressProgrammaticScrollRef.current = false;
    lastSettledScrollTopRef.current = nextTarget;
    hasSettledFollowFrameRef.current = true;
  }, [resolveScrollTopForRenderBottomIndex]);
  syncScrollHostToRenderBottomRef.current = syncScrollHostToRenderBottom;

  const queueFollowScrollSync = useCallback((nextRenderBottomIndex: number, options?: {
    guardPendingFollowDrift?: boolean;
  }) => {
    pendingFollowRenderBottomIndexRef.current = nextRenderBottomIndex;
    pendingFollowScrollSyncRef.current = pendingFollowScrollSyncRef.current
      || Boolean(options?.guardPendingFollowDrift);
    if (followScrollSyncTimerRef.current !== null) {
      return;
    }
    followScrollSyncTimerRef.current = window.setTimeout(() => {
      followScrollSyncTimerRef.current = null;
      const pendingRenderBottomIndex = pendingFollowRenderBottomIndexRef.current;
      pendingFollowRenderBottomIndexRef.current = null;
      if (pendingRenderBottomIndex === null) {
        return;
      }
      syncScrollHostToRenderBottomRef.current(pendingRenderBottomIndex);
    }, 0);
  }, []);

  const cancelPendingFollowScrollSync = useCallback(() => {
    if (followScrollSyncTimerRef.current !== null) {
      window.clearTimeout(followScrollSyncTimerRef.current);
      followScrollSyncTimerRef.current = null;
    }
    if (recentViewportLayoutChangeTimerRef.current !== null) {
      window.clearTimeout(recentViewportLayoutChangeTimerRef.current);
      recentViewportLayoutChangeTimerRef.current = null;
    }
    pendingFollowRenderBottomIndexRef.current = null;
    pendingFollowScrollSyncRef.current = false;
    pendingFollowViewportRealignRef.current = false;
    recentViewportLayoutChangeRef.current = false;
    ignoredProgrammaticScrollTopRef.current = null;
  }, []);

  const alignRenderBottomToFollow = useCallback((options?: {
    resetReportedViewport?: boolean;
    guardPendingFollowDrift?: boolean;
  }) => {
    const nextRenderBottomIndex = followVisualBottomIndex;
    if (options?.resetReportedViewport) {
      lastReportedViewportRef.current = '';
    }
    readingModeRef.current = false;
    setReadingMode(false);
    setRenderBottomIndex(nextRenderBottomIndex);
    queueFollowScrollSync(nextRenderBottomIndex, {
      guardPendingFollowDrift: options?.guardPendingFollowDrift,
    });
    emitRenderDemand('follow', nextRenderBottomIndex);
    return nextRenderBottomIndex;
  }, [emitRenderDemand, followVisualBottomIndex, queueFollowScrollSync]);

  const emitCurrentRenderDemand = useCallback(() => {
    const nextMode: 'follow' | 'reading' = readingModeRef.current ? 'reading' : 'follow';
    emitRenderDemand(
      nextMode,
      nextMode === 'follow' ? followVisualBottomIndex : effectiveRenderBottomIndex,
    );
  }, [effectiveRenderBottomIndex, emitRenderDemand, followVisualBottomIndex]);

  const emitReadingRenderDemand = useCallback((nextRenderBottomIndex?: number) => {
    emitRenderDemand('reading', nextRenderBottomIndex ?? effectiveRenderBottomIndex);
  }, [effectiveRenderBottomIndex, emitRenderDemand]);

  const reconcileViewportAfterBufferShift = useCallback(() => {
    if (!readingModeRef.current) {
      alignRenderBottomToFollow({ guardPendingFollowDrift: hasSettledFollowFrameRef.current });
      return;
    }

    if (effectiveRenderBottomIndex >= followVisualBottomIndex) {
      alignRenderBottomToFollow();
      return;
    }

    const nextRenderBottomIndex = Math.max(
      minimumRenderBottomIndex,
      Math.min(maximumRenderBottomIndex, Math.floor(effectiveRenderBottomIndex)),
    );
    if (maxScrollTop <= 1) {
      alignRenderBottomToFollow();
      return;
    }
    if (nextRenderBottomIndex !== effectiveRenderBottomIndex) {
      setRenderBottomIndex(nextRenderBottomIndex);
    }
    emitReadingRenderDemand(nextRenderBottomIndex);
  }, [
    alignRenderBottomToFollow,
    effectiveRenderBottomIndex,
    emitReadingRenderDemand,
    maxScrollTop,
    maximumRenderBottomIndex,
    minimumRenderBottomIndex,
    followVisualBottomIndex,
  ]);

  const emitRenderDemandSignalsForCurrentFrame = useCallback(() => {
    emitCurrentRenderDemand();
  }, [emitCurrentRenderDemand]);

  const runViewportRefresh = useCallback(() => {
    syncViewport();
  }, [syncViewport]);

  const resetTouchGesture = useCallback(() => {
    touchGestureRef.current = {
      active: false,
      pointerCaptured: false,
      axis: null,
      startX: 0,
      startY: 0,
      deltaX: 0,
      deltaY: 0,
    };
  }, []);

  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) {
      return;
    }
    previousSessionIdRef.current = sessionId;
    setReadingMode(false);
    setRenderBottomIndex(followVisualBottomIndex);
    lastReportedViewportRef.current = '';
    previousRefreshSessionIdRef.current = sessionId;
    previousInputResetEpochRef.current = inputResetEpoch;
  }, [followVisualBottomIndex, inputResetEpoch, sessionId]);

  useEffect(() => {
    const becameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!active) {
      return;
    }
    if (!becameActive) {
      return;
    }
    alignRenderBottomToFollow({ resetReportedViewport: true });
  }, [active, alignRenderBottomToFollow]);

  useEffect(() => {
    if (!active) {
      previousInputResetEpochRef.current = inputResetEpoch;
      return;
    }
    if (previousInputResetEpochRef.current === inputResetEpoch) {
      return;
    }
    previousInputResetEpochRef.current = inputResetEpoch;
    alignRenderBottomToFollow({ resetReportedViewport: true });
  }, [active, alignRenderBottomToFollow, inputResetEpoch]);

  useEffect(() => {
    const becameActive = active && !previousRefreshActiveRef.current;
    const sessionChanged = previousRefreshSessionIdRef.current !== sessionId;
    previousRefreshActiveRef.current = active;
    previousRefreshSessionIdRef.current = sessionId;
    if (!active) {
      return;
    }
    if (!becameActive && !sessionChanged) {
      return;
    }
    runViewportRefresh();
  }, [active, runViewportRefresh, sessionId]);

  useEffect(() => {
    reconcileViewportAfterBufferShift();
  }, [
    active,
    bufferGapRanges,
    bufferLines,
    bufferStartIndex,
    effectiveBufferEndIndex,
    followDemandAnchorEndIndex,
    maxScrollTop,
    reconcileViewportAfterBufferShift,
    sessionId,
    viewportRows,
  ]);

  useEffect(() => {
    if (!active || readingModeRef.current) {
      return;
    }
    queueFollowScrollSync(followVisualBottomIndex);
  }, [active, followVisualBottomIndex, queueFollowScrollSync]);

  useLayoutEffect(() => {
    if (!active || readingModeRef.current) {
      return;
    }
    const pendingRenderBottomIndex = pendingFollowRenderBottomIndexRef.current;
    if (followScrollSyncTimerRef.current !== null) {
      window.clearTimeout(followScrollSyncTimerRef.current);
      followScrollSyncTimerRef.current = null;
    }
    pendingFollowRenderBottomIndexRef.current = null;
    syncScrollHostToRenderBottom(pendingRenderBottomIndex ?? followVisualBottomIndex);
  }, [
    active,
    bufferGapRanges,
    bufferLines,
    bufferStartIndex,
    effectiveBufferEndIndex,
    followVisualBottomIndex,
    rowHeightPx,
    syncScrollHostToRenderBottom,
    viewportRows,
  ]);

  useEffect(() => {
    const previousMetrics = previousFollowViewportMetricsRef.current;
    previousFollowViewportMetricsRef.current = { viewportRows, rowHeightPx, clientHeightPx: viewportClientHeightPx };

    if (!active || readingModeRef.current) {
      return;
    }

    if (
      !previousMetrics
      || (
        previousMetrics.viewportRows === viewportRows
        && previousMetrics.rowHeightPx === rowHeightPx
        && previousMetrics.clientHeightPx === viewportClientHeightPx
      )
    ) {
      return;
    }

    syncScrollHostToRenderBottom(followVisualBottomIndex);
  }, [active, followVisualBottomIndex, rowHeightPx, syncScrollHostToRenderBottom, viewportClientHeightPx, viewportRows]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }
    runViewportRefresh();
    const observer = new ResizeObserver(() => runViewportRefresh());
    observer.observe(host);
    return () => observer.disconnect();
  }, [runViewportRefresh]);

  useEffect(() => {
    if (!active) {
      return;
    }
    emitRenderDemandSignalsForCurrentFrame();
  }, [
    active,
    bufferGapRanges,
    bufferLines,
    bufferStartIndex,
    daemonHeadRevision,
    effectiveBufferEndIndex,
    emitRenderDemandSignalsForCurrentFrame,
    followDemandAnchorEndIndex,
    viewportRows,
  ]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }

    input.disabled = !allowDomFocus;
    input.readOnly = !allowDomFocus;
    input.tabIndex = allowDomFocus ? 0 : -1;
    input.style.pointerEvents = allowDomFocus && !domInputOffscreen ? 'auto' : 'none';
    input.style.opacity = domInputOffscreen ? '0' : '0.01';
    input.style.width = domInputOffscreen ? '1px' : '140px';
    input.style.height = domInputOffscreen ? '1px' : '36px';
    input.style.left = domInputOffscreen ? '-9999px' : '50%';
    input.style.bottom = domInputOffscreen ? 'auto' : '12px';
    input.style.top = domInputOffscreen ? '0' : 'auto';
    input.style.transform = domInputOffscreen ? 'none' : 'translateX(-50%)';
    if (!allowDomFocus) {
      input.blur();
    }
  }, [allowDomFocus, domInputOffscreen]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || !allowDomFocus) {
      return;
    }

    let composing = false;
    let flushTimer: number | null = null;
    let flushRetryTimer: number | null = null;

    const sendTerminalInput = (value: string) => {
      if (!sessionId) {
        return;
      }
      onInput?.(sessionId, value);
    };

    const clearScheduledFlush = () => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (flushRetryTimer !== null) {
        window.clearTimeout(flushRetryTimer);
        flushRetryTimer = null;
      }
    };

    const flushDomInputValue = () => {
      if (composing) {
        return;
      }
      if (!input.value) {
        return;
      }
      sendTerminalInput(input.value.replace(/\n/g, '\r'));
      input.value = '';
      focusTerminal();
    };

    const scheduleFlushDomInputValue = () => {
      clearScheduledFlush();
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        flushDomInputValue();
      }, 0);
      flushRetryTimer = window.setTimeout(() => {
        flushRetryTimer = null;
        flushDomInputValue();
      }, 32);
    };

    const handleCompositionStart = () => {
      composing = true;
      input.value = '';
    };

    const handleCompositionEnd = (event: CompositionEvent) => {
      composing = false;
      if (event.data && !input.value) {
        input.value = event.data;
      }
      scheduleFlushDomInputValue();
    };

    const handleInput = () => {
      if (composing) {
        return;
      }
      flushDomInputValue();
    };

    const handleBeforeInput = (event: InputEvent) => {
      if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
        event.preventDefault();
        sendTerminalInput('\r');
        input.value = '';
        clearScheduledFlush();
        return;
      }

      if (
        event.inputType === 'insertReplacementText'
        || event.inputType === 'insertFromComposition'
        || event.inputType === 'insertCompositionText'
      ) {
        scheduleFlushDomInputValue();
      }
    };

    const handleChange = () => {
      scheduleFlushDomInputValue();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey) {
        return;
      }

      if (event.ctrlKey && event.key.length === 1) {
        const code = event.key.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) {
          event.preventDefault();
          sendTerminalInput(String.fromCharCode(code - 64));
          return;
        }
      }

      const arrows = cursorKeysApp ? APP_CURSOR_KEYS : NORMAL_CURSOR_KEYS;
      if (event.key in arrows) {
        event.preventDefault();
        sendTerminalInput(arrows[event.key as keyof typeof arrows]);
        return;
      }

      switch (event.key) {
        case 'Enter':
          event.preventDefault();
          sendTerminalInput('\r');
          input.value = '';
          return;
        case 'Backspace':
          event.preventDefault();
          sendTerminalInput('\x7f');
          input.value = '';
          return;
        case 'Tab':
          event.preventDefault();
          sendTerminalInput('\t');
          input.value = '';
          return;
        case 'Escape':
          event.preventDefault();
          sendTerminalInput('\x1b');
          input.value = '';
          return;
        default:
          return;
      }
    };

    input.addEventListener('compositionstart', handleCompositionStart);
    input.addEventListener('compositionend', handleCompositionEnd);
    input.addEventListener('beforeinput', handleBeforeInput);
    input.addEventListener('input', handleInput);
    input.addEventListener('change', handleChange);
    input.addEventListener('keydown', handleKeyDown);

    return () => {
      clearScheduledFlush();
      input.removeEventListener('compositionstart', handleCompositionStart);
      input.removeEventListener('compositionend', handleCompositionEnd);
      input.removeEventListener('beforeinput', handleBeforeInput);
      input.removeEventListener('input', handleInput);
      input.removeEventListener('change', handleChange);
      input.removeEventListener('keydown', handleKeyDown);
    };
  }, [allowDomFocus, cursorKeysApp, focusTerminal, onInput, sessionId]);

  useEffect(() => {
    if (!active || !allowDomFocus) {
      return;
    }
    focusTerminal();
  }, [active, allowDomFocus, focusNonce, focusTerminal]);

  useEffect(() => () => {
    cancelPendingFollowScrollSync();
    if (resizeCommitTimerRef.current) {
      window.clearTimeout(resizeCommitTimerRef.current);
      resizeCommitTimerRef.current = null;
    }
    resetTouchGesture();
  }, [cancelPendingFollowScrollSync, resetTouchGesture]);

  return (
    <div
      ref={containerRef}
      className="wterm"
      data-terminal-session-id={sessionId || undefined}
      data-testid={sessionId ? `terminal-view-${sessionId}` : undefined}
      data-active={active ? 'true' : 'false'}
      data-has-oninput={onInput ? 'true' : 'false'}
      data-has-onresize={onResize ? 'true' : 'false'}
      data-has-onswipetab={swipeTabEnabled ? 'true' : 'false'}
      data-width-mode={widthMode}
      onClick={() => {
        if (!sessionId) {
          return;
        }
        if (allowDomFocus) {
          focusTerminal();
          return;
        }
        onActivateInput?.(sessionId);
      }}
      onScroll={(event) => {
        if (suppressProgrammaticScrollRef.current) {
          return;
        }
        const host = event.currentTarget as HTMLDivElement;
        if (!readingModeRef.current && recentViewportLayoutChangeRef.current) {
          recentViewportLayoutChangeRef.current = false;
          if (recentViewportLayoutChangeTimerRef.current !== null) {
            window.clearTimeout(recentViewportLayoutChangeTimerRef.current);
            recentViewportLayoutChangeTimerRef.current = null;
          }
          queueFollowScrollSync(followVisualBottomIndex, {
            guardPendingFollowDrift: true,
          });
          return;
        }
        if (
          !readingModeRef.current
          && pendingFollowScrollSyncRef.current
          && pendingFollowRenderBottomIndexRef.current !== null
        ) {
          queueFollowScrollSync(pendingFollowRenderBottomIndexRef.current, {
            guardPendingFollowDrift: true,
          });
          return;
        }
        if (!readingModeRef.current && pendingFollowViewportRealignRef.current) {
          queueFollowScrollSync(followVisualBottomIndex, {
            guardPendingFollowDrift: true,
          });
          return;
        }
        if (!readingModeRef.current && pendingFollowScrollSyncRef.current) {
          const scrollTopUnchanged = Math.abs(host.scrollTop - lastSettledScrollTopRef.current) <= 1;
          if (scrollTopUnchanged) {
            return;
          }
          cancelPendingFollowScrollSync();
        }
        if (
          !readingModeRef.current
          && ignoredProgrammaticScrollTopRef.current !== null
        ) {
          if (Math.abs(host.scrollTop - ignoredProgrammaticScrollTopRef.current) <= 1) {
            ignoredProgrammaticScrollTopRef.current = null;
            lastSettledScrollTopRef.current = host.scrollTop;
            return;
          }
          ignoredProgrammaticScrollTopRef.current = null;
        }
        if (!readingModeRef.current) {
          const observedScrollTop = Math.max(0, host.scrollTop);
          const upwardAwayFromSettledBottom = observedScrollTop < lastSettledScrollTopRef.current - 1;
          const stillAtBottom = isScrollAtBottom(host, observedScrollTop, maxScrollTop);
          if (!upwardAwayFromSettledBottom && !stillAtBottom) {
            queueFollowScrollSync(followVisualBottomIndex, {
              guardPendingFollowDrift: true,
            });
            return;
          }
        }
        applyScrollState(host.scrollTop, host);
        lastSettledScrollTopRef.current = host.scrollTop;
      }}
      onTouchStart={(event) => {
        if (!active || !sessionId || !swipeTabEnabled || event.touches.length !== 1) {
          resetTouchGesture();
          return;
        }
        const touch = event.touches[0];
        touchGestureRef.current = {
          active: true,
          pointerCaptured: false,
          axis: null,
          startX: touch.clientX,
          startY: touch.clientY,
          deltaX: 0,
          deltaY: 0,
        };
      }}
      onTouchMove={(event) => {
        const gesture = touchGestureRef.current;
        if (!gesture.active || event.touches.length !== 1) {
          return;
        }
        const touch = event.touches[0];
        const deltaX = touch.clientX - gesture.startX;
        const deltaY = touch.clientY - gesture.startY;
        gesture.deltaX = deltaX;
        gesture.deltaY = deltaY;

        if (!gesture.axis) {
          if (Math.abs(deltaX) < TAB_SWIPE_LOCK_THRESHOLD_PX && Math.abs(deltaY) < TAB_SWIPE_LOCK_THRESHOLD_PX) {
            return;
          }
          gesture.axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
        }

        if (gesture.axis === 'horizontal') {
          gesture.pointerCaptured = true;
          event.preventDefault();
          return;
        }
      }}
      onTouchEnd={() => {
        const gesture = touchGestureRef.current;
        if (!gesture.active) {
          return;
        }
        const direction = gesture.axis === 'horizontal' && Math.abs(gesture.deltaX) >= TAB_SWIPE_TRIGGER_THRESHOLD_PX
          ? gesture.deltaX < 0
            ? 'next'
            : 'previous'
          : null;
        resetTouchGesture();
        if (!active || !sessionId || !swipeTabEnabled || !direction) {
          return;
        }
        onSwipeTab?.(sessionId, direction);
      }}
      onTouchCancel={() => {
        resetTouchGesture();
      }}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        backgroundColor: theme.background,
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehavior: 'contain',
        touchAction: swipeTabEnabled ? 'pan-y' : 'pan-x pan-y',
        padding: '0',
        borderRadius: '0',
        boxShadow: 'none',
        ['--term-font-family' as string]: TERMINAL_FONT_STACK,
        ['--term-font-size' as string]: `${fontSize}px`,
        ['--term-row-height' as string]: resolvedRowHeight || rowHeight,
        fontFamily: TERMINAL_FONT_STACK,
        fontSize: `${fontSize}px`,
      }}
    >
      <div className="term-grid" data-cursor-source="cursor-metadata" style={{ paddingTop: `${termGridPaddingTopPx}px`, paddingBottom: `${termGridPaddingBottomPx}px` }}>
        {renderRows.map(({ absoluteIndex, row, isGap }, rowIndex) => (
          <VisibleRow
            key={`row-${absoluteIndex}`}
            absoluteIndex={absoluteIndex}
            row={row}
            rowIndex={rowIndex}
            rowHeight={resolvedRowHeight || rowHeight}
            cellWidthPx={resolvedCellWidthPx}
            isGap={isGap}
            theme={theme}
            cursor={cursor}
            showAbsoluteLineNumbers={showAbsoluteLineNumbers}
            discontinuousLineNumber={isGap || hasDiscontinuousNeighbor(renderRows, rowIndex)}
          />
        ))}
      </div>
      <textarea
        ref={inputRef}
        data-wterm-input="true"
        data-terminal-input-session-id={sessionId || undefined}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        style={{
          position: 'absolute',
          left: '-9999px',
          top: 0,
          opacity: 0,
          width: '1px',
          height: '1px',
          border: '0',
          padding: 0,
          resize: 'none',
          background: 'transparent',
          color: 'transparent',
          caretColor: 'transparent',
        }}
      />
      <style>{`@keyframes zterm-history-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
