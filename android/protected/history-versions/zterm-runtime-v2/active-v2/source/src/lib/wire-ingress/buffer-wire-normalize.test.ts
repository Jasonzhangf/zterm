import { describe, expect, it } from 'vitest';
import type { TerminalBufferPayload } from '../types';
import {
  normalizeIncomingBufferPayload,
  normalizeTerminalCursorState,
} from './buffer-wire-normalize';

describe('client wire ingress buffer normalization', () => {
  it('normalizes terminal cursor state without changing valid cursor values', () => {
    expect(normalizeTerminalCursorState(null)).toBeNull();
    expect(
      normalizeTerminalCursorState({
        rowIndex: -2,
        col: 7.9,
        visible: false,
      }),
    ).toEqual({
      rowIndex: 0,
      col: 7,
      visible: false,
    });
    expect(
      normalizeTerminalCursorState({
        rowIndex: 3,
        col: 4,
        visible: true,
      }),
    ).toEqual({
      rowIndex: 3,
      col: 4,
      visible: true,
    });
  });

  it('preserves valid frame identity and normalizes payload rows', () => {
    const normalized = normalizeIncomingBufferPayload({
      revision: 7,
      startIndex: 2,
      endIndex: 4,
      rows: 24,
      cols: 80,
      frameStartIndex: 2,
      frameEndIndex: 4,
      frameChunkIndex: 0,
      frameChunkCount: 1,
      generatedAt: 1000,
      requestSentAt: 999,
      availableStartIndex: 0,
      availableEndIndex: 10,
      cursor: {
        rowIndex: 3,
        col: 4,
        visible: true,
      },
      lines: [
        {
          index: 2,
          cells: [
            {
              char: 65,
              fg: 7,
              bg: 0,
              flags: 0,
              width: 1,
            },
          ],
        },
      ],
    } as TerminalBufferPayload);

    expect(normalized.revision).toBe(7);
    expect(normalized.startIndex).toBe(2);
    expect(normalized.endIndex).toBe(4);
    expect(normalized.rows).toBe(24);
    expect(normalized.cols).toBe(80);
    expect(normalized.frameStartIndex).toBe(2);
    expect(normalized.frameEndIndex).toBe(4);
    expect(normalized.frameChunkIndex).toBe(0);
    expect(normalized.frameChunkCount).toBe(1);
    expect(normalized.availableEndIndex).toBe(10);
    expect(normalized.cursor).toEqual({
      rowIndex: 3,
      col: 4,
      visible: true,
    });
    expect(normalized.lines).toEqual([
      {
        index: 2,
        cells: [
          {
            char: 65,
            fg: 7,
            bg: 0,
            flags: 0,
            width: 1,
          },
        ],
      },
    ]);
  });

  it('bounds invalid range fields and leaves malformed optional frame identity as NaN', () => {
    const normalized = normalizeIncomingBufferPayload({
      revision: 0,
      startIndex: -3,
      endIndex: 2.9,
      rows: 0,
      cols: 0,
      frameStartIndex: 'bad',
      lines: [],
      cursor: null,
    } as unknown as TerminalBufferPayload);

    expect(normalized.startIndex).toBe(0);
    expect(normalized.endIndex).toBe(2);
    expect(normalized.rows).toBe(1);
    expect(normalized.cols).toBe(1);
    expect(Number.isNaN(normalized.frameStartIndex)).toBe(true);
    expect(normalized.lines).toEqual([]);
  });
});
