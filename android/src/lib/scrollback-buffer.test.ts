import { describe, expect, it } from 'vitest';
import { mergeIndexedScrollbackRanges, reconcileAbsoluteScrollbackRange, toContiguousLatestRange } from './scrollback-buffer';

describe('scrollback buffer helpers', () => {
  it('keeps only the latest contiguous suffix when merged indexes contain a gap', () => {
    const merged = mergeIndexedScrollbackRanges(
      { startIndex: 10, lines: ['10', '11', '12'] },
      { startIndex: 14, lines: ['14', '15'] },
    );

    expect(merged.startIndex).toBe(14);
    expect(merged.lines).toEqual(['14', '15']);
  });

  it('preserves overlap while extending the latest contiguous range', () => {
    const merged = mergeIndexedScrollbackRanges(
      { startIndex: 100, lines: ['100', '101', '102'] },
      { startIndex: 102, lines: ['102*', '103', '104'] },
    );

    expect(merged.startIndex).toBe(100);
    expect(merged.lines).toEqual(['100', '101', '102*', '103', '104']);
  });

  it('can collapse sparse entries into a latest contiguous range', () => {
    const range = toContiguousLatestRange([
      [40, '40'],
      [41, '41'],
      [44, '44'],
      [45, '45'],
    ]);

    expect(range.startIndex).toBe(44);
    expect(range.lines).toEqual(['44', '45']);
  });
});

describe('absolute scrollback range', () => {
  it('starts from zero on initial snapshot', () => {
    const range = reconcileAbsoluteScrollbackRange({
      lastScrollbackCount: -1,
      nextIndex: 0,
    }, 6);

    expect(range.startIndex).toBe(0);
    expect(range.nextIndex).toBe(6);
  });

  it('advances next index monotonically when new lines arrive', () => {
    const range = reconcileAbsoluteScrollbackRange({
      lastScrollbackCount: 6,
      nextIndex: 6,
    }, 9);

    expect(range.startIndex).toBe(0);
    expect(range.nextIndex).toBe(9);
  });

  it('preserves the latest absolute tail when bridge scrollback count shrinks', () => {
    const range = reconcileAbsoluteScrollbackRange({
      lastScrollbackCount: 20,
      nextIndex: 120,
    }, 8);

    expect(range.startIndex).toBe(112);
    expect(range.nextIndex).toBe(120);
  });
});
