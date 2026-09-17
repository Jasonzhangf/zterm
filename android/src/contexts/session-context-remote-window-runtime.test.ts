import { describe, expect, it, vi } from 'vitest';
import {
  requestRemoteWindowTargetsRuntime,
  requestRemoteWindowStreamStartRuntime,
  resolveRemoteWindowCatalogTransport,
  resolveRemoteWindowStreamIceServers,
  sendRemoteWindowInputRuntime,
  stopRemoteWindowStreamRuntime,
  updateRemoteWindowStreamQualityRuntime,
} from './session-context-remote-window-runtime';
import type {
  RemoteWindowStreamPurpose,
  RemoteWindowStreamTargetManifest,
  RemoteWindowVideoProfile,
} from '../lib/types';
import { buildRemoteWindowVideoProfile } from '../lib/remote-window-video-quality';
import { DEFAULT_BRIDGE_SETTINGS } from '../lib/bridge-settings';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';

const smoothVideoProfile = buildRemoteWindowVideoProfile('smooth');
const qualityVideoProfile = buildRemoteWindowVideoProfile('quality');

function makeSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as any;
}

function makeDaemonConnection(resourceOrFactory: any = makeSocket()) {
  const readResource = (sessionId: string) => (
    typeof resourceOrFactory === 'function'
      ? resourceOrFactory(sessionId)
      : {
          sessionId,
          socket: resourceOrFactory,
          terminalSocket: null,
          targetKey: 'daemon=mac-studio',
          channel: null,
        }
  );
  const readOpenSessionSocket = vi.fn((sessionId: string, purpose: string) => {
    const resource = readResource(sessionId) || null;
    const ws = resource?.socket || null;
    if (ws && ws.readyState === 1) {
      return ws;
    }
    const socketState = !ws
      ? 'missing'
      : ws.readyState === 0
        ? 'connecting'
        : ws.readyState === 2
          ? 'closing'
          : ws.readyState === 3
            ? 'closed'
            : `unknown:${ws.readyState}`;
    throw new Error(`${purpose} requires an open daemon connection (socket=${socketState}, target=${resource?.targetKey || 'daemon=mac-studio'}, channel=${resource?.channel?.state || 'missing'})`);
  });
  return {
    readSessionResource: vi.fn(readResource),
    readSessionSocket: vi.fn((sessionId: string) => readResource(sessionId)?.socket || null),
    readSessionTargetSocket: vi.fn((sessionId: string) => readResource(sessionId)?.terminalSocket || null),
    readOpenSessionSocket,
    sendSessionRaw: vi.fn(),
    sendSessionMessage: vi.fn(),
  } as unknown as ClientDaemonConnection & { readOpenSessionSocket: ReturnType<typeof vi.fn> };
}

function makeTarget(): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: 'pane-1',
    videoTarget: {
      kind: 'iterm2-pane',
      appBundleId: 'com.googlecode.iterm2',
      pid: 123,
      windowId: 'window-1',
      title: 'zterm pane',
      windowBoundsTopLeftPx: { x: 0, y: 80, width: 1000, height: 800 },
      cropRectTopLeftPx: { x: 0, y: 100, width: 1000, height: 400 },
    },
    inputTarget: {
      kind: 'tmux-pane',
      itermSessionId: 'iterm-1',
      tty: '/dev/ttys001',
      tmuxSession: 'zterm',
      tmuxWindowId: '@1',
      tmuxPaneId: '%2',
    },
    streamMode: 'view',
    focusPolicy: 'no-focus-steal',
    inputRoute: 'tmux-input',
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: '2026-07-19T00:00:00.000Z',
    },
  };
}

describe('session context remote window runtime', () => {
  const baseSession = {
    id: 'session-1',
    state: 'connected',
  } as any;

  it('reuses the daemon connection owner before requesting the target catalog', async () => {
    const ws = makeSocket();
    const daemonConnection = makeDaemonConnection(ws);
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [],
      errors: [],
    }));
    const sendSocketPayload = vi.fn();

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: ' session-1 ',
      sessions: [baseSession],
      daemonConnection,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload,
    })).resolves.toMatchObject({ requestId: 'rw-1' });

    expect(daemonConnection.readOpenSessionSocket).toHaveBeenCalledWith('session-1', 'Remote window catalog');
    expect(requestTargets).toHaveBeenCalledWith('session-1', {
      ws,
      sendSocketPayload,
    });
  });

  it('allows target catalog over an open socket while session status is still connecting', async () => {
    const ws = makeSocket();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-connecting',
      targets: [],
      errors: [],
    }));

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, state: 'connecting' }],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
    })).resolves.toMatchObject({ requestId: 'rw-connecting' });

    expect(requestTargets).toHaveBeenCalledTimes(1);
  });

  it('reads the daemon-owned target snapshot without client enumeration', async () => {
    const ws = makeSocket();
    let now = 10_000;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-live',
      targets: [makeTarget()],
      errors: [],
    }));
    const sendSocketPayload = vi.fn();

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload,
      now: () => now,
    })).resolves.toMatchObject({ requestId: 'rw-live', targets: [expect.objectContaining({ streamTargetId: 'pane-1' })] });

    now += 1000;
    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload,
      now: () => now,
    })).resolves.toMatchObject({ requestId: 'rw-live', targets: [expect.objectContaining({ streamTargetId: 'pane-1' })] });

    expect(requestTargets).toHaveBeenCalledTimes(2);
  });

  it('does not send force-refresh through the client catalog request', async () => {
    const ws = makeSocket();
    const requestTargets = vi.fn()
      .mockResolvedValueOnce({ requestId: 'rw-first', targets: [], errors: [] })
      .mockResolvedValueOnce({ requestId: 'rw-second', targets: [makeTarget()], errors: [] });

    await requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      now: () => 10_000,
    });

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      now: () => 10_001,
    })).resolves.toMatchObject({
      requestId: 'rw-second',
      targets: [expect.objectContaining({ streamTargetId: 'pane-1' })],
    });

    expect(requestTargets).toHaveBeenCalledTimes(2);
    expect(requestTargets).toHaveBeenLastCalledWith('session-1', {
      ws,
      sendSocketPayload: expect.any(Function),
    });
  });

  it('reads the daemon-owned snapshot across session switches', async () => {
    const ws = makeSocket();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-daemon-wide',
      targets: [makeTarget()],
      errors: [],
    }));
    const daemon = {
      daemonHostId: 'mac-studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
    };

    await requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, ...daemon }],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      now: () => 30_000,
    });

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-2',
      sessions: [{ ...baseSession, id: 'session-2', ...daemon }],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      now: () => 30_001,
    })).resolves.toMatchObject({ requestId: 'rw-daemon-wide' });

    expect(requestTargets).toHaveBeenCalledTimes(2);
  });

  it('reads the daemon snapshot on repeated requests', async () => {
    const ws = makeSocket();
    let now = 20_000;
    const requestTargets = vi.fn()
      .mockResolvedValueOnce({ requestId: 'rw-first', targets: [], errors: [] })
      .mockResolvedValueOnce({ requestId: 'rw-second', targets: [makeTarget()], errors: [] });

    await requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      now: () => now,
    });
    now += 501;

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      now: () => now,
    })).resolves.toMatchObject({ requestId: 'rw-second' });

    expect(requestTargets).toHaveBeenCalledTimes(2);
  });

  it('does not use target catalog cache to hide a closed transport', async () => {
    await requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      daemonConnection: makeDaemonConnection(),
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(async () => ({ requestId: 'rw-cached', targets: [makeTarget()], errors: [] })),
      },
      sendSocketPayload: vi.fn(),
      now: () => 1,
    });

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, state: 'connecting', bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      daemonConnection: makeDaemonConnection({ ...makeSocket(), readyState: 3 }),
      remoteWindowMessageRuntime: { requestTargets: vi.fn() },
      sendSocketPayload: vi.fn(),
      now: () => 2,
    })).rejects.toThrow('Remote window catalog requires an open daemon connection (socket=closed');
  });

  it('waits for the daemon channel to open before sending the catalog request when only socket=missing channel=opening is reported', async () => {
    let readAttempts = 0;
    const ws = makeSocket();
    const terminalSocket = makeSocket();
    let channelState: 'opening' | 'open' = 'opening';
    const daemonConnection = makeDaemonConnection((sessionId: string) => {
      readAttempts += 1;
      return {
        sessionId,
        socket: readAttempts >= 3 ? ws : null,
        terminalSocket,
        targetKey: 'daemon=mac-studio',
        channel: {
          channelId: 'channel:session-1',
          sessionId: 'session-1',
          sessionName: 'tmux-1',
          targetKey: 'daemon=mac-studio',
          state: channelState,
          bodySubscribed: true,
          openedAt: 1,
          closedAt: null,
        },
      };
    });
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-wait-success',
      targets: [],
      errors: [],
    }));
    let now = 1_000;
    const sleep = vi.fn(async () => {
      now += 60;
      if (readAttempts >= 2) {
        channelState = 'open';
      }
    });

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, state: 'connecting', bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      daemonConnection,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      now: () => now,
      sleep,
      catalogOpenTimeoutMs: 2_000,
      catalogOpenPollIntervalMs: 50,
    })).resolves.toMatchObject({ requestId: 'rw-wait-success' });

    expect(readAttempts).toBe(3);
    expect(sleep).toHaveBeenCalled();
    expect(requestTargets).toHaveBeenCalledTimes(1);
    expect(requestTargets).toHaveBeenCalledWith('session-1', {
      ws,
      sendSocketPayload: expect.any(Function),
    });
  });

  it('keeps waiting when the opening channel has not projected its terminal socket yet', async () => {
    let reads = 0;
    const targetSocket = makeSocket();
    const daemonConnection = makeDaemonConnection((sessionId: string) => {
      reads += 1;
      return {
        sessionId,
        socket: reads >= 3 ? targetSocket : null,
        terminalSocket: reads >= 3 ? targetSocket : null,
        targetKey: 'daemon=mac-studio',
        channel: {
          channelId: 'channel:session-1',
          sessionId: 'session-1',
          sessionName: 'tmux-1',
          targetKey: 'daemon=mac-studio',
          state: reads >= 3 ? 'open' : 'opening',
          bodySubscribed: true,
          openedAt: 1,
          closedAt: null,
        },
      };
    });
    const requestTargets = vi.fn(async () => ({ requestId: 'rw-delayed-socket', targets: [], errors: [] }));
    let now = 1_000;
    const sleep = vi.fn(async () => { now += 50; });

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, state: 'connecting', bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      daemonConnection,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      now: () => now,
      sleep,
      catalogOpenTimeoutMs: 2_000,
      catalogOpenPollIntervalMs: 50,
    })).resolves.toMatchObject({ requestId: 'rw-delayed-socket' });

    expect(reads).toBe(3);
    expect(sleep).toHaveBeenCalled();
    expect(requestTargets).toHaveBeenCalledWith('session-1', expect.objectContaining({ ws: targetSocket }));
  });

  it('sends the catalog request over an already-open target mux socket while the channel is opening', async () => {
    const targetSocket = makeSocket();
    const daemonConnection = makeDaemonConnection((sessionId: string) => ({
      sessionId,
      socket: null,
      terminalSocket: targetSocket,
      targetKey: 'daemon=mac-studio',
      channel: {
        channelId: 'channel:session-1',
        sessionId: 'session-1',
        sessionName: 'tmux-1',
        targetKey: 'daemon=mac-studio',
        state: 'opening',
        bodySubscribed: true,
        openedAt: 1,
        closedAt: null,
      },
    }));
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-target-open',
      targets: [],
      errors: [],
    }));
    const sleep = vi.fn(async () => undefined);

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, state: 'connecting', bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      daemonConnection,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      now: () => 1_000,
      sleep,
    })).resolves.toMatchObject({ requestId: 'rw-target-open' });

    expect(sleep).not.toHaveBeenCalled();
    expect(requestTargets).toHaveBeenCalledWith('session-1', {
      ws: targetSocket,
      sendSocketPayload: expect.any(Function),
    });
  });

  it('surfaces the explicit open daemon connection error when the socket stays missing past the channel-open wait timeout', async () => {
    const terminalSocket = makeSocket();
    const daemonConnection = makeDaemonConnection((sessionId: string) => ({
      sessionId,
      socket: null,
      terminalSocket,
      targetKey: 'daemon=mac-studio',
      channel: {
        channelId: 'channel:session-1',
        sessionId: 'session-1',
        sessionName: 'tmux-1',
        targetKey: 'daemon=mac-studio',
        state: 'opening',
        bodySubscribed: true,
        openedAt: 1,
        closedAt: null,
      },
    }));
    let now = 1_000;
    const sleep = vi.fn(async () => {
      now += 200;
    });

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, state: 'connecting', bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      daemonConnection,
      remoteWindowMessageRuntime: { requestTargets: vi.fn() },
      sendSocketPayload: vi.fn(),
      now: () => now,
      sleep,
      catalogOpenTimeoutMs: 100,
      catalogOpenPollIntervalMs: 50,
    })).rejects.toThrow('Remote window catalog requires an open daemon connection (socket=missing');

    expect(sleep.mock.calls.length).toBeGreaterThan(0);
  });

  it('does not wait for an open channel when the resource already reports the channel closed', async () => {
    const daemonConnection = makeDaemonConnection((sessionId: string) => ({
      sessionId,
      socket: null,
      terminalSocket: null,
      targetKey: 'daemon=mac-studio',
      channel: {
        channelId: 'channel:session-1',
        sessionId: 'session-1',
        sessionName: 'tmux-1',
        targetKey: 'daemon=mac-studio',
        state: 'closed',
        bodySubscribed: false,
        openedAt: 1,
        closedAt: 2,
      },
    }));
    const sleep = vi.fn(async () => undefined);

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, state: 'connecting', bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      daemonConnection,
      remoteWindowMessageRuntime: { requestTargets: vi.fn() },
      sendSocketPayload: vi.fn(),
      now: () => 1_000,
      sleep,
    })).rejects.toThrow('Remote window catalog requires an open daemon connection (socket=missing');

    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects a missing session id before touching transport state', async () => {
    const daemonConnection = makeDaemonConnection();
    const requestTargets = vi.fn();

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: '   ',
      sessions: [baseSession],
      daemonConnection,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
    })).rejects.toThrow('No target session for remote window catalog');

    expect(daemonConnection.readOpenSessionSocket).not.toHaveBeenCalled();
    expect(requestTargets).not.toHaveBeenCalled();
  });

  it('rejects catalog requests through daemon connection when no socket is open', () => {
    expect(() => resolveRemoteWindowCatalogTransport({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, state: 'connecting' }],
      daemonConnection: makeDaemonConnection({ ...makeSocket(), readyState: 3 }),
    })).toThrow('Remote window catalog requires an open daemon connection (socket=closed');
  });

  it('starts a receiver-backed stream over the existing open session transport', async () => {
    const ws = makeSocket();
    const target = makeTarget();
    const sendSocketPayload = vi.fn();
    const requestStreamStart = vi.fn(async () => ({
      requestId: 'rw-start-1',
      streamId: 'stream-1',
      targetId: 'pane-1',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      answer: { type: 'answer' as const, sdp: 'answer-sdp' },
      capture: {
        source: 'ScreenCaptureKit' as const,
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 5,
        targetKind: 'iterm2-pane' as const,
      },
      transport: { kind: 'webrtc-video' as const },
    }));
    const sendStreamIceCandidate = vi.fn();
    const startStream = vi.fn(async (receiverOptions: {
      sendIceCandidate: (candidate: { candidate: string }) => void;
      startRemote: (offer: { type: 'offer'; sdp: string }) => Promise<any>;
    }) => {
      receiverOptions.sendIceCandidate({ candidate: 'candidate:local' });
      const started = await receiverOptions.startRemote({ type: 'offer', sdp: 'offer-sdp' });
      return {
        streamId: 'stream-1',
        mediaStream: { id: 'media-stream-1' } as MediaStream,
        bindings: [],
        commitDecodedFrame: () => false,
        replaceLaneBinding: async () => false,
        started,
      };
    });

    await expect(requestRemoteWindowStreamStartRuntime({
      sessionId: ' session-1 ',
      streamId: 'stream-1',
      purpose: 'focus',
      target,
      videoProfile: qualityVideoProfile,
      sessions: [baseSession],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart,
        sendStreamAnswerV2: vi.fn(),
        sendStreamQuality: vi.fn(),
    sendStreamUpdateFocus: vi.fn(),
        sendStreamIceCandidate,
        stopStream: vi.fn(),
        sendInputEvent: vi.fn(),
      },
      remoteWindowReceiverRuntime: {
        startStream,
        stopStream: vi.fn(),
      },
      sendSocketPayload,
    })).resolves.toMatchObject({
      streamId: 'stream-1',
      mediaStream: { id: 'media-stream-1' },
      started: { targetId: 'pane-1' },
    });

    expect(startStream).toHaveBeenCalledWith(expect.objectContaining({
      streamId: 'stream-1',
      purpose: 'focus',
      target,
      sendIceCandidate: expect.any(Function),
      startRemote: expect.any(Function),
    }));
    expect(sendStreamIceCandidate).toHaveBeenCalledWith('session-1', {
      ws,
      streamId: 'stream-1',
      purpose: 'focus',
      candidate: { candidate: 'candidate:local' },
      sendSocketPayload,
    });
    expect(requestStreamStart).toHaveBeenCalledWith('session-1', {
      ws,
      streamId: 'stream-1',
      purpose: 'focus',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 2 as const,
      target,
      iceServers: undefined,
      videoProfile: qualityVideoProfile,
      sendSocketPayload,
    });
  });

  it('can start a low-rate preview stream before a high-quality focus stream on one daemon transport', async () => {
    const ws = makeSocket();
    const target = makeTarget();
    const sendSocketPayload = vi.fn();
    const requestStreamStart = vi.fn(async (_sessionId: string, options: {
      streamId: string;
      purpose?: RemoteWindowStreamPurpose;
      mediaPlan: 'single-focus' | 'overview-plus-focus';
      mediaPlanVersion: 1,
      videoProfile: RemoteWindowVideoProfile;
    }) => ({
      requestId: `rw-start-${options.streamId}`,
      streamId: options.streamId,
      purpose: options.purpose,
      targetId: 'pane-1',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      answer: { type: 'answer' as const, sdp: `answer-${options.streamId}` },
      capture: {
        source: 'ScreenCaptureKit' as const,
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 30,
        targetKind: 'iterm2-pane' as const,
      },
      transport: { kind: 'webrtc-video' as const },
    }));
    const startStream = vi.fn(async (receiverOptions: {
      streamId: string;
      purpose?: 'preview' | 'focus';
      startRemote: (offer: { type: 'offer'; sdp: string }) => Promise<any>;
    }) => {
      const started = await receiverOptions.startRemote({ type: 'offer', sdp: `offer-${receiverOptions.streamId}` });
      return {
        streamId: receiverOptions.streamId,
        purpose: receiverOptions.purpose,
        mediaStream: { id: `media-${receiverOptions.streamId}` } as MediaStream,
        bindings: [],
        commitDecodedFrame: () => false,
        replaceLaneBinding: async () => false,
        started,
      };
    });
    const remoteWindowMessageRuntime = {
      requestTargets: vi.fn(),
      requestStreamStart,
      sendStreamQuality: vi.fn(),
      sendStreamUpdateFocus: vi.fn(),
      sendStreamIceCandidate: vi.fn(),
      stopStream: vi.fn(),
      sendInputEvent: vi.fn(),
    };
    const remoteWindowReceiverRuntime = {
      startStream,
      stopStream: vi.fn(),
    };

    await requestRemoteWindowStreamStartRuntime({
      sessionId: 'session-1',
      streamId: 'canvas-stream',
      purpose: 'preview',
      target,
      videoProfile: smoothVideoProfile,
      sessions: [baseSession],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime,
      remoteWindowReceiverRuntime,
      sendSocketPayload,
    });
    await requestRemoteWindowStreamStartRuntime({
      sessionId: 'session-1',
      streamId: 'focus-stream',
      purpose: 'focus',
      target,
      videoProfile: qualityVideoProfile,
      sessions: [baseSession],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime,
      remoteWindowReceiverRuntime,
      sendSocketPayload,
    });

    expect(startStream.mock.calls.map(([options]) => ({
      streamId: options.streamId,
      purpose: options.purpose,
    }))).toEqual([
      { streamId: 'canvas-stream', purpose: 'preview' },
      { streamId: 'focus-stream', purpose: 'focus' },
    ]);
    expect(requestStreamStart.mock.calls.map(([, options]) => ({
      streamId: options.streamId,
      purpose: options.purpose,
      mediaPlan: options.mediaPlan,
      bitrate: options.videoProfile.maxBitrateBps,
    }))).toEqual([
      { streamId: 'canvas-stream', purpose: 'preview', mediaPlan: 'single-focus' as const, bitrate: 2_000_000 },
      { streamId: 'focus-stream', purpose: 'focus', mediaPlan: 'single-focus' as const, bitrate: 8_000_000 },
    ]);
  });

  it('inherits Relay TURN ice servers from the active session traversal route for remote video', async () => {
    const ws = {
      ...makeSocket(),
      getDiagnostics: () => ({
        mode: 'auto',
        stage: 'open',
        resolvedPath: 'rtc-relay',
        resolvedEndpoint: 'relay:mac-studio',
        attempts: [],
      }),
    };
    const target = makeTarget();
    const sendSocketPayload = vi.fn();
    const bridgeSettings = {
      ...DEFAULT_BRIDGE_SETTINGS,
      traversalRelay: {
        relayBaseUrl: 'https://relay.codewhisper.cc:18443/relay',
        accessToken: 'relay-access',
        userId: 'user-1',
        username: 'jason',
        deviceId: 'device-1',
        deviceName: 'phone',
        platform: 'android',
        wsDevicesUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/devices',
        wsHostUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/host',
        wsClientUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/client',
        turnUrl: 'turn:relay.codewhisper.cc:3479?transport=udp',
        turnUsername: 'turn-user',
        turnCredential: 'turn-credential',
        updatedAt: 1,
      },
    };
    const session = {
      ...baseSession,
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      authToken: 'daemon-token',
      daemonHostId: 'mac-studio',
      resolvedPath: 'rtc-relay',
    };
    const requestStreamStart = vi.fn(async () => ({
      requestId: 'rw-start-1',
      streamId: 'stream-1',
      targetId: 'pane-1',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      answer: { type: 'answer' as const, sdp: 'answer-sdp' },
      capture: {
        source: 'ScreenCaptureKit' as const,
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 5,
        targetKind: 'iterm2-pane' as const,
      },
      transport: { kind: 'webrtc-video' as const },
    }));
    const startStream = vi.fn(async (receiverOptions: {
      iceServers?: RTCIceServer[];
      startRemote: (offer: { type: 'offer'; sdp: string }) => Promise<any>;
    }) => {
      const started = await receiverOptions.startRemote({ type: 'offer', sdp: 'offer-sdp' });
      return {
        streamId: 'stream-1',
        mediaStream: { id: 'media-stream-1' } as MediaStream,
        bindings: [],
        commitDecodedFrame: () => false,
        replaceLaneBinding: async () => false,
        started,
      };
    });

    expect(resolveRemoteWindowStreamIceServers({
      session,
      ws,
      bridgeSettings,
    })).toEqual([{
      urls: 'turn:relay.codewhisper.cc:3479?transport=udp',
      username: 'turn-user',
      credential: 'turn-credential',
    }]);

    await requestRemoteWindowStreamStartRuntime({
      sessionId: 'session-1',
      streamId: 'stream-1',
      target,
      videoProfile: smoothVideoProfile,
      bridgeSettings,
      sessions: [session],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart,
        sendStreamQuality: vi.fn(),
        sendStreamUpdateFocus: vi.fn(),
        sendStreamIceCandidate: vi.fn(),
        stopStream: vi.fn(),
        sendInputEvent: vi.fn(),
      },
      remoteWindowReceiverRuntime: {
        startStream,
        stopStream: vi.fn(),
      },
      sendSocketPayload,
    });

    const expectedIceServers = [{
      urls: 'turn:relay.codewhisper.cc:3479?transport=udp',
      username: 'turn-user',
      credential: 'turn-credential',
    }];
    expect(startStream).toHaveBeenCalledWith(expect.objectContaining({
      iceServers: expectedIceServers,
    }));
    expect(requestStreamStart).toHaveBeenCalledWith('session-1', expect.objectContaining({
      iceServers: expectedIceServers,
    }));
  });

  it('rejects stream start without an open transport and does not create a receiver stream', async () => {
    const startStream = vi.fn();

    await expect(requestRemoteWindowStreamStartRuntime({
      sessionId: 'session-1',
      streamId: 'stream-1',
      target: makeTarget(),
      videoProfile: smoothVideoProfile,
      sessions: [{ ...baseSession, state: 'connecting' }],
      daemonConnection: makeDaemonConnection({ ...makeSocket(), readyState: 3 }),
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart: vi.fn(),
        sendStreamQuality: vi.fn(),
        sendStreamUpdateFocus: vi.fn(),
        sendStreamIceCandidate: vi.fn(),
        stopStream: vi.fn(),
        sendInputEvent: vi.fn(),
      },
      remoteWindowReceiverRuntime: {
        startStream,
        stopStream: vi.fn(),
      },
      sendSocketPayload: vi.fn(),
    })).rejects.toThrow('Remote window stream requires an open daemon connection (socket=closed');

    expect(startStream).not.toHaveBeenCalled();
  });

  it('stops the local receiver before sending daemon stop over the stream transport', async () => {
    const ws = makeSocket();
    const stopReceiver = vi.fn(() => true);
    const stopMessage = vi.fn(async () => ({
      requestId: 'rw-stop-1',
      streamId: 'stream-1',
      phase: 'stopped' as const,
    }));
    const sendSocketPayload = vi.fn();

    await expect(stopRemoteWindowStreamRuntime({
      sessionId: 'session-1',
      streamId: 'stream-1',
      sessions: [baseSession],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart: vi.fn(),
        sendStreamQuality: vi.fn(),
        sendStreamUpdateFocus: vi.fn(),
        sendStreamIceCandidate: vi.fn(),
        stopStream: stopMessage,
        sendInputEvent: vi.fn(),
      },
      remoteWindowReceiverRuntime: {
        startStream: vi.fn(),
        stopStream: stopReceiver,
      },
      sendSocketPayload,
    })).resolves.toBe(true);

    expect(stopReceiver).toHaveBeenCalledWith('stream-1');
    expect(stopMessage).toHaveBeenCalledWith('session-1', {
      ws,
      streamId: 'stream-1',
      sendSocketPayload,
    });
  });

  it('rejects stop when daemon stop acknowledgement fails', async () => {
    const ws = makeSocket();
    const stopReceiver = vi.fn(() => true);
    const stopMessage = vi.fn(async () => {
      throw new Error('daemon stop failed');
    });

    await expect(stopRemoteWindowStreamRuntime({
      sessionId: 'session-1',
      streamId: 'stream-1',
      sessions: [baseSession],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart: vi.fn(),
        sendStreamQuality: vi.fn(),
        sendStreamUpdateFocus: vi.fn(),
        sendStreamIceCandidate: vi.fn(),
        stopStream: stopMessage,
        sendInputEvent: vi.fn(),
      },
      remoteWindowReceiverRuntime: {
        startStream: vi.fn(),
        stopStream: stopReceiver,
      },
      sendSocketPayload: vi.fn(),
    })).rejects.toThrow('daemon stop failed');

    expect(stopReceiver).toHaveBeenCalledWith('stream-1');
  });

  it('sends acknowledged stream quality updates over the existing stream transport', async () => {
    const ws = makeSocket();
    const sendStreamQuality = vi.fn(async () => ({
      requestId: 'quality-1',
      streamId: 'stream-1',
      streamGroupId: 'stream-1',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 1,
      targetId: 'target-1',
      status: 'applied' as const,
      requestedVideoProfile: qualityVideoProfile,
      appliedVideoProfile: qualityVideoProfile,
    }));
    const sendSocketPayload = vi.fn();

    await updateRemoteWindowStreamQualityRuntime({
      sessionId: ' session-1 ',
      payload: {
        streamId: 'stream-1',
        streamGroupId: 'stream-1',
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
        revision: 1,
        targetId: 'target-1',
        videoProfile: qualityVideoProfile,
      },
      sessions: [baseSession],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart: vi.fn(),
        sendStreamQuality,
        sendStreamUpdateFocus: vi.fn(),
        sendStreamIceCandidate: vi.fn(),
        stopStream: vi.fn(),
        sendInputEvent: vi.fn(),
      },
      sendSocketPayload,
    });

    expect(sendStreamQuality).toHaveBeenCalledWith('session-1', {
      ws,
      payload: {
        streamId: 'stream-1',
        streamGroupId: 'stream-1',
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
        revision: 1,
        targetId: 'target-1',
        videoProfile: qualityVideoProfile,
      },
      sendSocketPayload,
    });
  });

  it('sends remote-window input over the existing stream transport', () => {
    const ws = makeSocket();
    const sendInputEvent = vi.fn();
    const sendSocketPayload = vi.fn();

    sendRemoteWindowInputRuntime({
      sessionId: ' session-1 ',
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
      sessions: [baseSession],
      daemonConnection: makeDaemonConnection(ws),
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart: vi.fn(),
        sendStreamQuality: vi.fn(),
        sendStreamUpdateFocus: vi.fn(),
        sendStreamIceCandidate: vi.fn(),
        stopStream: vi.fn(),
        sendInputEvent,
      },
      sendSocketPayload,
    });

    expect(sendInputEvent).toHaveBeenCalledWith('session-1', {
      ws,
      payload: {
        streamId: 'stream-1',
        targetId: 'target-1',
        event: expect.objectContaining({
          kind: 'pointer',
          x: 100,
        }),
      },
      sendSocketPayload,
    });
  });

  it('rejects remote-window input without an open stream transport', () => {
    expect(() => sendRemoteWindowInputRuntime({
      sessionId: 'session-1',
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
      sessions: [{ ...baseSession, state: 'connecting' }],
      daemonConnection: makeDaemonConnection({ ...makeSocket(), readyState: 3 }),
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart: vi.fn(),
        sendStreamQuality: vi.fn(),
        sendStreamUpdateFocus: vi.fn(),
        sendStreamIceCandidate: vi.fn(),
        stopStream: vi.fn(),
        sendInputEvent: vi.fn(),
      },
      sendSocketPayload: vi.fn(),
    })).toThrow('Remote window stream requires an open daemon connection (socket=closed');
  });
});
