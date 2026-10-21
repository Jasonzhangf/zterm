import { describe, expect, it, vi } from 'vitest';
import type {
  TerminalBufferPayload,
  TerminalCell,
} from '@zterm/shared/types';
import type {
  TerminalSnapshotRequestPayload,
  TerminalSnapshotResultPayload,
} from '@zterm/shared/protocol';
import {
  buildBufferHeadPayload,
  buildRequestedRangeBufferPayload,
} from './buffer-sync-contract';
import type {
  ResolvedTerminalSession,
  TerminalSessionIdentityResolution,
} from './terminal-source-adapter';
import type { SessionMirror } from './terminal-runtime-types';
import { createTerminalSnapshotReadRuntime } from './terminal-snapshot-read-runtime';

const STABLE_ID = 'tmux:v1:opaque-snapshot-id';

function row(text: string): TerminalCell[] {
  return Array.from(text).map((char) => ({
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  }));
}

function createMirror(overrides: Partial<SessionMirror> = {}): SessionMirror {
  return {
    key: 'tmux:work',
    sessionName: 'work',
    backend: 'tmux',
    scratchBridge: null,
    lifecycle: 'ready',
    cols: 80,
    rows: 24,
    baselineCols: 80,
    baselineRows: 24,
    consecutiveFailures: 0,
    cursorKeysApp: false,
    revision: 7,
    lastScrollbackCount: 0,
    bufferStartIndex: 100,
    bufferLines: [row('zero'), row('one'), row('two')],
    cursor: { rowIndex: 2, col: 3, visible: true },
    lastFlushStartedAt: 0,
    lastFlushCompletedAt: 0,
    lastLiveActivityAt: 0,
    lastHeadBroadcastAt: 0,
    flushInFlight: false,
    flushPromise: null,
    quietFlushStreak: 0,
    lastFlushHadContentChanges: false,
    pendingStableCaptureSnapshot: null,
    pendingPerformanceTraceCapture: null,
    adaptiveWidthBaselineGeometry: null,
    adaptiveWidthAppliedCols: null,
    adaptiveWidthAppliedRows: null,
    adaptiveWidthLeaseTimer: null,
    liveSyncTimer: null,
    subscribers: new Set(),
    ...overrides,
  };
}

function resolvedSession(): ResolvedTerminalSession {
  return {
    identity: {
      backend: 'tmux',
      sessionName: 'work',
      stableId: STABLE_ID,
    },
    target: {
      backend: 'tmux',
      sessionName: 'work',
      stableId: STABLE_ID,
      socketPath: '/tmp/zterm-test.sock',
      serverPid: '1',
      sessionId: '$1',
      createdAt: 1,
    },
  };
}

function request(overrides: Partial<TerminalSnapshotRequestPayload> = {}): TerminalSnapshotRequestPayload {
  return {
    version: 1,
    backend: 'tmux',
    stableId: STABLE_ID,
    maxLines: 2,
    ...overrides,
  };
}

function createNoWriteSpies() {
  return {
    attach: vi.fn(),
    capture: vi.fn(),
    resize: vi.fn(),
    input: vi.fn(),
    createSession: vi.fn(),
    scheduler: vi.fn(),
  };
}

function expectNoWriteCalls(spies: ReturnType<typeof createNoWriteSpies>) {
  for (const spy of Object.values(spies)) {
    expect(spy).not.toHaveBeenCalled();
  }
}

function lineIndexes(body: TerminalBufferPayload): number[] {
  return body.lines.map((line) => ('i' in line ? line.i : line.index));
}

describe('createTerminalSnapshotReadRuntime', () => {
  it('returns one ready mirror revision as the immutable tail body and sends the typed result once', () => {
    const mirror = createMirror();
    const resolved = resolvedSession();
    const sent: TerminalSnapshotResultPayload[] = [];
    const writeSpies = createNoWriteSpies();
    const resolveExistingSession = vi.fn(() => ({
      ok: true,
      session: resolved,
    } satisfies TerminalSessionIdentityResolution));
    const readExistingMirror = vi.fn(() => mirror);
    const buildHead = vi.fn(buildBufferHeadPayload);
    const buildBody = vi.fn(buildRequestedRangeBufferPayload);
    const sendSnapshotResult = vi.fn((result: TerminalSnapshotResultPayload) => {
      sent.push(result);
    });
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession,
      readExistingMirror,
      buildBufferHeadPayload: buildHead,
      buildRequestedRangeBufferPayload: buildBody,
      sendSnapshotResult,
      ...writeSpies,
    });

    const result = runtime.handleRequest(request());

    expect(result).toEqual(sent[0]);
    expect(sendSnapshotResult).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.backend).toBe('tmux');
    expect(result.stableId).toBe(STABLE_ID);
    expect(result.head).toMatchObject({
      sessionId: STABLE_ID,
      revision: 7,
      availableStartIndex: 100,
      availableEndIndex: 103,
      cursor: { rowIndex: 2, col: 3, visible: true },
    });
    expect(result.body).toMatchObject({
      revision: 7,
      startIndex: 101,
      endIndex: 103,
      availableStartIndex: 100,
      availableEndIndex: 103,
      cols: 80,
      rows: 24,
    });
    expect(lineIndexes(result.body)).toEqual([101, 102]);
    expect(buildHead).toHaveBeenCalledTimes(1);
    expect(buildBody).toHaveBeenCalledTimes(1);
    expect(buildHead.mock.calls[0]![1]).toBe(buildBody.mock.calls[0]![0]);
    expect(buildHead.mock.calls[0]![1]).not.toBe(mirror);
    expect(readExistingMirror).toHaveBeenCalledWith(resolved);
    expectNoWriteCalls(writeSpies);
  });

  it('keeps the response value independent from later mirror mutation', () => {
    const mirror = createMirror();
    const sent: TerminalSnapshotResultPayload[] = [];
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession: () => ({ ok: true, session: resolvedSession() }),
      readExistingMirror: () => mirror,
      buildBufferHeadPayload: buildBufferHeadPayload,
      buildRequestedRangeBufferPayload: buildRequestedRangeBufferPayload,
      sendSnapshotResult: (result) => {
        sent.push(result);
      },
    });

    const result = runtime.handleRequest(request());
    mirror.revision = 99;
    mirror.bufferStartIndex = 900;
    mirror.bufferLines[2]![0]!.char = 'X'.codePointAt(0)!;
    mirror.cursor!.col = 77;

    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result).toBe(sent[0]);
    expect(result.head.revision).toBe(7);
    expect(result.body.revision).toBe(7);
    expect(result.head.availableStartIndex).toBe(100);
    expect(result.body.startIndex).toBe(101);
    expect(result.body.lines).toEqual([
      expect.objectContaining({ i: 101, t: 'one' }),
      expect.objectContaining({ i: 102, t: 'two' }),
    ]);
    expect(result.head.cursor).toEqual({ rowIndex: 2, col: 3, visible: true });
    expect(result.body.cursor).toEqual({ rowIndex: 2, col: 3, visible: true });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.body)).toBe(true);
    expect(Object.isFrozen(result.body.lines)).toBe(true);
  });

  it('returns mirror_not_present without creating or capturing a mirror', () => {
    const writeSpies = createNoWriteSpies();
    const buildHead = vi.fn(buildBufferHeadPayload);
    const buildBody = vi.fn(buildRequestedRangeBufferPayload);
    const sent: TerminalSnapshotResultPayload[] = [];
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession: () => ({ ok: true, session: resolvedSession() }),
      readExistingMirror: () => undefined,
      buildBufferHeadPayload: buildHead,
      buildRequestedRangeBufferPayload: buildBody,
      sendSnapshotResult: (result) => {
        sent.push(result);
      },
      ...writeSpies,
    });

    const result = runtime.handleRequest(request());

    expect(result).toEqual({ status: 'unavailable', reason: 'mirror_not_present' });
    expect(sent).toEqual([result]);
    expect(buildHead).not.toHaveBeenCalled();
    expect(buildBody).not.toHaveBeenCalled();
    expectNoWriteCalls(writeSpies);
  });

  it('returns mirror_not_ready without serializing or starting capture', () => {
    const mirror = createMirror({ lifecycle: 'booting' });
    const writeSpies = createNoWriteSpies();
    const buildHead = vi.fn(buildBufferHeadPayload);
    const buildBody = vi.fn(buildRequestedRangeBufferPayload);
    const sent: TerminalSnapshotResultPayload[] = [];
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession: () => ({ ok: true, session: resolvedSession() }),
      readExistingMirror: () => mirror,
      buildBufferHeadPayload: buildHead,
      buildRequestedRangeBufferPayload: buildBody,
      sendSnapshotResult: (result) => {
        sent.push(result);
      },
      ...writeSpies,
    });

    const result = runtime.handleRequest(request());

    expect(result).toEqual({ status: 'unavailable', reason: 'mirror_not_ready' });
    expect(sent).toEqual([result]);
    expect(buildHead).not.toHaveBeenCalled();
    expect(buildBody).not.toHaveBeenCalled();
    expectNoWriteCalls(writeSpies);
  });

  it.each([
    'session_not_found',
    'session_identity_mismatch',
  ] as const)('returns failed %s without reading a different mirror', (code) => {
    const readExistingMirror = vi.fn();
    const buildHead = vi.fn(buildBufferHeadPayload);
    const buildBody = vi.fn(buildRequestedRangeBufferPayload);
    const sent: TerminalSnapshotResultPayload[] = [];
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession: () => ({
        ok: false,
        code,
        message: code,
      }),
      readExistingMirror,
      buildBufferHeadPayload: buildHead,
      buildRequestedRangeBufferPayload: buildBody,
      sendSnapshotResult: (result) => {
        sent.push(result);
      },
    });

    const result = runtime.handleRequest(request());

    expect(result).toEqual({ status: 'failed', code });
    expect(sent).toEqual([result]);
    expect(readExistingMirror).not.toHaveBeenCalled();
    expect(buildHead).not.toHaveBeenCalled();
    expect(buildBody).not.toHaveBeenCalled();
  });

  it.each([
    { maxLines: 1, expectedIndexes: [102] },
    { maxLines: 3, expectedIndexes: [100, 101, 102] },
    { maxLines: Number.MAX_SAFE_INTEGER, expectedIndexes: [100, 101, 102] },
  ])('clamps maxLines=$maxLines to the legal positive wire range and mirror tail', ({
    maxLines,
    expectedIndexes,
  }) => {
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession: () => ({ ok: true, session: resolvedSession() }),
      readExistingMirror: () => createMirror(),
      buildBufferHeadPayload: buildBufferHeadPayload,
      buildRequestedRangeBufferPayload: buildRequestedRangeBufferPayload,
      sendSnapshotResult: vi.fn(),
    });

    const result = runtime.handleRequest(request({ maxLines }));

    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(lineIndexes(result.body)).toEqual(expectedIndexes);
  });
});
