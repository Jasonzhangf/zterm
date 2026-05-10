import { describe, it, expect } from 'vitest';
import {
  resolveVisibleRangeViewportRows,
  resolveVisibleRangeEndIndex,
  buildDefaultVisibleRange,
  normalizeVisibleRange,
  visibleRangesEqual,
  resolveTailTargetEndIndex,
  type VisibleRangeState,
} from './visible-range';

describe('resolveVisibleRangeViewportRows', () => {
  it('uses visibleRange.viewportRows when valid', () => {
    expect(resolveVisibleRangeViewportRows(24, { startIndex: 0, endIndex: 24, viewportRows: 30 })).toBe(30);
  });
  it('falls back to bufferRows when visibleRange is undefined', () => {
    expect(resolveVisibleRangeViewportRows(24, undefined)).toBe(24);
  });
  it('falls back to bufferRows when viewportRows is invalid', () => {
    expect(resolveVisibleRangeViewportRows(24, { startIndex: 0, endIndex: 24, viewportRows: -1 })).toBe(24);
  });
  it('throws when both are invalid', () => {
    expect(() => resolveVisibleRangeViewportRows(-1, undefined)).toThrow();
  });
  it('clamps zero viewportRows to bufferRows', () => {
    expect(resolveVisibleRangeViewportRows(40, { startIndex: 0, endIndex: 40, viewportRows: 0 })).toBe(40);
  });
  it('clamps non-finite viewportRows to bufferRows', () => {
    expect(resolveVisibleRangeViewportRows(40, { startIndex: 0, endIndex: 40, viewportRows: Infinity })).toBe(40);
  });
});

describe('resolveVisibleRangeEndIndex', () => {
  it('uses visibleRange.endIndex when valid', () => {
    expect(resolveVisibleRangeEndIndex(100, 80, 70, { startIndex: 50, endIndex: 80, viewportRows: 30 })).toBe(80);
  });
  it('falls back to daemonHeadEndIndex', () => {
    expect(resolveVisibleRangeEndIndex(100, 80, 70, undefined)).toBe(100);
  });
  it('falls back to bufferTailEndIndex when daemonHead is 0', () => {
    expect(resolveVisibleRangeEndIndex(0, 80, 70, undefined)).toBe(80);
  });
  it('falls back to bufferEndIndex when others are 0', () => {
    expect(resolveVisibleRangeEndIndex(0, 0, 70, undefined)).toBe(70);
  });
  it('returns 0 when all are 0', () => {
    expect(resolveVisibleRangeEndIndex(0, 0, 0, undefined)).toBe(0);
  });
});

describe('buildDefaultVisibleRange', () => {
  it('builds correct default range', () => {
    const result = buildDefaultVisibleRange(24, 100, 80, 70);
    expect(result.viewportRows).toBe(24);
    expect(result.endIndex).toBe(100);
    expect(result.startIndex).toBe(76);
  });
  it('preserves previous viewportRows', () => {
    const prev: VisibleRangeState = { startIndex: 0, endIndex: 50, viewportRows: 30 };
    const result = buildDefaultVisibleRange(24, 100, 80, 70, prev);
    expect(result.viewportRows).toBe(30);
  });
  it('clamps startIndex to 0', () => {
    const result = buildDefaultVisibleRange(24, 10, 8, 6);
    expect(result.startIndex).toBe(0);
    expect(result.endIndex).toBe(10);
  });
});

describe('normalizeVisibleRange', () => {
  it('normalizes valid range', () => {
    expect(normalizeVisibleRange({ startIndex: 5, endIndex: 30, viewportRows: 25 })).toEqual({
      startIndex: 5, endIndex: 30, viewportRows: 25,
    });
  });
  it('clamps startIndex to >= 0', () => {
    expect(normalizeVisibleRange({ startIndex: -5, endIndex: 20, viewportRows: 25 }).startIndex).toBe(0);
  });
  it('clamps startIndex <= endIndex', () => {
    expect(normalizeVisibleRange({ startIndex: 100, endIndex: 20, viewportRows: 25 }).startIndex).toBe(20);
  });
  it('clamps viewportRows >= 1', () => {
    expect(normalizeVisibleRange({ startIndex: 0, endIndex: 20, viewportRows: 0 }).viewportRows).toBe(1);
  });
});

describe('visibleRangesEqual', () => {
  const range: VisibleRangeState = { startIndex: 10, endIndex: 40, viewportRows: 30 };
  it('returns true for identical ranges', () => {
    expect(visibleRangesEqual(range, { ...range })).toBe(true);
  });
  it('returns false when startIndex differs', () => {
    expect(visibleRangesEqual(range, { ...range, startIndex: 11 })).toBe(false);
  });
  it('returns false when endIndex differs', () => {
    expect(visibleRangesEqual(range, { ...range, endIndex: 41 })).toBe(false);
  });
  it('returns false when viewportRows differs', () => {
    expect(visibleRangesEqual(range, { ...range, viewportRows: 31 })).toBe(false);
  });
  it('returns false when either is undefined', () => {
    expect(visibleRangesEqual(undefined, range)).toBe(false);
    expect(visibleRangesEqual(range, undefined)).toBe(false);
    expect(visibleRangesEqual(undefined, undefined)).toBe(false);
  });
});

describe("resolveTailTargetEndIndex", () => {

  it("uses daemonHeadEndIndex when valid", () => {
    expect(resolveTailTargetEndIndex(200, 100)).toBe(200);
  });

  it("falls back to fallbackEndIndex when daemonHeadEndIndex is missing", () => {
    expect(resolveTailTargetEndIndex(undefined, 100)).toBe(100);
  });

  it("falls back to fallbackEndIndex when daemonHeadEndIndex is null", () => {
    expect(resolveTailTargetEndIndex(null, 100)).toBe(100);
  });

  it("clamps negative values to 0", () => {
    expect(resolveTailTargetEndIndex(-10, 100)).toBe(0);
    expect(resolveTailTargetEndIndex(-10, -50)).toBe(0);
  });

  it("handles finite check: Infinity falls back", () => {
    expect(resolveTailTargetEndIndex(Infinity, 100)).toBe(100);
  });
});
