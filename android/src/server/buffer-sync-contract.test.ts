import { describe, expect, it } from 'vitest';
import type { BufferSyncRequestPayload, TerminalCell } from '../lib/types';
import {
  buildBufferHeadPayload,
  buildRequestedRangeBufferPayload,
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

function createMirror(lines: string[], overrides?: Partial<BufferSyncMirrorSnapshot>): BufferSyncMirrorSnapshot {
  return {
    revision: 7,
    bufferStartIndex: 100,
    bufferLines: lines.map((line) => row(line)),
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
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
});
