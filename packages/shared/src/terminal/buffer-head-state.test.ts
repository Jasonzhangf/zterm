import { describe, it, expect } from 'vitest';
import {
  resolveHeadAvailableBounds,
  resolveAuthoritativeAvailableEndIndex,
  hasImpossibleLocalWindow,
  hasLocalWindow,
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

describe('resolveAuthoritativeAvailableEndIndex', () => {

  it('uses headAvailableEndIndex when provided', () => {
    expect(resolveAuthoritativeAvailableEndIndex(500, 0, 0, 0, 0, 0)).toBe(500);
  });

  it('falls back to headLatestEndIndex when headAvailableEndIndex missing', () => {
    expect(resolveAuthoritativeAvailableEndIndex(null, 300, 0, 0, 0, 0)).toBe(300);
  });

  it('falls back to daemonHeadEndIndex when head fields missing and daemon has revision', () => {
    expect(resolveAuthoritativeAvailableEndIndex(null, 0, 10, 200, 0, 0)).toBe(200);
  });

  it('falls back to bufferTailEndIndex when no head and daemonHeadEndIndex zero', () => {
    expect(resolveAuthoritativeAvailableEndIndex(null, 0, 0, 0, 150, 0)).toBe(150);
  });

  it('falls back to bufferEndIndex when other sources are zero', () => {
    expect(resolveAuthoritativeAvailableEndIndex(null, 0, 0, 0, 0, 80)).toBe(80);
  });

  it('returns null when all sources are zero/invalid', () => {
    expect(resolveAuthoritativeAvailableEndIndex(null, 0, 0, 0, 0, 0)).toBeNull();
  });

  it('clamps negative values to 0', () => {
    expect(resolveAuthoritativeAvailableEndIndex(-10, 0, 0, 0, 0, 0)).toBe(0);
  });
});

describe('hasLocalWindow', () => {

  it('returns true when valid window exists', () => {
    expect(hasLocalWindow(0, 100, 1)).toBe(true);
  });

  it('returns false when startIndex == endIndex', () => {
    expect(hasLocalWindow(50, 50, 1)).toBe(false);
  });

  it('returns false when revision is 0', () => {
    expect(hasLocalWindow(0, 100, 0)).toBe(false);
  });

  it('returns false when endIndex < startIndex', () => {
    expect(hasLocalWindow(100, 50, 1)).toBe(false);
  });

  it('returns false when revision is negative', () => {
    expect(hasLocalWindow(0, 100, -1)).toBe(false);
  });
});
