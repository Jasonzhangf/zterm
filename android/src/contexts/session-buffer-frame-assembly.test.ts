import { describe, expect, it } from 'vitest';
import type { TerminalBufferPayload } from '../lib/types';
import {
  TERMINAL_BUFFER_SYNC_FRAME_MAX_AGE_MS,
  TERMINAL_BUFFER_SYNC_FRAME_MAX_CHUNKS,
  TERMINAL_BUFFER_SYNC_FRAME_MAX_RETAINED_BYTES,
  TERMINAL_BUFFER_SYNC_FRAME_MAX_SPAN_LINES,
} from '@zterm/shared/types';
import {
  assembleBufferSyncFrameChunk as assembleBufferSyncFrameChunkAt,
  BUFFER_FRAME_REPAIR_LEDGER_MAX_REVISIONS,
  hasBufferFrameRepairDispatch,
  recordBufferFrameRepairDispatch,
  type BufferFrameAssemblyState,
} from './session-buffer-frame-assembly';

function assembleBufferSyncFrameChunk(
  current: BufferFrameAssemblyState | null,
  payload: TerminalBufferPayload,
  receivedAt = 1000,
) {
  return assembleBufferSyncFrameChunkAt(current, payload, receivedAt);
}

function row(index: number, text: string) {
  return {
    index,
    cells: Array.from(text).map((char) => ({
      char: char.codePointAt(0) || 32,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    })),
  };
}

function chunk(options: {
  revision?: number;
  generatedAt?: number;
  frameStartIndex?: number;
  frameEndIndex?: number;
  frameChunkIndex: number;
  frameChunkCount?: number;
  startIndex: number;
  endIndex: number;
  prefix?: string;
}): TerminalBufferPayload {
  const revision = options.revision ?? 11;
  const frameStartIndex = options.frameStartIndex ?? 100;
  const frameEndIndex = options.frameEndIndex ?? 104;
  return {
    revision,
    startIndex: options.startIndex,
    endIndex: options.endIndex,
    frameStartIndex,
    frameEndIndex,
    frameChunkIndex: options.frameChunkIndex,
    frameChunkCount: options.frameChunkCount ?? 2,
    generatedAt: options.generatedAt ?? 1234,
    availableStartIndex: frameStartIndex,
    availableEndIndex: frameEndIndex,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    cursor: null,
    lines: Array.from({ length: options.endIndex - options.startIndex }, (_, offset) => {
      const index = options.startIndex + offset;
      return row(index, `${options.prefix ?? 'new'}-${index}`);
    }),
  };
}

describe('session buffer frame assembly', () => {
  it('assembles out-of-order chunks into one continuous payload', () => {
    const second = assembleBufferSyncFrameChunk(null, chunk({
      frameChunkIndex: 1,
      startIndex: 102,
      endIndex: 104,
    }));
    expect(second.kind).toBe('pending');

    const first = assembleBufferSyncFrameChunk(
      second.state as BufferFrameAssemblyState,
      chunk({ frameChunkIndex: 0, startIndex: 100, endIndex: 102 }),
    );
    expect(first.kind).toBe('complete');
    if (first.kind !== 'complete') {
      throw new Error(`expected complete, got ${first.kind}`);
    }
    expect(first.payload.startIndex).toBe(100);
    expect(first.payload.endIndex).toBe(104);
    expect(first.payload.lines.map((line) => ('index' in line ? line.index : line.i))).toEqual([100, 101, 102, 103]);
    expect(first.payload.frameChunkCount).toBe(1);
  });

  it('rejects an internal row hole before it enters pending truth', () => {
    const invalid = chunk({ frameChunkIndex: 0, startIndex: 100, endIndex: 102 });
    invalid.lines = [row(100, 'new-100')];
    expect(assembleBufferSyncFrameChunk(null, invalid)).toEqual({
      kind: 'rejected',
      error: 'invalid-chunk-lines',
      state: null,
      repairRange: { startIndex: 100, endIndex: 104 },
      repairRevision: 11,
    });
  });

  it('rejects conflicting duplicate chunks and discards the corrupted pending frame', () => {
    const first = assembleBufferSyncFrameChunk(null, chunk({
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }));
    expect(first.kind).toBe('pending');
    const duplicate = assembleBufferSyncFrameChunk(
      first.state as BufferFrameAssemblyState,
      chunk({ frameChunkIndex: 0, startIndex: 100, endIndex: 102, prefix: 'conflict' }),
    );
    expect(duplicate).toEqual({
      kind: 'rejected',
      error: 'conflicting-duplicate-chunk',
      state: null,
      repairRange: { startIndex: 100, endIndex: 104 },
      repairRevision: 11,
    });
  });

  it('rejects same-revision frame interleave instead of mixing identities', () => {
    const first = assembleBufferSyncFrameChunk(null, chunk({
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }));
    expect(first.kind).toBe('pending');
    const interleaved = assembleBufferSyncFrameChunk(
      first.state as BufferFrameAssemblyState,
      chunk({
        generatedAt: 5678,
        frameChunkIndex: 1,
        startIndex: 102,
        endIndex: 104,
      }),
    );
    expect(interleaved.kind).toBe('rejected');
    if (interleaved.kind !== 'rejected') {
      throw new Error(`expected rejected, got ${interleaved.kind}`);
    }
    expect(interleaved.error).toBe('interleaved-same-revision-frame');
    expect(interleaved.state).toBeNull();
    expect(interleaved.repairRange).toEqual({ startIndex: 100, endIndex: 104 });
    expect(interleaved.repairRevision).toBe(11);
  });

  it('repairs the original pending range when a same-revision frame with another window interleaves', () => {
    const first = assembleBufferSyncFrameChunk(null, chunk({
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }));
    expect(first.kind).toBe('pending');

    const interleaved = assembleBufferSyncFrameChunk(
      first.state as BufferFrameAssemblyState,
      chunk({
        generatedAt: 5678,
        frameStartIndex: 200,
        frameEndIndex: 204,
        frameChunkIndex: 0,
        startIndex: 200,
        endIndex: 202,
      }),
    );

    expect(interleaved).toMatchObject({
      kind: 'rejected',
      error: 'interleaved-same-revision-frame',
      state: null,
      repairRange: { startIndex: 100, endIndex: 104 },
      repairRevision: 11,
    });
  });

  it('repairs the retained frame when an interleaved identity has non-dense lines', () => {
    const first = assembleBufferSyncFrameChunk(null, chunk({
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }));
    expect(first.kind).toBe('pending');
    if (first.kind !== 'pending') {
      throw new Error(`expected pending, got ${first.kind}`);
    }

    const invalidInterleave = chunk({
      generatedAt: 5678,
      frameStartIndex: 200,
      frameEndIndex: 204,
      frameChunkIndex: 0,
      startIndex: 200,
      endIndex: 202,
    });
    invalidInterleave.lines = [row(200, 'invalid-200')];

    expect(assembleBufferSyncFrameChunk(first.state, invalidInterleave)).toEqual({
      kind: 'rejected',
      error: 'interleaved-same-revision-frame',
      state: null,
      repairRange: { startIndex: 100, endIndex: 104 },
      repairRevision: 11,
    });
  });

  it('repairs the retained frame before rejecting an oversized same-revision interleave', () => {
    const first = assembleBufferSyncFrameChunk(null, chunk({
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }));
    expect(first.kind).toBe('pending');
    if (first.kind !== 'pending') {
      throw new Error(`expected pending, got ${first.kind}`);
    }

    const oversizedInterleave = chunk({
      frameStartIndex: 0,
      frameEndIndex: TERMINAL_BUFFER_SYNC_FRAME_MAX_SPAN_LINES + 1,
      frameChunkIndex: 0,
      startIndex: 0,
      endIndex: 1,
    });

    expect(assembleBufferSyncFrameChunk(first.state, oversizedInterleave)).toEqual({
      kind: 'rejected',
      error: 'interleaved-same-revision-frame',
      state: null,
      repairRange: { startIndex: 100, endIndex: 104 },
      repairRevision: 11,
    });
  });

  it('rejects an unchunked same-revision payload while a frame is incomplete', () => {
    const first = assembleBufferSyncFrameChunk(null, chunk({
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }));
    expect(first.kind).toBe('pending');
    const unchunked = chunk({
      frameChunkIndex: 0,
      frameChunkCount: 1,
      startIndex: 100,
      endIndex: 104,
    });
    unchunked.frameStartIndex = 100;
    unchunked.frameEndIndex = 104;
    unchunked.lines = [
      row(100, 'other-100'),
      row(101, 'other-101'),
      row(102, 'other-102'),
      row(103, 'other-103'),
    ];

    expect(assembleBufferSyncFrameChunk(first.state as BufferFrameAssemblyState, unchunked)).toEqual({
      kind: 'rejected',
      error: 'interleaved-same-revision-frame',
      state: null,
      repairRange: { startIndex: 100, endIndex: 104 },
      repairRevision: 11,
    });
  });

  it('rejects explicit malformed chunk counts instead of treating them as legacy payloads', () => {
    const malformed = chunk({
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    });
    malformed.frameChunkCount = 0;

    expect(assembleBufferSyncFrameChunk(null, malformed)).toEqual({
      kind: 'rejected',
      error: 'invalid-frame-metadata',
      state: null,
      repairRange: { startIndex: 100, endIndex: 104 },
      repairRevision: 11,
    });
  });

  it('uses the retained frame revision and clears pending truth when malformed metadata has no valid revision', () => {
    const first = assembleBufferSyncFrameChunk(null, chunk({
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }));
    expect(first.kind).toBe('pending');
    if (first.kind !== 'pending') {
      throw new Error(`expected pending, got ${first.kind}`);
    }

    const malformed = chunk({ frameChunkIndex: 1, startIndex: 102, endIndex: 104 });
    malformed.revision = Number.NaN;
    malformed.frameChunkCount = 0;

    expect(assembleBufferSyncFrameChunk(first.state, malformed)).toMatchObject({
      kind: 'rejected',
      error: 'invalid-frame-metadata',
      state: null,
      repairRange: { startIndex: 100, endIndex: 104 },
      repairRevision: 11,
    });
  });

  it('clears pending truth and repairs the retained range when malformed metadata advertises another range', () => {
    const first = assembleBufferSyncFrameChunk(null, chunk({
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }));
    expect(first.kind).toBe('pending');
    if (first.kind !== 'pending') {
      throw new Error(`expected pending, got ${first.kind}`);
    }

    const malformed = chunk({
      frameStartIndex: 900,
      frameEndIndex: 904,
      frameChunkIndex: 0,
      startIndex: 900,
      endIndex: 902,
    });
    malformed.frameChunkCount = 0;

    expect(assembleBufferSyncFrameChunk(first.state, malformed)).toMatchObject({
      kind: 'rejected',
      error: 'interleaved-same-revision-frame',
      state: null,
      repairRange: { startIndex: 100, endIndex: 104 },
      repairRevision: 11,
    });
  });

  it('lets a higher revision replace an incomplete frame and rejects a late older chunk', () => {
    const older = assembleBufferSyncFrameChunk(null, chunk({
      revision: 11,
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }));
    expect(older.kind).toBe('pending');
    const newer = assembleBufferSyncFrameChunk(
      older.state as BufferFrameAssemblyState,
      chunk({
        revision: 12,
        generatedAt: 2000,
        frameChunkIndex: 0,
        startIndex: 100,
        endIndex: 102,
      }),
    );
    expect(newer.kind).toBe('pending');
    if (newer.kind !== 'pending') {
      throw new Error(`expected pending, got ${newer.kind}`);
    }
    expect(newer.supersededFrameKey).toBe((older.state as BufferFrameAssemblyState).frameKey);

    const lateOlder = assembleBufferSyncFrameChunk(newer.state, chunk({
      revision: 11,
      frameChunkIndex: 1,
      startIndex: 102,
      endIndex: 104,
    }));
    expect(lateOlder.kind).toBe('rejected');
    if (lateOlder.kind !== 'rejected') {
      throw new Error(`expected rejected, got ${lateOlder.kind}`);
    }
    expect(lateOlder.error).toBe('stale-frame');
    expect(lateOlder.state).toBe(newer.state);
    expect(lateOlder.repairRange).toBeNull();
    expect(lateOlder.repairRevision).toBe(11);
  });

  it('rejects a late older unchunked payload without discarding the newer pending frame', () => {
    const newer = assembleBufferSyncFrameChunk(null, chunk({
      revision: 12,
      generatedAt: 2000,
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }));
    expect(newer.kind).toBe('pending');
    if (newer.kind !== 'pending') {
      throw new Error(`expected pending, got ${newer.kind}`);
    }

    const olderUnchunked = chunk({
      revision: 11,
      frameChunkIndex: 0,
      frameChunkCount: 1,
      startIndex: 100,
      endIndex: 104,
    });
    olderUnchunked.frameStartIndex = undefined;
    olderUnchunked.frameEndIndex = undefined;
    olderUnchunked.frameChunkIndex = undefined;
    olderUnchunked.lines = [
      row(100, 'old-100'),
      row(101, 'old-101'),
      row(102, 'old-102'),
      row(103, 'old-103'),
    ];

    expect(assembleBufferSyncFrameChunk(newer.state, olderUnchunked)).toEqual({
      kind: 'rejected',
      error: 'stale-frame',
      state: newer.state,
      repairRange: null,
      repairRevision: 11,
    });
  });

  it('classifies malformed lower-revision metadata as stale without requesting obsolete repair', () => {
    const newer = assembleBufferSyncFrameChunk(null, chunk({
      revision: 12,
      generatedAt: 2000,
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }));
    expect(newer.kind).toBe('pending');
    if (newer.kind !== 'pending') {
      throw new Error(`expected pending, got ${newer.kind}`);
    }

    const malformedOlder = chunk({
      revision: 11,
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    });
    malformedOlder.frameChunkCount = 0;

    expect(assembleBufferSyncFrameChunk(newer.state, malformedOlder)).toEqual({
      kind: 'rejected',
      error: 'stale-frame',
      state: newer.state,
      repairRange: null,
      repairRevision: 11,
    });
  });

  it('rejects frames whose declared span or chunk count exceeds the shared protocol bounds', () => {
    const oversizedSpan = chunk({
      frameStartIndex: 0,
      frameEndIndex: TERMINAL_BUFFER_SYNC_FRAME_MAX_SPAN_LINES + 1,
      frameChunkIndex: 0,
      startIndex: 0,
      endIndex: 1,
    });
    expect(assembleBufferSyncFrameChunk(null, oversizedSpan)).toMatchObject({
      kind: 'rejected',
      error: 'frame-resource-limit-exceeded',
      state: null,
      repairRange: {
        startIndex: 0,
        endIndex: TERMINAL_BUFFER_SYNC_FRAME_MAX_SPAN_LINES + 1,
      },
      repairRevision: 11,
    });

    const excessiveChunks = chunk({
      frameStartIndex: 0,
      frameEndIndex: TERMINAL_BUFFER_SYNC_FRAME_MAX_CHUNKS + 1,
      frameChunkIndex: 0,
      frameChunkCount: TERMINAL_BUFFER_SYNC_FRAME_MAX_CHUNKS + 1,
      startIndex: 0,
      endIndex: 1,
    });
    expect(assembleBufferSyncFrameChunk(null, excessiveChunks)).toMatchObject({
      kind: 'rejected',
      error: 'frame-resource-limit-exceeded',
    });
  });

  it('rejects a frame before retained payload bytes can exceed the shared memory bound', () => {
    const first = assembleBufferSyncFrameChunk(null, chunk({
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }));
    expect(first.kind).toBe('pending');
    if (first.kind !== 'pending') {
      throw new Error(`expected pending, got ${first.kind}`);
    }
    first.state.retainedBytes = TERMINAL_BUFFER_SYNC_FRAME_MAX_RETAINED_BYTES;

    expect(assembleBufferSyncFrameChunk(first.state, chunk({
      frameChunkIndex: 1,
      startIndex: 102,
      endIndex: 104,
    }))).toMatchObject({
      kind: 'rejected',
      error: 'frame-resource-limit-exceeded',
      state: null,
      repairRange: { startIndex: 100, endIndex: 104 },
      repairRevision: 11,
    });
  });

  it('expires an incomplete frame at the shared lifetime bound and requests its exact range', () => {
    const first = assembleBufferSyncFrameChunk(null, chunk({
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }), 1000);
    expect(first.kind).toBe('pending');
    if (first.kind !== 'pending') {
      throw new Error(`expected pending, got ${first.kind}`);
    }

    expect(assembleBufferSyncFrameChunk(first.state, chunk({
      frameChunkIndex: 1,
      startIndex: 102,
      endIndex: 104,
    }), 1000 + TERMINAL_BUFFER_SYNC_FRAME_MAX_AGE_MS + 1)).toEqual({
      kind: 'rejected',
      error: 'frame-assembly-expired',
      state: null,
      repairRange: { startIndex: 100, endIndex: 104 },
      repairRevision: 11,
    });
  });

  it('accepts a newer complete payload instead of expiring obsolete pending truth', () => {
    const first = assembleBufferSyncFrameChunk(null, chunk({
      revision: 11,
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }), 1000);
    expect(first.kind).toBe('pending');
    if (first.kind !== 'pending') {
      throw new Error(`expected pending, got ${first.kind}`);
    }

    const newer = chunk({
      revision: 12,
      generatedAt: 2000,
      frameChunkIndex: 0,
      frameChunkCount: 1,
      startIndex: 100,
      endIndex: 104,
    });
    newer.frameStartIndex = undefined;
    newer.frameEndIndex = undefined;
    newer.frameChunkIndex = undefined;

    expect(assembleBufferSyncFrameChunk(
      first.state,
      newer,
      1000 + TERMINAL_BUFFER_SYNC_FRAME_MAX_AGE_MS + 1,
    )).toEqual({
      kind: 'passthrough',
      payload: newer,
      state: null,
    });
  });

  it('starts a newer chunked frame instead of expiring obsolete pending truth', () => {
    const first = assembleBufferSyncFrameChunk(null, chunk({
      revision: 11,
      frameChunkIndex: 0,
      startIndex: 100,
      endIndex: 102,
    }), 1000);
    expect(first.kind).toBe('pending');
    if (first.kind !== 'pending') {
      throw new Error(`expected pending, got ${first.kind}`);
    }

    const newer = assembleBufferSyncFrameChunk(
      first.state,
      chunk({
        revision: 12,
        generatedAt: 2000,
        frameChunkIndex: 0,
        startIndex: 100,
        endIndex: 102,
      }),
      1000 + TERMINAL_BUFFER_SYNC_FRAME_MAX_AGE_MS + 1,
    );

    expect(newer.kind).toBe('pending');
    if (newer.kind !== 'pending') {
      throw new Error(`expected pending, got ${newer.kind}`);
    }
    expect(newer.state.revision).toBe(12);
    expect(newer.supersededFrameKey).toBe(first.state.frameKey);
  });

  it('retains distinct repair revisions in one bounded per-session ledger', () => {
    const revisions = Array.from(
      { length: BUFFER_FRAME_REPAIR_LEDGER_MAX_REVISIONS + 1 },
      (_, index) => index + 1,
    ).reduce<readonly number[]>(recordBufferFrameRepairDispatch, []);

    expect(revisions).toHaveLength(BUFFER_FRAME_REPAIR_LEDGER_MAX_REVISIONS);
    expect(hasBufferFrameRepairDispatch(revisions, 1)).toBe(false);
    expect(hasBufferFrameRepairDispatch(revisions, 2)).toBe(true);
    expect(hasBufferFrameRepairDispatch(revisions, BUFFER_FRAME_REPAIR_LEDGER_MAX_REVISIONS + 1)).toBe(true);
    expect(recordBufferFrameRepairDispatch(revisions, 2)).toBe(revisions);
  });

  it('rejects invalid revisions before they enter the repair dispatch ledger', () => {
    expect(() => recordBufferFrameRepairDispatch([], 0)).toThrow(
      'buffer frame repair revision must be a positive safe integer',
    );
    expect(() => recordBufferFrameRepairDispatch([], Number.NaN)).toThrow(
      'buffer frame repair revision must be a positive safe integer',
    );
  });
});
