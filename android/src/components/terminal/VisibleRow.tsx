import { memo, type CSSProperties, type PointerEventHandler } from 'react';
import {
  buildTerminalVisibleRowViewModel,
  hasDiscontinuousNeighbor,
  resolveCursorOverlay,
} from '@zterm/shared';
import type { TerminalCell } from '../../lib/types';
import type { TerminalThemePreset } from '@zterm/shared';

export interface VisibleRowProps {
  row: TerminalCell[];
  rowIndex: number;
  absoluteIndex: number;
  rowHeight: string;
  cellWidthPx: number;
  isGap: boolean;
  theme: TerminalThemePreset;
  cursorColumn: number;
  showAbsoluteLineNumbers?: boolean;
  discontinuousLineNumber?: boolean;
  rowHighlightStyle?: CSSProperties;
  copyModeActive?: boolean;
  plainText?: string;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
  onPointerCancel?: PointerEventHandler<HTMLDivElement>;
}

export const VisibleRow = memo(function VisibleRow({
  row,
  rowIndex: _rowIndex,
  absoluteIndex,
  rowHeight,
  cellWidthPx,
  isGap,
  theme,
  cursorColumn,
  showAbsoluteLineNumbers = false,
  discontinuousLineNumber = false,
  rowHighlightStyle,
  copyModeActive = false,
  plainText,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: VisibleRowProps) {
  const viewModel = buildTerminalVisibleRowViewModel({
    absoluteIndex,
    row,
    rowHeight,
    cellWidthPx,
    isGap,
    theme,
    cursorColumn,
    showAbsoluteLineNumbers,
    discontinuousLineNumber,
  });

  const lineNumberCell = viewModel.lineNumber ? (
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
        data-terminal-row={viewModel.dataset.terminalRow}
        data-terminal-gap={viewModel.dataset.terminalGap}
        data-terminal-index={viewModel.dataset.terminalIndex}
        data-terminal-copy-mode={copyModeActive ? 'true' : undefined}
        data-terminal-row-text={plainText}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={copyModeActive ? (event) => {
          event.preventDefault();
          event.stopPropagation();
        } : undefined}
        style={{
          ...viewModel.rowStyle,
          userSelect: copyModeActive ? 'none' : 'text',
          WebkitUserSelect: copyModeActive ? 'none' : 'text',
          ...rowHighlightStyle,
        }}
      >
        {lineNumberCell}
        <span {...viewModel.gapFillProps} />
      </div>
    );
  }
  return (
    <div
      data-terminal-row={viewModel.dataset.terminalRow}
      data-terminal-index={viewModel.dataset.terminalIndex}
      data-terminal-copy-mode={copyModeActive ? 'true' : undefined}
      data-terminal-row-text={plainText}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={copyModeActive ? (event) => {
        event.preventDefault();
        event.stopPropagation();
      } : undefined}
      style={{
        ...viewModel.rowStyle,
        userSelect: copyModeActive ? 'none' : 'text',
        WebkitUserSelect: copyModeActive ? 'none' : 'text',
        ...rowHighlightStyle,
      }}
    >
      {lineNumberCell}
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
}, (prev, next) => (
  prev.row === next.row
  && prev.rowHeight === next.rowHeight
  && prev.cellWidthPx === next.cellWidthPx
  && prev.isGap === next.isGap
  && prev.absoluteIndex === next.absoluteIndex
  && prev.theme === next.theme
  && prev.cursorColumn === next.cursorColumn
  && prev.showAbsoluteLineNumbers === next.showAbsoluteLineNumbers
  && prev.discontinuousLineNumber === next.discontinuousLineNumber
  && prev.rowHighlightStyle === next.rowHighlightStyle
  && prev.copyModeActive === next.copyModeActive
  && prev.plainText === next.plainText
  && prev.onPointerDown === next.onPointerDown
  && prev.onPointerMove === next.onPointerMove
  && prev.onPointerUp === next.onPointerUp
  && prev.onPointerCancel === next.onPointerCancel
));

export { resolveCursorOverlay, hasDiscontinuousNeighbor };
