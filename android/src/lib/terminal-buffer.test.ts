import { describe, expect, it } from 'vitest';
import type { TerminalBufferPayload, TerminalCell } from './types';
import { applyBufferSyncToSessionBuffer, cellsToLine, createSessionBufferState } from './terminal-buffer';

function row(text: string): TerminalCell[] {
  return Array.from(text).map((char) => ({
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  }));
}

function payload(options: {
  startIndex: number;
  endIndex: number;
  viewportEndIndex: number;
  rows?: number;
  lines: Array<[number, string]>;
  revision?: number;
}): TerminalBufferPayload {
  return {
    revision: options.revision ?? 1,
    startIndex: options.startIndex,
    endIndex: options.endIndex,
    viewportEndIndex: options.viewportEndIndex,
    cols: 80,
    rows: options.rows ?? 4,
    cursorKeysApp: false,
    lines: options.lines.map(([index, text]) => ({ index, cells: row(text) })),
  };
}

describe('terminal-buffer canonical mirror patching', () => {
  it('builds the initial local mirror directly from the incoming contiguous buffer-sync', () => {
    const next = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 190,
        endIndex: 210,
        viewportEndIndex: 210,
        lines: Array.from({ length: 20 }, (_, offset) => [190 + offset, `line-${190 + offset}`]),
      }),
      3000,
    );

    expect(next.startIndex).toBe(190);
    expect(next.endIndex).toBe(210);
    expect(next.viewportEndIndex).toBe(210);
    expect(next.lines).toHaveLength(20);
    expect(next.gapRanges).toEqual([]);
  });

  it('replaces the whole local mirror window on a newer revision', () => {
    const current = createSessionBufferState({
      lines: ['a', 'b', 'c', 'd'],
      startIndex: 100,
      endIndex: 104,
      viewportEndIndex: 104,
      rows: 4,
      cols: 80,
      cacheLines: 3000,
      revision: 1,
    });

    const next = applyBufferSyncToSessionBuffer(
      current,
      payload({
        startIndex: 101,
        endIndex: 107,
        viewportEndIndex: 107,
        revision: 2,
        lines: [
          [101, 'b'],
          [102, 'c'],
          [103, 'd'],
          [104, 'E'],
          [105, 'F'],
          [106, 'G'],
        ],
      }),
      3000,
    );

    expect(next.startIndex).toBe(101);
    expect(next.endIndex).toBe(107);
    expect(next.viewportEndIndex).toBe(107);
    expect(next.lines).toHaveLength(6);
    expect(next.gapRanges).toEqual([]);
    expect(String.fromCodePoint(next.lines[0][0].char)).toBe('b');
    expect(String.fromCodePoint(next.lines[5][0].char)).toBe('G');
  });

  it('keeps only the latest cache window when incoming full buffer exceeds cacheLines', () => {
    const next = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 0,
        endIndex: 6,
        viewportEndIndex: 6,
        revision: 1,
        lines: [
          [0, 'a'],
          [1, 'b'],
          [2, 'c'],
          [3, 'd'],
          [4, 'e'],
          [5, 'f'],
        ],
      }),
      4,
    );

    expect(next.startIndex).toBe(2);
    expect(next.endIndex).toBe(6);
    expect(next.lines).toHaveLength(4);
    expect(next.gapRanges).toEqual([]);
    expect(String.fromCodePoint(next.lines[0][0].char)).toBe('c');
    expect(String.fromCodePoint(next.lines[3][0].char)).toBe('f');
  });


  it('keeps the cache window centered on the reading viewport instead of always trimming to the newest tail', () => {
    const next = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 0,
        endIndex: 12,
        viewportEndIndex: 6,
        rows: 4,
        revision: 1,
        lines: Array.from({ length: 12 }, (_, index) => [index, `line-${index}`]),
      }),
      4,
    );

    expect(next.startIndex).toBe(2);
    expect(next.endIndex).toBe(6);
    expect(next.viewportEndIndex).toBe(6);
    expect(next.lines.map(cellsToLine)).toEqual(['line-2', 'line-3', 'line-4', 'line-5']);
  });

  it('ignores stale revisions', () => {
    const current = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 0,
        endIndex: 2,
        viewportEndIndex: 2,
        revision: 5,
        lines: [
          [0, 'new-a'],
          [1, 'new-b'],
        ],
      }),
      3000,
    );

    const next = applyBufferSyncToSessionBuffer(
      current,
      payload({
        startIndex: 0,
        endIndex: 2,
        viewportEndIndex: 2,
        revision: 4,
        lines: [
          [0, 'old-a'],
          [1, 'old-b'],
        ],
      }),
      3000,
    );

    expect(next).toBe(current);
    expect(next.revision).toBe(5);
  });

  it('patches a valid append-only partial payload onto the current contiguous window', () => {
    const current = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 100,
        endIndex: 106,
        viewportEndIndex: 106,
        revision: 2,
        lines: [
          [100, 'a'],
          [101, 'b'],
          [102, 'c'],
          [103, 'd'],
          [104, 'e'],
          [105, 'f'],
        ],
      }),
      3000,
    );

    const next = applyBufferSyncToSessionBuffer(
      current,
      payload({
        startIndex: 101,
        endIndex: 107,
        viewportEndIndex: 107,
        revision: 3,
        lines: [
          [106, 'G'],
        ],
      }),
      3000,
    );

    expect(next.startIndex).toBe(101);
    expect(next.endIndex).toBe(107);
    expect(next.lines.map(cellsToLine)).toEqual(['b', 'c', 'd', 'e', 'f', 'G']);
    expect(next.gapRanges).toEqual([]);
  });

  it('patches a valid middle span partial payload onto the current contiguous window', () => {
    const current = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 100,
        endIndex: 106,
        viewportEndIndex: 106,
        revision: 2,
        lines: [
          [100, 'a'],
          [101, 'b'],
          [102, 'c'],
          [103, 'd'],
          [104, 'e'],
          [105, 'f'],
        ],
      }),
      3000,
    );

    const next = applyBufferSyncToSessionBuffer(
      current,
      payload({
        startIndex: 100,
        endIndex: 106,
        viewportEndIndex: 106,
        revision: 3,
        lines: [
          [102, 'C'],
          [103, 'D'],
        ],
      }),
      3000,
    );

    expect(next.lines.map(cellsToLine)).toEqual(['a', 'b', 'C', 'D', 'e', 'f']);
    expect(next.gapRanges).toEqual([]);
  });

  it('keeps sparse gaps when the requested window still has unknown rows', () => {
    const next = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 98,
        endIndex: 107,
        viewportEndIndex: 107,
        revision: 3,
        lines: [
          [98, 'Y'],
          [99, 'Z'],
          [106, 'G'],
        ],
      }),
      3000,
    );

    expect(next.startIndex).toBe(98);
    expect(next.endIndex).toBe(107);
    expect(next.gapRanges).toEqual([{ startIndex: 100, endIndex: 106 }]);
    expect(next.lines.map(cellsToLine)).toEqual(['Y', 'Z', '', '', '', '', '', '', 'G']);
  });

  it('auto-stitches older rows onto the current local cache without forcing a full reload', () => {
    const current = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 100,
        endIndex: 106,
        viewportEndIndex: 106,
        revision: 2,
        lines: [
          [100, 'a'],
          [101, 'b'],
          [102, 'c'],
          [103, 'd'],
          [104, 'e'],
          [105, 'f'],
        ],
      }),
      3000,
    );

    const next = applyBufferSyncToSessionBuffer(
      current,
      payload({
        startIndex: 98,
        endIndex: 107,
        viewportEndIndex: 107,
        revision: 3,
        lines: [
          [98, 'Y'],
          [99, 'Z'],
          [106, 'G'],
        ],
      }),
      3000,
    );

    expect(next.gapRanges).toEqual([]);
    expect(next.lines.map(cellsToLine)).toEqual(['Y', 'Z', 'a', 'b', 'c', 'd', 'e', 'f', 'G']);
  });


  it('moves the local cache window upward when reading older history is fetched', () => {
    const current = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 188,
        endIndex: 200,
        viewportEndIndex: 200,
        rows: 4,
        revision: 2,
        lines: Array.from({ length: 12 }, (_, offset) => [188 + offset, `line-${188 + offset}`]),
      }),
      12,
    );

    const next = applyBufferSyncToSessionBuffer(
      current,
      payload({
        startIndex: 180,
        endIndex: 192,
        viewportEndIndex: 188,
        rows: 4,
        revision: 3,
        lines: Array.from({ length: 12 }, (_, offset) => [180 + offset, `line-${180 + offset}`]),
      }),
      12,
    );

    expect(next.startIndex).toBe(180);
    expect(next.endIndex).toBe(192);
    expect(next.viewportEndIndex).toBe(188);
    expect(next.lines.map(cellsToLine)).toEqual([
      'line-180', 'line-181', 'line-182', 'line-183',
      'line-184', 'line-185', 'line-186', 'line-187',
      'line-188', 'line-189', 'line-190', 'line-191',
    ]);
  });
});
