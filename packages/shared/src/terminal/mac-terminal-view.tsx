/**
 * shared Mac terminal view surface.
 *
 * Mac renders the canonical TerminalRenderBufferProjection directly as DOM rows.
 * There is no hidden terminal/mask/proxy layer: visible DOM owns rendering,
 * focus, keyboard input, scrollback and viewport demand.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Terminal } from '@jsonstudio/wtermmod-react';
import type { TerminalProps as WTermTerminalProps } from '@jsonstudio/wtermmod-react';
import type { TerminalCell, TerminalRenderBufferProjection } from '../connection/types';
import { getTerminalThemePreset } from './theme';
import { DEFAULT_ROWS, measureTerminalViewport, NORMAL_CURSOR_KEYS, TERMINAL_FONT_STACK } from './renderer';
import {
  buildTerminalGridPadding,
  buildTerminalRenderFrame,
  buildTerminalRenderRows,
  buildTerminalViewportDemand,
  buildTerminalVisibleRowViewModel,
  hasDiscontinuousNeighbor,
  resolveScrollTopForRenderBottomIndex,
} from './renderer/row';

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
    onResize: _onResize,
    onViewportChange,
    onImagePaste,
    onWidthModeChange: _onWidthModeChange,
  } = props;

  const theme = getTerminalThemePreset(themeId);
  const rowHeight = '17px';
  const rowHeightPx = 17;
  const cellWidthPx = 8.4;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [readingMode, setReadingMode] = useState(false);
  const [renderBottomIndex, setRenderBottomIndex] = useState(projection?.endIndex ?? 0);
  const [viewportRows, setViewportRows] = useState(DEFAULT_ROWS);
  const [viewportHeightPx, setViewportHeightPx] = useState(0);
  void active;

  const refreshMeasuredViewport = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measured = measureTerminalViewport(viewport, 14, rowHeight);
    setViewportRows((current) => (current === measured.rows ? current : measured.rows));
    const nextHeightPx = Math.max(0, viewport.clientHeight || 0);
    setViewportHeightPx((current) => (current === nextHeightPx ? current : nextHeightPx));
  };

  const renderGeometry = useMemo(() => {
    const startIndex = projection?.startIndex ?? 0;
    const endIndex = projection?.endIndex ?? 0;
    const frame = buildTerminalRenderFrame({
      bufferStartIndex: startIndex,
      effectiveBufferEndIndex: endIndex,
      bufferLinesLength: projection?.lines.length ?? 0,
      viewportRows,
      rowHeightPx,
      renderBottomIndex,
      followDemandAnchorEndIndex: endIndex,
      readingMode,
      overscanRows: 4,
    });
    const rowsToRender = projection
      ? buildTerminalRenderRows({
          bufferLines: projection.lines,
          gapRanges: projection.gapRanges,
          startIndex,
          leadingBlankRows: frame.leadingBlankRows,
          renderStartOffset: frame.renderStartOffset,
          renderEndOffset: frame.renderEndOffset,
        })
      : [];
    const padding = buildTerminalGridPadding({
      renderRows: rowsToRender,
      rowHeightPx,
      totalRows: frame.totalRows,
    });
    const shortBufferBottomResidualPx = frame.totalRows <= viewportRows
      ? Math.max(0, viewportHeightPx - viewportRows * rowHeightPx)
      : 0;
    return { frame, rowsToRender, padding, shortBufferBottomResidualPx };
  }, [projection, readingMode, renderBottomIndex, viewportHeightPx, viewportRows]);

  const syncScrollHostToRenderBottom = (nextRenderBottomIndex: number) => {
    const viewport = viewportRef.current;
    if (!viewport || !projection) return;
    const resolvedScrollTop = resolveScrollTopForRenderBottomIndex({
      nextRenderBottomIndex,
      totalRows: renderGeometry.frame.totalRows,
      viewportRows,
      bufferStartIndex: projection.startIndex,
      rowHeightPx,
      maxScrollTop: renderGeometry.frame.maxScrollTop,
    });
    const domMaxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollTop = domMaxScrollTop > 0 && !readingMode && nextRenderBottomIndex >= renderGeometry.frame.followVisualBottomIndex
      ? domMaxScrollTop
      : resolvedScrollTop;
  };

  useLayoutEffect(() => {
    refreshMeasuredViewport();
    const viewport = viewportRef.current;
    const handleWindowResize = () => refreshMeasuredViewport();
    window.addEventListener('resize', handleWindowResize);
    if (!viewport || typeof ResizeObserver === 'undefined') {
      return () => window.removeEventListener('resize', handleWindowResize);
    }
    const observer = new ResizeObserver(() => refreshMeasuredViewport());
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleWindowResize);
    };
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !projection) return;
    if (readingMode) return;
    setRenderBottomIndex(renderGeometry.frame.followVisualBottomIndex);
    requestAnimationFrame(() => {
      syncScrollHostToRenderBottom(renderGeometry.frame.followVisualBottomIndex);
      onViewportChange?.({
        ...buildTerminalViewportDemand({
          nextMode: 'follow',
          nextRenderBottomIndex: renderGeometry.frame.followVisualBottomIndex,
          viewportRows,
          bufferStartIndex: projection.startIndex,
          followDemandAnchorEndIndex: projection.endIndex,
        }),
        missingRanges: [],
      });
    });
  }, [onViewportChange, projection?.endIndex, projection?.revision, readingMode, renderGeometry.frame.followVisualBottomIndex, viewportRows]);

  useEffect(() => {
    if (allowDomFocus && active) {
      hostRef.current?.focus({ preventScroll: true });
    }
  }, [active, allowDomFocus]);

  const handleScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport || !projection) return;
    const domMaxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const bottomThreshold = domMaxScrollTop > 0 ? domMaxScrollTop : renderGeometry.frame.maxScrollTop;
    const isAtBottom = viewport.scrollTop >= bottomThreshold - 1;
    const nextMode = isAtBottom ? 'follow' : 'reading';
    const nextRenderBottomIndex = isAtBottom
      ? renderGeometry.frame.followVisualBottomIndex
      : Math.max(projection.startIndex + viewportRows, projection.startIndex + Math.ceil(viewport.scrollTop / rowHeightPx) + viewportRows);
    setReadingMode(nextMode === 'reading');
    setRenderBottomIndex(nextRenderBottomIndex);
    onViewportChange?.({
      ...buildTerminalViewportDemand({
        nextMode,
        nextRenderBottomIndex,
        viewportRows,
        bufferStartIndex: projection.startIndex,
        followDemandAnchorEndIndex: projection.endIndex,
      }),
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
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
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
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          padding: 0,
        }}
      >
        <div
          className="term-grid"
          data-cursor-source="projection"
          style={{
            minHeight: '100%',
            paddingTop: `${renderGeometry.padding.termGridPaddingTopPx + renderGeometry.shortBufferBottomResidualPx}px`,
            paddingBottom: `${renderGeometry.padding.termGridPaddingBottomPx}px`,
          }}
        >
          {renderGeometry.rowsToRender.map(({ row, absoluteIndex, isGap }, rowIndex) => {
            const viewModel = buildTerminalVisibleRowViewModel({
              absoluteIndex,
              row,
              rowHeight,
              cellWidthPx,
              isGap,
              theme,
              cursorColumn: -1,
              showAbsoluteLineNumbers,
              discontinuousLineNumber: isGap || hasDiscontinuousNeighbor(renderGeometry.rowsToRender, rowIndex),
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
