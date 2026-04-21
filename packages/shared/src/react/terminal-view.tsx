import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@jsonstudio/wtermmod-react/css';
import type { TerminalCell, TerminalRenderBufferProjection } from '../connection/types';

interface TerminalViewProps {
  sessionId: string | null;
  projection?: TerminalRenderBufferProjection;
  initialOutputHistory?: string;
  initialBufferLines?: string[];
  scrollbackStartIndex?: number;
  bufferRevision?: number;
  active?: boolean;
  allowDomFocus?: boolean;
  domInputOffscreen?: boolean;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  fontSize?: number;
  rowHeight?: string;
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
  '"Noto Sans CJK SC"',
  '"Source Han Sans SC"',
  '"PingFang SC"',
  '"Roboto Mono"',
  '"Menlo"',
  '"Consolas"',
  'monospace',
].join(', ');

function colorToCSS(index: number): string | null {
  if (index === DEFAULT_COLOR) return null;
  if (index < 16) return `var(--term-color-${index})`;
  if (index < 232) {
    const n = index - 16;
    const r = Math.floor(n / 36) * 51;
    const g = (Math.floor(n / 6) % 6) * 51;
    const b = (n % 6) * 51;
    return `rgb(${r}, ${g}, ${b})`;
  }
  const level = (index - 232) * 10 + 8;
  return `rgb(${level}, ${level}, ${level})`;
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

function buildCellStyle(cell: TerminalCell, rowHeight: string) {
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

interface ViewportRowProps {
  row: TerminalCell[];
  rowIndex: number;
  rowHeight: string;
  cursorVisible: boolean;
  cursorCol: number | null;
}

const ViewportRow = memo(function ViewportRow({ row, rowIndex, rowHeight, cursorVisible, cursorCol }: ViewportRowProps) {
  return (
    <div className="term-row" style={{ height: rowHeight, lineHeight: rowHeight }}>
      {row.length > 0
        ? row.map((cell, cellIndex) => {
            const isCursor = Boolean(cursorVisible && cursorCol === cellIndex);
            const style = buildCellStyle(cell, rowHeight);
            if (isCursor) {
              style.outline = '1px solid var(--term-cursor)';
              style.outlineOffset = '-1px';
            }
            return (
              <span
                key={`cell-${rowIndex}-${cellIndex}`}
                className={isCursor ? 'term-cell term-cursor' : 'term-cell'}
                style={style}
              >
                {cell.width === 0 ? '' : cell.char >= 32 ? String.fromCodePoint(cell.char) : ' '}
              </span>
            );
          })
        : ' '}
    </div>
  );
});

export function TerminalView({
  sessionId,
  projection,
  initialOutputHistory = '',
  initialBufferLines,
  scrollbackStartIndex,
  bufferRevision = 0,
  active = false,
  allowDomFocus = true,
  domInputOffscreen = false,
  onInput,
  onResize,
  fontSize = 14,
  rowHeight = '17px',
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const followOutputRef = useRef(true);
  const lastViewportRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeCommitTimerRef = useRef<number | null>(null);
  const [resolvedRowHeight, setResolvedRowHeight] = useState(rowHeight);

  const resolvedProjection = useMemo<TerminalRenderBufferProjection>(() => {
    if (projection) {
      return projection;
    }
    const lines = initialBufferLines?.length
      ? initialBufferLines
      : initialOutputHistory
        ? initialOutputHistory.split('\n')
        : [];
    return {
      lines,
      scrollbackStartIndex,
      revision: bufferRevision,
    };
  }, [bufferRevision, initialBufferLines, initialOutputHistory, projection, scrollbackStartIndex]);

  const bufferLines = useMemo(() => resolvedProjection.lines, [resolvedProjection.lines]);
  const viewportRows = useMemo(
    () => buildFallbackViewport(bufferLines.slice(-DEFAULT_ROWS)),
    [bufferLines],
  );
  const scrollbackLines = useMemo(
    () => bufferLines.slice(0, Math.max(0, bufferLines.length - viewportRows.length)),
    [bufferLines, viewportRows.length],
  );
  const resolvedScrollbackStartIndex = resolvedProjection.scrollbackStartIndex;
  const cursorRow = null;
  const cursorCol = null;
  const cursorKeysApp = false;

  const scrollToBottom = useCallback(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }
    host.scrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
  }, []);

  const syncFollowState = useCallback(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }
    const distanceFromBottom = host.scrollHeight - host.clientHeight - host.scrollTop;
    followOutputRef.current = distanceFromBottom <= 12;
  }, []);

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

    const measuredRowHeight = Math.max(Math.ceil(rect.height), parseInt(rowHeight, 10) || 0);
    const nextRowHeight = `${measuredRowHeight}px`;
    setResolvedRowHeight((current) => (current === nextRowHeight ? current : nextRowHeight));

    const cols = Math.max(1, Math.floor(host.clientWidth / rect.width));
    const rows = Math.max(1, Math.floor(host.clientHeight / measuredRowHeight));
    const previous = lastViewportRef.current;
    if (!previous || previous.cols !== cols || previous.rows !== rows) {
      if (resizeCommitTimerRef.current) {
        window.clearTimeout(resizeCommitTimerRef.current);
      }
      resizeCommitTimerRef.current = window.setTimeout(() => {
        lastViewportRef.current = { cols, rows };
        onResize?.(cols, rows);
        resizeCommitTimerRef.current = null;
      }, 90);
    }
  }, [fontSize, onResize, rowHeight]);

  useEffect(() => {
    if (!active) {
      return;
    }
    lastViewportRef.current = null;
    const frame = window.requestAnimationFrame(syncTerminalMetrics);
    const timer = window.setTimeout(syncTerminalMetrics, 120);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [active, sessionId, syncTerminalMetrics]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const host = containerRef.current;
    if (!host) {
      return;
    }
    if (followOutputRef.current) {
      scrollToBottom();
    }
  }, [active, resolvedProjection.revision, scrollToBottom, scrollbackLines.length, viewportRows.length]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }
    const observer = new ResizeObserver(() => syncTerminalMetrics());
    observer.observe(host);
    return () => observer.disconnect();
  }, [syncTerminalMetrics]);

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

  useEffect(() => () => {
    if (resizeCommitTimerRef.current) {
      window.clearTimeout(resizeCommitTimerRef.current);
      resizeCommitTimerRef.current = null;
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className="wterm"
      onClick={focusTerminal}
      onScroll={syncFollowState}
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#000',
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehavior: 'contain',
        padding: '0',
        borderRadius: '0',
        boxShadow: 'none',
        ['--term-font-family' as string]: TERMINAL_FONT_STACK,
        ['--term-font-size' as string]: `${fontSize}px`,
        ['--term-line-height' as string]: '1.4',
        ['--term-row-height' as string]: resolvedRowHeight || rowHeight,
      }}
    >
      <div className="term-grid" data-cursor-source="buffer-store">
        {scrollbackLines.map((line, index) => (
          <div
            key={`sb-${(resolvedScrollbackStartIndex ?? 0) + index}`}
            className="term-row term-scrollback-row"
            style={{ height: resolvedRowHeight || rowHeight, lineHeight: resolvedRowHeight || rowHeight }}
          >
            {line || ' '}
          </div>
        ))}
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
