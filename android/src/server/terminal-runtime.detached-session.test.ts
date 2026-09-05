import { describe, expect, it, vi } from 'vitest';
import { createTerminalRuntime } from './terminal-runtime';
import { createTerminalChannelMuxRuntime } from './terminal-channel-mux-runtime';
import type { TerminalSession, SessionMirror, TerminalTransportConnection } from './terminal-runtime-types';

function createTransportConnection(id: string): TerminalTransportConnection {
  return {
    transportId: id,
    transport: {
      kind: 'ws',
      readyState: 1,
      requestOrigin: undefined,
      connectedSent: false,
      sendText: vi.fn(),
      close: vi.fn(),
    },
    closeTransport: vi.fn(),
    requestOrigin: 'http://127.0.0.1:3333',
    role: 'pending',
    boundSubscriberId: null,
  };
}

function createDeps() {
  const sessions = new Map<string, TerminalSession>();
  const mirrors = new Map<string, SessionMirror>();
  const runTmux = vi.fn(() => ({ ok: true as const, stdout: '' }));
  const sendText = vi.fn();
  const daemonInputQueue = {
    handleInputMessage: vi.fn(async () => {}),
    enqueueBackendInput: vi.fn(async () => true),
    enqueueLiveMirrorInput: vi.fn(async (_sessionName: string, _payload: string, _appendEnter: boolean, shouldWrite?: () => boolean) => (
      shouldWrite ? shouldWrite() : true
    )),
    disposeLiveMirrorInputBatch: vi.fn(() => 0),
  };
  let paneMetrics = {
    paneId: '%1',
    tmuxAvailableLineCountHint: 0,
    paneRows: 40,
    paneCols: 120,
    alternateOn: false,
  };
  return {
    sessions,
    mirrors,
    runTmux,
    setPaneMetrics: (next: Partial<typeof paneMetrics>) => {
      paneMetrics = {
        ...paneMetrics,
        ...next,
      };
    },
    runtime: createTerminalRuntime({
      buildExactTmuxSessionTarget: (sessionName) => `=${sessionName}`,
      defaultSessionName: 'default',
      defaultViewport: { cols: 120, rows: 40 },
      sessions,
      mirrors,
      sendMessage: vi.fn(),
      sendText,
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
      buildChangedRangesBufferSyncPayload: (mirror: SessionMirror) => ({
        revision: mirror.revision,
        startIndex: mirror.bufferStartIndex,
        endIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
        availableStartIndex: mirror.bufferStartIndex,
        availableEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
        cols: mirror.cols,
        rows: mirror.rows,
        cursorKeysApp: mirror.cursorKeysApp,
        cursor: mirror.cursor,
        lines: [],
      }),
      sanitizeSessionName: (input?: string) => input?.trim() || 'demo',
      getMirrorKey: (sessionName: string) => sessionName,
      normalizeTerminalCols: (cols: number | undefined) => cols || 120,
      normalizeTerminalRows: (rows: number | undefined) => rows || 40,
      resolveAttachGeometry: ({ requestedGeometry, currentMirrorGeometry, existingTmuxGeometry, previousSessionGeometry }) => (
        requestedGeometry || currentMirrorGeometry || existingTmuxGeometry || previousSessionGeometry
      ),
      readTmuxPaneMetrics: () => ({ ...paneMetrics }),
      assertTmuxSessionExists: vi.fn(),
      captureMirrorAuthoritativeBufferFromTmux: vi.fn(async () => true),
      mirrorBufferChanged: vi.fn(() => []),
      mirrorCursorEqual: vi.fn(() => true),
      daemonInputQueue,
      autoCommandDelayMs: 0,
      waitMs: async () => {},
      runTmux,
      daemonRuntimeDebug: vi.fn(),
      logTimePrefix: () => '2026-05-03 00:00:00',
    }),
    channelMuxRuntime: createTerminalChannelMuxRuntime({
      sessions,
      sendText,
      defaultSessionName: 'default',
    }),
    daemonInputQueue,
    sendText,
  };
}

describe('terminal runtime detached transport cleanup', () => {
  it('creates mux channel subscribers without rebinding the physical connection to a single subscriber', () => {
    const { channelMuxRuntime, sessions } = createDeps();
    const connection = createTransportConnection('transport-1');

    const first = channelMuxRuntime.createMuxChannelSubscriber(connection, 'channel-a');
    const second = channelMuxRuntime.createMuxChannelSubscriber(connection, 'channel-b');

    expect(connection.boundSubscriberId).toBeNull();
    expect(connection.muxChannels?.get('channel-a')).toBe(first.id);
    expect(connection.muxChannels?.get('channel-b')).toBe(second.id);
    expect(sessions.get(first.id)).toBe(first);
    expect(sessions.get(second.id)).toBe(second);
    expect(first.transport).not.toBe(connection.transport);
    expect(second.transport).not.toBe(connection.transport);
    expect(first.transportId).toBe(connection.transportId);
    expect(second.transportId).toBe(connection.transportId);
  });

  it('wraps mux channel subscriber outbound messages in a channel envelope over the physical transport', () => {
    const { channelMuxRuntime, sendText } = createDeps();
    const connection = createTransportConnection('transport-1');
    const session = channelMuxRuntime.createMuxChannelSubscriber(connection, 'channel-a');

    session.transport?.sendText(JSON.stringify({
      type: 'title',
      payload: 'demo',
    }));

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(connection.transport, expect.stringContaining('"type":"mux-channel-message"'));
    const frame = JSON.parse(String(sendText.mock.calls[0]?.[1])) as {
      type: string;
      payload: {
        channelId: string;
        message: unknown;
      };
    };
    expect(frame).toEqual({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-a',
        message: {
          type: 'title',
          payload: 'demo',
        },
      },
    });
  });

  it('owns channel registry initialization and per-channel/all-channel release', () => {
    const { channelMuxRuntime, sessions } = createDeps();
    const connection = createTransportConnection('transport-1');

    expect(connection.muxChannels).toBeUndefined();
    channelMuxRuntime.ensureMuxChannels(connection);
    expect(connection.muxChannels).toBeInstanceOf(Map);

    const first = channelMuxRuntime.createMuxChannelSubscriber(connection, 'channel-a');
    const second = channelMuxRuntime.createMuxChannelSubscriber(connection, 'channel-b');
    expect(channelMuxRuntime.listMuxChannelSubscriberIds(connection)).toEqual([first.id, second.id]);

    expect(channelMuxRuntime.releaseMuxChannelSubscriber(connection, 'channel-a')).toBe(true);
    expect(connection.muxChannels?.has('channel-a')).toBe(false);
    expect(channelMuxRuntime.releaseMuxChannelSubscriber(connection, 'missing')).toBe(false);

    const released = channelMuxRuntime.releaseAllMuxChannelSubscribers(connection);
    expect(released).toEqual([second.id]);
    expect(connection.muxChannels?.size).toBe(0);
    expect(sessions.size).toBe(2);
  });

  it('removes detached transport-bound sessions from runtime maps and mirror subscribers', () => {
    const { runtime, sessions, mirrors, daemonInputQueue } = createDeps();
    const connection = createTransportConnection('transport-1');
    const session = runtime.createTransportSubscriber(connection);
    const mirror: SessionMirror = {
      key: 'demo',
      sessionName: 'demo',
      backend: 'tmux',
      scratchBridge: null,
      lifecycle: 'ready',
      cols: 120,
      rows: 40,
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
      liveSyncTimer: null,
      consecutiveFailures: 0,
      subscribers: new Set([session.id]),
      quietFlushStreak: 0,
      lastFlushHadContentChanges: false,
    };

    mirrors.set(mirror.key, mirror);
    session.sessionName = mirror.sessionName;
    session.mirrorKey = mirror.key;

    expect(sessions.has(session.id)).toBe(true);
    expect(mirror.subscribers.has(session.id)).toBe(true);

    runtime.detachSubscriberTransportOnly(session, 'websocket closed', connection.transportId);

    expect(sessions.has(session.id)).toBe(false);
    expect(session.transport).toBeNull();
    expect(session.mirrorKey).toBeNull();
    expect(mirror.subscribers.has(session.id)).toBe(false);
    expect(mirrors.has(mirror.key)).toBe(false);
    expect(mirror.lifecycle).toBe('destroyed');
    expect(daemonInputQueue.disposeLiveMirrorInputBatch).toHaveBeenCalledWith(
      'demo',
      'destroy:transport detached: websocket closed',
      'tmux',
    );
  });

  it('releases only the final subscriber mirror and never kills the tmux session', () => {
    const { runtime, sessions, mirrors, daemonInputQueue, runTmux } = createDeps();
    const firstConnection = createTransportConnection('transport-1');
    const secondConnection = createTransportConnection('transport-2');
    const first = runtime.createTransportSubscriber(firstConnection);
    const second = runtime.createTransportSubscriber(secondConnection);
    const mirror = runtime.createMirror('demo');
    mirror.lifecycle = 'ready';
    mirror.subscribers.add(first.id);
    mirror.subscribers.add(second.id);
    first.sessionName = mirror.sessionName;
    first.mirrorKey = mirror.key;
    second.sessionName = mirror.sessionName;
    second.mirrorKey = mirror.key;

    runtime.detachSubscriberTransportOnly(first, 'first websocket closed', firstConnection.transportId);

    expect(mirrors.get(mirror.key)).toBe(mirror);
    expect(mirror.lifecycle).toBe('ready');
    expect(mirror.subscribers).toEqual(new Set([second.id]));
    expect(sessions.has(second.id)).toBe(true);
    expect(daemonInputQueue.disposeLiveMirrorInputBatch).not.toHaveBeenCalled();
    expect(runTmux).not.toHaveBeenCalledWith(['kill-session', '-t', '=demo']);

    runtime.detachSubscriberTransportOnly(second, 'second websocket closed', secondConnection.transportId);

    expect(mirrors.has(mirror.key)).toBe(false);
    expect(mirror.lifecycle).toBe('destroyed');
    expect(daemonInputQueue.disposeLiveMirrorInputBatch).toHaveBeenCalledTimes(1);
    expect(runTmux).not.toHaveBeenCalledWith(['kill-session', '-t', '=demo']);
  });

  it('releases a closed mux subscriber without closing an unrelated sibling', () => {
    const { runtime, sessions, mirrors, daemonInputQueue } = createDeps();
    const first = runtime.createTransportSubscriber(createTransportConnection('transport-1'));
    const second = runtime.createTransportSubscriber(createTransportConnection('transport-2'));
    const mirror = runtime.createMirror('demo');
    mirror.lifecycle = 'ready';
    mirror.subscribers = new Set([first.id, second.id]);
    first.sessionName = mirror.sessionName;
    first.mirrorKey = mirror.key;
    second.sessionName = mirror.sessionName;
    second.mirrorKey = mirror.key;

    runtime.closeTransportSubscriber(first, 'mux channel closed');

    expect(sessions.has(first.id)).toBe(false);
    expect(sessions.has(second.id)).toBe(true);
    expect(second.transport).not.toBeNull();
    expect(mirrors.get(mirror.key)).toBe(mirror);
    expect(mirror.subscribers).toEqual(new Set([second.id]));
    expect(daemonInputQueue.disposeLiveMirrorInputBatch).not.toHaveBeenCalled();
  });

  it('detaches subscribers without mutating tmux width policy', () => {
    const { runtime, mirrors, runTmux, setPaneMetrics } = createDeps();
    const connection = createTransportConnection('transport-1');
    const session = runtime.createTransportSubscriber(connection);
    setPaneMetrics({
      paneCols: 99,
      paneRows: 56,
    });
    const mirror: SessionMirror = {
      key: 'demo',
      sessionName: 'demo',
      scratchBridge: null,
      lifecycle: 'ready',
      cols: 56,
      rows: 24,
      baselineCols: 56,
      baselineRows: 24,
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
      liveSyncTimer: null,
      consecutiveFailures: 0,
      subscribers: new Set([session.id]),
      quietFlushStreak: 0,
      lastFlushHadContentChanges: false,
    };

    mirrors.set(mirror.key, mirror);
    session.sessionName = mirror.sessionName;
    session.mirrorKey = mirror.key;

    runtime.detachSubscriberTransportOnly(session, 'websocket closed', connection.transportId);

    expect(runTmux).not.toHaveBeenCalledWith(['set-window-option', '-u', '-t', '=demo', 'window-size']);
    expect(mirror.cols).toBe(56);
    expect(mirror.rows).toBe(24);
    expect(mirror.baselineCols).toBe(56);
    expect(mirror.baselineRows).toBe(24);
    expect(mirror).not.toHaveProperty('adaptiveCols');
  });

  it('detaches adaptive subscribers by releasing tmux width ownership without self-writing mirror geometry', () => {
    const { runtime, mirrors, runTmux } = createDeps();
    const connection = createTransportConnection('transport-1');
    const session = runtime.createTransportSubscriber(connection);
    const mirror: SessionMirror = {
      key: 'demo',
      sessionName: 'demo',
      scratchBridge: null,
      lifecycle: 'ready',
      cols: 55,
      rows: 24,
      baselineCols: 55,
      baselineRows: 24,
      backend: 'tmux',
      adaptiveWidthBaselineGeometry: { cols: 120, rows: 40 },
      adaptiveWidthAppliedCols: 55,
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
      liveSyncTimer: null,
      consecutiveFailures: 0,
      subscribers: new Set([session.id]),
      quietFlushStreak: 0,
      lastFlushHadContentChanges: false,
    };

    mirrors.set(mirror.key, mirror);
    session.sessionName = mirror.sessionName;
    session.mirrorKey = mirror.key;
    session.adaptiveWidthCols = 55;
    session.adaptiveWidthHeartbeatAt = Date.now();

    runtime.detachSubscriberTransportOnly(session, 'websocket closed', connection.transportId);

    expect(runTmux).toHaveBeenCalledWith(['resize-window', '-t', '=demo', '-x', '120']);
    expect(runTmux).toHaveBeenCalledWith(['set-window-option', '-u', '-t', '=demo', 'window-size']);
    expect(mirror.cols).toBe(55);
    expect(mirror.rows).toBe(24);
    expect(session.adaptiveWidthCols).toBeNull();
  });
});
