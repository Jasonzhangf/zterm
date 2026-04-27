import { describe, expect, it } from 'vitest';
import type { BufferSyncRequestPayload, TerminalCell } from '../lib/types';
import {
  buildBufferHeadPayload,
  buildRequestedRangeBufferPayload,
  expandCompactLine,
  type BufferSyncMirrorSnapshot,
} from './buffer-sync-contract';

function row(text: string): TerminalCell[] {
  return Array.from(text).map((char) => ({
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  }));
}

function mixedBodyRow(): TerminalCell[] {
  return [
    { char: 'A'.codePointAt(0)!, fg: 256, bg: 256, flags: 0, width: 1 },
    { char: 32, fg: 256, bg: 8, flags: 0, width: 1 },
    { char: '你'.codePointAt(0)!, fg: 6, bg: 256, flags: 0, width: 2 },
    { char: 32, fg: 6, bg: 256, flags: 0, width: 0 },
    { char: '好'.codePointAt(0)!, fg: 6, bg: 256, flags: 0, width: 2 },
    { char: 32, fg: 6, bg: 256, flags: 0, width: 0 },
    { char: 'B'.codePointAt(0)!, fg: 256, bg: 256, flags: 0, width: 1 },
    { char: ' '.codePointAt(0)!, fg: 256, bg: 256, flags: 0, width: 1 },
    { char: 'C'.codePointAt(0)!, fg: 256, bg: 256, flags: 0, width: 1 },
  ];
}

function createMirror(lines: string[], overrides?: Partial<BufferSyncMirrorSnapshot>): BufferSyncMirrorSnapshot {
  return {
    revision: 7,
    bufferStartIndex: 100,
    bufferLines: lines.map((line) => row(line)),
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    cursor: null,
    ...overrides,
  };
}

function createRequest(overrides?: Partial<BufferSyncRequestPayload>): BufferSyncRequestPayload {
  return {
    knownRevision: 0,
    localStartIndex: 0,
    localEndIndex: 0,
    requestStartIndex: 100,
    requestEndIndex: 103,
    ...overrides,
  };
}

describe('buildRequestedRangeBufferPayload', () => {
  it('returns current head directly from mirror store without requiring any client planner state', () => {
    const payload = buildBufferHeadPayload('session-1', createMirror(['row-100', 'row-101', 'row-102']));

    expect(payload).toEqual({
      sessionId: 'session-1',
      revision: 7,
      latestEndIndex: 103,
      availableStartIndex: 100,
      availableEndIndex: 103,
      cursor: null,
    });
  });

  it('returns the requested range as buffer-sync payload', () => {
    const payload = buildRequestedRangeBufferPayload(
      createMirror(['row-100', 'row-101', 'row-102']),
      createRequest(),
    );

    expect(payload).toMatchObject({
      revision: 7,
      startIndex: 100,
      endIndex: 103,
      availableStartIndex: 100,
      availableEndIndex: 103,
    });
    expect(payload.lines.map((line) => ('i' in line ? line.i : line.index))).toEqual([100, 101, 102]);
  });

  it('keeps buffer lines raw and sends cursor separately as metadata', () => {
    const payload = buildRequestedRangeBufferPayload(
      createMirror(['prompt-$ '], {
        cursor: {
          rowIndex: 100,
          col: 8,
          visible: true,
        },
      }),
      createRequest({
        requestStartIndex: 100,
        requestEndIndex: 101,
      }),
    );

    expect(payload.cursor).toEqual({
      rowIndex: 100,
      col: 8,
      visible: true,
    });
    const compact = payload.lines[0] as { i: number; t: string; s?: [number, number, number, number, number][] };
    expect(compact.t).toBe('prompt-$ ');
    expect(compact.s).toBeUndefined();
    const expanded = expandCompactLine(compact, 80);
    expect(expanded[8]).toMatchObject({
      char: 32,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    });
  });

  it('still returns buffer-sync semantics for zero-width requests instead of forcing head-only semantics', () => {
    const payload = buildRequestedRangeBufferPayload(
      createMirror(['row-100', 'row-101', 'row-102']),
      createRequest({
        requestStartIndex: 103,
        requestEndIndex: 103,
      }),
    );

    expect(payload).toMatchObject({
      revision: 7,
      startIndex: 103,
      endIndex: 103,
      availableStartIndex: 100,
      availableEndIndex: 103,
    });
    expect(payload.lines).toEqual([]);
  });

  it('still returns buffer-sync semantics when the authoritative mirror is empty', () => {
    const payload = buildRequestedRangeBufferPayload(
      createMirror([], {
        bufferStartIndex: 0,
      }),
      createRequest({
        requestStartIndex: 0,
        requestEndIndex: 24,
      }),
    );

    expect(payload).toMatchObject({
      revision: 7,
      startIndex: 0,
      endIndex: 0,
      availableStartIndex: 0,
      availableEndIndex: 0,
    });
    expect(payload.lines).toEqual([]);
  });

  it('does not emit non-default style spans for rows that only use the terminal default 256/256 colors', () => {
    const payload = buildRequestedRangeBufferPayload(
      createMirror(['plain-default-row']),
      createRequest({
        requestStartIndex: 100,
        requestEndIndex: 101,
      }),
    );

    expect(payload.lines).toHaveLength(1);
    const compactLine = payload.lines[0] as { i: number; t: string; s?: unknown };
    expect(compactLine.i).toBe(100);
    expect(compactLine.t).toBe('plain-default-row');
    expect(compactLine.s).toBeUndefined();
  });

  it('roundtrips compact rows without corrupting trailing blank cells away from the default 256/256 sentinel', () => {
    const payload = buildRequestedRangeBufferPayload(
      createMirror(['A']),
      createRequest({
        requestStartIndex: 100,
        requestEndIndex: 101,
      }),
    );

    const compactLine = payload.lines[0] as { i: number; t: string; w?: number[]; s?: [number, number, number, number, number][] };
    const expanded = expandCompactLine(compactLine, 80);

    expect(expanded[0]).toMatchObject({
      char: 'A'.codePointAt(0),
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    });
    expect(expanded[1]).toMatchObject({
      char: 32,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    });
    expect(expanded[20]).toMatchObject({
      char: 32,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    });
  });

  it('keeps visible body-row semantics for ANSI/CJK mixed rows after compact roundtrip', () => {
    const payload = buildRequestedRangeBufferPayload(
      createMirror([], {
        bufferStartIndex: 100,
        bufferLines: [mixedBodyRow()],
      }),
      createRequest({
        requestStartIndex: 100,
        requestEndIndex: 101,
      }),
    );

    const compact = payload.lines[0] as { i: number; t: string; w?: number[]; s?: [number, number, number, number, number][] };
    expect(compact.t).toBe('A 你好B C');
    expect(compact.w).toEqual([1, 1, 2, 2, 1, 1, 1]);
    expect(compact.s).toEqual([
      [1, 2, 256, 8, 0],
      [2, 6, 6, 256, 0],
    ]);

    const expanded = expandCompactLine(compact, 9);
    expect(expanded.slice(0, 9).map((cell) => ({
      char: cell.char,
      fg: cell.fg,
      bg: cell.bg,
      flags: cell.flags,
      width: cell.width,
    }))).toEqual([
      { char: 'A'.codePointAt(0), fg: 256, bg: 256, flags: 0, width: 1 },
      { char: 32, fg: 256, bg: 8, flags: 0, width: 1 },
      { char: '你'.codePointAt(0), fg: 6, bg: 256, flags: 0, width: 2 },
      { char: 32, fg: 6, bg: 256, flags: 0, width: 0 },
      { char: '好'.codePointAt(0), fg: 6, bg: 256, flags: 0, width: 2 },
      { char: 32, fg: 6, bg: 256, flags: 0, width: 0 },
      { char: 'B'.codePointAt(0), fg: 256, bg: 256, flags: 0, width: 1 },
      { char: ' '.codePointAt(0), fg: 256, bg: 256, flags: 0, width: 1 },
      { char: 'C'.codePointAt(0), fg: 256, bg: 256, flags: 0, width: 1 },
    ]);
  });

  it('restores double-width continuation cells with the same buffer truth as daemon rows', () => {
    const compact = {
      i: 100,
      t: '你A',
      w: [2, 1],
      s: [[0, 2, 6, 256, 0]] as [number, number, number, number, number][],
    };

    const expanded = expandCompactLine(compact, 4);

    expect(expanded.slice(0, 4).map((cell) => ({
      char: cell.char,
      fg: cell.fg,
      bg: cell.bg,
      flags: cell.flags,
      width: cell.width,
    }))).toEqual([
      { char: '你'.codePointAt(0), fg: 6, bg: 256, flags: 0, width: 2 },
      { char: 32, fg: 6, bg: 256, flags: 0, width: 0 },
      { char: 'A'.codePointAt(0), fg: 256, bg: 256, flags: 0, width: 1 },
      { char: 32, fg: 256, bg: 256, flags: 0, width: 1 },
    ]);
  });
});
