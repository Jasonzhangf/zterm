/**
 * shared Mac terminal view surface.
 *
 * Mac renders the canonical TerminalRenderBufferProjection directly as DOM rows.
 * The embedded wtermmod Terminal is kept only as an input/resize bridge; render
 * truth must come from projection cells so colors, scrollback, and live revisions
 * stay visible instead of degrading into a write-only snapshot.
 */

import { useMemo } from 'react';
import { Terminal } from '@jsonstudio/wtermmod-react';
import type { TerminalProps as WTermTerminalProps } from '@jsonstudio/wtermmod-react';
import type { TerminalCell, TerminalRenderBufferProjection } from '../connection/types';
import { getTerminalThemePreset } from './theme';
import { TERMINAL_FONT_STACK } from './renderer';
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

export function MacTerminalView(props: MacTerminalViewProps) {
  const {
    projection,
    active = false,
    allowDomFocus = false,
    themeId,
    showAbsoluteLineNumbers = false,
    onInput,
    onResize,
    onViewportChange: _onViewportChange,
    onImagePaste: _onImagePaste,
    onWidthModeChange: _onWidthModeChange,
  } = props;

  const cols = projection?.cols ?? 80;
  const rows = projection?.rows ?? 24;
  const theme = getTerminalThemePreset(themeId);
  const rowHeight = '17px';
  const cellWidthPx = 8.4;
  void active;
  void allowDomFocus;

  const renderRows = useMemo(() => {
    if (!projection) return [];
    return projection.lines.map((row, index) => ({
      row,
      absoluteIndex: projection.startIndex + index,
      isGap: isGapIndex(projection, projection.startIndex + index),
    }));
  }, [projection]);

  return (
    <div
      className="mac-terminal-projection"
      data-mac-terminal-projection="true"
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        backgroundColor: theme.background,
        color: theme.foreground,
        overflow: 'hidden',
        fontFamily: TERMINAL_FONT_STACK,
        fontSize: '14px',
      }}
    >
      <div
        data-mac-terminal-scroll="true"
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
      <div
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none' }}
      >
        <Terminal
          cols={cols}
          rows={rows}
          autoResize
          theme={themeId === 'dark' ? 'dark' : undefined}
          onData={(data: string) => onInput?.(data)}
          onResize={onResize}
        />
      </div>
    </div>
  );
}

export function TerminalView(props: WTermTerminalProps) {
  return <Terminal {...props} />;
}
