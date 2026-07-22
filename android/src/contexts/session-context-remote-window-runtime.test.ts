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
import type { RemoteWindowStreamTargetManifest } from '../lib/types';
import { DEFAULT_BRIDGE_SETTINGS } from '../lib/bridge-settings';

function makeSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as any;
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

  it('reuses the open session transport owner before requesting the target catalog', async () => {
    const ws = makeSocket();
    const readSessionTransportSocket = vi.fn(() => ws);
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [],
      errors: [],
    }));
    const sendSocketPayload = vi.fn();

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: ' session-1 ',
      sessions: [baseSession],
      readSessionTransportSocket,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload,
    })).resolves.toMatchObject({ requestId: 'rw-1' });

    expect(readSessionTransportSocket).toHaveBeenCalledWith('session-1');
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
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
    })).resolves.toMatchObject({ requestId: 'rw-connecting' });

    expect(requestTargets).toHaveBeenCalledTimes(1);
  });

  it('reuses a fresh remote-window target catalog cache without re-enumerating daemon targets', async () => {
    const ws = makeSocket();
    const targetCatalogCache = new Map();
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
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload,
      targetCatalogCache,
      now: () => now,
    })).resolves.toMatchObject({ requestId: 'rw-live', targets: [expect.objectContaining({ streamTargetId: 'pane-1' })] });

    now += 1000;
    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload,
      targetCatalogCache,
      now: () => now,
    })).resolves.toMatchObject({ requestId: 'rw-live', targets: [expect.objectContaining({ streamTargetId: 'pane-1' })] });

    expect(requestTargets).toHaveBeenCalledTimes(1);
  });

  it('honors explicit force-refresh even when the daemon app catalog cache is fresh', async () => {
    const ws = makeSocket();
    const targetCatalogCache = new Map();
    const requestTargets = vi.fn()
      .mockResolvedValueOnce({ requestId: 'rw-first', targets: [], errors: [] })
      .mockResolvedValueOnce({ requestId: 'rw-refresh', targets: [makeTarget()], errors: [] });

    await requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      targetCatalogCache,
      now: () => 10_000,
    });

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      targetCatalogCache,
      forceRefresh: true,
      now: () => 10_001,
    })).resolves.toMatchObject({
      requestId: 'rw-refresh',
      targets: [expect.objectContaining({ streamTargetId: 'pane-1' })],
    });

    expect(requestTargets).toHaveBeenCalledTimes(2);
    expect(requestTargets).toHaveBeenLastCalledWith('session-1', {
      ws,
      request: { forceRefresh: true },
      sendSocketPayload: expect.any(Function),
    });
  });

  it('shares the daemon app catalog cache across session switches on the same daemon', async () => {
    const ws = makeSocket();
    const targetCatalogCache = new Map();
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
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      targetCatalogCache,
      now: () => 30_000,
    });

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-2',
      sessions: [{ ...baseSession, id: 'session-2', ...daemon }],
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      targetCatalogCache,
      now: () => 30_001,
    })).resolves.toMatchObject({ requestId: 'rw-daemon-wide' });

    expect(requestTargets).toHaveBeenCalledTimes(1);
  });

  it('refreshes remote-window targets after the catalog cache ttl expires', async () => {
    const ws = makeSocket();
    const targetCatalogCache = new Map();
    let now = 20_000;
    const requestTargets = vi.fn()
      .mockResolvedValueOnce({ requestId: 'rw-first', targets: [], errors: [] })
      .mockResolvedValueOnce({ requestId: 'rw-second', targets: [makeTarget()], errors: [] });

    await requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      targetCatalogCache,
      cacheTtlMs: 500,
      now: () => now,
    });
    now += 501;

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
      targetCatalogCache,
      cacheTtlMs: 500,
      now: () => now,
    })).resolves.toMatchObject({ requestId: 'rw-second' });

    expect(requestTargets).toHaveBeenCalledTimes(2);
  });

  it('does not use target catalog cache to hide a closed transport', async () => {
    const targetCatalogCache = new Map();
    await requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      readSessionTransportSocket: () => makeSocket(),
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(async () => ({ requestId: 'rw-cached', targets: [makeTarget()], errors: [] })),
      },
      sendSocketPayload: vi.fn(),
      targetCatalogCache,
      now: () => 1,
    });

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, state: 'connecting', bridgeHost: '100.66.1.82', bridgePort: 3333 }],
      readSessionTransportSocket: () => ({ ...makeSocket(), readyState: WebSocket.CLOSED }),
      remoteWindowMessageRuntime: { requestTargets: vi.fn() },
      sendSocketPayload: vi.fn(),
      targetCatalogCache,
      now: () => 2,
    })).rejects.toThrow('Remote window catalog transport is not open (session=connecting, socket=closed)');
  });

  it('rejects a missing session id before touching transport state', async () => {
    const readSessionTransportSocket = vi.fn();
    const requestTargets = vi.fn();

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: '   ',
      sessions: [baseSession],
      readSessionTransportSocket,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
    })).rejects.toThrow('No target session for remote window catalog');

    expect(readSessionTransportSocket).not.toHaveBeenCalled();
    expect(requestTargets).not.toHaveBeenCalled();
  });

  it('rejects catalog requests without reusing the paste ready error when no socket is open', () => {
    expect(() => resolveRemoteWindowCatalogTransport({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, state: 'connecting' }],
      readSessionTransportSocket: () => ({ ...makeSocket(), readyState: WebSocket.CLOSED }),
    })).toThrow('Remote window catalog transport is not open (session=connecting, socket=closed)');
  });

  it('starts a receiver-backed stream over the existing open session transport', async () => {
    const ws = makeSocket();
    const target = makeTarget();
    const sendSocketPayload = vi.fn();
    const requestStreamStart = vi.fn(async () => ({
      requestId: 'rw-start-1',
      streamId: 'stream-1',
      targetId: 'pane-1',
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
        started,
      };
    });

    await expect(requestRemoteWindowStreamStartRuntime({
      sessionId: ' session-1 ',
      streamId: 'stream-1',
      target,
      videoBitrate: { preset: '20mbps', bitrateMbps: 20, maxBitrateBps: 20_000_000 },
      sessions: [baseSession],
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart,
        sendStreamQuality: vi.fn(),
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
      target,
      sendIceCandidate: expect.any(Function),
      startRemote: expect.any(Function),
    }));
    expect(sendStreamIceCandidate).toHaveBeenCalledWith('session-1', {
      ws,
      streamId: 'stream-1',
      candidate: { candidate: 'candidate:local' },
      sendSocketPayload,
    });
    expect(requestStreamStart).toHaveBeenCalledWith('session-1', {
      ws,
      streamId: 'stream-1',
      target,
      offer: { type: 'offer', sdp: 'offer-sdp' },
      iceServers: undefined,
      videoBitrate: { preset: '20mbps', bitrateMbps: 20, maxBitrateBps: 20_000_000 },
      sendSocketPayload,
    });
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
      bridgeSettings,
      sessions: [session],
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart,
        sendStreamQuality: vi.fn(),
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
      sessions: [{ ...baseSession, state: 'connecting' }],
      readSessionTransportSocket: () => ({ ...makeSocket(), readyState: WebSocket.CLOSED }),
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart: vi.fn(),
        sendStreamQuality: vi.fn(),
        sendStreamIceCandidate: vi.fn(),
        stopStream: vi.fn(),
        sendInputEvent: vi.fn(),
      },
      remoteWindowReceiverRuntime: {
        startStream,
        stopStream: vi.fn(),
      },
      sendSocketPayload: vi.fn(),
    })).rejects.toThrow('Remote window stream transport is not open (session=connecting, socket=closed)');

    expect(startStream).not.toHaveBeenCalled();
  });

  it('stops the local receiver before sending daemon stop over the stream transport', () => {
    const ws = makeSocket();
    const stopReceiver = vi.fn(() => true);
    const stopMessage = vi.fn();
    const sendSocketPayload = vi.fn();

    expect(stopRemoteWindowStreamRuntime({
      sessionId: 'session-1',
      streamId: 'stream-1',
      sessions: [baseSession],
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart: vi.fn(),
        sendStreamQuality: vi.fn(),
        sendStreamIceCandidate: vi.fn(),
        stopStream: stopMessage,
        sendInputEvent: vi.fn(),
      },
      remoteWindowReceiverRuntime: {
        startStream: vi.fn(),
        stopStream: stopReceiver,
      },
      sendSocketPayload,
    })).toBe(true);

    expect(stopReceiver).toHaveBeenCalledWith('stream-1');
    expect(stopMessage).toHaveBeenCalledWith('session-1', {
      ws,
      streamId: 'stream-1',
      sendSocketPayload,
    });
  });

  it('sends stream quality updates over the existing stream transport', () => {
    const ws = makeSocket();
    const sendStreamQuality = vi.fn();
    const sendSocketPayload = vi.fn();

    updateRemoteWindowStreamQualityRuntime({
      sessionId: ' session-1 ',
      payload: {
        streamId: 'stream-1',
        targetId: 'target-1',
        videoBitrate: { preset: '10mbps', bitrateMbps: 10, maxBitrateBps: 10_000_000 },
      },
      sessions: [baseSession],
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart: vi.fn(),
        sendStreamQuality,
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
        targetId: 'target-1',
        videoBitrate: { preset: '10mbps', bitrateMbps: 10, maxBitrateBps: 10_000_000 },
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
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart: vi.fn(),
        sendStreamQuality: vi.fn(),
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
      readSessionTransportSocket: () => ({ ...makeSocket(), readyState: WebSocket.CLOSED }),
      remoteWindowMessageRuntime: {
        requestTargets: vi.fn(),
        requestStreamStart: vi.fn(),
        sendStreamQuality: vi.fn(),
        sendStreamIceCandidate: vi.fn(),
        stopStream: vi.fn(),
        sendInputEvent: vi.fn(),
      },
      sendSocketPayload: vi.fn(),
    })).toThrow('Remote window stream transport is not open (session=connecting, socket=closed)');
  });
});
