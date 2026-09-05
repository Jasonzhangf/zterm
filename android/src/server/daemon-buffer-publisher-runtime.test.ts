import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { BufferSyncRequestPayload } from '@zterm/shared/types';
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
} = {}) {
  return {
    kind: 'ws' as const,
    readyState: options.readyState ?? 1,
    bufferedAmount: options.bufferedAmount ?? 0,
    backpressureCount: 0,
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
