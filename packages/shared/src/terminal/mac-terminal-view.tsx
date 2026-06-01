/**
 * shared Mac terminal view surface.
 *
 * Mac renders the canonical TerminalRenderBufferProjection directly as DOM rows.
 * There is no hidden terminal/mask/proxy layer: visible DOM owns rendering,
 * focus, keyboard input, scrollback and viewport demand.
 */

import { useEffect, useMemo, useRef, type KeyboardEvent, type ClipboardEvent } from 'react';
import { Terminal } from '@jsonstudio/wtermmod-react';
import type { TerminalProps as WTermTerminalProps } from '@jsonstudio/wtermmod-react';
import type { TerminalCell, TerminalRenderBufferProjection } from '../connection/types';
import { getTerminalThemePreset } from './theme';
import { NORMAL_CURSOR_KEYS, TERMINAL_FONT_STACK } from './renderer';
import { buildTerminalVisibleRowViewModel, hasDiscontinuousNeighbor } from './renderer/row';

export type { WTermTerminalProps as TerminalProps };

export interface MacTerminalViewProps {
  sessionId?: string | null;
  projection?: TerminalRenderBufferProjection;
  active?: boolean;
  allowDomFocus?: boolean;
  themeId?: string;
  showAbsoluteLineNumbers?: boolean;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onViewportChange?: (viewState: unknown) => void;
  onImagePaste?: (file: File) => Promise<void> | void;
  onWidthModeChange?: (mode: string, cols?: number | null) => void;
}

function terminalCellToText(cell: TerminalCell | null | undefined) {
  if (!cell || cell.width === 0) return '';
  return cell.char >= 32 ? String.fromCodePoint(cell.char) : ' ';
}

function terminalRowToText(row: TerminalCell[]) {
  return row.map(terminalCellToText).join('').replace(/\s+$/u, '');
}

function isGapIndex(projection: TerminalRenderBufferProjection, absoluteIndex: number) {
  return projection.gapRanges.some((range) => absoluteIndex >= range.startIndex && absoluteIndex < range.endIndex);
}

function resolveKeyInput(event: KeyboardEvent<HTMLDivElement>, cursorKeysApp: boolean) {
  if (event.metaKey) return '';
  if (event.key === 'Enter') return '\r';
  if (event.key === 'Backspace') return '\x7f';
  if (event.key === 'Tab') return '\t';
  if (event.key === 'Escape') return '\x1b';
  if (event.ctrlKey && event.key.length === 1) {
    const code = event.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  }
  if (event.key in NORMAL_CURSOR_KEYS) {
    if (!cursorKeysApp) return NORMAL_CURSOR_KEYS[event.key as keyof typeof NORMAL_CURSOR_KEYS];
    const suffix = NORMAL_CURSOR_KEYS[event.key as keyof typeof NORMAL_CURSOR_KEYS].slice(-1);
    return `\x1bO${suffix}`;
  }
  if (!event.ctrlKey && !event.altKey && event.key.length === 1) return event.key;
  return '';
}

export function MacTerminalView(props: MacTerminalViewProps) {
  const {
    projection,
    active = false,
    allowDomFocus = false,
    themeId,
    showAbsoluteLineNumbers = false,
    onInput,
    onResize,
    onViewportChange,
    onImagePaste,
    onWidthModeChange: _onWidthModeChange,
  } = props;

  const cols = projection?.cols ?? 80;
  const rows = projection?.rows ?? 24;
  const theme = getTerminalThemePreset(themeId);
  const rowHeight = '17px';
  const cellWidthPx = 8.4;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  void active;

  const renderRows = useMemo(() => {
    if (!projection) return [];
    return projection.lines.map((row, index) => ({
      row,
      absoluteIndex: projection.startIndex + index,
      isGap: isGapIndex(projection, projection.startIndex + index),
    }));
  }, [projection]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !projection) return;
    viewport.scrollTop = viewport.scrollHeight;
    onViewportChange?.({
      mode: 'follow',
      viewportEndIndex: projection.endIndex,
      viewportRows: projection.rows,
      missingRanges: [],
    });
  }, [onViewportChange, projection?.endIndex, projection?.revision, projection?.rows]);

  useEffect(() => {
    if (allowDomFocus && active) {
      hostRef.current?.focus({ preventScroll: true });
    }
  }, [active, allowDomFocus]);

  const handleScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport || !projection) return;
    const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
    onViewportChange?.({
      mode: atBottom ? 'follow' : 'reading',
      viewportEndIndex: atBottom ? projection.endIndex : Math.max(projection.startIndex, projection.endIndex - projection.rows),
      viewportRows: projection.rows,
      missingRanges: [],
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const input = resolveKeyInput(event, projection?.cursorKeysApp ?? false);
    if (!input) return;
    event.preventDefault();
    onInput?.(input);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith('image/'));
    if (image && onImagePaste) {
      event.preventDefault();
      void onImagePaste(image);
      return;
    }
    const text = event.clipboardData.getData('text/plain');
    if (text) {
      event.preventDefault();
      onInput?.(text);
    }
  };

  return (
    <div
      ref={hostRef}
      className="mac-terminal-projection"
      data-mac-terminal-projection="true"
      data-mac-terminal-input="visible-dom"
      tabIndex={allowDomFocus ? 0 : -1}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        backgroundColor: theme.background,
        color: theme.foreground,
        overflow: 'hidden',
        outline: 'none',
        fontFamily: TERMINAL_FONT_STACK,
        fontSize: '14px',
      }}
    >
      <div
        ref={viewportRef}
        data-mac-terminal-scroll="true"
        data-follow-bottom="true"
        onScroll={handleScroll}
        style={{
          width: '100%',
          height: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          padding: 0,
        }}
      >
        <div className="term-grid" data-cursor-source="projection">
          {renderRows.map(({ row, absoluteIndex, isGap }, rowIndex) => {
            const viewModel = buildTerminalVisibleRowViewModel({
              absoluteIndex,
              row,
              rowHeight,
              cellWidthPx,
              isGap,
              theme,
              cursorColumn: -1,
              showAbsoluteLineNumbers,
              discontinuousLineNumber: isGap || hasDiscontinuousNeighbor(renderRows, rowIndex),
            });
            const lineNumber = viewModel.lineNumber ? (
              <span
                data-terminal-line-number={viewModel.lineNumber['data-terminal-line-number']}
                data-terminal-line-discontinuous={viewModel.lineNumber['data-terminal-line-discontinuous']}
                style={viewModel.lineNumber.style}
              >
                {viewModel.lineNumber.text}
              </span>
            ) : null;
            if (viewModel.kind === 'gap') {
              return (
                <div
                  key={`row-${absoluteIndex}`}
                  data-terminal-row={viewModel.dataset.terminalRow}
                  data-terminal-gap={viewModel.dataset.terminalGap}
                  data-terminal-index={viewModel.dataset.terminalIndex}
                  data-terminal-row-text={terminalRowToText(row)}
                  style={viewModel.rowStyle}
                >
                  {lineNumber}
                  <span {...viewModel.gapFillProps} />
                </div>
              );
            }
            return (
              <div
                key={`row-${absoluteIndex}`}
                data-terminal-row={viewModel.dataset.terminalRow}
                data-terminal-index={viewModel.dataset.terminalIndex}
                data-terminal-row-text={terminalRowToText(row)}
                style={viewModel.rowStyle}
              >
                {lineNumber}
                <span {...viewModel.cellWrapProps}>
                  {viewModel.cells.length > 0
                    ? viewModel.cells.map((cell) => (
                        <span
                          key={cell.key}
                          data-terminal-cursor={cell.cursorActive ? 'true' : undefined}
                          style={cell.style}
                        >
                          {cell.char}
                        </span>
                      ))
                    : ' '}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function TerminalView(props: WTermTerminalProps) {
  return <Terminal {...props} />;
}
