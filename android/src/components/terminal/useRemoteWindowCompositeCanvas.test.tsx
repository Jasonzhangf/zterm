// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRemoteWindowCompositeCanvas } from './useRemoteWindowCompositeCanvas';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useRemoteWindowCompositeCanvas projection owner', () => {
  it('draws daemon-published canvas rectangles and contained thumbnails', () => {
    let frameCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallback = callback;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const video = document.createElement('video');
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true },
      videoWidth: { value: 1920, configurable: true },
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
    renderHook(() => useRemoteWindowCompositeCanvas({
      layout: { windows: [slot], canvasWidth: 1920, canvasHeight: 1080 },
      focusedWindow: slot,
      overviewCropVisible: true,
      receiverMediaStream: { getTracks: () => [] } as unknown as MediaStream,
      videoElementRef: { current: video },
      overviewVideoElementRef: { current: null },
      overviewCanvasRef: { current: overview },
      thumbnailCanvasRefs: { current: new Map([['window-1', thumbnail]]) },
    }));

    act(() => frameCallback?.(0));
    expect(overviewContext.drawImage).toHaveBeenCalledTimes(2);
    expect(thumbnailContext.drawImage).toHaveBeenCalledTimes(1);
    expect(thumbnailContext.clearRect).toHaveBeenCalledWith(0, 0, 160, 90);
  });

  it('does not schedule drawing without receiver truth', () => {
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame');
    renderHook(() => useRemoteWindowCompositeCanvas({
      layout: { windows: [], canvasWidth: 1920, canvasHeight: 1080 },
      focusedWindow: null,
      overviewCropVisible: false,
      receiverMediaStream: null,
      videoElementRef: { current: null },
      overviewVideoElementRef: { current: null },
      overviewCanvasRef: { current: null },
      thumbnailCanvasRefs: { current: new Map() },
    }));
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});
