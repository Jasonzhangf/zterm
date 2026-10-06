import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type {
  RemoteWindowStreamStartRequestV2Payload,
  RemoteWindowStreamStatusPayload,
} from '@zterm/shared/protocol';
import { makeRemoteWindowVideoProfileFixture } from './remote-window-video-profile-test-fixture';
import { createRemoteWindowStreamDaemonRuntime } from './remote-window-stream-daemon';

vi.mock('@roamhq/wrtc', () => ({
  default: {
    RTCPeerConnection: class {},
    RTCSessionDescription: class {},
    RTCIceCandidate: class {},
    MediaStream: class {},
    nonstandard: {
      RTCVideoSource: class {},
      rgbaToI420: () => undefined,
    },
  },
}));

const target = () => ({ streamTargetId: 'app-window:app:window', videoTarget: { kind: 'app-window' as const, appBundleId: 'com.example.app', pid: 42, windowId: 'window', title: 'Example', windowBoundsTopLeftPx: { x: 0, y: 0, width: 800, height: 600 }, cropRectTopLeftPx: { x: 0, y: 0, width: 800, height: 600 } }, inputTarget: { kind: 'app-window' as const }, streamMode: 'interactive' as const, focusPolicy: 'bring-to-focus' as const, inputRoute: 'os-event' as const, capture: { source: 'ScreenCaptureKit' as const, coordinateSpace: 'macos-top-left-px' as const, scale: 1, createdAt: new Date().toISOString() } });
const profile = () => makeRemoteWindowVideoProfileFixture('smooth');
const start = (streamId: string): RemoteWindowStreamStartRequestV2Payload => ({ requestId: `${streamId}-request`, streamId, mediaPlan: 'single-focus', mediaPlanVersion: 2, target: target(), videoProfile: profile() });

async function startRuntimeStream(
  runtime: ReturnType<typeof createRemoteWindowStreamDaemonRuntime>,
  payload: RemoteWindowStreamStartRequestV2Payload,
) {
  const started = runtime.startStream(payload, {
    sendOffer: (offer) => {
      void runtime.acceptAnswer!({
        requestId: offer.requestId,
        streamId: offer.streamId,
        mediaPlanVersion: 2,
        answer: { type: 'answer', sdp: 'answer-sdp' },
      });
    },
  });
  await expect(started).resolves.toMatchObject({ streamId: payload.streamId, mediaPlanVersion: 2 });
}

function makePeerConnection() {
  const peerConnection = {
    localDescription: null as RTCSessionDescriptionInit | null,
    connectionState: 'connected' as RTCPeerConnectionState,
    iceConnectionState: 'connected' as RTCIceConnectionState,
    close: vi.fn(() => { peerConnection.connectionState = 'closed'; }),
    addTrack: vi.fn(() => ({
      getParameters: () => ({ encodings: [{ maxBitrate: 1_000_000, maxFramerate: 30 }] }),
      setParameters: vi.fn(async () => undefined),
    })),
    createOffer: vi.fn(async () => ({ type: 'offer' as const, sdp: 'offer-sdp' })),
    setLocalDescription: vi.fn(async (description: RTCSessionDescriptionInit) => {
      peerConnection.localDescription = description;
    }),
    setRemoteDescription: vi.fn(async () => undefined),
    addIceCandidate: vi.fn(async () => undefined),
  };
  return peerConnection;
}

/**
 * Deferred capture harness: the capture factory emits its first frame and then
 * stays pending across a real event-loop turn. This models a legal capture
 * implementation whose factory promise settles after real I/O, which the
 * previous `await Promise.resolve()` test could not exercise.
 */
function makeDeferredCaptureRuntime(input: { frameCapturedAtMs?: number; rejectSource?: boolean } = {}) {
  const peerConnection = makePeerConnection();
  const statuses: RemoteWindowStreamStatusPayload[] = [];
  const frameConsumer = vi.fn();
  let onFrame: ((frame: { width: number; height: number; rgba: Uint8Array; capturedAtMs?: number }) => void) | null = null;
  let releaseFactory: () => void = () => undefined;
  let resolveEmitted: () => void = () => undefined;
  const factoryEmitted = new Promise<void>((resolve) => {
    resolveEmitted = resolve;
  });
  const factoryGate = new Promise<void>((resolve) => {
    releaseFactory = resolve;
  });
  const captureSource = {
    captureEpoch: 0,
    width: 800,
    height: 600,
    frameRate: 30,
    maxCaptureWidth: 1440,
    maxCaptureHeight: 900,
    updateTarget: vi.fn(async (nextTarget: { videoTarget: { cropRectTopLeftPx?: { width: number; height: number } } }) => {
      captureSource.width = nextTarget.videoTarget.cropRectTopLeftPx?.width ?? captureSource.width;
      captureSource.height = nextTarget.videoTarget.cropRectTopLeftPx?.height ?? captureSource.height;
    }),
    updateVideoProfile: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
  const runtime = createRemoteWindowStreamDaemonRuntime({
    platform: 'darwin',
    arch: 'arm64',
    captureBinary: '/tmp/zterm-daemon',
    nowMs: () => 1_000_000,
    peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
    rtcSessionDescriptionFactory: (description) => description as RTCSessionDescription,
    rtcIceCandidateFactory: (candidate) => candidate as RTCIceCandidate,
    videoSourceFactory: () => ({
      createTrack: () => ({ id: 'video-track', stop: vi.fn() }) as unknown as MediaStreamTrack,
      onFrame: frameConsumer,
    }),
    rgbaToI420: vi.fn(),
    captureSourceFactory: vi.fn(async (_target, options) => {
      onFrame = options.onFrame;
      // A legal capture implementation emits its first frame before this
      // factory promise resolves.
      options.onFrame({
        width: 800,
        height: 600,
        rgba: new Uint8Array(800 * 600 * 4),
        capturedAtMs: input.frameCapturedAtMs ?? 1_000_000,
      });
      resolveEmitted();
      // Hold the factory pending across a real event-loop turn so the daemon
      // cannot rely on microtask ordering for capture-source assignment.
      await factoryGate;
      if (input.rejectSource) {
        throw new Error('remote window capture source failed to start');
      }
      return captureSource;
    }),
    runRemoteWindowInputEvent: vi.fn(async (payload) => (
      payload.event.kind === 'window-resize'
        ? { kind: 'window-resize' as const, position: { x: 617, y: 1405 }, size: { width: 384, height: 624 } }
        : undefined
    )),
    runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
  });
  return { runtime, statuses, frameConsumer, captureSource, releaseFactory, factoryEmitted, getOnFrame: () => onFrame };
}

describe('remote window stream daemon v2 contract', () => {
  it('uses the v2 typed start contract', () => {
    expect(start('typed-v2').mediaPlanVersion).toBe(2);
  });

  it('uses addTrack for v2 sender negotiation and applies quality after answer', () => {
    const source = readFileSync(new URL('./remote-window-stream-daemon.ts', import.meta.url), 'utf8');
    expect(source).toContain('const videoSender = peerConnection.addTrack(');
    expect(source).toContain("new MediaStream({ id: videoTrack.id })");
    expect(source).toContain('streamEntry.overviewVideoSender = peerConnection.addTrack(');
    expect(source).not.toContain('peerConnection.addTransceiver(videoTrack');
    expect(source).not.toContain('peerConnection.addTransceiver(streamEntry.overviewVideoTrack');
  });

  it('routes catalog, quality, and touch entries through the phase4 bridge', () => {
    const source = readFileSync(new URL('./remote-window-stream-daemon.ts', import.meta.url), 'utf8');
    expect(source).toContain('runRemoteWindowDagpipeGate');
    expect(source).toContain('listTargets: async (payload) => {');
    expect(source).toContain('const qualityGate = runRemoteWindowDagpipeGate');
    expect(source).toContain('const inputGate = runRemoteWindowDagpipeGate');
    expect(source).toContain('DAGpipe remote window catalog gate rejected');
  });

  it('does not feed captured frames before the ICE-connected streaming milestone', () => {
    const source = readFileSync(new URL('./remote-window-stream-daemon.ts', import.meta.url), 'utf8');
    expect(source).toContain("entry.remoteDescriptionApplied");
    expect(source).toContain("peerConnection.connectionState === 'connected'");
    expect(source).toContain("peerConnection.iceConnectionState === 'completed'");
    expect(source).toContain('answer-accepted');
  });

  it('reports expired capture frames as typed media telemetry', () => {
    const source = readFileSync(new URL('./remote-window-stream-daemon.ts', import.meta.url), 'utf8');
    expect(source).toContain('framesDropped');
    expect(source).toContain("phase: 'streaming'");
    expect(source).toContain('remote window capture frame expired');
  });

  it('holds the retained first frame and streaming until the capture factory settles across a real macrotask', async () => {
    const harness = makeDeferredCaptureRuntime();
    const payload = start('capture-ready-pending');
    const started = harness.runtime.startStream(payload, {
      sendStatus: (status) => {
        harness.statuses.push(status);
      },
      sendOffer: (offer) => {
        void harness.runtime.acceptAnswer!({
          requestId: offer.requestId,
          streamId: offer.streamId,
          mediaPlanVersion: 2,
          answer: { type: 'answer', sdp: 'answer-sdp' },
        });
      },
    });

    // Wait until the capture factory has emitted its first frame and staged the
    // pending media slot, then let a real event-loop turn run while the factory
    // is still pending and the peer answer/ICE state is already connected.
    await harness.factoryEmitted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.getOnFrame()).not.toBeNull();
    expect(harness.frameConsumer).not.toHaveBeenCalled();
    expect(harness.statuses.filter((status) => status.phase === 'streaming')).toHaveLength(0);

    harness.releaseFactory();
    await expect(started).resolves.toMatchObject({ streamId: payload.streamId, mediaPlanVersion: 2 });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The retained first frame dispatches exactly once through the existing
    // pending-frame/status owner, without a second capture callback.
    expect(harness.frameConsumer).toHaveBeenCalledTimes(1);
    expect(harness.statuses.filter((status) => status.phase === 'streaming')).toHaveLength(1);

    // The explicitly assigned capture source now backs a public resize.
    const ack = await harness.runtime.injectInput({
      streamId: payload.streamId,
      targetId: payload.target.streamTargetId,
      deliveryKind: 'action',
      sampledAtMs: 100,
      deadlineMs: 200,
      event: { kind: 'window-resize', width: 1080, height: 1395 },
    }, {
      version: 1,
      sequence: 'rw-resize-capture-ready',
      lane: 'reliable',
      attempt: 1,
      sentAtMs: 100,
    });
    expect(harness.captureSource.updateTarget).toHaveBeenCalled();
    expect(ack).toMatchObject({
      control: { accepted: true },
      payload: { capture: { frameWidth: 384, frameHeight: 624 } },
    });
    await harness.runtime.dispose();
  });

  it('drops the retained first frame and stops a late capture source when the stream stops before the factory settles', async () => {
    const harness = makeDeferredCaptureRuntime();
    const payload = start('capture-ready-stopped');
    const started = harness.runtime.startStream(payload, {
      sendStatus: (status) => {
        harness.statuses.push(status);
      },
      sendOffer: (offer) => {
        void harness.runtime.acceptAnswer!({
          requestId: offer.requestId,
          streamId: offer.streamId,
          mediaPlanVersion: 2,
          answer: { type: 'answer', sdp: 'answer-sdp' },
        });
      },
    });
    await harness.factoryEmitted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.frameConsumer).not.toHaveBeenCalled();

    const stopped = await harness.runtime.stopStream({ requestId: 'stop-before-factory', streamId: payload.streamId });
    expect('cleanup' in stopped ? stopped.cleanup?.status : undefined).toBe('released');

    harness.releaseFactory();
    const startedResult = await started;
    expect(('offer' in startedResult) ? (startedResult as { offer?: unknown }).offer : undefined).toBeUndefined();
    // The late factory completion must not revive the stream; it stops its own
    // source and the retained first frame is never dispatched.
    expect(harness.captureSource.stop).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.frameConsumer).not.toHaveBeenCalled();
    expect(harness.statuses.filter((status) => status.phase === 'streaming')).toHaveLength(0);
    await harness.runtime.dispose();
  });

  it('does not publish streaming for a retained first frame that expires before it can dispatch', async () => {
    const harness = makeDeferredCaptureRuntime({ frameCapturedAtMs: 999_000 });
    const payload = start('capture-ready-expired');
    const started = harness.runtime.startStream(payload, {
      sendStatus: (status) => {
        harness.statuses.push(status);
      },
      sendOffer: (offer) => {
        void harness.runtime.acceptAnswer!({
          requestId: offer.requestId,
          streamId: offer.streamId,
          mediaPlanVersion: 2,
          answer: { type: 'answer', sdp: 'answer-sdp' },
        });
      },
    });
    await harness.factoryEmitted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    harness.releaseFactory();
    await expect(started).resolves.toMatchObject({ streamId: payload.streamId, mediaPlanVersion: 2 });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.frameConsumer).not.toHaveBeenCalled();
    expect(harness.statuses.filter((status) => status.phase === 'streaming')).toHaveLength(0);
    const expired = harness.statuses.find((status) => status.message === 'remote window capture frame expired');
    expect(expired).toBeDefined();
    expect(expired?.framesDropped).toBe(1);
    expect(expired?.framesSent).toBe(0);
    expect(expired?.phase).toBe('starting');
    await harness.runtime.dispose();
  });

  it('rejects start and never streams when the capture factory fails after emitting a pending first frame', async () => {
    const harness = makeDeferredCaptureRuntime({ rejectSource: true });
    const payload = start('capture-ready-source-failed');
    const started = harness.runtime.startStream(payload, {
      sendStatus: (status) => {
        harness.statuses.push(status);
      },
      sendOffer: (offer) => {
        void harness.runtime.acceptAnswer!({
          requestId: offer.requestId,
          streamId: offer.streamId,
          mediaPlanVersion: 2,
          answer: { type: 'answer', sdp: 'answer-sdp' },
        });
      },
    });
    await harness.factoryEmitted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.frameConsumer).not.toHaveBeenCalled();

    harness.releaseFactory();
    const startedResult = await started;
    expect(startedResult).toMatchObject({
      streamId: payload.streamId,
      code: 'remote_window_stream_start_failed',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.frameConsumer).not.toHaveBeenCalled();
    expect(harness.statuses.filter((status) => status.phase === 'streaming')).toHaveLength(0);
    await harness.runtime.dispose();
  });

  it('admits a client-timestamped action across host clock skew and publishes resize geometry atomically', async () => {
    const peerConnection = makePeerConnection();
    const observedResize = {
      kind: 'window-resize' as const,
      position: { x: 617, y: 1405 },
      size: { width: 384, height: 624 },
    };
    const captureSource = {
      captureEpoch: 0,
      width: 800,
      height: 600,
      frameRate: 30,
      maxCaptureWidth: 1440,
      maxCaptureHeight: 900,
      updateTarget: vi.fn(async (nextTarget) => {
        captureSource.width = nextTarget.videoTarget.cropRectTopLeftPx!.width;
        captureSource.height = nextTarget.videoTarget.cropRectTopLeftPx!.height;
      }),
      updateVideoProfile: vi.fn(async () => undefined),
      stop: vi.fn(),
    };
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      arch: 'arm64',
      captureBinary: '/tmp/zterm-daemon',
      nowMs: () => 1_000_000,
      peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
      rtcSessionDescriptionFactory: (description) => description as RTCSessionDescription,
      rtcIceCandidateFactory: (candidate) => candidate as RTCIceCandidate,
      videoSourceFactory: () => ({
        createTrack: () => ({ id: 'video-track', stop: vi.fn() }) as unknown as MediaStreamTrack,
        onFrame: vi.fn(),
      }),
      rgbaToI420: vi.fn(),
      captureSourceFactory: vi.fn(async () => captureSource),
      runRemoteWindowInputEvent: vi.fn(async (payload) => (
        payload.event.kind === 'window-resize' ? observedResize : undefined
      )),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const payload = start('clock-skew-resize');
    await startRuntimeStream(runtime, payload);

    const ack = await runtime.injectInput({
      streamId: payload.streamId,
      targetId: payload.target.streamTargetId,
      deliveryKind: 'action',
      sampledAtMs: 100,
      deadlineMs: 200,
      event: { kind: 'window-resize', width: 1080, height: 1395 },
    }, {
      version: 1,
      sequence: 'rw-resize-1',
      lane: 'reliable',
      attempt: 1,
      sentAtMs: 100,
    });

    expect(ack).toMatchObject({
      control: {
        sequence: 'rw-resize-1',
        accepted: true,
      },
      payload: {
        streamId: payload.streamId,
        targetId: payload.target.streamTargetId,
        target: {
          videoTarget: {
            windowBoundsTopLeftPx: { x: 617, y: 1405, width: 384, height: 624 },
            cropRectTopLeftPx: { x: 617, y: 1405, width: 384, height: 624 },
          },
        },
        capture: {
          frameWidth: 384,
          frameHeight: 624,
        },
      },
    });
    expect(captureSource.updateTarget).toHaveBeenCalledWith(expect.objectContaining({
      videoTarget: expect.objectContaining({
        windowBoundsTopLeftPx: { x: 617, y: 1405, width: 384, height: 624 },
        cropRectTopLeftPx: { x: 617, y: 1405, width: 384, height: 624 },
      }),
    }));
    await runtime.dispose();
  });

  it('fails resize explicitly when native readback is missing and never updates capture or ACKs predicted bounds', async () => {
    const peerConnection = makePeerConnection();
    const captureSource = {
      captureEpoch: 0,
      width: 800,
      height: 600,
      frameRate: 30,
      maxCaptureWidth: 1440,
      maxCaptureHeight: 900,
      updateTarget: vi.fn(async () => undefined),
      updateVideoProfile: vi.fn(async () => undefined),
      stop: vi.fn(),
    };
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      arch: 'arm64',
      captureBinary: '/tmp/zterm-daemon',
      nowMs: () => 1_000_000,
      peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
      rtcSessionDescriptionFactory: (description) => description as RTCSessionDescription,
      rtcIceCandidateFactory: (candidate) => candidate as RTCIceCandidate,
      videoSourceFactory: () => ({
        createTrack: () => ({ id: 'video-track', stop: vi.fn() }) as unknown as MediaStreamTrack,
        onFrame: vi.fn(),
      }),
      rgbaToI420: vi.fn(),
      captureSourceFactory: vi.fn(async () => captureSource),
      runRemoteWindowInputEvent: vi.fn(async () => undefined),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const payload = start('missing-readback');
    await startRuntimeStream(runtime, payload);

    const ack = await runtime.injectInput({
      streamId: payload.streamId,
      targetId: payload.target.streamTargetId,
      deliveryKind: 'action',
      sampledAtMs: 100,
      deadlineMs: 200,
      event: { kind: 'window-resize', width: 1080, height: 1395 },
    }, {
      version: 1,
      sequence: 'rw-resize-missing-readback',
      lane: 'reliable',
      attempt: 1,
      sentAtMs: 100,
    });

    expect(ack).toMatchObject({
      control: {
        accepted: false,
        error: { code: 'remote_window_input_failed' },
      },
      payload: {
        streamId: payload.streamId,
        targetId: payload.target.streamTargetId,
      },
    });
    expect(ack?.payload.target).toBeUndefined();
    expect(ack?.payload.capture).toBeUndefined();
    expect(captureSource.updateTarget).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('validates resize against display bounds before native input injection', async () => {
    const runRemoteWindowInputEvent = vi.fn(async (payload) => (
      payload.event.kind === 'window-resize'
        ? {
            kind: 'window-resize' as const,
            position: { x: 0, y: 0 },
            size: { width: payload.event.width, height: payload.event.height },
          }
        : undefined
    ));
    const peerConnection = makePeerConnection();
    const captureSource = {
      captureEpoch: 0,
      width: 800,
      height: 600,
      frameRate: 30,
      maxCaptureWidth: 1440,
      maxCaptureHeight: 900,
      updateTarget: vi.fn(async () => undefined),
      updateVideoProfile: vi.fn(async () => undefined),
      stop: vi.fn(),
    };
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      arch: 'arm64',
      captureBinary: '/tmp/zterm-daemon',
      nowMs: () => 1_000_000,
      peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
      rtcSessionDescriptionFactory: (description) => description as RTCSessionDescription,
      rtcIceCandidateFactory: (candidate) => candidate as RTCIceCandidate,
      videoSourceFactory: () => ({
        createTrack: () => ({ id: 'video-track', stop: vi.fn() }) as unknown as MediaStreamTrack,
        onFrame: vi.fn(),
      }),
      rgbaToI420: vi.fn(),
      captureSourceFactory: vi.fn(async () => captureSource),
      runRemoteWindowInputEvent,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const payload = start('resize-bounds');
    payload.target.capture.displayBoundsTopLeftPx = { x: 0, y: 0, width: 900, height: 700 };
    await startRuntimeStream(runtime, payload);

    const rejected = await runtime.injectInput({
      streamId: payload.streamId,
      targetId: payload.target.streamTargetId,
      deliveryKind: 'action',
      sampledAtMs: 100,
      deadlineMs: 200,
      event: { kind: 'window-resize', width: 1200, height: 800 },
    }, {
      version: 1,
      sequence: 'rw-resize-out-of-display',
      lane: 'reliable',
      attempt: 1,
      sentAtMs: 100,
    });
    expect(rejected).not.toBeNull();
    if (!rejected) throw new Error('expected resize rejection ack');
    expect(rejected.control).toMatchObject({ accepted: false, retryable: false });
    expect(runRemoteWindowInputEvent).not.toHaveBeenCalled();

    const accepted = await runtime.injectInput({
      streamId: payload.streamId,
      targetId: payload.target.streamTargetId,
      deliveryKind: 'action',
      sampledAtMs: 100,
      deadlineMs: 200,
      event: { kind: 'window-resize', width: 800, height: 600 },
    }, {
      version: 1,
      sequence: 'rw-resize-in-display',
      lane: 'reliable',
      attempt: 1,
      sentAtMs: 100,
    });
    expect(accepted).not.toBeNull();
    if (!accepted) throw new Error('expected resize acceptance ack');
    expect(accepted.control).toMatchObject({ accepted: true });
    expect(runRemoteWindowInputEvent).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it('shares one pending stop operation across concurrent stop callers', async () => {
    const peerConnection = makePeerConnection();
    const captureSource = {
      captureEpoch: 0,
      width: 800,
      height: 600,
      frameRate: 30,
      maxCaptureWidth: 1440,
      maxCaptureHeight: 900,
      updateTarget: vi.fn(async () => undefined),
      updateVideoProfile: vi.fn(async () => undefined),
      stop: vi.fn(),
    };
    const releaseStream = vi.fn(async (streamId: string) => ({
      streamId,
      status: 'released' as const,
      released: [],
      sharedReleased: [],
      remaining: [],
      errors: [],
    }));
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      arch: 'arm64',
      captureBinary: '/tmp/zterm-daemon',
      nowMs: () => 1_000_000,
      peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
      rtcSessionDescriptionFactory: (description) => description as RTCSessionDescription,
      rtcIceCandidateFactory: (candidate) => candidate as RTCIceCandidate,
      videoSourceFactory: () => ({
        createTrack: () => ({ id: 'video-track', stop: vi.fn() }) as unknown as MediaStreamTrack,
        onFrame: vi.fn(),
      }),
      rgbaToI420: vi.fn(),
      captureSourceFactory: vi.fn(async () => captureSource),
      remoteWindowInputHelperFactory: () => ({
        warm: vi.fn(async () => undefined),
        send: vi.fn(async () => undefined),
        releaseStream,
        dispose: vi.fn(async () => undefined),
        hasLease: () => false,
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const payload = start('concurrent-stop');
    await startRuntimeStream(runtime, payload);
    const first = runtime.stopStream({ requestId: 'stop-a', streamId: payload.streamId });
    const second = runtime.stopStream({ requestId: 'stop-b', streamId: payload.streamId });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    // Cleanup is shared, but each protocol caller must settle on its own
    // requestId: the client matches a stop result only by the id it sent.
    expect(releaseStream).toHaveBeenCalledTimes(1);
    expect(firstResult).not.toBe(secondResult);
    expect(firstResult.requestId).toBe('stop-a');
    expect(secondResult.requestId).toBe('stop-b');
    expect(firstResult.streamId).toBe(payload.streamId);
    expect(secondResult.streamId).toBe(payload.streamId);
    if ('code' in firstResult || 'code' in secondResult) {
      throw new Error(
        `concurrent stop must settle with a status, got ${JSON.stringify({ firstResult, secondResult })}`,
      );
    }
    expect(firstResult.phase).toBe('stopped');
    expect(secondResult.phase).toBe('stopped');
    expect(firstResult.cleanup).toEqual(secondResult.cleanup);
    await runtime.dispose();
  });

  it('retries only the failed resources on a repeated stop and does not recreate released ones', async () => {
    const peerConnection = makePeerConnection();
    const captureStop = vi.fn();
    const captureSource = {
      captureEpoch: 0,
      width: 800,
      height: 600,
      frameRate: 30,
      maxCaptureWidth: 1440,
      maxCaptureHeight: 900,
      updateTarget: vi.fn(async () => undefined),
      updateVideoProfile: vi.fn(async () => undefined),
      stop: captureStop,
    };
    let helperReleaseAttempts = 0;
    const releaseStream = vi.fn(async (streamId: string) => {
      helperReleaseAttempts += 1;
      if (helperReleaseAttempts === 1) {
        return {
          streamId,
          status: 'failed' as const,
          released: [],
          sharedReleased: [],
          remaining: [`key:0:${streamId}`],
          errors: ['native release not confirmed'],
        };
      }
      return { streamId, status: 'released' as const, released: [], sharedReleased: [], remaining: [], errors: [] };
    });
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      arch: 'arm64',
      captureBinary: '/tmp/zterm-daemon',
      nowMs: () => 1_000_000,
      peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
      rtcSessionDescriptionFactory: (description) => description as RTCSessionDescription,
      rtcIceCandidateFactory: (candidate) => candidate as RTCIceCandidate,
      videoSourceFactory: () => ({
        createTrack: () => ({ id: 'video-track', stop: vi.fn() }) as unknown as MediaStreamTrack,
        onFrame: vi.fn(),
      }),
      rgbaToI420: vi.fn(),
      captureSourceFactory: vi.fn(async () => captureSource),
      remoteWindowInputHelperFactory: () => ({
        warm: vi.fn(async () => undefined),
        send: vi.fn(async () => undefined),
        releaseStream,
        dispose: vi.fn(async () => undefined),
        hasLease: () => true,
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const payload = start('stop-retry');
    await startRuntimeStream(runtime, payload);
    const first = await runtime.stopStream({ requestId: 'stop-1', streamId: payload.streamId });
    expect('cleanup' in first ? first.cleanup?.status : undefined).toBe('failed');
    expect('cleanup' in first ? first.cleanup?.remainingResources : undefined).toEqual([`key:0:${payload.streamId}`]);
    // The failed stop kept admission closed and video ceased: capture stops once.
    expect(captureStop).toHaveBeenCalledTimes(1);

    const second = await runtime.stopStream({ requestId: 'stop-2', streamId: payload.streamId });
    expect('cleanup' in second ? second.cleanup?.status : undefined).toBe('released');
    expect(releaseStream).toHaveBeenCalledTimes(2);
    // The successfully released focus resources are not recreated or re-stopped.
    expect(captureStop).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it('cancels the pending answer at stop and rejects a late answer as cancelled without resuming the stopped start', async () => {
    const peerConnection = makePeerConnection();
    const captureSource = {
      captureEpoch: 0,
      width: 800,
      height: 600,
      frameRate: 30,
      maxCaptureWidth: 1440,
      maxCaptureHeight: 900,
      updateTarget: vi.fn(async () => undefined),
      updateVideoProfile: vi.fn(async () => undefined),
      stop: vi.fn(),
    };
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      arch: 'arm64',
      captureBinary: '/tmp/zterm-daemon',
      nowMs: () => 1_000_000,
      peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
      rtcSessionDescriptionFactory: (description) => description as RTCSessionDescription,
      rtcIceCandidateFactory: (candidate) => candidate as RTCIceCandidate,
      videoSourceFactory: () => ({
        createTrack: () => ({ id: 'video-track', stop: vi.fn() }) as unknown as MediaStreamTrack,
        onFrame: vi.fn(),
      }),
      rgbaToI420: vi.fn(),
      captureSourceFactory: vi.fn(async () => captureSource),
      runRemoteWindowInputEvent: vi.fn(async () => undefined),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const payload = start('pending-answer');
    let stopPromise: Promise<unknown> | null = null;
    const started = runtime.startStream(payload, {
      // The offer callback fires after waitForRemoteWindowAnswer has registered
      // the pending entry, so stopping here deterministically cancels it while
      // the negotiation is still pending.
      sendOffer: () => {
        stopPromise = runtime.stopStream({ requestId: 'stop-pending', streamId: payload.streamId });
      },
    });
    for (let turn = 0; turn < 12; turn += 1) {
      await Promise.resolve();
    }
    expect(stopPromise).not.toBeNull();
    const stopReason = (await stopPromise) as unknown as { cleanup?: { status?: string } };
    expect(stopReason.cleanup?.status).toBe('released');
    // The pending start resolves as an error, never as a stopped-but-live offer.
    const startedResult = await started;
    expect(startedResult).toEqual(expect.objectContaining({ requestId: payload.requestId }));
    expect(('offer' in startedResult) ? (startedResult as { offer?: unknown }).offer : undefined).toBeUndefined();
    // A late answer for the stopped stream returns the explicit cancellation
    // code and never resolves the stopped start.
    await expect(runtime.acceptAnswer!({
      requestId: payload.requestId,
      streamId: payload.streamId,
      mediaPlanVersion: 2,
      answer: { type: 'answer', sdp: 'late-answer-sdp' },
    })).rejects.toMatchObject({ name: 'remote_window_stream_answer_cancelled' });
    await runtime.dispose();
  });
});
