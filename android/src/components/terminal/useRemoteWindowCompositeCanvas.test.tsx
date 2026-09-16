// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRemoteWindowCompositeCanvas } from './useRemoteWindowCompositeCanvas';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useRemoteWindowCompositeCanvas projection owner', () => {
  it('draws focus from the playback decoded-frame subscription without owning RVFC', () => {
    const receiver = { getTracks: () => [] } as unknown as MediaStream;
    const video = document.createElement('video');
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true },
      videoWidth: { value: 1280, configurable: true },
      videoHeight: { value: 720, configurable: true },
    });
    video.srcObject = receiver;
    const focus = document.createElement('canvas');
    const context = { drawImage: vi.fn() };
    focus.getContext = vi.fn(() => context) as unknown as HTMLCanvasElement['getContext'];
    let subscriber: ((frame: { video: HTMLVideoElement; presentedFrames?: number }) => void) | null = null;

    renderHook(() => useRemoteWindowCompositeCanvas({
      layout: null,
      focusedWindow: null,
      overviewCropVisible: false,
      receiverMediaStream: receiver,
      overviewMediaStream: null,
      videoElementRef: { current: video },
      overviewVideoElementRef: { current: null },
      overviewCanvasRef: { current: null },
      focusDisplayCanvasRef: { current: focus },
      thumbnailCanvasRefs: { current: new Map() },
      subscribeDecodedFrame: (callback) => {
        subscriber = callback;
        return () => { subscriber = null; };
      },
    }));

    act(() => subscriber?.({ video, presentedFrames: 1 }));
    expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 786 });
    act(() => subscriber?.({ video, presentedFrames: 2 }));
    expect(focus.width).toBe(786);
    expect(focus.height).toBe(720);
    expect(context.drawImage).toHaveBeenLastCalledWith(video, 0, 0, 786, 720);
  });

  it('crops the visible focus canvas from the daemon canvas layout', () => {
    const receiver = { getTracks: () => [] } as unknown as MediaStream;
    const video = document.createElement('video');
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true },
      videoWidth: { value: 1920, configurable: true },
      videoHeight: { value: 1080, configurable: true },
    });
    video.srcObject = receiver;
    const focus = document.createElement('canvas');
    const context = { drawImage: vi.fn() };
    focus.getContext = vi.fn(() => context) as unknown as HTMLCanvasElement['getContext'];
    const focusedWindow = { windowId: 'focus', offsetX: 560, offsetY: 324, width: 800, height: 600 };
    let subscriber: ((frame: { video: HTMLVideoElement; presentedFrames?: number }) => void) | null = null;

    renderHook(() => useRemoteWindowCompositeCanvas({
      layout: { windows: [focusedWindow], canvasWidth: 1920, canvasHeight: 1080 },
      focusedWindow,
      overviewCropVisible: false,
      receiverMediaStream: receiver,
      overviewMediaStream: null,
      videoElementRef: { current: video },
      overviewVideoElementRef: { current: null },
      overviewCanvasRef: { current: null },
      focusDisplayCanvasRef: { current: focus },
      thumbnailCanvasRefs: { current: new Map() },
      subscribeDecodedFrame: (callback) => {
        subscriber = callback;
        return () => { subscriber = null; };
      },
    }));

    act(() => subscriber?.({ video, presentedFrames: 1 }));

    expect(focus.width).toBe(800);
    expect(focus.height).toBe(600);
    expect(context.drawImage).toHaveBeenCalledWith(video, 560, 324, 800, 600, 0, 0, 800, 600);
  });

  it('draws overview and thumbnails once per decoded frame with cached contexts', () => {
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame');
    let frameCallback: ((now: number, metadata: { presentedFrames?: number }) => void) | null = null;
    const receiver = { getTracks: () => [] } as unknown as MediaStream;
    const video = document.createElement('video');
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true },
      videoWidth: { value: 1920, configurable: true },
      videoHeight: { value: 1080, configurable: true },
    });
    video.srcObject = receiver;
    Object.assign(video, {
      requestVideoFrameCallback: vi.fn((callback: typeof frameCallback) => {
        frameCallback = callback;
        return 1;
      }),
      cancelVideoFrameCallback: vi.fn(),
    });
    const overview = document.createElement('canvas');
    overview.width = 320;
    overview.height = 180;
    const thumbnail = document.createElement('canvas');
    thumbnail.width = 160;
    thumbnail.height = 90;
    const overviewContext = { clearRect: vi.fn(), drawImage: vi.fn() };
    const thumbnailContext = { clearRect: vi.fn(), drawImage: vi.fn() };
    overview.getContext = vi.fn(() => overviewContext) as unknown as HTMLCanvasElement['getContext'];
    thumbnail.getContext = vi.fn(() => thumbnailContext) as unknown as HTMLCanvasElement['getContext'];
    const slot = { windowId: 'window-1', offsetX: 10, offsetY: 20, width: 800, height: 600 };
    let unsubscribe: (() => void) | null = null;
    const hook = renderHook(() => useRemoteWindowCompositeCanvas({
      layout: { windows: [slot], canvasWidth: 1920, canvasHeight: 1080 },
      focusedWindow: slot,
      overviewCropVisible: true,
      receiverMediaStream: receiver,
      overviewMediaStream: { getTracks: () => [] } as unknown as MediaStream,
      videoElementRef: { current: null },
      overviewVideoElementRef: { current: video },
      overviewCanvasRef: { current: overview },
      thumbnailCanvasRefs: { current: new Map([['window-1', thumbnail]]) },
      subscribeDecodedFrame: () => {
        unsubscribe = () => {};
        return () => { unsubscribe = null; };
      },
    }));

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    act(() => frameCallback?.(0, { presentedFrames: 1 }));
    expect(overviewContext.drawImage).toHaveBeenCalledTimes(1);
    expect(thumbnailContext.drawImage).toHaveBeenCalledTimes(1);
    expect(thumbnailContext.clearRect).toHaveBeenCalledWith(0, 0, 160, 90);
    expect(overview.getContext).toHaveBeenCalledTimes(1);
    expect(thumbnail.getContext).toHaveBeenCalledTimes(1);

    act(() => frameCallback?.(1, { presentedFrames: 1 }));
    expect(overviewContext.drawImage).toHaveBeenCalledTimes(1);
    expect(thumbnailContext.drawImage).toHaveBeenCalledTimes(1);
    act(() => frameCallback?.(2, { presentedFrames: 2 }));
    expect(overviewContext.drawImage).toHaveBeenCalledTimes(2);
    expect(thumbnailContext.drawImage).toHaveBeenCalledTimes(2);
    expect(overview.getContext).toHaveBeenCalledTimes(1);
    expect(thumbnail.getContext).toHaveBeenCalledTimes(1);

    hook.unmount();
    expect(unsubscribe).toBeNull();
  });

  it('draws focus once for each unique decoded frame without a display-rAF loop', () => {
    const receiver = { getTracks: () => [] } as unknown as MediaStream;
    const video = document.createElement('video');
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true },
      videoWidth: { value: 1280, configurable: true },
      videoHeight: { value: 720, configurable: true },
    });
    video.srcObject = receiver;
    const focus = document.createElement('canvas');
    const context = { drawImage: vi.fn() };
    focus.getContext = vi.fn(() => context) as unknown as HTMLCanvasElement['getContext'];
    let subscriber: ((frame: { video: HTMLVideoElement; presentedFrames?: number }) => void) | null = null;

    renderHook(() => useRemoteWindowCompositeCanvas({
      layout: null,
      focusedWindow: null,
      overviewCropVisible: false,
      receiverMediaStream: receiver,
      overviewMediaStream: null,
      videoElementRef: { current: video },
      overviewVideoElementRef: { current: null },
      overviewCanvasRef: { current: null },
      focusDisplayCanvasRef: { current: focus },
      thumbnailCanvasRefs: { current: new Map() },
      subscribeDecodedFrame: (callback) => {
        subscriber = callback;
        return () => { subscriber = null; };
      },
    }));

    act(() => subscriber?.({ video, presentedFrames: 4 }));
    act(() => subscriber?.({ video, presentedFrames: 4 }));
    act(() => subscriber?.({ video, presentedFrames: 5 }));
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect(focus.getContext).toHaveBeenCalledTimes(1);
    expect(focus.width).toBe(1280);
    expect(focus.height).toBe(720);
    expect(subscriber).not.toBeNull();
  });

  it('does not register RVFC when focus drawing is subscribed to playback frames', () => {
    const video = document.createElement('video');
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true },
      videoWidth: { value: 1280, configurable: true },
      videoHeight: { value: 720, configurable: true },
    });
    const requestVideoFrameCallback = vi.fn();
    Object.assign(video, { requestVideoFrameCallback });
    const focus = document.createElement('canvas');
    const context = { drawImage: vi.fn() };
    focus.getContext = vi.fn(() => context) as unknown as HTMLCanvasElement['getContext'];

    renderHook(() => useRemoteWindowCompositeCanvas({
      layout: null,
      focusedWindow: null,
      overviewCropVisible: false,
      receiverMediaStream: { getTracks: () => [] } as unknown as MediaStream,
      overviewMediaStream: null,
      videoElementRef: { current: video },
      overviewVideoElementRef: { current: null },
      overviewCanvasRef: { current: null },
      focusDisplayCanvasRef: { current: focus },
      thumbnailCanvasRefs: { current: new Map() },
      subscribeDecodedFrame: () => () => {},
    }));

    expect(requestVideoFrameCallback).not.toHaveBeenCalled();
  });

  it('does not report missing decoded-frame callback because playback owns RVFC capability', () => {
    const onProjectionError = vi.fn();
    renderHook(() => useRemoteWindowCompositeCanvas({
      layout: null,
      focusedWindow: null,
      overviewCropVisible: false,
      receiverMediaStream: { getTracks: () => [] } as unknown as MediaStream,
      overviewMediaStream: null,
      videoElementRef: { current: document.createElement('video') },
      overviewVideoElementRef: { current: null },
      overviewCanvasRef: { current: null },
      focusDisplayCanvasRef: { current: document.createElement('canvas') },
      thumbnailCanvasRefs: { current: new Map() },
      subscribeDecodedFrame: () => () => {},
      onProjectionError,
    }));
    expect(onProjectionError).not.toHaveBeenCalled();
  });

  it('does not schedule drawing without receiver truth', () => {
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame');
    renderHook(() => useRemoteWindowCompositeCanvas({
      layout: { windows: [], canvasWidth: 1920, canvasHeight: 1080 },
      focusedWindow: null,
      overviewCropVisible: false,
      receiverMediaStream: null,
      overviewMediaStream: null,
      videoElementRef: { current: null },
      overviewVideoElementRef: { current: null },
      overviewCanvasRef: { current: null },
      thumbnailCanvasRefs: { current: new Map() },
    }));
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});
