import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalCell } from '../lib/types';

export interface TerminalDebugMetrics {
  bufferLines: number;
  renderedLines: number;
  viewportRows: number;
  resizeRows: number;
  resizeCols: number;
  clientHeight: number;
  hostBottom: number;
  hostTop: number;
  windowHeight: number;
  visualViewportHeight: number;
  gapToWindowBottom: number;
  followOutput: boolean;
  userScrollGesture: boolean;
  renderBottomIndex: number;
  bufferStartIndex: number;
  bufferEndIndex: number;
  availableStartIndex: number;
  availableEndIndex: number;
  viewportTopIndex: number;
  viewportBottomIndex: number;
  localWindowStartIndex: number;
  localWindowEndIndex: number;
  blankTopRows: number;
  lineHeightPx: number;
}

interface TerminalViewProps {
  sessionId: string | null;
  initialBufferLines?: TerminalCell[][];
  bufferStartIndex?: number;
  bufferAvailableStartIndex?: number;
  bufferAvailableEndIndex?: number;
  bufferRevision?: number;
  cursorKeysApp?: boolean;
  active?: boolean;
  allowDomFocus?: boolean;
  domInputOffscreen?: boolean;
  resumeNonce?: number;
  onInput?: (data: string) => void;
  onRequestBufferRange?: (startIndex: number, endIndex: number) => void;
  onHorizontalSwipeStart?: () => void;
  onHorizontalSwipeMove?: (deltaX: number) => void;
  onHorizontalSwipeEnd?: (deltaX: number, completed: boolean) => void;
  onTitleChange?: (title: string) => void;
  onResize?: (cols: number, rows: number) => void;
  freezeResize?: boolean;
  focusNonce?: number;
  forceScrollToBottomNonce?: number;
  fontSize?: number;
  rowHeight?: string;
  debugOverlayEnabled?: boolean;
  onDebugMetricsChange?: (metrics: TerminalDebugMetrics | null) => void;
}

const DEFAULT_ROWS = 24;
const DEFAULT_COLOR = 256;
const DEFAULT_FOREGROUND = '#d4d4d4';
const DEFAULT_BACKGROUND = '#000000';
const RANGE_REQUEST_THRESHOLD_ROWS = 8;
const ANSI_16_COLORS = [
  '#1e1e1e',
  '#f44747',
  '#6a9955',
  '#d7ba7d',
  '#569cd6',
  '#c586c0',
  '#4ec9b0',
  '#d4d4d4',
  '#808080',
  '#f44747',
  '#6a9955',
  '#d7ba7d',
  '#569cd6',
  '#c586c0',
  '#4ec9b0',
  '#ffffff',
] as const;
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
const XTERM_6X6_STEPS = [0, 95, 135, 175, 215, 255] as const;

function colorToCSS(index: number): string | null {
  if (index === DEFAULT_COLOR) return null;
  if (index < 16) return ANSI_16_COLORS[index] || DEFAULT_FOREGROUND;
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

function resolveColors(cell: TerminalCell) {
  let fg = cell.fg;
  let bg = cell.bg;

  if (cell.flags & FLAG_REVERSE) {
    [fg, bg] = [bg, fg];
    if (fg === DEFAULT_COLOR) fg = 0;
    if (bg === DEFAULT_COLOR) bg = 7;
  }

  return {
    fg: colorToCSS(fg) || DEFAULT_FOREGROUND,
    bg: colorToCSS(bg) || 'transparent',
  };
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

  if (cell.flags & FLAG_BOLD) style.fontWeight = '700';
  if (cell.flags & FLAG_DIM) style.opacity = '0.5';
  if (cell.flags & FLAG_ITALIC) style.fontStyle = 'italic';
  if (cell.flags & FLAG_INVISIBLE) style.visibility = 'hidden';

  const decorations: string[] = [];
  if (cell.flags & FLAG_UNDERLINE) decorations.push('underline');
  if (cell.flags & FLAG_STRIKETHROUGH) decorations.push('line-through');
  if (decorations.length > 0) style.textDecoration = decorations.join(' ');

  return style;
}

const VisibleRow = memo(function VisibleRow({
  row,
  rowIndex,
  rowHeight,
}: {
  row: TerminalCell[];
  rowIndex: number;
  rowHeight: string;
}) {
  return (
    <div style={{ display: 'block', height: rowHeight, lineHeight: rowHeight, whiteSpace: 'pre' }}>
      {row.length > 0
        ? row.map((cell, cellIndex) => {
            const content = cell.width === 0 ? '' : cell.char >= 32 ? String.fromCodePoint(cell.char) : ' ';
            return (
              <span key={`cell-${rowIndex}-${cellIndex}`} style={cellStyle(cell, rowHeight)}>
                {content}
              </span>
            );
          })
        : ' '}
    </div>
  );
}, (prev, next) => prev.row === next.row && prev.rowHeight === next.rowHeight);

export function TerminalView({
  sessionId,
  initialBufferLines,
  bufferStartIndex = 0,
  bufferAvailableStartIndex = 0,
  bufferAvailableEndIndex,
  bufferRevision = 0,
  cursorKeysApp = false,
  active = false,
  allowDomFocus = true,
  domInputOffscreen = false,
  resumeNonce = 0,
  onInput,
  onRequestBufferRange,
  onHorizontalSwipeStart,
  onHorizontalSwipeMove,
  onHorizontalSwipeEnd,
  onResize,
  freezeResize = false,
  focusNonce = 0,
  forceScrollToBottomNonce = 0,
  fontSize = 14,
  rowHeight = '17px',
  debugOverlayEnabled = false,
  onDebugMetricsChange,
}: TerminalViewProps) {
  const bufferLines = initialBufferLines || [];
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastViewportRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeCommitTimerRef = useRef<number | null>(null);
  const touchGestureRef = useRef<{
    active: boolean;
    mode: 'pending' | 'vertical' | 'horizontal';
    startX: number;
    startY: number;
    deltaX: number;
    deltaY: number;
    startBottomIndex: number;
  }>({
    active: false,
    mode: 'pending',
    startX: 0,
    startY: 0,
    deltaX: 0,
    deltaY: 0,
    startBottomIndex: 0,
  });

  const [resolvedRowHeight, setResolvedRowHeight] = useState(rowHeight);
  const [viewportRows, setViewportRows] = useState(DEFAULT_ROWS);
  const bufferEndIndex = bufferStartIndex + bufferLines.length;
  const availableStartIndex = bufferAvailableStartIndex;
  const availableEndIndex = typeof bufferAvailableEndIndex === 'number' && Number.isFinite(bufferAvailableEndIndex)
    ? Math.max(bufferEndIndex, Math.floor(bufferAvailableEndIndex))
    : bufferEndIndex;
  const previousBufferEndRef = useRef(bufferEndIndex);
  const [renderBottomIndex, setRenderBottomIndex] = useState(bufferEndIndex);

  const resolvedLineHeightPx = Math.max(
    1,
    parseInt(resolvedRowHeight || rowHeight, 10) || parseInt(rowHeight, 10) || 18,
  );

  const clampBottomIndex = useCallback((nextBottomIndex: number) => {
    const normalized = Math.floor(Number.isFinite(nextBottomIndex) ? nextBottomIndex : bufferEndIndex);
    return Math.max(bufferStartIndex, Math.min(bufferEndIndex, normalized));
  }, [bufferEndIndex, bufferStartIndex]);

  const forceFollowToBottom = useCallback(() => {
    setRenderBottomIndex(bufferEndIndex);
  }, [bufferEndIndex]);

  useEffect(() => {
    const previousBufferEnd = previousBufferEndRef.current;
    previousBufferEndRef.current = bufferEndIndex;
    setRenderBottomIndex((current) => {
      const normalizedCurrent = Math.max(bufferStartIndex, Math.min(previousBufferEnd, Math.floor(current)));
      if (normalizedCurrent >= previousBufferEnd) {
        return bufferEndIndex;
      }
      return clampBottomIndex(normalizedCurrent);
    });
  }, [bufferEndIndex, bufferRevision, bufferStartIndex, clampBottomIndex]);

  const clampedRenderBottomIndex = clampBottomIndex(renderBottomIndex);
  const viewportBottomIndex = clampedRenderBottomIndex;
  const viewportTopIndex = viewportBottomIndex - viewportRows;
  const localWindowStartIndex = Math.max(bufferStartIndex, viewportTopIndex);
  const localWindowEndIndex = Math.min(bufferEndIndex, viewportBottomIndex);
  const startOffset = Math.max(0, localWindowStartIndex - bufferStartIndex);
  const endOffset = Math.max(startOffset, localWindowEndIndex - bufferStartIndex);
  const visibleBufferRows = useMemo(
    () => bufferLines.slice(startOffset, endOffset),
    [bufferLines, endOffset, startOffset],
  );
  const missingTopRows = Math.max(0, localWindowStartIndex - viewportTopIndex);
  const followOutput = viewportBottomIndex >= bufferEndIndex;

  const visibleRows = useMemo(() => {
    const rows: Array<{ index: number; row: TerminalCell[] }> = [];

    for (let offset = 0; offset < missingTopRows; offset += 1) {
      rows.push({
        index: viewportTopIndex + offset,
        row: [],
      });
    }

    visibleBufferRows.forEach((row, offset) => {
      rows.push({
        index: localWindowStartIndex + offset,
        row,
      });
    });

    return rows;
  }, [localWindowStartIndex, missingTopRows, viewportTopIndex, visibleBufferRows]);

  useEffect(() => {
    if (!active || !onRequestBufferRange) {
      return;
    }

    if (bufferStartIndex <= availableStartIndex) {
      return;
    }

    if (localWindowStartIndex - bufferStartIndex > RANGE_REQUEST_THRESHOLD_ROWS) {
      return;
    }

    const requestEnd = bufferStartIndex;
    const requestStart = Math.max(availableStartIndex, bufferStartIndex - viewportRows);
    if (requestStart >= requestEnd) {
      return;
    }

    onRequestBufferRange(requestStart, requestEnd);
  }, [
    active,
    availableStartIndex,
    bufferStartIndex,
    onRequestBufferRange,
    localWindowStartIndex,
    viewportRows,
  ]);

  const syncDebugMetrics = useCallback(() => {
    if (!debugOverlayEnabled) {
      onDebugMetricsChange?.(null);
      return;
    }

    const host = containerRef.current;
    if (!host) {
      onDebugMetricsChange?.(null);
      return;
    }

    const hostRect = host.getBoundingClientRect();
    onDebugMetricsChange?.({
      bufferLines: bufferLines.length,
      renderedLines: visibleRows.length,
      viewportRows,
      resizeRows: lastViewportRef.current?.rows || 0,
      resizeCols: lastViewportRef.current?.cols || 0,
      clientHeight: Math.round(host.clientHeight),
      hostBottom: Math.round(hostRect.bottom),
      hostTop: Math.round(hostRect.top),
      windowHeight: Math.round(window.innerHeight || 0),
      visualViewportHeight: Math.round(window.visualViewport?.height || 0),
      gapToWindowBottom: Math.round(Math.max(0, (window.innerHeight || 0) - hostRect.bottom)),
      followOutput,
      userScrollGesture: touchGestureRef.current.active && touchGestureRef.current.mode === 'vertical',
      renderBottomIndex: viewportBottomIndex,
      bufferStartIndex,
      bufferEndIndex,
      availableStartIndex,
      availableEndIndex,
      viewportTopIndex,
      viewportBottomIndex,
      localWindowStartIndex,
      localWindowEndIndex,
      blankTopRows: missingTopRows,
      lineHeightPx: resolvedLineHeightPx,
    });
  }, [
    availableEndIndex,
    availableStartIndex,
    bufferEndIndex,
    bufferLines.length,
    bufferStartIndex,
    debugOverlayEnabled,
    followOutput,
    localWindowEndIndex,
    localWindowStartIndex,
    missingTopRows,
    onDebugMetricsChange,
    viewportBottomIndex,
    resolvedLineHeightPx,
    viewportRows,
    viewportTopIndex,
    visibleRows.length,
  ]);

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

    const effectiveRowHeight = Math.max(Math.ceil(rect.height), parseInt(rowHeight, 10) || 0);
    const nextRowHeight = `${effectiveRowHeight}px`;
    setResolvedRowHeight((current) => (current === nextRowHeight ? current : nextRowHeight));

    const nextViewportRows = Math.max(1, Math.floor(host.clientHeight / effectiveRowHeight));
    setViewportRows((current) => (current === nextViewportRows ? current : nextViewportRows));

    const colsFromViewport = Math.max(1, Math.floor(host.clientWidth / rect.width));
    const rowsForDaemon = nextViewportRows;
    const previousViewport = lastViewportRef.current;
    if (freezeResize && previousViewport) {
      return;
    }

    if (!previousViewport || previousViewport.cols !== colsFromViewport || previousViewport.rows !== rowsForDaemon) {
      if (resizeCommitTimerRef.current) {
        window.clearTimeout(resizeCommitTimerRef.current);
      }
      resizeCommitTimerRef.current = window.setTimeout(() => {
        lastViewportRef.current = { cols: colsFromViewport, rows: rowsForDaemon };
        onResize?.(colsFromViewport, rowsForDaemon);
        resizeCommitTimerRef.current = null;
      }, 90);
    }
  }, [fontSize, freezeResize, onResize, rowHeight]);

  useEffect(() => {
    if (!active || !forceScrollToBottomNonce) {
      return;
    }
    forceFollowToBottom();
  }, [active, forceFollowToBottom, forceScrollToBottomNonce]);

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
    let pendingComposedValue: string | null = null;

    const handleCompositionStart = () => {
      composing = true;
      pendingComposedValue = null;
      input.value = '';
    };

    const handleCompositionEnd = (event: CompositionEvent) => {
      composing = false;
      const value = event.data || input.value;
      if (value) {
        pendingComposedValue = value;
        forceFollowToBottom();
        onInput?.(value);
      }
      input.value = '';
      focusTerminal();
    };

    const handleInput = () => {
      if (composing) {
        return;
      }
      if (input.value) {
        const normalizedValue = input.value.replace(/\n/g, '\r');
        if (pendingComposedValue !== null) {
          if (normalizedValue === pendingComposedValue) {
            pendingComposedValue = null;
            input.value = '';
            return;
          }
          pendingComposedValue = null;
        }
        forceFollowToBottom();
        onInput?.(normalizedValue);
        input.value = '';
        focusTerminal();
      }
    };

    const handleBeforeInput = (event: InputEvent) => {
      if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
        event.preventDefault();
        forceFollowToBottom();
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
          forceFollowToBottom();
          onInput?.(String.fromCharCode(code - 64));
          return;
        }
      }

      const arrows = cursorKeysApp ? APP_CURSOR_KEYS : NORMAL_CURSOR_KEYS;
      if (event.key in arrows) {
        event.preventDefault();
        forceFollowToBottom();
        onInput?.(arrows[event.key as keyof typeof arrows]);
        return;
      }

      switch (event.key) {
        case 'Enter':
          event.preventDefault();
          forceFollowToBottom();
          onInput?.('\r');
          input.value = '';
          return;
        case 'Backspace':
          event.preventDefault();
          forceFollowToBottom();
          onInput?.('\x7f');
          input.value = '';
          return;
        case 'Tab':
          event.preventDefault();
          forceFollowToBottom();
          onInput?.('\t');
          input.value = '';
          return;
        case 'Escape':
          event.preventDefault();
          forceFollowToBottom();
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
  }, [cursorKeysApp, focusTerminal, forceFollowToBottom, onInput]);

  useEffect(() => {
    lastViewportRef.current = null;
    if (resizeCommitTimerRef.current) {
      window.clearTimeout(resizeCommitTimerRef.current);
      resizeCommitTimerRef.current = null;
    }
  }, [fontSize, resumeNonce, sessionId]);

  useEffect(() => () => {
    if (resizeCommitTimerRef.current) {
      window.clearTimeout(resizeCommitTimerRef.current);
      resizeCommitTimerRef.current = null;
    }
    onDebugMetricsChange?.(null);
  }, [onDebugMetricsChange]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const frameA = window.requestAnimationFrame(syncTerminalMetrics);
    const frameB = window.requestAnimationFrame(() => window.requestAnimationFrame(syncTerminalMetrics));
    const timer = window.setTimeout(syncTerminalMetrics, 120);
    return () => {
      window.cancelAnimationFrame(frameA);
      window.cancelAnimationFrame(frameB);
      window.clearTimeout(timer);
    };
  }, [active, resumeNonce, sessionId, syncTerminalMetrics]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }
    const observer = new ResizeObserver(() => syncTerminalMetrics());
    observer.observe(host);
    return () => observer.disconnect();
  }, [sessionId, syncTerminalMetrics]);

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

  useEffect(() => {
    if (!active) {
      onDebugMetricsChange?.(null);
      return;
    }
    const frame = window.requestAnimationFrame(syncDebugMetrics);
    return () => window.cancelAnimationFrame(frame);
  }, [active, bufferRevision, onDebugMetricsChange, syncDebugMetrics, viewportRows, clampedRenderBottomIndex]);

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
      onTouchStart={(event) => {
        if (event.touches.length !== 1) {
          touchGestureRef.current.active = false;
          return;
        }

        const touch = event.touches[0];
        touchGestureRef.current = {
          active: true,
          mode: 'pending',
          startX: touch.clientX,
          startY: touch.clientY,
          deltaX: 0,
          deltaY: 0,
          startBottomIndex: clampedRenderBottomIndex,
        };
      }}
      onTouchMove={(event) => {
        const touch = event.touches[0];
        const gesture = touchGestureRef.current;
        if (!touch || !gesture.active || event.touches.length !== 1) {
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
          if (Math.abs(deltaX) > Math.abs(deltaY)) {
            gesture.mode = 'horizontal';
            onHorizontalSwipeStart?.();
          } else {
            gesture.mode = 'vertical';
          }
        }

        if (gesture.mode === 'horizontal') {
          event.preventDefault();
          onHorizontalSwipeMove?.(deltaX);
          return;
        }

        if (gesture.mode === 'vertical') {
          event.preventDefault();
          const rowDelta = Math.round(deltaY / Math.max(1, resolvedLineHeightPx));
          const nextBottomIndex = clampBottomIndex(gesture.startBottomIndex + rowDelta);
          setRenderBottomIndex(nextBottomIndex);
        }
      }}
      onTouchEnd={() => {
        const gesture = touchGestureRef.current;
        if (gesture.active && gesture.mode === 'horizontal') {
          onHorizontalSwipeEnd?.(gesture.deltaX, false);
        }
        if (gesture.active && gesture.mode === 'vertical' && viewportBottomIndex >= bufferEndIndex) {
          setRenderBottomIndex(bufferEndIndex);
        }
        touchGestureRef.current.active = false;
      }}
      onTouchCancel={() => {
        const gesture = touchGestureRef.current;
        if (gesture.active && gesture.mode === 'horizontal') {
          onHorizontalSwipeEnd?.(gesture.deltaX, false);
        }
        touchGestureRef.current.active = false;
      }}
      style={{
        position: 'relative',
        display: 'block',
        width: '100%',
        height: '100%',
        backgroundColor: DEFAULT_BACKGROUND,
        color: DEFAULT_FOREGROUND,
        fontFamily: TERMINAL_FONT_STACK,
        fontSize: `${fontSize}px`,
        lineHeight: '1.4',
        overflow: 'hidden',
        overscrollBehavior: 'none',
        touchAction: 'none',
        padding: '0',
        borderRadius: '0',
        boxShadow: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          width: '100%',
          whiteSpace: 'pre',
          boxSizing: 'border-box',
        }}
      >
        {visibleRows.map(({ index, row }) => (
          <VisibleRow
            key={`line-${index}`}
            row={row}
            rowIndex={index}
            rowHeight={resolvedRowHeight || rowHeight}
          />
        ))}
      </div>
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
