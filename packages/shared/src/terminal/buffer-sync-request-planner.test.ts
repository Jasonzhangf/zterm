import { describe, it, expect } from 'vitest';
import {
  resolveTailRefreshWindow,
  resolveReadingRepairMissingRanges,
} from './buffer-sync-request-planner';

describe('resolveTailRefreshWindow', () => {
  const base = {
    authoritativeHeadStartIndex: 0,
    viewportEndIndex: 100,
    viewportRows: 40,
    cacheLines: 40,
    localHasWindow: true,
    distanceToHead: 0,
    sameEndRevisionAdvanced: false,
    sameEndWindowHasLocalGaps: false,
    invalidLocalWindow: false,
  };

  it('Branch 1: requestWindowOverride overrides and clamps to authoritativeHeadStartIndex', () => {
    const result = resolveTailRefreshWindow({
      ...base,
      requestWindowOverride: { requestStartIndex: 5, requestEndIndex: 80 },
    });
    expect(result.requestStartIndex).toBe(5);
    expect(result.requestEndIndex).toBe(80);
  });

  it('Branch 1: requestWindowOverride clamps low values to authoritativeHeadStartIndex', () => {
    const result = resolveTailRefreshWindow({
      ...base,
      authoritativeHeadStartIndex: 50,
      requestWindowOverride: { requestStartIndex: 10, requestEndIndex: 30 },
    });
    expect(result.requestStartIndex).toBe(50);
    expect(result.requestEndIndex).toBe(50);
  });

  it('Branch 2: no local window → visible window', () => {
    const result = resolveTailRefreshWindow({
      ...base,
      localHasWindow: false,
    });
    expect(result.requestStartIndex).toBe(60);
    expect(result.requestEndIndex).toBe(100);
  });

  it('Branch 2: invalidLocalWindow → visible window', () => {
    const result = resolveTailRefreshWindow({
      ...base,
      invalidLocalWindow: true,
    });
    expect(result.requestStartIndex).toBe(60);
    expect(result.requestEndIndex).toBe(100);
  });

  it('Branch 2: distanceToHead > cacheLines → visible window', () => {
    const result = resolveTailRefreshWindow({
      ...base,
      distanceToHead: 200,
    });
    expect(result.requestStartIndex).toBe(60);
    expect(result.requestEndIndex).toBe(100);
  });

  it('Branch 2: scrollback reset requests the fresh authoritative tail, not the stale local window', () => {
    const result = resolveTailRefreshWindow({
      ...base,
      authoritativeHeadStartIndex: 47,
      viewportEndIndex: 50,
      distanceToHead: 200,
      invalidLocalWindow: false,
    });
    expect(result.requestStartIndex).toBe(47);
    expect(result.requestEndIndex).toBe(50);
  });

  it('Branch 3: distanceToHead > 0 → incremental from local end', () => {
    // distanceToHead = 20, so localEndIndex = 100 - 20 = 80
    const result = resolveTailRefreshWindow({
      ...base,
      distanceToHead: 20,
    });
    expect(result.requestStartIndex).toBe(80);
    expect(result.requestEndIndex).toBe(100);
  });

  it('Branch 3: distanceToHead > 0 clamped by authoritativeHeadStartIndex', () => {
    const result = resolveTailRefreshWindow({
      ...base,
      distanceToHead: 20,
      authoritativeHeadStartIndex: 90,
    });
    // max(90, 100 - 20) = max(90, 80) = 90
    expect(result.requestStartIndex).toBe(90);
    expect(result.requestEndIndex).toBe(100);
  });

  it('Branch 4: sameEndRevisionAdvanced with gaps → visible rows window', () => {
    const result = resolveTailRefreshWindow({
      ...base,
      sameEndRevisionAdvanced: true,
      sameEndWindowHasLocalGaps: true,
    });
    // max(0, 100 - 40) = 60
    expect(result.requestStartIndex).toBe(60);
    expect(result.requestEndIndex).toBe(100);
  });

  it('Branch 4.5: forceSameEndRefresh still stays inside the visible window', () => {
    const result = resolveTailRefreshWindow({
      ...base,
      authoritativeHeadStartIndex: 8,
      sameEndRevisionAdvanced: true,
      sameEndWindowHasLocalGaps: true,
      forceSameEndRefresh: true,
    });
    expect(result.requestStartIndex).toBe(60);
    expect(result.requestEndIndex).toBe(100);
  });

  it('Branch 5: sameEndRevisionAdvanced without gaps → visible window', () => {
    const result = resolveTailRefreshWindow({
      ...base,
      sameEndRevisionAdvanced: true,
      sameEndWindowHasLocalGaps: false,
    });
    expect(result.requestStartIndex).toBe(60);
    expect(result.requestEndIndex).toBe(100);
  });

  it('Branch 6: default incremental from local end', () => {
    const result = resolveTailRefreshWindow(base);
    expect(result.requestStartIndex).toBe(60);
    expect(result.requestEndIndex).toBe(100);
  });

  it('Branch 6: default incremental with non-zero authoritativeHeadStartIndex', () => {
    const result = resolveTailRefreshWindow({
      ...base,
      authoritativeHeadStartIndex: 50,
    });
    expect(result.requestStartIndex).toBe(60);
    expect(result.requestEndIndex).toBe(100);
  });
});

describe('resolveReadingRepairMissingRanges', () => {
  it('returns empty when visible range is empty', () => {
    const result = resolveReadingRepairMissingRanges({
      visibleStartIndex: 100,
      visibleEndIndex: 100,
      localStartIndex: 0,
      localEndIndex: 200,
      localGapRanges: [],
    });
    expect(result).toEqual([]);
  });

  it('returns empty when local covers visible with no gaps', () => {
    const result = resolveReadingRepairMissingRanges({
      visibleStartIndex: 50,
      visibleEndIndex: 100,
      localStartIndex: 0,
      localEndIndex: 200,
      localGapRanges: [],
    });
    expect(result).toEqual([]);
  });

  it('detects gap before local buffer', () => {
    const result = resolveReadingRepairMissingRanges({
      visibleStartIndex: 50,
      visibleEndIndex: 100,
      localStartIndex: 70,
      localEndIndex: 200,
      localGapRanges: [],
    });
    expect(result).toEqual([{ startIndex: 50, endIndex: 70 }]);
  });

  it('detects gap after local buffer', () => {
    const result = resolveReadingRepairMissingRanges({
      visibleStartIndex: 50,
      visibleEndIndex: 100,
      localStartIndex: 0,
      localEndIndex: 80,
      localGapRanges: [],
    });
    expect(result).toEqual([{ startIndex: 80, endIndex: 100 }]);
  });

  it('detects gaps before + after + inner', () => {
    const result = resolveReadingRepairMissingRanges({
      visibleStartIndex: 50,
      visibleEndIndex: 100,
      localStartIndex: 60,
      localEndIndex: 90,
      localGapRanges: [{ startIndex: 70, endIndex: 75 }],
    });
    // before: [50, 60), inner: [70, 75), after: [90, 100)
    expect(result.length).toBe(3);
    expect(result[0]).toEqual({ startIndex: 50, endIndex: 60 });
    expect(result[1]).toEqual({ startIndex: 70, endIndex: 75 });
    expect(result[2]).toEqual({ startIndex: 90, endIndex: 100 });
  });
});
