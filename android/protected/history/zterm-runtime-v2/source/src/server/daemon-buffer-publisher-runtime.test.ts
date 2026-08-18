import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
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

function makeSession(id: string, transport = makeTransport()): TerminalSession {
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

    expect(publisherSource).not.toContain("from './terminal-mirror-runtime'");
    expect(publisherSource).not.toContain("from './server'");
    expect(publisherSource).not.toContain("from './terminal-message-runtime'");
    expect(publisherSource).not.toContain("from './daemon-control-gateway-runtime'");
    expect(mirrorRuntimeSource).toContain('createDaemonBufferPublisherRuntime');
    expect(mirrorRuntimeSource).not.toContain('SUBSCRIBER_PENDING_RANGE_LIMIT');
    expect(mirrorRuntimeSource).not.toContain('splitBufferSyncPayloadMessages');
  });
});
