// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import {
  applyRemoteWindowTargetCatalog,
  beginRemoteWindowTargetEnumeration,
  enterRemoteWindowFullscreen,
  initialRemoteWindowOverlayState,
  selectRemoteWindowTarget,
} from '../../lib/remote-window-overlay-runtime';
import { useRemoteWindowViewport } from './useRemoteWindowViewport';

afterEach(cleanup);

const target: RemoteWindowStreamTargetManifest = {
  streamTargetId: 'target',
  videoTarget: {
    kind: 'app-window',
    appBundleId: 'com.example.app',
    pid: 42,
    windowId: 'window',
    title: 'Example',
    windowBoundsTopLeftPx: { x: 0, y: 0, width: 800, height: 600 },
  },
  inputTarget: { kind: 'app-window' },
  streamMode: 'interactive',
  focusPolicy: 'bring-to-focus',
  inputRoute: 'os-event',
  capture: {
    source: 'ScreenCaptureKit',
    coordinateSpace: 'macos-top-left-px',
    scale: 1,
    createdAt: '2026-08-19T00:00:00.000Z',
  },
};

function lockedState(fullscreen = false) {
  const started = beginRemoteWindowTargetEnumeration(initialRemoteWindowOverlayState);
  const picker = applyRemoteWindowTargetCatalog(started.state, started.requestEpoch, {
    requestId: 'catalog',
    targets: [target],
  });
  const locked = selectRemoteWindowTarget(picker, target.streamTargetId);
  return fullscreen ? enterRemoteWindowFullscreen(locked) : locked;
}

describe('useRemoteWindowViewport geometry owner', () => {
  it('measures the surface and owns deterministic double-tap/reset state', async () => {
    const surface = document.createElement('div');
    surface.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 800, width: 400, height: 800, toJSON: () => ({}),
    }));
    const onResetGestures = vi.fn();
    const focusedWindowSlotRef = { current: null };
    const videoSurfaceRef = { current: surface };
    const floatingOverlayRef = { current: null };
    const state = lockedState(true);
    const receiverFrameSize = { width: 800, height: 600 };
    const { result } = renderHook(() => useRemoteWindowViewport({
      state,
      receiverFrameSize,
      focusedWindowSlotRef,
      videoSurfaceRef,
      floatingOverlayRef,
      bottomInsetPx: 0,
      bottomChromeInsetPx: 0,
      onResetGestures,
    }));

    await waitFor(() => expect(result.current.surfaceSize).toEqual({ width: 400, height: 800 }));
    act(() => result.current.handleDoubleTapZoom(200, 300));
    expect(result.current.fullscreenViewport.scale).toBe(2);
    act(() => result.current.resetFullscreenViewport());
    expect(result.current.fullscreenViewport).toEqual({ scale: 1, panX: 0, panY: 0 });
    expect(onResetGestures).toHaveBeenCalledTimes(1);
    expect(result.current.viewportDebugSnapshot?.surface).toContain('400x800');
  });

  it('applies IME chrome pan only in fullscreen', async () => {
    const surface = document.createElement('div');
    surface.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 800, width: 400, height: 800, toJSON: () => ({}),
    }));
    const focusedWindowSlotRef = { current: null };
    const videoSurfaceRef = { current: surface };
    const floatingOverlayRef = { current: null };
    const onResetGestures = vi.fn();
    const state = lockedState(true);
    const receiverFrameSize = { width: 800, height: 600 };
    const { result } = renderHook(() => useRemoteWindowViewport({
      state,
      receiverFrameSize,
      focusedWindowSlotRef,
      videoSurfaceRef,
      floatingOverlayRef,
      bottomInsetPx: 300,
      bottomChromeInsetPx: 50,
      onResetGestures,
    }));
    await waitFor(() => expect(result.current.fullscreenViewport.panY).toBeLessThanOrEqual(0));
  });
});
