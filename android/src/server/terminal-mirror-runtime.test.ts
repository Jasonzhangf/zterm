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
    widthMode: 'mirror-fixed',
    pendingPasteImage: null,
    pendingAttachFile: null,
  };
}

function createRuntime() {
  const sessions = new Map<string, TerminalSession>();
  const mirrors = new Map<string, SessionMirror>();
  const assertTmuxSessionExists = vi.fn();
  const runTmux = vi.fn(() => ({ ok: true as const, stdout: '' }));
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
    assertTmuxSessionExists,
    captureMirrorAuthoritativeBufferFromTmux,
    mirrorBufferChanged: () => [],
    mirrorCursorEqual: () => true,
    writeToLiveMirror: () => true,
    enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
    disposeLiveMirrorInputBatch: () => 0,
    writeToTmuxSession: vi.fn(),
    autoCommandDelayMs: 0,
    waitMs: async () => {},
    logTimePrefix: () => '2026-05-01 00:00:00',
    runTmux,
    closeLogicalTerminalSession: vi.fn(),
    getSessionMirror: (session: TerminalSession) => (session.mirrorKey ? mirrors.get(session.mirrorKey) || null : null),
  });

  return {
    runtime,
    sessions,
    mirrors,
    runTmux,
    assertTmuxSessionExists,
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
    const { runtime, sessions, mirrors, assertTmuxSessionExists, captureMirrorAuthoritativeBufferFromTmux, sendMessage, sendScheduleStateToSession } = createRuntime();
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
    expect(assertTmuxSessionExists).toHaveBeenCalledTimes(1);
    expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);
    expect(session.mirrorKey).toBe('demo');
    expect(session.transport?.connectedSent).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: 'connected' }),
    );
    expect(sendScheduleStateToSession).toHaveBeenCalledWith(session, 'demo');
  });

  it('does not implicitly create a missing tmux session during attach and reports tmux_session_unavailable instead', async () => {
    const { runtime, sessions, mirrors, assertTmuxSessionExists, sendMessage, captureMirrorAuthoritativeBufferFromTmux } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);
    assertTmuxSessionExists.mockImplementation(() => {
      throw new Error('can not find session: missing-demo');
    });

    await runtime.attachTmux(session, {
      sessionName: 'missing-demo',
      cols: 120,
      rows: 40,
    });

    const mirror = mirrors.get('missing-demo');
    expect(assertTmuxSessionExists).toHaveBeenCalledTimes(1);
    expect(captureMirrorAuthoritativeBufferFromTmux).not.toHaveBeenCalled();
    expect(mirror?.lifecycle).toBe('failed');
    expect(session.transport?.connectedSent).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({
          code: 'tmux_session_unavailable',
        }),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: 'connected' }),
    );
  });

  it('keeps the mirror/runtime shell alive and reports initial sync failure when initial capture hits a dead pane target', async () => {
    const { sessions, mirrors, sendMessage } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);

    const customRuntime = createTerminalMirrorRuntime({
      defaultViewport: { cols: 120, rows: 40 },
      sessions,
      mirrors,
      sendMessage,
      sendScheduleStateToSession: vi.fn(),
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
        paneId: '%3',
        tmuxAvailableLineCountHint: 0,
        paneRows: 56,
        paneCols: 56,
        alternateOn: false,
      }),
      assertTmuxSessionExists: vi.fn(),
      captureMirrorAuthoritativeBufferFromTmux: vi.fn(async () => {
        throw new Error('tmux returned invalid pane metrics for rcc-zterm: pane is dead');
      }),
      mirrorBufferChanged: () => [],
      mirrorCursorEqual: () => true,
      writeToLiveMirror: () => true,
      enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
    disposeLiveMirrorInputBatch: () => 0,
      writeToTmuxSession: vi.fn(),
      autoCommandDelayMs: 0,
      waitMs: async () => {},
      logTimePrefix: () => '2026-05-13 00:30:00',
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
      closeLogicalTerminalSession: vi.fn(),
      getSessionMirror: (candidate: TerminalSession) => (candidate.mirrorKey ? mirrors.get(candidate.mirrorKey) || null : null),
    });

    await customRuntime.attachTmux(session, {
      sessionName: 'rcc-zterm',
      cols: 56,
      rows: 56,
    });

    const mirror = mirrors.get('rcc-zterm');
    expect(mirror?.lifecycle).toBe('failed');
    expect(session.mirrorKey).toBe('rcc-zterm');
    expect(sendMessage).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({
          code: 'initial_buffer_sync_failed',
          message: expect.stringContaining('Failed to capture canonical tmux buffer during initial sync'),
        }),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: 'connected' }),
    );
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

      await vi.advanceTimersByTimeAsync(16);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to idle cadence after initial forced revision ages out without new live activity', async () => {
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

      await vi.advanceTimersByTimeAsync(16);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1600);
      const callsBeforeIdleWindow = captureMirrorAuthoritativeBufferFromTmux.mock.calls.length;

      await vi.advanceTimersByTimeAsync(33);
      expect(captureMirrorAuthoritativeBufferFromTmux.mock.calls.length - callsBeforeIdleWindow).toBeLessThanOrEqual(1);

      await vi.advanceTimersByTimeAsync(120);
      expect(captureMirrorAuthoritativeBufferFromTmux.mock.calls.length).toBeGreaterThan(callsBeforeIdleWindow);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses an already-ready mirror with one immediate sync and without duplicating recurring live sync loops', async () => {
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

      await vi.advanceTimersByTimeAsync(1);

      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(2);
      expect(secondSession.mirrorKey).toBe('demo');
      expect(secondSession.transport?.connectedSent).toBe(true);

      await vi.advanceTimersByTimeAsync(16);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses min adaptive cols across concurrent adaptive-phone subscribers', async () => {
    const { runtime, sessions, mirrors, runTmux } = createRuntime();
    const firstSession = createSession('session-1');
    const secondSession = createSession('session-2');
    secondSession.transportId = 'transport-2';
    sessions.set(firstSession.id, firstSession);
    sessions.set(secondSession.id, secondSession);

    await runtime.attachTmux(firstSession, {
      sessionName: 'demo',
      cols: 120,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    await runtime.attachTmux(secondSession, {
      sessionName: 'demo',
      cols: 80,
      rows: 40,
      widthMode: 'adaptive-phone',
    });

    const mirror = mirrors.get('demo');
    expect(mirror?.adaptiveCols.get('session-1')?.cols).toBe(120);
    expect(mirror?.adaptiveCols.get('session-2')?.cols).toBe(80);
    expect(mirror?.cols).toBe(80);
    expect(runTmux).toHaveBeenLastCalledWith(['resize-window', '-t', 'demo', '-x', '80']);
  });

  it('accepts adaptive-phone attach payload with cols only and keeps baseline rows', async () => {
    const { runtime, sessions, mirrors } = createRuntime();
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 88,
      widthMode: 'adaptive-phone',
    } as any);

    const mirror = mirrors.get('demo');
    expect(mirror?.adaptiveCols.get('session-1')?.cols).toBe(88);
    expect(mirror?.cols).toBe(88);
    expect(mirror?.rows).toBe(40);
  });

  it('keeps upstream width untouched for mirror-fixed subscriber attach', async () => {
    const { runtime, sessions, mirrors } = createRuntime();
    const adaptiveSession = createSession('session-1');
    const fixedSession = createSession('session-2');
    fixedSession.transportId = 'transport-2';
    sessions.set(adaptiveSession.id, adaptiveSession);
    sessions.set(fixedSession.id, fixedSession);

    await runtime.attachTmux(adaptiveSession, {
      sessionName: 'demo',
      cols: 90,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    const mirror = mirrors.get('demo');
    expect(mirror?.cols).toBe(90);

    await runtime.attachTmux(fixedSession, {
      sessionName: 'demo',
      cols: 60,
      rows: 40,
      widthMode: 'mirror-fixed',
    });

    expect(mirror?.cols).toBe(90);
    expect(mirror?.adaptiveCols.has('session-2')).toBe(false);
  });

  it('stops recurring live sync once the last subscriber detaches, then resumes on reattach', async () => {
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

      sessions.delete(firstSession.id);
      if (mirror) {
        mirror.subscribers.delete(firstSession.id);
        runtime.scheduleMirrorLiveSync(mirror, 0);
      }

      await vi.advanceTimersByTimeAsync(500);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);

      const secondSession = createSession('session-2');
      secondSession.transportId = 'transport-2';
      sessions.set(secondSession.id, secondSession);

      await runtime.attachTmux(secondSession, {
        sessionName: 'demo',
        cols: 120,
        rows: 40,
      });

      await vi.advanceTimersByTimeAsync(1);
      expect(secondSession.mirrorKey).toBe('demo');
      expect(secondSession.transport?.connectedSent).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
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
      assertTmuxSessionExists: vi.fn(),
      captureMirrorAuthoritativeBufferFromTmux,
      mirrorBufferChanged: (mirror, previousStartIndex, previousLines) => findChangedIndexedRanges({
        previousStartIndex,
        previousLines,
        nextStartIndex: mirror.bufferStartIndex,
        nextLines: mirror.bufferLines,
      }),
      mirrorCursorEqual: () => true,
      writeToLiveMirror: () => true,
      enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
    disposeLiveMirrorInputBatch: () => 0,
      writeToTmuxSession: vi.fn(),
      autoCommandDelayMs: 0,
      waitMs: async () => {},
      logTimePrefix: () => '2026-05-03 00:00:00',
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
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

  it('broadcasts buffer-sync instead of buffer-head when an existing canonical row changes without tail growth', async () => {
    const { runtime, sessions, sendMessage } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);
    const mirror = runtime.createMirror('demo');
    mirror.lifecycle = 'ready';
    mirror.subscribers.add(session.id);
    mirror.bufferStartIndex = 100;
    mirror.bufferLines = [
      [{ char: 97, fg: 256, bg: 256, flags: 0, width: 1 }],
      [{ char: 98, fg: 256, bg: 256, flags: 0, width: 1 }],
      [{ char: 99, fg: 256, bg: 256, flags: 0, width: 1 }],
    ];
    mirror.cursor = null;
    mirror.cursorKeysApp = false;

    const capture = vi.fn(async (targetMirror: SessionMirror) => {
      targetMirror.bufferStartIndex = 100;
      targetMirror.bufferLines = [
        [{ char: 97, fg: 256, bg: 256, flags: 0, width: 1 }],
        [{ char: 66, fg: 256, bg: 256, flags: 0, width: 1 }],
        [{ char: 99, fg: 256, bg: 256, flags: 0, width: 1 }],
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
      assertTmuxSessionExists: vi.fn(),
      captureMirrorAuthoritativeBufferFromTmux: capture,
      mirrorBufferChanged: (targetMirror, previousStartIndex, previousLines) => findChangedIndexedRanges({
        previousStartIndex,
        previousLines,
        nextStartIndex: targetMirror.bufferStartIndex,
        nextLines: targetMirror.bufferLines,
      }),
      mirrorCursorEqual: () => true,
      writeToLiveMirror: () => true,
      enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
    disposeLiveMirrorInputBatch: () => 0,
      writeToTmuxSession: vi.fn(),
      autoCommandDelayMs: 0,
      waitMs: async () => {},
      logTimePrefix: () => '2026-05-11 00:00:00',
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
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
    expect(sendMessage).not.toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: 'buffer-head',
      }),
    );
  });

  it('does not release a ready mirror when live sync later discovers a dead pane target', async () => {
    const { sessions, sendMessage } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);

    const mirror: SessionMirror = {
      key: 'rcc-zterm',
      sessionName: 'rcc-zterm',
      scratchBridge: null,
      lifecycle: 'ready',
      cols: 56,
      rows: 56,
      baselineCols: 56,
      baselineRows: 56,
      cursorKeysApp: false,
      revision: 1,
      lastScrollbackCount: 0,
      bufferStartIndex: 0,
      bufferLines: [],
      cursor: null,
      lastFlushStartedAt: 0,
      lastFlushCompletedAt: 0,
      lastLiveActivityAt: 0,
      lastHeadBroadcastAt: 0,
      lastResizeAt: 0,
      
      flushInFlight: false,
      flushPromise: null,
      pendingStableCaptureSnapshot: null,
      liveSyncTimer: null,
      consecutiveFailures: 0,
      adaptiveCols: new Map(),
      subscribers: new Set([session.id]),
    };
    session.mirrorKey = mirror.key;
    const mirrors = new Map<string, SessionMirror>([[mirror.key, mirror]]);

    const customRuntime = createTerminalMirrorRuntime({
      defaultViewport: { cols: 120, rows: 40 },
      sessions,
      mirrors,
      sendMessage,
      sendScheduleStateToSession: vi.fn(),
      buildConnectedPayload: (sessionId: string) => ({ sessionId }),
      buildBufferHeadPayload: () => ({
        sessionId: 'session-1',
        revision: 1,
        latestEndIndex: 0,
        availableStartIndex: 0,
        availableEndIndex: 0,
        cursor: null,
      }),
      buildChangedRangesBufferSyncPayload: (targetMirror, changedRanges) => buildChangedRangesBufferSyncPayload(targetMirror, changedRanges),
      sanitizeSessionName: (input?: string) => input?.trim() || 'rcc-zterm',
      getMirrorKey: (sessionName: string) => sessionName,
      normalizeTerminalCols: (cols?: number) => cols || 120,
      normalizeTerminalRows: (rows?: number) => rows || 40,
      resolveAttachGeometry: ({ requestedGeometry, currentMirrorGeometry, existingTmuxGeometry, previousSessionGeometry }) =>
        requestedGeometry || currentMirrorGeometry || existingTmuxGeometry || previousSessionGeometry,
      readTmuxPaneMetrics: () => ({
        paneId: '%3',
        tmuxAvailableLineCountHint: 0,
        paneRows: 56,
        paneCols: 56,
        alternateOn: false,
      }),
      assertTmuxSessionExists: vi.fn(),
      captureMirrorAuthoritativeBufferFromTmux: vi.fn(async () => {
        throw new Error('tmux returned invalid pane metrics for rcc-zterm: pane is dead');
      }),
      mirrorBufferChanged: () => [],
      mirrorCursorEqual: () => true,
      writeToLiveMirror: () => true,
      enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
    disposeLiveMirrorInputBatch: () => 0,
      writeToTmuxSession: vi.fn(),
      autoCommandDelayMs: 0,
      waitMs: async () => {},
      logTimePrefix: () => '2026-05-13 00:31:00',
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
      closeLogicalTerminalSession: vi.fn(),
      getSessionMirror: (candidate: TerminalSession) => (candidate.mirrorKey ? mirrors.get(candidate.mirrorKey) || null : null),
    });

    const ok = await customRuntime.syncMirrorCanonicalBuffer(mirror);

    expect(ok).toBe(false);
    expect(mirrors.get('rcc-zterm')).toBe(mirror);
    expect(session.mirrorKey).toBe('rcc-zterm');
    expect(sendMessage).not.toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({
          code: 'tmux_session_unavailable',
        }),
      }),
    );
  });

it('keeps fast subscriber lane green even when another subscriber is backpressured (R1)', async () => {
  const { runtime, sessions } = createRuntime();
  const fastSession = createSession('session-fast');
  const slowSession = createSession('session-slow');
  sessions.set(fastSession.id, fastSession);
  sessions.set(slowSession.id, slowSession);
  const mirror = runtime.createMirror('demo');
  mirror.lifecycle = 'ready';
  mirror.subscribers.add(fastSession.id);
  mirror.subscribers.add(slowSession.id);
  mirror.lastLiveActivityAt = Date.now() - 100;
  slowSession.transport = {
    ...slowSession.transport,
    readyState: 1,
    bufferedAmount: 256 * 1024,
    backpressureCount: 3,
  } as TerminalSession['transport'];
  fastSession.transport = fastSession.transport as TerminalSession['transport'];
  const now = Date.now();
  const fastDecision = runtime.resolveMirrorLiveSyncDelayForSubscriber(mirror, fastSession.id, sessions, now);
  const slowDecision = runtime.resolveMirrorLiveSyncDelayForSubscriber(mirror, slowSession.id, sessions, now);
  // Mirror-level decision must NOT see per-subscriber backpressure now.
  expect(slowDecision.lane).toBe('slow');
  expect(slowDecision.reason).toBe('transport-backpressure');
  expect(fastDecision.lane).toBe('fast');
  expect(fastDecision.delayMs).toBeLessThan(slowDecision.delayMs);
  });

it('skips buffer-head broadcast for a backpressured subscriber while healthy peers still receive head (R2)', async () => {
  const { sessions, sendMessage } = createRuntime();
  const fastSession = createSession('session-fast-head');
  const slowSession = createSession('session-slow-head');
  sessions.set(fastSession.id, fastSession);
  sessions.set(slowSession.id, slowSession);
  slowSession.transport = {
    ...slowSession.transport,
    readyState: 1,
    bufferedAmount: 256 * 1024,
    backpressureCount: 5,
  } as TerminalSession['transport'];
  const setup = createRuntime();
  const mirror = setup.runtime.createMirror('demo-head');
  mirror.lifecycle = 'ready';
  mirror.subscribers.add(fastSession.id);
  mirror.subscribers.add(slowSession.id);
  mirror.bufferStartIndex = 100;
  mirror.bufferLines = [[{ char: 97, fg: 256, bg: 256, flags: 0, width: 1 }]];
  mirror.cursor = { rowIndex: 100, col: 0, visible: true };
  mirror.cursorKeysApp = false;

  const capture = vi.fn(async (targetMirror: SessionMirror) => {
    targetMirror.bufferStartIndex = 100;
    targetMirror.bufferLines = [[{ char: 97, fg: 256, bg: 256, flags: 0, width: 1 }]];
    targetMirror.cursor = { rowIndex: 100, col: 2, visible: true };
    targetMirror.cursorKeysApp = false;
    return true;
  });

  const customRuntime = createTerminalMirrorRuntime({
    defaultViewport: { cols: 120, rows: 40 },
    sessions,
    mirrors: new Map<string, SessionMirror>([['demo-head', mirror]]),
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
    sanitizeSessionName: (input?: string) => input?.trim() || 'demo-head',
    getMirrorKey: (sessionName: string) => sessionName,
    normalizeTerminalCols: (cols?: number) => cols || 120,
    normalizeTerminalRows: (rows?: number) => rows || 40,
    resolveAttachGeometry: ({ requestedGeometry, currentMirrorGeometry, existingTmuxGeometry, previousSessionGeometry }) =>
      requestedGeometry || currentMirrorGeometry || existingTmuxGeometry || previousSessionGeometry,
    readTmuxPaneMetrics: () => ({ paneId: '%1', tmuxAvailableLineCountHint: 0, paneRows: 40, paneCols: 120, alternateOn: false }),
    assertTmuxSessionExists: vi.fn(),
    captureMirrorAuthoritativeBufferFromTmux: capture,
    mirrorBufferChanged: () => [],
    mirrorCursorEqual: () => false,
    writeToLiveMirror: () => true,
    enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
    disposeLiveMirrorInputBatch: () => 0,
    writeToTmuxSession: vi.fn(),
    autoCommandDelayMs: 0,
    waitMs: async () => {},
    logTimePrefix: () => '2026-05-06 00:00:00',
    runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    closeLogicalTerminalSession: vi.fn(),
    getSessionMirror: () => mirror,
  });

  await customRuntime.syncMirrorCanonicalBuffer(mirror);

  expect(sendMessage).toHaveBeenCalledWith(
    fastSession,
    expect.objectContaining({ type: 'buffer-head' }),
  );
  const slowHeadCalls = sendMessage.mock.calls.filter(
    ([target, msg]) => target === slowSession && (msg as { type: string }).type === 'buffer-head',
  );
  expect(slowHeadCalls).toHaveLength(0);
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
      assertTmuxSessionExists: vi.fn(),
      captureMirrorAuthoritativeBufferFromTmux: capture,
      mirrorBufferChanged: (targetMirror, previousStartIndex, previousLines) => findChangedIndexedRanges({
        previousStartIndex,
        previousLines,
        nextStartIndex: targetMirror.bufferStartIndex,
        nextLines: targetMirror.bufferLines,
      }),
      mirrorCursorEqual: () => true,
      writeToLiveMirror: () => true,
      enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
    disposeLiveMirrorInputBatch: () => 0,
      writeToTmuxSession: vi.fn(),
      autoCommandDelayMs: 0,
      waitMs: async () => {},
      logTimePrefix: () => '2026-05-06 00:00:00',
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
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
      assertTmuxSessionExists: vi.fn(),
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
      enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
    disposeLiveMirrorInputBatch: () => 0,
      writeToTmuxSession: vi.fn(),
      autoCommandDelayMs: 0,
      waitMs: async () => {},
      logTimePrefix: () => '2026-05-06 00:00:00',
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
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
});
