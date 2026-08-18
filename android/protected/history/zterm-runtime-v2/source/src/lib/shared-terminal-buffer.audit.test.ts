import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_CACHE_LINES } from './mobile-config';
import { applyBufferSyncToSessionBuffer, cellsToLine, type TerminalBufferPayload } from '../../../packages/shared/src';

function payload(input: {
  startIndex: number;
  endIndex: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  viewportEndIndex?: number;
  revision: number;
  rows?: number;
  lines: Array<[number, string]>;
}): TerminalBufferPayload {
  return {
    revision: input.revision,
    startIndex: input.startIndex,
    endIndex: input.endIndex,
    availableStartIndex: input.availableStartIndex,
    availableEndIndex: input.availableEndIndex,
    cols: 80,
    rows: input.rows ?? 4,
    cursorKeysApp: false,
    lines: input.lines.map(([index, text]) => ({
      index,
      cells: Array.from(text).map((char) => ({
        char: char.codePointAt(0) || 32,
        fg: 256,
        bg: 256,
        flags: 0,
        width: 1,
      })),
    })),
  };
}

describe('shared terminal-buffer audit', () => {
  it('keeps the local sliding history when a follow payload only carries the tail window diff', () => {
    const current = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 100,
        endIndex: 112,
        availableStartIndex: 100,
        availableEndIndex: 112,
        viewportEndIndex: 112,
        revision: 5,
        lines: Array.from({ length: 12 }, (_, offset) => [100 + offset, `line-${100 + offset}`]),
      }),
      DEFAULT_TERMINAL_CACHE_LINES,
    );

    const next = applyBufferSyncToSessionBuffer(
      current,
      payload({
        startIndex: 109,
        endIndex: 113,
        availableStartIndex: 100,
        availableEndIndex: 113,
        viewportEndIndex: 113,
        revision: 6,
        lines: [[112, 'line-112']],
      }),
      DEFAULT_TERMINAL_CACHE_LINES,
    );

    expect(next.startIndex).toBe(100);
    expect(next.endIndex).toBe(113);
    expect(next.bufferTailEndIndex).toBe(113);
    expect(next.lines.map(cellsToLine).slice(0, 3)).toEqual(['line-100', 'line-101', 'line-102']);
    expect(next.lines.map(cellsToLine).slice(-2)).toEqual(['line-111', 'line-112']);
  });

  it('moves the local cache window upward when reading older history is fetched', () => {
    const current = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 188,
        endIndex: 200,
        availableEndIndex: 200,
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
        availableEndIndex: 200,
        viewportEndIndex: 188,
        rows: 4,
        revision: 3,
        lines: Array.from({ length: 12 }, (_, offset) => [180 + offset, `line-${180 + offset}`]),
      }),
      12,
    );

    expect(next.startIndex).toBe(180);
    expect(next.endIndex).toBe(192);
    expect(next.bufferTailEndIndex).toBe(200);
    expect(next.lines.map(cellsToLine)[0]).toBe('line-180');
    expect(next.lines.map(cellsToLine).slice(-1)[0]).toBe('line-191');
  });
});
