import { describe, expect, it, vi } from 'vitest';
import type { TerminalBufferPayload, TerminalCell } from './types';
import { applyBufferSyncToSessionBuffer, createSessionBufferState } from './terminal-buffer';

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

describe('terminal-buffer replace-only mirror', () => {
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
    expect(String.fromCodePoint(next.lines[0][0].char)).toBe('c');
    expect(String.fromCodePoint(next.lines[3][0].char)).toBe('f');
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

  it('rejects malformed partial payloads instead of merging locally', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
          [104, 'E'],
          [105, 'F'],
          [106, 'G'],
        ],
      }),
      3000,
    );

    expect(next).toBe(current);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
