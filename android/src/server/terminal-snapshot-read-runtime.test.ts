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
  TerminalSourceMirrorSnapshot,
} from './terminal-source-adapter';
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

function snapshot(
  overrides: Partial<TerminalSourceMirrorSnapshot> = {},
): TerminalSourceMirrorSnapshot {
  return {
    revision: 7,
    bufferStartIndex: 100,
    bufferLines: [row('zero'), row('one'), row('two')],
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    cursor: { rowIndex: 2, col: 3, visible: true },
    capturedLineCount: 3,
    canonicalLineCount: 3,
    totalAvailableLines: 103,
    visibleTopIndex: 100,
    ...overrides,
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

function lineIndexes(body: TerminalBufferPayload): number[] {
  return body.lines.map((line) => ('i' in line ? line.i : line.index));
}

function bodyText(body: TerminalBufferPayload): string {
  return body.lines
    .map((line) => ('t' in line ? line.t : ''))
    .join('|');
}

describe('createTerminalSnapshotReadRuntime', () => {
  it('captures one fresh detached frame and serializes head and body from the same revision', async () => {
    const resolved = resolvedSession();
    const captured = snapshot();
    const sent: TerminalSnapshotResultPayload[] = [];
    const resolveExistingSession = vi.fn(() => ({
      ok: true,
      session: resolved,
    } satisfies TerminalSessionIdentityResolution));
    const captureSessionSnapshot = vi.fn(async () => captured);
    const buildHead = vi.fn(buildBufferHeadPayload);
    const buildBody = vi.fn(buildRequestedRangeBufferPayload);
    const sendSnapshotResult = vi.fn((result: TerminalSnapshotResultPayload) => {
      sent.push(result);
    });
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession,
      captureSessionSnapshot,
      buildBufferHeadPayload: buildHead,
      buildRequestedRangeBufferPayload: buildBody,
      sendSnapshotResult,
    });

    const result = await runtime.handleRequest(request());

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
    expect(buildHead.mock.calls[0]![1]).not.toBe(captured);
    expect(captureSessionSnapshot).toHaveBeenCalledWith(resolved);
    expect(resolveExistingSession).toHaveBeenCalledTimes(2);
  });

  it('captures a fresh frame even when a live mirror would be absent or stale', async () => {
    const sent: TerminalSnapshotResultPayload[] = [];
    const captureSessionSnapshot = vi.fn(async () => snapshot({
      bufferLines: [row('fresh-source-line')],
      bufferStartIndex: 40,
      revision: 11,
    }));
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession: () => ({ ok: true, session: resolvedSession() }),
      captureSessionSnapshot,
      buildBufferHeadPayload: buildBufferHeadPayload,
      buildRequestedRangeBufferPayload: buildRequestedRangeBufferPayload,
      sendSnapshotResult: (result) => {
        sent.push(result);
      },
    });

    const result = await runtime.handleRequest(request({ maxLines: 1 }));

    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(bodyText(result.body)).toBe('fresh-source-line');
    expect(captureSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([result]);
  });

  it('returns newly captured source content on each repeated preview request', async () => {
    const markers = [row('preview-marker-old'), row('preview-marker-new')];
    const captureSessionSnapshot = vi
      .fn(async (_session: ResolvedTerminalSession) => snapshot())
      .mockResolvedValueOnce(snapshot({ bufferLines: [markers[0]!] }))
      .mockResolvedValueOnce(snapshot({ bufferLines: [markers[1]!] }));
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession: () => ({ ok: true, session: resolvedSession() }),
      captureSessionSnapshot,
      buildBufferHeadPayload: buildBufferHeadPayload,
      buildRequestedRangeBufferPayload: buildRequestedRangeBufferPayload,
      sendSnapshotResult: vi.fn(),
    });

    const first = await runtime.handleRequest(request({ maxLines: 1 }));
    const second = await runtime.handleRequest(request({ maxLines: 1 }));

    expect(captureSessionSnapshot).toHaveBeenCalledTimes(2);
    expect(first.status).toBe('available');
    expect(second.status).toBe('available');
    if (first.status !== 'available' || second.status !== 'available') return;
    expect(bodyText(first.body)).toBe('preview-marker-old');
    expect(bodyText(second.body)).toBe('preview-marker-new');
  });

  it.each([
    'session_not_found',
    'session_identity_mismatch',
  ] as const)('rejects a target that changes during capture with %s before publishing', async (code) => {
    let resolutionCount = 0;
    const captureSessionSnapshot = vi.fn(async () => snapshot({ bufferLines: [row('replacement-content')] }));
    const buildHead = vi.fn(buildBufferHeadPayload);
    const buildBody = vi.fn(buildRequestedRangeBufferPayload);
    const sent: TerminalSnapshotResultPayload[] = [];
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession: () => {
        resolutionCount += 1;
        return resolutionCount === 1
          ? { ok: true, session: resolvedSession() }
          : { ok: false, code, message: code };
      },
      captureSessionSnapshot,
      buildBufferHeadPayload: buildHead,
      buildRequestedRangeBufferPayload: buildBody,
      sendSnapshotResult: (result) => {
        sent.push(result);
      },
    });

    const result = await runtime.handleRequest(request());

    expect(result).toEqual({ status: 'failed', code });
    expect(sent).toEqual([result]);
    expect(captureSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(buildHead).not.toHaveBeenCalled();
    expect(buildBody).not.toHaveBeenCalled();
  });

  it('does not capture when the pre-read identity resolution fails', async () => {
    const captureSessionSnapshot = vi.fn(async () => snapshot());
    const buildHead = vi.fn(buildBufferHeadPayload);
    const buildBody = vi.fn(buildRequestedRangeBufferPayload);
    const sent: TerminalSnapshotResultPayload[] = [];
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession: () => ({
        ok: false,
        code: 'session_not_found',
        message: 'gone',
      }),
      captureSessionSnapshot,
      buildBufferHeadPayload: buildHead,
      buildRequestedRangeBufferPayload: buildBody,
      sendSnapshotResult: (result) => {
        sent.push(result);
      },
    });

    const result = await runtime.handleRequest(request());

    expect(result).toEqual({ status: 'failed', code: 'session_not_found' });
    expect(sent).toEqual([result]);
    expect(captureSessionSnapshot).not.toHaveBeenCalled();
    expect(buildHead).not.toHaveBeenCalled();
    expect(buildBody).not.toHaveBeenCalled();
  });

  it('propagates capture rejection so the message owner sends one explicit failure', async () => {
    const sent: TerminalSnapshotResultPayload[] = [];
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession: () => ({ ok: true, session: resolvedSession() }),
      captureSessionSnapshot: async () => {
        throw new Error('fresh capture failed');
      },
      buildBufferHeadPayload: buildBufferHeadPayload,
      buildRequestedRangeBufferPayload: buildRequestedRangeBufferPayload,
      sendSnapshotResult: (result) => {
        sent.push(result);
      },
    });

    await expect(runtime.handleRequest(request())).rejects.toThrow('fresh capture failed');
    expect(sent).toEqual([]);
  });

  it('keeps the response independent from later mutation of the captured source frame', async () => {
    const captured = snapshot();
    const sent: TerminalSnapshotResultPayload[] = [];
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession: () => ({ ok: true, session: resolvedSession() }),
      captureSessionSnapshot: async () => captured,
      buildBufferHeadPayload: buildBufferHeadPayload,
      buildRequestedRangeBufferPayload: buildRequestedRangeBufferPayload,
      sendSnapshotResult: (result) => {
        sent.push(result);
      },
    });

    const result = await runtime.handleRequest(request());
    captured.revision = 99;
    captured.bufferStartIndex = 900;
    captured.bufferLines[2]![0]!.char = 'X'.codePointAt(0)!;
    captured.cursor!.col = 77;

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

  it.each([
    { maxLines: 1, expectedIndexes: [102] },
    { maxLines: 3, expectedIndexes: [100, 101, 102] },
    { maxLines: Number.MAX_SAFE_INTEGER, expectedIndexes: [100, 101, 102] },
  ])('clamps maxLines=$maxLines to the legal positive wire range and captured tail', async ({
    maxLines,
    expectedIndexes,
  }) => {
    const runtime = createTerminalSnapshotReadRuntime({
      resolveExistingSession: () => ({ ok: true, session: resolvedSession() }),
      captureSessionSnapshot: async () => snapshot(),
      buildBufferHeadPayload: buildBufferHeadPayload,
      buildRequestedRangeBufferPayload: buildRequestedRangeBufferPayload,
      sendSnapshotResult: vi.fn(),
    });

    const result = await runtime.handleRequest(request({ maxLines }));

    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(lineIndexes(result.body)).toEqual(expectedIndexes);
  });
});
