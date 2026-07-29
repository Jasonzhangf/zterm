import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteWindowReceiverRuntime,
  REMOTE_WINDOW_RECEIVER_TRACK_TIMEOUT_MS,
} from './remote-window-receiver-runtime';
import type {
  RemoteWindowStreamRtcDescription,
  RemoteWindowStreamTargetManifest,
} from './types';

class MockMediaTrack {
  kind = 'video';
  stop = vi.fn();
}

class MockMediaStream {
  private tracks: MockMediaTrack[] = [];

  constructor(tracks: MockMediaTrack[] = []) {
    this.tracks = tracks;
  }

  addTrack(track: MockMediaTrack) {
    this.tracks.push(track);
  }

  getTracks() {
    return this.tracks;
  }
}

class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = [];

  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addTransceiver = vi.fn();
  addIceCandidate = vi.fn(async () => undefined);
  close = vi.fn();
  getStats = vi.fn(async () => new Map());

  constructor(public readonly configuration: RTCConfiguration) {
    MockRTCPeerConnection.instances.push(this);
  }

  async createOffer() {
    return { type: 'offer' as const, sdp: 'local-offer-sdp' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
  }

  emitLocalCandidate() {
    this.onicecandidate?.({
      candidate: {
        candidate: 'candidate:local',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'ufrag-local',
        toJSON() {
          return {
            candidate: 'candidate:local',
            sdpMid: '0',
            sdpMLineIndex: 0,
            usernameFragment: 'ufrag-local',
          };
        },
      },
    } as RTCPeerConnectionIceEvent);
  }

  emitVideoTrack(stream = new MockMediaStream([new MockMediaTrack()])) {
    this.ontrack?.({
      track: stream.getTracks()[0],
      streams: [stream],
    } as unknown as RTCTrackEvent);
    return stream;
  }

  static reset() {
    MockRTCPeerConnection.instances = [];
  }
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

function createRuntime(timeoutHandlers?: Array<() => void>) {
  MockRTCPeerConnection.reset();
  return createRemoteWindowReceiverRuntime({
    peerConnectionFactory: (configuration) => new MockRTCPeerConnection(configuration) as unknown as RTCPeerConnection,
    mediaStreamFactory: () => new MockMediaStream() as unknown as MediaStream,
    trackTimeoutMs: 50,
    setTimeoutFn: vi.fn((handler) => {
      timeoutHandlers?.push(handler as () => void);
      return 1;
    }) as any,
    clearTimeoutFn: vi.fn() as any,
  });
}

async function flushMicrotasks(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe('remote window receiver runtime', () => {
  it('creates a recvonly video offer, waits for a real video track, and returns the receiver stream', async () => {
    const runtime = createRuntime();
    const sendIceCandidate = vi.fn();
    const startRemote = vi.fn(async (_offer) => ({
      requestId: 'rw-start-1',
      streamId: 'stream-1',
      targetId: 'pane-1',
      answer: { type: 'answer' as const, sdp: 'remote-answer-sdp' },
      capture: {
        source: 'ScreenCaptureKit' as const,
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 5,
        targetKind: 'iterm2-pane' as const,
      },
      transport: { kind: 'webrtc-video' as const },
    }));

    const started = runtime.startStream({
      streamId: 'stream-1',
      target: makeTarget(),
      iceServers: [{ urls: 'stun:relay.codewhisper.cc:3478' }],
      sendIceCandidate,
      startRemote,
    });

    await flushMicrotasks();
    const peer = MockRTCPeerConnection.instances[0]!;
    expect(peer.configuration).toMatchObject({ iceServers: [{ urls: 'stun:relay.codewhisper.cc:3478' }] });
    expect(peer.addTransceiver).toHaveBeenCalledWith('video', { direction: 'recvonly' });
    await flushMicrotasks();
    expect(startRemote).toHaveBeenCalledWith({ type: 'offer', sdp: 'local-offer-sdp' });
    expect(peer.remoteDescription).toEqual({ type: 'answer', sdp: 'remote-answer-sdp' });

    const mediaStream = peer.emitVideoTrack();

    await expect(started).resolves.toMatchObject({
      streamId: 'stream-1',
      mediaStream,
      started: { streamId: 'stream-1', targetId: 'pane-1' },
    });
  });

  it('sends local ICE candidates and applies remote candidates by stream id', async () => {
    const runtime = createRuntime();
    const sendIceCandidate = vi.fn();
    const startRemote = vi.fn(async () => ({
      requestId: 'rw-start-1',
      streamId: 'stream-1',
      targetId: 'pane-1',
      answer: { type: 'answer' as const, sdp: 'remote-answer-sdp' },
      capture: {
        source: 'ScreenCaptureKit' as const,
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 5,
        targetKind: 'iterm2-pane' as const,
      },
      transport: { kind: 'webrtc-video' as const },
    }));

    const started = runtime.startStream({
      streamId: 'stream-1',
      target: makeTarget(),
      sendIceCandidate,
      startRemote,
    });
    await flushMicrotasks();
    const peer = MockRTCPeerConnection.instances[0]!;
    peer.emitLocalCandidate();
    peer.emitVideoTrack();
    await started;

    expect(sendIceCandidate).toHaveBeenCalledWith({
      candidate: 'candidate:local',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: 'ufrag-local',
    });
    await expect(runtime.addIceCandidate({
      streamId: 'stream-1',
      candidate: { candidate: 'candidate:remote', sdpMid: '0', sdpMLineIndex: 0 },
    })).resolves.toBe(true);
    expect(peer.addIceCandidate).toHaveBeenCalledWith({
      candidate: 'candidate:remote',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    });
  });

  it('collects WebRTC video stats for adaptive remote-window quality decisions', async () => {
    const runtime = createRuntime();
    const started = runtime.startStream({
      streamId: 'stream-stats',
      target: makeTarget(),
      sendIceCandidate: vi.fn(),
      startRemote: vi.fn(async () => ({
        requestId: 'rw-start-stats',
        streamId: 'stream-stats',
        targetId: 'pane-1',
        answer: { type: 'answer' as const, sdp: 'remote-answer-sdp' },
        capture: {
          source: 'ScreenCaptureKit' as const,
          frameWidth: 640,
          frameHeight: 360,
          frameRate: 30,
          targetKind: 'iterm2-pane' as const,
        },
        transport: { kind: 'webrtc-video' as const },
      })),
    });
    await flushMicrotasks();
    const peer = MockRTCPeerConnection.instances[0]!;
    peer.emitVideoTrack();
    const result = await started;
    peer.getStats.mockResolvedValue(new Map<string, unknown>([
      ['inbound-video', {
        type: 'inbound-rtp',
        kind: 'video',
        framesPerSecond: 18,
        framesDropped: 9,
        freezeCount: 1,
        jitterBufferDelay: 0.32,
        jitterBufferEmittedCount: 1,
      }],
      ['candidate', {
        type: 'candidate-pair',
        state: 'succeeded',
        availableIncomingBitrate: 5_000_000,
        currentRoundTripTime: 0.18,
        availableOutgoingBitrate: 4_000_000,
      }],
      ['remote-inbound', {
        type: 'remote-inbound-rtp',
        kind: 'video',
        roundTripTime: 0.21,
      }],
    ]));

    await expect(result.collectStats?.()).resolves.toMatchObject({
      framesPerSecond: 18,
      framesDropped: 9,
      freezeCount: 1,
      jitterBufferDelayMs: 320,
      availableIncomingBitrateBps: 5_000_000,
      availableOutgoingBitrateBps: 4_000_000,
      rttMs: 210,
    });

    peer.getStats.mockResolvedValue(new Map<string, unknown>([
      ['inbound-video', {
        type: 'inbound-rtp',
        kind: 'video',
        framesPerSecond: 30,
        framesDropped: 10,
        freezeCount: 1,
        jitterBufferDelay: 0.34,
        jitterBufferEmittedCount: 11,
      }],
    ]));

    const nextSample = await result.collectStats?.();
    expect(nextSample).toMatchObject({
      framesPerSecond: 30,
      framesDropped: 1,
      freezeCount: 0,
    });
    expect(nextSample?.jitterBufferDelayMs).toBeCloseTo(2);
  });

  it('cleans the peer exactly once on stop and ignores late candidates', async () => {
    const runtime = createRuntime();
    const track = new MockMediaTrack();
    const mediaStream = new MockMediaStream([track]);
    const started = runtime.startStream({
      streamId: 'stream-1',
      target: makeTarget(),
      sendIceCandidate: vi.fn(),
      startRemote: vi.fn(async () => ({
        requestId: 'rw-start-1',
        streamId: 'stream-1',
        targetId: 'pane-1',
        answer: { type: 'answer' as const, sdp: 'remote-answer-sdp' },
        capture: {
          source: 'ScreenCaptureKit' as const,
          frameWidth: 640,
          frameHeight: 360,
          frameRate: 5,
          targetKind: 'iterm2-pane' as const,
        },
        transport: { kind: 'webrtc-video' as const },
      })),
    });
    await flushMicrotasks();
    const peer = MockRTCPeerConnection.instances[0]!;
    peer.emitVideoTrack(mediaStream);
    await started;

    expect(runtime.stopStream('stream-1')).toBe(true);
    expect(runtime.stopStream('stream-1')).toBe(false);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    await expect(runtime.addIceCandidate({
      streamId: 'stream-1',
      candidate: { candidate: 'candidate:late' },
    })).resolves.toBe(false);
  });

  it('keeps preview and focus receiver streams independent', async () => {
    const runtime = createRuntime();
    const startRemote = vi.fn(async (offer: RemoteWindowStreamRtcDescription, streamId: string, purpose: 'preview' | 'focus') => ({
      requestId: `rw-start-${streamId}`,
      streamId,
      purpose,
      targetId: 'pane-1',
      answer: { type: 'answer' as const, sdp: `answer-${offer.sdp}` },
      capture: {
        source: 'ScreenCaptureKit' as const,
        frameWidth: 640,
        frameHeight: 360,
        frameRate: purpose === 'preview' ? 12 : 30,
        targetKind: 'iterm2-pane' as const,
      },
      transport: { kind: 'webrtc-video' as const },
    }));

    const canvasStarted = runtime.startStream({
      streamId: 'canvas-stream',
      purpose: 'preview',
      target: makeTarget(),
      sendIceCandidate: vi.fn(),
      startRemote: (offer) => startRemote(offer, 'canvas-stream', 'preview'),
    });
    const focusStarted = runtime.startStream({
      streamId: 'focus-stream',
      purpose: 'focus',
      target: makeTarget(),
      sendIceCandidate: vi.fn(),
      startRemote: (offer) => startRemote(offer, 'focus-stream', 'focus'),
    });

    await flushMicrotasks();
    const canvasPeer = MockRTCPeerConnection.instances[0]!;
    const focusPeer = MockRTCPeerConnection.instances[1]!;
    canvasPeer.emitVideoTrack();
    focusPeer.emitVideoTrack();

    await expect(canvasStarted).resolves.toMatchObject({ streamId: 'canvas-stream', purpose: 'preview' });
    await expect(focusStarted).resolves.toMatchObject({ streamId: 'focus-stream', purpose: 'focus' });
    expect(runtime.getActiveStreamIds().sort()).toEqual(['canvas-stream', 'focus-stream']);

    expect(runtime.stopStream('focus-stream')).toBe(true);
    expect(canvasPeer.close).not.toHaveBeenCalled();
    expect(focusPeer.close).toHaveBeenCalledTimes(1);
    expect(runtime.getActiveStreamIds()).toEqual(['canvas-stream']);
  });

  it('rejects stream setup failures and closes the peer without rendering a fake stream', async () => {
    const runtime = createRuntime();
    const failure = runtime.startStream({
      streamId: 'stream-1',
      target: makeTarget(),
      sendIceCandidate: vi.fn(),
      startRemote: vi.fn(async () => {
        throw new Error('ScreenCaptureKit capture start failure');
      }),
    });

    await expect(failure).rejects.toThrow('ScreenCaptureKit capture start failure');
    expect(MockRTCPeerConnection.instances[0]!.close).toHaveBeenCalledTimes(1);
    expect(runtime.getActiveStreamIds()).toEqual([]);
  });

  it('does not spend receiver track timeout while daemon stream start is pending', async () => {
    MockRTCPeerConnection.reset();
    const timeoutDelays: number[] = [];
    const runtime = createRemoteWindowReceiverRuntime({
      peerConnectionFactory: (configuration) => new MockRTCPeerConnection(configuration) as unknown as RTCPeerConnection,
      mediaStreamFactory: () => new MockMediaStream() as unknown as MediaStream,
      setTimeoutFn: vi.fn((_handler, delay) => {
        timeoutDelays.push(Number(delay));
        return 1;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });
    type RemoteStartResolve = (payload: {
      requestId: string;
      streamId: string;
      targetId: string;
      answer: { type: 'answer'; sdp: string };
      capture: {
        source: 'ScreenCaptureKit';
        frameWidth: number;
        frameHeight: number;
        frameRate: number;
        targetKind: 'iterm2-pane';
      };
      transport: { kind: 'webrtc-video' };
    }) => void;
    let resolveRemote: RemoteStartResolve | undefined;

    const started = runtime.startStream({
      streamId: 'stream-1',
      target: makeTarget(),
      sendIceCandidate: vi.fn(),
      startRemote: vi.fn(async () => new Promise((resolve) => {
        resolveRemote = resolve;
      })),
    });
    await flushMicrotasks();

    expect(timeoutDelays).toEqual([]);
    const completeRemote: RemoteStartResolve | undefined = resolveRemote;
    if (typeof completeRemote !== 'function') {
      throw new Error('startRemote resolver was not captured');
    }
    completeRemote({
      requestId: 'rw-start-1',
      streamId: 'stream-1',
      targetId: 'pane-1',
      answer: { type: 'answer', sdp: 'remote-answer-sdp' },
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 5,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    });
    await flushMicrotasks();

    expect(timeoutDelays[0]).toBe(REMOTE_WINDOW_RECEIVER_TRACK_TIMEOUT_MS);
    expect(REMOTE_WINDOW_RECEIVER_TRACK_TIMEOUT_MS).toBeGreaterThan(20_000);
    MockRTCPeerConnection.instances[0]!.emitVideoTrack();
    await expect(started).resolves.toMatchObject({
      streamId: 'stream-1',
    });
  });

  it('does not arm a receiver track timeout when daemon stream start fails before answer', async () => {
    MockRTCPeerConnection.reset();
    const timeoutDelays: number[] = [];
    const runtime = createRemoteWindowReceiverRuntime({
      peerConnectionFactory: (configuration) => new MockRTCPeerConnection(configuration) as unknown as RTCPeerConnection,
      mediaStreamFactory: () => new MockMediaStream() as unknown as MediaStream,
      setTimeoutFn: vi.fn((_handler, delay) => {
        timeoutDelays.push(Number(delay));
        return 1;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    await expect(runtime.startStream({
      streamId: 'stream-1',
      target: makeTarget(),
      sendIceCandidate: vi.fn(),
      startRemote: vi.fn(async () => {
        throw new Error('ScreenCaptureKit capture start failure');
      }),
    })).rejects.toThrow('ScreenCaptureKit capture start failure');

    expect(timeoutDelays).toEqual([]);
  });

  it('rejects when no video track arrives before timeout', async () => {
    const timeoutHandlers: Array<() => void> = [];
    const runtime = createRuntime(timeoutHandlers);
    const pending = runtime.startStream({
      streamId: 'stream-1',
      target: makeTarget(),
      sendIceCandidate: vi.fn(),
      startRemote: vi.fn(async () => ({
        requestId: 'rw-start-1',
        streamId: 'stream-1',
        targetId: 'pane-1',
        answer: { type: 'answer' as const, sdp: 'remote-answer-sdp' },
        capture: {
          source: 'ScreenCaptureKit' as const,
          frameWidth: 640,
          frameHeight: 360,
          frameRate: 5,
          targetKind: 'iterm2-pane' as const,
        },
        transport: { kind: 'webrtc-video' as const },
      })),
    });

    await flushMicrotasks();
    timeoutHandlers[0]?.();

    await expect(pending).rejects.toThrow('Remote window receiver did not receive a video track');
    expect(MockRTCPeerConnection.instances[0]!.close).toHaveBeenCalledTimes(1);
    expect(runtime.getActiveStreamIds()).toEqual([]);
  });

  it('fails explicitly when the WebView does not provide WebRTC primitives', async () => {
    const runtime = createRemoteWindowReceiverRuntime({
      mediaStreamFactory: () => new MockMediaStream() as unknown as MediaStream,
    });

    await expect(runtime.startStream({
      streamId: 'stream-1',
      target: makeTarget(),
      sendIceCandidate: vi.fn(),
      startRemote: vi.fn(),
    })).rejects.toThrow('Remote window receiver requires RTCPeerConnection');
  });
});
