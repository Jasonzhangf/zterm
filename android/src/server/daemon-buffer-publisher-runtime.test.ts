import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { BufferSyncRequestPayload } from '@zterm/shared/types';
import type { TerminalTransportLane } from '@zterm/shared/protocol';
import {
  createDaemonBufferPublisherRuntime,
  type DaemonBufferPublisherDeps,
} from './daemon-buffer-publisher-runtime';
import type {
  SessionMirror,
  TerminalSession,
  TerminalSessionTransport,
} from './terminal-runtime-types';

function makeTransport(options: {
  readyState?: number;
  bufferedAmount?: number;
  flowUnknown?: boolean;
  isLaneOpen?: (lane: TerminalTransportLane) => boolean;
} = {}) {
  return {
    kind: 'ws' as const,
    readyState: options.readyState ?? 1,
    bufferedAmount: options.bufferedAmount ?? 0,
    flowUnknown: options.flowUnknown,
    backpressureCount: 0,
    isLaneOpen: options.isLaneOpen,
    sendText: () => undefined,
    close: () => undefined,
  } satisfies TerminalSessionTransport;
}

function makeSession(
  id: string,
  transport: TerminalSessionTransport = makeTransport(),
): TerminalSession {
  return {
    id,
    transportId: `transport-${id}`,
    transport,
    sessionName: 'demo',
    backend: 'tmux',
    mirrorKey: 'demo',
    bodySubscribed: true,
    pendingPasteImage: null,
    pendingAttachFile: null,
  } as TerminalSession;
}

function makeMuxChannelTransport(physicalTransport: TerminalSessionTransport): TerminalSessionTransport {
  return {
    kind: physicalTransport.kind,
    get readyState() {
      return physicalTransport.readyState;
    },
    get bufferedAmount() {
      return physicalTransport.bufferedAmount;
    },
    sendText: (text) => physicalTransport.sendText(text),
    close: (reason) => physicalTransport.close(reason),
  };
}

function makeMirror(subscriberIds: string[], revision = 1): SessionMirror {
  return {
    key: 'demo',
    sessionName: 'demo',
    backend: 'tmux',
    scratchBridge: null,
    lifecycle: 'ready',
    cols: 80,
    rows: 24,
    consecutiveFailures: 0,
    cursorKeysApp: false,
    revision,
    lastScrollbackCount: 0,
    bufferStartIndex: 0,
    bufferLines: [[]],
    cursor: null,
    lastFlushStartedAt: 0,
    lastFlushCompletedAt: 0,
    lastLiveActivityAt: 0,
    lastHeadBroadcastAt: 0,
    flushInFlight: false,
    flushPromise: null,
    quietFlushStreak: 0,
    lastFlushHadContentChanges: false,
    liveSyncTimer: null,
    subscribers: new Set(subscriberIds),
  } as SessionMirror;
}

function makeDeps(overrides: Partial<DaemonBufferPublisherDeps> = {}): DaemonBufferPublisherDeps {
  const sessions = new Map<string, TerminalSession>();
  return {
    sessions,
    sendMessage: () => undefined,
    sendText: () => undefined,
    buildBufferHeadPayload: (sessionId, mirror) => ({
      sessionId,
      revision: mirror.revision,
      startIndex: mirror.bufferStartIndex,
      endIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
      lines: [],
    }) as never,
    buildChangedRangesBufferSyncPayload: (mirror, changedRanges) => ({
      revision: mirror.revision,
      startIndex: changedRanges[0]?.startIndex ?? mirror.bufferStartIndex,
      endIndex: changedRanges[changedRanges.length - 1]?.endIndex ?? mirror.bufferStartIndex,
      lines: [],
    }) as never,
    ensureSessionReady: () => undefined,
    buildRequestedRangeBufferPayload: (mirror, request) => ({
      revision: mirror.revision,
      startIndex: request.requestStartIndex,
      endIndex: request.requestEndIndex,
      availableStartIndex: mirror.bufferStartIndex,
      availableEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
      cols: mirror.cols,
      rows: mirror.rows,
      cursorKeysApp: mirror.cursorKeysApp,
      cursor: mirror.cursor,
      requestSentAt: request.requestedAt,
      lines: [],
    }),
    ...overrides,
  };
}

describe('daemon buffer publisher runtime', () => {
  it('queues and flushes one latest buffer-sync frame per subscriber', () => {
    const session = makeSession('s1');
    const sent: string[] = [];
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      sendText: (transport, text) => {
        expect(transport).toBe(session.transport);
        sent.push(text);
      },
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1']);

    publisher.broadcastChangedRangesBufferSyncToSubscribers(
      mirror,
      [{ startIndex: 1, endIndex: 2 }],
    );

    expect(sent).toHaveLength(1);
    expect(session.bufferSyncState?.lastSentRevision).toBe(1);
    expect(session.bufferSyncState?.pendingLatestRevision).toBeNull();
  });

  it('holds pending frames while transport backpressure is active and drains after low water', () => {
    const transport = makeTransport({ bufferedAmount: 200_000 });
    const session = makeSession('s1', transport);
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      sendText: () => undefined,
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1']);

    publisher.broadcastChangedRangesBufferSyncToSubscribers(
      mirror,
      [{ startIndex: 2, endIndex: 3 }],
    );

    expect(session.bufferSyncState?.pendingLatestRevision).toBe(1);
    expect(session.bufferSyncState?.pendingChangedAbsoluteRanges).toEqual([
      { startIndex: 2, endIndex: 3 },
    ]);
    expect(publisher.flushPendingSubscriberBufferSync(mirror, 's1')).toBe('backpressured');

    transport.bufferedAmount = 0;
    transport.backpressureCount = 0;
    expect(publisher.flushPendingSubscriberBufferSync(mirror, 's1')).toBe('sent');
    expect(session.bufferSyncState?.pendingLatestRevision).toBeNull();
  });

  it('holds pending frames while the transport flow observation is unknown', () => {
    const transport = makeTransport({ bufferedAmount: 0, flowUnknown: true });
    const session = makeSession('s1', transport);
    const sent: string[] = [];
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      sendText: (_transport, text) => {
        sent.push(text);
      },
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1']);

    publisher.broadcastChangedRangesBufferSyncToSubscribers(
      mirror,
      [{ startIndex: 2, endIndex: 3 }],
    );

    // An unknown flow observation is not proof of an empty queue: hold the
    // frame and send nothing until a real bufferedAmount value is projected.
    expect(sent).toHaveLength(0);
    expect(session.bufferSyncState?.pendingLatestRevision).toBe(1);
    expect(publisher.flushPendingSubscriberBufferSync(mirror, 's1')).toBe('backpressured');

    // Once the client reports a real flow value, the held frame flushes at the
    // same revision identity with no chunk loss.
    transport.flowUnknown = false;
    expect(publisher.flushPendingSubscriberBufferSync(mirror, 's1')).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(session.bufferSyncState?.lastSentRevision).toBe(1);
    expect(session.bufferSyncState?.pendingLatestRevision).toBeNull();
  });

  it('broadcasts a fresh head once and serves later probes from the cache', () => {
    const first = makeSession('s1');
    const second = makeSession('s2');
    const heads: string[] = [];
    const deps = makeDeps({
      sessions: new Map([['s1', first], ['s2', second]]),
      sendMessage: (session, message) => {
        if (message.type === 'buffer-head') {
          heads.push(session.id);
        }
      },
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1', 's2'], 7);

    publisher.sendBufferHeadToSession(first, mirror);
    publisher.sendBufferHeadToSession(first, mirror);

    expect(heads).toEqual(['s1', 's2', 's1']);
  });

  it('splits an oversized fresh body into contiguous same-revision frames without live-tail seed', () => {
    const session = makeSession('s1');
    const sent: string[] = [];
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      buildChangedRangesBufferSyncPayload: (mirror, ranges) => ({
        revision: mirror.revision,
        startIndex: ranges[0]?.startIndex ?? mirror.bufferStartIndex,
        endIndex: ranges[ranges.length - 1]?.endIndex ?? mirror.bufferStartIndex,
        lines: Array.from({ length: 20_000 }, (_, index) => ({ i: index })),
      }) as never,
      sendText: (transport, text) => {
        expect(transport).toBe(session.transport);
        sent.push(text);
      },
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1'], 4);

    publisher.broadcastChangedRangesBufferSyncToSubscribers(
      mirror,
      [{ startIndex: 0, endIndex: 20_000 }],
    );

    expect(sent.length).toBeGreaterThan(1);
    const messages = sent.map((text) => JSON.parse(text));
    for (const message of messages) {
      expect(message.payload.revision).toBe(4);
      expect(message.payload.frameChunkCount).toBe(messages.length);
    }
    expect(messages[0].payload.startIndex).toBe(0);
    expect(messages[messages.length - 1].payload.endIndex).toBe(20_000);
    expect(session.bufferSyncState?.lastSentRevision).toBe(4);
  });

  it('round-robins explicit range chunks across logical subscribers sharing one physical transport', () => {
    const sharedTransport = makeTransport({ bufferedAmount: 200_000 });
    const first = makeSession('s1', makeMuxChannelTransport(sharedTransport));
    const second = makeSession('s2', makeMuxChannelTransport(sharedTransport));
    const third = makeSession('s3', makeMuxChannelTransport(sharedTransport));
    first.transportId = 'connection-1';
    second.transportId = 'connection-1';
    third.transportId = 'connection-1';
    first.muxParentTransportId = 'connection-1';
    second.muxParentTransportId = 'connection-1';
    third.muxParentTransportId = 'connection-1';
    first.bodySubscribed = false;
    second.bodySubscribed = false;
    third.bodySubscribed = false;
    const sent: Array<{ requestSentAt: number; frameChunkIndex?: number }> = [];
    const largeLines = Array.from({ length: 20_000 }, (_, index) => ({ i: index }));
    const deps = makeDeps({
      sessions: new Map([['s1', first], ['s2', second], ['s3', third]]),
      sendText: (_transport, text) => {
        const payload = JSON.parse(text).payload;
        sent.push({ requestSentAt: payload.requestSentAt, frameChunkIndex: payload.frameChunkIndex });
      },
      buildRequestedRangeBufferPayload: (mirror, request) => ({
        revision: mirror.revision,
        startIndex: 0,
        endIndex: 20_000,
        availableStartIndex: mirror.bufferStartIndex,
        availableEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
        cols: mirror.cols,
        rows: mirror.rows,
        cursorKeysApp: mirror.cursorKeysApp,
        cursor: mirror.cursor,
        requestSentAt: request.requestedAt,
        lines: largeLines,
      }) as never,
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1', 's2', 's3'], 9);
    const request = (requestedAt: number) => ({
      knownRevision: 8,
      localStartIndex: 0,
      localEndIndex: 0,
      requestStartIndex: 0,
      requestEndIndex: 20_000,
      requestedAt,
      targetHeadRevision: 9,
    } satisfies BufferSyncRequestPayload);

    expect(publisher.enqueueRangeBufferSyncResponse(first, mirror, request(101))).toBe('queued');
    expect(publisher.enqueueRangeBufferSyncResponse(second, mirror, request(202))).toBe('queued');
    expect(publisher.enqueueRangeBufferSyncResponse(third, mirror, request(303))).toBe('queued');

    sharedTransport.bufferedAmount = 0;
    sharedTransport.backpressureCount = 0;
    publisher.flushPendingBufferSyncToSubscribers(mirror);
    publisher.flushPendingBufferSyncToSubscribers(mirror);

    expect(sent.slice(0, 2).map((message) => message.requestSentAt)).toEqual([101, 202]);
    expect(sent.slice(2, 4).map((message) => message.requestSentAt)).toEqual([303, 101]);
  });

  it('returns stale-transport without clearing the pending range', () => {
    const session = makeSession('s1');
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      sendText: () => undefined,
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1']);

    session.bufferSyncState = {
      lastSentRevision: 0,
      pendingLatestRevision: 1,
      pendingChangedAbsoluteRanges: [{ startIndex: 1, endIndex: 2 }],
      pendingSince: Date.now(),
      pendingTransportId: 'old-transport',
      highWaterActive: false,
      highWaterEnteredAt: 0,
      resyncRequired: false,
      resyncReason: null,
    };

    expect(publisher.flushPendingSubscriberBufferSync(mirror, 's1')).toBe('stale-transport');
    expect(session.bufferSyncState?.resyncReason).toBe('transport-generation');
    expect(session.bufferSyncState?.pendingChangedAbsoluteRanges).toHaveLength(1);
  });

  it('publishes explicit range responses through the publisher while body subscription is disabled', () => {
    const session = makeSession('s1');
    session.bodySubscribed = false;
    const sent: string[] = [];
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      sendText: (_transport, text) => sent.push(text),
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1'], 9);
    const request = {
      knownRevision: 8,
      localStartIndex: 0,
      localEndIndex: 0,
      requestStartIndex: 4,
      requestEndIndex: 6,
      requestedAt: 101,
      targetHeadRevision: 9,
    } satisfies BufferSyncRequestPayload;

    expect(publisher.enqueueRangeBufferSyncResponse(session, mirror, request)).toBe('queued');

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({
      type: 'buffer-sync',
      payload: {
        revision: 9,
        startIndex: 4,
        endIndex: 6,
        requestSentAt: 101,
      },
    });
    expect(session.bufferSyncState?.pendingRangeResponses).toHaveLength(0);
  });

  it('keeps queued range responses FIFO, split, and request-correlated under backpressure', () => {
    const transport = makeTransport({ bufferedAmount: 200_000 });
    const session = makeSession('s1', transport);
    session.bodySubscribed = false;
    const sent: string[] = [];
    const largeLines = Array.from({ length: 20_000 }, (_, index) => ({ i: index }));
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      sendText: (_transport, text) => sent.push(text),
      buildRequestedRangeBufferPayload: (mirror, request) => ({
        revision: mirror.revision,
        startIndex: request.requestStartIndex,
        endIndex: request.requestEndIndex,
        availableStartIndex: mirror.bufferStartIndex,
        availableEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
        cols: mirror.cols,
        rows: mirror.rows,
        cursorKeysApp: mirror.cursorKeysApp,
        cursor: mirror.cursor,
        requestSentAt: request.requestedAt,
        lines: request.requestedAt === 201 ? largeLines : [{ i: 20_000 }],
      }) as never,
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1'], 12);
    const firstRequest = {
      knownRevision: 11,
      localStartIndex: 0,
      localEndIndex: 0,
      requestStartIndex: 0,
      requestEndIndex: 20_000,
      requestedAt: 201,
      targetHeadRevision: 12,
    } satisfies BufferSyncRequestPayload;
    const secondRequest = {
      ...firstRequest,
      requestStartIndex: 20_000,
      requestEndIndex: 20_001,
      requestedAt: 202,
    } satisfies BufferSyncRequestPayload;

    expect(publisher.enqueueRangeBufferSyncResponse(session, mirror, firstRequest)).toBe('queued');
    expect(publisher.enqueueRangeBufferSyncResponse(session, mirror, secondRequest)).toBe('queued');
    expect(sent).toHaveLength(0);

    transport.bufferedAmount = 0;
    transport.backpressureCount = 0;
    for (let attempt = 0; attempt < 100 && (session.bufferSyncState?.pendingRangeResponses?.length ?? 0) > 0; attempt += 1) {
      publisher.flushPendingBufferSyncToSubscribers(mirror);
    }

    const messages = sent.map((text) => JSON.parse(text));
    expect(messages.length).toBeGreaterThan(1);
    const firstRequestMessages = messages.slice(0, -1);
    expect(firstRequestMessages.every((message) => message.payload.requestSentAt === 201)).toBe(true);
    expect(firstRequestMessages.every((message) => message.payload.revision === 12)).toBe(true);
    expect(firstRequestMessages.every((message) => message.payload.frameStartIndex === 0)).toBe(true);
    expect(firstRequestMessages.every((message) => message.payload.frameEndIndex === 20_000)).toBe(true);
    expect(messages[messages.length - 1]?.payload).toMatchObject({
      requestSentAt: 202,
      startIndex: 20_000,
      endIndex: 20_001,
    });
    expect(session.bufferSyncState?.pendingRangeResponses).toHaveLength(0);
  });

  it('rejects explicit range requests when the per-subscriber queue is full', () => {
    const transport = makeTransport({ bufferedAmount: 200_000 });
    const session = makeSession('s1', transport);
    session.bodySubscribed = false;
    const deps = makeDeps({ sessions: new Map([['s1', session]]) });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1'], 12);
    const request = (requestedAt: number) => ({
      knownRevision: 11,
      localStartIndex: 0,
      localEndIndex: 0,
      requestStartIndex: 0,
      requestEndIndex: 1,
      requestedAt,
      targetHeadRevision: 12,
    } satisfies BufferSyncRequestPayload);

    for (let index = 0; index < 64; index += 1) {
      expect(publisher.enqueueRangeBufferSyncResponse(session, mirror, request(index))).toBe('queued');
    }

    expect(publisher.enqueueRangeBufferSyncResponse(session, mirror, request(64))).toBe('queue-full');
    expect(session.bufferSyncState?.pendingRangeResponses).toHaveLength(64);
  });

  it('retains successful range chunk progress after a later chunk send fails', () => {
    const session = makeSession('s1');
    session.bodySubscribed = false;
    const sent: number[] = [];
    const largeLines = Array.from({ length: 20_000 }, (_, index) => ({ i: index }));
    let sendAttempts = 0;
    let failOnSecondAttempt = true;
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      sendText: (_transport, text) => {
        sendAttempts += 1;
        if (failOnSecondAttempt && sendAttempts === 2) {
          throw new Error('forced second chunk failure');
        }
        sent.push(JSON.parse(text).payload.frameChunkIndex);
      },
      buildRequestedRangeBufferPayload: (mirror, request) => ({
        revision: mirror.revision,
        startIndex: 0,
        endIndex: 20_000,
        availableStartIndex: mirror.bufferStartIndex,
        availableEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
        cols: mirror.cols,
        rows: mirror.rows,
        cursorKeysApp: mirror.cursorKeysApp,
        cursor: mirror.cursor,
        requestSentAt: request.requestedAt,
        lines: largeLines,
      }) as never,
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1'], 12);

    expect(publisher.enqueueRangeBufferSyncResponse(session, mirror, {
      knownRevision: 11,
      localStartIndex: 0,
      localEndIndex: 0,
      requestStartIndex: 0,
      requestEndIndex: 20_000,
      requestedAt: 201,
      targetHeadRevision: 12,
    })).toBe('queued');
    expect(sent).toEqual([0]);
    expect(session.bufferSyncState?.pendingRangeResponses?.[0]?.nextChunkIndex).toBe(1);

    failOnSecondAttempt = false;
    publisher.flushPendingSubscriberBufferSync(mirror, session.id);

    expect(sent[0]).toBe(0);
    expect(sent[1]).toBe(1);
    expect(new Set(sent).size).toBe(sent.length);
  });

  it('re-checks physical backpressure before every chunk and resumes the same frame identity', () => {
    const session = makeSession('s1');
    session.bodySubscribed = false;
    const sent: number[] = [];
    const largeLines = Array.from({ length: 20_000 }, (_, index) => ({ i: index }));
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      sendText: (_transport, text) => {
        sent.push(JSON.parse(text).payload.frameChunkIndex);
        // A queue rise after the first chunk must pause the same authoritative
        // frame instead of sending a half-applied different revision.
        session.transport!.bufferedAmount = 200_000;
      },
      buildRequestedRangeBufferPayload: (mirror, request) => ({
        revision: mirror.revision,
        startIndex: 0,
        endIndex: 20_000,
        availableStartIndex: mirror.bufferStartIndex,
        availableEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
        cols: mirror.cols,
        rows: mirror.rows,
        cursorKeysApp: mirror.cursorKeysApp,
        cursor: mirror.cursor,
        requestSentAt: request.requestedAt,
        lines: largeLines,
      }) as never,
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1'], 12);

    expect(publisher.enqueueRangeBufferSyncResponse(session, mirror, {
      knownRevision: 11,
      localStartIndex: 0,
      localEndIndex: 0,
      requestStartIndex: 0,
      requestEndIndex: 20_000,
      requestedAt: 201,
      targetHeadRevision: 12,
    })).toBe('queued');
    expect(sent).toEqual([0]);

    // Still OPEN and the frame is not complete: next flush must wait at the
    // same chunk boundary and must not emit a new frame revision.
    expect(publisher.flushPendingSubscriberBufferSync(mirror, session.id)).toBe('backpressured');
    expect(sent).toEqual([0]);
    expect(session.bufferSyncState?.pendingRangeResponses?.[0]?.nextChunkIndex).toBe(1);
    expect(session.bufferSyncState?.pendingRangeResponses?.[0]?.payload.revision).toBe(12);

    session.transport!.bufferedAmount = 0;
    expect(publisher.flushPendingSubscriberBufferSync(mirror, session.id)).toBe('sent');
    expect(sent).toEqual([0, 1]);
  });

  it('freezes a partially sent live frame and completes it before a newer revision', () => {
    const transport = makeTransport({ bufferedAmount: 0 });
    const session = makeSession('s1', transport);
    const sent: Array<{ revision: number; chunk: number; count: number }> = [];
    let freezeOnNextSend = true;
    const largeLines = Array.from({ length: 3000 }, (_, index) => ({
      i: index,
      t: 'x'.repeat(100),
    }));
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      buildChangedRangesBufferSyncPayload: (mirror, ranges) => ({
        revision: mirror.revision,
        startIndex: ranges[0]?.startIndex ?? mirror.bufferStartIndex,
        endIndex: ranges[ranges.length - 1]?.endIndex ?? mirror.bufferStartIndex,
        lines: largeLines,
      }) as never,
      sendText: (_transport, text) => {
        const payload = JSON.parse(text).payload as {
          revision: number;
          frameChunkIndex: number;
          frameChunkCount: number;
        };
        sent.push({
          revision: payload.revision,
          chunk: payload.frameChunkIndex,
          count: payload.frameChunkCount,
        });
        // Freeze the frame immediately after the first chunk crosses the wire.
        if (freezeOnNextSend) {
          freezeOnNextSend = false;
          session.transport!.bufferedAmount = 200_000;
        }
      },
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1'], 1);

    publisher.broadcastChangedRangesBufferSyncToSubscribers(
      mirror,
      [{ startIndex: 0, endIndex: 3000 }],
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ revision: 1, chunk: 0 });
    expect(session.bufferSyncState?.pendingLiveFrame?.revision).toBe(1);
    expect(session.bufferSyncState?.pendingLiveFrame?.nextChunkIndex).toBe(1);

    // A newer revision arrives while revision 1 is half sent; it stages behind.
    mirror.revision = 2;
    publisher.broadcastChangedRangesBufferSyncToSubscribers(
      mirror,
      [{ startIndex: 0, endIndex: 3000 }],
    );

    // Draining completes the frozen revision-1 frame before any revision-2 chunk.
    session.transport!.bufferedAmount = 0;
    expect(publisher.flushPendingSubscriberBufferSync(mirror, 's1')).toBe('sent');
    const chunkCount = sent[0]!.count;
    expect(sent).toHaveLength(chunkCount);
    expect(sent.map((entry) => entry.revision)).toEqual(Array(chunkCount).fill(1));
    for (let index = 0; index < chunkCount; index += 1) {
      expect(sent[index]).toMatchObject({ revision: 1, chunk: index, count: chunkCount });
    }
    expect(session.bufferSyncState?.pendingLiveFrame).toBeNull();
    expect(session.bufferSyncState?.pendingChangedAbsoluteRanges).toEqual([
      { startIndex: 0, endIndex: 3000 },
    ]);
  });

  it('discards a frozen live frame and resyncs from chunk 0 after a transport generation change', () => {
    const transport = makeTransport({ bufferedAmount: 0 });
    const session = makeSession('s1', transport);
    const sent: Array<{ revision: number; chunk: number; transportId: string }> = [];
    const largeLines = Array.from({ length: 3000 }, (_, index) => ({
      i: index,
      t: 'x'.repeat(100),
    }));
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      buildChangedRangesBufferSyncPayload: (mirror, ranges) => ({
        revision: mirror.revision,
        startIndex: ranges[0]?.startIndex ?? mirror.bufferStartIndex,
        endIndex: ranges[ranges.length - 1]?.endIndex ?? mirror.bufferStartIndex,
        lines: largeLines,
      }) as never,
      sendText: (_transport, text) => {
        const payload = JSON.parse(text).payload as {
          revision: number;
          frameChunkIndex: number;
        };
        sent.push({
          revision: payload.revision,
          chunk: payload.frameChunkIndex,
          transportId: session.transportId,
        });
        session.transport!.bufferedAmount = 200_000;
      },
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1'], 1);

    publisher.broadcastChangedRangesBufferSyncToSubscribers(
      mirror,
      [{ startIndex: 0, endIndex: 3000 }],
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ revision: 1, chunk: 0, transportId: 'transport-s1' });

    // The session now rides a fresh physical transport after a reconnect.
    session.transportId = 'transport-s1-r2';
    session.transport!.bufferedAmount = 0;
    expect(publisher.flushPendingSubscriberBufferSync(mirror, 's1')).toBe('stale-transport');
    expect(session.bufferSyncState?.pendingLiveFrame).toBeNull();
    expect(session.bufferSyncState?.resyncRequired).toBe(true);
    expect(session.bufferSyncState?.resyncReason).toBe('transport-generation');
    expect(session.bufferSyncState?.pendingChangedAbsoluteRanges).toEqual([
      { startIndex: 0, endIndex: 3000 },
    ]);

    // The new transport queues one fresh authoritative frame from chunk 0.
    publisher.broadcastChangedRangesBufferSyncToSubscribers(
      mirror,
      [{ startIndex: 0, endIndex: 3000 }],
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ revision: 1, chunk: 0, transportId: 'transport-s1-r2' });
  });

  it('live buffer-sync frame pins control lane when bulk is closed at chunk 0 and stays control after bulk opens mid-frame', () => {
    let bulkOpen = false;
    const transport = makeTransport({
      isLaneOpen: (lane) => lane === 'control' || bulkOpen,
    });
    const session = makeSession('s1', transport);
    const sent: Array<{ lane: TerminalTransportLane; chunk: number; count: number }> = [];
    const largeLines = Array.from({ length: 3000 }, (_, index) => ({
      i: index,
      t: 'x'.repeat(100),
    }));
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      buildChangedRangesBufferSyncPayload: (mirror, ranges) => ({
        revision: mirror.revision,
        startIndex: ranges[0]?.startIndex ?? mirror.bufferStartIndex,
        endIndex: ranges[ranges.length - 1]?.endIndex ?? mirror.bufferStartIndex,
        lines: largeLines,
      }) as never,
      sendText: (_transport, text, lane) => {
        const payload = JSON.parse(text).payload as {
          revision: number;
          frameChunkIndex: number;
          frameChunkCount: number;
        };
        sent.push({
          lane: lane ?? 'control',
          chunk: payload.frameChunkIndex,
          count: payload.frameChunkCount,
        });
        if (payload.frameChunkIndex === 0) {
          transport.bufferedAmount = 200_000;
        }
      },
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1'], 1);

    publisher.broadcastChangedRangesBufferSyncToSubscribers(
      mirror,
      [{ startIndex: 0, endIndex: 3000 }],
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.lane).toBe('control');
    expect(sent[0]!.chunk).toBe(0);
    expect(session.bufferSyncState?.pendingLiveFrame?.effectiveLane).toBe('control');
    expect(session.bufferSyncState?.pendingLiveFrame?.nextChunkIndex).toBe(1);

    // zterm-bulk opens mid-frame: remaining chunks of the same frame stay on control.
    bulkOpen = true;
    transport.bufferedAmount = 0;
    for (
      let attempt = 0;
      attempt < 100 && session.bufferSyncState?.pendingLiveFrame;
      attempt += 1
    ) {
      publisher.flushPendingSubscriberBufferSync(mirror, 's1');
    }
    const chunkCount = sent[0]!.count;
    expect(sent).toHaveLength(chunkCount);
    expect(sent.map((entry) => entry.lane)).toEqual(Array(chunkCount).fill('control'));
    expect(sent.map((entry) => entry.chunk)).toEqual(
      Array.from({ length: chunkCount }, (_, index) => index),
    );
    expect(session.bufferSyncState?.pendingLiveFrame).toBeNull();
    expect(session.bufferSyncState?.pendingChangedAbsoluteRanges).toEqual([]);

    // A subsequent frame starts on the now-open bulk lane.
    const controlSent = sent.length;
    publisher.broadcastChangedRangesBufferSyncToSubscribers(
      mirror,
      [{ startIndex: 3000, endIndex: 4000 }],
    );
    expect(sent.slice(controlSent).every((entry) => entry.lane === 'bulk')).toBe(true);
  });

  it('live buffer-sync frame started on bulk discards and resends from chunk 0 on control when bulk closes mid-frame', () => {
    let bulkOpen = true;
    const transport = makeTransport({
      isLaneOpen: (lane) => lane === 'control' || bulkOpen,
    });
    const session = makeSession('s1', transport);
    const sent: Array<{ lane: TerminalTransportLane; chunk: number }> = [];
    const largeLines = Array.from({ length: 3000 }, (_, index) => ({
      i: index,
      t: 'x'.repeat(100),
    }));
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      buildChangedRangesBufferSyncPayload: (mirror, ranges) => ({
        revision: mirror.revision,
        startIndex: ranges[0]?.startIndex ?? mirror.bufferStartIndex,
        endIndex: ranges[ranges.length - 1]?.endIndex ?? mirror.bufferStartIndex,
        lines: largeLines,
      }) as never,
      sendText: (_transport, text, lane) => {
        const payload = JSON.parse(text).payload as {
          revision: number;
          frameChunkIndex: number;
          frameChunkCount: number;
        };
        sent.push({ lane: lane ?? 'control', chunk: payload.frameChunkIndex });
        if (payload.frameChunkIndex === 0 && lane === 'bulk') {
          bulkOpen = false;
        }
      },
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1'], 1);

    publisher.broadcastChangedRangesBufferSyncToSubscribers(
      mirror,
      [{ startIndex: 0, endIndex: 3000 }],
    );

    // Chunk 0 left on bulk; bulk closed before chunk 1 so the frame discards.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.lane).toBe('bulk');
    expect(session.bufferSyncState?.pendingLiveFrame).toBeNull();
    expect(session.bufferSyncState?.pendingChangedAbsoluteRanges).toEqual([
      { startIndex: 0, endIndex: 3000 },
    ]);

    // Re-flush rebuilds the frame from chunk 0 on control.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = session.bufferSyncState;
      if (!state?.pendingLiveFrame && (state?.pendingChangedAbsoluteRanges.length ?? 0) === 0) {
        break;
      }
      publisher.flushPendingSubscriberBufferSync(mirror, 's1');
    }
    const controlStart = sent.findIndex((entry) => entry.lane === 'control');
    expect(controlStart).toBeGreaterThanOrEqual(1);
    expect(sent.slice(controlStart).every((entry) => entry.lane === 'control')).toBe(true);
    expect(sent.slice(controlStart).map((entry) => entry.chunk)).toEqual(
      Array.from({ length: sent.length - controlStart }, (_, index) => index),
    );
    expect(session.bufferSyncState?.pendingLiveFrame).toBeNull();
    expect(session.bufferSyncState?.pendingChangedAbsoluteRanges).toEqual([]);
  });
});

describe('daemon buffer publisher lane pinning', () => {
  it('range buffer-sync response pins control lane when bulk is closed at chunk 0 and stays control after bulk opens mid-response', () => {
    let bulkOpen = false;
    const transport = makeTransport({
      isLaneOpen: (lane) => lane === 'control' || bulkOpen,
    });
    const session = makeSession('s1', transport);
    session.bodySubscribed = false;
    const sent: Array<{ lane: TerminalTransportLane; chunk: number }> = [];
    const largeLines = Array.from({ length: 20_000 }, (_, index) => ({ i: index }));
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      buildRequestedRangeBufferPayload: (mirror, request) => ({
        revision: mirror.revision,
        startIndex: request.requestStartIndex,
        endIndex: request.requestEndIndex,
        availableStartIndex: mirror.bufferStartIndex,
        availableEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
        cols: mirror.cols,
        rows: mirror.rows,
        cursorKeysApp: mirror.cursorKeysApp,
        cursor: mirror.cursor,
        requestSentAt: request.requestedAt,
        lines: largeLines,
      }) as never,
      sendText: (_transport, text, lane) => {
        const payload = JSON.parse(text).payload as {
          requestSentAt: number;
          frameChunkIndex: number;
          frameChunkCount: number;
        };
        sent.push({ lane: lane ?? 'control', chunk: payload.frameChunkIndex });
        if (payload.frameChunkIndex === 0 && payload.requestSentAt === 101) {
          transport.bufferedAmount = 200_000;
        }
      },
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1'], 9);
    const request = {
      knownRevision: 8,
      localStartIndex: 0,
      localEndIndex: 0,
      requestStartIndex: 0,
      requestEndIndex: 20_000,
      requestedAt: 101,
      targetHeadRevision: 9,
    } satisfies BufferSyncRequestPayload;

    expect(publisher.enqueueRangeBufferSyncResponse(session, mirror, request)).toBe('queued');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.lane).toBe('control');
    expect(session.bufferSyncState?.pendingRangeResponses?.[0]?.effectiveLane).toBe('control');
    expect(session.bufferSyncState?.pendingRangeResponses?.[0]?.nextChunkIndex).toBe(1);

    // zterm-bulk opens mid-response: remaining chunks stay on control.
    bulkOpen = true;
    transport.bufferedAmount = 0;
    for (
      let attempt = 0;
      attempt < 100 && (session.bufferSyncState?.pendingRangeResponses?.length ?? 0) > 0;
      attempt += 1
    ) {
      publisher.flushPendingBufferSyncToSubscribers(mirror);
    }

    const chunkCount = Math.max(1, ...sent.map((entry) => entry.chunk)) + 1;
    expect(sent).toHaveLength(chunkCount);
    expect(sent.every((entry) => entry.lane === 'control')).toBe(true);
    expect(sent.map((entry) => entry.chunk)).toEqual(
      Array.from({ length: chunkCount }, (_, index) => index),
    );
    expect(session.bufferSyncState?.pendingRangeResponses).toHaveLength(0);

    // A subsequent range response starts on the now-open bulk lane.
    const beforeSecond = sent.length;
    publisher.enqueueRangeBufferSyncResponse(session, mirror, { ...request, requestedAt: 102 });
    for (
      let attempt = 0;
      attempt < 100 && (session.bufferSyncState?.pendingRangeResponses?.length ?? 0) > 0;
      attempt += 1
    ) {
      publisher.flushPendingBufferSyncToSubscribers(mirror);
    }
    expect(sent.slice(beforeSecond).every((entry) => entry.lane === 'bulk')).toBe(true);
    expect(session.bufferSyncState?.pendingRangeResponses).toHaveLength(0);
  });

  it('range buffer-sync response started on bulk resets to chunk 0 on control when bulk closes mid-response', () => {
    let bulkOpen = true;
    const transport = makeTransport({
      isLaneOpen: (lane) => lane === 'control' || bulkOpen,
    });
    const session = makeSession('s1', transport);
    session.bodySubscribed = false;
    const sent: Array<{ lane: TerminalTransportLane; chunk: number }> = [];
    const largeLines = Array.from({ length: 20_000 }, (_, index) => ({ i: index }));
    const deps = makeDeps({
      sessions: new Map([['s1', session]]),
      buildRequestedRangeBufferPayload: (mirror, request) => ({
        revision: mirror.revision,
        startIndex: request.requestStartIndex,
        endIndex: request.requestEndIndex,
        availableStartIndex: mirror.bufferStartIndex,
        availableEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
        cols: mirror.cols,
        rows: mirror.rows,
        cursorKeysApp: mirror.cursorKeysApp,
        cursor: mirror.cursor,
        requestSentAt: request.requestedAt,
        lines: largeLines,
      }) as never,
      sendText: (_transport, text, lane) => {
        const payload = JSON.parse(text).payload as {
          frameChunkIndex: number;
          frameChunkCount: number;
        };
        sent.push({ lane: lane ?? 'control', chunk: payload.frameChunkIndex });
        if (payload.frameChunkIndex === 0 && lane === 'bulk') {
          bulkOpen = false;
        }
      },
    });
    const publisher = createDaemonBufferPublisherRuntime(deps);
    const mirror = makeMirror(['s1'], 9);
    const request = {
      knownRevision: 8,
      localStartIndex: 0,
      localEndIndex: 0,
      requestStartIndex: 0,
      requestEndIndex: 20_000,
      requestedAt: 101,
      targetHeadRevision: 9,
    } satisfies BufferSyncRequestPayload;

    expect(publisher.enqueueRangeBufferSyncResponse(session, mirror, request)).toBe('queued');

    // Chunk 0 left on bulk; bulk closed before chunk 1 so the response resets.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.lane).toBe('bulk');
    expect(session.bufferSyncState?.pendingRangeResponses?.[0]?.nextChunkIndex).toBe(0);
    expect(session.bufferSyncState?.pendingRangeResponses?.[0]?.effectiveLane).toBe('control');

    transport.bufferedAmount = 0;
    for (
      let attempt = 0;
      attempt < 100 && (session.bufferSyncState?.pendingRangeResponses?.length ?? 0) > 0;
      attempt += 1
    ) {
      publisher.flushPendingBufferSyncToSubscribers(mirror);
    }

    expect(sent.length).toBeGreaterThan(1);
    const controlStart = sent.findIndex((entry) => entry.lane === 'control');
    expect(controlStart).toBeGreaterThanOrEqual(1);
    expect(sent.slice(controlStart).every((entry) => entry.lane === 'control')).toBe(true);
    expect(sent.slice(controlStart).map((entry) => entry.chunk)).toEqual(
      Array.from({ length: sent.length - controlStart }, (_, index) => index),
    );
    expect(session.bufferSyncState?.pendingRangeResponses).toHaveLength(0);
  });
});

describe('daemon buffer publisher ownership gates', () => {
  it('keeps subscriber data publishing out of mirror writer and god runtime files', () => {
    const publisherSource = readFileSync(
      join(process.cwd(), 'src', 'server', 'daemon-buffer-publisher-runtime.ts'),
      'utf8',
    );
    const mirrorRuntimeSource = readFileSync(
      join(process.cwd(), 'src', 'server', 'terminal-mirror-runtime.ts'),
      'utf8',
    );
    const messageRuntimeSource = readFileSync(
      join(process.cwd(), 'src', 'server', 'terminal-message-runtime.ts'),
      'utf8',
    );
    const edgeRegistry = JSON.parse(readFileSync(
      join(process.cwd(), 'docs', 'edge-registry.json'),
      'utf8',
    )) as { edges: Array<{ edge_id: string; publication_lanes?: string[] }> };
    const publisherTransportEdge = edgeRegistry.edges.find(
      (edge) => edge.edge_id === 'edge.daemon.buffer_publisher_to_transport_subscriber',
    );

    expect(publisherSource).not.toContain("from './terminal-mirror-runtime'");
    expect(publisherSource).not.toContain("from './server'");
    expect(publisherSource).not.toContain("from './terminal-message-runtime'");
    expect(publisherSource).not.toContain("from './daemon-control-gateway-runtime'");
    expect(mirrorRuntimeSource).toContain('createDaemonBufferPublisherRuntime');
    expect(mirrorRuntimeSource).not.toContain('SUBSCRIBER_PENDING_RANGE_LIMIT');
    expect(mirrorRuntimeSource).not.toContain('splitBufferSyncPayloadMessages');
    expect(messageRuntimeSource).toContain('enqueueRangeBufferSyncResponse');
    expect(messageRuntimeSource).not.toContain(
      "deps.sendMessage(session, { type: 'buffer-sync', payload });",
    );
    expect(publisherTransportEdge?.publication_lanes).toEqual([
      'live_pending_latest',
      'explicit_range_fifo',
    ]);
  });
});
