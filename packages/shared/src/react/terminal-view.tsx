import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@jsonstudio/wtermmod-react/css';
import { getTerminalThemePreset, type TerminalThemePreset } from '../terminal/theme';
import type { TerminalCell, TerminalGapRange, TerminalRenderBufferProjection } from '../connection/types';

interface ViewState {
  mode: 'follow' | 'reading';
  viewportEndIndex: number;
  viewportRows: number;
  missingRanges?: TerminalGapRange[];
}

interface TerminalViewProps {
  sessionId: string | null;
  projection?: TerminalRenderBufferProjection;
  active?: boolean;
  allowDomFocus?: boolean;
  domInputOffscreen?: boolean;
  onInput?: (data: string) => void;
  onImagePaste?: (file: File) => void | Promise<void>;
  onResize?: (cols: number, rows: number) => void;
  onViewportChange?: (viewState: ViewState) => void;
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

function emptyProjection(): TerminalRenderBufferProjection {
  return {
    lines: [],
    gapRanges: [],
    startIndex: 0,
    endIndex: 0,
    viewportEndIndex: 0,
    cols: 80,
    rows: DEFAULT_ROWS,
    cursorKeysApp: false,
    revision: 0,
  };
}

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
    console.warn('[shared-terminal-view] Failed to render code point:', { code, error });
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

function collectIntersectingGapRanges(gapRanges: TerminalGapRange[], startIndex: number, endIndex: number) {
  if (endIndex <= startIndex) {
    return [] as TerminalGapRange[];
  }
  return gapRanges
    .map((range) => ({
      startIndex: Math.max(startIndex, range.startIndex),
      endIndex: Math.min(endIndex, range.endIndex),
    }))
    .filter((range) => range.endIndex > range.startIndex);
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
            <span key={`cell-${rowIndex}-${cellIndex}`} style={cellStyle(cell, rowHeight, theme)}>
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
  projection,
  active = false,
  allowDomFocus = true,
  domInputOffscreen = false,
  onInput,
  onImagePaste,
  onResize,
  onViewportChange,
  fontSize = 13,
  rowHeight = '16px',
  themeId,
}: TerminalViewProps) {
  const theme = getTerminalThemePreset(themeId);
  const resolvedProjection = projection || emptyProjection();
  const bufferLines = resolvedProjection.lines;
  const bufferGapRanges = resolvedProjection.gapRanges || [];
  const bufferStartIndex = resolvedProjection.startIndex || 0;
  const effectiveBufferEndIndex = Math.max(bufferStartIndex, resolvedProjection.endIndex || (bufferStartIndex + bufferLines.length));
  const authoritativeViewportEndIndex = Math.max(bufferStartIndex, resolvedProjection.viewportEndIndex || effectiveBufferEndIndex);
  const cursorKeysApp = Boolean(resolvedProjection.cursorKeysApp);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastViewportRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeCommitTimerRef = useRef<number | null>(null);
  const previousBufferStartIndexRef = useRef(bufferStartIndex);
  const previousActiveRef = useRef(active);
  const lastReportedViewportRef = useRef<string>('');
  const lastRenderableRowsRef = useRef<Array<{ absoluteIndex: number; row: TerminalCell[]; isGap: boolean }>>([]);
  const composingRef = useRef(false);

  const [viewportRows, setViewportRows] = useState(DEFAULT_ROWS);
  const [resolvedRowHeight, setResolvedRowHeight] = useState(rowHeight);
  const [scrollTop, setScrollTop] = useState(0);
  const [followMode, setFollowMode] = useState(true);

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
  const visibleStartOffset = followMode
    ? followViewportTopOffset
    : Math.max(0, Math.floor(scrollTop / rowHeightPx));
  const renderStartOffset = Math.max(0, visibleStartOffset - OVERSCAN_ROWS);
  const renderEndOffset = Math.min(totalRows, visibleStartOffset + viewportRows + OVERSCAN_ROWS);

  const visibleRows = useMemo(() => {
    const rows: Array<{ absoluteIndex: number; row: TerminalCell[]; isGap: boolean }> = [];
    for (let offset = renderStartOffset; offset < renderEndOffset; offset += 1) {
      const absoluteIndex = bufferStartIndex + offset;
      rows.push({
        absoluteIndex,
        row: bufferLines[offset] || [],
        isGap: isGapIndex(bufferGapRanges, absoluteIndex),
      });
    }
    return rows;
  }, [bufferGapRanges, bufferLines, bufferStartIndex, renderEndOffset, renderStartOffset]);

  const continuityCheck = useMemo(() => {
    const visibleWindowStartIndex = bufferStartIndex + visibleStartOffset;
    const visibleWindowEndIndex = Math.min(effectiveBufferEndIndex, visibleWindowStartIndex + viewportRows);
    const precheckStartIndex = Math.max(bufferStartIndex, visibleWindowStartIndex - viewportRows * 2);

    let visibleContinuous = true;
    let precheckContinuous = true;
    for (const range of bufferGapRanges) {
      if (range.endIndex <= precheckStartIndex || range.startIndex >= visibleWindowEndIndex) {
        continue;
      }
      precheckContinuous = false;
      if (range.endIndex > visibleWindowStartIndex && range.startIndex < visibleWindowEndIndex) {
        visibleContinuous = false;
      }
    }

    return {
      visibleContinuous,
      precheckContinuous,
      precheckStartIndex,
      visibleWindowEndIndex,
      missingRanges: collectIntersectingGapRanges(bufferGapRanges, precheckStartIndex, visibleWindowEndIndex),
    };
  }, [bufferGapRanges, bufferStartIndex, effectiveBufferEndIndex, viewportRows, visibleStartOffset]);

  const renderRows = useMemo(() => (
    continuityCheck.visibleContinuous ? visibleRows : lastRenderableRowsRef.current
  ), [continuityCheck.visibleContinuous, visibleRows]);

  const focusTerminal = useCallback(() => {
    if (!allowDomFocus || composingRef.current) {
      return;
    }
    const input = inputRef.current;
    if (!input) {
      return;
    }
    if (document.activeElement === input) {
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
      onResize?.(nextViewport.cols, nextViewport.rows);
      resizeCommitTimerRef.current = null;
    }, 60);
  }, [active, fontSize, onResize, rowHeight, sessionId]);

  const emitViewportState = useCallback((nextMode: 'follow' | 'reading', nextScrollTop: number, missingRanges?: TerminalGapRange[]) => {
    if (!active || !sessionId || !onViewportChange) {
      return;
    }

    const viewportTopOffset = Math.max(0, Math.floor(nextScrollTop / rowHeightPx));
    const viewportEndIndex = nextMode === 'follow'
      ? authoritativeViewportEndIndex
      : bufferStartIndex + Math.min(totalRows, viewportTopOffset + viewportRows);
    const key = nextMode === 'follow'
      ? `${nextMode}:${viewportRows}`
      : `${nextMode}:${viewportEndIndex}:${viewportRows}:${(missingRanges || []).map((range) => `${range.startIndex}-${range.endIndex}`).join(',')}`;
    if (lastReportedViewportRef.current === key) {
      return;
    }
    lastReportedViewportRef.current = key;
    onViewportChange({
      mode: nextMode,
      viewportEndIndex,
      viewportRows,
      missingRanges: nextMode === 'reading' ? (missingRanges || []) : [],
    });
  }, [active, authoritativeViewportEndIndex, bufferStartIndex, onViewportChange, rowHeightPx, sessionId, totalRows, viewportRows]);

  const applyScrollState = useCallback((nextScrollTop: number) => {
    const clamped = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
    setScrollTop(clamped);

    const nextVisibleStart = Math.max(0, Math.floor(clamped / rowHeightPx));
    const distanceFromBottomRows = Math.max(0, followViewportTopOffset - nextVisibleStart);
    const nextMode: 'follow' | 'reading' = distanceFromBottomRows <= 1 ? 'follow' : 'reading';
    setFollowMode(nextMode === 'follow');
    emitViewportState(nextMode, clamped);
  }, [emitViewportState, followViewportTopOffset, maxScrollTop, rowHeightPx]);

  const forceFollowViewport = useCallback(() => {
    const nextScrollTop = followViewportTopOffset * rowHeightPx;
    const host = containerRef.current;
    if (host) {
      host.scrollTop = nextScrollTop;
    }
    setFollowMode(true);
    setScrollTop(nextScrollTop);
    emitViewportState('follow', nextScrollTop);
  }, [emitViewportState, maxScrollTop]);

  useEffect(() => {
    setFollowMode(true);
    setScrollTop(0);
    lastReportedViewportRef.current = '';
  }, [sessionId]);

  useEffect(() => {
    const becameActive = active && !previousActiveRef.current;
    previousActiveRef.current = active;
    if (!becameActive) {
      return;
    }
    lastReportedViewportRef.current = '';
    forceFollowViewport();
  }, [active, forceFollowViewport]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }

    if (followMode) {
      const nextScrollTop = followViewportTopOffset * rowHeightPx;
      host.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
      emitViewportState('follow', nextScrollTop);
      previousBufferStartIndexRef.current = bufferStartIndex;
      return;
    }

    const previousStartIndex = previousBufferStartIndexRef.current;
    if (bufferStartIndex !== previousStartIndex) {
      const deltaRows = previousStartIndex - bufferStartIndex;
      const nextScrollTop = Math.max(0, host.scrollTop + deltaRows * rowHeightPx);
      host.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
      emitViewportState('reading', nextScrollTop);
    }
    previousBufferStartIndexRef.current = bufferStartIndex;
  }, [bufferStartIndex, emitViewportState, followMode, followViewportTopOffset, rowHeightPx]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const host = containerRef.current;
    if (!host) {
      return;
    }
    const frame = window.requestAnimationFrame(syncViewport);
    const timer = window.setTimeout(syncViewport, 120);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [active, sessionId, syncViewport]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }
    const observer = new ResizeObserver(() => syncViewport());
    observer.observe(host);
    return () => observer.disconnect();
  }, [syncViewport]);

  useEffect(() => {
    if (!active) {
      return;
    }
    emitViewportState(followMode ? 'follow' : 'reading', scrollTop);
  }, [active, emitViewportState, followMode, scrollTop, viewportRows]);

  useEffect(() => {
    if (!active || followMode) {
      return;
    }
    const nearTop = visibleStartOffset <= PRELOAD_MARGIN_ROWS;
    const nearBottom = followViewportTopOffset - visibleStartOffset <= PRELOAD_MARGIN_ROWS;
    if (nearTop || nearBottom) {
      emitViewportState('reading', scrollTop);
    }
  }, [active, emitViewportState, followMode, followViewportTopOffset, scrollTop, visibleStartOffset]);

  useEffect(() => {
    if (continuityCheck.visibleContinuous) {
      lastRenderableRowsRef.current = visibleRows;
    }
  }, [continuityCheck.visibleContinuous, visibleRows]);

  useEffect(() => {
    if (!active || !sessionId || followMode || continuityCheck.precheckContinuous) {
      return;
    }
    emitViewportState('reading', scrollTop, continuityCheck.missingRanges);
  }, [
    active,
    emitViewportState,
    continuityCheck.missingRanges,
    continuityCheck.precheckContinuous,
    followMode,
    sessionId,
    scrollTop,
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
    if (!input) {
      return;
    }

    let skipNextInput = false;

    const sendTerminalInput = (value: string) => {
      forceFollowViewport();
      onInput?.(value);
    };

    const handleCompositionStart = () => {
      composingRef.current = true;
      skipNextInput = false;
      input.value = '';
    };

    const handleCompositionEnd = (event: CompositionEvent) => {
      composingRef.current = false;
      const value = event.data || input.value;
      if (value) {
        skipNextInput = true;
        sendTerminalInput(value);
      }
      input.value = '';
      focusTerminal();
    };

    const handleInput = () => {
      if (composingRef.current) {
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
      if (composingRef.current) {
        return;
      }
      if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
        event.preventDefault();
        sendTerminalInput('\r');
        input.value = '';
      }
    };

    const handlePaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items || typeof onImagePaste !== 'function') {
        return;
      }
      for (const item of Array.from(items)) {
        if (!item.type.startsWith('image/')) {
          continue;
        }
        const file = item.getAsFile();
        if (!file) {
          continue;
        }
        event.preventDefault();
        void Promise.resolve(onImagePaste(file)).catch((error) => {
          window.alert(error instanceof Error ? error.message : 'Failed to paste image');
        });
        input.value = '';
        return;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (composingRef.current || event.metaKey) {
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
    input.addEventListener('paste', handlePaste);

    return () => {
      input.removeEventListener('compositionstart', handleCompositionStart);
      input.removeEventListener('compositionend', handleCompositionEnd);
      input.removeEventListener('beforeinput', handleBeforeInput);
      input.removeEventListener('input', handleInput);
      input.removeEventListener('keydown', handleKeyDown);
      input.removeEventListener('paste', handlePaste);
    };
  }, [cursorKeysApp, focusTerminal, forceFollowViewport, onImagePaste, onInput]);

  useEffect(() => {
    if (!active || !allowDomFocus) {
      return;
    }
    focusTerminal();
  }, [active, allowDomFocus, focusTerminal]);

  useEffect(() => () => {
    if (resizeCommitTimerRef.current) {
      window.clearTimeout(resizeCommitTimerRef.current);
      resizeCommitTimerRef.current = null;
    }
    composingRef.current = false;
  }, []);

  return (
    <div
      ref={containerRef}
      className="wterm"
      data-terminal-session-id={sessionId || undefined}
      onClick={focusTerminal}
      onScroll={(event) => applyScrollState((event.currentTarget as HTMLDivElement).scrollTop)}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        backgroundColor: theme.background,
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehavior: 'contain',
        padding: '0',
        borderRadius: '0',
        boxShadow: 'none',
        ['--term-font-family' as string]: TERMINAL_FONT_STACK,
        ['--term-font-size' as string]: `${fontSize}px`,
        ['--term-row-height' as string]: resolvedRowHeight || rowHeight,
        fontFamily: TERMINAL_FONT_STACK,
        fontSize: `${fontSize}px`,
        letterSpacing: '0',
        fontKerning: 'none',
        fontVariantLigatures: 'none',
        fontFeatureSettings: '"liga" 0, "calt" 0',
        textRendering: 'optimizeSpeed',
      }}
    >
      <div
        className="term-grid"
        data-cursor-source="buffer-store"
        style={{
          paddingTop: `${renderStartOffset * rowHeightPx}px`,
          paddingBottom: `${Math.max(0, totalRows - renderEndOffset) * rowHeightPx}px`,
        }}
      >
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
    </div>
  );
}
