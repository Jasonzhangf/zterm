import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES } from '@zterm/shared/terminal/input-chunking';
import { isTerminalMuxServerFrame, type TerminalTransportServerFrame } from '@zterm/shared/protocol';
import { createTerminalChannelMuxRuntime } from './terminal-channel-mux-runtime';
import { createTerminalMessageRuntime } from './terminal-message-runtime';
import { createDaemonInputQueueRuntime } from './daemon-input-queue-runtime';
import type {
  TerminalSession,
  TerminalSessionTransport,
  SessionMirror,
  TerminalTransportConnection,
} from './terminal-runtime-types';
import type { TerminalFileTransferMessageRuntime } from './terminal-file-transfer-message-runtime';
import type { RemoteWindowStreamDaemonRuntime } from './remote-window-stream-daemon';
import { makeRemoteWindowVideoProfileFixture } from './remote-window-video-profile-test-fixture';

const smoothVideoProfile = makeRemoteWindowVideoProfileFixture('smooth');
const qualityVideoProfile = makeRemoteWindowVideoProfileFixture('quality');

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
      quietFlushStreak: 0,
      lastFlushHadContentChanges: false,
  };
}

function createFileTransferMessageRuntimeStub(): TerminalFileTransferMessageRuntime {
  return {
    handleMessage: vi.fn(async () => {}),
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
  useRealChannelMux?: boolean;
}) {
  type RemoteWindowListTargetsResult = Awaited<ReturnType<RemoteWindowStreamDaemonRuntime['listTargets']>>;
      type RemoteWindowStartStreamResult = Awaited<ReturnType<RemoteWindowStreamDaemonRuntime['startStream']>>;
      type RemoteWindowStopStreamResult = Awaited<ReturnType<RemoteWindowStreamDaemonRuntime['stopStream']>>;
      type RemoteWindowQualityResult = Awaited<ReturnType<RemoteWindowStreamDaemonRuntime['updateStreamQuality']>>;
      type RemoteWindowInputResult = Awaited<ReturnType<RemoteWindowStreamDaemonRuntime['injectInput']>>;
  const sessions = new Map<string, TerminalSession>();
  const mirrors = new Map<string, SessionMirror>();
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
  const handleInput = vi.fn(async (_session: TerminalSession, _data: string, _shouldWrite?: () => boolean) => true);
  const closeSession = vi.fn();
  const handleAdaptiveResize = vi.fn();
  const daemonRuntimeDebug = vi.fn();
  const daemonInputQueue = createDaemonInputQueueRuntime({
    sessions,
    mirrors,
    getMirrorKey: (sessionName: string) => sessionName,
    sendTransportMessage,
    sendMessage,
    handleInput,
    writeBackendInputGroup: vi.fn(async () => {}),
    resolveBackendInputMaxChunkBytes: () => TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES,
    daemonRuntimeDebug,
  });
  const fileTransferMessageRuntime = createFileTransferMessageRuntimeStub();
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
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
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
      streamGroupId: 'stream-default',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 1,
      targetId: 'target-default',
      status: 'applied',
      requestedVideoProfile: smoothVideoProfile,
      appliedVideoProfile: smoothVideoProfile,
    })),
    updateFocus: vi.fn(async () => ({
      requestId: 'remote-window-focus-default',
      streamId: 'stream-default',
      revision: 1,
      targetId: 'target-default',
      phase: 'accepted' as const,
    })),
    injectInput: vi.fn(async (): Promise<RemoteWindowInputResult> => ({
      control: {
        version: 1,
        sequence: 'remote-window-input-default',
        accepted: true,
        retryable: false,
        duplicate: false,
        receivedAtMs: 1,
      },
      payload: { streamId: 'stream-default', targetId: 'target-default' },
    })),
    setBrowserUserAgent: vi.fn(),
    dispose: vi.fn(),
  };

  const attachmentMessageRuntime = {
    handleMessage: vi.fn(async () => {}),
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
  const channelMuxRuntime = options?.useRealChannelMux ? createTerminalChannelMuxRuntime({
    sessions,
    sendText: (transport, text) => sendTransportMessage(transport, JSON.parse(text)),
    defaultSessionName: 'demo',
  }) : {
    createMuxChannelSubscriber,
    ensureMuxChannels: (connection: TerminalTransportConnection) => {
      if (!connection.muxChannels) {
        connection.muxChannels = new Map();
      }
      return connection.muxChannels;
    },
    releaseMuxChannelSubscriber: (connection: TerminalTransportConnection, channelId: string) => {
      connection.muxChannels?.delete(channelId);
    },
  };

  const runtime = createTerminalMessageRuntime({
    sessions,
    sendTransportMessage,
    sendMessage,
    normalizeBufferSyncRequestPayload: (_session, request) => request,
    getSessionMirror: () => options?.mirror ?? null,
    sendBufferHeadToSession,
    scheduleMirrorLiveSync,
    refreshMirrorHeadForSession,
    daemonInputQueue,
    closeSession,
    fileTransferMessageRuntime,
    attachmentMessageRuntime,
    remoteWindowStreamRuntime,
    channelMuxRuntime,
    controlRuntimeDeps: {
      sessions,
      mirrors,
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
    handleInput,
    closeSession,
    handleAdaptiveResize,
    daemonRuntimeDebug,
    fileTransferMessageRuntime,
    attachmentMessageRuntime,
    remoteWindowStreamRuntime,
    createMuxChannelSubscriber,
    daemonInputQueue,
  };
}

describe('terminal message runtime explicit error truth', () => {
  it('routes attachment messages to the attachment delivery owner runtime', async () => {
    const { runtime, attachmentMessageRuntime } = createRuntime();
    const connection = createConnection(null);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'pending-attachments-query',
      payload: { deviceId: 'phone-a' },
    })));

    expect(attachmentMessageRuntime.handleMessage).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({
        type: 'pending-attachments-query',
        payload: { deviceId: 'phone-a' },
      }),
    );
  });

  it('routes file transfer transport messages to the daemon file transfer owner runtime', async () => {
    const { runtime, sessions, fileTransferMessageRuntime } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'file-list-request',
      payload: {
        requestId: 'list-router-1',
        path: '/tmp',
        showHidden: false,
      },
    })));

    expect(fileTransferMessageRuntime.handleMessage).toHaveBeenCalledWith(
      session,
      connection,
      expect.objectContaining({
        type: 'file-list-request',
        payload: expect.objectContaining({ requestId: 'list-router-1' }),
      }),
    );
  });

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
          payload: { sessions: [], sessionCatalog: [] },
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

  it('preserves the selected backend through mux attach', async () => {
    const { runtime, sessions } = createRuntime({ passThroughTransportSend: true });
    const connection = createConnection(null);
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-hello', payload: { version: 1, clientInstanceId: 'android-client-backend' },
    })));
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-open', payload: { channelId: 'herdr-channel', sessionName: 'alpha', backend: 'herdr' },
    })));
    expect([...sessions.values()].find((session) => session.muxChannelId === 'herdr-channel')?.backend).toBe('herdr');
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

  it('reports attach failure only through the mux-channel-closed control error path', async () => {
    const { runtime, closeSession } = createRuntime({
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
    expect(sentFrames).not.toContainEqual(expect.objectContaining({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-attach-failed',
        message: {
          type: 'error',
        },
      },
    }));
    // phantom channel 必须原子清理：显式 closed + registry 删除 + subscriber 关闭（禁止保留未 attach channel）
    expect(sentFrames).toContainEqual({
      type: 'mux-channel-closed',
      payload: {
        channelId: 'channel-attach-failed',
        reason: expect.stringContaining('forced attach failure'),
        code: 'mux_channel_open_failed',
      },
    });
    expect(connection.muxChannels?.has('channel-attach-failed')).toBe(false);
    expect(closeSession).toHaveBeenCalledWith(
      expect.objectContaining({ muxChannelId: 'channel-attach-failed' }),
      expect.stringContaining('forced attach failure'),
      false,
    );
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
    const { runtime, sessions, fileTransferMessageRuntime } = createRuntime();
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
    expect(fileTransferMessageRuntime.handleBinaryPayload).toHaveBeenCalledTimes(1);
    expect(fileTransferMessageRuntime.handleBinaryPayload).toHaveBeenCalledWith(
      subscriberB,
      Buffer.from('image-chunk'),
    );
    expect(fileTransferMessageRuntime.handleBinaryPayload).not.toHaveBeenCalledWith(
      subscriberA,
      expect.anything(),
    );
  });

  it('rejects mux binary chunks for unknown channels before file-transfer truth', async () => {
    const { runtime, sendTransportMessage, fileTransferMessageRuntime } = createRuntime();
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

    expect(fileTransferMessageRuntime.handleBinaryPayload).not.toHaveBeenCalled();
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
      quietFlushStreak: 0,
      lastFlushHadContentChanges: false,
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
      quietFlushStreak: 0,
      lastFlushHadContentChanges: false,
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
      quietFlushStreak: 0,
      lastFlushHadContentChanges: false,
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
      rows: 24,
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
    const { runtime, sendTransportMessage, remoteWindowStreamRuntime, fileTransferMessageRuntime } = createRuntime();
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

    expect(fileTransferMessageRuntime.handleMessage).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-error',
      payload,
    });
  });

  it('rejects the removed v1 remote window stream start path', async () => {
    const { runtime, sendTransportMessage, remoteWindowStreamRuntime, fileTransferMessageRuntime } = createRuntime();
    const connection = createConnection(null);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-stream-start-request',
      payload: {
        requestId: 'rw-start-1',
        streamId: 'stream-1',
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
        target: makeRemoteWindowTargetManifest(),
        offer: { type: 'offer', sdp: 'android-offer' },
      },
    })));
    await flushAsyncHandlers();

    expect(remoteWindowStreamRuntime.startStream).not.toHaveBeenCalled();
    expect(fileTransferMessageRuntime.handleMessage).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-error',
      payload: {
        requestId: 'rw-start-1',
        streamId: 'stream-1',
        code: 'remote_window_stream_protocol_unsupported',
        message: 'remote window stream start v1 is unsupported; use mediaPlanVersion 2',
      },
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
      streamGroupId: 'stream-1',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 1,
      targetId: 'target-1',
      status: 'applied' as const,
      requestedVideoProfile: qualityVideoProfile,
      appliedVideoProfile: qualityVideoProfile,
    };
    remoteWindowStreamRuntime.updateStreamQuality.mockResolvedValueOnce(qualityPayload);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-stream-quality-request',
      payload: {
        requestId: 'rw-quality-1',
        streamId: 'stream-1',
        streamGroupId: 'stream-1',
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
        revision: 1,
        targetId: 'target-1',
        videoProfile: qualityVideoProfile,
      },
    })));
    await flushAsyncHandlers();

    expect(remoteWindowStreamRuntime.updateStreamQuality).toHaveBeenCalledWith({
      requestId: 'rw-quality-1',
      streamId: 'stream-1',
      streamGroupId: 'stream-1',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 1,
      targetId: 'target-1',
      videoProfile: qualityVideoProfile,
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
      message: 'remote window video preference is invalid: invalid',
    };
    remoteWindowStreamRuntime.updateStreamQuality.mockResolvedValueOnce(errorPayload);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-stream-quality-request',
      payload: {
        requestId: 'rw-quality-fail',
        streamId: 'stream-1',
        streamGroupId: 'stream-1',
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
        revision: 1,
        targetId: 'target-1',
        videoProfile: { ...qualityVideoProfile, preference: 'invalid' },
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
    const inputResult = {
      control: {
        version: 1 as const,
        sequence: 'rw-input-1',
        accepted: true,
        retryable: false,
        duplicate: false,
        receivedAtMs: 1,
      },
      payload: { streamId: 'stream-1', targetId: 'target-1' },
    };
    remoteWindowStreamRuntime.injectInput.mockResolvedValueOnce(inputResult);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-input',
      control: {
        version: 1,
        sequence: 'rw-input-1',
        lane: 'reliable',
        attempt: 1,
        sentAtMs: 1,
      },
      payload: {
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

    expect(remoteWindowStreamRuntime.injectInput).toHaveBeenCalledWith(
      {
        streamId: 'stream-1',
        targetId: 'target-1',
        event: expect.objectContaining({ kind: 'pointer', phase: 'down' }),
      },
      expect.objectContaining({ sequence: 'rw-input-1', lane: 'reliable' }),
    );
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-input-ack',
      control: inputResult.control,
      payload: inputResult.payload,
    });
  });

  it('surfaces remote window input policy errors explicitly', async () => {
    const { runtime, sendTransportMessage, remoteWindowStreamRuntime } = createRuntime();
    const connection = createConnection(null);
    const inputResult = {
      control: {
        version: 1 as const,
        sequence: 'rw-input-fail',
        accepted: false,
        retryable: false,
        duplicate: false,
        receivedAtMs: 2,
        error: {
          code: 'remote_window_input_failed',
          message: 'remote window OS input requires bring-to-focus policy',
        },
      },
      payload: { streamId: 'stream-1', targetId: 'target-1' },
    };
    remoteWindowStreamRuntime.injectInput.mockResolvedValueOnce(inputResult);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'remote-window-input',
      control: {
        version: 1,
        sequence: 'rw-input-fail',
        lane: 'reliable',
        attempt: 1,
        sentAtMs: 2,
      },
      payload: {
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
      type: 'remote-window-input-ack',
      control: inputResult.control,
      payload: inputResult.payload,
    });
  });

  it('surfaces stream start errors explicitly without converting them into catalog or screenshot success', async () => {
    const { runtime, sendTransportMessage, remoteWindowStreamRuntime, fileTransferMessageRuntime } = createRuntime();
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
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
        target: makeRemoteWindowTargetManifest(),
        offer: { type: 'offer', sdp: 'android-offer' },
      },
    })));
    await flushAsyncHandlers();

    expect(fileTransferMessageRuntime.handleMessage).not.toHaveBeenCalled();
    expect(remoteWindowStreamRuntime.listTargets).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'remote-window-error',
      payload: {
        requestId: 'rw-start-fail',
        streamId: 'stream-fail',
        code: 'remote_window_stream_protocol_unsupported',
        message: 'remote window stream start v1 is unsupported; use mediaPlanVersion 2',
      },
    });
  });
  describe('remote-window mux channel envelope', () => {
    it('rejects an unwrapped remote-window request on the physical mux transport', async () => {
      const { runtime, sendTransportMessage, remoteWindowStreamRuntime } = createRuntime();
      const connection = createConnection(null);
      await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
        type: 'mux-hello',
        payload: { version: 1, clientInstanceId: 'client-a' },
      })));
      await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
        type: 'mux-channel-open',
        payload: { channelId: 'rw-channel', sessionName: 'alpha' },
      })));

      await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
        type: 'remote-window-stream-start-request',
        payload: { requestId: 'rw-start-1' },
      })));

      expect(remoteWindowStreamRuntime.startStream).not.toHaveBeenCalled();
      expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, expect.objectContaining({
        type: 'mux-error',
        payload: expect.objectContaining({ code: 'mux_unwrapped_session_message' }),
      }));
    });

    it('sends raw remote-window-stream-started without mux envelope when mux is not negotiated', async () => {
      const { runtime, sendTransportMessage, remoteWindowStreamRuntime } = createRuntime();
      const connection = createConnection(null);
      const startedPayload = {
        requestId: 'rw-start-raw',
        streamId: 'stream-raw',
        targetId: 'target-raw',
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
        answer: { type: 'answer' as const, sdp: 'raw-answer' },
        capture: {
          source: 'ScreenCaptureKit' as const,
          frameWidth: 640,
          frameHeight: 360,
          frameRate: 12,
          targetKind: 'app-window' as const,
        },
        transport: { kind: 'webrtc-video' as const },
      };
      remoteWindowStreamRuntime.startStream.mockResolvedValueOnce(startedPayload);

      await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
        type: 'remote-window-stream-start-request',
        payload: {
          requestId: 'rw-start-raw',
          streamId: 'stream-raw',
          mediaPlan: 'single-focus' as const,
          mediaPlanVersion: 1 as const,
          target: makeRemoteWindowTargetManifest(),
          offer: { type: 'offer', sdp: 'raw-offer' },
        },
      })));
      await flushAsyncHandlers();

      expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
        type: 'remote-window-error',
        payload: {
          requestId: 'rw-start-raw',
          streamId: 'stream-raw',
          code: 'remote_window_stream_protocol_unsupported',
          message: 'remote window stream start v1 is unsupported; use mediaPlanVersion 2',
        },
      });
    });
  });

  it('wraps remote window channel responses in mux-channel-message frames', async () => {
    const { runtime, remoteWindowStreamRuntime } = createRuntime({
      useRealChannelMux: true,
      passThroughTransportSend: true,
    });
    const connection = createConnection(null);
    connection.muxVersion = 1;
    remoteWindowStreamRuntime.startStream.mockRejectedValueOnce(
      new Error('ScreenCaptureKit capture process exited code=4'),
    );

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-open',
      payload: {
        channelId: 'rw-channel',
        sessionName: 'remote-window',
        bodySubscribed: false,
      },
    })));
    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'mux-channel-message',
      payload: {
        channelId: 'rw-channel',
        message: {
          type: 'remote-window-stream-start-request',
          payload: {
            requestId: 'rw-mux-start',
            streamId: 'rw-mux-stream',
            mediaPlan: 'single-focus',
            mediaPlanVersion: 1,
            target: makeRemoteWindowTargetManifest(),
            offer: { type: 'offer', sdp: 'android-offer' },
          },
        },
      },
    })));
    await flushAsyncHandlers();

    const physicalConnection = connection.transport;
    const transportFrames = (physicalConnection.sendText as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => JSON.parse(call[0] as string) as TerminalTransportServerFrame);
    expect(transportFrames.every(isTerminalMuxServerFrame)).toBe(true);
    expect(transportFrames.some((frame) => frame.type === 'remote-window-error')).toBe(false);
    const errorFrame = [...transportFrames].reverse().find((frame) => (
      frame.type === 'mux-channel-message'
      && frame.payload.message.type === 'remote-window-error'
    ));
    if (!errorFrame) {
      throw new Error('expected a wrapped remote-window-error mux channel frame');
    }
    expect(errorFrame).toEqual({
      type: 'mux-channel-message',
      payload: {
        channelId: 'rw-channel',
        message: {
          type: 'remote-window-error',
          payload: {
            requestId: 'rw-mux-start',
            streamId: 'rw-mux-stream',
            code: 'remote_window_stream_protocol_unsupported',
            message: 'remote window stream start v1 is unsupported; use mediaPlanVersion 2',
          },
        },
      },
    });
  });
});
