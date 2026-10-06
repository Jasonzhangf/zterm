import { describe, expect, it, vi } from 'vitest';
import { releaseRemoteWindowStreamSessionResources } from './remote-window-stream-session';

function makeCaptureSource(stop: () => void = vi.fn()) {
  return { captureEpoch: 0, width: 2, height: 2, frameRate: 12, stop };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  const session = {
    requestId: 'request-1',
    streamId: 'stream-1',
    purpose: 'focus' as const,
    framesSent: 7,
    captureSource: makeCaptureSource(),
    overviewCaptureSource: makeCaptureSource(),
    videoTrack: { stop: vi.fn() } as unknown as MediaStreamTrack,
    overviewVideoTrack: { stop: vi.fn() } as unknown as MediaStreamTrack,
    peerConnection: {
      onicecandidate: vi.fn(),
      onconnectionstatechange: vi.fn(),
      close: vi.fn(),
    } as unknown as RTCPeerConnection,
    ...overrides,
  };
  return session;
}

describe('remote window stream session resource owner', () => {
  it('releases every focus/overview resource and clears each field only on success', () => {
    const session = makeSession();
    const captureStop = session.captureSource.stop;
    const overviewCaptureStop = session.overviewCaptureSource.stop;
    const videoTrackStop = session.videoTrack.stop;
    const overviewTrackStop = session.overviewVideoTrack!.stop;
    const peerClose = session.peerConnection.close;

    const result = releaseRemoteWindowStreamSessionResources(session);

    expect(captureStop).toHaveBeenCalledTimes(1);
    expect(overviewCaptureStop).toHaveBeenCalledTimes(1);
    expect(videoTrackStop).toHaveBeenCalledTimes(1);
    expect(overviewTrackStop).toHaveBeenCalledTimes(1);
    expect(peerClose).toHaveBeenCalledTimes(1);
    expect(session.captureSource).toBeNull();
    expect(session.overviewCaptureSource).toBeNull();
    expect(session.videoTrack).toBeNull();
    expect(session.overviewVideoTrack).toBeNull();
    expect(session.peerConnection).toBeNull();
    expect(result.remainingResources).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.hadResources).toBe(true);
  });

  it('preserves failed resource references for retry and only retries those', () => {
    const captureStop = vi.fn(() => { throw new Error('capture busy'); });
    const trackStop = vi.fn(() => { throw new Error('track busy'); });
    const captureSource = makeCaptureSource(captureStop);
    const videoTrack = { stop: trackStop } as unknown as MediaStreamTrack;
    const session = makeSession({ captureSource, videoTrack });
    const overviewCaptureStop = session.overviewCaptureSource.stop;
    const peerClose = session.peerConnection.close;

    const result = releaseRemoteWindowStreamSessionResources(session);

    expect(result.remainingResources).toEqual(['focus-capture', 'focus-track']);
    expect(result.errors).toEqual([
      { resource: 'focus-capture', message: 'capture busy' },
      { resource: 'focus-track', message: 'track busy' },
    ]);
    expect(session.captureSource).toBe(captureSource);
    expect(session.videoTrack).toBe(videoTrack);
    expect(overviewCaptureStop).toHaveBeenCalledTimes(1);
    expect(peerClose).toHaveBeenCalledTimes(1);
    expect(session.overviewCaptureSource).toBeNull();
    expect(session.peerConnection).toBeNull();

    // A retry must not release resources that already succeeded.
    const retry = releaseRemoteWindowStreamSessionResources(session);
    expect(overviewCaptureStop).toHaveBeenCalledTimes(1);
    expect(peerClose).toHaveBeenCalledTimes(1);
    expect(retry.remainingResources).toEqual(['focus-capture', 'focus-track']);
  });

  it('reports no owned resources when every field is already released', () => {
    const session = makeSession({
      captureSource: null,
      overviewCaptureSource: null,
      videoTrack: null,
      overviewVideoTrack: null,
      peerConnection: null,
    });
    const result = releaseRemoteWindowStreamSessionResources(session);
    expect(result).toEqual({ remainingResources: [], errors: [], hadResources: false });
  });
});
