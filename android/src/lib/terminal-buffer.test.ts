import { describe, expect, it } from 'vitest';
import type { TerminalBufferPayload, TerminalCell } from './types';
import {
  applyBufferDeltaToSessionBuffer,
  applyBufferRangeToSessionBuffer,
  applyBufferSyncToSessionBuffer,
  createSessionBufferState,
} from './terminal-buffer';

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
  availableStart: number;
  availableEnd: number;
  viewportStart: number;
  rows?: number;
  lines: Array<[number, string]>;
}): TerminalBufferPayload {
  const rows = options.rows ?? 4;
  return {
    revision: 1,
    startIndex: options.availableStart,
    endIndex: options.availableEnd,
    viewportStartIndex: options.viewportStart,
    viewportEndIndex: options.viewportStart + rows,
    cols: 80,
    rows,
    cursorRow: options.viewportStart + rows - 1,
    cursorCol: 0,
    cursorVisible: true,
    cursorKeysApp: false,
    lines: options.lines.map(([index, text]) => ({ index, cells: row(text) })),
  };
}

describe('terminal-buffer local mirror merge', () => {
  it('keeps only the concrete initial sync slice while tracking broader daemon availability', () => {
    const next = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        availableStart: 100,
        availableEnd: 210,
        viewportStart: 206,
        lines: [
          [190, 'a'],
          [191, 'b'],
          [192, 'c'],
          [193, 'd'],
          [194, 'e'],
          [195, 'f'],
          [196, 'g'],
          [197, 'h'],
          [198, 'i'],
          [199, 'j'],
          [200, 'k'],
          [201, 'l'],
          [202, 'm'],
          [203, 'n'],
          [204, 'o'],
          [205, 'p'],
          [206, 'q'],
          [207, 'r'],
          [208, 's'],
          [209, 't'],
        ],
      }),
      3000,
    );

    expect(next.startIndex).toBe(190);
    expect(next.endIndex).toBe(210);
    expect(next.availableStartIndex).toBe(100);
    expect(next.availableEndIndex).toBe(210);
    expect(next.viewportStartIndex).toBe(206);
    expect(next.viewportEndIndex).toBe(210);
    expect(next.lines).toHaveLength(20);
  });

  it('prepends contiguous history without dropping the existing bottom window', () => {
    const current = createSessionBufferState({
      lines: ['f', 'g', 'h', 'i'],
      startIndex: 105,
      endIndex: 109,
      availableStartIndex: 90,
      availableEndIndex: 109,
      viewportStartIndex: 105,
      viewportEndIndex: 109,
      rows: 4,
      cols: 80,
      cacheLines: 3000,
    });

    const next = applyBufferRangeToSessionBuffer(
      current,
      payload({
        availableStart: 90,
        availableEnd: 109,
        viewportStart: 105,
        lines: [
          [101, 'b'],
          [102, 'c'],
          [103, 'd'],
          [104, 'e'],
        ],
      }),
      3000,
    );

    expect(next.startIndex).toBe(101);
    expect(next.endIndex).toBe(109);
    expect(next.lines).toHaveLength(8);
    expect(String.fromCodePoint(next.lines[0][0].char)).toBe('b');
    expect(String.fromCodePoint(next.lines[7][0].char)).toBe('i');
  });

  it('applies bottom deltas without trimming reading history', () => {
    const current = createSessionBufferState({
      lines: ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      startIndex: 101,
      endIndex: 109,
      availableStartIndex: 90,
      availableEndIndex: 109,
      viewportStartIndex: 105,
      viewportEndIndex: 109,
      rows: 4,
      cols: 80,
      cacheLines: 3000,
    });

    const next = applyBufferDeltaToSessionBuffer(
      current,
      payload({
        availableStart: 91,
        availableEnd: 110,
        viewportStart: 106,
        lines: [
          [106, 'g'],
          [107, 'h'],
          [108, 'i'],
          [109, 'j'],
        ],
      }),
      3000,
    );

    expect(next.startIndex).toBe(101);
    expect(next.endIndex).toBe(110);
    expect(next.availableStartIndex).toBe(91);
    expect(next.availableEndIndex).toBe(110);
    expect(next.viewportStartIndex).toBe(106);
    expect(next.viewportEndIndex).toBe(110);
    expect(String.fromCodePoint(next.lines[0][0].char)).toBe('b');
    expect(String.fromCodePoint(next.lines[next.lines.length - 1][0].char)).toBe('j');
  });
});
