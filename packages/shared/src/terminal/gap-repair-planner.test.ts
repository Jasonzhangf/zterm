import { describe, it, expect } from 'vitest';
import { computeVisibleRangeRepairRanges } from './gap-repair-planner';

describe('computeVisibleRangeRepairRanges', () => {
  it('returns empty when visible window is zero', () => {
    expect(computeVisibleRangeRepairRanges({
      visibleStartIndex: 50,
      visibleEndIndex: 50,
      localStartIndex: 0,
      localEndIndex: 100,
      localGapRanges: [],
    })).toEqual([]);
  });

  it('returns empty when local buffer fully covers visible window', () => {
    expect(computeVisibleRangeRepairRanges({
      visibleStartIndex: 20,
      visibleEndIndex: 80,
      localStartIndex: 0,
      localEndIndex: 100,
      localGapRanges: [],
    })).toEqual([]);
  });

  it('detects leading gap when localStart > visibleStart', () => {
    const result = computeVisibleRangeRepairRanges({
      visibleStartIndex: 10,
      visibleEndIndex: 80,
      localStartIndex: 30,
      localEndIndex: 100,
      localGapRanges: [],
    });
    expect(result).toEqual([{ startIndex: 10, endIndex: 30 }]);
  });

  it('detects trailing gap when localEnd < visibleEnd', () => {
    const result = computeVisibleRangeRepairRanges({
      visibleStartIndex: 10,
      visibleEndIndex: 80,
      localStartIndex: 0,
      localEndIndex: 60,
      localGapRanges: [],
    });
    expect(result).toEqual([{ startIndex: 60, endIndex: 80 }]);
  });

  it('detects internal gaps from localGapRanges', () => {
    const result = computeVisibleRangeRepairRanges({
      visibleStartIndex: 0,
      visibleEndIndex: 100,
      localStartIndex: 0,
      localEndIndex: 100,
      localGapRanges: [{ startIndex: 30, endIndex: 40 }, { startIndex: 70, endIndex: 80 }],
    });
    expect(result).toEqual([
      { startIndex: 30, endIndex: 40 },
      { startIndex: 70, endIndex: 80 },
    ]);
  });

  it('detects all three gap types simultaneously', () => {
    const result = computeVisibleRangeRepairRanges({
      visibleStartIndex: 10,
      visibleEndIndex: 90,
      localStartIndex: 30,
      localEndIndex: 70,
      localGapRanges: [{ startIndex: 45, endIndex: 55 }],
    });
    expect(result).toEqual([
      { startIndex: 10, endIndex: 30 },
      { startIndex: 45, endIndex: 55 },
      { startIndex: 70, endIndex: 90 },
    ]);
  });

  it('merges adjacent gap ranges', () => {
    const result = computeVisibleRangeRepairRanges({
      visibleStartIndex: 0,
      visibleEndIndex: 100,
      localStartIndex: 50,
      localEndIndex: 50,
      localGapRanges: [],
    });
    // localStart=50 > visibleStart=0 → leading gap [0,50)
    // localEnd=50 < visibleEnd=100 → trailing gap [50,100)
    // These are adjacent so should merge
    expect(result).toEqual([{ startIndex: 0, endIndex: 100 }]);
  });

  it('returns empty when buffer has no gaps and full coverage', () => {
    expect(computeVisibleRangeRepairRanges({
      visibleStartIndex: 0,
      visibleEndIndex: 100,
      localStartIndex: 0,
      localEndIndex: 100,
      localGapRanges: [],
    })).toEqual([]);
  });
});
