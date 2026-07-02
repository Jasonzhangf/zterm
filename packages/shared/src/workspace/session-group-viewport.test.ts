import { describe, expect, it } from 'vitest';
import {
  resolveSessionGroupBoundaryProjection,
  resolveTerminalSessionGroupSlotReplacement,
  resolveTerminalSessionGroupViewportProjection,
  resolveTerminalSessionGroupViewportSlots,
} from './session-group-viewport';

describe('session-group viewport projection', () => {
  it('keeps fixed before and after slots visible when center is focused', () => {
    expect(resolveSessionGroupBoundaryProjection({
      before: 'top',
      center: 'middle',
      after: 'bottom',
    }, 'center')).toEqual({
      slots: {
        before: 'top',
        center: 'middle',
        after: 'bottom',
      },
      visible: {
        before: true,
        after: true,
      },
    });
  });

  it('hides the before edge when the fixed before slot becomes focused', () => {
    expect(resolveSessionGroupBoundaryProjection({
      before: 'top',
      center: 'middle',
      after: 'bottom',
    }, 'before')).toEqual({
      slots: {
        before: null,
        center: 'top',
        after: 'middle',
      },
      visible: {
        before: false,
        after: true,
      },
    });
  });

  it('hides the after edge when the fixed after slot becomes focused', () => {
    expect(resolveSessionGroupBoundaryProjection({
      before: 'top',
      center: 'middle',
      after: 'bottom',
    }, 'after')).toEqual({
      slots: {
        before: 'middle',
        center: 'bottom',
        after: null,
      },
      visible: {
        before: true,
        after: false,
      },
    });
  });

  it('does not show unset boundary peeks when center is focused', () => {
    expect(resolveTerminalSessionGroupViewportProjection({
      top: null,
      center: 'middle',
      bottom: null,
    }, 'center')).toEqual({
      slots: {
        top: null,
        center: 'middle',
        bottom: null,
      },
      visible: {
        top: false,
        bottom: false,
      },
    });
  });

  it('maps terminal top and bottom slots through the shared boundary projection', () => {
    expect(resolveTerminalSessionGroupViewportSlots({
      top: 'top',
      center: 'middle',
      bottom: 'bottom',
    }, 'bottom')).toEqual({
      top: 'middle',
      center: 'bottom',
      bottom: null,
    });
  });

  it('replaces a fixed slot without duplicating the same session in another slot', () => {
    expect(resolveTerminalSessionGroupSlotReplacement({
      top: 'a',
      center: 'b',
      bottom: 'c',
    }, 'a', 'bottom')).toEqual({
      top: null,
      center: 'b',
      bottom: 'a',
    });
  });
});
