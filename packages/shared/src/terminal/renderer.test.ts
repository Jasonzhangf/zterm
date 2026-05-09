import { describe, expect, it } from 'vitest';
import { getTerminalThemePreset } from './theme';
import {
  buildTerminalRenderRows,
  detectDoubleWidthChar,
  hasDiscontinuousNeighbor,
  renderGapMarker,
  renderRowCells,
  resolveCursorOverlay,
} from './renderer/index';

describe('shared terminal renderer pure helpers', () => {
  const theme = getTerminalThemePreset('classic-dark');

  it('builds visible render rows with gap truth', () => {
    const rows = buildTerminalRenderRows({
      bufferLines: [
        [{ char: 65, fg: 256, bg: 256, flags: 0, width: 1 }],
        [{ char: 66, fg: 256, bg: 256, flags: 0, width: 1 }],
      ],
      gapRanges: [{ startIndex: 1, endIndex: 2 }],
      startIndex: 0,
      leadingBlankRows: 0,
      renderStartOffset: 0,
      renderEndOffset: 2,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ absoluteIndex: 0, isGap: false, viewportOffset: 0 });
    expect(rows[1]).toMatchObject({ absoluteIndex: 1, isGap: true, viewportOffset: 1 });
  });

  it('renders row cells with cursor styling and preserves double-width widths', () => {
    const cells = renderRowCells({
      absoluteIndex: 8,
      row: [
        { char: '你'.codePointAt(0)!, fg: 2, bg: 1, flags: 0, width: 2 },
        { char: 0, fg: 256, bg: 256, flags: 0, width: 0 },
      ],
      rowHeight: '17px',
      cellWidthPx: 8,
      theme,
      cursorColumn: 0,
    });

    expect(cells).toHaveLength(2);
    expect(cells[0]?.char).toBe('你');
    expect(cells[0]?.cursorActive).toBe(true);
    expect(cells[0]?.style.width).toBe('16px');
    expect(cells[1]?.char).toBe('');
    expect(cells[1]?.style.width).toBe('0px');
  });

  it('builds gap marker payload with explicit fill block', () => {
    const gap = renderGapMarker({
      absoluteIndex: 99,
      rowHeight: '17px',
      theme,
    });

    expect(gap.key).toBe('row-99');
    expect(gap.rowStyle.background).toBe('rgba(239, 68, 68, 0.12)');
    expect(gap.fillProps['data-terminal-gap-fill']).toBe('true');
  });

  it('resolves cursor overlay only for matching visible cursor row', () => {
    const row = [
      { char: 65, fg: 256, bg: 256, flags: 0, width: 1 },
      { char: 66, fg: 256, bg: 256, flags: 0, width: 1 },
    ];

    expect(resolveCursorOverlay({
      row,
      cursor: { rowIndex: 12, col: 1, visible: true },
      absoluteIndex: 12,
    })).toEqual({ cursorColumn: 1, active: true });

    expect(resolveCursorOverlay({
      row,
      cursor: { rowIndex: 13, col: 1, visible: true },
      absoluteIndex: 12,
    })).toEqual({ cursorColumn: -1, active: false });
  });

  it('detects double-width characters by code point', () => {
    expect(detectDoubleWidthChar('你')).toBe(true);
    expect(detectDoubleWidthChar('A')).toBe(false);
    expect(detectDoubleWidthChar('😀')).toBe(true);
  });

  it('marks discontinuous neighbors when absolute indices skip', () => {
    const rows = [
      { absoluteIndex: 10 },
      { absoluteIndex: 12 },
      { absoluteIndex: 13 },
    ];

    expect(hasDiscontinuousNeighbor(rows, 0)).toBe(true);
    expect(hasDiscontinuousNeighbor(rows, 1)).toBe(true);
    expect(hasDiscontinuousNeighbor(rows, 2)).toBe(false);
  });
});
