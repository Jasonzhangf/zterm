import { describe, expect, it, vi } from 'vitest';
import { createTerminalMirrorRuntime } from './terminal-mirror-runtime';
import { buildChangedRangesBufferSyncPayload } from './buffer-sync-contract';
import type { TerminalSession, SessionMirror } from './terminal-runtime-types';
import { findChangedIndexedRanges } from './canonical-buffer';

function createSession(id = 'session-1'): TerminalSession {
  return {
    id,
    transportId: 'transport-1',
    transport: {
      kind: 'ws',
      readyState: 1,
      requestOrigin: 'http://127.0.0.1:3333',
      connectedSent: false,
      sendText: vi.fn(),
      close: vi.fn(),
    },
    closeTransport: vi.fn(),
    sessionName: 'demo',
    mirrorKey: null,
    pendingPasteImage: null,
    pendingAttachFile: null,
  };
}

function createRuntime() {
  const sessions = new Map<string, TerminalSession>();
  const mirrors = new Map<string, SessionMirror>();
  const ensureTmuxSession = vi.fn();
  const captureMirrorAuthoritativeBufferFromTmux = vi.fn(async (mirror: SessionMirror) => {
    mirror.bufferLines = [];
    mirror.bufferStartIndex = 0;
    mirror.cursor = null;
    mirror.cursorKeysApp = false;
    return true;
  });
  const sendMessage = vi.fn();
  const sendScheduleStateToSession = vi.fn();

  const runtime = createTerminalMirrorRuntime({
    defaultViewport: { cols: 120, rows: 40 },
    sessions,
    mirrors,
    sendMessage,
    sendScheduleStateToSession,
    buildConnectedPayload: (sessionId: string) => ({ sessionId }),
    buildBufferHeadPayload: () => ({
      sessionId: 'session-1',
      revision: 1,
      latestEndIndex: 0,
      availableStartIndex: 0,
      availableEndIndex: 0,
      cursor: null,
    }),
    buildChangedRangesBufferSyncPayload: (mirror, changedRanges) => buildChangedRangesBufferSyncPayload(mirror, changedRanges),
    sanitizeSessionName: (input?: string) => input?.trim() || 'demo',
    getMirrorKey: (sessionName: string) => sessionName,
    normalizeTerminalCols: (cols?: number) => cols || 120,
    normalizeTerminalRows: (rows?: number) => rows || 40,
    resolveAttachGeometry: ({ requestedGeometry, currentMirrorGeometry, existingTmuxGeometry, previousSessionGeometry }) =>
      requestedGeometry || currentMirrorGeometry || existingTmuxGeometry || previousSessionGeometry,
    readTmuxPaneMetrics: () => ({
      paneId: '%1',
      tmuxAvailableLineCountHint: 0,
      paneRows: 40,
      paneCols: 120,
      alternateOn: false,
    }),
    ensureTmuxSession,
    captureMirrorAuthoritativeBufferFromTmux,
    mirrorBufferChanged: () => [],
    mirrorCursorEqual: () => true,
    writeToLiveMirror: () => true,
    writeToTmuxSession: vi.fn(),
    autoCommandDelayMs: 0,
    waitMs: async () => {},
    logTimePrefix: () => '2026-05-01 00:00:00',
    closeLogicalTerminalSession: vi.fn(),
    getSessionMirror: (session: TerminalSession) => (session.mirrorKey ? mirrors.get(session.mirrorKey) || null : null),
  });

  return {
    runtime,
    sessions,
    mirrors,
    ensureTmuxSession,
    captureMirrorAuthoritativeBufferFromTmux,
    sendMessage,
    sendScheduleStateToSession,
  };
}

describe('terminal mirror runtime lifecycle truth', () => {
  it('creates new mirrors as idle so attach can boot them exactly once', async () => {
    const { runtime, mirrors } = createRuntime();
    const mirror = runtime.createMirror('demo');
    expect(mirror.lifecycle).toBe('idle');
    expect(mirrors.get('demo')?.lifecycle).toBe('idle');
  });

  it('attachTmux boots a newly created mirror and marks session ready', async () => {
    const { runtime, sessions, mirrors, ensureTmuxSession, captureMirrorAuthoritativeBufferFromTmux, sendMessage, sendScheduleStateToSession } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 120,
      rows: 40,
    });

    const mirror = mirrors.get('demo');
    expect(mirror).toBeTruthy();
    expect(mirror?.lifecycle).toBe('ready');
    expect(ensureTmuxSession).toHaveBeenCalledTimes(1);
    expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);
    expect(session.mirrorKey).toBe('demo');
    expect(session.transport?.connectedSent).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: 'connected' }),
    );
    expect(sendScheduleStateToSession).toHaveBeenCalledWith(session, 'demo');
  });

  it('keeps recurring live sync after mirror boot so external tmux writes enter daemon mirror truth', async () => {
    vi.useFakeTimers();
    try {
      const {
        runtime,
        sessions,
        mirrors,
        captureMirrorAuthoritativeBufferFromTmux,
      } = createRuntime();
      const session = createSession();
      sessions.set(session.id, session);

      await runtime.attachTmux(session, {
        sessionName: 'demo',
        cols: 120,
        rows: 40,
      });

      const mirror = mirrors.get('demo');
      expect(mirror?.lifecycle).toBe('ready');
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(34);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not duplicate recurring live sync when a new attached session reuses an already-ready mirror', async () => {
    vi.useFakeTimers();
    try {
      const {
        runtime,
        sessions,
        mirrors,
        captureMirrorAuthoritativeBufferFromTmux,
      } = createRuntime();
      const firstSession = createSession('session-1');
      sessions.set(firstSession.id, firstSession);

      await runtime.attachTmux(firstSession, {
        sessionName: 'demo',
        cols: 120,
        rows: 40,
      });

      const mirror = mirrors.get('demo');
      expect(mirror?.lifecycle).toBe('ready');
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);

      const secondSession = createSession('session-2');
      secondSession.transportId = 'transport-2';
      sessions.set(secondSession.id, secondSession);

      await runtime.attachTmux(secondSession, {
        sessionName: 'demo',
        cols: 120,
        rows: 40,
      });

      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();

      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);
      expect(secondSession.mirrorKey).toBe('demo');
      expect(secondSession.transport?.connectedSent).toBe(true);

      await vi.advanceTimersByTimeAsync(34);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bumps mirror revision when an existing canonical row changes without tail growth', async () => {
    const sessions = new Map<string, TerminalSession>();
    const mirrors = new Map<string, SessionMirror>();
    const captureMirrorAuthoritativeBufferFromTmux = vi
      .fn<Parameters<NonNullable<ReturnType<typeof createRuntime>['captureMirrorAuthoritativeBufferFromTmux']>>, ReturnType<NonNullable<ReturnType<typeof createRuntime>['captureMirrorAuthoritativeBufferFromTmux']>>>()
      .mockImplementationOnce(async (mirror: SessionMirror) => {
        mirror.bufferStartIndex = 100;
        mirror.bufferLines = [
          [{ char: 97, fg: 256, bg: 256, flags: 0, width: 1 }],
          [{ char: 98, fg: 256, bg: 256, flags: 0, width: 1 }],
          [{ char: 99, fg: 256, bg: 256, flags: 0, width: 1 }],
        ];
        mirror.cursor = null;
        mirror.cursorKeysApp = false;
        return true;
      })
      .mockImplementationOnce(async (mirror: SessionMirror) => {
        mirror.bufferStartIndex = 100;
        mirror.bufferLines = [
          [{ char: 97, fg: 256, bg: 256, flags: 0, width: 1 }],
          [{ char: 66, fg: 256, bg: 256, flags: 0, width: 1 }],
          [{ char: 99, fg: 256, bg: 256, flags: 0, width: 1 }],
        ];
        mirror.cursor = null;
        mirror.cursorKeysApp = false;
        return true;
      });

    const runtime = createTerminalMirrorRuntime({
      defaultViewport: { cols: 120, rows: 40 },
      sessions,
      mirrors,
      sendMessage: vi.fn(),
      sendScheduleStateToSession: vi.fn(),
      buildConnectedPayload: (sessionId: string) => ({ sessionId }),
      buildBufferHeadPayload: () => ({
        sessionId: 'session-1',
        revision: 1,
        latestEndIndex: 0,
        availableStartIndex: 0,
        availableEndIndex: 0,
        cursorKeysApp: false,
        cursor: null,
      }),
      buildChangedRangesBufferSyncPayload: (mirror, changedRanges) => buildChangedRangesBufferSyncPayload(mirror, changedRanges),
      sanitizeSessionName: (input?: string) => input?.trim() || 'demo',
      getMirrorKey: (sessionName: string) => sessionName,
      normalizeTerminalCols: (cols?: number) => cols || 120,
      normalizeTerminalRows: (rows?: number) => rows || 40,
      resolveAttachGeometry: ({ requestedGeometry, currentMirrorGeometry, existingTmuxGeometry, previousSessionGeometry }) =>
        requestedGeometry || currentMirrorGeometry || existingTmuxGeometry || previousSessionGeometry,
      readTmuxPaneMetrics: () => ({
        paneId: '%1',
        tmuxAvailableLineCountHint: 0,
        paneRows: 40,
        paneCols: 120,
        alternateOn: false,
      }),
      ensureTmuxSession: vi.fn(),
      captureMirrorAuthoritativeBufferFromTmux,
      mirrorBufferChanged: (mirror, previousStartIndex, previousLines) => findChangedIndexedRanges({
        previousStartIndex,
        previousLines,
        nextStartIndex: mirror.bufferStartIndex,
        nextLines: mirror.bufferLines,
      }),
      mirrorCursorEqual: () => true,
      writeToLiveMirror: () => true,
      writeToTmuxSession: vi.fn(),
      autoCommandDelayMs: 0,
      waitMs: async () => {},
      logTimePrefix: () => '2026-05-03 00:00:00',
      closeLogicalTerminalSession: vi.fn(),
      getSessionMirror: (session: TerminalSession) => (session.mirrorKey ? mirrors.get(session.mirrorKey) || null : null),
    });

    const mirror = runtime.createMirror('demo');
    mirror.lifecycle = 'ready';

    await runtime.syncMirrorCanonicalBuffer(mirror);
    expect(mirror.revision).toBe(1);

    await runtime.syncMirrorCanonicalBuffer(mirror);
    expect(mirror.revision).toBe(2);
  });
});

  it('broadcasts sparse mirror-diff buffer-sync to ready subscribers after canonical mirror content changes', async () => {
    const { runtime, sessions, sendMessage } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);
    const mirror = runtime.createMirror('demo');
    mirror.lifecycle = 'ready';
    mirror.subscribers.add(session.id);
    mirror.bufferStartIndex = 100;
    mirror.bufferLines = [
      [{ char: 97, fg: 256, bg: 256, flags: 0, width: 1 }],
    ];

    const capture = vi.fn(async (targetMirror: SessionMirror) => {
      targetMirror.bufferStartIndex = 100;
      targetMirror.bufferLines = [
        [{ char: 97, fg: 256, bg: 256, flags: 0, width: 1 }],
        [{ char: 98, fg: 256, bg: 256, flags: 0, width: 1 }],
      ];
      targetMirror.cursor = null;
      targetMirror.cursorKeysApp = false;
      return true;
    });

    const customRuntime = createTerminalMirrorRuntime({
      defaultViewport: { cols: 120, rows: 40 },
      sessions,
      mirrors: new Map<string, SessionMirror>([['demo', mirror]]),
      sendMessage,
      sendScheduleStateToSession: vi.fn(),
      buildConnectedPayload: (sessionId: string) => ({ sessionId }),
      buildBufferHeadPayload: (sessionId: string, targetMirror: SessionMirror) => ({
        sessionId,
        revision: targetMirror.revision,
        latestEndIndex: targetMirror.bufferStartIndex + targetMirror.bufferLines.length,
        availableStartIndex: targetMirror.bufferStartIndex,
        availableEndIndex: targetMirror.bufferStartIndex + targetMirror.bufferLines.length,
        cursorKeysApp: targetMirror.cursorKeysApp,
        cursor: targetMirror.cursor,
      }),
      buildChangedRangesBufferSyncPayload: (targetMirror, changedRanges) => buildChangedRangesBufferSyncPayload(targetMirror, changedRanges),
      sanitizeSessionName: (input?: string) => input?.trim() || 'demo',
      getMirrorKey: (sessionName: string) => sessionName,
      normalizeTerminalCols: (cols?: number) => cols || 120,
      normalizeTerminalRows: (rows?: number) => rows || 40,
      resolveAttachGeometry: ({ requestedGeometry, currentMirrorGeometry, existingTmuxGeometry, previousSessionGeometry }) =>
        requestedGeometry || currentMirrorGeometry || existingTmuxGeometry || previousSessionGeometry,
      readTmuxPaneMetrics: () => ({ paneId: '%1', tmuxAvailableLineCountHint: 0, paneRows: 40, paneCols: 120, alternateOn: false }),
      ensureTmuxSession: vi.fn(),
      captureMirrorAuthoritativeBufferFromTmux: capture,
      mirrorBufferChanged: (targetMirror, previousStartIndex, previousLines) => findChangedIndexedRanges({
        previousStartIndex,
        previousLines,
        nextStartIndex: targetMirror.bufferStartIndex,
        nextLines: targetMirror.bufferLines,
      }),
      mirrorCursorEqual: () => true,
      writeToLiveMirror: () => true,
      writeToTmuxSession: vi.fn(),
      autoCommandDelayMs: 0,
      waitMs: async () => {},
      logTimePrefix: () => '2026-05-06 00:00:00',
      closeLogicalTerminalSession: vi.fn(),
      getSessionMirror: () => mirror,
    });

    await customRuntime.syncMirrorCanonicalBuffer(mirror);

    expect(sendMessage).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: 'buffer-sync',
        payload: expect.objectContaining({
          revision: 1,
          startIndex: 101,
          endIndex: 102,
        }),
      }),
    );
  });

  it('broadcasts buffer-head only when canonical mirror body is unchanged but cursor metadata changes', async () => {
    const { runtime, sessions, sendMessage } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);
    const mirror = runtime.createMirror('demo');
    mirror.lifecycle = 'ready';
    mirror.subscribers.add(session.id);
    mirror.bufferStartIndex = 100;
    mirror.bufferLines = [
      [{ char: 97, fg: 256, bg: 256, flags: 0, width: 1 }],
    ];
    mirror.cursor = { rowIndex: 100, col: 0, visible: true };
    mirror.cursorKeysApp = false;

    const capture = vi.fn(async (targetMirror: SessionMirror) => {
      targetMirror.bufferStartIndex = 100;
      targetMirror.bufferLines = [
        [{ char: 97, fg: 256, bg: 256, flags: 0, width: 1 }],
      ];
      targetMirror.cursor = { rowIndex: 100, col: 1, visible: true };
      targetMirror.cursorKeysApp = false;
      return true;
    });

    const customRuntime = createTerminalMirrorRuntime({
      defaultViewport: { cols: 120, rows: 40 },
      sessions,
      mirrors: new Map<string, SessionMirror>([['demo', mirror]]),
      sendMessage,
      sendScheduleStateToSession: vi.fn(),
      buildConnectedPayload: (sessionId: string) => ({ sessionId }),
      buildBufferHeadPayload: (sessionId: string, targetMirror: SessionMirror) => ({
        sessionId,
        revision: targetMirror.revision,
        latestEndIndex: targetMirror.bufferStartIndex + targetMirror.bufferLines.length,
        availableStartIndex: targetMirror.bufferStartIndex,
        availableEndIndex: targetMirror.bufferStartIndex + targetMirror.bufferLines.length,
        cursorKeysApp: targetMirror.cursorKeysApp,
        cursor: targetMirror.cursor,
      }),
      buildChangedRangesBufferSyncPayload: (targetMirror, changedRanges) => buildChangedRangesBufferSyncPayload(targetMirror, changedRanges),
      sanitizeSessionName: (input?: string) => input?.trim() || 'demo',
      getMirrorKey: (sessionName: string) => sessionName,
      normalizeTerminalCols: (cols?: number) => cols || 120,
      normalizeTerminalRows: (rows?: number) => rows || 40,
      resolveAttachGeometry: ({ requestedGeometry, currentMirrorGeometry, existingTmuxGeometry, previousSessionGeometry }) =>
        requestedGeometry || currentMirrorGeometry || existingTmuxGeometry || previousSessionGeometry,
      readTmuxPaneMetrics: () => ({ paneId: '%1', tmuxAvailableLineCountHint: 0, paneRows: 40, paneCols: 120, alternateOn: false }),
      ensureTmuxSession: vi.fn(),
      captureMirrorAuthoritativeBufferFromTmux: capture,
      mirrorBufferChanged: (targetMirror, previousStartIndex, previousLines) => findChangedIndexedRanges({
        previousStartIndex,
        previousLines,
        nextStartIndex: targetMirror.bufferStartIndex,
        nextLines: targetMirror.bufferLines,
      }),
      mirrorCursorEqual: (left, right) => (
        (left?.rowIndex ?? null) === (right?.rowIndex ?? null)
        && (left?.col ?? null) === (right?.col ?? null)
        && (left?.visible ?? null) === (right?.visible ?? null)
      ),
      writeToLiveMirror: () => true,
      writeToTmuxSession: vi.fn(),
      autoCommandDelayMs: 0,
      waitMs: async () => {},
      logTimePrefix: () => '2026-05-06 00:00:00',
      closeLogicalTerminalSession: vi.fn(),
      getSessionMirror: () => mirror,
    });

    await customRuntime.syncMirrorCanonicalBuffer(mirror);

    expect(sendMessage).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: 'buffer-head',
        payload: expect.objectContaining({
          revision: 1,
          latestEndIndex: 101,
          cursor: { rowIndex: 100, col: 1, visible: true },
        }),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: 'buffer-sync',
      }),
    );
  });
