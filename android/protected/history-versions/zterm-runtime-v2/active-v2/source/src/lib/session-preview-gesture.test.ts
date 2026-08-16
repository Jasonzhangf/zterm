import { describe, expect, it } from 'vitest';
import {
  beginSessionPreviewGesture,
  createSessionPreviewGestureState,
  resolveSessionPreviewGesture,
  updateSessionPreviewGesture,
} from './session-preview-gesture';

describe('session preview right-edge gesture', () => {
  it('admits one horizontal left swipe from the right edge', () => {
    let state = beginSessionPreviewGesture(338, 400, 360);
    state = updateSessionPreviewGesture(state, 270, 404);
    expect(resolveSessionPreviewGesture(state)).toBe('open-preview');
  });

  it.each([
    ['middle start', 200, 120, 404],
    ['left edge start', 40, 0, 404],
    ['wrong direction', 338, 359, 404],
    ['vertical movement', 338, 330, 480],
    ['short movement', 338, 320, 402],
  ])('rejects %s', (_name, startX, endX, endY) => {
    let state = beginSessionPreviewGesture(startX as number, 400, 360);
    state = updateSessionPreviewGesture(state, endX as number, endY as number);
    expect(resolveSessionPreviewGesture(state)).toBeNull();
  });

  it('keeps an unarmed state inert', () => {
    expect(resolveSessionPreviewGesture(createSessionPreviewGestureState())).toBeNull();
  });
});
