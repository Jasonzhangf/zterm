import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES } from '@zterm/shared/terminal/input-chunking';
import type { TerminalTransportServerFrame } from '@zterm/shared/protocol';
import { createTerminalMessageRuntime } from './terminal-message-runtime';
import type { TerminalMessageRuntimeDeps } from './terminal-message-runtime';
import type {
  TerminalSession,
  TerminalSessionTransport,
  SessionMirror,
  TerminalTransportConnection,
} from './terminal-runtime-types';
import type { TerminalFileTransferRuntime } from './terminal-file-transfer-runtime';
import type { RemoteWindowStreamDaemonRuntime } from './remote-window-stream-daemon';

function createTransport(): TerminalSessionTransport {
  return {
    kind: 'ws',
    readyState: 1,
    requestOrigin: 'http://127.0.0.1:3333',
    connectedSent: false,
    sendText: vi.fn(),
    close: vi.fn(),
  };
}

function createConnection(boundSubscriberId: string | null = null): TerminalTransportConnection {
  return {
    transportId: 'transport-1',
    transport: createTransport(),
    closeTransport: vi.fn(),
    requestOrigin: 'http://127.0.0.1:3333',
    role: boundSubscriberId ? 'session' : 'pending',
    boundSubscriberId,
  };
}

function bindSessionToConnection(session: TerminalSession, connection: TerminalTransportConnection) {
  session.id = connection.transportId;
  session.transportId = connection.transportId;
  session.transport = connection.transport;
  session.closeTransport = connection.closeTransport;
  connection.boundSubscriberId = session.id;
  connection.role = 'session';
}

function createSession(id = 'session-1'): TerminalSession {
  return {
    id,
    transportId: 'transport-1',
    transport: createTransport(),
    closeTransport: vi.fn(),
    sessionName: 'demo',
    mirrorKey: 'demo',
    bodySubscribed: true,
    pendingPasteImage: null,
    pendingAttachFile: null,
  };
}

function makeRemoteWindowTargetManifest() {
  return {
    streamTargetId: 'iterm2-pane:window:tab:pane',
    videoTarget: {
      kind: 'iterm2-pane' as const,
      appBundleId: 'com.googlecode.iterm2',
      pid: 0,
      windowId: 'window',
      title: 'pane',
      windowBoundsTopLeftPx: { x: 0, y: 10, width: 800, height: 600 },
      paneRectInContentPx: { x: 0, y: 20, width: 800, height: 300 },
      cropRectTopLeftPx: { x: 0, y: 30, width: 800, height: 300 },
      contentTopInsetPx: 10,
    },
    inputTarget: {
      kind: 'tmux-pane' as const,
      itermSessionId: 'pane',
      tty: '/dev/ttys001',
      tmuxSession: 'zterm',
      tmuxWindowId: '@1',
      tmuxPaneId: '%2',
    },
    streamMode: 'view' as const,
    focusPolicy: 'no-focus-steal' as const,
    inputRoute: 'tmux-input' as const,
    capture: {
      source: 'ScreenCaptureKit' as const,
      coordinateSpace: 'macos-top-left-px' as const,
      scale: 1,
      createdAt: '2026-07-19T00:00:00.000Z',
    },
  };
}

function createReadyMirror(): SessionMirror {
  return {
    key: 'demo',
    sessionName: 'demo',
    scratchBridge: null,
    lifecycle: 'ready',
    cols: 120,
    rows: 40,
    cursorKeysApp: false,
    revision: 3,
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
    subscribers: new Set(),
  };
}

function createFileTransferRuntimeStub(): TerminalFileTransferRuntime {
  return {
    handlePasteImage: vi.fn(),
    handleFileListRequest: vi.fn(),
    handleFileCreateDirectoryRequest: vi.fn(),
    handleFileDownloadRequest: vi.fn(),
    handleRemoteScreenshotRequest: vi.fn(async () => {}),
    handleFileUploadStart: vi.fn(),
    handleFileUploadChunk: vi.fn(),
    handleFileUploadEnd: vi.fn(),
    handleBinaryPayload: vi.fn(),
  };
}

function flushAsyncHandlers() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createRuntime(options?: {
  mirror?: SessionMirror | null;
  passThroughTransportSend?: boolean;
  failSessionActivityPublish?: boolean;
  failAttachTmux?: boolean;
}) {
  type RemoteWindowListTargetsResult = Awaited<ReturnType<RemoteWindowStreamDaemonRuntime['listTargets']>>;
      type RemoteWindowStartStreamResult = Awaited<ReturnType<RemoteWindowStreamDaemonRuntime['startStream']>>;
      type RemoteWindowStopStreamResult = Awaited<ReturnType<RemoteWindowStreamDaemonRuntime['stopStream']>>;
      type RemoteWindowQualityResult = Awaited<ReturnType<RemoteWindowStreamDaemonRuntime['updateStreamQuality']>>;
      type RemoteWindowInputResult = Awaited<ReturnType<RemoteWindowStreamDaemonRuntime['injectInput']>>;
  const sessions = new Map<string, TerminalSession>();
  const sendTransportMessage = vi.fn((transport: TerminalSessionTransport | null | undefined, message: TerminalTransportServerFrame) => {
    if (
      options?.failSessionActivityPublish
      && message.type === 'mux-target-message'
      && message.payload.message.type === 'session-activity'
    ) {
      throw new Error('forced session activity send failure');
    }
    if (options?.passThroughTransportSend && transport?.sendText) {
      transport.sendText(JSON.stringify(message));
    }
  });
  const sendMessage = vi.fn();
  const sendBufferHeadToSession = vi.fn();
  const scheduleMirrorLiveSync = vi.fn();
  const refreshMirrorHeadForSession = vi.fn(async () => true);
  const handleInput = vi.fn(async () => true) as unknown as ReturnType<typeof vi.fn> & TerminalMessageRuntimeDeps['handleInput'];
  const closeSession = vi.fn();
  const handleClientDebugLog = vi.fn();
  const handleClientDebugSnapshot = vi.fn();
  const handleAdaptiveResize = vi.fn();
  const daemonRuntimeDebug = vi.fn();
  const terminalFileTransferRuntime = createFileTransferRuntimeStub();
  const listRemoteWindowTargets = vi.fn(async (): Promise<RemoteWindowListTargetsResult> => ({
      requestId: 'remote-window-default',
      targets: [],
    }));
  const remoteWindowStreamRuntime = {
    listTargets: listRemoteWindowTargets,
    startStream: vi.fn(async (): Promise<RemoteWindowStartStreamResult> => ({
      requestId: 'remote-window-start-default',
      streamId: 'stream-default',
      targetId: 'target-default',
      answer: { type: 'answer', sdp: 'answer-sdp' },
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 12,
        targetKind: 'app-window',
      },
      transport: { kind: 'webrtc-video' },
    })),
    addIceCandidate: vi.fn(async () => true),
    stopStream: vi.fn(async (): Promise<RemoteWindowStopStreamResult> => ({
      requestId: 'remote-window-stop-default',
      streamId: 'stream-default',
      phase: 'stopped',
    })),
    updateStreamQuality: vi.fn(async (): Promise<RemoteWindowQualityResult> => ({
      requestId: 'remote-window-quality-default',
      streamId: 'stream-default',
      targetId: 'target-default',
      accepted: true,
      videoBitrate: { preset: '5mbps', bitrateMbps: 5, maxBitrateBps: 5_000_000 },
    })),
    injectInput: vi.fn(async (): Promise<RemoteWindowInputResult> => ({
      requestId: 'remote-window-input-default',
      streamId: 'stream-default',
      targetId: 'target-default',
      accepted: true,
    })),
    dispose: vi.fn(),
  };

  const attachmentDeliveryRuntime = {
    listForDevice: vi.fn(async () => []),
    readAsset: vi.fn(async () => ({ manifest: { attachmentId: 'test', kind: 'image' as const, mimeType: 'image/png', preview: { sha256: 'a', size: 1 }, original: { sha256: 'b', size: 2 } }, data: Buffer.from('') })),
    acknowledge: vi.fn(async () => {}),
  };

  const createMuxChannelSubscriber = vi.fn((connection: TerminalTransportConnection, channelId: string) => {
    const subscriber = createSession(`${connection.transportId}:${channelId}`);
    subscriber.transportId = connection.transportId;
    subscriber.transport = createTransport();
    subscriber.closeTransport = vi.fn();
    subscriber.muxChannelId = channelId;
    subscriber.muxParentTransportId = connection.transportId;
    if (!connection.muxChannels) {
      connection.muxChannels = new Map();
    }
    connection.muxChannels.set(channelId, subscriber.id);
    sessions.set(subscriber.id, subscriber);
    return subscriber;
  });

  const runtime = createTerminalMessageRuntime({
    sessions,
    sendTransportMessage,
    sendMessage,
    normalizeBufferSyncRequestPayload: (_session, request) => request,
    getSessionMirror: () => options?.mirror ?? null,
    sendBufferHeadToSession,
    scheduleMirrorLiveSync,
    refreshMirrorHeadForSession,
    handleInput,
    closeSession,
    terminalFileTransferRuntime,
    attachmentDeliveryRuntime,
    remoteWindowStreamRuntime,
    handleClientDebugLog,
    handleClientDebugSnapshot,
    daemonRuntimeDebug,
    controlRuntimeDeps: {
      sessions,
      mirrors: new Map<string, SessionMirror>(),
      issueSessionTransportToken: vi.fn(() => 'token'),
      consumeSessionTransportToken: vi.fn(() => true),
      scheduleEngine: {
        listBySession: vi.fn(() => []),
        upsert: vi.fn(),
        delete: vi.fn(),
        toggle: vi.fn(),
        runNow: vi.fn(async () => undefined),
        renameSession: vi.fn(),
        markSessionMissing: vi.fn(),
      },
      sendTransportMessage,
      sendMessage,
      sendScheduleStateToSession: vi.fn(),
      listTmuxSessions: vi.fn(() => []),
      createDetachedTmuxSession: vi.fn(() => 'demo'),
      closeDetachedTerminalSession: vi.fn(),
      renameTmuxSession: vi.fn(() => 'demo'),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
      sanitizeSessionName: vi.fn((input?: string) => input?.trim() || 'demo'),
      createTransportSubscriber: vi.fn(),
      createMuxChannelSubscriber,
      bindConnectionToSubscriber: vi.fn(),
      getMirrorKey: vi.fn((sessionName: string) => sessionName),
      attachTmux: vi.fn(async () => {
        if (options?.failAttachTmux) {
          throw new Error('forced attach failure');
        }
      }),
      handleAdaptiveResize,
      destroyMirror: vi.fn(),
    },
  });

  return {
    runtime,
    sessions,
    sendTransportMessage,
    sendMessage,
    sendBufferHeadToSession,
    scheduleMirrorLiveSync,
    refreshMirrorHeadForSession,
    handleClientDebugLog,
    handleClientDebugSnapshot,
    handleInput,
    closeSession,
    handleAdaptiveResize,
    daemonRuntimeDebug,
    terminalFileTransferRuntime,
    remoteWindowStreamRuntime,
    createMuxChannelSubscriber,
  };
}

describe('terminal message runtime explicit error truth', () => {
  it('negotiates mux readiness and wraps target replies on the same physical transport', async () => {
    const { runtime } = createRuntime({ passThroughTransportSend: true });
    const connection = createConnection(null);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-hello',
      payload: {
        version: 1,
        clientInstanceId: 'android-client-1',
      },
    })));

    expect(connection.muxVersion).toBe(1);
    expect(connection.transport.sendText).toHaveBeenCalledWith(expect.stringContaining('"type":"mux-ready"'));

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-target-message',
      payload: {
        requestId: 'list-1',
        message: { type: 'list-sessions' },
      },
    })));

    const sentFrames = (connection.transport.sendText as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => JSON.parse(String(call[0])) as { type: string; payload?: unknown });
    expect(sentFrames).toContainEqual({
      type: 'mux-target-message',
      payload: {
        requestId: 'list-1',
        message: {
          type: 'sessions',
          payload: { sessions: [] },
        },
      },
    });
    expect(sentFrames).toContainEqual({
      type: 'mux-target-message',
      payload: {
        requestId: 'list-1',
        message: {
          type: 'session-activity',
          payload: { activities: [] },
        },
      },
    });
    expect(sentFrames.every((frame) => frame.type.startsWith('mux-'))).toBe(true);
  });

  it('publishes attach-time session activity only through the mux target control envelope', async () => {
    const { runtime } = createRuntime({ passThroughTransportSend: true });
    const connection = createConnection(null);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-hello',
      payload: {
        version: 1,
        clientInstanceId: 'android-client-1',
      },
    })));
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-a',
        sessionName: 'alpha',
      },
    })));

    const sentFrames = (connection.transport.sendText as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => JSON.parse(String(call[0])) as { type: string; payload?: unknown });
    expect(sentFrames).toContainEqual(expect.objectContaining({
      type: 'mux-channel-opened',
      payload: expect.objectContaining({
        channelId: 'channel-a',
      }),
    }));
    expect(sentFrames).toContainEqual({
      type: 'mux-target-message',
      payload: {
        message: {
          type: 'session-activity',
          payload: { activities: [] },
        },
      },
    });
    expect(sentFrames.every((frame) => frame.type.startsWith('mux-'))).toBe(true);
  });

  it('rolls back mux channel open when target control publication fails', async () => {
    const { runtime, sessions, closeSession } = createRuntime({
      failSessionActivityPublish: true,
      passThroughTransportSend: true,
    });
    const connection = createConnection(null);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-hello',
      payload: {
        version: 1,
        clientInstanceId: 'android-client-1',
      },
    })));
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-failed',
        sessionName: 'alpha',
      },
    })));

    const subscriber = sessions.get('transport-1:channel-failed');
    expect(connection.muxChannels?.has('channel-failed')).toBe(false);
    expect(subscriber?.transport).toBeNull();
    expect(closeSession).toHaveBeenCalledWith(
      subscriber,
      'session activity control publish failed: forced session activity send failure',
      false,
    );
    const sentFrames = (connection.transport.sendText as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => JSON.parse(String(call[0])) as { type: string; payload?: unknown });
    expect(sentFrames).toContainEqual({
      type: 'mux-channel-closed',
      payload: {
        channelId: 'channel-failed',
        reason: 'session activity control publish failed: forced session activity send failure',
        code: 'session_activity_failed',
      },
    });
  });

  it('reports attach failure through the opened mux channel error path', async () => {
    const { runtime } = createRuntime({
      failAttachTmux: true,
      passThroughTransportSend: true,
    });
    const connection = createConnection(null);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-hello',
      payload: {
        version: 1,
        clientInstanceId: 'android-client-1',
      },
    })));
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-attach-failed',
        sessionName: 'alpha',
      },
    })));
    await flushAsyncHandlers();

    const sentFrames = (connection.transport.sendText as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => JSON.parse(String(call[0])) as { type: string; payload?: unknown });
    expect(sentFrames).toContainEqual(expect.objectContaining({
      type: 'mux-channel-opened',
      payload: expect.objectContaining({
        channelId: 'channel-attach-failed',
      }),
    }));
    expect(sentFrames).toContainEqual({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-attach-failed',
        message: {
          type: 'error',
          payload: {
            message: 'forced attach failure',
            code: 'mux_channel_open_failed',
          },
        },
      },
    });
  });

  it('binds multiple mux channels on one connection and routes input only to the owning subscriber', async () => {
    const { runtime, sessions, handleInput, createMuxChannelSubscriber } = createRuntime();
    const connection = createConnection(null);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-hello',
      payload: {
        version: 1,
        clientInstanceId: 'android-client-1',
      },
    })));
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-a',
        sessionName: 'alpha',
      },
    })));
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-b',
        sessionName: 'beta',
      },
    })));

    expect(createMuxChannelSubscriber).toHaveBeenCalledTimes(2);
    expect(connection.muxChannels?.size).toBe(2);
    const subscriberA = sessions.get('transport-1:channel-a');
    const subscriberB = sessions.get('transport-1:channel-b');
    expect(subscriberA).toBeTruthy();
    expect(subscriberB).toBeTruthy();

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-b',
        message: {
          type: 'input',
          payload: 'echo beta\r',
        },
      },
    })));

    expect(handleInput).toHaveBeenCalledTimes(1);
    expect(handleInput).toHaveBeenCalledWith(subscriberB, 'echo beta\r', expect.any(Function));
    expect(handleInput).not.toHaveBeenCalledWith(subscriberA, expect.anything(), expect.anything());
  });

  it('honors initial mux channel body subscription before tmux attach starts', async () => {
    const { runtime, sessions } = createRuntime();
    const connection = createConnection(null);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-hello',
      payload: {
        version: 1,
        clientInstanceId: 'android-client-1',
      },
    })));
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-inactive',
        sessionName: 'alpha',
        bodySubscribed: false,
      },
    })));

    const subscriber = sessions.get('transport-1:channel-inactive');
    expect(subscriber?.bodySubscribed).toBe(false);
  });

  it('routes mux binary chunks only to the owning channel subscriber', async () => {
    const { runtime, sessions, terminalFileTransferRuntime } = createRuntime();
    const connection = createConnection(null);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-hello',
      payload: {
        version: 1,
        clientInstanceId: 'android-client-1',
      },
    })));
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-a',
        sessionName: 'alpha',
      },
    })));
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-b',
        sessionName: 'beta',
      },
    })));

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-binary',
      payload: {
        channelId: 'channel-b',
        dataBase64: Buffer.from('image-chunk').toString('base64'),
      },
    })));

    const subscriberA = sessions.get('transport-1:channel-a');
    const subscriberB = sessions.get('transport-1:channel-b');
    expect(terminalFileTransferRuntime.handleBinaryPayload).toHaveBeenCalledTimes(1);
    expect(terminalFileTransferRuntime.handleBinaryPayload).toHaveBeenCalledWith(
      subscriberB,
      Buffer.from('image-chunk'),
    );
    expect(terminalFileTransferRuntime.handleBinaryPayload).not.toHaveBeenCalledWith(
      subscriberA,
      expect.anything(),
    );
  });

  it('rejects mux binary chunks for unknown channels before file-transfer truth', async () => {
    const { runtime, sendTransportMessage, terminalFileTransferRuntime } = createRuntime();
    const connection = createConnection(null);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-hello',
      payload: {
        version: 1,
        clientInstanceId: 'android-client-1',
      },
    })));
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-binary',
      payload: {
        channelId: 'missing-channel',
        dataBase64: Buffer.from('orphan').toString('base64'),
      },
    })));

    expect(terminalFileTransferRuntime.handleBinaryPayload).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'mux-error',
      payload: expect.objectContaining({
        code: 'mux_unknown_channel',
        channelId: 'missing-channel',
      }),
    });
  });

  it('rejects unknown mux channels without mutating input or buffer truth', async () => {
    const { runtime, sendTransportMessage, handleInput, sendMessage } = createRuntime();
    const connection = createConnection(null);
    connection.muxVersion = 1;
    connection.muxChannels = new Map();

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-message',
      payload: {
        channelId: 'missing-channel',
        message: {
          type: 'input',
          payload: 'should-not-write\r',
        },
      },
    })));

    expect(handleInput).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'mux-error',
      payload: {
        code: 'mux_unknown_channel',
        message: 'mux channel missing-channel is not open',
        channelId: 'missing-channel',
      },
    });
  });

  it('rejects unwrapped session-bound messages after mux negotiation', async () => {
    const { runtime, sendTransportMessage, handleInput } = createRuntime();
    const connection = createConnection(null);
    connection.muxVersion = 1;
    connection.muxChannels = new Map();

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: 'bare-input\r',
    })));

    expect(handleInput).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'mux-error',
      payload: {
        code: 'mux_unwrapped_session_message',
        message: 'session-bound message input must be sent inside mux-channel-message',
      },
    });
  });

  it('updates physical body subscription without closing the transport, and resubscribe sends head truth plus live demand', async () => {
    const mirror = createReadyMirror();
    const { runtime, sessions, sendBufferHeadToSession, scheduleMirrorLiveSync } = createRuntime({ mirror });
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'body-subscription',
      payload: { version: 1, subscribed: false },
    })));

    expect(session.bodySubscribed).toBe(false);
    expect(connection.transport.close).not.toHaveBeenCalled();
    expect(sendBufferHeadToSession).not.toHaveBeenCalled();
    expect(scheduleMirrorLiveSync).toHaveBeenCalledWith(mirror, 0);
    scheduleMirrorLiveSync.mockClear();

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'body-subscription',
      payload: { version: 1, subscribed: true },
    })));

    expect(session.bodySubscribed).toBe(true);
    expect(connection.transport.close).not.toHaveBeenCalled();
    expect(sendBufferHeadToSession).toHaveBeenCalledWith(session, mirror);
    expect(scheduleMirrorLiveSync).toHaveBeenCalledWith(mirror, 0);
  });

  it('does not echo legacy clientSessionId in session-ticket because daemon owns no client state', async () => {
    const { runtime, sendTransportMessage } = createRuntime();
    const connection = createConnection(null);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'session-open',
      payload: {
        clientSessionId: 'session-legacy',
      },
    })));

    expect(sendTransportMessage).toHaveBeenCalledWith(
      connection.transport,
      expect.objectContaining({
        type: 'session-ticket',
        payload: expect.not.objectContaining({
          clientSessionId: expect.anything(),
        }),
      }),
    );
  });

  it('returns explicit session_not_ready error for buffer-head-request when mirror is missing', async () => {
    const { runtime, sessions, sendMessage, sendBufferHeadToSession } = createRuntime({ mirror: null });
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'buffer-head-request',
      payload: {},
    })));

    expect(sendBufferHeadToSession).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(session, {
      type: 'error',
      payload: {
        message: 'buffer-head-request requires a ready mirror',
        code: 'session_not_ready',
      },
    });
  });

  it('returns explicit session_not_ready error for buffer-sync-request when mirror is not ready', async () => {
    const mirror: SessionMirror = {
      key: 'demo',
      sessionName: 'demo',
      scratchBridge: null,
      lifecycle: 'booting',
      cols: 120,
      rows: 40,
      cursorKeysApp: false,
      revision: 0,
      lastScrollbackCount: -1,
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
      subscribers: new Set(),
    };
    const { runtime, sessions, sendMessage } = createRuntime({ mirror });
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'buffer-sync-request',
      payload: {
        startIndex: 0,
        endIndex: 0,
      },
    })));

    expect(sendMessage).toHaveBeenCalledWith(session, {
      type: 'error',
      payload: {
        message: 'buffer-sync-request requires a ready mirror',
        code: 'session_not_ready',
      },
    });
  });

  it('allows explicit buffer-sync range reads while physical body subscription is disabled', async () => {
    const mirror = createReadyMirror();
    mirror.bufferLines = [[{
      char: 97,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    }]];
    mirror.revision = 4;
    const { runtime, sessions, sendMessage, sendBufferHeadToSession, scheduleMirrorLiveSync } = createRuntime({ mirror });
    const session = createSession();
    session.bodySubscribed = false;
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'buffer-sync-request',
      payload: {
        knownRevision: 4,
        localStartIndex: 0,
        localEndIndex: 0,
        requestStartIndex: 0,
        requestEndIndex: 1,
      },
    })));

    expect(sendBufferHeadToSession).not.toHaveBeenCalled();
    expect(scheduleMirrorLiveSync).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(session, expect.objectContaining({
      type: 'buffer-sync',
      payload: expect.objectContaining({
        revision: 4,
        startIndex: 0,
        endIndex: 1,
        availableStartIndex: 0,
        availableEndIndex: 1,
      }),
    }));
  });

  it('uses buffer-head-request as a pure head-read probe path', async () => {
    const mirror: SessionMirror = {
      key: 'demo',
      sessionName: 'demo',
      scratchBridge: null,
      lifecycle: 'ready',
      cols: 120,
      rows: 40,
      cursorKeysApp: false,
      revision: 0,
      lastScrollbackCount: -1,
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
      subscribers: new Set(),
    };
    const { runtime, sessions, refreshMirrorHeadForSession, sendBufferHeadToSession } = createRuntime({ mirror });
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'buffer-head-request',
      payload: {},
    })));

    expect(refreshMirrorHeadForSession).not.toHaveBeenCalled();
    expect(sendBufferHeadToSession).toHaveBeenCalledWith(session, mirror);
  });

  it('sends a buffer-head immediately for each head request without cache window suppression', async () => {
    const mirror: SessionMirror = {
      key: 'demo',
      sessionName: 'demo',
      scratchBridge: null,
      lifecycle: 'ready',
      cols: 120,
      rows: 40,
      cursorKeysApp: false,
      revision: 0,
      lastScrollbackCount: -1,
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
      subscribers: new Set(),
    };
    const { runtime, sessions, sendBufferHeadToSession } = createRuntime({ mirror });
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'buffer-head-request',
      payload: {},
    })));

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'buffer-head-request',
      payload: {},
    })));

    expect(sendBufferHeadToSession).toHaveBeenCalledTimes(2);
    expect(sendBufferHeadToSession).toHaveBeenNthCalledWith(
      1,
      session,
      mirror,
    );
    expect(sendBufferHeadToSession).toHaveBeenNthCalledWith(
      2,
      session,
      mirror,
    );
  });

  it('routes debug-snapshot frames to the dedicated client debug snapshot handler', async () => {
    const { runtime, sessions, handleClientDebugSnapshot } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'debug-snapshot',
      payload: {
        snapshot: {
          source: 'session-transport-runtime-debug',
          keyboardInset: 320,
        },
      },
    })));

    expect(handleClientDebugSnapshot).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        snapshot: expect.objectContaining({
          keyboardInset: 320,
        }),
      }),
    );
  });

  it('routes resize frames as compatibility no-op without terminal input fallback', async () => {
    const { runtime, sessions, sendTransportMessage, handleInput, closeSession, handleAdaptiveResize } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'resize',
      payload: {
        cols: 72,
        rows: 24,
        widthMode: 'adaptive-phone',
      },
    })));

    expect(sendTransportMessage).not.toHaveBeenCalled();
    expect(handleInput).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(handleAdaptiveResize).toHaveBeenCalledWith(session, {
      cols: 72,
      widthMode: 'adaptive-phone',
    });
  });

  it('surfaces resize session_not_ready failures instead of silently accepting them', async () => {
    const { runtime, sessions, sendMessage, handleAdaptiveResize } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);
    handleAdaptiveResize.mockReturnValueOnce({
      ok: false,
      code: 'session_not_ready',
      message: 'resize requires an attached mirror',
    });

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'resize',
      payload: {
        cols: 72,
        widthMode: 'adaptive-phone',
      },
    })));

    expect(sendMessage).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: 'error',
        payload: {
          message: 'resize requires an attached mirror',
          code: 'session_not_ready',
        },
      }),
    );
  });

  it('writes string input payloads to the attached session', async () => {
    const { runtime, sessions, handleInput, sendMessage, daemonRuntimeDebug } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: 'pwd\r',
    })));

    expect(handleInput).toHaveBeenCalledWith(session, 'pwd\r', expect.any(Function));
    expect(sendMessage).not.toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: 'error' }),
    );
    expect(daemonRuntimeDebug).toHaveBeenCalledWith('input-receive', expect.objectContaining({
      transportId: connection.transportId,
      sessionId: session.id,
      bytes: 4,
      queueDepth: 0,
    }));
    expect(daemonRuntimeDebug).toHaveBeenCalledWith('input-write', expect.objectContaining({
      transportId: connection.transportId,
      sessionId: session.id,
      sessionName: 'demo',
      bytes: 4,
      queueDepth: 0,
    }));
    expect(JSON.stringify(daemonRuntimeDebug.mock.calls)).not.toContain('pwd');
  });

  it('writes reliable input payloads once and acks the accepted seq', async () => {
    const { runtime, sessions, handleInput, sendTransportMessage } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: {
        version: 1,
        seq: 'input-seq-1',
        data: 'pwd\r',
        sentAt: 1000,
        attempt: 1,
      },
    })));

    expect(handleInput).toHaveBeenCalledWith(session, 'pwd\r', expect.any(Function));
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'input-ack',
      payload: {
        version: 1,
        seq: 'input-seq-1',
        accepted: true,
        bytes: 4,
      },
    });
  });

  it('acks duplicate reliable input seq without writing it to tmux twice', async () => {
    const { runtime, sessions, handleInput, sendTransportMessage } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);
    const message = Buffer.from(JSON.stringify({
      type: 'input',
      payload: {
        version: 1,
        seq: 'input-seq-dup',
        data: 'echo once\r',
        sentAt: 1000,
        attempt: 1,
      },
    }));

    await runtime.handleMessage(connection, message);
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: {
        version: 1,
        seq: 'input-seq-dup',
        data: 'echo once\r',
        sentAt: 1500,
        attempt: 2,
      },
    })));

    expect(handleInput).toHaveBeenCalledTimes(1);
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'input-ack',
      payload: {
        version: 1,
        seq: 'input-seq-dup',
        accepted: true,
        bytes: 10,
      },
    });
  });

  it('accepts input payloads at the daemon frame byte limit', async () => {
    const { runtime, sessions, handleInput, sendMessage } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);
    const payload = 'a'.repeat(TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload,
    })));

    expect(handleInput).toHaveBeenCalledWith(session, payload, expect.any(Function));
    expect(sendMessage).not.toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('rejects input payloads over the daemon frame byte limit before tmux write', async () => {
    const { runtime, sessions, handleInput, sendTransportMessage, daemonRuntimeDebug } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);
    const payload = 'a'.repeat(TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES + 1);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload,
    })));

    expect(handleInput).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'error',
      payload: {
        message: `input payload exceeds ${TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES} bytes; client must chunk`,
        code: 'input_too_large',
      },
    });
    expect(daemonRuntimeDebug).toHaveBeenCalledWith('input-drop', expect.objectContaining({
      transportId: connection.transportId,
      sessionId: session.id,
      reason: 'input_too_large',
      bytes: TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES + 1,
      max: TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES,
    }));
    expect(JSON.stringify(daemonRuntimeDebug.mock.calls)).not.toContain(payload.slice(0, 32));
  });

  it('rejects object input payloads instead of writing object stringification to tmux', async () => {
    const { runtime, sessions, handleInput, sendMessage, sendTransportMessage } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: {
        data: 'pwd\r',
        sentAt: Date.now(),
      },
    })));

    expect(handleInput).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(session, {
      type: 'error',
      payload: {
        message: 'invalid input payload',
        code: 'input_invalid',
      },
    });
    expect(sendTransportMessage).not.toHaveBeenCalledWith(connection.transport, expect.objectContaining({
      type: 'input-ack',
    }));
  });

  it('rejects invalid reliable input seq with nack and never writes object data to tmux', async () => {
    const { runtime, sessions, handleInput, sendMessage, sendTransportMessage } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: {
        version: 1,
        seq: 'bad-seq',
        data: ['not-string'],
        sentAt: 1000,
        attempt: 1,
      },
    })));

    expect(handleInput).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'input-ack',
      payload: {
        version: 1,
        seq: 'bad-seq',
        accepted: false,
        bytes: 0,
        error: 'input_invalid',
      },
    });
    expect(sendMessage).toHaveBeenCalledWith(session, {
      type: 'error',
      payload: {
        message: 'invalid input payload',
        code: 'input_invalid',
      },
    });
  });

  it('drops input when the bound session was detached before dispatch reaches tmux', async () => {
    const { runtime, sessions, handleInput, sendTransportMessage } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);
    sessions.delete(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: 'late-after-detach\r',
    })));

    expect(handleInput).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'error',
      payload: { message: 'input requires an attached session transport', code: 'session_required' },
    });
  });

  it('drops input when the current session transport no longer matches the message transport', async () => {
    const { runtime, sessions, handleInput, sendTransportMessage, daemonRuntimeDebug } = createRuntime();
    const session = createSession();
    session.transportId = 'transport-2';
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: 'late-from-old-transport\r',
    })));

    expect(handleInput).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'error',
      payload: { message: 'input requires the current attached session transport', code: 'input_stale_transport' },
    });
    expect(daemonRuntimeDebug).toHaveBeenCalledWith('input-drop', expect.objectContaining({
      transportId: connection.transportId,
      sessionId: session.id,
      reason: 'input_stale_transport',
      bytes: 24,
      queueDepth: 0,
    }));
    expect(JSON.stringify(daemonRuntimeDebug.mock.calls)).not.toContain('late-from-old-transport');
  });

  it('drops plain text input when the current session transport no longer matches the message transport', async () => {
    const { runtime, sessions, handleInput, sendTransportMessage } = createRuntime();
    const session = createSession();
    session.transportId = 'transport-2';
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from('plain-late-from-old-transport\r'));

    expect(handleInput).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'error',
      payload: { message: 'input requires the current attached session transport', code: 'input_stale_transport' },
    });
  });

  it('drops queued input when transport/session becomes stale before async tmux write drains', async () => {
    let allowWrite = false;
    const { runtime, sessions, handleInput, sendTransportMessage } = createRuntime();
    handleInput.mockImplementation(async (_session, _data, shouldWrite?: () => boolean) => {
      await Promise.resolve();
      return shouldWrite ? shouldWrite() : allowWrite;
    });

    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);

    const pending = runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: 'delayed\r',
    })));

    sessions.delete(session.id);
    allowWrite = false;
    await pending;

    expect(handleInput).toHaveBeenCalledWith(session, 'delayed\r', expect.any(Function));
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'error',
      payload: { message: 'input requires the current attached session transport', code: 'input_stale_transport' },
    });
  });

  it('routes remote window target requests to the daemon stream owner without requiring an attached terminal session', async () => {
    const { runtime, sendTransportMessage, remoteWindowStreamRuntime } = createRuntime();
    const connection = createConnection(null);
    const payload = {
      requestId: 'rw-1',
      targets: [makeRemoteWindowTargetManifest()],
    };
    remoteWindowStreamRuntime.listTargets.mockResolvedValueOnce(payload);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-targets-request',
      payload: { requestId: 'rw-1' },
    })));
    await flushAsyncHandlers();

    expect(remoteWindowStreamRuntime.listTargets).toHaveBeenCalledWith({ requestId: 'rw-1' });
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-targets-response',
      payload,
    });
  });

  it('surfaces remote window catalog errors explicitly without screenshot or terminal render fallback', async () => {
    const { runtime, sendTransportMessage, remoteWindowStreamRuntime, terminalFileTransferRuntime } = createRuntime();
    const connection = createConnection(null);
    const payload = {
      requestId: 'rw-2',
      code: 'iterm2_api_unavailable',
      message: 'No module named iterm2',
    };
    remoteWindowStreamRuntime.listTargets.mockResolvedValueOnce(payload);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-targets-request',
      payload: { requestId: 'rw-2' },
    })));
    await flushAsyncHandlers();

    expect(terminalFileTransferRuntime.handleRemoteScreenshotRequest).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-error',
      payload,
    });
  });

  it('routes remote window stream start and daemon candidates through the same control transport', async () => {
    const { runtime, sendTransportMessage, remoteWindowStreamRuntime, terminalFileTransferRuntime } = createRuntime();
    const connection = createConnection(null);
    const startedPayload = {
      requestId: 'rw-start-1',
      streamId: 'stream-1',
      targetId: 'iterm2-pane:window:tab:pane',
      answer: { type: 'answer' as const, sdp: 'daemon-answer' },
      capture: {
        source: 'ScreenCaptureKit' as const,
        frameWidth: 800,
        frameHeight: 300,
        frameRate: 12,
        targetKind: 'iterm2-pane' as const,
      },
      transport: { kind: 'webrtc-video' as const },
    };
    (remoteWindowStreamRuntime.startStream as any).mockImplementationOnce(async (_payload: unknown, handlers: any) => {
      handlers?.sendIceCandidate?.({
        requestId: 'rw-start-1',
        streamId: 'stream-1',
        candidate: { candidate: 'candidate:daemon', sdpMid: '0', sdpMLineIndex: 0 },
      });
      handlers?.sendStatus?.({
        requestId: 'rw-start-1',
        streamId: 'stream-1',
        phase: 'streaming',
        framesSent: 1,
      });
      return startedPayload;
    });

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-stream-start-request',
      payload: {
        requestId: 'rw-start-1',
        streamId: 'stream-1',
        target: makeRemoteWindowTargetManifest(),
        offer: { type: 'offer', sdp: 'android-offer' },
      },
    })));
    await flushAsyncHandlers();

    expect(remoteWindowStreamRuntime.startStream).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'rw-start-1', streamId: 'stream-1' }),
      expect.objectContaining({
        sendIceCandidate: expect.any(Function),
        sendStatus: expect.any(Function),
      }),
    );
    expect(terminalFileTransferRuntime.handleRemoteScreenshotRequest).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-stream-ice-candidate',
      payload: {
        requestId: 'rw-start-1',
        streamId: 'stream-1',
        candidate: { candidate: 'candidate:daemon', sdpMid: '0', sdpMLineIndex: 0 },
      },
    });
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-stream-status',
      payload: {
        requestId: 'rw-start-1',
        streamId: 'stream-1',
        phase: 'streaming',
        framesSent: 1,
      },
    });
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-stream-started',
      payload: startedPayload,
    });
  });

  it('routes stream ICE candidates and stop requests to the daemon stream owner', async () => {
    const { runtime, sendTransportMessage, remoteWindowStreamRuntime } = createRuntime();
    const connection = createConnection(null);
    const stopPayload = {
      requestId: 'rw-stop-1',
      streamId: 'stream-1',
      phase: 'stopped' as const,
      framesSent: 3,
      message: 'remote window stream stopped',
    };
    remoteWindowStreamRuntime.stopStream.mockResolvedValueOnce(stopPayload);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-stream-ice-candidate',
      payload: {
        requestId: 'rw-candidate-1',
        streamId: 'stream-1',
        candidate: { candidate: 'candidate:android', sdpMid: '0', sdpMLineIndex: 0 },
      },
    })));
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-stream-stop-request',
      payload: {
        requestId: 'rw-stop-1',
        streamId: 'stream-1',
      },
    })));
    await flushAsyncHandlers();

    expect(remoteWindowStreamRuntime.addIceCandidate).toHaveBeenCalledWith({
      requestId: 'rw-candidate-1',
      streamId: 'stream-1',
      candidate: { candidate: 'candidate:android', sdpMid: '0', sdpMLineIndex: 0 },
    });
    expect(remoteWindowStreamRuntime.stopStream).toHaveBeenCalledWith({
      requestId: 'rw-stop-1',
      streamId: 'stream-1',
    });
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-stream-status',
      payload: stopPayload,
    });
  });

  it('routes remote window stream quality requests to the daemon stream owner', async () => {
    const { runtime, sendTransportMessage, remoteWindowStreamRuntime } = createRuntime();
    const connection = createConnection(null);
    const qualityPayload = {
      requestId: 'rw-quality-1',
      streamId: 'stream-1',
      targetId: 'target-1',
      accepted: true,
      videoBitrate: { preset: '10mbps' as const, bitrateMbps: 10 as const, maxBitrateBps: 10_000_000 },
    };
    remoteWindowStreamRuntime.updateStreamQuality.mockResolvedValueOnce(qualityPayload);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-stream-quality-request',
      payload: {
        requestId: 'rw-quality-1',
        streamId: 'stream-1',
        targetId: 'target-1',
        videoBitrate: { preset: '10mbps', bitrateMbps: 10, maxBitrateBps: 10_000_000 },
      },
    })));
    await flushAsyncHandlers();

    expect(remoteWindowStreamRuntime.updateStreamQuality).toHaveBeenCalledWith({
      requestId: 'rw-quality-1',
      streamId: 'stream-1',
      targetId: 'target-1',
      videoBitrate: { preset: '10mbps', bitrateMbps: 10, maxBitrateBps: 10_000_000 },
    });
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-stream-quality-result',
      payload: qualityPayload,
    });
  });

  it('surfaces remote window stream quality errors explicitly', async () => {
    const { runtime, sendTransportMessage, remoteWindowStreamRuntime } = createRuntime();
    const connection = createConnection(null);
    const errorPayload = {
      requestId: 'rw-quality-fail',
      streamId: 'stream-1',
      code: 'remote_window_stream_quality_failed',
      message: 'remote window video bitrate config does not match its preset',
    };
    remoteWindowStreamRuntime.updateStreamQuality.mockResolvedValueOnce(errorPayload);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-stream-quality-request',
      payload: {
        requestId: 'rw-quality-fail',
        streamId: 'stream-1',
        targetId: 'target-1',
        videoBitrate: { preset: '10mbps', bitrateMbps: 5, maxBitrateBps: 5_000_000 },
      },
    })));
    await flushAsyncHandlers();

    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-error',
      payload: errorPayload,
    });
  });

  it('routes remote window input to the daemon stream owner and returns explicit acceptance', async () => {
    const { runtime, sendTransportMessage, remoteWindowStreamRuntime } = createRuntime();
    const connection = createConnection(null);
    const inputPayload = {
      requestId: 'rw-input-1',
      streamId: 'stream-1',
      targetId: 'target-1',
      accepted: true,
    };
    remoteWindowStreamRuntime.injectInput.mockResolvedValueOnce(inputPayload);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-input',
      payload: {
        requestId: 'rw-input-1',
        streamId: 'stream-1',
        targetId: 'target-1',
        event: {
          kind: 'pointer',
          phase: 'down',
          pointerId: 1,
          button: 'left',
          buttons: 1,
          x: 100,
          y: 120,
          normalizedX: 0.5,
          normalizedY: 0.6,
        },
      },
    })));
    await flushAsyncHandlers();

    expect(remoteWindowStreamRuntime.injectInput).toHaveBeenCalledWith({
      requestId: 'rw-input-1',
      streamId: 'stream-1',
      targetId: 'target-1',
      event: expect.objectContaining({
        kind: 'pointer',
        phase: 'down',
      }),
    });
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-input-result',
      payload: inputPayload,
    });
  });

  it('surfaces remote window input policy errors explicitly', async () => {
    const { runtime, sendTransportMessage, remoteWindowStreamRuntime } = createRuntime();
    const connection = createConnection(null);
    const errorPayload = {
      requestId: 'rw-input-fail',
      streamId: 'stream-1',
      code: 'remote_window_input_failed',
      message: 'remote window OS input requires bring-to-focus policy',
    };
    remoteWindowStreamRuntime.injectInput.mockResolvedValueOnce(errorPayload);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-input',
      payload: {
        requestId: 'rw-input-fail',
        streamId: 'stream-1',
        targetId: 'target-1',
        event: {
          kind: 'key',
          phase: 'down',
          key: 'a',
          code: 'KeyA',
          text: 'a',
        },
      },
    })));
    await flushAsyncHandlers();

    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-error',
      payload: errorPayload,
    });
  });

  it('surfaces stream start errors explicitly without converting them into catalog or screenshot success', async () => {
    const { runtime, sendTransportMessage, remoteWindowStreamRuntime, terminalFileTransferRuntime } = createRuntime();
    const connection = createConnection(null);
    const errorPayload = {
      requestId: 'rw-start-fail',
      streamId: 'stream-fail',
      code: 'remote_window_stream_start_failed',
      message: 'ScreenCaptureKit capture start failure',
    };
    remoteWindowStreamRuntime.startStream.mockResolvedValueOnce(errorPayload);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-stream-start-request',
      payload: {
        requestId: 'rw-start-fail',
        streamId: 'stream-fail',
        target: makeRemoteWindowTargetManifest(),
        offer: { type: 'offer', sdp: 'android-offer' },
      },
    })));
    await flushAsyncHandlers();

    expect(terminalFileTransferRuntime.handleRemoteScreenshotRequest).not.toHaveBeenCalled();
    expect(remoteWindowStreamRuntime.listTargets).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-error',
      payload: errorPayload,
    });
  });
});
