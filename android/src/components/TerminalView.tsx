import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getTerminalThemePreset, type TerminalThemePreset } from '@zterm/shared';
import type {
  TerminalCell,
  TerminalFollowResetToken,
  TerminalGapRange,
  TerminalResizeHandler,
  TerminalViewportChangeHandler,
} from '../lib/types';

interface TerminalViewProps {
  sessionId: string | null;
  initialBufferLines?: TerminalCell[][];
  bufferStartIndex?: number;
  bufferEndIndex?: number;
  bufferViewportEndIndex?: number;
  bufferGapRanges?: TerminalGapRange[];
  cursorKeysApp?: boolean;
  active?: boolean;
  allowDomFocus?: boolean;
  domInputOffscreen?: boolean;
  onInput?: (sessionId: string, data: string) => void;
  onResize?: TerminalResizeHandler;
  onViewportChange?: TerminalViewportChangeHandler;
  onSwipeTab?: (sessionId: string, direction: 'previous' | 'next') => void;
  focusNonce?: number;
  followResetToken?: TerminalFollowResetToken;
  viewportLayoutNonce?: number | string;
  fontSize?: number;
  rowHeight?: string;
  themeId?: string;
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
const PRELOAD_MARGIN_ROWS = 12;
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
  } catch {
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

function resolveColors(inputCell: TerminalCell, theme: TerminalThemePreset) {
  const cell = normalizeCell(inputCell);
  let fg = cell.fg;
  let bg = cell.bg;
  const reverse = Boolean(cell.flags & FLAG_REVERSE);

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

function cellStyle(inputCell: TerminalCell, rowHeight: string, theme: TerminalThemePreset) {
  const cell = normalizeCell(inputCell);
  const colors = resolveColors(cell, theme);
  const style: Record<string, string> = {
    display: 'inline-block',
    height: rowHeight,
    lineHeight: rowHeight,
    verticalAlign: 'top',
    overflow: 'hidden',
    whiteSpace: 'pre',
    width: cell.width === 2 ? '2ch' : cell.width === 0 ? '0px' : '1ch',
    letterSpacing: '0',
    fontKerning: 'none',
    fontVariantLigatures: 'none',
    fontFeatureSettings: '"liga" 0, "calt" 0',
    textRendering: 'optimizeSpeed',
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
    };
  }

  const probe = document.createElement('span');
  probe.textContent = 'W';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'pre';
  probe.style.fontFamily = TERMINAL_FONT_STACK;
  probe.style.fontSize = `${fontSize}px`;
  probe.style.lineHeight = rowHeight;
  host.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();

  const cellWidth = Math.max(1, rect.width || fontSize * 0.62);
  const measuredRowHeight = Math.max(1, Math.ceil(rect.height || parseInt(rowHeight, 10) || 17));

  return {
    cols: Math.max(1, Math.floor(host.clientWidth / cellWidth)),
    rows: Math.max(1, Math.floor(host.clientHeight / measuredRowHeight)),
    resolvedRowHeight: `${measuredRowHeight}px`,
  };
}

function isGapIndex(gapRanges: TerminalGapRange[], absoluteIndex: number) {
  return gapRanges.some((range) => absoluteIndex >= range.startIndex && absoluteIndex < range.endIndex);
}

function resolveDomBottomScrollTop(host: HTMLDivElement, fallbackScrollTop: number) {
  const safeFallbackScrollTop = Math.max(0, fallbackScrollTop);
  const domBottomScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
  if (!Number.isFinite(domBottomScrollTop)) {
    return safeFallbackScrollTop;
  }
  return Math.min(domBottomScrollTop, safeFallbackScrollTop);
}

function resolveViewportModeFromScroll(options: {
  scrollTop: number;
  maxScrollTop: number;
  rowHeightPx: number;
  followViewportTopOffset: number;
}): { clampedScrollTop: number; mode: 'follow' | 'reading' } {
  const clampedScrollTop = Math.max(0, Math.min(options.maxScrollTop, options.scrollTop));
  const nextVisibleStart = Math.max(0, Math.floor(clampedScrollTop / options.rowHeightPx));
  const distanceFromBottomRows = Math.max(0, options.followViewportTopOffset - nextVisibleStart);
  return {
    clampedScrollTop,
    mode: distanceFromBottomRows <= 1 ? 'follow' : 'reading',
  };
}

const VisibleRow = memo(function VisibleRow({
  row,
  rowIndex,
  absoluteIndex,
  rowHeight,
  isGap,
  theme,
}: {
  row: TerminalCell[];
  rowIndex: number;
  absoluteIndex: number;
  rowHeight: string;
  isGap: boolean;
  theme: TerminalThemePreset;
}) {
  if (isGap) {
    return (
      <div
        data-terminal-row="true"
        data-terminal-gap="true"
        data-terminal-index={absoluteIndex}
        style={{
          display: 'block',
          height: rowHeight,
          lineHeight: rowHeight,
          whiteSpace: 'pre',
          color: theme.foreground,
          opacity: 0.48,
          background: `repeating-linear-gradient(90deg, ${theme.selection || 'rgba(255,255,255,0.08)'} 0 8px, transparent 8px 16px)`,
          borderTop: `1px dashed ${theme.colors[8]}`,
        }}
      >
        ⋯
      </div>
    );
  }

  return (
    <div
      data-terminal-row="true"
      data-terminal-index={absoluteIndex}
      style={{
        display: 'block',
        height: rowHeight,
        lineHeight: rowHeight,
        whiteSpace: 'pre',
      }}
    >
      {row.length > 0
        ? row.map((cell, cellIndex) => (
            <span
              key={`cell-${rowIndex}-${cellIndex}`}
              style={cellStyle(cell, rowHeight, theme)}
            >
              {cell.width === 0 ? '' : safeCodePointToString(cell.char)}
            </span>
          ))
        : ' '}
    </div>
  );
}, (prev, next) => (
  prev.row === next.row
  && prev.rowHeight === next.rowHeight
  && prev.isGap === next.isGap
  && prev.absoluteIndex === next.absoluteIndex
  && prev.theme === next.theme
));

export function TerminalView({
  sessionId,
  initialBufferLines,
  bufferStartIndex = 0,
  bufferEndIndex,
  bufferViewportEndIndex,
  bufferGapRanges = [],
  cursorKeysApp = false,
  active = false,
  allowDomFocus = true,
  domInputOffscreen = false,
  onInput,
  onResize,
  onViewportChange,
  onSwipeTab,
  focusNonce = 0,
  followResetToken = 0,
  viewportLayoutNonce = 0,
  fontSize = 14,
  rowHeight = '17px',
  themeId,
}: TerminalViewProps) {
  const theme = getTerminalThemePreset(themeId);
  const bufferLines = initialBufferLines || [];
  const effectiveBufferEndIndex = typeof bufferEndIndex === 'number' && Number.isFinite(bufferEndIndex)
    ? Math.max(bufferStartIndex, Math.floor(bufferEndIndex))
    : bufferStartIndex + bufferLines.length;
  const authoritativeViewportEndIndex = typeof bufferViewportEndIndex === 'number' && Number.isFinite(bufferViewportEndIndex)
    ? Math.max(bufferStartIndex, Math.floor(bufferViewportEndIndex))
    : effectiveBufferEndIndex;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastViewportRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeCommitTimerRef = useRef<number | null>(null);
  const followViewportAuditTimerRef = useRef<number | null>(null);
  const previousBufferStartIndexRef = useRef(bufferStartIndex);
  const lastReportedViewportRef = useRef<string>('');
  const followFlushFrameRef = useRef<number | null>(null);
  const pendingFollowScrollTopRef = useRef<number | null>(null);
  const readingModeRef = useRef(false);
  const suppressProgrammaticScrollRef = useRef(false);
  const wasActiveRef = useRef(active);
  const lastAppliedFollowResetTokenRef = useRef(followResetToken);
  const previousRefreshActiveRef = useRef(active);
  const previousRefreshSessionIdRef = useRef<string | null>(sessionId);
  const previousRefreshLayoutNonceRef = useRef<string | number>(viewportLayoutNonce);
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
  const [scrollTop, setScrollTop] = useState(0);
  const [readingMode, setReadingMode] = useState(false);

  const rowHeightPx = Math.max(1, parseInt(resolvedRowHeight, 10) || parseInt(rowHeight, 10) || 17);
  const totalRows = Math.max(
    bufferLines.length,
    effectiveBufferEndIndex - bufferStartIndex,
    authoritativeViewportEndIndex - bufferStartIndex,
    viewportRows,
  );
  const followViewportTopOffset = Math.max(
    0,
    Math.min(totalRows - viewportRows, authoritativeViewportEndIndex - bufferStartIndex - viewportRows),
  );
  const maxScrollTop = Math.max(0, (totalRows - viewportRows) * rowHeightPx);
  const currentScrollOffset = Math.max(0, Math.floor(scrollTop / rowHeightPx));
  readingModeRef.current = readingMode;
  const followMode = !readingMode;
  const visibleStartOffset = followMode
    ? followViewportTopOffset
    : currentScrollOffset;
  const renderStartOffset = Math.max(0, visibleStartOffset - OVERSCAN_ROWS);
  const renderEndOffset = Math.min(totalRows, visibleStartOffset + viewportRows + OVERSCAN_ROWS);
  const followVisibleDataRows = Math.max(
    0,
    Math.min(
      viewportRows,
      Math.max(0, authoritativeViewportEndIndex - bufferStartIndex),
    ),
  );
  const followLeadingBlankRows = followMode
    ? Math.max(0, viewportRows - followVisibleDataRows)
    : 0;
  const historyLoading = active
    && !followMode
    && visibleStartOffset <= 1
    && bufferStartIndex > 0;

  const visibleRows = useMemo(() => {
    const rows: Array<{ absoluteIndex: number; row: TerminalCell[]; isGap: boolean; viewportOffset: number }> = [];
    for (let dataOffset = 0; dataOffset < bufferLines.length; dataOffset += 1) {
      const viewportOffset = followLeadingBlankRows + dataOffset;
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
  }, [bufferGapRanges, bufferLines, bufferStartIndex, followLeadingBlankRows, renderEndOffset, renderStartOffset]);

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

  const syncViewport = useCallback(() => {
    const host = containerRef.current;
    if (!host || !active || !sessionId) {
      return;
    }

    const nextViewport = measureViewport(host, fontSize, rowHeight);
    setResolvedRowHeight((current) => current === nextViewport.resolvedRowHeight ? current : nextViewport.resolvedRowHeight);
    setViewportRows((current) => current === nextViewport.rows ? current : nextViewport.rows);

    const previous = lastViewportRef.current;
    if (previous && previous.cols === nextViewport.cols && previous.rows === nextViewport.rows) {
      return;
    }

    if (resizeCommitTimerRef.current) {
      window.clearTimeout(resizeCommitTimerRef.current);
    }

    resizeCommitTimerRef.current = window.setTimeout(() => {
      lastViewportRef.current = { cols: nextViewport.cols, rows: nextViewport.rows };
      onResize?.(sessionId, nextViewport.cols, nextViewport.rows);
      resizeCommitTimerRef.current = null;
    }, 60);
  }, [active, fontSize, onResize, rowHeight, sessionId]);

  const emitViewportState = useCallback((nextMode: 'follow' | 'reading', nextScrollTop: number) => {
    if (!active || !sessionId || !onViewportChange) {
      return;
    }

    const viewportTopOffset = Math.max(0, Math.floor(nextScrollTop / rowHeightPx));
    const viewportEndIndex = nextMode === 'follow'
      ? authoritativeViewportEndIndex
      : bufferStartIndex + Math.min(totalRows, viewportTopOffset + viewportRows);
    const key = nextMode === 'follow'
      ? `${nextMode}:${viewportRows}`
      : `${nextMode}:${viewportEndIndex}:${viewportRows}`;
    if (lastReportedViewportRef.current === key) {
      return;
    }
    lastReportedViewportRef.current = key;
    onViewportChange(sessionId, {
      mode: nextMode,
      viewportEndIndex,
      viewportRows,
    });
  }, [active, authoritativeViewportEndIndex, bufferStartIndex, onViewportChange, rowHeightPx, sessionId, totalRows, viewportRows]);

  const applyScrollState = useCallback((nextScrollTop: number) => {
    if (followFlushFrameRef.current !== null) {
      window.cancelAnimationFrame(followFlushFrameRef.current);
      followFlushFrameRef.current = null;
    }
    pendingFollowScrollTopRef.current = null;
    const { clampedScrollTop, mode: nextMode } = resolveViewportModeFromScroll({
      scrollTop: nextScrollTop,
      maxScrollTop,
      rowHeightPx,
      followViewportTopOffset,
    });
    setScrollTop(clampedScrollTop);
    setReadingMode(nextMode === 'reading');
    emitViewportState(nextMode, clampedScrollTop);
  }, [emitViewportState, followViewportTopOffset, maxScrollTop, rowHeightPx]);

  const scheduleFollowViewportSync = useCallback((nextScrollTop: number) => {
    const host = containerRef.current;
    if (host) {
      pendingFollowScrollTopRef.current = Math.max(0, nextScrollTop);
      if (followFlushFrameRef.current !== null) {
        return;
      }

      followFlushFrameRef.current = window.requestAnimationFrame(() => {
        followFlushFrameRef.current = null;
        const targetScrollTop = pendingFollowScrollTopRef.current;
        pendingFollowScrollTopRef.current = null;
        if (targetScrollTop === null) {
          return;
        }

        const nextTarget = resolveDomBottomScrollTop(host, targetScrollTop);
        suppressProgrammaticScrollRef.current = true;
        if (Math.abs(host.scrollTop - nextTarget) > 1) {
          host.scrollTop = nextTarget;
        }
        setScrollTop(nextTarget);
        window.setTimeout(() => {
          suppressProgrammaticScrollRef.current = false;
        }, 0);
      });
    }
  }, []);

  const alignViewportToFollow = useCallback((options?: { resetReportedViewport?: boolean }) => {
    const nextScrollTop = followViewportTopOffset * rowHeightPx;
    if (options?.resetReportedViewport) {
      lastReportedViewportRef.current = '';
    }
    setReadingMode(false);
    setScrollTop(nextScrollTop);
    scheduleFollowViewportSync(nextScrollTop);
    emitViewportState('follow', nextScrollTop);
    return nextScrollTop;
  }, [emitViewportState, followViewportTopOffset, rowHeightPx, scheduleFollowViewportSync]);

  const forceFollowViewport = useCallback(() => {
    alignViewportToFollow();
  }, [alignViewportToFollow]);

  const resetViewportToFollow = useCallback(() => {
    alignViewportToFollow({ resetReportedViewport: true });
  }, [alignViewportToFollow]);

  const emitCurrentViewportState = useCallback(() => {
    emitViewportState(followMode ? 'follow' : 'reading', scrollTop);
  }, [emitViewportState, followMode, scrollTop]);

  const emitReadingViewportState = useCallback((nextScrollTop?: number) => {
    emitViewportState('reading', nextScrollTop ?? scrollTop);
  }, [emitViewportState, scrollTop]);

  const anchorReadingViewportAfterPrepend = useCallback((host: HTMLDivElement, prependedRows: number) => {
    const nextScrollTop = host.scrollTop + prependedRows * rowHeightPx;
    host.scrollTop = nextScrollTop;
    setScrollTop(nextScrollTop);
    emitReadingViewportState(nextScrollTop);
  }, [emitReadingViewportState, rowHeightPx]);

  const emitReadingViewportIfNearEdge = useCallback(() => {
    if (followMode) {
      return;
    }
    const nearTop = visibleStartOffset <= PRELOAD_MARGIN_ROWS;
    const nearBottom = followViewportTopOffset - visibleStartOffset <= PRELOAD_MARGIN_ROWS;
    if (nearTop || nearBottom) {
      emitReadingViewportState();
    }
  }, [emitReadingViewportState, followMode, followViewportTopOffset, visibleStartOffset]);

  const reconcileViewportAfterBufferShift = useCallback(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }

    if (!readingModeRef.current) {
      alignViewportToFollow();
      previousBufferStartIndexRef.current = bufferStartIndex;
      return;
    }

    const previousStartIndex = previousBufferStartIndexRef.current;
    if (bufferStartIndex < previousStartIndex) {
      const prependedRows = previousStartIndex - bufferStartIndex;
      anchorReadingViewportAfterPrepend(host, prependedRows);
    }
    previousBufferStartIndexRef.current = bufferStartIndex;
  }, [alignViewportToFollow, anchorReadingViewportAfterPrepend, bufferStartIndex]);

  const emitViewportSignalsForCurrentFrame = useCallback(() => {
    emitCurrentViewportState();
    if (!readingModeRef.current) {
      return;
    }
    emitReadingViewportIfNearEdge();
  }, [emitCurrentViewportState, emitReadingViewportIfNearEdge]);

  const runViewportRefresh = useCallback((options?: {
    alignFollow?: boolean;
  }) => {
    syncViewport();
    if (options?.alignFollow && !readingModeRef.current) {
      alignViewportToFollow();
    }
  }, [alignViewportToFollow, syncViewport]);

  const scheduleViewportRefresh = useCallback((options?: {
    alignFollow?: boolean;
    timeoutMs?: number;
  }) => {
    const refreshViewport = () => runViewportRefresh(options);
    const frame = window.requestAnimationFrame(refreshViewport);
    const timer = window.setTimeout(refreshViewport, options?.timeoutMs ?? 48);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [runViewportRefresh]);

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
    setReadingMode(false);
    setScrollTop(0);
    lastReportedViewportRef.current = '';
    lastAppliedFollowResetTokenRef.current = followResetToken;
    previousRefreshSessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const becameActive = active && !wasActiveRef.current;
    const followResetChanged = active && lastAppliedFollowResetTokenRef.current !== followResetToken;
    wasActiveRef.current = active;
    if (!active) {
      return;
    }
    if (!becameActive && !followResetChanged) {
      return;
    }
    lastAppliedFollowResetTokenRef.current = followResetToken;
    resetViewportToFollow();
  }, [active, followResetToken, resetViewportToFollow]);

  useEffect(() => {
    const becameActive = active && !previousRefreshActiveRef.current;
    const sessionChanged = previousRefreshSessionIdRef.current !== sessionId;
    const layoutChanged = previousRefreshLayoutNonceRef.current !== viewportLayoutNonce;
    previousRefreshActiveRef.current = active;
    previousRefreshSessionIdRef.current = sessionId;
    previousRefreshLayoutNonceRef.current = viewportLayoutNonce;
    if (!active) {
      return;
    }
    if (!becameActive && !sessionChanged && !layoutChanged) {
      return;
    }
    return scheduleViewportRefresh({
      alignFollow: true,
      timeoutMs: layoutChanged ? 48 : 120,
    });
  }, [active, scheduleViewportRefresh, sessionId, viewportLayoutNonce]);

  useEffect(() => {
    reconcileViewportAfterBufferShift();
  }, [reconcileViewportAfterBufferShift]);

  useEffect(() => {
    if (!active || !followMode) {
      return;
    }
    if (followViewportAuditTimerRef.current !== null) {
      return;
    }
    followViewportAuditTimerRef.current = window.setTimeout(() => {
      followViewportAuditTimerRef.current = null;
      runViewportRefresh({ alignFollow: true });
    }, 72);
  }, [
    active,
    authoritativeViewportEndIndex,
    bufferLines.length,
    effectiveBufferEndIndex,
    followMode,
    runViewportRefresh,
  ]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }
    const observer = new ResizeObserver(() => runViewportRefresh({ alignFollow: true }));
    observer.observe(host);
    return () => observer.disconnect();
  }, [runViewportRefresh]);

  useEffect(() => {
    if (!active) {
      return;
    }
    emitViewportSignalsForCurrentFrame();
  }, [active, emitViewportSignalsForCurrentFrame, viewportRows]);

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
    if (!input) {
      return;
    }

    let composing = false;
    let skipNextInput = false;

    const sendTerminalInput = (value: string) => {
      forceFollowViewport();
      if (!sessionId) {
        return;
      }
      onInput?.(sessionId, value);
    };

    const handleCompositionStart = () => {
      composing = true;
      skipNextInput = false;
      input.value = '';
    };

    const handleCompositionEnd = (event: CompositionEvent) => {
      composing = false;
      const value = event.data || input.value;
      if (value) {
        skipNextInput = true;
        sendTerminalInput(value);
      }
      input.value = '';
      focusTerminal();
    };

    const handleInput = () => {
      if (composing) {
        return;
      }
      if (skipNextInput) {
        skipNextInput = false;
        input.value = '';
        return;
      }
      if (input.value) {
        sendTerminalInput(input.value.replace(/\n/g, '\r'));
        input.value = '';
        focusTerminal();
      }
    };

    const handleBeforeInput = (event: InputEvent) => {
      if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
        event.preventDefault();
        sendTerminalInput('\r');
        input.value = '';
      }
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
    input.addEventListener('keydown', handleKeyDown);

    return () => {
      input.removeEventListener('compositionstart', handleCompositionStart);
      input.removeEventListener('compositionend', handleCompositionEnd);
      input.removeEventListener('beforeinput', handleBeforeInput);
      input.removeEventListener('input', handleInput);
      input.removeEventListener('keydown', handleKeyDown);
    };
  }, [cursorKeysApp, focusTerminal, forceFollowViewport, onInput]);

  useEffect(() => {
    if (!active || !allowDomFocus) {
      return;
    }
    focusTerminal();
  }, [active, allowDomFocus, focusNonce, focusTerminal]);

  useEffect(() => () => {
    if (followFlushFrameRef.current !== null) {
      window.cancelAnimationFrame(followFlushFrameRef.current);
      followFlushFrameRef.current = null;
    }
    if (followViewportAuditTimerRef.current !== null) {
      window.clearTimeout(followViewportAuditTimerRef.current);
      followViewportAuditTimerRef.current = null;
    }
    if (resizeCommitTimerRef.current) {
      window.clearTimeout(resizeCommitTimerRef.current);
      resizeCommitTimerRef.current = null;
    }
    resetTouchGesture();
  }, [resetTouchGesture]);

  return (
    <div
      ref={containerRef}
      className="wterm"
      data-terminal-session-id={sessionId || undefined}
      onClick={focusTerminal}
      onScroll={(event) => {
        if (suppressProgrammaticScrollRef.current) {
          return;
        }
        applyScrollState((event.currentTarget as HTMLDivElement).scrollTop);
      }}
      onTouchStart={(event) => {
        if (!active || !sessionId || event.touches.length !== 1) {
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
        if (!active || !sessionId || !direction) {
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
        touchAction: 'pan-y',
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
      <div className="term-grid" data-cursor-source="buffer-store" style={{ paddingTop: `${termGridPaddingTopPx}px`, paddingBottom: `${termGridPaddingBottomPx}px` }}>
        {historyLoading ? (
          <div
            data-terminal-history-loading="true"
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              height: rowHeightPx * 2,
              color: theme.foreground,
              background: `linear-gradient(180deg, ${theme.background} 0%, rgba(0,0,0,0) 100%)`,
              fontSize: `${Math.max(11, fontSize - 1)}px`,
              opacity: 0.88,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '10px',
                height: '10px',
                borderRadius: '999px',
                border: `2px solid ${theme.colors[8]}`,
                borderTopColor: theme.foreground,
                animation: 'zterm-history-spin 0.8s linear infinite',
                boxSizing: 'border-box',
              }}
            />
            <span>加载历史…</span>
          </div>
        ) : null}
        {renderRows.map(({ absoluteIndex, row, isGap }, rowIndex) => (
          <VisibleRow
            key={`row-${absoluteIndex}`}
            absoluteIndex={absoluteIndex}
            row={row}
            rowIndex={rowIndex}
            rowHeight={resolvedRowHeight || rowHeight}
            isGap={isGap}
            theme={theme}
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
