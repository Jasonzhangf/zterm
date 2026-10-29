/**
 * Pure positioning helper for the session drawer row action menu.
 *
 * The rendered menu is a fixed-width column of 44px actions. Without a
 * viewport clamp it can be anchored so its only Hide and Close actions fall
 * below the viewport on lower rows and short landscape heights.
 */

export const SLOT_MENU_WIDTH_PX = 160;
export const SLOT_MENU_MARGIN_PX = 12;
export const SLOT_MENU_PADDING_PX = 8;
export const SLOT_MENU_GAP_PX = 8;
export const SLOT_MENU_ACTION_HEIGHT_PX = 44;
export const SLOT_MENU_TITLE_HEIGHT_PX = 19;
export const SLOT_MENU_BORDER_PX = 2;

export type SlotMenuPlacement = 'below' | 'above' | 'clamped';

export interface SlotMenuPositionInput {
  /** Top edge of the anchor (peer or pointer) in viewport coordinates. */
  anchorTop: number;
  /** Bottom edge of the anchor in viewport coordinates. */
  anchorBottom: number;
  /** Horizontal anchor (left edge) in viewport coordinates. */
  anchorLeft: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Measured or budgeted menu height. */
  menuHeight: number;
  menuWidth?: number;
  margin?: number;
  gap?: number;
}

export interface SlotMenuPosition {
  top: number;
  left: number;
  maxHeight: number;
  placement: SlotMenuPlacement;
}

/**
 * Deterministic height budget derived from the rendered action count. Used
 * before/without real measurement (e.g. jsdom, first paint).
 */
export function estimateSlotMenuHeight(actionCount: number): number {
  const actions = Math.max(0, Math.trunc(actionCount));
  return (
    SLOT_MENU_BORDER_PX
    + SLOT_MENU_PADDING_PX * 2
    + SLOT_MENU_TITLE_HEIGHT_PX
    + actions * SLOT_MENU_ACTION_HEIGHT_PX
    + actions * SLOT_MENU_GAP_PX
  );
}

/**
 * Compute the fixed menu rectangle so it always stays inside the viewport.
 *
 * Preference order:
 * 1. Open downward from the anchor when it fits below.
 * 2. Open upward (bottom-anchored to the anchor top) when space above is larger.
 * 3. Otherwise clamp `top` to `margin` and cap `maxHeight` to the remaining
 *    vertical space so the final action stays reachable by scrolling.
 */
export function computeSlotMenuPosition(input: SlotMenuPositionInput): SlotMenuPosition {
  const margin = input.margin ?? SLOT_MENU_MARGIN_PX;
  const gap = input.gap ?? 0;
  const menuWidth = input.menuWidth ?? SLOT_MENU_WIDTH_PX;
  const menuHeight = Math.max(0, input.menuHeight);

  const maxLeft = Math.max(margin, input.viewportWidth - menuWidth - margin);
  const left = Math.min(Math.max(margin, input.anchorLeft), maxLeft);

  const belowTop = input.anchorBottom + gap;
  const spaceBelow = input.viewportHeight - margin - belowTop;
  if (menuHeight <= spaceBelow) {
    return { top: belowTop, left, maxHeight: menuHeight, placement: 'below' };
  }

  const aboveTop = input.anchorTop - gap - menuHeight;
  const spaceAbove = input.anchorTop - gap - margin;
  if (menuHeight <= spaceAbove) {
    return { top: aboveTop, left, maxHeight: menuHeight, placement: 'above' };
  }

  const maxHeight = Math.max(0, input.viewportHeight - margin * 2);
  return { top: margin, left, maxHeight, placement: 'clamped' };
}
