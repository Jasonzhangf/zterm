import { describe, expect, it } from 'vitest';

import {
  applyBufferSyncToSessionBuffer,
  cellsToLine,
  createSessionBufferState,
} from './terminal-buffer';
import type { TerminalBufferPayload } from './types';

function lines(startIndex: number, count: number, prefix: string) {
  return Array.from({ length: count }, (_, offset) => ({
    index: startIndex + offset,
    cells: [{
      char: `${prefix}-${startIndex + offset}`.codePointAt(0) || 32,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    }],
  }));
}

function textLines(startIndex: number, count: number, prefix: string) {
  return Array.from({ length: count }, (_, offset) => `${prefix}-${startIndex + offset}`);
}

describe('terminal buffer merge', () => {
  it('keeps a current tail window anchored when a newer near-tail payload does not reach the authoritative tail', () => {
    const current = createSessionBufferState({
      lines: textLines(10606, 1000, 'current'),
      startIndex: 10606,
      endIndex: 11606,
      bufferHeadStartIndex: 10592,
      bufferTailEndIndex: 11606,
      cols: 115,
      rows: 24,
      revision: 3220,
      cacheLines: 1000,
    });
    const payload: TerminalBufferPayload = {
      startIndex: 10592,
      endIndex: 11601,
      availableStartIndex: 10592,
      availableEndIndex: 11606,
      revision: 3221,
      cols: 115,
      rows: 24,
      cursorKeysApp: false,
      lines: lines(10592, 1009, 'next'),
    };

    const next = applyBufferSyncToSessionBuffer(current, payload, 1000);

    expect(next.startIndex).toBe(10606);
    expect(next.endIndex).toBe(11606);
    expect(next.bufferHeadStartIndex).toBe(10592);
    expect(next.bufferTailEndIndex).toBe(11606);
    expect(next.revision).toBe(3221);
    expect(next.lines).toHaveLength(1000);
    expect(cellsToLine(next.lines[0]!)).toBe('n');
    expect(cellsToLine(next.lines[994]!)).toBe('n');
    expect(cellsToLine(next.lines[995]!)).toBe('current-11601');
    expect(cellsToLine(next.lines[999]!)).toBe('current-11605');
    expect(next.gapRanges).toEqual([]);
  });

  it('still allows an older reading window to move the local cache when the current window is not anchored at tail', () => {
    const current = createSessionBufferState({
      lines: textLines(5000, 1000, 'current'),
      startIndex: 5000,
      endIndex: 6000,
      bufferHeadStartIndex: 4000,
      bufferTailEndIndex: 7000,
      cols: 115,
      rows: 24,
      revision: 90,
      cacheLines: 1000,
    });
    const payload: TerminalBufferPayload = {
      startIndex: 4500,
      endIndex: 5500,
      availableStartIndex: 4000,
      availableEndIndex: 7000,
      revision: 91,
      cols: 115,
      rows: 24,
      cursorKeysApp: false,
      lines: lines(4500, 1000, 'older'),
    };

    const next = applyBufferSyncToSessionBuffer(current, payload, 1000);

    expect(next.startIndex).toBe(4500);
    expect(next.endIndex).toBe(5500);
    expect(cellsToLine(next.lines[0]!)).toBe('o');
    expect(cellsToLine(next.lines[999]!)).toBe('o');
  });

  it('keeps the authoritative tail when an oversized payload covers the current tail', () => {
    const current = createSessionBufferState({
      lines: textLines(16463, 1000, 'current'),
      startIndex: 16463,
      endIndex: 17463,
      bufferHeadStartIndex: 16463,
      bufferTailEndIndex: 17463,
      cols: 115,
      rows: 24,
      revision: 7439,
      cacheLines: 1000,
    });
    const payload: TerminalBufferPayload = {
      startIndex: 14763,
      endIndex: 17463,
      availableStartIndex: 14763,
      availableEndIndex: 17463,
      revision: 7440,
      cols: 115,
      rows: 24,
      cursorKeysApp: false,
      lines: lines(14763, 2700, 'next'),
    };

    const next = applyBufferSyncToSessionBuffer(current, payload, 1000);

    expect(next.startIndex).toBe(16463);
    expect(next.endIndex).toBe(17463);
    expect(next.bufferHeadStartIndex).toBe(14763);
    expect(next.bufferTailEndIndex).toBe(17463);
    expect(next.lines).toHaveLength(1000);
    expect(cellsToLine(next.lines[0]!)).toBe('n');
    expect(next.gapRanges).toEqual([]);
  });
});
