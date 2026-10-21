import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRendererWindow } from './renderer-window.js';
import type {
  BufferHeadPayload,
  CompactIndexedLine,
  TerminalBufferPayload,
  TerminalCell,
} from '../../shared/src/connection/types.js';
import {
  TERMINAL_BUFFER_SYNC_FRAME_MAX_AGE_MS,
} from '../../shared/src/connection/types.js';
import {
  createMirrorConsumer,
  type MirrorBodySnapshot,
  type MirrorCommitEvent,
  type MirrorMetadataEvent,
  type MirrorRequestMessage,
} from './mirror-consumer.js';

function line(index: number, text: string): CompactIndexedLine {
  return { i: index, t: text };
}

function payload(options: {
  revision: number;
  startIndex: number;
  endIndex: number;
  lines: CompactIndexedLine[];
  availableStartIndex?: number;
  availableEndIndex?: number;
  frame?: {
    startIndex: number;
    endIndex: number;
    chunkIndex: number;
    chunkCount: number;
    generatedAt: number;
  };
}): TerminalBufferPayload {
  return {
    revision: options.revision,
    startIndex: options.startIndex,
    endIndex: options.endIndex,
    ...(options.frame
      ? {
          frameStartIndex: options.frame.startIndex,
          frameEndIndex: options.frame.endIndex,
          frameChunkIndex: options.frame.chunkIndex,
          frameChunkCount: options.frame.chunkCount,
          generatedAt: options.frame.generatedAt,
        }
      : {}),
    availableStartIndex: options.availableStartIndex ?? 0,
    availableEndIndex: options.availableEndIndex ?? options.endIndex,
    cols: 20,
    rows: 4,
    cursorKeysApp: false,
    cursor: null,
    lines: options.lines,
  };
}

function frameChunk(index: number, text: string) {
  return payload({
    revision: 11,
    startIndex: index === 0 ? 100 : 102,
    endIndex: index === 0 ? 102 : 104,
    availableStartIndex: 100,
    availableEndIndex: 104,
    frame: {
      startIndex: 100,
      endIndex: 104,
      chunkIndex: index,
      chunkCount: 2,
      generatedAt: 1234,
    },
    lines: index === 0
      ? [line(100, `${text}-100`), line(101, `${text}-101`)]
      : [line(102, `${text}-102`), line(103, `${text}-103`)],
  });
}

function head(
  revision: number,
  endIndex: number,
  availableStartIndex = 0,
): BufferHeadPayload {
  return {
    sessionId: 's1',
    revision,
    latestEndIndex: endIndex,
    availableStartIndex,
    availableEndIndex: endIndex,
  };
}

function textOf(cells: readonly TerminalCell[] | undefined) {
  return (cells || [])
    .filter((cell) => cell.width !== 0)
    .map((cell) => String.fromCodePoint(cell.char))
    .join('')
    .trimEnd();
}

function bodyText(snapshot: MirrorBodySnapshot, index: number) {
  return textOf(snapshot.lines.get(index));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('mirror-consumer public contract', () => {
  it('keeps newer head bounds when an older accepted body arrives', () => {
    const renderer = createRendererWindow({ visibleRows: 24 });
    const commits: MirrorCommitEvent[] = [];
    const requests: MirrorRequestMessage[] = [];
    const consumer = createMirrorConsumer({
      sendRequest: (message) => { requests.push(message); return true; },
      onMetadata: (event) => renderer.setHead(event.effectiveBounds),
      onCommit: (event) => { commits.push(event); renderer.commit(event.snapshot); },
    });
    consumer.registerSession('s1');
    consumer.handleMessage('s1', { type: 'buffer-sync', payload: payload({
      revision: 1, startIndex: 100, endIndex: 124, availableStartIndex: 100,
      lines: Array.from({ length: 24 }, (_, index) => line(100 + index, 'old')),
    }) });
    consumer.handleMessage('s1', { type: 'buffer-head', payload: head(3, 148, 100) });
    consumer.handleMessage('s1', { type: 'buffer-sync', payload: payload({
      revision: 2, startIndex: 100, endIndex: 124, availableStartIndex: 100,
      lines: Array.from({ length: 24 }, (_, index) => line(100 + index, 'changed')),
    }) });
    const body = consumer.snapshot('s1')!.body;
    expect(body.revision).toBe(2);
    expect(bodyText(body, 100)).toBe('changed');
    expect(body.endIndex).toBe(124);
    expect(body.lines.has(124)).toBe(false);
    expect(commits.at(-1)!.snapshot.availableEndIndex).toBe(148);
    expect(renderer.snapshot().tailEndIndex).toBe(148);
    expect(renderer.setViewport({}).visibleDemand).toMatchObject({ startIndex: 124, endIndex: 148 });
    expect(requests.filter((request) => request.type === 'buffer-sync-request')
      .every((request) => request.type !== 'buffer-sync-request'
        || (request.payload.requestEndIndex === 148 && request.payload.targetHeadRevision === 3))).toBe(true);
    consumer.dispose();
  });

  it('does not promote retained pre-reset rows when a new partial body exceeds the old revision ceiling', () => {
    const consumer = createMirrorConsumer({ sendRequest: () => true });
    consumer.registerSession('s1');
    consumer.handleMessage('s1', { type: 'buffer-sync', payload: payload({
      revision: 10, startIndex: 0, endIndex: 24,
      lines: Array.from({ length: 24 }, (_, index) => line(index, 'old')),
    }) });
    consumer.handleMessage('s1', { type: 'buffer-head', payload: head(1, 24) });
    consumer.handleMessage('s1', { type: 'buffer-sync', payload: payload({
      revision: 11, startIndex: 12, endIndex: 24, availableEndIndex: 24,
      lines: Array.from({ length: 12 }, (_, index) => line(12 + index, 'new')),
    }) });
    const body = consumer.snapshot('s1')!.body;
    expect(body.revision).toBe(11);
    expect(body.lines.has(0)).toBe(false);
    expect(bodyText(body, 12)).toBe('new');
    consumer.dispose();
  });

  it('assembles out-of-order chunks and applies one complete frame once', () => {
    const commits: MirrorCommitEvent[] = [];
    const consumer = createMirrorConsumer({
      sendRequest: () => false,
      onCommit: (event) => commits.push(event),
    });
    consumer.registerSession('s1', { cacheLines: 1000, cols: 20, rows: 4 });

    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: frameChunk(1, 'second'),
    });
    expect(consumer.snapshot('s1')?.frameAssembly.pending).toMatchObject({
      revision: 11,
      receivedChunkCount: 1,
      chunkCount: 2,
    });
    expect(consumer.snapshot('s1')?.body.revision).toBe(0);
    expect(commits).toHaveLength(0);

    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: frameChunk(0, 'first'),
    });
    expect(commits).toHaveLength(1);
    expect(consumer.snapshot('s1')?.frameAssembly.pending).toBeNull();
    expect(consumer.snapshot('s1')?.body.revision).toBe(11);
    expect(bodyText(consumer.snapshot('s1')!.body, 100)).toBe('first-100');
    expect(bodyText(consumer.snapshot('s1')!.body, 103)).toBe('second-103');
    expect(bodyText(commits[0]!.snapshot, 100)).toBe('first-100');
    expect(Object.isFrozen(commits[0]!.snapshot.lines.get(100))).toBe(true);
  });

  it('keeps existing body truth when a head revision starts a new assembly epoch', () => {
    const commits: MirrorCommitEvent[] = [];
    const consumer = createMirrorConsumer({
      sendRequest: () => false,
      onCommit: (event) => commits.push(event),
    });
    consumer.registerSession('s1');

    consumer.handleMessage('s1', {
      type: 'buffer-head',
      payload: head(10, 101, 100),
    });
    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: payload({
        revision: 10,
        startIndex: 100,
        endIndex: 101,
        lines: [line(100, 'old-epoch')],
      }),
    });
    const oldEpoch = consumer.snapshot('s1')!.epoch;
    expect(commits).toHaveLength(1);

    consumer.handleMessage('s1', {
      type: 'buffer-head',
      payload: head(1, 1),
    });
    expect(consumer.snapshot('s1')?.epoch).toBeGreaterThan(oldEpoch);
    expect(consumer.snapshot('s1')?.body.revision).toBe(10);
    expect(bodyText(consumer.snapshot('s1')!.body, 100)).toBe('old-epoch');

    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: payload({
        revision: 10,
        startIndex: 100,
        endIndex: 101,
        lines: [line(100, 'stale-old-epoch')],
      }),
    });
    expect(commits).toHaveLength(1);
    expect(bodyText(consumer.snapshot('s1')!.body, 100)).toBe('old-epoch');

    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: payload({
        revision: 1,
        startIndex: 0,
        endIndex: 1,
        lines: [line(0, 'new-epoch')],
      }),
    });
    expect(commits).toHaveLength(2);
    expect(consumer.snapshot('s1')?.body.revision).toBe(1);
    expect(bodyText(consumer.snapshot('s1')!.body, 0)).toBe('new-epoch');
  });

  it('retains an exact rejection repair and does not mark it dispatched when send is refused', () => {
    const commits: MirrorCommitEvent[] = [];
    const sendRequest = vi.fn((_message: unknown) => false);
    const consumer = createMirrorConsumer({
      sendRequest,
      onCommit: (event) => commits.push(event),
    });
    consumer.registerSession('s1');
    consumer.handleMessage('s1', {
      type: 'buffer-head',
      payload: head(11, 104, 100),
    });

    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: frameChunk(0, 'original'),
    });
    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: frameChunk(0, 'conflict'),
    });

    const snapshot = consumer.snapshot('s1')!;
    expect(commits).toHaveLength(0);
    expect(snapshot.body.revision).toBe(0);
    expect(snapshot.frameAssembly.error).toEqual({
      error: 'conflicting-duplicate-chunk',
      revision: 11,
      repair: {
        status: 'pending',
        range: { startIndex: 100, endIndex: 104 },
      },
    });
    expect(snapshot.frameAssembly.repairDispatchedRevisions).toEqual([]);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest.mock.calls[0]?.[0]).toMatchObject({
      type: 'buffer-sync-request',
      payload: {
        knownRevision: 0,
        requestStartIndex: 100,
        requestEndIndex: 104,
        targetHeadRevision: 11,
      },
    });

    sendRequest.mockReturnValue(true);
    consumer.handleMessage('s1', {
      type: 'buffer-head',
      payload: head(11, 104, 100),
    });
    expect(consumer.snapshot('s1')?.frameAssembly.error?.repair.status).toBe('dispatched');
    expect(consumer.snapshot('s1')?.frameAssembly.repairDispatchedRevisions).toEqual([11]);
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it('dispatches a frame repair at most once per accepted revision', () => {
    const sendRequest = vi.fn(() => true);
    const consumer = createMirrorConsumer({
      sendRequest,
      onCommit: vi.fn(),
    });
    consumer.registerSession('s1');
    consumer.handleMessage('s1', {
      type: 'buffer-head',
      payload: head(11, 104, 100),
    });

    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: frameChunk(0, 'original'),
    });
    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: frameChunk(0, 'conflict'),
    });
    expect(consumer.snapshot('s1')?.frameAssembly.error?.repair.status).toBe('dispatched');
    expect(consumer.snapshot('s1')?.frameAssembly.repairDispatchedRevisions).toEqual([11]);
    expect(sendRequest).toHaveBeenCalledTimes(1);

    consumer.handleMessage('s1', {
      type: 'buffer-head',
      payload: head(11, 104, 100),
    });
    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: frameChunk(0, 'another-original'),
    });
    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: frameChunk(0, 'another-conflict'),
    });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(consumer.snapshot('s1')?.frameAssembly.repairDispatchedRevisions).toEqual([11]);
  });

  it('separates buffer-head metadata and cursor from body commit', () => {
    const commits: MirrorCommitEvent[] = [];
    const metadata: MirrorMetadataEvent[] = [];
    const consumer = createMirrorConsumer({
      sendRequest: () => false,
      onCommit: (event) => commits.push(event),
      onMetadata: (event) => { metadata.push(event); },
    });
    consumer.registerSession('s1');

    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: payload({
        revision: 1,
        startIndex: 0,
        endIndex: 1,
        lines: [line(0, 'body-one')],
      }),
    });
    expect(commits).toHaveLength(1);

    consumer.handleMessage('s1', {
      type: 'buffer-head',
      payload: {
        ...head(1, 1),
        cursor: { rowIndex: 0, col: 4, visible: true },
      },
    });
    consumer.handleMessage('s1', {
      type: 'buffer-head',
      payload: head(2, 2),
    });

    expect(commits).toHaveLength(1);
    expect(metadata).toHaveLength(2);
    expect(consumer.snapshot('s1')?.head?.revision).toBe(2);
    expect(consumer.snapshot('s1')?.cursor).toEqual({
      rowIndex: 0,
      col: 4,
      visible: true,
    });
    expect(consumer.snapshot('s1')?.body.revision).toBe(1);
    expect(bodyText(consumer.snapshot('s1')!.body, 0)).toBe('body-one');
  });

  it('keeps gaps blank and asks only for declared visible missing ranges', () => {
    const requested: unknown[] = [];
    const consumer = createMirrorConsumer({
      sendRequest: (message) => {
        requested.push(message);
        return false;
      },
    });
    consumer.registerSession('s1', { cacheLines: 1000, cols: 20, rows: 4 });
    consumer.handleMessage('s1', {
      type: 'buffer-head',
      payload: head(1, 104, 100),
    });
    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: payload({
        revision: 1,
        startIndex: 100,
        endIndex: 104,
        availableStartIndex: 100,
        availableEndIndex: 104,
        lines: [line(100, 'row-100'), line(103, 'row-103')],
      }),
    });

    expect(consumer.snapshot('s1')?.body.gapRanges).toEqual([
      { startIndex: 101, endIndex: 103 },
    ]);
    consumer.setVisibleDemand('s1', {
      startIndex: 100,
      endIndex: 104,
      visibleRows: 4,
      mode: 'reading',
    });
    expect(requested.at(-1)).toMatchObject({
      type: 'buffer-sync-request',
      payload: {
        knownRevision: 1,
        targetHeadRevision: 1,
        requestStartIndex: 100,
        requestEndIndex: 104,
        missingRanges: [{ startIndex: 101, endIndex: 103 }],
      },
    });

    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: payload({
        revision: 2,
        startIndex: 101,
        endIndex: 103,
        availableStartIndex: 100,
        availableEndIndex: 104,
        lines: [line(101, 'row-101'), line(102, 'row-102')],
      }),
    });
    expect(consumer.snapshot('s1')?.body.gapRanges).toEqual([]);
    expect(bodyText(consumer.snapshot('s1')!.body, 101)).toBe('row-101');
    expect(bodyText(consumer.snapshot('s1')!.body, 102)).toBe('row-102');
  });

  it('uses the shared initial three-screen window and retained cache boundary', () => {
    const requested: unknown[] = [];
    const consumer = createMirrorConsumer({
      sendRequest: (message) => {
        requested.push(message);
        return false;
      },
    });
    consumer.registerSession('s1', { cacheLines: 1000, cols: 80, rows: 24 });
    consumer.handleMessage('s1', {
      type: 'buffer-head',
      payload: head(3, 300, 0),
    });

    consumer.setVisibleDemand('s1', {
      startIndex: 276,
      endIndex: 300,
      visibleRows: 24,
      mode: 'follow',
    });
    expect(requested.at(-1)).toMatchObject({
      type: 'buffer-sync-request',
      payload: {
        requestStartIndex: 228,
        requestEndIndex: 300,
        targetHeadRevision: 3,
      },
    });
    expect(consumer.snapshot('s1')?.cacheLines).toBe(1000);

    consumer.setVisibleDemand('s1', {
      startIndex: 290,
      endIndex: 300,
      visibleRows: 10,
      mode: 'follow',
    });
    expect(requested.at(-1)).toMatchObject({
      type: 'buffer-sync-request',
      payload: {
        requestStartIndex: 270,
        requestEndIndex: 300,
        targetHeadRevision: 3,
      },
    });
  });

  it('turns an expired incomplete frame into an exact repair request', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const requested: MirrorRequestMessage[] = [];
    const consumer = createMirrorConsumer({
      sendRequest: (message) => {
        requested.push(message);
        return true;
      },
    });
    consumer.registerSession('s1');
    consumer.handleMessage('s1', {
      type: 'buffer-head',
      payload: head(11, 104, 100),
    });
    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: frameChunk(0, 'incomplete'),
    });

    expect(consumer.snapshot('s1')?.body.revision).toBe(0);
    expect(requested).toHaveLength(0);
    vi.advanceTimersByTime(TERMINAL_BUFFER_SYNC_FRAME_MAX_AGE_MS + 2);

    expect(consumer.snapshot('s1')?.frameAssembly.error).toEqual({
      error: 'frame-assembly-expired',
      revision: 11,
      repair: {
        status: 'dispatched',
        range: { startIndex: 100, endIndex: 104 },
      },
    });
    expect(consumer.snapshot('s1')?.body.revision).toBe(0);
    expect(requested).toEqual([
      {
        type: 'buffer-sync-request',
        payload: {
          knownRevision: 0,
          localStartIndex: 0,
          localEndIndex: 0,
          requestStartIndex: 100,
          requestEndIndex: 104,
          targetHeadRevision: 11,
          missingRanges: [{ startIndex: 100, endIndex: 104 }],
        },
      },
    ]);
  });

  it('close cancels only that session timer and assembly resource', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sendRequest = vi.fn(() => true);
    const consumer = createMirrorConsumer({ sendRequest });
    consumer.registerSession('s1');
    consumer.registerSession('s2');
    consumer.handleMessage('s1', {
      type: 'buffer-head',
      payload: head(11, 104, 100),
    });
    consumer.handleMessage('s2', {
      type: 'buffer-head',
      payload: { ...head(20, 210, 200), sessionId: 's2' },
    });
    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: frameChunk(0, 'pending'),
    });

    expect(consumer.snapshot('s1')?.frameAssembly.pending).not.toBeNull();
    consumer.close('s1');
    expect(consumer.snapshot('s1')).toBeNull();
    expect(consumer.snapshot('s2')).not.toBeNull();

    vi.advanceTimersByTime(TERMINAL_BUFFER_SYNC_FRAME_MAX_AGE_MS + 10);
    expect(sendRequest).not.toHaveBeenCalled();
    expect(consumer.snapshot('s2')?.head?.revision).toBe(20);
  });

  it('head-only metadata projects head without body commit or injected output', () => {
    const renderer = createRendererWindow({ visibleRows: 24 });
    const commits: MirrorCommitEvent[] = [];
    const requests: MirrorRequestMessage[] = [];
    const consumer = createMirrorConsumer({
      sendRequest: (message) => {
        requests.push(message);
        return true;
      },
      onMetadata: (event) => renderer.setHead(event.effectiveBounds),
      onCommit: (event) => {
        commits.push(event);
        renderer.commit(event.snapshot);
      },
    });
    consumer.registerSession('s1');

    consumer.handleMessage('s1', { type: 'buffer-head', payload: head(1, 24) });

    expect(commits).toHaveLength(0);
    expect(consumer.snapshot('s1')!.body.revision).toBe(0);
    expect(consumer.snapshot('s1')!.body.lines.size).toBe(0);
    expect(renderer.snapshot().tailEndIndex).toBe(24);
    expect(renderer.setViewport({}).visibleDemand).toMatchObject({ endIndex: 24 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      type: 'buffer-sync-request',
      payload: { requestEndIndex: 24, targetHeadRevision: 1 },
    });
    consumer.dispose();
  });

  it('reuses complete body from cache after a later head lands', () => {
    const renderer = createRendererWindow({ visibleRows: 12 });
    const commits: MirrorCommitEvent[] = [];
    const requests: MirrorRequestMessage[] = [];
    const consumer = createMirrorConsumer({
      sendRequest: (message) => {
        requests.push(message);
        return true;
      },
      onMetadata: (event) => renderer.setHead(event.effectiveBounds),
      onCommit: (event) => {
        commits.push(event);
        consumer.setVisibleDemand('s1', renderer.commit(event.snapshot).visibleDemand);
      },
    });
    consumer.registerSession('s1');

    consumer.handleMessage('s1', {
      type: 'buffer-sync',
      payload: payload({
        revision: 1,
        startIndex: 0,
        endIndex: 24,
        lines: Array.from({ length: 24 }, (_, index) => line(index, `row-${index}`)),
      }),
    });
    expect(commits).toHaveLength(1);
    requests.length = 0;

    const headPayload: BufferHeadPayload = {
      sessionId: 's1',
      revision: 1,
      latestEndIndex: 12,
      availableStartIndex: 0,
      availableEndIndex: 24,
    };
    consumer.handleMessage('s1', { type: 'buffer-head', payload: headPayload });

    expect(commits).toHaveLength(2);
    expect(requests).toHaveLength(0);
    expect(renderer.snapshot().tailEndIndex).toBe(12);
    expect(renderer.snapshot().revision).toBe(1);
    expect(renderer.setViewport({}).visibleDemand).toMatchObject({
      startIndex: 0,
      endIndex: 12,
    });
    const body = consumer.snapshot('s1')!.body;
    expect(body.endIndex).toBe(24);
    expect(body.lines.size).toBe(24);
    expect(bodyText(body, 23)).toBe('row-23');

    const demand = renderer.setViewport({}).visibleDemand;
    consumer.handleMessage('s1', { type: 'buffer-head', payload: headPayload });
    consumer.setVisibleDemand('s1', demand);
    expect(commits).toHaveLength(2);
    expect(requests).toHaveLength(0);
    consumer.dispose();
  });
});
