import { describe, it, expect } from "vitest";
import { mergeGapRanges, collectIntersectingGapRanges, resolveRequestedBufferWindow } from "./gap-utils";

describe("mergeGapRanges", () => {
  it("returns empty for empty input", () => {
    expect(mergeGapRanges([])).toEqual([]);
  });

  it("returns single range unchanged", () => {
    const ranges = [{ startIndex: 10, endIndex: 20 }];
    expect(mergeGapRanges(ranges)).toEqual(ranges);
  });

  it("merges overlapping ranges", () => {
    const ranges = [
      { startIndex: 10, endIndex: 15 },
      { startIndex: 12, endIndex: 18 },
    ];
    expect(mergeGapRanges(ranges)).toEqual([{ startIndex: 10, endIndex: 18 }]);
  });

  it("merges adjacent ranges", () => {
    const ranges = [
      { startIndex: 10, endIndex: 15 },
      { startIndex: 15, endIndex: 20 },
    ];
    expect(mergeGapRanges(ranges)).toEqual([{ startIndex: 10, endIndex: 20 }]);
  });

  it("keeps non overlapping separate", () => {
    const ranges = [
      { startIndex: 10, endIndex: 12 },
      { startIndex: 20, endIndex: 22 },
    ];
    expect(mergeGapRanges(ranges)).toEqual(ranges);
  });
});

describe("collectIntersectingGapRanges", () => {
  it("returns empty when end <= start", () => {
    expect(collectIntersectingGapRanges([{ startIndex: 0, endIndex: 10 }], 5, 5)).toEqual([]);
  });

  it("returns intersecting portions", () => {
    const ranges = [
      { startIndex: 10, endIndex: 20 },
      { startIndex: 30, endIndex: 40 },
    ];
    expect(collectIntersectingGapRanges(ranges, 15, 35)).toEqual([
      { startIndex: 15, endIndex: 20 },
      { startIndex: 30, endIndex: 35 },
    ]);
  });

  it("returns empty if no intersection", () => {
    const ranges = [{ startIndex: 10, endIndex: 20 }];
    expect(collectIntersectingGapRanges(ranges, 30, 40)).toEqual([]);
  });
});

describe("resolveRequestedBufferWindow", () => {
  it("computes window with cache lines", () => {
    const result = resolveRequestedBufferWindow(100, 24, 120, 0);
    expect(result.requestEndIndex).toBe(100);
    expect(result.requestStartIndex).toBe(0);
  });

  it("respects minStartIndex", () => {
    const result = resolveRequestedBufferWindow(50, 24, 120, 10);
    expect(result.requestStartIndex).toBe(10);
    expect(result.requestEndIndex).toBe(50);
  });
});
