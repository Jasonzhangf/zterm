import { describe, expect, it } from 'vitest';
import {
  JUNCTION_PREVIEW_EDGE_PX,
  JUNCTION_PREVIEW_WIDE_ASPECT_RATIO,
  resolveJunctionPreviewLayout,
} from './junction-preview-layout';

describe('junction preview layout projection', () => {
  it('projects portrait phone as focus, one side strip, and two horizontal strips', () => {
    const layout = resolveJunctionPreviewLayout({
      viewportWidth: 374,
      viewportHeight: 706,
      fontSize: 11,
      focus: { col: 0, row: 0 },
    });

    expect(layout.form).toBe('portrait');
    expect(layout.focus).toEqual({ col: 0, row: 0 });
    expect(layout.visibleCells).toEqual([
      { col: -1, row: 0, edge: 'left' },
      { col: 0, row: -1, edge: 'top' },
      { col: 0, row: 0, edge: 'focus' },
      { col: 0, row: 1, edge: 'bottom' },
    ]);
    expect(layout.side).toEqual({ edge: 'left', sizePx: 38 });
    expect(layout.topBottomSizePx).toBe(30);
    expect(layout.focusSizePx).toEqual({ width: 330, height: 634 });
    expect(layout.transform).toEqual({ x: -1, y: 0 });
  });

  it('projects landscape phone as a two-pane center plus top and bottom strips', () => {
    const layout = resolveJunctionPreviewLayout({
      viewportWidth: 800,
      viewportHeight: 500,
      fontSize: 11,
      focus: { col: 1, row: 0 },
    });

    expect(layout.form).toBe('landscape');
    expect(layout.visibleCells).toEqual([
      { col: 1, row: -1, edge: 'top' },
      { col: 0, row: 0, edge: 'focus' },
      { col: 1, row: 0, edge: 'focus' },
      { col: 1, row: 1, edge: 'bottom' },
    ]);
    expect(layout.centerColumns).toBe(2);
    expect(layout.transform).toEqual({ x: -1, y: 0 });
  });

  it('projects a wide/tablet viewport as focus plus left, right, top, and bottom strips', () => {
    const layout = resolveJunctionPreviewLayout({
      viewportWidth: 1280,
      viewportHeight: 720,
      fontSize: 11,
      focus: { col: 0, row: 0 },
    });

    expect(JUNCTION_PREVIEW_WIDE_ASPECT_RATIO).toBe(16 / 9);
    expect(layout.form).toBe('wide');
    expect(layout.visibleCells).toEqual([
      { col: -1, row: 0, edge: 'left' },
      { col: 0, row: -1, edge: 'top' },
      { col: 0, row: 0, edge: 'focus' },
      { col: 1, row: 0, edge: 'right' },
      { col: 0, row: 1, edge: 'bottom' },
    ]);
    expect(layout.side).toEqual({ edge: 'both', sizePx: JUNCTION_PREVIEW_EDGE_PX.side });
    expect(layout.visibleCells.filter((cell) => cell.edge === 'focus')).toHaveLength(1);
  });

  it('switches to wide at the declared 16:9 boundary without a separate width floor', () => {
    const atBoundary = resolveJunctionPreviewLayout({
      viewportWidth: 800,
      viewportHeight: 450,
      fontSize: 11,
      focus: { col: 0, row: 0 },
    });
    const belowBoundary = resolveJunctionPreviewLayout({
      viewportWidth: 799,
      viewportHeight: 450,
      fontSize: 11,
      focus: { col: 0, row: 0 },
    });

    expect(atBoundary.form).toBe('wide');
    expect(atBoundary.visibleCells).toHaveLength(5);
    expect(belowBoundary.form).toBe('landscape');
    expect(belowBoundary.visibleCells).toHaveLength(4);
  });
});
