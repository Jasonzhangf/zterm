// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useRemoteWindowDisplayQualityControls } from './useRemoteWindowDisplayQualityControls';
import {
  REMOTE_WINDOW_VIDEO_CAP_STORAGE_KEY,
} from './remote-window-overlay-storage';
import { REMOTE_WINDOW_VIDEO_PREFERENCE_STORAGE_KEY } from '../../lib/remote-window-video-quality';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';

const target: RemoteWindowStreamTargetManifest = {
  streamTargetId: 'target-controls',
  videoTarget: {
    kind: 'app-window',
    appBundleId: 'com.apple.TextEdit',
    pid: 123,
    windowId: 'window-controls',
    title: 'TextEdit',
    windowBoundsTopLeftPx: { x: 10, y: 20, width: 1280, height: 720 },
    cropRectTopLeftPx: { x: 10, y: 20, width: 1280, height: 720 },
  },
  inputTarget: { kind: 'app-window' },
  streamMode: 'interactive',
  focusPolicy: 'bring-to-focus',
  inputRoute: 'os-event',
  capture: {
    source: 'ScreenCaptureKit',
    coordinateSpace: 'macos-top-left-px',
    displayId: 'display-1',
    displayBoundsTopLeftPx: { x: 0, y: 0, width: 1920, height: 1080 },
    scale: 1,
    createdAt: '2026-07-20T00:00:00.000Z',
  },
};

describe('useRemoteWindowDisplayQualityControls', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('exposes the explicit Mbps cap in the same commit as the committed settings', () => {
    const { result } = renderHook(() => useRemoteWindowDisplayQualityControls({ target }));
    expect(result.current.maxBitrateCapBps).toBeNull();

    act(() => {
      expect(result.current.commitQualitySettings({
        preference: 'quality',
        maxBitrateCapMbps: 12.5,
        maxFrameRateFps: 60,
      })).toBe(true);
    });
    expect(result.current.qualitySettings).toEqual({
      preference: 'quality',
      maxBitrateCapMbps: 12.5,
      maxFrameRateFps: 60,
    });
    // Same commit: the render-path derivation must not read a stale ref.
    expect(result.current.maxBitrateCapBps).toBe(12_500_000);
  });

  it('persists the explicit preference and cap as the desired truth, not a multiplier', () => {
    const { result } = renderHook(() => useRemoteWindowDisplayQualityControls({ target }));
    act(() => {
      expect(result.current.commitQualitySettings({
        preference: 'quality',
        maxBitrateCapMbps: 4,
        maxFrameRateFps: 60,
      })).toBe(true);
    });
    expect(window.localStorage.getItem(REMOTE_WINDOW_VIDEO_CAP_STORAGE_KEY)).toContain('4');
    expect(window.localStorage.getItem(REMOTE_WINDOW_VIDEO_PREFERENCE_STORAGE_KEY)).toContain('quality');
    expect(result.current.maxBitrateCapBps).toBe(4_000_000);
  });

  it('refuses an out-of-range cap without persisting a partial Apply', () => {
    const { result } = renderHook(() => useRemoteWindowDisplayQualityControls({ target }));
    act(() => {
      expect(result.current.commitQualitySettings({
        preference: 'quality',
        maxBitrateCapMbps: 26,
        maxFrameRateFps: 60,
      })).toBe(false);
    });
    // Nothing is written: no preference, no cap.
    expect(window.localStorage.getItem(REMOTE_WINDOW_VIDEO_CAP_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(REMOTE_WINDOW_VIDEO_PREFERENCE_STORAGE_KEY)).toBeNull();
    expect(result.current.qualitySettings).toEqual({
      preference: 'smooth',
      maxBitrateCapMbps: null,
      maxFrameRateFps: 30,
    });
  });
});
