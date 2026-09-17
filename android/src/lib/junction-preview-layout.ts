import type { JunctionPreviewCoordinate } from './junction-preview-lattice';

export const JUNCTION_PREVIEW_EDGE_PX = {
  side: 38,
  topBottom: 30,
} as const;

export const JUNCTION_PREVIEW_GAP_PX = 6;
export const JUNCTION_PREVIEW_WIDE_ASPECT_RATIO = 16 / 9;
export const JUNCTION_PREVIEW_HEADER_HEIGHT_PX = 36;

export type JunctionPreviewForm = 'portrait' | 'landscape' | 'wide';
export type JunctionPreviewCellEdge = 'focus' | 'left' | 'right' | 'top' | 'bottom';

export interface JunctionPreviewVisibleCell extends JunctionPreviewCoordinate {
  edge: JunctionPreviewCellEdge;
}

export interface JunctionPreviewLayoutPlan {
  form: JunctionPreviewForm;
  focus: JunctionPreviewCoordinate;
  visibleCells: JunctionPreviewVisibleCell[];
  side: { edge: 'left' | 'right' | 'both'; sizePx: number };
  topBottomSizePx: number;
  focusSizePx: { width: number; height: number };
  centerColumns: number;
  transform: { x: number; y: number };
}

export function resolveJunctionPreviewLayout(input: {
  viewportWidth: number;
  viewportHeight: number;
  fontSize: number;
  focus: JunctionPreviewCoordinate;
  sideEdge?: 'left' | 'right';
}): JunctionPreviewLayoutPlan {
  const { viewportWidth, viewportHeight, fontSize, focus, sideEdge } = input;
  const charWidthPx = Math.max(4, fontSize * 0.6);
  const wide = viewportHeight > 0
    && viewportWidth / viewportHeight >= JUNCTION_PREVIEW_WIDE_ASPECT_RATIO;
  const resolvedSideEdge = sideEdge || (focus.col < 0 ? 'right' : 'left');

  if (wide) {
    const focusWidth = viewportWidth - JUNCTION_PREVIEW_EDGE_PX.side * 2 - JUNCTION_PREVIEW_GAP_PX * 2;
    const focusHeight = viewportHeight - JUNCTION_PREVIEW_EDGE_PX.topBottom * 2 - JUNCTION_PREVIEW_GAP_PX * 2;
    return {
      form: 'wide',
      focus,
      visibleCells: [
        { col: focus.col - 1, row: focus.row, edge: 'left' },
        { col: focus.col, row: focus.row - 1, edge: 'top' },
        { col: focus.col, row: focus.row, edge: 'focus' },
        { col: focus.col + 1, row: focus.row, edge: 'right' },
        { col: focus.col, row: focus.row + 1, edge: 'bottom' },
      ],
      side: { edge: 'both', sizePx: JUNCTION_PREVIEW_EDGE_PX.side },
      topBottomSizePx: JUNCTION_PREVIEW_EDGE_PX.topBottom,
      focusSizePx: { width: Math.max(1, focusWidth), height: Math.max(1, focusHeight) },
      centerColumns: Math.max(1, Math.floor(Math.max(1, focusWidth) / charWidthPx)),
      transform: { x: -1, y: 0 },
    };
  }

  if (input.viewportWidth >= input.viewportHeight) {
    const focusWidth = (viewportWidth - JUNCTION_PREVIEW_GAP_PX) / 2;
    const focusHeight = viewportHeight - JUNCTION_PREVIEW_EDGE_PX.topBottom * 2 - JUNCTION_PREVIEW_GAP_PX * 2;
    const secondaryCol = focus.col - 1;
    return {
      form: 'landscape',
      focus,
      visibleCells: [
        { col: focus.col, row: focus.row - 1, edge: 'top' },
        { col: secondaryCol, row: focus.row, edge: 'focus' },
        { col: focus.col, row: focus.row, edge: 'focus' },
        { col: focus.col, row: focus.row + 1, edge: 'bottom' },
      ],
      side: { edge: 'both', sizePx: 0 },
      topBottomSizePx: JUNCTION_PREVIEW_EDGE_PX.topBottom,
      focusSizePx: { width: Math.max(1, focusWidth), height: Math.max(1, focusHeight) },
      centerColumns: 2,
      transform: { x: -1, y: 0 },
    };
  }

  const focusWidth = viewportWidth - JUNCTION_PREVIEW_EDGE_PX.side - JUNCTION_PREVIEW_GAP_PX;
  const focusHeight = viewportHeight - JUNCTION_PREVIEW_EDGE_PX.topBottom * 2 - JUNCTION_PREVIEW_GAP_PX * 2;
  const sideCol = resolvedSideEdge === 'left' ? focus.col - 1 : focus.col + 1;
  const sideCell = { col: sideCol, row: focus.row, edge: resolvedSideEdge } as const;
  return {
    form: 'portrait',
    focus,
    visibleCells: [
      sideCell,
      { col: focus.col, row: focus.row - 1, edge: 'top' },
      { col: focus.col, row: focus.row, edge: 'focus' },
      { col: focus.col, row: focus.row + 1, edge: 'bottom' },
    ],
    side: { edge: resolvedSideEdge, sizePx: JUNCTION_PREVIEW_EDGE_PX.side },
    topBottomSizePx: JUNCTION_PREVIEW_EDGE_PX.topBottom,
    focusSizePx: { width: Math.max(1, focusWidth), height: Math.max(1, focusHeight) },
    centerColumns: Math.max(1, Math.floor(Math.max(1, focusWidth) / charWidthPx)),
    transform: { x: resolvedSideEdge === 'left' ? -1 : 1, y: 0 },
  };
}
