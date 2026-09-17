import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteWindowStreamStartRequestV2Payload } from '@zterm/shared/protocol';
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

  it('does not feed captured frames before the ICE-connected streaming milestone', () => {
    const source = readFileSync(new URL('./remote-window-stream-daemon.ts', import.meta.url), 'utf8');
    expect(source).toContain("entry.remoteDescriptionApplied");
    expect(source).toContain("entry.peerConnection.connectionState === 'connected'");
    expect(source).toContain("entry.peerConnection.iceConnectionState === 'completed'");
    expect(source).toContain('answer-accepted');
  });

  it('admits a client-timestamped action across host clock skew and publishes resize geometry atomically', async () => {
    const peerConnection = makePeerConnection();
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
        createTrack: () => ({ id: 'video-track' }) as MediaStreamTrack,
        onFrame: vi.fn(),
      }),
      rgbaToI420: vi.fn(),
      captureSourceFactory: vi.fn(async () => captureSource),
      runRemoteWindowInputEvent: vi.fn(async () => undefined),
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
            windowBoundsTopLeftPx: { x: 0, y: 0, width: 1080, height: 1395 },
            cropRectTopLeftPx: { x: 0, y: 0, width: 1080, height: 1395 },
          },
        },
        capture: {
          frameWidth: 1080,
          frameHeight: 1395,
        },
      },
    });
    runtime.dispose();
  });

  it('validates resize against display bounds before native input injection', async () => {
    const runRemoteWindowInputEvent = vi.fn(async () => undefined);
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
        createTrack: () => ({ id: 'video-track' }) as MediaStreamTrack,
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
    runtime.dispose();
  });
});
