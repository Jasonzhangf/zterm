import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import '@jsonstudio/wtermmod-react/css';
import type { TerminalCell, TerminalSnapshot } from '../lib/types';

interface TerminalViewProps {
  sessionId: string | null;
  initialOutputHistory?: string;
  initialBufferLines?: string[];
  scrollbackStartIndex?: number;
  bufferUpdateKind?: 'replace' | 'append' | 'prepend' | 'viewport';
  bufferRevision?: number;
  snapshot?: TerminalSnapshot;
  active?: boolean;
  allowDomFocus?: boolean;
  domInputOffscreen?: boolean;
  resumeNonce?: number;
  onInput?: (data: string) => void;
  onHorizontalSwipeStart?: () => void;
  onHorizontalSwipeMove?: (deltaX: number) => void;
  onHorizontalSwipeEnd?: (deltaX: number, completed: boolean) => void;
  onBufferLinesChange?: (sessionId: string, lines: string[]) => void;
  onTitleChange?: (title: string) => void;
  onResize?: (cols: number, rows: number) => void;
  focusNonce?: number;
  forceScrollToBottomNonce?: number;
  fontSize?: number;
  rowHeight?: string;
}

const DEFAULT_ROWS = 24;
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
const DEFAULT_COLOR = 256;
const FLAG_BOLD = 0x01;
const FLAG_DIM = 0x02;
const FLAG_ITALIC = 0x04;
const FLAG_UNDERLINE = 0x08;
const FLAG_REVERSE = 0x20;
const FLAG_INVISIBLE = 0x40;
const FLAG_STRIKETHROUGH = 0x80;
const TERMINAL_FONT_STACK = [
  '"Sarasa Mono SC"',
  '"Sarasa Term SC"',
  '"Noto Sans Mono CJK SC"',
  '"Noto Sans CJK SC"',
  '"Source Han Sans SC"',
  '"Droid Sans Fallback"',
  '"PingFang SC"',
  '"Microsoft YaHei UI"',
  '"Roboto Mono"',
  '"Menlo"',
  '"Consolas"',
  'monospace',
].join(', ');
const ENABLE_DEBUG_OVERLAY = false;

function colorToCSS(index: number): string | null {
  if (index === DEFAULT_COLOR) return null;
  if (index < 16) return `var(--term-color-${index})`;
  if (index < 232) {
    const n = index - 16;
    const r = Math.floor(n / 36) * 51;
    const g = (Math.floor(n / 6) % 6) * 51;
    const b = (n % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  const level = (index - 232) * 10 + 8;
  return `rgb(${level},${level},${level})`;
}

function resolveColors(cell: TerminalCell) {
  let fg = cell.fg;
  let bg = cell.bg;

  if (cell.flags & FLAG_REVERSE) {
    [fg, bg] = [bg, fg];
    if (fg === DEFAULT_COLOR) fg = 0;
    if (bg === DEFAULT_COLOR) bg = 7;
  }

  return {
    fg: colorToCSS(fg) || 'var(--term-fg)',
    bg: colorToCSS(bg) || 'transparent',
  };
}

function buildFallbackViewport(lines: string[]) {
  return lines.map((line) =>
    Array.from(line).map((char) => ({
      char: char.codePointAt(0) || 32,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    } satisfies TerminalCell)),
  );
}

function cellStyle(cell: TerminalCell, rowHeight: string) {
  const colors = resolveColors(cell);
  const style: Record<string, string> = {
    display: 'inline-block',
    height: rowHeight,
    lineHeight: rowHeight,
    verticalAlign: 'top',
    overflow: 'hidden',
    whiteSpace: 'pre',
    width: cell.width === 2 ? '2ch' : cell.width === 0 ? '0px' : '1ch',
  };

  if (cell.width === 0) {
    return style;
  }

  style.color = colors.fg;
  style.background = colors.bg;

  if (cell.flags & FLAG_BOLD) {
    style.fontWeight = '700';
  }
  if (cell.flags & FLAG_DIM) {
    style.opacity = '0.5';
  }
  if (cell.flags & FLAG_ITALIC) {
    style.fontStyle = 'italic';
  }

  const decorations: string[] = [];
  if (cell.flags & FLAG_UNDERLINE) {
    decorations.push('underline');
  }
  if (cell.flags & FLAG_STRIKETHROUGH) {
    decorations.push('line-through');
  }
  if (decorations.length > 0) {
    style.textDecoration = decorations.join(' ');
  }

  if (cell.flags & FLAG_INVISIBLE) {
    style.visibility = 'hidden';
  }

  return style;
}

interface ViewportRowProps {
  row: TerminalCell[];
  rowIndex: number;
  rowHeight: string;
  cursorVisible: boolean;
  cursorCol: number | null;
}

const ViewportRow = memo(function ViewportRow({
  row,
  rowIndex,
  rowHeight,
  cursorVisible,
  cursorCol,
}: ViewportRowProps) {
  return (
    <div className="term-row" style={{ height: rowHeight, lineHeight: rowHeight }}>
      {row.length > 0
        ? row.map((cell, cellIndex) => {
            const isCursor = Boolean(cursorVisible && cursorCol === cellIndex);
            const content = cell.width === 0 ? '' : cell.char >= 32 ? String.fromCodePoint(cell.char) : ' ';
            const style = cellStyle(cell, rowHeight);
            if (isCursor) {
              style.outline = '1px solid var(--term-cursor)';
              style.outlineOffset = '-1px';
            }
            return (
              <span
                key={`cell-${rowIndex}-${cellIndex}`}
                className={isCursor ? 'term-cell term-cursor' : cell.width === 0 ? 'term-cell term-cell-continuation' : 'term-cell'}
                style={style}
              >
                {content}
              </span>
            );
          })
        : ' '}
    </div>
  );
}, (prev, next) => (
  prev.row === next.row
  && prev.rowHeight === next.rowHeight
  && prev.cursorVisible === next.cursorVisible
  && prev.cursorCol === next.cursorCol
));

export function TerminalView({
  sessionId,
  initialOutputHistory = '',
  initialBufferLines,
  scrollbackStartIndex,
  bufferUpdateKind = 'replace',
  bufferRevision = 0,
  snapshot,
  active = false,
  allowDomFocus = true,
  domInputOffscreen = false,
  resumeNonce = 0,
  onInput,
  onHorizontalSwipeStart,
  onHorizontalSwipeMove,
  onHorizontalSwipeEnd,
  onTitleChange: _onTitleChange,
  onResize,
  focusNonce = 0,
  forceScrollToBottomNonce = 0,
  fontSize = 14,
  rowHeight = '17px',
}: TerminalViewProps) {
  type ViewMode = 'follow' | 'reading';
  const SCROLLBACK_OVERSCAN_ROWS = 48;
  const FOLLOW_BOTTOM_THRESHOLD_PX = 2;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastViewportRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeCommitTimerRef = useRef<number | null>(null);
  const viewModeRef = useRef<ViewMode>('follow');
  const followOutputRef = useRef(true);
  const scrollLockRef = useRef(false);
  const userVerticalScrollActiveRef = useRef(false);
  const manualScrollAnchorRef = useRef<{
    absoluteTopLineIndex?: number;
    topLineOffset: number;
    intraLineOffset: number;
  } | null>(null);
  const wasActiveRef = useRef(active);
  const touchGestureRef = useRef<{
    active: boolean;
    mode: 'pending' | 'vertical' | 'horizontal';
    startX: number;
    startY: number;
    startScrollTop: number;
    deltaX: number;
    deltaY: number;
    moved: boolean;
  }>({
    active: false,
    mode: 'pending',
    startX: 0,
    startY: 0,
    startScrollTop: 0,
    deltaX: 0,
    deltaY: 0,
    moved: false,
  });
  const scrollMetricsRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
    clientHeight: number;
    bufferRevision: number;
    bufferStartIndex?: number;
    lineHeightPx: number;
  } | null>(null);
  const [resolvedRowHeight, setResolvedRowHeight] = useState(rowHeight);
  const [debugMetrics, setDebugMetrics] = useState({
    bufferLines: 0,
    scrollbackLines: 0,
    viewportRows: 0,
    scrollHeight: 0,
    clientHeight: 0,
    scrollTop: 0,
    maxScrollTop: 0,
    followOutput: true,
  });
  const [scrollViewportState, setScrollViewportState] = useState({
    topLine: 0,
    visibleRows: DEFAULT_ROWS,
  });

  const fallbackLines = useMemo(() => {
    if (initialBufferLines?.length) {
      return initialBufferLines;
    }
    return initialOutputHistory ? initialOutputHistory.split('\n') : [];
  }, [initialBufferLines, initialOutputHistory]);

  const viewportRows = snapshot?.viewport?.length ? snapshot.viewport : buildFallbackViewport(fallbackLines.slice(-DEFAULT_ROWS));
  const scrollbackLines = fallbackLines.slice(0, Math.max(0, fallbackLines.length - viewportRows.length));
  const cursor = snapshot?.cursor;
  const cursorKeysApp = snapshot?.cursorKeysApp ?? false;
  const resolvedLineHeightPx = Math.max(1, parseInt(resolvedRowHeight || rowHeight, 10) || parseInt(rowHeight, 10) || 18);
  const cursorRow = snapshot && cursor?.visible ? cursor.row : null;
  const cursorCol = snapshot && cursor?.visible ? cursor.col : null;

  const syncDebugMetrics = useCallback(() => {
    if (!ENABLE_DEBUG_OVERLAY) {
      return;
    }
    const host = containerRef.current;
    if (!host) {
      return;
    }
    const maxScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
    const nextMetrics = {
      bufferLines: fallbackLines.length,
      scrollbackLines: scrollbackLines.length,
      viewportRows: viewportRows.length,
      scrollHeight: Math.round(host.scrollHeight),
      clientHeight: Math.round(host.clientHeight),
      scrollTop: Math.round(host.scrollTop),
      maxScrollTop: Math.round(maxScrollTop),
      followOutput: followOutputRef.current,
    };
    setDebugMetrics(nextMetrics);
  }, [fallbackLines.length, scrollbackLines.length, viewportRows.length]);

  const syncScrollViewportState = useCallback((host: HTMLDivElement) => {
    const nextTopLine = Math.max(0, Math.floor(host.scrollTop / resolvedLineHeightPx));
    const nextVisibleRows = Math.max(1, Math.ceil(host.clientHeight / resolvedLineHeightPx));
    setScrollViewportState((current) =>
      current.topLine === nextTopLine && current.visibleRows === nextVisibleRows
        ? current
        : { topLine: nextTopLine, visibleRows: nextVisibleRows },
    );
  }, [resolvedLineHeightPx]);

  const updateManualScrollAnchor = useCallback((host: HTMLDivElement) => {
    const topLineOffset = Math.max(0, Math.floor(host.scrollTop / resolvedLineHeightPx));
    const intraLineOffset = host.scrollTop - topLineOffset * resolvedLineHeightPx;
    manualScrollAnchorRef.current = {
      absoluteTopLineIndex:
        scrollbackStartIndex !== undefined
          ? scrollbackStartIndex + topLineOffset
          : undefined,
      topLineOffset,
      intraLineOffset,
    };
  }, [resolvedLineHeightPx, scrollbackStartIndex]);

  const setViewMode = useCallback((mode: ViewMode) => {
    viewModeRef.current = mode;
    followOutputRef.current = mode === 'follow';
    scrollLockRef.current = mode !== 'follow';
    if (mode === 'follow') {
      manualScrollAnchorRef.current = null;
    }
  }, []);

  const updateFollowOutputFromHost = useCallback((host: HTMLDivElement) => {
    const maxScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
    const distanceFromBottom = Math.max(0, maxScrollTop - host.scrollTop);
    const shouldKeepReading =
      userVerticalScrollActiveRef.current
      || viewModeRef.current === 'reading';

    if (distanceFromBottom > FOLLOW_BOTTOM_THRESHOLD_PX || shouldKeepReading && distanceFromBottom > 0) {
      setViewMode('reading');
      updateManualScrollAnchor(host);
    } else {
      setViewMode('follow');
    }
    syncScrollViewportState(host);
    if (scrollMetricsRef.current) {
      scrollMetricsRef.current = {
        ...scrollMetricsRef.current,
        scrollTop: host.scrollTop,
        scrollHeight: host.scrollHeight,
        clientHeight: host.clientHeight,
        bufferStartIndex: scrollbackStartIndex,
        lineHeightPx: resolvedLineHeightPx,
      };
    }
    syncDebugMetrics();
  }, [resolvedLineHeightPx, scrollbackStartIndex, setViewMode, syncDebugMetrics, syncScrollViewportState, updateManualScrollAnchor]);

  useLayoutEffect(() => {
    if (!active) {
      return;
    }

    const host = containerRef.current;
    if (!host) {
      return;
    }

    const previous = scrollMetricsRef.current;
    const syncMetrics = () => {
      scrollMetricsRef.current = {
        scrollHeight: host.scrollHeight,
        scrollTop: host.scrollTop,
        clientHeight: host.clientHeight,
        bufferRevision,
        bufferStartIndex: scrollbackStartIndex,
        lineHeightPx: resolvedLineHeightPx,
      };
      syncScrollViewportState(host);
      syncDebugMetrics();
    };
    const scrollToBottom = () => {
      host.scrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
      manualScrollAnchorRef.current = null;
    };
    const restorePreviousScrollTop = () => {
      host.scrollTop = Math.min(previous?.scrollTop ?? 0, Math.max(0, host.scrollHeight - host.clientHeight));
    };
    const restoreReadingAnchor = () => {
      const anchor = manualScrollAnchorRef.current;
      if (anchor) {
        const maxScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
        const nextTopLineOffset =
          anchor.absoluteTopLineIndex !== undefined && scrollbackStartIndex !== undefined
            ? Math.max(0, anchor.absoluteTopLineIndex - scrollbackStartIndex)
            : anchor.topLineOffset;
        host.scrollTop = Math.min(
          maxScrollTop,
          Math.max(0, nextTopLineOffset * resolvedLineHeightPx + anchor.intraLineOffset),
        );
        return;
      }

      if (!previous) {
        restorePreviousScrollTop();
        return;
      }

      const maxScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
      const previousLineHeightPx = Math.max(1, previous.lineHeightPx || resolvedLineHeightPx);
      const topLineOffset = Math.floor(previous.scrollTop / previousLineHeightPx);
      const intraLineOffset = previous.scrollTop - topLineOffset * previousLineHeightPx;

      if (previous.bufferStartIndex !== undefined && scrollbackStartIndex !== undefined) {
        const absoluteTopLineIndex = previous.bufferStartIndex + topLineOffset;
        const nextTopLineOffset = Math.max(0, absoluteTopLineIndex - scrollbackStartIndex);
        host.scrollTop = Math.min(maxScrollTop, Math.max(0, nextTopLineOffset * resolvedLineHeightPx + intraLineOffset));
        return;
      }
      host.scrollTop = Math.min(maxScrollTop, Math.max(0, previous.scrollTop));
    };
    const activated = !wasActiveRef.current;

    if (!previous) {
      scrollToBottom();
      setViewMode('follow');
      syncMetrics();
      return;
    }

    if (activated) {
      if (viewModeRef.current === 'follow') {
        scrollToBottom();
      } else {
        restoreReadingAnchor();
      }
      syncMetrics();
      return;
    }

    if (userVerticalScrollActiveRef.current) {
      host.scrollTop = Math.min(host.scrollTop, Math.max(0, host.scrollHeight - host.clientHeight));
      updateManualScrollAnchor(host);
      syncMetrics();
      return;
    }

    const shouldFollowOutput = viewModeRef.current === 'follow';
    const bufferChanged = previous.bufferRevision !== bufferRevision;
    const layoutChanged =
      previous.lineHeightPx !== resolvedLineHeightPx
      || previous.clientHeight !== host.clientHeight
      || previous.bufferStartIndex !== scrollbackStartIndex;

    if (shouldFollowOutput) {
      scrollToBottom();
    } else if (bufferChanged || layoutChanged) {
      restoreReadingAnchor();
    }

    syncMetrics();
  }, [
    active,
    bufferRevision,
    bufferUpdateKind,
    resolvedLineHeightPx,
    rowHeight,
    setViewMode,
    scrollbackLines.length,
    scrollbackStartIndex,
    syncDebugMetrics,
    syncScrollViewportState,
    viewportRows.length,
  ]);

  useEffect(() => {
    wasActiveRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!active || !forceScrollToBottomNonce) {
      return;
    }

    const host = containerRef.current;
    if (!host) {
      return;
    }

    setViewMode('follow');
    host.scrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
    scrollMetricsRef.current = {
      scrollHeight: host.scrollHeight,
      scrollTop: host.scrollTop,
      clientHeight: host.clientHeight,
      bufferRevision,
      bufferStartIndex: scrollbackStartIndex,
      lineHeightPx: resolvedLineHeightPx,
    };
    syncScrollViewportState(host);
    syncDebugMetrics();
  }, [active, bufferRevision, forceScrollToBottomNonce, resolvedLineHeightPx, scrollbackStartIndex, setViewMode, syncDebugMetrics, syncScrollViewportState]);

  const focusTerminal = useCallback(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.disabled = false;
    input.readOnly = false;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, []);

  const syncTerminalMetrics = useCallback(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }

    const probe = document.createElement('span');
    probe.textContent = 'W';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.fontFamily = TERMINAL_FONT_STACK;
    probe.style.fontSize = `${fontSize}px`;
    probe.style.lineHeight = '1.4';
    host.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();

    if (!rect.width || !rect.height) {
      return;
    }

    const measuredRowHeight = Math.max(Math.ceil(rect.height), parseInt(rowHeight, 10) || 0);
    const nextRowHeight = `${measuredRowHeight}px`;
    setResolvedRowHeight((current) => (current === nextRowHeight ? current : nextRowHeight));

    const colsFromViewport = Math.max(1, Math.floor(host.clientWidth / rect.width));
    const rowsFromViewport = Math.max(1, Math.floor(host.clientHeight / measuredRowHeight));
    const previousViewport = lastViewportRef.current;
    if (!previousViewport || previousViewport.cols !== colsFromViewport || previousViewport.rows !== rowsFromViewport) {
      if (resizeCommitTimerRef.current) {
        window.clearTimeout(resizeCommitTimerRef.current);
      }
      resizeCommitTimerRef.current = window.setTimeout(() => {
        lastViewportRef.current = { cols: colsFromViewport, rows: rowsFromViewport };
        onResize?.(colsFromViewport, rowsFromViewport);
        resizeCommitTimerRef.current = null;
      }, 90);
    }
  }, [fontSize, onResize, rowHeight]);

  useEffect(() => {
    if (!allowDomFocus || !active) {
      return;
    }
    focusTerminal();
  }, [active, allowDomFocus, focusNonce, focusTerminal]);

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
        onInput?.(value);
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
        onInput?.(input.value.replace(/\n/g, '\r'));
        input.value = '';
        focusTerminal();
      }
    };

    const handleBeforeInput = (event: InputEvent) => {
      if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
        event.preventDefault();
        onInput?.('\r');
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
          onInput?.(String.fromCharCode(code - 64));
          return;
        }
      }

      const arrows = cursorKeysApp ? APP_CURSOR_KEYS : NORMAL_CURSOR_KEYS;
      if (event.key in arrows) {
        event.preventDefault();
        onInput?.(arrows[event.key as keyof typeof arrows]);
        return;
      }

      switch (event.key) {
        case 'Enter':
          event.preventDefault();
          onInput?.('\r');
          input.value = '';
          return;
        case 'Backspace':
          event.preventDefault();
          onInput?.('\x7f');
          input.value = '';
          return;
        case 'Tab':
          event.preventDefault();
          onInput?.('\t');
          input.value = '';
          return;
        case 'Escape':
          event.preventDefault();
          onInput?.('\x1b');
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
  }, [cursorKeysApp, focusTerminal, onInput]);

  useEffect(() => {
    lastViewportRef.current = null;
    if (resizeCommitTimerRef.current) {
      window.clearTimeout(resizeCommitTimerRef.current);
      resizeCommitTimerRef.current = null;
    }
  }, [sessionId, resumeNonce, fontSize]);

  useEffect(() => () => {
    if (resizeCommitTimerRef.current) {
      window.clearTimeout(resizeCommitTimerRef.current);
      resizeCommitTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }

    lastViewportRef.current = null;
    const frameA = window.requestAnimationFrame(syncTerminalMetrics);
    const frameB = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(syncTerminalMetrics);
    });
    const timer = window.setTimeout(syncTerminalMetrics, 120);
    return () => {
      window.cancelAnimationFrame(frameA);
      window.cancelAnimationFrame(frameB);
      window.clearTimeout(timer);
    };
  }, [active, resumeNonce, sessionId, syncTerminalMetrics]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(syncTerminalMetrics);
    return () => window.cancelAnimationFrame(frame);
  }, [fontSize, resumeNonce, sessionId, syncTerminalMetrics]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }

    const observer = new ResizeObserver(() => syncTerminalMetrics());
    observer.observe(host);
    return () => observer.disconnect();
  }, [sessionId, syncTerminalMetrics]);

  const renderedScrollbackRange = useMemo(() => {
    const renderStart = Math.max(0, scrollViewportState.topLine - SCROLLBACK_OVERSCAN_ROWS);
    const renderEnd = Math.min(
      scrollbackLines.length,
      scrollViewportState.topLine + scrollViewportState.visibleRows + SCROLLBACK_OVERSCAN_ROWS,
    );
    return {
      start: renderStart,
      end: renderEnd,
    };
  }, [SCROLLBACK_OVERSCAN_ROWS, scrollViewportState.topLine, scrollViewportState.visibleRows, scrollbackLines.length]);

  const renderedScrollbackLines = useMemo(
    () => scrollbackLines.slice(renderedScrollbackRange.start, renderedScrollbackRange.end),
    [renderedScrollbackRange.end, renderedScrollbackRange.start, scrollbackLines],
  );
  const topSpacerHeightPx = renderedScrollbackRange.start * resolvedLineHeightPx;
  const bottomSpacerHeightPx = Math.max(0, (scrollbackLines.length - renderedScrollbackRange.end) * resolvedLineHeightPx);

  useEffect(() => {
    const handleViewportChange = () => {
      window.requestAnimationFrame(syncTerminalMetrics);
    };

    window.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.visualViewport?.removeEventListener('resize', handleViewportChange);
    };
  }, [syncTerminalMetrics]);

  return (
    <div
      ref={containerRef}
      className="wterm"
      onPointerDownCapture={() => {
        if (!allowDomFocus) {
          inputRef.current?.blur();
        }
      }}
      onTouchStartCapture={() => {
        if (!allowDomFocus) {
          inputRef.current?.blur();
        }
      }}
      onScroll={() => {
        const host = containerRef.current;
        if (!host) {
          return;
        }
        updateFollowOutputFromHost(host);
      }}
      onTouchStart={(event) => {
        if (event.touches.length !== 1) {
          touchGestureRef.current.active = false;
          return;
        }
        const host = containerRef.current;
        const touch = event.touches[0];
        if (!host || !touch) {
          touchGestureRef.current.active = false;
          return;
        }
        if (host.scrollHeight > host.clientHeight + 1) {
          setViewMode('reading');
          updateManualScrollAnchor(host);
        }
        touchGestureRef.current = {
          active: true,
          mode: 'pending',
          startX: touch.clientX,
          startY: touch.clientY,
          startScrollTop: host.scrollTop,
          deltaX: 0,
          deltaY: 0,
          moved: false,
        };
      }}
      onTouchMove={(event) => {
        const host = containerRef.current;
        const touch = event.touches[0];
        const gesture = touchGestureRef.current;
        if (!host || !touch || !gesture.active || event.touches.length !== 1) {
          return;
        }
        const deltaX = touch.clientX - gesture.startX;
        const deltaY = touch.clientY - gesture.startY;
        gesture.deltaX = deltaX;
        gesture.deltaY = deltaY;

        if (gesture.mode === 'pending') {
          if (Math.abs(deltaX) < 6 && Math.abs(deltaY) < 6) {
            return;
          }

          if (Math.abs(deltaY) >= Math.abs(deltaX)) {
            gesture.mode = 'vertical';
            gesture.startY = touch.clientY;
            gesture.startScrollTop = host.scrollTop;
            setViewMode('reading');
            updateManualScrollAnchor(host);
          } else {
            gesture.mode = 'horizontal';
            gesture.startX = touch.clientX;
            onHorizontalSwipeStart?.();
          }
        }

        if (gesture.mode === 'vertical') {
          if (host.scrollHeight <= host.clientHeight + 1) {
            return;
          }
          const nextDeltaY = touch.clientY - gesture.startY;
          if (!gesture.moved && Math.abs(nextDeltaY) < 2) {
            return;
          }
          gesture.moved = true;
          userVerticalScrollActiveRef.current = true;
          const maxScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
          host.scrollTop = Math.max(0, Math.min(maxScrollTop, gesture.startScrollTop - nextDeltaY));
          updateManualScrollAnchor(host);
          updateFollowOutputFromHost(host);
          event.preventDefault();
          return;
        }

        if (gesture.mode === 'horizontal') {
          if (Math.abs(deltaX) < 8) {
            return;
          }
          gesture.moved = true;
          onHorizontalSwipeMove?.(deltaX);
          event.preventDefault();
        }
      }}
      onTouchEnd={() => {
        const gesture = touchGestureRef.current;
        userVerticalScrollActiveRef.current = false;
        if (gesture.active && gesture.mode === 'horizontal') {
          const completed = Math.abs(gesture.deltaX) >= 56 && Math.abs(gesture.deltaX) > Math.abs(gesture.deltaY);
          onHorizontalSwipeEnd?.(gesture.deltaX, completed);
        }
        touchGestureRef.current.active = false;
      }}
      onTouchCancel={() => {
        const gesture = touchGestureRef.current;
        userVerticalScrollActiveRef.current = false;
        if (gesture.active && gesture.mode === 'horizontal') {
          onHorizontalSwipeEnd?.(gesture.deltaX, false);
        }
        touchGestureRef.current.active = false;
      }}
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#000',
        overflowY: 'scroll',
        overflowX: 'hidden',
        WebkitOverflowScrolling: 'touch',
        overscrollBehaviorY: 'contain',
        overscrollBehaviorX: 'none',
        overflowAnchor: 'none',
        touchAction: 'none',
        padding: '0',
        borderRadius: '0',
        boxShadow: 'none',
        ['--term-font-family' as string]: TERMINAL_FONT_STACK,
        ['--term-font-size' as string]: `${fontSize}px`,
        ['--term-line-height' as string]: '1.4',
        ['--term-row-height' as string]: resolvedRowHeight || rowHeight,
      }}
    >
      <div className="term-grid" data-cursor-source={snapshot ? 'remote' : 'hydrated'}>
        {topSpacerHeightPx > 0 && <div aria-hidden="true" style={{ height: `${topSpacerHeightPx}px` }} />}
        {renderedScrollbackLines.map((line, index) => {
          const absoluteIndex = renderedScrollbackRange.start + index;
          return (
            <div
              key={`sb-${(scrollbackStartIndex ?? 0) + absoluteIndex}`}
              className="term-row term-scrollback-row"
              style={{ height: resolvedRowHeight || rowHeight, lineHeight: resolvedRowHeight || rowHeight }}
            >
              {line || ' '}
            </div>
          );
        })}
        {bottomSpacerHeightPx > 0 && <div aria-hidden="true" style={{ height: `${bottomSpacerHeightPx}px` }} />}
        {viewportRows.map((row, rowIndex) => (
          <ViewportRow
            key={`vp-${rowIndex}`}
            row={row}
            rowIndex={rowIndex}
            rowHeight={resolvedRowHeight || rowHeight}
            cursorVisible={cursorRow === rowIndex}
            cursorCol={cursorRow === rowIndex ? cursorCol : null}
          />
        ))}
      </div>
      {ENABLE_DEBUG_OVERLAY && (
        <div
          style={{
            position: 'absolute',
            top: '8px',
            right: '8px',
            zIndex: 5,
            padding: '6px 8px',
            borderRadius: '8px',
            background: 'rgba(0,0,0,0.72)',
            color: '#8df0a1',
            fontSize: '10px',
            lineHeight: '1.35',
            pointerEvents: 'none',
            whiteSpace: 'pre-wrap',
            textAlign: 'right',
          }}
        >
          {`lines:${debugMetrics.bufferLines}\nsb:${debugMetrics.scrollbackLines} vp:${debugMetrics.viewportRows}\nscroll:${debugMetrics.scrollTop}/${debugMetrics.maxScrollTop}\nheight:${debugMetrics.clientHeight}/${debugMetrics.scrollHeight}\nfollow:${debugMetrics.followOutput ? '1' : '0'}`}
        </div>
      )}
      <textarea
        ref={inputRef}
        data-wterm-input="true"
        aria-hidden="true"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="enter"
        inputMode="text"
        style={{
          position: 'fixed',
          caretColor: 'transparent',
          color: 'transparent',
          background: 'transparent',
          border: '0',
          padding: '0',
          margin: '0',
          outline: 'none',
          resize: 'none',
          whiteSpace: 'pre',
          fontSize: '16px',
          zIndex: 0,
        }}
      />
    </div>
  );
}
