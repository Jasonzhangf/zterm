import { describe, expect, it, vi } from 'vitest';
import { releaseRemoteWindowStreamSessionResources } from './remote-window-stream-session';

function makeCaptureSource(stop: () => void = vi.fn()) {
  return { captureEpoch: 0, width: 2, height: 2, frameRate: 12, stop };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
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
    sendStatus: vi.fn(),
    ...overrides,
  };
}

describe('remote window stream session resource owner', () => {
  it('releases every focus/overview resource and publishes one stopped status', () => {
    const session = makeSession();
    const result = releaseRemoteWindowStreamSessionResources(session, 'closed');

    expect(session.captureSource.stop).toHaveBeenCalledTimes(1);
    expect(session.overviewCaptureSource.stop).toHaveBeenCalledTimes(1);
    expect(session.videoTrack.stop).toHaveBeenCalledTimes(1);
    expect(session.overviewVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(session.peerConnection.close).toHaveBeenCalledTimes(1);
    expect(session.sendStatus).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'stopped',
      framesSent: 7,
      message: 'closed',
    }));
    expect(result.cleanupErrors).toEqual([]);
  });

  it('continues exact cleanup and exposes every release failure in stopped status', () => {
    const session = makeSession({
      captureSource: makeCaptureSource(vi.fn(() => { throw new Error('capture busy'); })),
      videoTrack: { stop: vi.fn(() => { throw new Error('track busy'); }) } as unknown as MediaStreamTrack,
    });
    const result = releaseRemoteWindowStreamSessionResources(session, 'closed');

    expect(session.overviewCaptureSource.stop).toHaveBeenCalledTimes(1);
    expect(session.overviewVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(session.peerConnection.close).toHaveBeenCalledTimes(1);
    expect(result.cleanupErrors).toEqual([
      'focus capture stop: capture busy',
      'focus track stop: track busy',
    ]);
    expect(session.sendStatus).toHaveBeenCalledWith(expect.objectContaining({
      message: 'closed; cleanup failed: focus capture stop: capture busy; focus track stop: track busy',
    }));
  });
});
