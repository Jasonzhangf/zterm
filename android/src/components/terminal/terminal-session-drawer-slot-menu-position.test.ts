import { describe, expect, it } from 'vitest';
import {
  SLOT_MENU_MARGIN_PX,
  computeSlotMenuPosition,
  estimateSlotMenuHeight,
} from './terminal-session-drawer-slot-menu-position';

const MENU_HEIGHT = 200;

function baseInput(overrides: Partial<Parameters<typeof computeSlotMenuPosition>[0]> = {}) {
  return {
    anchorTop: 100,
    anchorBottom: 144,
    anchorLeft: 12,
    viewportWidth: 400,
    viewportHeight: 900,
    menuHeight: MENU_HEIGHT,
    ...overrides,
  };
}

describe('computeSlotMenuPosition', () => {
  it('opens below the anchor when there is enough space below', () => {
    const position = computeSlotMenuPosition(baseInput());

    expect(position.placement).toBe('below');
    expect(position.top).toBe(144);
    expect(position.maxHeight).toBe(MENU_HEIGHT);
    expect(position.top + MENU_HEIGHT).toBeLessThanOrEqual(900 - SLOT_MENU_MARGIN_PX);
  });

  it('flips above the anchor when it is near the bottom and space above is larger', () => {
    const position = computeSlotMenuPosition(baseInput({
      anchorTop: 780,
      anchorBottom: 800,
      viewportHeight: 900,
    }));

    expect(position.placement).toBe('above');
    expect(position.top).toBe(580);
    expect(position.maxHeight).toBe(MENU_HEIGHT);
    expect(position.top + MENU_HEIGHT).toBeLessThanOrEqual(800);
  });

  it('clamps to the margin and reduces maxHeight when neither side fits (short landscape)', () => {
    const position = computeSlotMenuPosition(baseInput({
      anchorTop: 150,
      anchorBottom: 200,
      viewportHeight: 300,
      menuHeight: 349,
    }));

    expect(position.placement).toBe('clamped');
    expect(position.top).toBe(SLOT_MENU_MARGIN_PX);
    expect(position.maxHeight).toBe(300 - SLOT_MENU_MARGIN_PX * 2);
    expect(position.top + position.maxHeight).toBeLessThanOrEqual(300);
  });

  it('clamps horizontally so the 160px menu stays inside the viewport', () => {
    const position = computeSlotMenuPosition(baseInput({
      anchorLeft: 320,
      viewportWidth: 360,
    }));

    expect(position.left).toBe(360 - 160 - SLOT_MENU_MARGIN_PX);
    expect(position.left + 160).toBeLessThanOrEqual(360);
  });
});

describe('estimateSlotMenuHeight', () => {
  it('grows with the rendered action count and stays within a plausible budget', () => {
    const three = estimateSlotMenuHeight(3);
    const six = estimateSlotMenuHeight(6);

    expect(six).toBeGreaterThan(three);
    expect(six).toBe(37 + 6 * 52);
  });
});
