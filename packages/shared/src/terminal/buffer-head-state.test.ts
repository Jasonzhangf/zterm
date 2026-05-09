import { describe, it, expect } from 'vitest';
import {
  resolveHeadAvailableBounds,
  hasImpossibleLocalWindow,
  type SessionBufferHeadState,
} from './buffer-head-state';

function makeBuffer(overrides?: Partial<{ startIndex: number; endIndex: number; revision: number }>) {
  return {
    lines: [],
    gapRanges: [],
    startIndex: overrides?.startIndex ?? 0,
    endIndex: overrides?.endIndex ?? 100,
    bufferHeadStartIndex: 0,
    bufferTailEndIndex: 100,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    cursor: null,
    updateKind: 'replace' as const,
    revision: overrides?.revision ?? 1,
  };
}

function makeHead(overrides?: Partial<SessionBufferHeadState>): SessionBufferHeadState {
  return {
    revision: overrides?.revision ?? 10,
    latestEndIndex: overrides?.latestEndIndex ?? 200,
    availableStartIndex: overrides?.availableStartIndex,
    availableEndIndex: overrides?.availableEndIndex,
    seenAt: overrides?.seenAt ?? 1000,
  };
}

describe('resolveHeadAvailableBounds', () => {
  it('uses head available bounds when present', () => {
    const head = makeHead({ availableStartIndex: 10, availableEndIndex: 500 });
    const buffer = makeBuffer({ startIndex: 0, endIndex: 100 });
    const result = resolveHeadAvailableBounds(head, buffer);
    expect(result.availableStartIndex).toBe(10);
    expect(result.availableEndIndex).toBe(500);
  });

  it('falls back to buffer bounds when head has no available bounds', () => {
    const head = makeHead({ latestEndIndex: 200 });
    const buffer = makeBuffer({ startIndex: 0, endIndex: 100 });
    const result = resolveHeadAvailableBounds(head, buffer);
    expect(result.availableStartIndex).toBe(0);
    expect(result.availableEndIndex).toBe(200);
  });

  it('falls back to buffer endIndex when head has no bounds', () => {
    const head: SessionBufferHeadState = {
      revision: 0,
      latestEndIndex: 0,
      seenAt: 0,
    };
    const buffer = makeBuffer({ startIndex: 0, endIndex: 100 });
    const result = resolveHeadAvailableBounds(head, buffer);
    expect(result.availableStartIndex).toBe(0);
    expect(result.availableEndIndex).toBe(100);
  });

  it('handles null head gracefully', () => {
    const buffer = makeBuffer({ startIndex: 5, endIndex: 50 });
    const result = resolveHeadAvailableBounds(null, buffer);
    expect(result.availableStartIndex).toBe(5);
    expect(result.availableEndIndex).toBeNull();
  });
});

describe('hasImpossibleLocalWindow', () => {
  it('returns false when window is valid', () => {
    const head = makeHead({ availableEndIndex: 500 });
    const buffer = makeBuffer({ startIndex: 0, endIndex: 100 });
    expect(hasImpossibleLocalWindow(head, buffer)).toBe(false);
  });

  it('returns true when buffer start > head available end', () => {
    const head = makeHead({ availableEndIndex: 50 });
    const buffer = makeBuffer({ startIndex: 100, endIndex: 200 });
    expect(hasImpossibleLocalWindow(head, buffer)).toBe(true);
  });

  it('returns false when head is null', () => {
    const buffer = makeBuffer({ startIndex: 0, endIndex: 100 });
    expect(hasImpossibleLocalWindow(null, buffer)).toBe(false);
  });
});
