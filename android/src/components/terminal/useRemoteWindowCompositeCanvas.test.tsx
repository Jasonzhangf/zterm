// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRemoteWindowCompositeCanvas } from './useRemoteWindowCompositeCanvas';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useRemoteWindowCompositeCanvas projection owner', () => {
  it('draws overview and thumbnails once per decoded frame with cached contexts', () => {
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame');
    let frameCallback: ((now: number, metadata: { presentedFrames?: number }) => void) | null = null;
    let callbackId = 0;
    const video = document.createElement('video');
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true },
      videoWidth: { value: 1920, configurable: true },
      videoHeight: { value: 1080, configurable: true },
    });
    const requestVideoFrameCallback = vi.fn((callback: typeof frameCallback) => {
      frameCallback = callback;
      callbackId += 1;
      return callbackId;
    });
    const cancelVideoFrameCallback = vi.fn();
    Object.assign(video, { requestVideoFrameCallback, cancelVideoFrameCallback });
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
    const hook = renderHook(() => useRemoteWindowCompositeCanvas({
      layout: { windows: [slot], canvasWidth: 1920, canvasHeight: 1080 },
      focusedWindow: slot,
      overviewCropVisible: true,
      receiverMediaStream: { getTracks: () => [] } as unknown as MediaStream,
      overviewMediaStream: { getTracks: () => [] } as unknown as MediaStream,
      videoElementRef: { current: null },
      overviewVideoElementRef: { current: video },
      overviewCanvasRef: { current: overview },
      thumbnailCanvasRefs: { current: new Map([['window-1', thumbnail]]) },
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
    expect(cancelVideoFrameCallback).toHaveBeenCalledWith(callbackId);
  });

  it('draws focus once for each unique decoded frame without a display-rAF loop', () => {
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame');
    let frameCallback: ((now: number, metadata: { presentedFrames?: number }) => void) | null = null;
    const video = document.createElement('video');
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true },
      videoWidth: { value: 1280, configurable: true },
      videoHeight: { value: 720, configurable: true },
    });
    Object.assign(video, {
      requestVideoFrameCallback: vi.fn((callback: typeof frameCallback) => {
        frameCallback = callback;
        return 1;
      }),
      cancelVideoFrameCallback: vi.fn(),
    });
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
    }));

    act(() => frameCallback?.(0, { presentedFrames: 4 }));
    act(() => frameCallback?.(1, { presentedFrames: 4 }));
    act(() => frameCallback?.(2, { presentedFrames: 5 }));
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect(focus.getContext).toHaveBeenCalledTimes(1);
    expect(focus.width).toBe(1280);
    expect(focus.height).toBe(720);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('reports missing decoded-frame callback instead of starting a fallback draw loop', () => {
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame');
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
      onProjectionError,
    }));
    expect(onProjectionError).toHaveBeenCalledWith('remote window decoded-frame callback is unavailable');
    expect(requestAnimationFrame).not.toHaveBeenCalled();
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
