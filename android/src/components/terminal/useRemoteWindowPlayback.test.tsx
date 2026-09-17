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
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
    });
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
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
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
    const staleFrame = frameCallbacks[0];
    rerender({ receiverMediaStream: second });
    await waitFor(() => expect(video.srcObject).toBe(second));
    const currentFrame = frameCallbacks[frameCallbacks.length - 1];
    act(() => staleFrame());
    expect(result.current.videoHasPlayed).toBe(false);
    act(() => currentFrame());
    expect(result.current.videoHasPlayed).toBe(true);
  });

  it('binds decoded geometry to the immutable stream track and rejects stale callbacks', async () => {
    const video = document.createElement('video') as HTMLVideoElement & {
      requestVideoFrameCallback: (callback: () => void) => number;
    };
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
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
    const currentFrame = frameCallbacks[frameCallbacks.length - 1];

    act(() => staleFrame());
    expect(onDecodedFrameSize).not.toHaveBeenCalled();
    expect(result.current.videoHasPlayed).toBe(false);

    act(() => currentFrame());
    expect(onDecodedFrameSize).toHaveBeenCalledWith({ width: 1280, height: 720 });
    expect(result.current.videoHasPlayed).toBe(true);
  });

  it('publishes decoded frames only after current playback and dimensions are valid', async () => {
    const video = document.createElement('video') as HTMLVideoElement & {
      requestVideoFrameCallback: (callback: (now: number, metadata: unknown) => void) => number;
    };
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
    });
    const frameCallbacks: Array<(now: number, metadata: unknown) => void> = [];
    video.requestVideoFrameCallback = vi.fn((callback: (now: number, metadata: unknown) => void) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    video.cancelVideoFrameCallback = vi.fn();
    video.play = vi.fn(() => new Promise<void>(() => {}));
    const receiver = stream('decoded-subscription');
    video.srcObject = receiver;
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

    let decodedFrame: { video: HTMLVideoElement; lane: 'focus' | 'overview'; presentedFrames?: number } | null = null;
    act(() => {
      result.current.subscribeDecodedFrame((frame) => {
        decodedFrame = frame;
      });
    });
    await waitFor(() => expect(frameCallbacks.length).toBeGreaterThan(0));

    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
    act(() => frameCallbacks[0]?.(0, { presentedFrames: 1 }));
    expect(decodedFrame).toBeNull();
    await waitFor(() => expect(frameCallbacks.length).toBeGreaterThan(1));

    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
    act(() => frameCallbacks[1]?.(1, { presentedFrames: 2 }));
    expect(decodedFrame).toEqual({ video, lane: 'focus', presentedFrames: 2 });
  });

  it('owns both focus and overview RVFC lanes and publishes lane-tagged decoded frames', async () => {
    const focusVideo = document.createElement('video');
    const overviewVideo = document.createElement('video');
    Object.defineProperties(focusVideo, {
      readyState: { configurable: true, value: 2 },
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
    });
    Object.defineProperties(overviewVideo, {
      readyState: { configurable: true, value: 2 },
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    const focusCallbacks: Array<(now: number, metadata: unknown) => void> = [];
    const overviewCallbacks: Array<(now: number, metadata: unknown) => void> = [];
    const focusRequest = vi.fn((callback: (now: number, metadata: unknown) => void) => {
      focusCallbacks.push(callback);
      return focusCallbacks.length;
    });
    const overviewRequest = vi.fn((callback: (now: number, metadata: unknown) => void) => {
      overviewCallbacks.push(callback);
      return overviewCallbacks.length;
    });
    focusVideo.requestVideoFrameCallback = focusRequest;
    focusVideo.cancelVideoFrameCallback = vi.fn();
    overviewVideo.requestVideoFrameCallback = overviewRequest;
    overviewVideo.cancelVideoFrameCallback = vi.fn();
    focusVideo.play = vi.fn(() => new Promise<void>(() => {}));
    overviewVideo.play = vi.fn(() => new Promise<void>(() => {}));
    const receiver = stream('focus-lane', 'focus-track');
    const overview = stream('overview-lane', 'overview-track');
    const videoElementRef = { current: focusVideo };
    const overviewVideoElementRef = { current: overviewVideo };
    const { result } = renderHook(() => useRemoteWindowPlayback({
      receiverMediaStream: receiver,
      overviewMediaStream: overview,
      streamStatus: 'streaming',
      streamId: receiver.id,
      videoElementRef,
      overviewVideoElementRef,
    }));

    const frames: Array<{ video: HTMLVideoElement; lane: 'focus' | 'overview'; presentedFrames?: number }> = [];
    act(() => {
      result.current.subscribeDecodedFrame((frame) => frames.push(frame));
    });
    await waitFor(() => {
      expect(focusCallbacks.length).toBeGreaterThan(0);
      expect(overviewCallbacks.length).toBeGreaterThan(0);
    });
    expect(focusRequest).toHaveBeenCalledTimes(1);
    expect(overviewRequest).toHaveBeenCalledTimes(1);

    act(() => {
      focusCallbacks[0]?.(0, { presentedFrames: 10 });
      overviewCallbacks[0]?.(0, { presentedFrames: 20 });
    });
    expect(frames).toEqual([
      { video: focusVideo, lane: 'focus', presentedFrames: 10 },
      { video: overviewVideo, lane: 'overview', presentedFrames: 20 },
    ]);
  });

  it('rearms the retained overview lane after playback invalidation', async () => {
    const focusVideo = document.createElement('video');
    const overviewVideo = document.createElement('video');
    Object.defineProperties(focusVideo, {
      readyState: { configurable: true, value: 2 },
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
    });
    Object.defineProperties(overviewVideo, {
      readyState: { configurable: true, value: 2 },
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    let nextCallbackId = 0;
    const focusRequest = vi.fn(() => ++nextCallbackId);
    const overviewRequest = vi.fn(() => ++nextCallbackId);
    focusVideo.requestVideoFrameCallback = focusRequest;
    focusVideo.cancelVideoFrameCallback = vi.fn();
    overviewVideo.requestVideoFrameCallback = overviewRequest;
    overviewVideo.cancelVideoFrameCallback = vi.fn();
    focusVideo.play = vi.fn(() => new Promise<void>(() => {}));
    overviewVideo.play = vi.fn(() => new Promise<void>(() => {}));
    const receiver = stream('retained-focus', 'retained-focus-track');
    const overview = stream('retained-overview', 'retained-overview-track');
    const videoElementRef = { current: focusVideo };
    const overviewVideoElementRef = { current: overviewVideo };
    const { result } = renderHook(() => useRemoteWindowPlayback({
      receiverMediaStream: receiver,
      overviewMediaStream: overview,
      streamStatus: 'streaming',
      streamId: receiver.id,
      videoElementRef,
      overviewVideoElementRef,
    }));

    await waitFor(() => {
      expect(focusRequest).toHaveBeenCalledTimes(1);
      expect(overviewRequest).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.invalidatePlayback();
      result.current.restoreRetainedPlayback(false);
    });

    await waitFor(() => {
      expect(focusRequest).toHaveBeenCalledTimes(2);
      expect(overviewRequest).toHaveBeenCalledTimes(2);
    });
  });

  it('reports unavailable RVFC for the required overview projection lane', async () => {
    const focusVideo = document.createElement('video');
    const overviewVideo = document.createElement('video');
    const focusCallbacks: Array<(now: number, metadata: unknown) => void> = [];
    Object.defineProperties(focusVideo, {
      requestVideoFrameCallback: {
        configurable: true,
        value: vi.fn((callback: (now: number, metadata: unknown) => void) => {
          focusCallbacks.push(callback);
          return focusCallbacks.length;
        }),
      },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
      play: { configurable: true, value: vi.fn(() => new Promise<void>(() => {})) },
    });
    Object.defineProperties(overviewVideo, {
      requestVideoFrameCallback: { configurable: true, value: undefined },
      cancelVideoFrameCallback: { configurable: true, value: undefined },
      play: { configurable: true, value: vi.fn(() => new Promise<void>(() => {})) },
    });
    const onProjectionError = vi.fn();
    const receiver = stream('rvfc-focus', 'rvfc-focus-track');
    const overview = stream('rvfc-overview', 'rvfc-overview-track');
    const videoElementRef = { current: focusVideo };
    const overviewVideoElementRef = { current: overviewVideo };
    renderHook(() => useRemoteWindowPlayback({
      receiverMediaStream: receiver,
      overviewMediaStream: overview,
      streamStatus: 'streaming',
      streamId: receiver.id,
      videoElementRef,
      overviewVideoElementRef,
      onProjectionError,
    }));

    await waitFor(() => expect(onProjectionError).toHaveBeenCalledWith(
      'remote window decoded-frame callback is unavailable',
    ));
    expect(overviewVideo.play).not.toHaveBeenCalled();
  });

  it('reports overview autoplay rejection through the projection error path', async () => {
    const focusVideo = document.createElement('video');
    const overviewVideo = document.createElement('video');
    const focusCallbacks: Array<(now: number, metadata: unknown) => void> = [];
    Object.defineProperties(focusVideo, {
      requestVideoFrameCallback: {
        configurable: true,
        value: vi.fn((callback: (now: number, metadata: unknown) => void) => {
          focusCallbacks.push(callback);
          return focusCallbacks.length;
        }),
      },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
      play: { configurable: true, value: vi.fn(() => new Promise<void>(() => {})) },
    });
    Object.defineProperties(overviewVideo, {
      requestVideoFrameCallback: {
        configurable: true,
        value: vi.fn(() => 1),
      },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
      play: {
        configurable: true,
        value: vi.fn(() => Promise.reject(new Error('overview autoplay blocked'))),
      },
    });
    const onProjectionError = vi.fn();
    const receiver = stream('overview-reject-focus', 'overview-reject-focus-track');
    const overview = stream('overview-reject', 'overview-reject-track');
    const videoElementRef = { current: focusVideo };
    const overviewVideoElementRef = { current: overviewVideo };
    renderHook(() => useRemoteWindowPlayback({
      receiverMediaStream: receiver,
      overviewMediaStream: overview,
      streamStatus: 'streaming',
      streamId: receiver.id,
      videoElementRef,
      overviewVideoElementRef,
      onProjectionError,
    }));

    await waitFor(() => expect(onProjectionError).toHaveBeenCalledWith(
      'remote window overview playback was rejected: overview autoplay blocked',
    ));
  });

  it('reports unavailable RVFC for a required focus projection lane', async () => {
    const video = document.createElement('video');
    Object.defineProperties(video, {
      requestVideoFrameCallback: { configurable: true, value: undefined },
      cancelVideoFrameCallback: { configurable: true, value: undefined },
      play: { configurable: true, value: vi.fn(() => new Promise<void>(() => {})) },
    });
    const onProjectionError = vi.fn();
    const receiver = stream('rvfc-required-focus', 'rvfc-required-focus-track');
    const videoElementRef = { current: video };
    const overviewVideoElementRef = { current: null };
    renderHook(() => useRemoteWindowPlayback({
      receiverMediaStream: receiver,
      overviewMediaStream: null,
      receiverPlaybackBinding: {
        streamId: 'rvfc-required-focus-stream',
        mediaPlanVersion: 1,
        lane: 'focus',
        mediaEpoch: 0,
        mediaStream: receiver,
        trackId: 'rvfc-required-focus-track',
      },
      streamStatus: 'streaming',
      streamId: receiver.id,
      videoElementRef,
      overviewVideoElementRef,
      onProjectionError,
    }));

    await waitFor(() => expect(onProjectionError).toHaveBeenCalledWith(
      'remote window decoded-frame callback is unavailable',
    ));
    expect(video.play).not.toHaveBeenCalled();
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
