import { describe, expect, it } from 'vitest';
import {
  COPY_LONG_PRESS_DELAY_MS,
  COPY_LONG_PRESS_MOVE_THRESHOLD_PX,
  hasCopyLongPressMovedTooFar,
} from './terminal-copy-gesture';

describe('terminal-copy-gesture', () => {
  it('keeps the copy long-press timer at the locked delay', () => {
    expect(COPY_LONG_PRESS_DELAY_MS).toBe(420);
  });

  it('keeps the copy long-press move threshold at the locked slop', () => {
    expect(COPY_LONG_PRESS_MOVE_THRESHOLD_PX).toBe(10);
  });

  it('treats movement above the threshold as a cancel', () => {
    expect(hasCopyLongPressMovedTooFar({ x: 12, y: 18 }, 23, 18)).toBe(true);
    expect(hasCopyLongPressMovedTooFar({ x: 12, y: 18 }, 12, 29)).toBe(true);
    expect(hasCopyLongPressMovedTooFar({ x: 12, y: 18 }, 20, 18)).toBe(false);
  });
});
