import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteWindowReceiverRuntime,
  REMOTE_WINDOW_RECEIVER_TRACK_TIMEOUT_MS,
} from './remote-window-receiver-runtime';
import type {
  RemoteWindowStreamRtcDescription,
  RemoteWindowStreamStartedOfferV2Payload,
  RemoteWindowStreamTargetManifest,
} from './types';
import type { RemoteWindowStreamMediaBinding } from '@zterm/shared/protocol';

class MockMediaTrack {
  kind = 'video';
  id = '';
  stop = vi.fn();
}

class MockMediaStream {
  id = '';
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
  transceivers: Array<{ mid: string | null }> = [];
  addTransceiver = vi.fn(() => {
    const transceiver = { mid: null as string | null };
    this.transceivers.push(transceiver);
    return transceiver;
  });
  addIceCandidate = vi.fn(async () => undefined);
  close = vi.fn();
  getStats = vi.fn(async () => new Map());
  getTransceivers = vi.fn(() => this.transceivers as unknown as RTCRtpTransceiver[]);

  constructor(public readonly configuration: RTCConfiguration) {
    MockRTCPeerConnection.instances.push(this);
  }

  async createOffer() {
    return { type: 'offer' as const, sdp: 'local-offer-sdp' };
  }

  async createAnswer() {
    return { type: 'answer' as const, sdp: 'local-answer-sdp' };
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

  emitVideoTrack(stream = new MockMediaStream([new MockMediaTrack()]), mid: string | null = '0') {
    const transceiverIndex = mid !== null && /^\d+$/.test(mid) ? Number(mid) : 0;
    const transceiver = this.transceivers[transceiverIndex] ?? { mid: null };
    transceiver.mid = mid;
    this.ontrack?.({
      track: stream.getTracks()[0],
      streams: [stream],
      transceiver,
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

function createRuntime(
  timeoutHandlers?: Array<() => void>,
  nowMs: () => number = Date.now,
) {
  MockRTCPeerConnection.reset();
  return createRemoteWindowReceiverRuntime({
    peerConnectionFactory: (configuration) => new MockRTCPeerConnection(configuration) as unknown as RTCPeerConnection,
    mediaStreamFactory: () => new MockMediaStream() as unknown as MediaStream,
    trackTimeoutMs: 50,
    nowMs,
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

type InboundVideoStatsFixture = {
  id: string;
  trackId: string;
  mid: string;
  ssrc: number;
  packetsReceived?: number;
  packetsLost?: number;
};

function inboundStatsReport(
  fixtures: InboundVideoStatsFixture[],
): Map<string, unknown> {
  return new Map<string, unknown>(
    fixtures.map((fixture) => [
      fixture.id,
      {
        type: 'inbound-rtp',
        kind: 'video',
        trackIdentifier: fixture.trackId,
        mid: fixture.mid,
        ssrc: fixture.ssrc,
        transportId: 'transport-1',
        packetsReceived: fixture.packetsReceived,
        packetsLost: fixture.packetsLost,
      },
    ]),
  );
}

describe('remote window receiver runtime', () => {
  it('creates a recvonly video offer, waits for a real video track, and returns the receiver stream', async () => {
    const runtime = createRuntime();
    const sendIceCandidate = vi.fn();
    const startRemote = vi.fn(async (_offer) => ({
      requestId: 'rw-start-1',
      streamId: 'stream-1',
      targetId: 'pane-1',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
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

    await flushMicrotasks(20);
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
      startupTelemetry: {
        captureStartedAt: expect.any(Number),
        answerAppliedAt: expect.any(Number),
        focusTrackAttachedAt: expect.any(Number),
      },
    });
  });

  it('commits decoded frames monotonically and retires the prior lane binding exactly once', async () => {
    const runtime = createRuntime();
    const offer: RemoteWindowStreamStartedOfferV2Payload = {
      requestId: 'rw-v2-replace',
      streamId: 'stream-v2-replace',
      targetId: 'pane-1',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 2,
      offer: { type: 'offer', sdp: 'host-offer' },
      mediaBindings: [{
        role: 'focus',
        epoch: 0,
        mediaStreamId: 'focus-media-0',
        trackId: 'focus-track-0',
      }],
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    };
    const sendAnswer = vi.fn();
    const pending = runtime.startStream({
      streamId: offer.streamId,
      target: makeTarget(),
      protocolVersion: 2,
      sendIceCandidate: vi.fn(),
      sendAnswer,
      startRemote: vi.fn(async () => offer),
    });
    await flushMicrotasks(12);
    const peer = MockRTCPeerConnection.instances[0]!;
    const oldTrack = new MockMediaTrack();
    oldTrack.id = 'focus-track-0';
    const oldStream = new MockMediaStream([oldTrack]);
    oldStream.id = 'focus-media-0';
    peer.emitVideoTrack(oldStream);
    const started = await pending;
    const onCommit = vi.fn();
    const firstCommit = {
      streamId: offer.streamId,
      mediaPlanVersion: 2,
      lane: 'focus' as const,
      mediaEpoch: 0,
      trackId: 'focus-track-0',
      frameId: 4,
      width: 640,
      height: 360,
    };
    expect(started.commitDecodedFrame(firstCommit)).toBe(true);
    expect(started.commitDecodedFrame({ ...firstCommit, frameId: 4 })).toBe(false);
    expect(started.commitDecodedFrame({ ...firstCommit, frameId: 3 })).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();

    const replacement: RemoteWindowStreamMediaBinding = {
      role: 'focus',
      epoch: 1,
      mediaStreamId: 'focus-media-1',
      trackId: 'focus-track-1',
    };
    await expect(started.replaceLaneBinding?.(
      replacement,
      { type: 'offer', sdp: 'replacement-offer' },
      sendAnswer,
    )).resolves.toBe(true);
    expect(oldTrack.stop).toHaveBeenCalledTimes(1);
    expect(started.commitDecodedFrame(firstCommit)).toBe(false);

    const newTrack = new MockMediaTrack();
    newTrack.id = replacement.trackId;
    const newStream = new MockMediaStream([newTrack]);
    newStream.id = replacement.mediaStreamId;
    peer.emitVideoTrack(newStream);
    const replacementCommit = {
      ...firstCommit,
      mediaEpoch: 1,
      trackId: replacement.trackId,
      frameId: 0,
    };
    expect(started.commitDecodedFrame(replacementCommit)).toBe(true);
    expect(oldTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('binds v2 tracks by negotiated m-line when receiver-local ids differ from sender ids', async () => {
    const runtime = createRuntime();
    const offer: RemoteWindowStreamStartedOfferV2Payload = {
      requestId: 'rw-v2-cross-endpoint-ids',
      streamId: 'stream-v2-cross-endpoint-ids',
      targetId: 'pane-1',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 2,
      offer: { type: 'offer', sdp: 'host-offer' },
      mediaBindings: [{
        role: 'focus',
        epoch: 0,
        mediaStreamId: 'sender-stream-id',
        trackId: 'sender-track-id',
      }],
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    };
    const sendAnswer = vi.fn();
    const started = runtime.startStream({
      streamId: offer.streamId,
      target: makeTarget(),
      protocolVersion: 2,
      sendIceCandidate: vi.fn(),
      sendAnswer,
      startRemote: vi.fn(async () => offer),
    });
    await flushMicrotasks(20);
    const peer = MockRTCPeerConnection.instances[0]!;
    const receiverTrack = new MockMediaTrack();
    receiverTrack.id = 'receiver-track-id';
    const receiverStream = new MockMediaStream([receiverTrack]);
    receiverStream.id = 'receiver-stream-id';

    peer.emitVideoTrack(receiverStream, '0');

    await expect(started).resolves.toMatchObject({
      streamId: offer.streamId,
      mediaStream: receiverStream,
      bindings: [{ lane: 'focus', trackId: 'receiver-track-id' }],
    });
    expect(peer.close).not.toHaveBeenCalled();
    expect(sendAnswer).toHaveBeenCalledWith(expect.objectContaining({
      requestId: offer.requestId,
      streamId: offer.streamId,
      mediaPlanVersion: 2,
    }));
  });

  it('fails explicitly when a v2 track has no registered transceiver lane', async () => {
    const runtime = createRuntime();
    const offer: RemoteWindowStreamStartedOfferV2Payload = {
      requestId: 'rw-v2-missing-mid',
      streamId: 'stream-v2-missing-mid',
      targetId: 'pane-1',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 2,
      offer: { type: 'offer', sdp: 'host-offer' },
      mediaBindings: [{
        role: 'focus',
        epoch: 0,
        mediaStreamId: 'sender-stream-id',
        trackId: 'sender-track-id',
      }],
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    };
    const started = runtime.startStream({
      streamId: offer.streamId,
      target: makeTarget(),
      protocolVersion: 2,
      sendIceCandidate: vi.fn(),
      sendAnswer: vi.fn(),
      startRemote: vi.fn(async () => offer),
    });
    await flushMicrotasks(20);
    const peer = MockRTCPeerConnection.instances[0]!;
    const track = new MockMediaTrack();
    const stream = new MockMediaStream([track]);
    peer.ontrack?.({
      track,
      streams: [stream],
    } as unknown as RTCTrackEvent);

    await expect(started).rejects.toThrow('without registered transceiver lane');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
  });

  it('binds v2 tracks when the negotiated mid is an opaque string', async () => {
    const runtime = createRuntime();
    const offer: RemoteWindowStreamStartedOfferV2Payload = {
      requestId: 'rw-v2-opaque-mid',
      streamId: 'stream-v2-opaque-mid',
      targetId: 'pane-1',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 2,
      offer: { type: 'offer', sdp: 'host-offer' },
      mediaBindings: [{
        role: 'focus',
        epoch: 0,
        mediaStreamId: 'sender-stream-id',
        trackId: 'sender-track-id',
      }],
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    };
    const sendAnswer = vi.fn();
    const started = runtime.startStream({
      streamId: offer.streamId,
      target: makeTarget(),
      protocolVersion: 2,
      sendIceCandidate: vi.fn(),
      sendAnswer,
      startRemote: vi.fn(async () => offer),
    });
    await flushMicrotasks(20);
    const peer = MockRTCPeerConnection.instances[0]!;
    const receiverTrack = new MockMediaTrack();
    receiverTrack.id = 'receiver-track-id';
    const receiverStream = new MockMediaStream([receiverTrack]);
    receiverStream.id = 'receiver-stream-id';

    peer.emitVideoTrack(receiverStream, 'focus');

    await expect(started).resolves.toMatchObject({
      streamId: offer.streamId,
      mediaStream: receiverStream,
      bindings: [{ lane: 'focus', trackId: 'receiver-track-id' }],
    });
    expect(peer.close).not.toHaveBeenCalled();
    expect(sendAnswer).toHaveBeenCalledWith(expect.objectContaining({
      requestId: offer.requestId,
      streamId: offer.streamId,
      mediaPlanVersion: 2,
    }));
  });

  it('binds v2 tracks when the track event exposes a distinct transceiver wrapper', async () => {
    const runtime = createRuntime();
    const offer: RemoteWindowStreamStartedOfferV2Payload = {
      requestId: 'rw-v2-wrapper-mid',
      streamId: 'stream-v2-wrapper-mid',
      targetId: 'pane-1',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 2,
      offer: { type: 'offer', sdp: 'host-offer' },
      mediaBindings: [{
        role: 'focus',
        epoch: 0,
        mediaStreamId: 'sender-stream-id',
        trackId: 'sender-track-id',
      }],
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    };
    const started = runtime.startStream({
      streamId: offer.streamId,
      target: makeTarget(),
      protocolVersion: 2,
      sendIceCandidate: vi.fn(),
      sendAnswer: vi.fn(),
      startRemote: vi.fn(async () => offer),
    });
    await flushMicrotasks(20);
    const peer = MockRTCPeerConnection.instances[0]!;
    const track = new MockMediaTrack();
    const stream = new MockMediaStream([track]);
    peer.ontrack?.({
      track,
      streams: [stream],
      transceiver: { mid: '0' },
    } as unknown as RTCTrackEvent);

    await expect(started).resolves.toMatchObject({ streamId: offer.streamId });
  });

  it('negotiates focus-only for a single app window', async () => {
    const runtime = createRuntime();
    const appTarget = {
      ...makeTarget(),
      streamTargetId: 'app-window:123:456',
      videoTarget: {
        ...makeTarget().videoTarget,
        kind: 'app-window' as const,
      },
    } as RemoteWindowStreamTargetManifest;
    const started = runtime.startStream({
      streamId: 'app-stream',
      target: appTarget,
      sendIceCandidate: vi.fn(),
      startRemote: vi.fn(async () => ({
        requestId: 'rw-app-start',
        streamId: 'app-stream',
        targetId: 'app-window:123:456',
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
        answer: { type: 'answer' as const, sdp: 'answer-app' },
        capture: {
          source: 'ScreenCaptureKit' as const,
          frameWidth: 800,
          frameHeight: 600,
          frameRate: 30,
          targetKind: 'app-window' as const,
        },
        transport: { kind: 'webrtc-video' as const },
      })),
    });
    await flushMicrotasks(20);
    const peer = MockRTCPeerConnection.instances[0]!;
    expect(peer.addTransceiver).toHaveBeenCalledTimes(1);
    const focusStream = peer.emitVideoTrack();
    await expect(started).resolves.toMatchObject({
      mediaStream: focusStream,
      started: { mediaPlan: 'single-focus', mediaPlanVersion: 1 as const },
    });
  });

  it('negotiates focus and overview only for a composite app group', async () => {
    const timeoutHandlers: Array<() => void> = [];
    const runtime = createRuntime(timeoutHandlers);
    const target = {
      ...makeTarget(),
      compositeWindows: [{
        windowId: 'window-2',
        title: 'second',
        windowBoundsTopLeftPx: { x: 1000, y: 80, width: 800, height: 600 },
        cropRectTopLeftPx: { x: 1000, y: 80, width: 800, height: 600 },
      }],
    } as RemoteWindowStreamTargetManifest;
    const started = runtime.startStream({
      streamId: 'composite-stream',
      target,
      sendIceCandidate: vi.fn(),
      startRemote: vi.fn(async () => ({
        requestId: 'rw-composite-start',
        streamId: 'composite-stream',
        targetId: 'pane-1',
        mediaPlan: 'overview-plus-focus' as const,
        mediaPlanVersion: 1 as const,
        answer: { type: 'answer' as const, sdp: 'answer-composite' },
        capture: {
          source: 'ScreenCaptureKit' as const,
          frameWidth: 1920,
          frameHeight: 1080,
          frameRate: 30,
          targetKind: 'iterm2-pane' as const,
        },
        transport: { kind: 'webrtc-video' as const },
      })),
    });
    await flushMicrotasks(20);
    const peer = MockRTCPeerConnection.instances[0]!;
    expect(peer.addTransceiver).toHaveBeenCalledTimes(2);
    const focusStream = peer.emitVideoTrack();
    timeoutHandlers[0]?.();
    const overviewStream = new MockMediaStream([new MockMediaTrack()]);
    overviewStream.id = 'overview';
    peer.emitVideoTrack(overviewStream, '1');
    await expect(started).resolves.toMatchObject({
      mediaStream: focusStream,
      overviewMediaStream: overviewStream,
      started: { mediaPlan: 'overview-plus-focus', mediaPlanVersion: 1 as const },
    });
  });

  it('keeps the composite timeout armed after focus and reports the missing overview lane', async () => {
    const timeoutHandlers: Array<() => void> = [];
    const runtime = createRuntime(timeoutHandlers);
    const target = {
      ...makeTarget(),
      compositeWindows: [{
        windowId: 'window-2',
        title: 'second',
        windowBoundsTopLeftPx: { x: 1000, y: 80, width: 800, height: 600 },
        cropRectTopLeftPx: { x: 1000, y: 80, width: 800, height: 600 },
      }],
    } as RemoteWindowStreamTargetManifest;
    const started = runtime.startStream({
      streamId: 'composite-timeout',
      target,
      sendIceCandidate: vi.fn(),
      startRemote: vi.fn(async () => ({
        requestId: 'rw-composite-timeout',
        streamId: 'composite-timeout',
        targetId: 'pane-1',
        mediaPlan: 'overview-plus-focus' as const,
        mediaPlanVersion: 1 as const,
        answer: { type: 'answer' as const, sdp: 'answer-composite' },
        capture: {
          source: 'ScreenCaptureKit' as const,
          frameWidth: 1920,
          frameHeight: 1080,
          frameRate: 30,
          targetKind: 'iterm2-pane' as const,
        },
        transport: { kind: 'webrtc-video' as const },
      })),
    });
    await flushMicrotasks(20);

    MockRTCPeerConnection.instances[0]!.emitVideoTrack();
    timeoutHandlers[1]?.();

    await expect(started).rejects.toMatchObject({
      name: 'remote_window_receiver_lane_timeout',
      failureStage: 'track-attach',
      lane: 'overview',
      elapsedMs: expect.any(Number),
    });
    expect(MockRTCPeerConnection.instances[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a started response whose explicit media plan does not match the offer lanes', async () => {
    const runtime = createRuntime();
    await expect(runtime.startStream({
      streamId: 'stream-plan-mismatch',
      target: makeTarget(),
      sendIceCandidate: vi.fn(),
      startRemote: vi.fn(async () => ({
        requestId: 'rw-plan-mismatch',
        streamId: 'stream-plan-mismatch',
        targetId: 'pane-1',
        mediaPlan: 'overview-plus-focus' as const,
        mediaPlanVersion: 1 as const,
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
    })).rejects.toThrow('Remote window media plan mismatch: expected single-focus, got overview-plus-focus');
  });

  it('sends local ICE candidates and applies remote candidates by stream id', async () => {
    const runtime = createRuntime();
    const sendIceCandidate = vi.fn();
    const startRemote = vi.fn(async () => ({
      requestId: 'rw-start-1',
      streamId: 'stream-1',
      targetId: 'pane-1',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
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
    }, 'rw-start-1');
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

  it('sends the start request before flushing local ICE gathered during offer creation', async () => {
    const runtime = createRuntime();
    const order: string[] = [];
    const started = runtime.startStream({
      streamId: 'stream-local-ice-order',
      target: makeTarget(),
      sendIceCandidate: () => order.push('candidate'),
      startRemote: vi.fn(async () => {
        order.push('start');
        return {
          requestId: 'rw-start-local-ice-order',
          streamId: 'stream-local-ice-order',
          targetId: 'pane-1',
          mediaPlan: 'single-focus' as const,
          mediaPlanVersion: 1 as const,
          answer: { type: 'answer' as const, sdp: 'remote-answer-sdp' },
          capture: {
            source: 'ScreenCaptureKit' as const,
            frameWidth: 640,
            frameHeight: 360,
            frameRate: 30,
            targetKind: 'iterm2-pane' as const,
          },
          transport: { kind: 'webrtc-video' as const },
        };
      }),
    });
    const peer = MockRTCPeerConnection.instances[0]!;
    peer.emitLocalCandidate();
    await flushMicrotasks(20);
    peer.emitVideoTrack();
    await started;
    expect(order).toEqual(['start', 'candidate']);
  });

  it('queues early remote ICE until the answer is applied, then flushes it in order', async () => {
    const runtime = createRuntime();
    let resolveStarted!: (payload: any) => void;
    const startRemote = vi.fn(() => new Promise<import('./types').RemoteWindowStreamStartedPayload>((resolve) => {
      resolveStarted = resolve;
    }));
    const started = runtime.startStream({
      streamId: 'stream-early-ice',
      target: makeTarget(),
      sendIceCandidate: vi.fn(),
      startRemote,
    });
    await flushMicrotasks(10);
    const peer = MockRTCPeerConnection.instances[0]!;
    await expect(runtime.addIceCandidate({
      streamId: 'stream-early-ice',
      candidate: { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 },
    })).resolves.toBe(true);
    expect(peer.addIceCandidate).not.toHaveBeenCalled();

    resolveStarted({
      requestId: 'rw-start-early',
      streamId: 'stream-early-ice',
      targetId: 'pane-1',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 1 as const,
      answer: { type: 'answer', sdp: 'remote-answer-sdp' },
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    });
    await flushMicrotasks(10);
    expect(peer.addIceCandidate).toHaveBeenCalledWith({
      candidate: 'candidate:early',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    });
    peer.emitVideoTrack();
    await expect(started).resolves.toMatchObject({ streamId: 'stream-early-ice' });
  });

  it('isolates lane baselines and uses only the selected transport pair for RTT', async () => {
    let now = 1_000;
    const runtime = createRuntime(undefined, () => now);
    const target = {
      ...makeTarget(),
      compositeWindows: [{
        windowId: 'window-2',
        title: 'second',
        windowBoundsTopLeftPx: { x: 1000, y: 80, width: 800, height: 600 },
        cropRectTopLeftPx: { x: 1000, y: 80, width: 800, height: 600 },
      }],
    } as RemoteWindowStreamTargetManifest;
    const offer: RemoteWindowStreamStartedOfferV2Payload = {
      requestId: 'rw-stats-lanes',
      streamId: 'stream-stats-lanes',
      targetId: 'pane-1',
      mediaPlan: 'overview-plus-focus',
      mediaPlanVersion: 2,
      offer: { type: 'offer', sdp: 'host-offer' },
      mediaBindings: [
        { role: 'focus', epoch: 0, mediaStreamId: 'sender-focus-stream', trackId: 'sender-focus-track' },
        { role: 'overview', epoch: 0, mediaStreamId: 'sender-overview-stream', trackId: 'sender-overview-track' },
      ],
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 1920,
        frameHeight: 1080,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    };
    const started = runtime.startStream({
      streamId: offer.streamId,
      target,
      protocolVersion: 2,
      sendIceCandidate: vi.fn(),
      sendAnswer: vi.fn(),
      startRemote: vi.fn(async () => offer),
    });
    await flushMicrotasks(20);
    const peer = MockRTCPeerConnection.instances[0]!;
    const focusTrack = new MockMediaTrack();
    focusTrack.id = 'receiver-focus-track';
    const focusStream = new MockMediaStream([focusTrack]);
    focusStream.id = 'receiver-focus-stream';
    peer.emitVideoTrack(focusStream, '0');
    const overviewTrack = new MockMediaTrack();
    overviewTrack.id = 'receiver-overview-track';
    const overviewStream = new MockMediaStream([overviewTrack]);
    overviewStream.id = 'receiver-overview-stream';
    peer.emitVideoTrack(overviewStream, '1');
    const result = await started;

    peer.getStats.mockResolvedValue(new Map<string, unknown>([
      ['inbound-focus', {
        type: 'inbound-rtp',
        kind: 'video',
        trackIdentifier: focusTrack.id,
        mid: '0',
        ssrc: 111,
        transportId: 'transport-1',
        framesPerSecond: 30,
        bytesReceived: 1_000,
        framesDropped: 2,
        freezeCount: 0,
        jitterBufferDelay: 0.2,
        jitterBufferEmittedCount: 10,
      }],
      ['inbound-overview', {
        type: 'inbound-rtp',
        kind: 'video',
        trackIdentifier: overviewTrack.id,
        mid: '1',
        ssrc: 222,
        transportId: 'transport-1',
        framesPerSecond: 5,
        bytesReceived: 2_000,
        framesDropped: 20,
        freezeCount: 5,
        jitterBufferDelay: 1,
        jitterBufferEmittedCount: 20,
      }],
      ['transport-1', {
        type: 'transport',
        id: 'transport-1',
        selectedCandidatePairId: 'pair-selected',
      }],
      ['pair-selected', {
        type: 'candidate-pair',
        id: 'pair-selected',
        state: 'succeeded',
        nominated: true,
        currentRoundTripTime: 0.05,
        availableIncomingBitrate: 123_456,
      }],
      ['pair-other', {
        type: 'candidate-pair',
        id: 'pair-other',
        state: 'succeeded',
        nominated: false,
        currentRoundTripTime: 0.9,
      }],
      ['remote-inbound', {
        type: 'remote-inbound-rtp',
        kind: 'video',
        roundTripTime: 0.8,
      }],
    ]));

    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      lane: 'focus',
      trackId: focusTrack.id,
      mediaEpoch: 0,
      ssrc: 111,
      mid: '0',
      transportId: 'transport-1',
      selectedCandidatePairId: 'pair-selected',
      framesPerSecond: 30,
      framesDropped: null,
      freezeCount: null,
      jitterBufferDelayMs: null,
      receivedBitrateBps: null,
      rttMs: 50,
      availableIncomingBitrateBps: 123_456,
    });
    now = 1_500;
    await expect(runtime.getStatsSample(offer.streamId, 'overview')).resolves.toMatchObject({
      lane: 'overview',
      trackId: overviewTrack.id,
      ssrc: 222,
      mid: '1',
      framesPerSecond: 5,
      framesDropped: null,
      freezeCount: null,
      jitterBufferDelayMs: null,
      receivedBitrateBps: null,
    });

    now = 2_000;
    peer.getStats.mockResolvedValue(new Map<string, unknown>([
      ['inbound-focus', {
        type: 'inbound-rtp',
        kind: 'video',
        trackIdentifier: focusTrack.id,
        mid: '0',
        ssrc: 111,
        transportId: 'transport-1',
        framesPerSecond: 28,
        bytesReceived: 2_000,
        framesDropped: 5,
        freezeCount: 1,
        jitterBufferDelay: 0.5,
        jitterBufferEmittedCount: 20,
      }],
      ['inbound-overview', {
        type: 'inbound-rtp',
        kind: 'video',
        trackIdentifier: overviewTrack.id,
        mid: '1',
        ssrc: 222,
        transportId: 'transport-1',
        framesPerSecond: 4,
        bytesReceived: 4_000,
        framesDropped: 30,
        freezeCount: 7,
        jitterBufferDelay: 1.5,
        jitterBufferEmittedCount: 40,
      }],
      ['transport-1', {
        type: 'transport',
        id: 'transport-1',
        selectedCandidatePairId: 'pair-selected',
      }],
      ['pair-selected', {
        type: 'candidate-pair',
        id: 'pair-selected',
        state: 'succeeded',
        nominated: true,
        currentRoundTripTime: 0.07,
      }],
      ['pair-other', {
        type: 'candidate-pair',
        id: 'pair-other',
        state: 'succeeded',
        nominated: true,
        currentRoundTripTime: 0.9,
      }],
    ]));

    await expect(runtime.getStatsSample(offer.streamId, 'overview')).resolves.toMatchObject({
      lane: 'overview',
      framesDropped: 10,
      freezeCount: 2,
      jitterBufferDelayMs: 25,
      receivedBitrateBps: 32_000,
      rttMs: 70,
    });
    now = 2_500;
    const focusSample = await runtime.getStatsSample(offer.streamId, 'focus');
    expect(focusSample).toMatchObject({
      lane: 'focus',
      framesDropped: 3,
      freezeCount: 1,
      jitterBufferDelayMs: 30,
      rttMs: 70,
    });
    expect(focusSample?.receivedBitrateBps).toBeCloseTo(5_333.333333333333);
    expect(result.collectStats).toBeDefined();
  });

  it('computes received packet loss ratio from inbound counter deltas', async () => {
    let now = 1_000;
    const runtime = createRuntime(undefined, () => now);
    const offer: RemoteWindowStreamStartedOfferV2Payload = {
      requestId: 'rw-stats-loss',
      streamId: 'stream-stats-loss',
      targetId: 'pane-1',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 2,
      offer: { type: 'offer', sdp: 'host-offer' },
      mediaBindings: [{
        role: 'focus',
        epoch: 0,
        mediaStreamId: 'sender-focus-stream',
        trackId: 'sender-focus-track',
      }],
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    };
    const started = runtime.startStream({
      streamId: offer.streamId,
      target: makeTarget(),
      protocolVersion: 2,
      sendIceCandidate: vi.fn(),
      sendAnswer: vi.fn(),
      startRemote: vi.fn(async () => offer),
    });
    await flushMicrotasks(20);
    const peer = MockRTCPeerConnection.instances[0]!;
    const track = new MockMediaTrack();
    track.id = 'receiver-focus-track';
    peer.emitVideoTrack(new MockMediaStream([track]), '0');
    await started;

    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: 0, packetsLost: 0 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      lane: 'focus',
      ssrc: 111,
      receivedPacketLossRatio: null,
    });

    now = 2_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: 100, packetsLost: 9 },
    ]));
    const lossSample = await runtime.getStatsSample(offer.streamId, 'focus');
    expect(lossSample?.receivedPacketLossRatio).toBe(9 / 109);

    now = 3_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: 200, packetsLost: 9 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      receivedPacketLossRatio: 0,
    });

    now = 4_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: 200, packetsLost: 9 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      receivedPacketLossRatio: null,
    });

    now = 5_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: 199, packetsLost: 9 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      receivedPacketLossRatio: null,
    });

    now = 6_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: 201, packetsLost: 8 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      receivedPacketLossRatio: null,
    });

    now = 7_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: 201, packetsLost: 8 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      receivedPacketLossRatio: null,
    });

    now = 8_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: 201, packetsLost: 20 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      receivedPacketLossRatio: 12 / 12,
    });
  });

  it('keeps lane packet loss baselines independent', async () => {
    let now = 1_000;
    const runtime = createRuntime(undefined, () => now);
    const target = {
      ...makeTarget(),
      compositeWindows: [{
        windowId: 'window-2',
        title: 'second',
        windowBoundsTopLeftPx: { x: 1000, y: 80, width: 800, height: 600 },
        cropRectTopLeftPx: { x: 1000, y: 80, width: 800, height: 600 },
      }],
    } as RemoteWindowStreamTargetManifest;
    const offer: RemoteWindowStreamStartedOfferV2Payload = {
      requestId: 'rw-stats-loss-lanes',
      streamId: 'stream-stats-loss-lanes',
      targetId: 'pane-1',
      mediaPlan: 'overview-plus-focus',
      mediaPlanVersion: 2,
      offer: { type: 'offer', sdp: 'host-offer' },
      mediaBindings: [
        { role: 'focus', epoch: 0, mediaStreamId: 'sender-focus-stream', trackId: 'sender-focus-track' },
        { role: 'overview', epoch: 0, mediaStreamId: 'sender-overview-stream', trackId: 'sender-overview-track' },
      ],
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 1920,
        frameHeight: 1080,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    };
    const started = runtime.startStream({
      streamId: offer.streamId,
      target,
      protocolVersion: 2,
      sendIceCandidate: vi.fn(),
      sendAnswer: vi.fn(),
      startRemote: vi.fn(async () => offer),
    });
    await flushMicrotasks(20);
    const peer = MockRTCPeerConnection.instances[0]!;
    const focusTrack = new MockMediaTrack();
    focusTrack.id = 'receiver-focus-track';
    peer.emitVideoTrack(new MockMediaStream([focusTrack]), '0');
    const overviewTrack = new MockMediaTrack();
    overviewTrack.id = 'receiver-overview-track';
    peer.emitVideoTrack(new MockMediaStream([overviewTrack]), '1');
    await started;

    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: focusTrack.id, mid: '0', ssrc: 111, packetsReceived: 0, packetsLost: 0 },
      { id: 'inbound-overview', trackId: overviewTrack.id, mid: '1', ssrc: 222, packetsReceived: 50, packetsLost: 5 },
    ]));
    await runtime.getStatsSample(offer.streamId, 'focus');
    await runtime.getStatsSample(offer.streamId, 'overview');

    now = 2_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: focusTrack.id, mid: '0', ssrc: 111, packetsReceived: 100, packetsLost: 9 },
      { id: 'inbound-overview', trackId: overviewTrack.id, mid: '1', ssrc: 222, packetsReceived: 50, packetsLost: 5 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'overview')).resolves.toMatchObject({
      lane: 'overview',
      receivedPacketLossRatio: null,
    });
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      receivedPacketLossRatio: 9 / 109,
    });

    now = 3_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: focusTrack.id, mid: '0', ssrc: 111, packetsReceived: 100, packetsLost: 9 },
      { id: 'inbound-overview', trackId: overviewTrack.id, mid: '1', ssrc: 222, packetsReceived: 60, packetsLost: 6 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'overview')).resolves.toMatchObject({
      receivedPacketLossRatio: 1 / 11,
    });

    now = 4_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: focusTrack.id, mid: '0', ssrc: 111, packetsReceived: 150, packetsLost: 9 },
      { id: 'inbound-overview', trackId: overviewTrack.id, mid: '1', ssrc: 222, packetsReceived: 60, packetsLost: 6 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      lane: 'focus',
      receivedPacketLossRatio: 0,
    });
  });

  it('resets the packet loss baseline only for the replaced lane', async () => {
    let now = 1_000;
    const runtime = createRuntime(undefined, () => now);
    const offer: RemoteWindowStreamStartedOfferV2Payload = {
      requestId: 'rw-stats-loss-reset',
      streamId: 'stream-stats-loss-reset',
      targetId: 'pane-1',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 2,
      offer: { type: 'offer', sdp: 'host-offer' },
      mediaBindings: [{
        role: 'focus',
        epoch: 0,
        mediaStreamId: 'sender-focus-stream',
        trackId: 'sender-focus-track',
      }],
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    };
    const started = runtime.startStream({
      streamId: offer.streamId,
      target: makeTarget(),
      protocolVersion: 2,
      sendIceCandidate: vi.fn(),
      sendAnswer: vi.fn(),
      startRemote: vi.fn(async () => offer),
    });
    await flushMicrotasks(20);
    const peer = MockRTCPeerConnection.instances[0]!;
    const oldTrack = new MockMediaTrack();
    oldTrack.id = 'receiver-focus-track-0';
    peer.emitVideoTrack(new MockMediaStream([oldTrack]), '0');
    await started;

    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: oldTrack.id, mid: '0', ssrc: 111, packetsReceived: 0, packetsLost: 0 },
    ]));
    await runtime.getStatsSample(offer.streamId, 'focus');

    now = 2_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: oldTrack.id, mid: '0', ssrc: 111, packetsReceived: 40, packetsLost: 4 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      receivedPacketLossRatio: 4 / 44,
    });

    now = 3_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: oldTrack.id, mid: '0', ssrc: 999, packetsReceived: 50, packetsLost: 10 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      ssrc: 999,
      receivedPacketLossRatio: null,
    });

    now = 4_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: oldTrack.id, mid: '0', ssrc: 999, packetsReceived: 60, packetsLost: 12 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      receivedPacketLossRatio: 2 / 12,
    });

    now = 5_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: oldTrack.id, mid: '1', ssrc: 999, packetsReceived: 100, packetsLost: 20 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      mid: '1',
      receivedPacketLossRatio: null,
    });

    now = 6_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: oldTrack.id, mid: '1', ssrc: 999, packetsReceived: 101, packetsLost: 21 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      receivedPacketLossRatio: 1 / 2,
    });
  });

  it('keeps packet loss ratio unknown for missing or non-finite counters', async () => {
    let now = 1_000;
    const runtime = createRuntime(undefined, () => now);
    const offer: RemoteWindowStreamStartedOfferV2Payload = {
      requestId: 'rw-stats-loss-nonsensical',
      streamId: 'stream-stats-loss-nonsensical',
      targetId: 'pane-1',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 2,
      offer: { type: 'offer', sdp: 'host-offer' },
      mediaBindings: [{
        role: 'focus',
        epoch: 0,
        mediaStreamId: 'sender-focus-stream',
        trackId: 'sender-focus-track',
      }],
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    };
    const started = runtime.startStream({
      streamId: offer.streamId,
      target: makeTarget(),
      protocolVersion: 2,
      sendIceCandidate: vi.fn(),
      sendAnswer: vi.fn(),
      startRemote: vi.fn(async () => offer),
    });
    await flushMicrotasks(20);
    const peer = MockRTCPeerConnection.instances[0]!;
    const track = new MockMediaTrack();
    track.id = 'receiver-focus-track';
    peer.emitVideoTrack(new MockMediaStream([track]), '0');
    await started;

    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: 0, packetsLost: 0 },
    ]));
    await runtime.getStatsSample(offer.streamId, 'focus');

    const cases: Array<{ label: string; sample: InboundVideoStatsFixture }> = [
      {
        label: 'missing packetsLost',
        sample: { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: 50 },
      },
      {
        label: 'missing packetsReceived',
        sample: { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsLost: 5 },
      },
      {
        label: 'NaN packetsReceived',
        sample: { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: Number.NaN, packetsLost: 10 },
      },
      {
        label: 'Infinity packetsLost',
        sample: { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: 90, packetsLost: Number.POSITIVE_INFINITY },
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      now = 2_000 + index * 1_000;
      peer.getStats.mockResolvedValue(inboundStatsReport([testCase.sample]));
      const sample = await runtime.getStatsSample(offer.streamId, 'focus');
      expect(sample?.receivedPacketLossRatio, testCase.label).toBe(null);
    }

    now = 6_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: 90, packetsLost: 9 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      receivedPacketLossRatio: null,
    });

    now = 7_000;
    peer.getStats.mockResolvedValue(inboundStatsReport([
      { id: 'inbound-focus', trackId: track.id, mid: '0', ssrc: 111, packetsReceived: 150, packetsLost: 9 },
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      receivedPacketLossRatio: 0,
    });
  });

  it('keeps RTT unknown when the selected candidate-pair identity is missing', async () => {
    const runtime = createRuntime();
    const offer: RemoteWindowStreamStartedOfferV2Payload = {
      requestId: 'rw-stats-selected-pair',
      streamId: 'stream-stats-selected-pair',
      targetId: 'pane-1',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 2,
      offer: { type: 'offer', sdp: 'host-offer' },
      mediaBindings: [{
        role: 'focus',
        epoch: 0,
        mediaStreamId: 'sender-focus-stream',
        trackId: 'sender-focus-track',
      }],
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    };
    const started = runtime.startStream({
      streamId: offer.streamId,
      target: makeTarget(),
      protocolVersion: 2,
      sendIceCandidate: vi.fn(),
      sendAnswer: vi.fn(),
      startRemote: vi.fn(async () => offer),
    });
    await flushMicrotasks(20);
    const peer = MockRTCPeerConnection.instances[0]!;
    const track = new MockMediaTrack();
    track.id = 'receiver-focus-track';
    const stream = new MockMediaStream([track]);
    peer.emitVideoTrack(stream, '0');
    await started;
    peer.getStats.mockResolvedValue(new Map<string, unknown>([
      ['inbound-focus', {
        type: 'inbound-rtp',
        kind: 'video',
        trackIdentifier: track.id,
        mid: '0',
        transportId: 'transport-1',
      }],
      ['transport-1', {
        type: 'transport',
        id: 'transport-1',
      }],
      ['pair-succeeded', {
        type: 'candidate-pair',
        id: 'pair-succeeded',
        state: 'succeeded',
        nominated: true,
        currentRoundTripTime: 0.9,
      }],
      ['remote-inbound', {
        type: 'remote-inbound-rtp',
        kind: 'video',
        roundTripTime: 0.8,
      }],
    ]));
    await expect(runtime.getStatsSample(offer.streamId)).resolves.toMatchObject({
      lane: 'focus',
      rttMs: null,
      selectedCandidatePairId: null,
    });
  });

  it('resets only the replaced lane baseline', async () => {
    let now = 1_000;
    const runtime = createRuntime(undefined, () => now);
    const offer: RemoteWindowStreamStartedOfferV2Payload = {
      requestId: 'rw-stats-reset',
      streamId: 'stream-stats-reset',
      targetId: 'pane-1',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 2,
      offer: { type: 'offer', sdp: 'host-offer' },
      mediaBindings: [{
        role: 'focus',
        epoch: 0,
        mediaStreamId: 'sender-focus-stream',
        trackId: 'sender-focus-track',
      }],
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    };
    const started = runtime.startStream({
      streamId: offer.streamId,
      target: makeTarget(),
      protocolVersion: 2,
      sendIceCandidate: vi.fn(),
      sendAnswer: vi.fn(),
      startRemote: vi.fn(async () => offer),
    });
    await flushMicrotasks(20);
    const peer = MockRTCPeerConnection.instances[0]!;
    const oldTrack = new MockMediaTrack();
    oldTrack.id = 'receiver-focus-track-0';
    const oldStream = new MockMediaStream([oldTrack]);
    peer.emitVideoTrack(oldStream, '0');
    const result = await started;
    peer.getStats.mockResolvedValue(new Map<string, unknown>([
      ['inbound-focus', {
        type: 'inbound-rtp',
        kind: 'video',
        trackIdentifier: oldTrack.id,
        mid: '0',
        ssrc: 111,
        transportId: 'transport-1',
        bytesReceived: 1_000,
        framesDropped: 4,
      }],
    ]));
    await runtime.getStatsSample(offer.streamId, 'focus');

    now = 2_000;
    peer.getStats.mockResolvedValue(new Map<string, unknown>([
      ['inbound-focus', {
        type: 'inbound-rtp',
        kind: 'video',
        trackIdentifier: oldTrack.id,
        mid: '0',
        ssrc: 111,
        transportId: 'transport-1',
        bytesReceived: 2_000,
        framesDropped: 6,
      }],
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      framesDropped: 2,
      receivedBitrateBps: 8_000,
    });

    await expect(result.replaceLaneBinding?.({
      role: 'focus',
      epoch: 1,
      mediaStreamId: 'sender-focus-stream-1',
      trackId: 'sender-focus-track-1',
    }, { type: 'offer', sdp: 'replacement-offer' }, vi.fn())).resolves.toBe(true);
    const replacementTrack = new MockMediaTrack();
    replacementTrack.id = 'receiver-focus-track-1';
    const replacementStream = new MockMediaStream([replacementTrack]);
    peer.emitVideoTrack(replacementStream, '0');
    now = 3_000;
    peer.getStats.mockResolvedValue(new Map<string, unknown>([
      ['inbound-focus', {
        type: 'inbound-rtp',
        kind: 'video',
        trackIdentifier: replacementTrack.id,
        mid: '0',
        ssrc: 222,
        transportId: 'transport-1',
        bytesReceived: 3_000,
        framesDropped: 10,
      }],
    ]));
    await expect(runtime.getStatsSample(offer.streamId, 'focus')).resolves.toMatchObject({
      mediaEpoch: 1,
      trackId: replacementTrack.id,
      ssrc: 222,
      framesDropped: null,
      receivedBitrateBps: null,
    });
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
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
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
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
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
      mediaPlan: 'single-focus';
      mediaPlanVersion: 1,
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
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
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
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
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

    await expect(pending).rejects.toThrow('Remote window receiver timed out waiting for required lane: focus');
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
