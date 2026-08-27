import type { CSSProperties } from 'react';
import type { TerminalCell, TerminalGapRange } from '../../connection/types';
import type { TerminalThemePreset } from '../theme';
import { safeTerminalCodePointToString } from '../cell-render';
import { terminalCellStyle } from '../renderer';
import { computeVisibleRangeRepairRanges } from '../gap-repair-planner';

export interface TerminalRenderRowModel {
  absoluteIndex: number;
  row: TerminalCell[];
  isGap: boolean;
  viewportOffset: number;
}

export interface TerminalRenderFrame {
  dataRowCount: number;
  minimumRenderBottomIndex: number;
  followVisualBottomIndex: number;
  maximumRenderBottomIndex: number;
  clampedRenderBottomIndex: number;
  totalRows: number;
  maxScrollTop: number;
  effectiveRenderBottomIndex: number;
  visibleWindowStartIndex: number;
  visibleWindowEndIndex: number;
  visibleDataRows: number;
  leadingBlankRows: number;
  visibleStartOffset: number;
  renderStartOffset: number;
  renderEndOffset: number;
}

export interface TerminalRenderDemandFromScroll {
  clampedScrollTop: number;
  nextMode: 'follow' | 'reading';
  nextRenderBottomIndex: number;
}

export interface TerminalViewportDemand {
  mode: 'follow' | 'reading';
  viewportEndIndex: number;
  viewportRows: number;
}

export interface TerminalViewportDemandWithRepair extends TerminalViewportDemand {
  missingRanges?: TerminalGapRange[];
}

export function isTerminalGapIndex(gapRanges: TerminalGapRange[], absoluteIndex: number) {
  return gapRanges.some((range) => absoluteIndex >= range.startIndex && absoluteIndex < range.endIndex);
}

export function hasDiscontinuousNeighbor(
  rows: Array<{ absoluteIndex: number }>,
  rowIndex: number,
) {
  const current = rows[rowIndex];
  if (!current) return false;
  const previous = rows[rowIndex - 1];
  const next = rows[rowIndex + 1];
  const brokenBefore = Boolean(previous) && previous.absoluteIndex + 1 !== current.absoluteIndex;
  const brokenAfter = Boolean(next) && current.absoluteIndex + 1 !== next.absoluteIndex;
  return brokenBefore || brokenAfter;
}

function isTerminalBlankRow(row: TerminalCell[] | null | undefined) {
  if (!Array.isArray(row) || row.length === 0) {
    return true;
  }
  for (const cell of row) {
    if (!cell) {
      continue;
    }
    const codePoint = cell.char;
    if (typeof codePoint !== 'number' || Number.isNaN(codePoint) || codePoint <= 32) {
      continue;
    }
    return false;
  }
  return true;
}

export function resolveTerminalFollowAnchorEndIndex(options: {
  bufferStartIndex: number;
  bufferLines: TerminalCell[][];
  effectiveBufferEndIndex: number;
  bufferTailEndIndex: number;
  cursorRowIndex: number | null | undefined;
  cursorVisible: boolean | null | undefined;
  viewportRows: number;
}) {
  const tailEndIndex = Math.max(
    options.bufferStartIndex,
    Math.floor(options.bufferTailEndIndex || options.effectiveBufferEndIndex || 0),
  );
  const cursorRowIndex = Number.isFinite(options.cursorRowIndex)
    ? Math.max(options.bufferStartIndex, Math.floor(options.cursorRowIndex ?? -1))
    : -1;
  const cursorVisible = options.cursorVisible !== false;
  const viewportRows = Math.max(1, Math.floor(options.viewportRows || 1));
  const tailStartIndex = Math.max(options.bufferStartIndex, tailEndIndex - viewportRows);
  const cursorOutsideTailWindow = cursorVisible
    && cursorRowIndex >= options.bufferStartIndex
    && cursorRowIndex + 1 < tailStartIndex;

  if (!cursorOutsideTailWindow) {
    return tailEndIndex;
  }

  let tailWindowHasContent = false;
  for (let index = tailStartIndex; index < tailEndIndex; index += 1) {
    const offset = index - options.bufferStartIndex;
    if (offset < 0 || offset >= options.bufferLines.length) {
      continue;
    }
    if (!isTerminalBlankRow(options.bufferLines[offset])) {
      tailWindowHasContent = true;
      break;
    }
  }
  if (tailWindowHasContent) {
    return tailEndIndex;
  }

  return Math.max(options.bufferStartIndex, Math.min(tailEndIndex, cursorRowIndex + 1));
}

export function buildTerminalRenderRows(options: {
  bufferLines: TerminalCell[][];
  gapRanges?: TerminalGapRange[];
  startIndex: number;
  leadingBlankRows: number;
  renderStartOffset: number;
  renderEndOffset: number;
}) {
  const rows: TerminalRenderRowModel[] = [];
  const gapRanges = Array.isArray(options.gapRanges) ? options.gapRanges : [];
  const visibleDataStartOffset = Math.max(0, options.renderStartOffset - options.leadingBlankRows);
  const visibleDataEndOffset = Math.max(
    visibleDataStartOffset,
    Math.min(options.bufferLines.length, options.renderEndOffset - options.leadingBlankRows),
  );

  for (let dataOffset = visibleDataStartOffset; dataOffset < visibleDataEndOffset; dataOffset += 1) {
    const viewportOffset = options.leadingBlankRows + dataOffset;
    const absoluteIndex = options.startIndex + dataOffset;
    rows.push({
      absoluteIndex,
      row: options.bufferLines[dataOffset] || [],
      isGap: isTerminalGapIndex(gapRanges, absoluteIndex),
      viewportOffset,
    });
  }

  return rows;
}

export function buildTerminalRenderFrame(options: {
  bufferStartIndex: number;
  effectiveBufferEndIndex: number;
  bufferLinesLength: number;
  viewportRows: number;
  rowHeightPx: number;
  viewportClientHeightPx?: number;
  renderBottomIndex: number;
  followDemandAnchorEndIndex: number;
  readingMode: boolean;
  overscanRows: number;
}) : TerminalRenderFrame {
  const dataRowCount = Math.max(0, options.effectiveBufferEndIndex - options.bufferStartIndex);
  const minimumRenderBottomIndex = dataRowCount <= options.viewportRows
    ? options.effectiveBufferEndIndex
    : options.bufferStartIndex + options.viewportRows;
  const followVisualBottomIndex = Math.max(
    minimumRenderBottomIndex,
    Math.min(
      Math.max(minimumRenderBottomIndex, Math.floor(options.followDemandAnchorEndIndex || 0)),
      Math.max(minimumRenderBottomIndex, Math.floor(options.effectiveBufferEndIndex || 0)),
    ),
  );
  const maximumRenderBottomIndex = Math.max(minimumRenderBottomIndex, options.effectiveBufferEndIndex);
  const clampedRenderBottomIndex = Math.max(
    minimumRenderBottomIndex,
    Math.min(maximumRenderBottomIndex, Math.floor(options.renderBottomIndex || followVisualBottomIndex)),
  );
  const totalRows = Math.max(
    options.bufferLinesLength,
    options.effectiveBufferEndIndex - options.bufferStartIndex,
    options.viewportRows,
  );
  const maxScrollTop = Math.max(
    0,
    Number.isFinite(options.viewportClientHeightPx) && (options.viewportClientHeightPx || 0) > 0
      ? totalRows * options.rowHeightPx - options.viewportClientHeightPx!
      : (totalRows - options.viewportRows) * options.rowHeightPx,
  );
  const effectiveRenderBottomIndex = options.readingMode ? clampedRenderBottomIndex : followVisualBottomIndex;
  const visibleWindowStartIndex = Math.max(options.bufferStartIndex, effectiveRenderBottomIndex - options.viewportRows);
  const visibleWindowEndIndex = Math.min(
    options.effectiveBufferEndIndex,
    Math.max(visibleWindowStartIndex, effectiveRenderBottomIndex),
  );
  const visibleDataRows = Math.max(0, visibleWindowEndIndex - visibleWindowStartIndex);
  const leadingBlankRows = Math.max(0, options.viewportRows - visibleDataRows);
  const visibleStartOffset = Math.max(0, visibleWindowStartIndex - options.bufferStartIndex);
  const renderStartOffset = Math.max(0, visibleStartOffset - options.overscanRows);
  const renderEndOffset = Math.min(totalRows, visibleStartOffset + options.viewportRows + options.overscanRows);

  return {
    dataRowCount,
    minimumRenderBottomIndex,
    followVisualBottomIndex,
    maximumRenderBottomIndex,
    clampedRenderBottomIndex,
    totalRows,
    maxScrollTop,
    effectiveRenderBottomIndex,
    visibleWindowStartIndex,
    visibleWindowEndIndex,
    visibleDataRows,
    leadingBlankRows,
    visibleStartOffset,
    renderStartOffset,
    renderEndOffset,
  };
}

export function buildTerminalGridPadding(options: {
  renderRows: Array<{ viewportOffset: number }>;
  rowHeightPx: number;
  totalRows: number;
}) {
  const termGridPaddingTopPx = options.renderRows.length > 0
    ? options.renderRows[0]!.viewportOffset * options.rowHeightPx
    : options.totalRows * options.rowHeightPx;
  const termGridPaddingBottomPx = options.renderRows.length > 0
    ? Math.max(0, options.totalRows - (options.renderRows[options.renderRows.length - 1]!.viewportOffset + 1)) * options.rowHeightPx
    : 0;
  return {
    termGridPaddingTopPx,
    termGridPaddingBottomPx,
  };
}

export function buildTerminalRenderGeometryRevision(options: {
  revision: number;
  startIndex: number;
  effectiveBufferEndIndex: number;
  followVisualBottomIndex: number;
  viewportRows: number;
  rowHeightPx: number;
  renderRowsLength: number;
  termGridPaddingTopPx: number;
  termGridPaddingBottomPx: number;
}) {
  return [
    options.revision,
    options.startIndex,
    options.effectiveBufferEndIndex,
    options.followVisualBottomIndex,
    options.viewportRows,
    options.rowHeightPx,
    options.renderRowsLength,
    options.termGridPaddingTopPx,
    options.termGridPaddingBottomPx,
  ].join(':');
}

export function resolveScrollTopForRenderBottomIndex(options: {
  nextRenderBottomIndex: number;
  totalRows: number;
  viewportRows: number;
  bufferStartIndex: number;
  rowHeightPx: number;
  maxScrollTop: number;
}) {
  const topOffset = Math.max(
    0,
    Math.min(
      options.totalRows - options.viewportRows,
      Math.max(0, Math.floor(options.nextRenderBottomIndex) - options.bufferStartIndex - options.viewportRows),
    ),
  );
  if (Math.floor(options.nextRenderBottomIndex) >= options.bufferStartIndex + options.totalRows) {
    return options.maxScrollTop;
  }
  return Math.max(0, Math.min(options.maxScrollTop, topOffset * options.rowHeightPx));
}

export function resolveTerminalRenderDemandFromScroll(options: {
  nextScrollTop: number;
  maxScrollTop: number;
  rowHeightPx: number;
  dataRowCount: number;
  viewportRows: number;
  effectiveBufferEndIndex: number;
  minimumRenderBottomIndex: number;
  bufferTailAnchorEndIndex: number;
  bufferStartIndex: number;
  followVisualBottomIndex: number;
  observedScrollTop: number;
  isAtBottom: boolean;
  resolveScrollTopForRenderBottomIndex: (nextRenderBottomIndex: number) => number;
}) : TerminalRenderDemandFromScroll {
  const viewportRows = Math.max(1, Math.floor(options.viewportRows || 1));
  const clampedScrollTop = Math.max(0, Math.min(options.maxScrollTop, options.nextScrollTop));
  const visibleTopOffset = Math.max(0, Math.floor(clampedScrollTop / options.rowHeightPx));
  const nextWindowBottomIndex = options.dataRowCount <= viewportRows
    ? options.effectiveBufferEndIndex
    : Math.max(
        options.minimumRenderBottomIndex,
        Math.min(options.bufferTailAnchorEndIndex, options.bufferStartIndex + visibleTopOffset + viewportRows),
      );
  const nextMode: 'follow' | 'reading' = options.isAtBottom ? 'follow' : 'reading';
  const nextRenderBottomIndex = nextMode === 'follow'
    ? options.followVisualBottomIndex
    : nextWindowBottomIndex;
  return {
    clampedScrollTop: nextMode === 'follow'
      ? options.resolveScrollTopForRenderBottomIndex(nextRenderBottomIndex)
      : clampedScrollTop,
    nextMode,
    nextRenderBottomIndex,
  };
}

export function buildTerminalViewportDemand(options: {
  nextMode: 'follow' | 'reading';
  nextRenderBottomIndex: number;
  viewportRows: number;
  bufferStartIndex: number;
  followDemandAnchorEndIndex: number;
  viewportEndIndexOverride?: number;
}) : TerminalViewportDemand {
  const viewportEndIndex = typeof options.viewportEndIndexOverride === 'number'
    ? Math.max(options.bufferStartIndex, Math.floor(options.viewportEndIndexOverride))
    : options.nextMode === 'follow'
      ? Math.max(options.bufferStartIndex, Math.floor(options.followDemandAnchorEndIndex))
      : Math.max(options.bufferStartIndex, Math.floor(options.nextRenderBottomIndex));
  return {
    mode: options.nextMode,
    viewportEndIndex,
    viewportRows: options.viewportRows,
  };
}

export function buildTerminalViewportDemandWithRepair(options: {
  nextMode: 'follow' | 'reading';
  nextRenderBottomIndex: number;
  viewportRows: number;
  bufferStartIndex: number;
  bufferEndIndex: number;
  gapRanges: TerminalGapRange[];
  followDemandAnchorEndIndex: number;
  viewportEndIndexOverride?: number;
}): TerminalViewportDemandWithRepair {
  const demand = buildTerminalViewportDemand({
    nextMode: options.nextMode,
    nextRenderBottomIndex: options.nextRenderBottomIndex,
    viewportRows: options.viewportRows,
    bufferStartIndex: options.bufferStartIndex,
    followDemandAnchorEndIndex: options.followDemandAnchorEndIndex,
    viewportEndIndexOverride: options.viewportEndIndexOverride,
  });
  const visibleEndIndex = Math.max(options.bufferStartIndex, demand.viewportEndIndex);
  const visibleStartIndex = Math.max(
    options.bufferStartIndex,
    visibleEndIndex - Math.max(1, Math.floor(options.viewportRows || 1)),
  );

  const missingRanges = computeVisibleRangeRepairRanges({
    visibleStartIndex,
    visibleEndIndex,
    localStartIndex: options.bufferStartIndex,
    localEndIndex: options.bufferEndIndex,
    localGapRanges: Array.isArray(options.gapRanges) ? options.gapRanges : [],
  });

  return missingRanges.length > 0
    ? { ...demand, missingRanges }
    : demand;
}

export function buildTerminalViewportDemandKey(demand: TerminalViewportDemand) {
  const missingRanges = (demand as TerminalViewportDemandWithRepair).missingRanges;
  const repairKey = Array.isArray(missingRanges) && missingRanges.length > 0
    ? `:${missingRanges.map((range) => `${range.startIndex}-${range.endIndex}`).join(',')}`
    : '';
  return `${demand.mode}:${demand.viewportEndIndex}:${demand.viewportRows}${repairKey}`;
}

export function renderGapMarker(options: {
  absoluteIndex: number;
  rowHeight: string;
  theme: TerminalThemePreset;
}) {
  return {
    key: `row-${options.absoluteIndex}`,
    rowStyle: {
      display: 'flex',
      alignItems: 'center',
      height: options.rowHeight,
      lineHeight: options.rowHeight,
      whiteSpace: 'pre',
      color: options.theme.foreground,
      opacity: 1,
      background: options.theme.background,
      borderTop: 'none',
      borderBottom: 'none',
    } satisfies CSSProperties,
    fillProps: {
      'data-terminal-gap-fill': 'true',
      style: {
        display: 'block',
        minWidth: 0,
        flex: 1,
        height: '100%',
        background: options.theme.background,
      } satisfies CSSProperties,
    },
  };
}

export function renderRowCells(options: {
  absoluteIndex: number;
  row: TerminalCell[];
  rowHeight: string;
  cellWidthPx: number;
  theme: TerminalThemePreset;
  cursorColumn: number;
}) {
  return options.row.map((cell, cellIndex) => ({
    key: `cell-${options.absoluteIndex}-${cellIndex}`,
    char: cell.width === 0 ? '' : safeTerminalCodePointToString(cell.char),
    cursorActive: options.cursorColumn === cellIndex,
    style: terminalCellStyle(
      cell,
      options.rowHeight,
      options.cellWidthPx,
      options.theme,
      options.cursorColumn === cellIndex,
    ),
  }));
}

export function buildTerminalLineNumberProps(options: {
  absoluteIndex: number;
  theme: TerminalThemePreset;
  discontinuousLineNumber?: boolean;
}) {
  return {
    'data-terminal-line-number': 'true',
    'data-terminal-line-discontinuous': options.discontinuousLineNumber ? 'true' : undefined,
    style: {
      display: 'inline-flex',
      width: '48px',
      minWidth: '48px',
      justifyContent: 'flex-end',
      paddingRight: '8px',
      boxSizing: 'border-box',
      color: options.discontinuousLineNumber ? '#ef4444' : options.theme.colors[8],
      opacity: 0.92,
      fontWeight: options.discontinuousLineNumber ? 700 : 500,
    } satisfies CSSProperties,
    text: options.absoluteIndex,
  };
}

export function buildTerminalVisibleRowViewModel(options: {
  absoluteIndex: number;
  row: TerminalCell[];
  rowHeight: string;
  cellWidthPx: number;
  isGap: boolean;
  theme: TerminalThemePreset;
  cursorColumn: number;
  showAbsoluteLineNumbers?: boolean;
  discontinuousLineNumber?: boolean;
}) {
  const lineNumber = options.showAbsoluteLineNumbers
    ? buildTerminalLineNumberProps({
        absoluteIndex: options.absoluteIndex,
        theme: options.theme,
        discontinuousLineNumber: options.discontinuousLineNumber,
      })
    : null;

  if (options.isGap) {
    return {
      kind: 'gap' as const,
      dataset: {
        terminalRow: 'true',
        terminalGap: 'true',
        terminalIndex: options.absoluteIndex,
      },
      rowStyle: renderGapMarker({
        absoluteIndex: options.absoluteIndex,
        rowHeight: options.rowHeight,
        theme: options.theme,
      }).rowStyle,
      gapFillProps: renderGapMarker({
        absoluteIndex: options.absoluteIndex,
        rowHeight: options.rowHeight,
        theme: options.theme,
      }).fillProps,
      lineNumber,
    };
  }

  return {
    kind: 'row' as const,
    dataset: {
      terminalRow: 'true',
      terminalIndex: options.absoluteIndex,
    },
    rowStyle: {
      display: 'flex',
      alignItems: 'center',
      height: options.rowHeight,
      lineHeight: options.rowHeight,
      whiteSpace: 'pre',
      background: options.theme.background,
    } satisfies CSSProperties,
    lineNumber,
    cellWrapProps: {
      style: {
        display: 'inline-block',
        minWidth: 0,
        flex: 1,
        whiteSpace: 'pre',
      } satisfies CSSProperties,
    },
    cells: renderRowCells({
      absoluteIndex: options.absoluteIndex,
      row: options.row,
      rowHeight: options.rowHeight,
      cellWidthPx: options.cellWidthPx,
      theme: options.theme,
      cursorColumn: options.cursorColumn,
    }),
  };
}
