import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalCell } from '../lib/types';
import { buildChangedRangesBufferSyncPayload } from './buffer-sync-contract';
import { findChangedIndexedRanges } from './canonical-buffer';
import { createTerminalMirrorRuntime } from './terminal-mirror-runtime';
import type {
  SessionMirror,
  TerminalSession,
  TerminalSessionTransport,
} from './terminal-runtime-types';

const OPEN = 1;
const CLOSED = 3;

function row(char: string): TerminalCell[] {
  return [{
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  }];
}

function wideRow(seed: number, cols = 120): TerminalCell[] {
  const text = `large-${String(seed).padStart(4, '0')}-`.padEnd(cols, String(seed % 10));
  return Array.from(text).slice(0, cols).map((char) => ({
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  }));
}

function createSession(id: string, bufferedAmount = 0): TerminalSession {
  return {
    id,
    transportId: `transport-${id}`,
    transport: {
      kind: 'ws',
      readyState: OPEN,
      bufferedAmount,
      connectedSent: true,
      sendText: vi.fn(),
      close: vi.fn(),
    },
    sessionName: 'demo',
    mirrorKey: 'demo',
    bodySubscribed: true,
    pendingPasteImage: null,
    pendingAttachFile: null,
  };
}

function createHarness(options?: {
  sessions?: TerminalSession[];
  captures?: TerminalCell[][][];
  changedRanges?: Array<{ startIndex: number; endIndex: number }>;
  captureTrace?: {
    captureStartedAt: number;
    captureDoneAt: number;
    canonicalizeDoneAt: number;
    capturedLineCount: number;
    canonicalLineCount: number;
  };
}) {
  const sessions = new Map<string, TerminalSession>();
  for (const session of options?.sessions || []) {
    sessions.set(session.id, session);
  }
  const mirrors = new Map<string, SessionMirror>();
  const captures = [...(options?.captures || [])];
  const sendText = vi.fn((transport: TerminalSessionTransport | null | undefined, text: string) => {
    transport?.sendText(text);
  });
  const captureMirrorAuthoritativeBufferFromTmux = vi.fn(async (mirror: SessionMirror) => {
    const next = captures.shift();
    if (next) {
      mirror.bufferStartIndex = 0;
      mirror.bufferLines = next;
      mirror.cursor = null;
      mirror.cursorKeysApp = false;
      if (options?.captureTrace) {
        mirror.pendingPerformanceTraceCapture = options.captureTrace;
      }
    }
    return true;
  });
  const recordPerformanceTrace = vi.fn();

  const runtime = createTerminalMirrorRuntime({
    defaultViewport: { cols: 120, rows: 40 },
    sessions,
    mirrors,
    sendMessage: vi.fn(),
    sendText,
    recordPerformanceTrace,
    sendScheduleStateToSession: vi.fn(),
    buildConnectedPayload: (sessionId: string) => ({ sessionId }),
    buildBufferHeadPayload: (sessionId: string, mirror: SessionMirror) => ({
      sessionId,
      revision: mirror.revision,
      latestEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
      availableStartIndex: mirror.bufferStartIndex,
      availableEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
      cursorKeysApp: mirror.cursorKeysApp,
      cursor: mirror.cursor,
    }),
    buildChangedRangesBufferSyncPayload: (mirror, changedRanges) =>
      buildChangedRangesBufferSyncPayload(mirror, changedRanges),
    sanitizeSessionName: (value?: string) => value?.trim() || 'demo',
    getMirrorKey: (sessionName: string) => sessionName,
    normalizeTerminalCols: (cols?: number) => cols || 120,
    normalizeTerminalRows: (rows?: number) => rows || 40,
    resolveAttachGeometry: ({
      requestedGeometry,
      currentMirrorGeometry,
      existingTmuxGeometry,
      previousSessionGeometry,
    }) => requestedGeometry || currentMirrorGeometry || existingTmuxGeometry || previousSessionGeometry,
    readTmuxPaneMetrics: () => ({
      paneId: '%1',
      tmuxAvailableLineCountHint: 0,
      paneRows: 40,
      paneCols: 120,
      alternateOn: false,
    }),
    assertTmuxSessionExists: vi.fn(),
    captureMirrorAuthoritativeBufferFromTmux,
    mirrorBufferChanged: (mirror, previousStartIndex, previousLines) => (
      options?.changedRanges
      || findChangedIndexedRanges({
        previousStartIndex,
        previousLines,
        nextStartIndex: mirror.bufferStartIndex,
        nextLines: mirror.bufferLines,
      })
    ),
    mirrorCursorEqual: () => true,
    writeToLiveMirror: () => true,
    enqueueLiveMirrorInput: async () => true,
    disposeLiveMirrorInputBatch: () => 0,
    writeToTmuxSession: vi.fn(),
    autoCommandDelayMs: 0,
    waitMs: async () => {},
    logTimePrefix: () => '2026-07-13 16:00:00',
    runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    closeTransportSubscriber: vi.fn(),
    getSessionMirror: (session: TerminalSession) => (
      session.mirrorKey ? mirrors.get(session.mirrorKey) || null : null
    ),
  });
  const mirror = runtime.createMirror('demo');
  mirror.lifecycle = 'ready';
  for (const session of sessions.values()) {
    mirror.subscribers.add(session.id);
  }
  return {
    runtime,
    mirror,
    sendText,
    captureMirrorAuthoritativeBufferFromTmux,
    recordPerformanceTrace,
  };
}

function parseLastBufferSync(session: TerminalSession) {
  const mock = session.transport?.sendText as ReturnType<typeof vi.fn>;
  const lastCall = mock.mock.calls[mock.mock.calls.length - 1];
  const lastText = lastCall?.[0] as string | undefined;
  return lastText ? JSON.parse(lastText) : null;
}

function parseBufferSyncMessages(session: TerminalSession) {
  const mock = session.transport?.sendText as ReturnType<typeof vi.fn>;
  return mock.mock.calls.map((call) => JSON.parse(call[0] as string));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('terminal mirror per-subscriber latest-authoritative backpressure', () => {
  it('records capture, canonicalize, and mirror-commit trace stages with the committed subscriber revision identity', async () => {
    const subscriber = createSession('subscriber-1');
    const { runtime, mirror, recordPerformanceTrace } = createHarness({
      sessions: [subscriber],
      captures: [[row('a'), row('b')]],
      captureTrace: {
        captureStartedAt: 10,
        captureDoneAt: 18,
        canonicalizeDoneAt: 23,
        capturedLineCount: 2,
        canonicalLineCount: 2,
      },
    });

    await runtime.syncMirrorCanonicalBuffer(mirror);

    expect(recordPerformanceTrace).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'subscriber-1',
      traceId: 'subscriber-1:1',
      mirrorRevision: 1,
      subscriberId: 'subscriber-1',
      stage: 'capture-start',
      at: 10,
      lineCount: 2,
    }));
    expect(recordPerformanceTrace).toHaveBeenCalledWith(expect.objectContaining({
      traceId: 'subscriber-1:1',
      mirrorRevision: 1,
      stage: 'capture-done',
      at: 18,
    }));
    expect(recordPerformanceTrace).toHaveBeenCalledWith(expect.objectContaining({
      traceId: 'subscriber-1:1',
      mirrorRevision: 1,
      stage: 'canonicalize-done',
      at: 23,
    }));
    expect(recordPerformanceTrace).toHaveBeenCalledWith(expect.objectContaining({
      traceId: 'subscriber-1:1',
      mirrorRevision: 1,
      stage: 'mirror-commit',
      lineCount: 2,
    }));
    expect(JSON.stringify(recordPerformanceTrace.mock.calls)).not.toContain('payload');
    expect(JSON.stringify(recordPerformanceTrace.mock.calls)).not.toContain('cells');
  });

  it('keeps one bounded pending latest for the slow subscriber while healthy sends every revision', async () => {
    const healthy = createSession('healthy');
    const slow = createSession('slow', 256_000);
    const { runtime, mirror } = createHarness({
      sessions: [healthy, slow],
      captures: [
        [row('a'), row('b')],
        [row('A'), row('b'), row('c')],
      ],
    });

    await runtime.syncMirrorCanonicalBuffer(mirror);
    await runtime.syncMirrorCanonicalBuffer(mirror);

    expect(healthy.transport?.sendText).toHaveBeenCalledTimes(2);
    expect(slow.transport?.sendText).not.toHaveBeenCalled();
    expect(slow.bufferSyncState).toMatchObject({
      lastSentRevision: 0,
      pendingLatestRevision: 2,
      pendingSince: expect.any(Number),
      pendingTransportId: slow.transportId,
      resyncRequired: false,
    });
    expect(slow.bufferSyncState?.pendingChangedAbsoluteRanges.length).toBeGreaterThan(0);
    expect(slow.bufferSyncState).not.toHaveProperty('payload');
    expect(slow.bufferSyncState).not.toHaveProperty('text');
    expect(slow.bufferSyncState).not.toHaveProperty('lines');
    expect(slow.bufferSyncState).not.toHaveProperty('cells');
  });

  it('does not send or queue unsolicited body bytes for an unsubscribed physical subscriber', async () => {
    const inactive = createSession('inactive');
    inactive.bodySubscribed = false;
    const { runtime, mirror } = createHarness({
      sessions: [inactive],
      captures: [[row('a')], [row('b')]],
    });

    await runtime.syncMirrorCanonicalBuffer(mirror);
    await runtime.syncMirrorCanonicalBuffer(mirror);

    expect(inactive.transport?.sendText).not.toHaveBeenCalled();
    expect(inactive.bufferSyncState).toBeUndefined();
    expect(inactive.transport?.readyState).toBe(OPEN);
  });

  it('does not run recurring live capture when every physical subscriber is body-unsubscribed', async () => {
    vi.useFakeTimers();
    const inactive = createSession('inactive');
    inactive.bodySubscribed = false;
    const { runtime, mirror, captureMirrorAuthoritativeBufferFromTmux } = createHarness({
      sessions: [inactive],
      captures: [[row('a')]],
    });

    runtime.scheduleMirrorLiveSync(mirror, 0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runOnlyPendingTimersAsync();

    expect(captureMirrorAuthoritativeBufferFromTmux).not.toHaveBeenCalled();
    expect(mirror.liveSyncTimer).toBeNull();
    expect(inactive.transport?.readyState).toBe(OPEN);
  });

  it('uses high/low hysteresis and flushes current mirror truth only after crossing low water', async () => {
    const slow = createSession('slow', 256_000);
    const { runtime, mirror } = createHarness({
      sessions: [slow],
      captures: [[row('a')], [row('Z'), row('b')]],
    });

    await runtime.syncMirrorCanonicalBuffer(mirror);
    await runtime.syncMirrorCanonicalBuffer(mirror);

    expect(slow.bufferSyncState?.pendingLatestRevision).toBe(2);
    slow.transport!.bufferedAmount = 96_000;
    expect(runtime.flushPendingSubscriberBufferSync(mirror, slow.id)).toBe('backpressured');
    expect(slow.transport?.sendText).not.toHaveBeenCalled();

    slow.transport!.bufferedAmount = 32_000;
    expect(runtime.flushPendingSubscriberBufferSync(mirror, slow.id)).toBe('sent');

    const message = parseLastBufferSync(slow);
    expect(message).toMatchObject({
      type: 'buffer-sync',
      payload: {
        revision: 2,
        availableStartIndex: 0,
        availableEndIndex: 2,
      },
    });
    expect(message.payload.lines.map((line: { i?: number; index?: number }) => line.i ?? line.index)).toEqual([0, 1]);
    expect(slow.bufferSyncState).toMatchObject({
      lastSentRevision: 2,
      pendingLatestRevision: null,
      pendingChangedAbsoluteRanges: [],
      pendingSince: 0,
      resyncRequired: false,
    });
  });

  it('splits oversized body refreshes into contiguous chunks instead of falling back to live tail', async () => {
    const subscriber = createSession('subscriber');
    const lines = Array.from({ length: 1_600 }, (_, index) => wideRow(index));
    const { runtime, mirror } = createHarness({
      sessions: [subscriber],
      captures: [lines],
      changedRanges: [{ startIndex: 0, endIndex: lines.length }],
    });

    await runtime.syncMirrorCanonicalBuffer(mirror);

    const messages = parseBufferSyncMessages(subscriber);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.type === 'buffer-sync')).toBe(true);
    expect(messages.every((message) => message.payload.revision === 1)).toBe(true);
    expect(messages.every((message) => message.payload.availableStartIndex === 0)).toBe(true);
    expect(messages.every((message) => message.payload.availableEndIndex === lines.length)).toBe(true);
    expect(messages.every((message) => message.payload.frameStartIndex === 0)).toBe(true);
    expect(messages.every((message) => message.payload.frameEndIndex === lines.length)).toBe(true);
    expect(messages.every((message) => message.payload.frameChunkCount === messages.length)).toBe(true);
    expect(messages.map((message) => message.payload.frameChunkIndex)).toEqual(
      messages.map((_, index) => index),
    );

    const sentIndexes = messages.flatMap((message) => (
      message.payload.lines.map((line: { i?: number; index?: number }) => line.i ?? line.index)
    ));
    expect(sentIndexes).toEqual(Array.from({ length: lines.length }, (_, index) => index));
    expect(messages[0]!.payload.startIndex).toBe(0);
    expect(messages[messages.length - 1]!.payload.endIndex).toBe(lines.length);
    for (let index = 1; index < messages.length; index += 1) {
      expect(messages[index]!.payload.startIndex).toBe(messages[index - 1]!.payload.endIndex);
    }
    for (const call of (subscriber.transport?.sendText as ReturnType<typeof vi.fn>).mock.calls) {
      expect(Buffer.byteLength(call[0] as string, 'utf8')).toBeLessThanOrEqual(128_000);
    }
    expect(subscriber.bufferSyncState).toMatchObject({
      lastSentRevision: 1,
      pendingLatestRevision: null,
      pendingChangedAbsoluteRanges: [],
      resyncRequired: false,
    });
  });

  it('retains pending truth on send failure and succeeds on a later drain', async () => {
    const slow = createSession('slow', 256_000);
    const { runtime, mirror } = createHarness({
      sessions: [slow],
      captures: [[row('a')]],
    });

    await runtime.syncMirrorCanonicalBuffer(mirror);
    slow.transport!.bufferedAmount = 0;
    slow.transport!.sendText = vi.fn(() => {
      throw new Error('slow transport send failed');
    });

    expect(runtime.flushPendingSubscriberBufferSync(mirror, slow.id)).toBe('send-error');
    expect(slow.bufferSyncState).toMatchObject({
      lastSentRevision: 0,
      pendingLatestRevision: 1,
    });

    slow.transport!.sendText = vi.fn();
    expect(runtime.flushPendingSubscriberBufferSync(mirror, slow.id)).toBe('sent');
    expect(slow.bufferSyncState).toMatchObject({
      lastSentRevision: 1,
      pendingLatestRevision: null,
    });
  });

  it('retains pending truth for non-open transport and stale transport generation', async () => {
    const slow = createSession('slow', 256_000);
    const { runtime, mirror } = createHarness({
      sessions: [slow],
      captures: [[row('a')]],
    });

    await runtime.syncMirrorCanonicalBuffer(mirror);
    slow.transport!.bufferedAmount = 0;
    slow.transport!.readyState = CLOSED;
    expect(runtime.flushPendingSubscriberBufferSync(mirror, slow.id)).toBe('transport-not-open');
    expect(slow.bufferSyncState?.pendingLatestRevision).toBe(1);

    slow.transport!.readyState = OPEN;
    slow.transportId = 'transport-slow-rebound';
    expect(runtime.flushPendingSubscriberBufferSync(mirror, slow.id)).toBe('stale-transport');
    expect(slow.bufferSyncState).toMatchObject({
      lastSentRevision: 0,
      pendingLatestRevision: 1,
      resyncRequired: true,
      resyncReason: 'transport-generation',
    });
  });

  it('enters explicit full resync truth when pending range count exceeds the hard limit', async () => {
    const slow = createSession('slow', 256_000);
    const changedRanges = Array.from({ length: 65 }, (_, index) => ({
      startIndex: index * 2,
      endIndex: index * 2 + 1,
    }));
    const lines = Array.from({ length: 130 }, (_, index) => row(String.fromCharCode(65 + (index % 26))));
    const { runtime, mirror } = createHarness({
      sessions: [slow],
      captures: [lines],
      changedRanges,
    });

    await runtime.syncMirrorCanonicalBuffer(mirror);

    expect(slow.bufferSyncState).toMatchObject({
      pendingLatestRevision: 1,
      pendingChangedAbsoluteRanges: [{ startIndex: 0, endIndex: 130 }],
      resyncRequired: true,
      resyncReason: 'range-count',
    });
  });

  it('enters explicit full resync truth when pending span or age exceeds its hard limit', async () => {
    const spanSlow = createSession('span-slow', 256_000);
    const spanLines = Array.from({ length: 4_100 }, () => row('x'));
    const spanHarness = createHarness({
      sessions: [spanSlow],
      captures: [spanLines],
      changedRanges: [
        { startIndex: 0, endIndex: 1 },
        { startIndex: 4_099, endIndex: 4_100 },
      ],
    });

    await spanHarness.runtime.syncMirrorCanonicalBuffer(spanHarness.mirror);
    expect(spanSlow.bufferSyncState).toMatchObject({
      pendingChangedAbsoluteRanges: [{ startIndex: 0, endIndex: 4_100 }],
      resyncRequired: true,
      resyncReason: 'span-lines',
    });

    const ageSlow = createSession('age-slow', 256_000);
    const ageHarness = createHarness({
      sessions: [ageSlow],
      captures: [[row('a')]],
    });
    await ageHarness.runtime.syncMirrorCanonicalBuffer(ageHarness.mirror);
    ageSlow.bufferSyncState!.pendingSince = Date.now() - 30_000;

    expect(ageHarness.runtime.flushPendingSubscriberBufferSync(ageHarness.mirror, ageSlow.id)).toBe('backpressured');
    expect(ageSlow.bufferSyncState).toMatchObject({
      pendingChangedAbsoluteRanges: [{ startIndex: 0, endIndex: 1 }],
      resyncRequired: true,
      resyncReason: 'age',
    });
  });

  it('flushes the final pending revision from the live tick after output stops', async () => {
    vi.useFakeTimers();
    const slow = createSession('slow', 256_000);
    const { runtime, mirror } = createHarness({
      sessions: [slow],
      captures: [[row('a')]],
    });

    await runtime.syncMirrorCanonicalBuffer(mirror);
    expect(slow.bufferSyncState?.pendingLatestRevision).toBe(1);

    slow.transport!.bufferedAmount = 0;
    runtime.scheduleMirrorLiveSync(mirror, 0);
    await vi.advanceTimersByTimeAsync(1);
    mirror.lifecycle = 'idle';
    await vi.runOnlyPendingTimersAsync();

    expect(slow.transport?.sendText).toHaveBeenCalledTimes(1);
    expect(slow.bufferSyncState).toMatchObject({
      lastSentRevision: 1,
      pendingLatestRevision: null,
    });
  });
});
