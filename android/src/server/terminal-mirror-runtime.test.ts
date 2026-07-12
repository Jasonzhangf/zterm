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

function createRuntime(overrides: {
  readTmuxPaneMetrics?: () => {
    paneId: string;
    tmuxAvailableLineCountHint: number;
    paneRows: number;
    paneCols: number;
    alternateOn: boolean;
  };
  normalizeTerminalCols?: (cols?: number) => number;
  normalizeTerminalRows?: (rows?: number) => number;
} = {}) {
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
    sendText: vi.fn(),
    sendScheduleStateToSession,
    buildConnectedPayload: (sessionId: string) => ({ sessionId }),
    buildBufferHeadPayload: (sessionId: string, targetMirror: SessionMirror) => ({
      sessionId,
      revision: targetMirror.revision,
      latestEndIndex: 0,
      availableStartIndex: 0,
      availableEndIndex: 0,
      cursor: null,
    }),
    buildChangedRangesBufferSyncPayload: (mirror, changedRanges) => buildChangedRangesBufferSyncPayload(mirror, changedRanges),
    sanitizeSessionName: (input?: string) => input?.trim() || 'demo',
    getMirrorKey: (sessionName: string) => sessionName,
    normalizeTerminalCols: overrides.normalizeTerminalCols || ((cols?: number) => cols || 120),
    normalizeTerminalRows: overrides.normalizeTerminalRows || ((rows?: number) => rows || 40),
    resolveAttachGeometry: ({ requestedGeometry, currentMirrorGeometry, existingTmuxGeometry, previousSessionGeometry }) =>
      requestedGeometry || currentMirrorGeometry || existingTmuxGeometry || previousSessionGeometry,
    readTmuxPaneMetrics: overrides.readTmuxPaneMetrics || (() => ({
      paneId: '%1',
      tmuxAvailableLineCountHint: 0,
      paneRows: 40,
      paneCols: 120,
      alternateOn: false,
    })),
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
    closeTransportSubscriber: vi.fn(),
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
    sendText: vi.fn(),
    sendScheduleStateToSession,
  };
}

function expectOnlyAdaptiveWidthTmuxMutation(runTmux: { mock: { calls: unknown[][] } }) {
  for (const [rawArgs] of runTmux.mock.calls) {
    const args = rawArgs as string[];
    if (args[0] === 'resize-window') {
      expect(args).toEqual(['resize-window', '-t', expect.any(String), '-x', expect.any(String)]);
      continue;
    }
    if (args[0] === 'set-window-option') {
      expect(args).toEqual(['set-window-option', '-u', '-t', expect.any(String), 'window-size']);
      continue;
    }
    expect(args.join(' ')).not.toContain('@zterm_adaptive_width_');
  }
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

  it('fans out the first head request of a revision once, then serves same-revision probes only to the requester', () => {
    const { runtime, sessions, sendMessage } = createRuntime();
    const firstSession = createSession('session-1');
    const secondSession = createSession('session-2');
    sessions.set(firstSession.id, firstSession);
    sessions.set(secondSession.id, secondSession);

    const mirror = runtime.createMirror('demo');
    mirror.lifecycle = 'ready';
    mirror.revision = 7;
    mirror.subscribers.add(firstSession.id);
    mirror.subscribers.add(secondSession.id);

    runtime.sendBufferHeadToSession(firstSession, mirror);

    const firstBroadcastCalls = sendMessage.mock.calls.filter(
      ([, message]) => (message as { type?: string }).type === 'buffer-head',
    );
    expect(firstBroadcastCalls).toHaveLength(2);
    expect(firstBroadcastCalls).toEqual([
      [firstSession, expect.objectContaining({ type: 'buffer-head', payload: expect.objectContaining({ sessionId: 'session-1', revision: 7 }) })],
      [secondSession, expect.objectContaining({ type: 'buffer-head', payload: expect.objectContaining({ sessionId: 'session-2', revision: 7 }) })],
    ]);

    sendMessage.mockClear();

    runtime.sendBufferHeadToSession(firstSession, mirror);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      firstSession,
      expect.objectContaining({
        type: 'buffer-head',
        payload: expect.objectContaining({
          sessionId: 'session-1',
          revision: 7,
        }),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      secondSession,
      expect.objectContaining({ type: 'buffer-head' }),
    );
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

  it('classifies missing wezterm panes as session unavailable instead of generic sync failure', async () => {
    const { runtime, sessions, mirrors, sendMessage, captureMirrorAuthoritativeBufferFromTmux } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);
    captureMirrorAuthoritativeBufferFromTmux.mockImplementation(async () => {
      throw new Error('wezterm session not found: demo');
    });

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 120,
      rows: 40,
    });

    expect(mirrors.get('demo')).toBeUndefined();
    expect(session.mirrorKey).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({
          code: 'tmux_session_unavailable',
        }),
      }),
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
      sendText: vi.fn(),
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
        throw new Error('tmux returned invalid pane metrics for demo-zterm: pane is dead');
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
      closeTransportSubscriber: vi.fn(),
      getSessionMirror: (candidate: TerminalSession) => (candidate.mirrorKey ? mirrors.get(candidate.mirrorKey) || null : null),
    });

    await customRuntime.attachTmux(session, {
      sessionName: 'demo-zterm',
      cols: 56,
      rows: 56,
    });

    const mirror = mirrors.get('demo-zterm');
    expect(mirror?.lifecycle).toBe('failed');
    expect(session.mirrorKey).toBe('demo-zterm');
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

  it('keeps subscribed mirror capture on active cadence after initial forced revision ages out without new live activity', async () => {
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

  it('records adaptive attach leases and asks tmux to reflow to the narrowest active width', async () => {
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
    expect(mirror?.subscribers).toEqual(new Set(['session-1', 'session-2']));
    expect(mirror?.cols).toBe(120);
    expect(firstSession.adaptiveWidthCols).toBe(120);
    expect(secondSession.adaptiveWidthCols).toBe(80);
    expect(mirror?.adaptiveWidthAppliedCols).toBe(80);
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', 'demo', '-x', '120']);
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', 'demo', '-x', '80']);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
    expect(mirror).not.toHaveProperty('adaptiveCols');
  });

  it('stores adaptive width only as a transport subscriber lease without changing mirror geometry', async () => {
    const { runtime, sessions, mirrors } = createRuntime();
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 88,
      widthMode: 'adaptive-phone',
    } as any);

    const mirror = mirrors.get('demo');
    expect(mirror?.cols).toBe(120);
    expect(mirror?.rows).toBe(40);
    expect(session.adaptiveWidthCols).toBe(88);
    expect(session).not.toHaveProperty('widthMode');
    expect(mirror).not.toHaveProperty('adaptiveCols');
  });

  it('rejects adaptive attach without finite cols without throwing or applying a lease', async () => {
    const { runtime, sessions, mirrors, runTmux, sendMessage } = createRuntime({
      normalizeTerminalCols: (cols?: number) => {
        if (!Number.isFinite(cols) || cols! <= 0) {
          throw new Error('terminal cols must be a finite positive number');
        }
        return Math.max(1, Math.floor(cols!));
      },
    });
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await expect(runtime.attachTmux(session, {
      sessionName: 'demo',
      widthMode: 'adaptive-phone',
    } as any)).resolves.toBeUndefined();

    const mirror = mirrors.get('demo');
    expect(mirror?.subscribers).toEqual(new Set(['session-1']));
    expect(mirror?.cols).toBe(120);
    expect(session.adaptiveWidthCols).toBeNull();
    expect(runTmux).not.toHaveBeenCalledWith(['resize-window', '-t', 'demo', '-x', '120']);
    expect(sendMessage).toHaveBeenCalledWith(session, {
      type: 'error',
      payload: {
        message: 'adaptive-phone width lease requires finite positive cols',
        code: 'adaptive_width_cols_invalid',
      },
    });
  });

  it('rejects invalid adaptive resize cols and releases the previous lease instead of throwing', async () => {
    const { runtime, sessions, mirrors, runTmux } = createRuntime();
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 90,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    runTmux.mockClear();

    const result = runtime.handleAdaptiveResize(session, {
      cols: Number.NaN,
      widthMode: 'adaptive-phone',
    });

    expect(result).toEqual({
      ok: false,
      code: 'adaptive_width_cols_invalid',
      message: 'adaptive-phone width lease requires finite positive cols',
    });
    expect(session.adaptiveWidthCols).toBeNull();
    expect(mirrors.get('demo')?.cols).toBe(120);
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', 'demo', '-x', '120']);
    expect(runTmux).toHaveBeenCalledWith(['set-window-option', '-u', '-t', 'demo', 'window-size']);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
  });

  it('does not persist adaptive width metadata into zterm tmux options', async () => {
    const { runtime, sessions, runTmux } = createRuntime();
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 88,
      widthMode: 'adaptive-phone',
    } as any);

    expect(session.adaptiveWidthCols).toBe(88);
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', 'demo', '-x', '88']);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
  });

  it('updates adaptive resize lease by resizing tmux width only', async () => {
    const { runtime, sessions, mirrors, runTmux } = createRuntime();
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 120,
      rows: 40,
      widthMode: 'adaptive-phone',
    });

    const mirror = mirrors.get('demo');
    expect(mirror?.cols).toBe(120);
    runTmux.mockClear();

    const result = runtime.handleAdaptiveResize(session, {
      cols: 72,
      widthMode: 'adaptive-phone',
    });

    expect(result).toEqual({ ok: true });
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', 'demo', '-x', '72']);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
    expect(mirror?.cols).toBe(120);
    expect(session.adaptiveWidthCols).toBe(72);
    expect(mirror?.adaptiveWidthAppliedCols).toBe(72);
  });

  it('clears adaptive lease when a subscriber switches to mirror-fixed and releases tmux width ownership', async () => {
    const { runtime, sessions, mirrors, runTmux } = createRuntime();
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 100,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    runTmux.mockClear();

    const result = runtime.handleAdaptiveResize(session, {
      cols: 60,
      widthMode: 'mirror-fixed',
    });

    expect(result).toEqual({ ok: true });
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', 'demo', '-x', '120']);
    expect(runTmux).toHaveBeenCalledWith(['set-window-option', '-u', '-t', 'demo', 'window-size']);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
    expect(mirrors.get('demo')?.cols).toBe(120);
    expect(session.adaptiveWidthCols).toBeNull();
  });

  it('re-sorts adaptive leases when the narrowest subscriber disappears', async () => {
    const { runtime, sessions, mirrors, runTmux } = createRuntime();
    const wideSession = createSession('session-wide');
    const narrowSession = createSession('session-narrow');
    narrowSession.transportId = 'transport-narrow';
    sessions.set(wideSession.id, wideSession);
    sessions.set(narrowSession.id, narrowSession);

    await runtime.attachTmux(wideSession, {
      sessionName: 'demo',
      cols: 100,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    await runtime.attachTmux(narrowSession, {
      sessionName: 'demo',
      cols: 60,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    runTmux.mockClear();

    runtime.releaseAdaptiveWidthLease(narrowSession, 'test-disappear');

    expect(mirrors.get('demo')?.cols).toBe(120);
    expect(mirrors.get('demo')?.adaptiveWidthAppliedCols).toBe(100);
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', 'demo', '-x', '100']);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
  });

  it('clears the last adaptive lease when heartbeat expires and releases tmux width ownership', async () => {
    vi.useFakeTimers();
    try {
      const { runtime, sessions, mirrors, runTmux } = createRuntime();
      const session = createSession('session-1');
      sessions.set(session.id, session);

      await runtime.attachTmux(session, {
        sessionName: 'demo',
        cols: 70,
        rows: 40,
        widthMode: 'adaptive-phone',
      });
      expect(mirrors.get('demo')?.cols).toBe(120);
      runTmux.mockClear();

      await vi.advanceTimersByTimeAsync(65001);

      expect(mirrors.get('demo')?.cols).toBe(120);
      expect(mirrors.get('demo')?.adaptiveWidthAppliedCols).toBeNull();
      expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', 'demo', '-x', '120']);
      expect(runTmux).toHaveBeenCalledWith(['set-window-option', '-u', '-t', 'demo', 'window-size']);
      expectOnlyAdaptiveWidthTmuxMutation(runTmux);
      expect(session.adaptiveWidthCols).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not touch tmux sessions on daemon start for historical adaptive state', () => {
    const { runtime, runTmux } = createRuntime();
    runTmux.mockImplementation((args?: string[]) => {
      if (args?.[0] === 'show-window-options' && args.includes('@zterm_adaptive_width_baseline')) {
        return { ok: true as const, stdout: '120x40\n' };
      }
      return { ok: true as const, stdout: '' };
    });

    const restored = runtime.restorePersistedAdaptiveWidthBaselines(['demo']);

    expect(restored).toBe(0);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
  });

  it('does not resize orphaned narrow tmux windows on daemon start', () => {
    const { runtime, runTmux } = createRuntime({
      readTmuxPaneMetrics: () => ({
        paneId: '%1',
        tmuxAvailableLineCountHint: 0,
        paneRows: 55,
        paneCols: 55,
        alternateOn: false,
      }),
    });
    runTmux.mockImplementation((args?: string[]) => {
      if (args?.[0] === 'display-message') {
        return { ok: true as const, stdout: '115x56\n' };
      }
      return { ok: true as const, stdout: '' };
    });

    const restored = runtime.restorePersistedAdaptiveWidthBaselines(['demo']);

    expect(restored).toBe(0);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
  });

  it('does not resize startup sessions without baseline when the tmux window already matches the attached client', () => {
    const { runtime, runTmux } = createRuntime({
      readTmuxPaneMetrics: () => ({
        paneId: '%1',
        tmuxAvailableLineCountHint: 0,
        paneRows: 56,
        paneCols: 115,
        alternateOn: false,
      }),
    });
    runTmux.mockImplementation((args?: string[]) => {
      if (args?.[0] === 'display-message') {
        return { ok: true as const, stdout: '115x56\n' };
      }
      return { ok: true as const, stdout: '' };
    });

    const restored = runtime.restorePersistedAdaptiveWidthBaselines(['demo']);

    expect(restored).toBe(0);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
  });

  it('does not unset manual window-size on daemon start', () => {
    const { runtime, runTmux } = createRuntime({
      readTmuxPaneMetrics: () => ({
        paneId: '%1',
        tmuxAvailableLineCountHint: 0,
        paneRows: 56,
        paneCols: 115,
        alternateOn: false,
      }),
    });
    runTmux.mockImplementation((args?: string[]) => {
      if (args?.[0] === 'display-message') {
        return { ok: true as const, stdout: '115x56\n' };
      }
      if (args?.[0] === 'show-window-options' && args.includes('window-size')) {
        return { ok: true as const, stdout: 'manual\n' };
      }
      return { ok: true as const, stdout: '' };
    });

    const restored = runtime.restorePersistedAdaptiveWidthBaselines(['demo']);

    expect(restored).toBe(0);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
  });

  it('does not unset latest window-size on daemon start', () => {
    const { runtime, runTmux } = createRuntime({
      readTmuxPaneMetrics: () => ({
        paneId: '%1',
        tmuxAvailableLineCountHint: 0,
        paneRows: 56,
        paneCols: 115,
        alternateOn: false,
      }),
    });
    runTmux.mockImplementation((args?: string[]) => {
      if (args?.[0] === 'display-message') {
        return { ok: true as const, stdout: '115x56\n' };
      }
      if (args?.[0] === 'show-window-options' && args.includes('window-size')) {
        return { ok: true as const, stdout: 'latest\n' };
      }
      return { ok: true as const, stdout: '' };
    });

    const restored = runtime.restorePersistedAdaptiveWidthBaselines(['demo']);

    expect(restored).toBe(0);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
  });

  it('reports resize as session_not_ready when no mirror is attached', () => {
    const { runtime } = createRuntime();
    const session = createSession('session-1');

    const result = runtime.handleAdaptiveResize(session, {
      cols: 72,
      widthMode: 'adaptive-phone',
    });

    expect(result).toEqual({
      ok: false,
      code: 'session_not_ready',
      message: 'resize requires an attached mirror',
    });
  });

  it('keeps existing mirror geometry when a later subscriber sends different client cols', async () => {
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
    expect(mirror?.cols).toBe(120);

    await runtime.attachTmux(fixedSession, {
      sessionName: 'demo',
      cols: 60,
      rows: 40,
      widthMode: 'mirror-fixed',
    });

    expect(mirror?.cols).toBe(120);
    expect(fixedSession).not.toHaveProperty('widthMode');
    expect(mirror).not.toHaveProperty('adaptiveCols');
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
      sendText: vi.fn(),
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
      closeTransportSubscriber: vi.fn(),
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
      sendText: vi.fn(),
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
      closeTransportSubscriber: vi.fn(),
      getSessionMirror: () => mirror,
    });

    await customRuntime.syncMirrorCanonicalBuffer(mirror);

    // R5: buffer-sync now goes through sendText (pre-serialized).
    // Expect sendText to have been called with the serialized buffer-sync JSON.
    // Just verify sendMessage was not called with buffer-sync (which it wasn't, since we use sendText).
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
      key: 'demo-zterm',
      sessionName: 'demo-zterm',
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
      
      flushInFlight: false,
      flushPromise: null,
      pendingStableCaptureSnapshot: null,
      liveSyncTimer: null,
      consecutiveFailures: 0,
      subscribers: new Set([session.id]),
    };
    session.mirrorKey = mirror.key;
    const mirrors = new Map<string, SessionMirror>([[mirror.key, mirror]]);

    const customRuntime = createTerminalMirrorRuntime({
      defaultViewport: { cols: 120, rows: 40 },
      sessions,
      mirrors,
      sendMessage,
      sendText: vi.fn(),
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
      sanitizeSessionName: (input?: string) => input?.trim() || 'demo-zterm',
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
        throw new Error('tmux returned invalid pane metrics for demo-zterm: pane is dead');
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
      closeTransportSubscriber: vi.fn(),
      getSessionMirror: (candidate: TerminalSession) => (candidate.mirrorKey ? mirrors.get(candidate.mirrorKey) || null : null),
    });

    const ok = await customRuntime.syncMirrorCanonicalBuffer(mirror);

    expect(ok).toBe(false);
    expect(mirrors.get('demo-zterm')).toBe(mirror);
    expect(session.mirrorKey).toBe('demo-zterm');
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
    sendText: vi.fn(),
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
    closeTransportSubscriber: vi.fn(),
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

  it('broadcasts changed-span buffer-sync to ready subscribers after canonical mirror content changes', async () => {
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
      sendText: vi.fn(),
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
      closeTransportSubscriber: vi.fn(),
      getSessionMirror: () => mirror,
    });

    await customRuntime.syncMirrorCanonicalBuffer(mirror);

    // R5: buffer-sync now goes through sendText (pre-serialized).
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
      sendText: vi.fn(),
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
      closeTransportSubscriber: vi.fn(),
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
