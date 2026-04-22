import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalCell } from '../lib/types';

interface TerminalViewProps {
  sessionId: string | null;
  initialBufferLines?: TerminalCell[][];
  bufferStartIndex?: number;
  bufferViewportEndIndex?: number;
  cursorKeysApp?: boolean;
  active?: boolean;
  allowDomFocus?: boolean;
  domInputOffscreen?: boolean;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  focusNonce?: number;
  fontSize?: number;
  rowHeight?: string;
}

interface RenderRow {
  index: number;
  row: TerminalCell[];
}

const DEFAULT_ROWS = 24;
const DEFAULT_COLOR = 256;
const DEFAULT_FOREGROUND = '#d4d4d4';
const DEFAULT_BACKGROUND = '#000000';
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

function colorToCSS(index: number): string | null {
  if (index === DEFAULT_COLOR) {
    return null;
  }
  if (index < 16) {
    return ANSI_16_COLORS[index] || DEFAULT_FOREGROUND;
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

function resolveColors(inputCell: TerminalCell) {
  const cell = normalizeCell(inputCell);
  let fg = cell.fg;
  let bg = cell.bg;

  if (cell.flags & FLAG_REVERSE) {
    [fg, bg] = [bg, fg];
    if (fg === DEFAULT_COLOR) {
      fg = 0;
    }
    if (bg === DEFAULT_COLOR) {
      bg = 7;
    }
  }

  return {
    fg: colorToCSS(fg) || DEFAULT_FOREGROUND,
    bg: colorToCSS(bg) || 'transparent',
  };
}

function cellStyle(inputCell: TerminalCell, rowHeight: string) {
  const cell = normalizeCell(inputCell);
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
  if (decorations.length > 0) {
    style.textDecoration = decorations.join(' ');
  }

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
    <div
      data-terminal-row="true"
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
              style={cellStyle(cell, rowHeight)}
            >
              {cell.width === 0 ? '' : safeCodePointToString(cell.char)}
            </span>
          ))
        : ' '}
    </div>
  );
}, (prev, next) => prev.row === next.row && prev.rowHeight === next.rowHeight);

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

function deriveRenderRows(options: {
  lines: TerminalCell[][];
  startIndex: number;
  viewportEndIndex: number;
  viewportRows: number;
}): RenderRow[] {
  const viewportRows = Math.max(1, Math.floor(options.viewportRows || DEFAULT_ROWS));
  const viewportBottomIndex = Math.max(0, Math.floor(options.viewportEndIndex));
  const viewportTopIndex = Math.max(0, viewportBottomIndex - viewportRows);
  const rows: RenderRow[] = [];

  for (let index = viewportTopIndex; index < viewportBottomIndex; index += 1) {
    const rowOffset = index - options.startIndex;
    rows.push({
      index,
      row: rowOffset >= 0 && rowOffset < options.lines.length ? options.lines[rowOffset] || [] : [],
    });
  }

  return rows;
}

export function TerminalView({
  sessionId,
  initialBufferLines,
  bufferStartIndex = 0,
  bufferViewportEndIndex,
  cursorKeysApp = false,
  active = false,
  allowDomFocus = true,
  domInputOffscreen = false,
  onInput,
  onResize,
  focusNonce = 0,
  fontSize = 14,
  rowHeight = '17px',
}: TerminalViewProps) {
  const bufferLines = initialBufferLines || [];
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastViewportRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeCommitTimerRef = useRef<number | null>(null);
  const [viewportRows, setViewportRows] = useState(DEFAULT_ROWS);
  const [resolvedRowHeight, setResolvedRowHeight] = useState(rowHeight);

  const renderRows = useMemo(() => deriveRenderRows({
    lines: bufferLines,
    startIndex: bufferStartIndex,
    viewportEndIndex:
      typeof bufferViewportEndIndex === 'number' && Number.isFinite(bufferViewportEndIndex)
        ? Math.floor(bufferViewportEndIndex)
        : bufferStartIndex + bufferLines.length,
    viewportRows,
  }), [bufferLines, bufferStartIndex, bufferViewportEndIndex, viewportRows]);

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
    if (!host) {
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
  }, [fontSize, onResize, rowHeight]);

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
        onInput?.(value);
      }
      input.value = '';
      focusTerminal();
    };

    const handleInput = () => {
      if (composing || !input.value) {
        return;
      }

      const normalizedValue = input.value.replace(/\n/g, '\r');
      if (pendingComposedValue !== null) {
        if (normalizedValue === pendingComposedValue) {
          pendingComposedValue = null;
          input.value = '';
          return;
        }
        pendingComposedValue = null;
      }

      onInput?.(normalizedValue);
      input.value = '';
      focusTerminal();
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
  }, [fontSize, sessionId]);

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

    const frameA = window.requestAnimationFrame(syncViewport);
    const frameB = window.requestAnimationFrame(() => window.requestAnimationFrame(syncViewport));
    const timer = window.setTimeout(syncViewport, 120);
    return () => {
      window.cancelAnimationFrame(frameA);
      window.cancelAnimationFrame(frameB);
      window.clearTimeout(timer);
    };
  }, [active, sessionId, syncViewport]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => syncViewport());
    observer.observe(host);
    return () => observer.disconnect();
  }, [sessionId, syncViewport]);

  useEffect(() => {
    const handleViewportChange = () => {
      window.requestAnimationFrame(syncViewport);
    };

    window.addEventListener('resize', handleViewportChange);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
    };
  }, [syncViewport]);

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
      style={{
        position: 'relative',
        display: 'block',
        width: '100%',
        height: '100%',
        backgroundColor: DEFAULT_BACKGROUND,
        color: DEFAULT_FOREGROUND,
        fontFamily: TERMINAL_FONT_STACK,
        fontSize: `${fontSize}px`,
        lineHeight: rowHeight,
        overflow: 'hidden',
        overscrollBehavior: 'none',
        padding: '0',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
        }}
      >
        {renderRows.map(({ index, row }) => (
          <VisibleRow
            key={`line-${index}`}
            row={row}
            rowIndex={index}
            rowHeight={resolvedRowHeight}
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
