import { describe, expect, it } from 'vitest';
import type { TerminalBufferPayload } from '../../connection/types';
import {
  assembleBufferSyncFrameChunk,
  hasBufferFrameRepairDispatch,
  recordBufferFrameRepairDispatch,
} from './session-buffer-frame-assembly';

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
  frameChunkIndex: number;
  startIndex: number;
  endIndex: number;
  prefix?: string;
}): TerminalBufferPayload {
  return {
    revision: options.revision ?? 11,
    startIndex: options.startIndex,
    endIndex: options.endIndex,
    frameStartIndex: 100,
    frameEndIndex: 104,
    frameChunkIndex: options.frameChunkIndex,
    frameChunkCount: 2,
    generatedAt: 1234,
    availableStartIndex: 100,
    availableEndIndex: 104,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    cursor: null,
    lines: Array.from(
      { length: options.endIndex - options.startIndex },
      (_, offset) => {
        const index = options.startIndex + offset;
        return row(index, `${options.prefix ?? 'new'}-${index}`);
      },
    ),
  };
}

describe('shared buffer frame assembly public contract', () => {
  it('keeps an incomplete frame pending and resolves one commit exactly once', () => {
    let commits = 0;
    const first = assembleBufferSyncFrameChunk(
      null,
      chunk({ frameChunkIndex: 0, startIndex: 100, endIndex: 102 }),
      1000,
    );
    expect(first.kind).toBe('pending');
    expect(commits).toBe(0);
    if (first.kind !== 'pending') {
      throw new Error(`expected pending, got ${first.kind}`);
    }

    const second = assembleBufferSyncFrameChunk(
      first.state,
      chunk({ frameChunkIndex: 1, startIndex: 102, endIndex: 104 }),
      1001,
    );
    expect(second.kind).toBe('complete');
    if (second.kind === 'complete') {
      commits += 1;
    }
    expect(commits).toBe(1);
    expect(second.kind === 'complete' ? second.payload.frameChunkCount : null).toBe(1);
  });

  it('does not let stale or conflicting frames replace published truth', () => {
    const pending = assembleBufferSyncFrameChunk(
      null,
      chunk({ revision: 12, frameChunkIndex: 0, startIndex: 100, endIndex: 102 }),
      1000,
    );
    expect(pending.kind).toBe('pending');
    if (pending.kind !== 'pending') {
      throw new Error(`expected pending, got ${pending.kind}`);
    }

    const stale = assembleBufferSyncFrameChunk(
      pending.state,
      chunk({ revision: 11, frameChunkIndex: 1, startIndex: 102, endIndex: 104 }),
      1001,
    );
    expect(stale).toMatchObject({
      kind: 'rejected',
      error: 'stale-frame',
      state: pending.state,
      repairRange: null,
    });

    const conflict = assembleBufferSyncFrameChunk(
      pending.state,
      chunk({
        revision: 12,
        frameChunkIndex: 0,
        startIndex: 100,
        endIndex: 102,
        prefix: 'conflict',
      }),
      1001,
    );
    expect(conflict).toMatchObject({
      kind: 'rejected',
      error: 'conflicting-duplicate-chunk',
      state: null,
      repairRange: { startIndex: 100, endIndex: 104 },
      repairRevision: 12,
    });
  });

  it('preserves the exact repair range and records dispatch only after dispatch', () => {
    const pending = assembleBufferSyncFrameChunk(
      null,
      chunk({ frameChunkIndex: 0, startIndex: 100, endIndex: 102 }),
      1000,
    );
    if (pending.kind !== 'pending') {
      throw new Error(`expected pending, got ${pending.kind}`);
    }

    const rejected = assembleBufferSyncFrameChunk(
      pending.state,
      chunk({
        frameChunkIndex: 1,
        startIndex: 103,
        endIndex: 104,
      }),
      1001,
    );
    expect(rejected).toMatchObject({
      kind: 'rejected',
      error: 'non-contiguous-frame',
      repairRange: { startIndex: 100, endIndex: 104 },
      repairRevision: 11,
    });
    const ledgerBeforeDispatch: readonly number[] = [];
    expect(hasBufferFrameRepairDispatch(ledgerBeforeDispatch, 11)).toBe(false);

    const ledgerAfterDispatch = recordBufferFrameRepairDispatch(ledgerBeforeDispatch, 11);
    expect(hasBufferFrameRepairDispatch(ledgerAfterDispatch, 11)).toBe(true);
    expect(recordBufferFrameRepairDispatch(ledgerAfterDispatch, 11)).toBe(ledgerAfterDispatch);
  });
});
