// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRemoteWindowPlayback } from './useRemoteWindowPlayback';

afterEach(cleanup);

function stream(id: string, trackId = `${id}-track`): MediaStream {
  const track = { id: trackId, kind: 'video', readyState: 'live', muted: false };
  return {
    id,
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
}

describe('useRemoteWindowPlayback owner', () => {
  it('reveals after play resolves when requestVideoFrameCallback is unavailable', async () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'requestVideoFrameCallback', {
      configurable: true,
      value: undefined,
    });
    video.play = vi.fn(() => Promise.resolve());
    const receiver = stream('no-rvfc');
    const videoElementRef = { current: video };
    const overviewVideoElementRef = { current: null };
    const { result } = renderHook(() => useRemoteWindowPlayback({
      receiverMediaStream: receiver,
      overviewMediaStream: null,
      streamStatus: 'streaming',
      streamId: receiver.id,
      videoElementRef,
      overviewVideoElementRef,
    }));

    await waitFor(() => expect(result.current.videoHasPlayed).toBe(true));
  });

  it('reports track attach, decoded first frame, and playing as separate telemetry facts', async () => {
    const video = document.createElement('video') as HTMLVideoElement & {
      requestVideoFrameCallback: (callback: () => void) => number;
    };
    const frameCallbacks: Array<() => void> = [];
    video.requestVideoFrameCallback = vi.fn((callback: () => void) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    video.cancelVideoFrameCallback = vi.fn();
    let resolvePlay!: () => void;
    video.play = vi.fn(() => new Promise<void>((resolve) => {
      resolvePlay = resolve;
    }));
    const onVideoDebug = vi.fn();
    const receiver = stream('telemetry');
    const videoElementRef = { current: video };
    const overviewVideoElementRef = { current: null };
    renderHook(() => useRemoteWindowPlayback({
      receiverMediaStream: receiver,
      overviewMediaStream: null,
      streamStatus: 'streaming',
      streamId: receiver.id,
      videoElementRef,
      overviewVideoElementRef,
      onVideoDebug,
    }));

    await waitFor(() => expect(onVideoDebug).toHaveBeenCalled());
    expect(onVideoDebug.mock.calls[onVideoDebug.mock.calls.length - 1]?.[0]).toMatchObject({
      trackAttachedAt: expect.any(Number),
      decodedFirstFrameAt: null,
      playingAt: null,
    });
    act(() => resolvePlay());
    await waitFor(() => expect(onVideoDebug.mock.calls[onVideoDebug.mock.calls.length - 1]?.[0].playingAt).toEqual(expect.any(Number)));
    act(() => frameCallbacks[0]?.());
    await waitFor(() => expect(onVideoDebug.mock.calls[onVideoDebug.mock.calls.length - 1]?.[0].decodedFirstFrameAt).toEqual(expect.any(Number)));
  });

  it('rejects a late frame reveal from the previous receiver epoch', async () => {
    const video = document.createElement('video') as HTMLVideoElement & {
      requestVideoFrameCallback: (callback: () => void) => number;
    };
    const frameCallbacks: Array<() => void> = [];
    video.requestVideoFrameCallback = vi.fn((callback: () => void) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    video.cancelVideoFrameCallback = vi.fn();
    video.play = vi.fn(() => new Promise<void>(() => {}));
    const first = stream('first');
    const second = stream('second');
    const videoElementRef = { current: video };
    const overviewVideoElementRef = { current: null };
    const { result, rerender } = renderHook(
      ({ receiverMediaStream }) => useRemoteWindowPlayback({
        receiverMediaStream,
        overviewMediaStream: null,
        streamStatus: 'streaming',
        streamId: receiverMediaStream.id,
        videoElementRef,
        overviewVideoElementRef,
      }),
      { initialProps: { receiverMediaStream: first } },
    );

    await waitFor(() => expect(frameCallbacks.length).toBeGreaterThan(0));
    const staleReveal = frameCallbacks[1];
    rerender({ receiverMediaStream: second });
    await waitFor(() => expect(video.srcObject).toBe(second));
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    const currentReveal = frameCallbacks[frameCallbacks.length - 1];
    act(() => staleReveal());
    expect(result.current.videoHasPlayed).toBe(false);
    act(() => currentReveal());
    expect(result.current.videoHasPlayed).toBe(true);
  });

  it('binds decoded geometry to the immutable stream track and rejects stale callbacks', async () => {
    const video = document.createElement('video') as HTMLVideoElement & {
      requestVideoFrameCallback: (callback: () => void) => number;
    };
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
    });
    const frameCallbacks: Array<() => void> = [];
    video.requestVideoFrameCallback = vi.fn((callback: () => void) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    video.cancelVideoFrameCallback = vi.fn();
    video.play = vi.fn(() => new Promise<void>(() => {}));
    const onDecodedFrameSize = vi.fn();
    const first = stream('first', 'first-track');
    const second = stream('second', 'second-track');
    const videoElementRef = { current: video };
    const overviewVideoElementRef = { current: null };
    const { result, rerender } = renderHook(
      ({ receiverMediaStream }) => useRemoteWindowPlayback({
        receiverMediaStream,
        overviewMediaStream: null,
        streamStatus: 'streaming',
        streamId: receiverMediaStream.id,
        videoElementRef,
        overviewVideoElementRef,
        onDecodedFrameSize,
      }),
      { initialProps: { receiverMediaStream: first } },
    );

    await waitFor(() => expect(frameCallbacks.length).toBeGreaterThan(0));
    const staleFrame = frameCallbacks[0];
    rerender({ receiverMediaStream: second });
    await waitFor(() => expect(video.srcObject).toBe(second));
    const currentFrame = frameCallbacks[frameCallbacks.length - 2];
    const currentReveal = frameCallbacks[frameCallbacks.length - 1];

    act(() => staleFrame());
    expect(onDecodedFrameSize).not.toHaveBeenCalled();
    expect(result.current.videoHasPlayed).toBe(false);

    act(() => currentFrame());
    act(() => currentReveal());
    expect(onDecodedFrameSize).toHaveBeenCalledWith({ width: 1280, height: 720 });
    expect(result.current.videoHasPlayed).toBe(true);
  });

  it('keeps visibility false when playback is explicitly invalidated', () => {
    const videoElementRef = { current: null };
    const overviewVideoElementRef = { current: null };
    const { result } = renderHook(() => useRemoteWindowPlayback({
      receiverMediaStream: null,
      overviewMediaStream: null,
      streamStatus: null,
      streamId: null,
      videoElementRef,
      overviewVideoElementRef,
    }));
    act(() => {
      result.current.updateVisibility(true);
      result.current.invalidatePlayback();
      result.current.updateVisibility(false);
    });
    expect(result.current.videoHasPlayed).toBe(false);
  });
});
