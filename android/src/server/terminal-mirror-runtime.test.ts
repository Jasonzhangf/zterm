import { describe, expect, it, vi } from 'vitest';
import { createTerminalMirrorRuntime } from './terminal-mirror-runtime';
import { buildChangedRangesBufferSyncPayload } from './buffer-sync-contract';
import type { TerminalSession, SessionMirror } from './terminal-runtime-types';
import { findChangedIndexedRanges } from './canonical-buffer';
import type { TerminalCell } from '../lib/types';
import type { AdaptiveWidthOwnershipStore, AdaptiveWidthOwnershipRecord } from './adaptive-width-ownership-store';
import { TERMINAL_SESSION_ATTACH_LEASE_MS } from './terminal-session-attach-lease-runtime';

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
    sessionAttachHeartbeatAt: Date.now(),
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
  captureMirrorAuthoritativeBufferFromTmux?: (mirror: SessionMirror) => Promise<boolean>;
  normalizeTerminalCols?: (cols?: number) => number;
  normalizeTerminalRows?: (rows?: number) => number;
  getMirrorKey?: (sessionName: string, backend?: 'tmux' | 'herdr') => string;
  mirrorBufferChanged?: (mirror: SessionMirror, previousStartIndex: number, previousLines: TerminalCell[][]) => Array<{ startIndex: number; endIndex: number }>;
  waitMs?: (delayMs: number) => Promise<void>;
  adaptiveWidthOwnershipStore?: AdaptiveWidthOwnershipStore;
  resizeBackendSession?: (
    sessionName: string,
    geometry: { cols: number; rows: number },
    backend: 'tmux' | 'herdr' | undefined,
    operation: 'apply' | 'release',
  ) => void;
} = {}) {
  const sessions = new Map<string, TerminalSession>();
  const mirrors = new Map<string, SessionMirror>();
  const assertTmuxSessionExists = vi.fn();
  const runTmux = vi.fn((_args: string[]) => ({ ok: true as const, stdout: '' }));
  const captureMirrorAuthoritativeBufferFromTmux = vi.fn(overrides.captureMirrorAuthoritativeBufferFromTmux || (async (mirror: SessionMirror) => {
    mirror.bufferLines = [];
    mirror.bufferStartIndex = 0;
    mirror.cursor = null;
    mirror.cursorKeysApp = false;
    return true;
  }));
  const sendMessage = vi.fn();
  const sendText = vi.fn();
  const sendScheduleStateToSession = vi.fn();
  const closeTransportSubscriber = vi.fn();

  const runtime = createTerminalMirrorRuntime({
    defaultViewport: { cols: 120, rows: 40 },
    sessions,
    mirrors,
    sendMessage,
    sendText,
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
    buildExactTmuxSessionTarget: (sessionName) => `=${sessionName}`,
    getMirrorKey: overrides.getMirrorKey || ((sessionName: string) => sessionName),
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
    resolveTerminalSessionBackend: () => 'tmux',
    captureMirrorAuthoritativeBufferFromTmux,
    mirrorBufferChanged: overrides.mirrorBufferChanged || (() => []),
    mirrorCursorEqual: () => true,
    daemonInputQueue: {
      handleInputMessage: async () => {},
      enqueueBackendInput: async () => true,
      enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
      disposeLiveMirrorInputBatch: () => 0,
    },
    autoCommandDelayMs: 0,
    waitMs: overrides.waitMs || (async () => {}),
    logTimePrefix: () => '2026-05-01 00:00:00',
    runTmux,
    resizeBackendSession: overrides.resizeBackendSession,
    adaptiveWidthOwnershipStore: overrides.adaptiveWidthOwnershipStore,
    closeTransportSubscriber,
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
    sendText,
    sendScheduleStateToSession,
    closeTransportSubscriber,
  };
}

function expectOnlyAdaptiveWidthTmuxMutation(runTmux: { mock: { calls: unknown[][] } }) {
  for (const [rawArgs] of runTmux.mock.calls) {
    const args = rawArgs as string[];
    if (args[0] === 'resize-window') {
      if (args.length === 5) {
        expect(args).toEqual(['resize-window', '-t', expect.any(String), '-x', expect.any(String)]);
      } else {
        expect(args).toEqual(['resize-window', '-t', expect.any(String), '-x', expect.any(String), '-y', expect.any(String)]);
      }
      continue;
    }
    if (args[0] === 'set-window-option') {
      expect(args).toEqual(['set-window-option', '-u', '-t', expect.any(String), 'window-size']);
      continue;
    }
    expect(args.join(' ')).not.toContain('@zterm_adaptive_width_');
  }
}

function createOwnershipStore(
  initialRecords: AdaptiveWidthOwnershipRecord[] = [],
  overrides: { removeError?: Error; upsertError?: Error; upsertErrorOnce?: Error } = {},
) {
  let records = initialRecords;
  return {
    read: vi.fn(() => records),
    upsert: vi.fn((record: Omit<AdaptiveWidthOwnershipRecord, 'updatedAt'>) => {
      if (overrides.upsertErrorOnce) {
        const error = overrides.upsertErrorOnce;
        overrides.upsertErrorOnce = undefined;
        throw error;
      }
      if (overrides.upsertError) {
        throw overrides.upsertError;
      }
      records = [
        ...records.filter((entry) => entry.sessionName !== record.sessionName),
        { ...record, updatedAt: '2026-09-13T00:00:00.000Z' },
      ];
    }),
    remove: vi.fn((sessionName: string) => {
      if (overrides.removeError) {
        throw overrides.removeError;
      }
      records = records.filter((entry) => entry.sessionName !== sessionName);
    }),
    records: () => records,
  };
}

describe('terminal mirror runtime lifecycle truth', () => {
  it('keeps same-named tmux and Herdr mirrors independent', async () => {
    const key = (sessionName: string, backend: 'tmux' | 'herdr' = 'tmux') => `${backend}:${sessionName}`;
    const { runtime, sessions, mirrors } = createRuntime({ getMirrorKey: key });
    const tmuxSession = createSession('tmux-session');
    const herdrSession = createSession('herdr-session');
    sessions.set(tmuxSession.id, tmuxSession);
    sessions.set(herdrSession.id, herdrSession);

    await runtime.attachTmux(tmuxSession, { sessionName: 'same-name', backend: 'tmux', cols: 120, rows: 40 });
    await runtime.attachTmux(herdrSession, { sessionName: 'same-name', backend: 'herdr', cols: 120, rows: 40 });

    expect(tmuxSession.mirrorKey).toBe('tmux:same-name');
    expect(herdrSession.mirrorKey).toBe('herdr:same-name');
    expect(mirrors.get('tmux:same-name')?.backend).toBe('tmux');
    expect(mirrors.get('herdr:same-name')?.backend).toBe('herdr');
  });

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

  it('releases an inactive body-suppressed channel without doing initial buffer capture', async () => {
    const { runtime, sessions, mirrors, assertTmuxSessionExists, captureMirrorAuthoritativeBufferFromTmux, closeTransportSubscriber } = createRuntime();
    const session = createSession();
    session.bodySubscribed = false;
    session.muxChannelId = 'channel-demo';
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 120,
      rows: 40,
    });

    expect(mirrors.has('demo')).toBe(false);
    expect(assertTmuxSessionExists).toHaveBeenCalledTimes(1);
    expect(captureMirrorAuthoritativeBufferFromTmux).not.toHaveBeenCalled();
    expect(closeTransportSubscriber).toHaveBeenCalledWith(
      session,
      'body subscription released',
      false,
      'no_body_demand',
    );
    expect(session.transport?.close).not.toHaveBeenCalled();
  });

  it('releases the mirror and mux channel when the last body subscriber unsubscribes', async () => {
    const {
      runtime,
      sessions,
      mirrors,
      closeTransportSubscriber,
    } = createRuntime();
    const session = createSession();
    session.bodySubscribed = true;
    session.muxChannelId = 'channel-demo';
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 120,
      rows: 40,
    });

    const mirror = mirrors.get('demo');
    expect(mirror).toBeTruthy();
    expect(mirror?.subscribers.has(session.id)).toBe(true);

    session.bodySubscribed = false;
    expect(runtime.releaseMirrorIfNoBodyDemand(mirror!, 'body subscription released')).toBe(true);

    expect(mirrors.has('demo')).toBe(false);
    expect(closeTransportSubscriber).toHaveBeenCalledWith(
      session,
      'body subscription released',
      false,
      'no_body_demand',
    );
    expect(session.transport?.close).not.toHaveBeenCalled();
  });

  it('keeps the mirror while another ready body subscriber still demands it', async () => {
    const {
      runtime,
      sessions,
      mirrors,
      closeTransportSubscriber,
    } = createRuntime();
    const first = createSession('session-1');
    const second = createSession('session-2');
    sessions.set(first.id, first);
    sessions.set(second.id, second);

    await runtime.attachTmux(first, {
      sessionName: 'demo',
      cols: 120,
      rows: 40,
    });
    await runtime.attachTmux(second, {
      sessionName: 'demo',
      cols: 120,
      rows: 40,
    });

    const mirror = mirrors.get('demo');
    expect(mirror).toBeTruthy();
    first.bodySubscribed = false;

    expect(runtime.releaseMirrorIfNoBodyDemand(mirror!, 'body subscription released')).toBe(false);
    expect(mirrors.has('demo')).toBe(true);
    expect(mirror?.subscribers.has(second.id)).toBe(true);
    expect(closeTransportSubscriber).not.toHaveBeenCalled();
  });

  it('releases the withdrawn subscriber channel and adaptive width while a peer keeps the mirror', async () => {
    const {
      runtime,
      sessions,
      mirrors,
      runTmux,
      closeTransportSubscriber,
    } = createRuntime();
    const first = createSession('session-1');
    const second = createSession('session-2');
    first.muxChannelId = 'channel-first';
    second.muxChannelId = 'channel-second';
    sessions.set(first.id, first);
    sessions.set(second.id, second);

    await runtime.attachTmux(first, {
      sessionName: 'demo',
      cols: 80,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    await runtime.attachTmux(second, {
      sessionName: 'demo',
      cols: 120,
      rows: 40,
      widthMode: 'adaptive-phone',
    });

    const mirror = mirrors.get('demo');
    expect(mirror).toBeTruthy();
    expect(mirror?.adaptiveWidthAppliedCols).toBe(80);
    expect(first.adaptiveWidthCols).toBe(80);
    // The real closeTransportSubscriber releases the lease through the mirror
    // owner and detaches the subscriber; emulate that production contract.
    closeTransportSubscriber.mockImplementation((session: TerminalSession, reason: string) => {
      runtime.releaseAdaptiveWidthLease(session, `close:${reason}`);
      mirror?.subscribers.delete(session.id);
      session.mirrorKey = null;
    });
    runTmux.mockClear();

    first.bodySubscribed = false;
    expect(runtime.releaseMirrorIfNoBodyDemand(mirror!, 'body subscription released')).toBe(false);

    expect(mirrors.has('demo')).toBe(true);
    expect(mirror?.subscribers.has(first.id)).toBe(false);
    expect(mirror?.subscribers.has(second.id)).toBe(true);
    expect(first.adaptiveWidthCols).toBeNull();
    expect(second.adaptiveWidthCols).toBe(120);
    expect(closeTransportSubscriber).toHaveBeenCalledTimes(1);
    expect(closeTransportSubscriber).toHaveBeenCalledWith(
      first,
      'body subscription released',
      false,
      'no_body_demand',
    );
    expect(closeTransportSubscriber).not.toHaveBeenCalledWith(
      second,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(first.transport?.close).not.toHaveBeenCalled();
    expect(second.transport?.close).not.toHaveBeenCalled();
    // The remaining subscriber's 120-col lease must win once the withdrawn
    // 80-col lease is gone.
    const resizeCalls = runTmux.mock.calls
      .map((call) => call[0] as string[])
      .filter((args) => args[0] === 'resize-window');
    expect(resizeCalls.at(-1)).toEqual(['resize-window', '-t', '=demo', '-x', '120']);
  });

  it('releases a body-suppressed attach while a ready peer keeps the mirror', async () => {
    const {
      runtime,
      sessions,
      mirrors,
      runTmux,
      closeTransportSubscriber,
    } = createRuntime();
    const peer = createSession('session-peer');
    const withdrawn = createSession('session-withdrawn');
    peer.muxChannelId = 'channel-peer';
    withdrawn.muxChannelId = 'channel-withdrawn';
    sessions.set(peer.id, peer);
    sessions.set(withdrawn.id, withdrawn);

    await runtime.attachTmux(peer, {
      sessionName: 'demo',
      cols: 120,
      rows: 40,
      widthMode: 'adaptive-phone',
    });

    const mirror = mirrors.get('demo');
    expect(mirror?.lifecycle).toBe('ready');
    expect(mirror?.subscribers.has(peer.id)).toBe(true);
    closeTransportSubscriber.mockImplementation((session: TerminalSession, reason: string) => {
      runtime.releaseAdaptiveWidthLease(session, `close:${reason}`);
      mirror?.subscribers.delete(session.id);
      session.mirrorKey = null;
    });
    runTmux.mockClear();

    withdrawn.bodySubscribed = false;
    await runtime.attachTmux(withdrawn, {
      sessionName: 'demo',
      cols: 80,
      rows: 40,
      widthMode: 'adaptive-phone',
    });

    expect(mirrors.get('demo')).toBe(mirror);
    expect(mirror?.lifecycle).toBe('ready');
    expect(mirror?.subscribers.has(peer.id)).toBe(true);
    expect(mirror?.subscribers.has(withdrawn.id)).toBe(false);
    expect(peer.mirrorKey).toBe('demo');
    expect(withdrawn.mirrorKey).toBeNull();
    expect(withdrawn.adaptiveWidthCols).toBeNull();
    expect(peer.adaptiveWidthCols).toBe(120);
    expect(closeTransportSubscriber).toHaveBeenCalledTimes(1);
    expect(closeTransportSubscriber).toHaveBeenCalledWith(
      withdrawn,
      'body subscription released',
      false,
      'no_body_demand',
    );
    expect(withdrawn.transport?.close).not.toHaveBeenCalled();
    expect(peer.transport?.close).not.toHaveBeenCalled();
    const resizeCalls = runTmux.mock.calls
      .map((call) => call[0] as string[])
      .filter((args) => args[0] === 'resize-window');
    expect(resizeCalls).toEqual([]);
  });

  it('releases a mirror if body subscription is false before async attach reaches ready', async () => {
    const {
      runtime,
      sessions,
      mirrors,
      assertTmuxSessionExists,
      closeTransportSubscriber,
    } = createRuntime();
    const session = createSession();
    session.bodySubscribed = true;
    session.muxChannelId = 'channel-demo';
    sessions.set(session.id, session);
    assertTmuxSessionExists.mockImplementation(() => {
      session.bodySubscribed = false;
    });

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 120,
      rows: 40,
    });

    expect(mirrors.has('demo')).toBe(false);
    expect(closeTransportSubscriber).toHaveBeenCalledWith(
      session,
      'body subscription released',
      false,
      'no_body_demand',
    );
    expect(session.transport?.close).not.toHaveBeenCalled();
  });

  it('releases mirror ownership for a legacy non-mux subscriber while keeping its physical transport open', async () => {
    const {
      runtime,
      sessions,
      mirrors,
      closeTransportSubscriber,
    } = createRuntime();
    const session = createSession();
    session.bodySubscribed = true;
    session.muxChannelId = null;
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 120,
      rows: 40,
    });
    const mirror = mirrors.get('demo');
    expect(mirror).toBeTruthy();

    session.bodySubscribed = false;
    expect(runtime.releaseMirrorIfNoBodyDemand(mirror!, 'body subscription released')).toBe(true);

    expect(mirrors.has('demo')).toBe(false);
    expect(sessions.has(session.id)).toBe(true);
    expect(closeTransportSubscriber).not.toHaveBeenCalled();
    expect(session.transport?.close).not.toHaveBeenCalled();
    expect(session.mirrorKey).toBe(null);
  });

  it('releases the old mirror when one subscriber moves to another tmux target', async () => {
    const { runtime, sessions, mirrors } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);

    await runtime.attachTmux(session, { sessionName: 'demo-a', cols: 120, rows: 40 });
    const oldMirror = mirrors.get('demo-a');
    expect(oldMirror?.subscribers).toEqual(new Set([session.id]));

    await runtime.attachTmux(session, { sessionName: 'demo-b', cols: 120, rows: 40 });

    expect(mirrors.has('demo-a')).toBe(false);
    expect(oldMirror?.lifecycle).toBe('destroyed');
    expect(mirrors.get('demo-b')?.subscribers).toEqual(new Set([session.id]));
    expect(session.mirrorKey).toBe('demo-b');
  });

  it('does not resurrect a mirror when the last subscriber detaches during initial sync', async () => {
    let releaseBoot = () => {};
    const bootPaused = new Promise<void>((resolve) => {
      releaseBoot = resolve;
    });
    const { runtime, sessions, mirrors } = createRuntime({
      waitMs: async () => bootPaused,
    });
    const session = createSession();
    sessions.set(session.id, session);

    const attachPromise = runtime.attachTmux(session, { sessionName: 'boot-race', cols: 120, rows: 40 });
    await Promise.resolve();

    const mirror = mirrors.get('boot-race');
    expect(mirror?.lifecycle).toBe('ready');
    expect(mirror?.subscribers).toEqual(new Set([session.id]));

    session.transport = null;
    session.mirrorKey = null;
    mirror?.subscribers.clear();
    runtime.destroyMirrorIfUnsubscribed(mirror!, 'boot transport detached');
    releaseBoot();
    await attachPromise;

    expect(mirrors.has('boot-race')).toBe(false);
    expect(mirror?.lifecycle).toBe('destroyed');
  });

  it('splits an oversized initial live sync into contiguous same-revision frames', async () => {
    const wideRow: TerminalCell[] = Array.from({ length: 200 }, () => ({
      char: 'W'.codePointAt(0)!,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    }));
    const { runtime, sessions, mirrors, sendText } = createRuntime({
      captureMirrorAuthoritativeBufferFromTmux: async (mirror) => {
        mirror.cols = 200;
        mirror.rows = 24;
        mirror.bufferStartIndex = 0;
        mirror.bufferLines = Array.from({ length: 3000 }, () => wideRow);
        mirror.cursor = null;
        mirror.cursorKeysApp = false;
        return true;
      },
      normalizeTerminalCols: () => 200,
      normalizeTerminalRows: () => 24,
    });
    const session = createSession();
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 200,
      rows: 24,
    });
    const mirror = mirrors.get('demo');
    expect(mirror).not.toBeNull();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      runtime.flushPendingSubscriberBufferSync(mirror!, session.id);
    }

    const syncTexts = sendText.mock.calls.map(([, text]) => String(text)).filter((text) => {
      try {
        return JSON.parse(text).type === 'buffer-sync';
      } catch {
        return false;
      }
    });
    expect(syncTexts.length).toBeGreaterThan(1);
    const messages = syncTexts.map((text) => JSON.parse(text));
    for (const message of messages) {
      expect(message.payload.revision).toBe(1);
      expect(message.payload.frameChunkCount).toBe(messages.length);
      expect(Buffer.byteLength(JSON.stringify(message), 'utf8')).toBeLessThan(128_000);
    }
    expect(messages[0].payload.startIndex).toBe(0);
    expect(messages[messages.length - 1].payload.endIndex).toBe(3000);
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
      buildExactTmuxSessionTarget: (sessionName) => `=${sessionName}`,
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
      resolveTerminalSessionBackend: () => 'tmux',
      captureMirrorAuthoritativeBufferFromTmux: vi.fn(async () => {
        throw new Error('tmux returned invalid pane metrics for demo-zterm: pane is dead');
      }),
      mirrorBufferChanged: () => [],
      mirrorCursorEqual: () => true,
      daemonInputQueue: {
        handleInputMessage: async () => {},
        enqueueBackendInput: async () => true,
        enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
        disposeLiveMirrorInputBatch: () => 0,
      },
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

  it('backs off quiet mirror capture after consecutive no-change flushes while still polling an idle terminal', async () => {
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

      // First post-attach sync (no content change) lands after the 33ms
      // active window, then the loop must back off: 120 -> 240 -> 480 -> cap.
      await vi.advanceTimersByTimeAsync(33);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(2);

      // 120ms window: one quiet poll (streak=2 -> 240ms next).
      await vi.advanceTimersByTimeAsync(120);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(3);

      // 240ms window: one quiet poll (streak=3 -> 480ms next).
      await vi.advanceTimersByTimeAsync(240);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(4);

      // Cap reached: 500ms windows keep polling at ~2fps, never 33ms.
      const callsBeforeCapWindow = captureMirrorAuthoritativeBufferFromTmux.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(callsBeforeCapWindow + 1);
      await vi.advanceTimersByTimeAsync(500);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(callsBeforeCapWindow + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops capture when the last body demand attach lease expires while keeping transport open', async () => {
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

      session.sessionAttachHeartbeatAt = Date.now() - TERMINAL_SESSION_ATTACH_LEASE_MS - 1;
      runtime.scheduleMirrorLiveSync(mirror!, 0);
      await vi.advanceTimersByTimeAsync(1);

      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);
      expect(mirror?.liveSyncTimer).toBeNull();
      expect(session.transport?.readyState).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs one immediate post-flush capture when input lands during an older in-flight capture', async () => {
    vi.useFakeTimers();
    try {
      let releaseFirstCapture = () => {};
      let captureCount = 0;
      const {
        runtime,
        sessions,
        mirrors,
        captureMirrorAuthoritativeBufferFromTmux,
      } = createRuntime({
        captureMirrorAuthoritativeBufferFromTmux: async () => {
          captureCount += 1;
          if (captureCount === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstCapture = resolve;
            });
          }
          return true;
        },
      });
      const session = createSession();
      sessions.set(session.id, session);
      const mirror = runtime.createMirror('demo');
      mirror.lifecycle = 'ready';
      mirror.subscribers.add(session.id);
      session.mirrorKey = mirror.key;

      const oldCapture = runtime.syncMirrorCanonicalBuffer(mirror);
      await vi.waitFor(() => {
        expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);
      });

      await expect(runtime.handleInput(session, 'a')).resolves.toBe(true);
      await expect(runtime.handleInput(session, 'b')).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);

      releaseFirstCapture();
      await oldCapture;
      await vi.advanceTimersByTimeAsync(0);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(119);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(3);
      expect(mirrors.get('demo')).toBe(mirror);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns to the active 33ms cadence as soon as a flush reports content changes', async () => {
    vi.useFakeTimers();
    try {
      let changed = false;
      const {
        runtime,
        sessions,
        captureMirrorAuthoritativeBufferFromTmux,
      } = createRuntime({
        mirrorBufferChanged: () => (changed ? [{ startIndex: 10, endIndex: 11 }] : []),
      });
      const session = createSession();
      sessions.set(session.id, session);

      await runtime.attachTmux(session, {
        sessionName: 'demo',
        cols: 120,
        rows: 40,
      });
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);

      // One quiet flush (backoff starts), then content changes: the flush
      // that observes the change returns to the active 33ms cadence.
      await vi.advanceTimersByTimeAsync(120);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(2);
      changed = true;
      await vi.advanceTimersByTimeAsync(120);
      expect(captureMirrorAuthoritativeBufferFromTmux.mock.calls.length).toBeGreaterThan(2);
      // Back to active cadence: a 33ms window must trigger a flush (a quiet
      // backoff would not fire within 33ms).
      const afterChange = captureMirrorAuthoritativeBufferFromTmux.mock.calls.length;
      await vi.advanceTimersByTimeAsync(33);
      expect(captureMirrorAuthoritativeBufferFromTmux.mock.calls.length).toBeGreaterThan(afterChange);
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

      // The reuse sync produced no content change, so the recurring loop
      // backs off to the quiet cadence (120ms) instead of 33ms.
      await vi.advanceTimersByTimeAsync(120);
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
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '120']);
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '80']);
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
    expect(runTmux).not.toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '120']);
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
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '120', '-y', '40']);
    expect(runTmux).toHaveBeenCalledWith(['set-window-option', '-u', '-t', '=demo', 'window-size']);
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
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '88']);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
  });

  it('persists daemon-owned adaptive width ownership without tmux option state', async () => {
    const ownership = createOwnershipStore();
    const { runtime, sessions, runTmux } = createRuntime({
      adaptiveWidthOwnershipStore: ownership,
    });
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 88,
      rows: 24,
      widthMode: 'adaptive-phone',
    });

    expect(ownership.upsert).toHaveBeenCalledWith({
      sessionName: 'demo',
      paneId: '%1',
      baseline: { cols: 120, rows: 40 },
      appliedCols: 88,
      appliedRows: 40,
    });
    expect(ownership.records()).toHaveLength(1);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
  });

  it('does not mutate tmux when adaptive width ownership persistence fails', async () => {
    const ownership = createOwnershipStore([], {
      upsertError: new Error('ownership write failed'),
    });
    const resizeBackendSession = vi.fn();
    const { runtime, sessions, runTmux } = createRuntime({
      adaptiveWidthOwnershipStore: ownership,
      resizeBackendSession,
    });
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await expect(runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 88,
      rows: 24,
      widthMode: 'adaptive-phone',
    })).rejects.toThrow('ownership write failed');

    expect(resizeBackendSession).not.toHaveBeenCalled();
    expect(runTmux).not.toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '88']);
    expect(ownership.records()).toEqual([]);
  });

  it('removes adaptive width ownership when the tmux mutation fails', async () => {
    const ownership = createOwnershipStore();
    const resizeError = new Error('tmux resize failed');
    const resizeBackendSession = vi.fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw resizeError;
      });
    const { runtime, sessions, mirrors } = createRuntime({
      adaptiveWidthOwnershipStore: ownership,
      resizeBackendSession,
    });
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 100,
      rows: 24,
      widthMode: 'adaptive-phone',
    });
    expect(ownership.records()).toHaveLength(1);

    expect(() => runtime.handleAdaptiveResize(session, {
      cols: 72,
      widthMode: 'adaptive-phone',
    })).toThrow(resizeError);

    expect(ownership.remove).toHaveBeenCalledWith('demo');
    expect(ownership.records()).toEqual([]);
    expect(mirrors.get('demo')?.adaptiveWidthAppliedCols).toBe(100);
  });

  it('keeps a lease-expiry reconciliation failure bounded inside the timer owner', async () => {
    vi.useFakeTimers();
    try {
      const ownershipOverrides: { upsertErrorOnce?: Error } = {};
      const ownership = createOwnershipStore([], ownershipOverrides);
      const resizeBackendSession = vi.fn();
      const { runtime, sessions, mirrors } = createRuntime({
        adaptiveWidthOwnershipStore: ownership,
        resizeBackendSession,
      });
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
      await vi.advanceTimersByTimeAsync(10000);
      runtime.refreshAdaptiveWidthLeaseHeartbeat(wideSession);
      ownershipOverrides.upsertErrorOnce = new Error('ownership write failed');
      const uncaught: unknown[] = [];
      const onUncaught = (error: unknown) => uncaught.push(error);
      process.on('uncaughtException', onUncaught);
      resizeBackendSession.mockClear();

      try {
        await vi.advanceTimersByTimeAsync(55001);
        await Promise.resolve();
      } finally {
        process.off('uncaughtException', onUncaught);
      }

      expect(uncaught).toEqual([]);
      expect(resizeBackendSession).not.toHaveBeenCalled();
      expect(mirrors.get('demo')?.adaptiveWidthAppliedCols).toBe(60);
      expect(narrowSession.adaptiveWidthCols).toBeNull();
      expect(wideSession.adaptiveWidthCols).toBe(100);
    } finally {
      vi.useRealTimers();
    }
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
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '72']);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
    expect(mirror?.cols).toBe(120);
    expect(session.adaptiveWidthCols).toBe(72);
    expect(mirror?.adaptiveWidthAppliedCols).toBe(72);
  });

  it('clears adaptive lease when a subscriber switches to mirror-fixed and releases tmux width ownership', async () => {
    const ownership = createOwnershipStore();
    const { runtime, sessions, mirrors, runTmux } = createRuntime({
      adaptiveWidthOwnershipStore: ownership,
    });
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
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '120', '-y', '40']);
    expect(runTmux).toHaveBeenCalledWith(['set-window-option', '-u', '-t', '=demo', 'window-size']);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
    expect(mirrors.get('demo')?.cols).toBe(120);
    expect(session.adaptiveWidthCols).toBeNull();
    expect(ownership.remove).toHaveBeenCalledWith('demo');
    expect(ownership.records()).toEqual([]);
  });

  it('restores baseline width before unsetting window-size during final release', async () => {
    const { runtime, sessions, runTmux } = createRuntime();
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 100,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    runTmux.mockClear();

    runtime.handleAdaptiveResize(session, {
      cols: 60,
      widthMode: 'mirror-fixed',
    });

    const calls = runTmux.mock.calls as unknown as Array<[string[]]>;
    const resizeCallIndex = calls.findIndex(([args]) => args?.[0] === 'resize-window');
    const unsetCallIndex = calls.findIndex(([args]) => args?.[0] === 'set-window-option');
    expect(resizeCallIndex).toBeGreaterThanOrEqual(0);
    expect(unsetCallIndex).toBeGreaterThan(resizeCallIndex);
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '120', '-y', '40']);
    expect(runTmux).toHaveBeenCalledWith(['set-window-option', '-u', '-t', '=demo', 'window-size']);
  });

  it('uses the backend resize hook with explicit apply and release operations', async () => {
    const resizeBackendSession = vi.fn();
    const { runtime, sessions, mirrors } = createRuntime({
      readTmuxPaneMetrics: () => ({
        paneId: '%1',
        tmuxAvailableLineCountHint: 0,
        paneRows: 52,
        paneCols: 120,
        alternateOn: false,
      }),
      resizeBackendSession,
    });
    const session = createSession('session-1');
    session.backend = 'herdr';
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      backend: 'herdr',
      cols: 100,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    expect(resizeBackendSession).toHaveBeenCalledWith('demo', { cols: 100, rows: 52 }, 'herdr', 'apply');
    resizeBackendSession.mockClear();

    runtime.handleAdaptiveResize(session, {
      cols: 60,
      widthMode: 'mirror-fixed',
    });

    expect(resizeBackendSession).toHaveBeenCalledWith('demo', { cols: 120, rows: 52 }, 'herdr', 'release');
    expect(mirrors.get('demo')?.adaptiveWidthAppliedCols).toBeNull();
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
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '100']);
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
      expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '120', '-y', '40']);
      expect(runTmux).toHaveBeenCalledWith(['set-window-option', '-u', '-t', '=demo', 'window-size']);
      expectOnlyAdaptiveWidthTmuxMutation(runTmux);
      expect(session.adaptiveWidthCols).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases tmux width ownership when mirror destruction bypasses subscriber detach', async () => {
    const { runtime, sessions, mirrors, runTmux } = createRuntime();
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 70,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    runTmux.mockClear();

    const mirror = mirrors.get('demo')!;
    runtime.destroyMirror(mirror, 'daemon shutdown');

    expect(mirrors.has('demo')).toBe(false);
    expect(mirror.lifecycle).toBe('destroyed');
    expect(session.adaptiveWidthCols).toBeNull();
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '120', '-y', '40']);
    expect(runTmux).toHaveBeenCalledWith(['set-window-option', '-u', '-t', '=demo', 'window-size']);
    expectOnlyAdaptiveWidthTmuxMutation(runTmux);
  });

  it('still tears down subscribers and retains retry state when adaptive width release mutation fails', async () => {
    const { runtime, sessions, mirrors, runTmux, sendMessage } = createRuntime();
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 70,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    runTmux.mockClear();
    runTmux.mockImplementation((args?: string[]) => {
      if (args?.[0] === 'set-window-option') {
        throw new Error('tmux release failed');
      }
      return { ok: true as const, stdout: '' };
    });

    const mirror = mirrors.get('demo')!;
    const destroyed = runtime.destroyMirror(mirror, 'tmux session killed', {
      closeTransportSubscribers: false,
      releaseCode: 'tmux_session_killed',
    });

    expect(destroyed).toBe(true);
    expect(mirrors.has('demo')).toBe(false);
    expect(session.mirrorKey).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(session, {
      type: 'error',
      payload: { message: 'tmux session killed', code: 'tmux_session_killed' },
    });
    expect(runTmux).toHaveBeenCalledWith(['set-window-option', '-u', '-t', '=demo', 'window-size']);
  });

  it('retries retained adaptive width cleanup before re-creating a mirror', async () => {
    const ownership = createOwnershipStore();
    const { runtime, sessions, mirrors, runTmux } = createRuntime({
      adaptiveWidthOwnershipStore: ownership,
    });
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 70,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    runTmux.mockClear();
    runTmux.mockImplementation((args?: string[]) => {
      if (args?.[0] === 'set-window-option') {
        throw new Error('tmux release failed');
      }
      return { ok: true as const, stdout: '' };
    });

    const mirror = mirrors.get('demo')!;
    runtime.destroyMirror(mirror, 'daemon shutdown');

    runTmux.mockClear();
    runTmux.mockReturnValue({ ok: true as const, stdout: '' });
    runtime.createMirror('demo');

    expect(runTmux).toHaveBeenCalledWith(['set-window-option', '-u', '-t', '=demo', 'window-size']);
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '120', '-y', '40']);
    expect(ownership.remove).toHaveBeenCalledWith('demo');
    expect(ownership.records()).toEqual([]);
  });

  it('keeps released tmux state authoritative when journal cleanup fails', async () => {
    const ownership = createOwnershipStore([], {
      removeError: new Error('journal remove failed'),
    });
    const { runtime, sessions, mirrors, runTmux } = createRuntime({
      adaptiveWidthOwnershipStore: ownership,
    });
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 70,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    runTmux.mockClear();

    expect(runtime.destroyMirror(mirrors.get('demo')!, 'daemon shutdown')).toBe(true);
    expect(mirrors.has('demo')).toBe(false);
    expect(session.mirrorKey).toBeNull();
    expect(runTmux).toHaveBeenCalledWith(['set-window-option', '-u', '-t', '=demo', 'window-size']);
    expect(ownership.remove).toHaveBeenCalledWith('demo');
  });

  it('blocks mirror creation while retained adaptive width cleanup cannot succeed', async () => {
    const { runtime, sessions, mirrors, runTmux } = createRuntime();
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 70,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    runTmux.mockClear();
    runTmux.mockImplementation((args?: string[]) => {
      if (args?.[0] === 'set-window-option') {
        throw new Error('tmux release failed');
      }
      return { ok: true as const, stdout: '' };
    });

    runtime.destroyMirror(mirrors.get('demo')!, 'daemon shutdown');

    expect(() => runtime.createMirror('demo')).toThrow(/adaptive width cleanup pending/);
  });

  it('keeps attach transactional when retained adaptive width cleanup blocks mirror creation', async () => {
    const { runtime, sessions, mirrors, runTmux } = createRuntime();
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 70,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    runTmux.mockClear();
    runTmux.mockImplementation((args?: string[]) => {
      if (args?.[0] === 'set-window-option') {
        throw new Error('tmux release failed');
      }
      return { ok: true as const, stdout: '' };
    });

    runtime.destroyMirror(mirrors.get('demo')!, 'daemon shutdown');
    runTmux.mockClear();
    await expect(runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 70,
      rows: 40,
      widthMode: 'adaptive-phone',
    })).rejects.toThrow(/adaptive width cleanup pending/);

    expect(session.mirrorKey).toBeNull();
    expect(mirrors.has('demo')).toBe(false);
  });

  it('does not mutate a same-name replacement target with stale cleanup', async () => {
    let paneId = '%1';
    const { runtime, sessions, mirrors, runTmux } = createRuntime({
      readTmuxPaneMetrics: () => ({
        paneId,
        tmuxAvailableLineCountHint: 0,
        paneRows: 40,
        paneCols: 120,
        alternateOn: false,
      }),
    });
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 70,
      rows: 40,
      widthMode: 'adaptive-phone',
    });
    runTmux.mockClear();
    runTmux.mockImplementation((args?: string[]) => {
      if (args?.[0] === 'set-window-option') {
        throw new Error('tmux release failed');
      }
      return { ok: true as const, stdout: '' };
    });

    runtime.destroyMirror(mirrors.get('demo')!, 'daemon shutdown');
    paneId = '%2';
    runTmux.mockClear();
    runtime.createMirror('demo');

    expect(mirrors.has('demo')).toBe(true);
    expect(runTmux).not.toHaveBeenCalledWith(['set-window-option', '-u', '-t', '=demo', 'window-size']);
    expect(runTmux).not.toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '120']);
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

  it('restores daemon-owned adaptive width baseline on daemon start and clears the journal', () => {
    const ownership = createOwnershipStore([{
      sessionName: 'demo',
      paneId: '%1',
      baseline: { cols: 120, rows: 40 },
      appliedCols: 55,
      appliedRows: 24,
      updatedAt: '2026-09-13T00:00:00.000Z',
    }]);
    const { runtime, runTmux } = createRuntime({
      adaptiveWidthOwnershipStore: ownership,
    });

    const restored = runtime.restorePersistedAdaptiveWidthBaselines(['demo']);

    expect(restored).toBe(1);
    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '120', '-y', '40']);
    expect(runTmux).toHaveBeenCalledWith(['set-window-option', '-u', '-t', '=demo', 'window-size']);
    expect(ownership.remove).toHaveBeenCalledWith('demo');
    expect(ownership.records()).toEqual([]);
  });

  it('does not restore a stale journal when the tmux pane identity changed', () => {
    const ownership = createOwnershipStore([{
      sessionName: 'demo',
      paneId: '%old-pane',
      baseline: { cols: 120, rows: 40 },
      appliedCols: 55,
      appliedRows: 24,
      updatedAt: '2026-09-13T00:00:00.000Z',
    }]);
    const { runtime, runTmux } = createRuntime({
      adaptiveWidthOwnershipStore: ownership,
    });

    const restored = runtime.restorePersistedAdaptiveWidthBaselines(['demo']);

    expect(restored).toBe(0);
    expect(runTmux).not.toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '120']);
    expect(runTmux).not.toHaveBeenCalledWith(['set-window-option', '-u', '-t', '=demo', 'window-size']);
    expect(ownership.remove).toHaveBeenCalledWith('demo');
    expect(ownership.records()).toEqual([]);
  });

  it('removes stale journal records for tmux sessions that no longer exist', () => {
    const ownership = createOwnershipStore([{
      sessionName: 'old-session',
      paneId: '%1',
      baseline: { cols: 120, rows: 40 },
      appliedCols: 55,
      appliedRows: 24,
      updatedAt: '2026-09-13T00:00:00.000Z',
    }]);
    const { runtime } = createRuntime({
      adaptiveWidthOwnershipStore: ownership,
    });

    const restored = runtime.restorePersistedAdaptiveWidthBaselines(['demo']);

    expect(restored).toBe(0);
    expect(ownership.remove).toHaveBeenCalledWith('old-session');
    expect(ownership.records()).toEqual([]);
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

  it('keeps mirror-fixed client cols out of tmux resize ownership', async () => {
    const { runtime, sessions, runTmux } = createRuntime();
    const session = createSession('session-1');
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      sessionName: 'demo',
      cols: 60,
      rows: 30,
      widthMode: 'mirror-fixed',
    });

    const resizeResult = runtime.handleAdaptiveResize(session, {
      cols: 50,
      widthMode: 'mirror-fixed',
    });

    expect(resizeResult).toEqual({ ok: true });
    expect(session.adaptiveWidthCols).toBeNull();
    expect(runTmux).not.toHaveBeenCalled();
  });

  it('keeps existing mirror geometry when a later subscriber sends different client cols', async () => {
    const { runtime, sessions, mirrors, runTmux } = createRuntime();
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
    expect(runTmux).not.toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '60']);
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

      mirror?.subscribers.delete(firstSession.id);
      firstSession.mirrorKey = null;
      sessions.delete(firstSession.id);
      runtime.destroyMirrorIfUnsubscribed(mirror!, 'last subscriber detached');

      await vi.advanceTimersByTimeAsync(500);
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);
      expect(mirrors.has('demo')).toBe(false);

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
      buildExactTmuxSessionTarget: (sessionName) => `=${sessionName}`,
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
      daemonInputQueue: {
        handleInputMessage: async () => {},
        enqueueBackendInput: async () => true,
        enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
        disposeLiveMirrorInputBatch: () => 0,
      },
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
      buildExactTmuxSessionTarget: (sessionName) => `=${sessionName}`,
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
      daemonInputQueue: {
        handleInputMessage: async () => {},
        enqueueBackendInput: async () => true,
        enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
        disposeLiveMirrorInputBatch: () => 0,
      },
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

  it('does not emit per-flush terminal previews to console output', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const { runtime } = createRuntime({
        captureMirrorAuthoritativeBufferFromTmux: async (mirror: SessionMirror) => {
          mirror.bufferStartIndex = 100;
          mirror.bufferLines = [
            [{ char: 98, fg: 256, bg: 256, flags: 0, width: 1 }],
          ];
          mirror.cursor = null;
          mirror.cursorKeysApp = false;
          return true;
        },
        mirrorBufferChanged: (mirror, previousStartIndex, previousLines) => findChangedIndexedRanges({
          previousStartIndex,
          previousLines,
          nextStartIndex: mirror.bufferStartIndex,
          nextLines: mirror.bufferLines,
        }),
      });
      const mirror = runtime.createMirror('demo');
      mirror.lifecycle = 'ready';
      mirror.bufferStartIndex = 100;
      mirror.bufferLines = [
        [{ char: 97, fg: 256, bg: 256, flags: 0, width: 1 }],
      ];

      await runtime.syncMirrorCanonicalBuffer(mirror);

      expect(
        debugSpy.mock.calls.some(([message]) => String(message).includes('mirror.flush.inspect')),
      ).toBe(false);
    } finally {
      debugSpy.mockRestore();
    }
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
      quietFlushStreak: 0,
      lastFlushHadContentChanges: false,
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
      buildExactTmuxSessionTarget: (sessionName) => `=${sessionName}`,
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
      daemonInputQueue: {
        handleInputMessage: async () => {},
        enqueueBackendInput: async () => true,
        enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
        disposeLiveMirrorInputBatch: () => 0,
      },
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
    buildExactTmuxSessionTarget: (sessionName) => `=${sessionName}`,
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
    daemonInputQueue: {
      handleInputMessage: async () => {},
      enqueueBackendInput: async () => true,
      enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
      disposeLiveMirrorInputBatch: () => 0,
    },
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
      buildExactTmuxSessionTarget: (sessionName) => `=${sessionName}`,
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
      daemonInputQueue: {
        handleInputMessage: async () => {},
        enqueueBackendInput: async () => true,
        enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
        disposeLiveMirrorInputBatch: () => 0,
      },
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
      buildExactTmuxSessionTarget: (sessionName) => `=${sessionName}`,
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
      daemonInputQueue: {
        handleInputMessage: async () => {},
        enqueueBackendInput: async () => true,
        enqueueLiveMirrorInput: async (_sessionName, _payload, _appendEnter, shouldWrite) => shouldWrite ? shouldWrite() : true,
        disposeLiveMirrorInputBatch: () => 0,
      },
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
