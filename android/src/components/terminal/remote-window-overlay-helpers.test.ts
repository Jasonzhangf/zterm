import { describe, expect, it } from 'vitest';
import {
  buildRemoteWindowAppTargetGroups,
  clampFloatingOffset,
  clampFullscreenViewport,
  formatTargetKind,
  isRemoteWindowChromeTarget,
  resolveAspectRect,
  resolveRemoteWindowQualityStreamSize,
  resolveRemoteWindowTargetAspectRatio,
  safeRemoteWindowGroupId,
} from './remote-window-overlay-helpers';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';

function appTarget(appBundleId: string): RemoteWindowStreamTargetManifest {
  return { streamTargetId: `app:${appBundleId}`, videoTarget: { kind: 'app-window', appBundleId, pid: 1, windowId: '1', title: 'Chrome', windowBoundsTopLeftPx: { x: 0, y: 0, width: 800, height: 600 } }, inputTarget: { kind: 'app-window' }, streamMode: 'interactive', focusPolicy: 'bring-to-focus', inputRoute: 'os-event', capture: { source: 'ScreenCaptureKit', coordinateSpace: 'macos-top-left-px', scale: 1, createdAt: 'now' } };
}

describe('remote window aspect-ratio scaling', () => {
  it('retains existing overlay helper contracts', () => {
    expect(isRemoteWindowChromeTarget(appTarget('com.google.Chrome'))).toBe(true);
    expect(clampFloatingOffset(150, 10, 100)).toBe(100);
    expect(resolveAspectRect({ width: 100, height: 100 }, { width: 200, height: 100 }, 'fit')).toMatchObject({ width: 100, height: 50 });
    expect(clampFullscreenViewport({ scale: 8, panX: 9999, panY: -9999 }, { width: 100, height: 100 }, { width: 300, height: 300 }).scale).toBeLessThanOrEqual(4);
    expect(formatTargetKind({ videoTarget: { kind: 'app-window' } } as never)).toBeTruthy();
    expect(safeRemoteWindowGroupId('a/b:c')).toBe('a-b-c');
    expect(buildRemoteWindowAppTargetGroups([appTarget('com.app')]).length).toBeGreaterThan(0);
  });
  it('aligns short edge to 720/1080/2160 without upscaling', () => {
    expect(resolveRemoteWindowQualityStreamSize({ source: { width: 1920, height: 1080 }, quality: 'smooth-720', aspectRatio: 16 / 9 })).toEqual({ width: 1280, height: 720 });
    expect(resolveRemoteWindowQualityStreamSize({ source: { width: 2560, height: 1440 }, quality: 'quality-1080', aspectRatio: 16 / 9 })).toEqual({ width: 1920, height: 1080 });
    expect(resolveRemoteWindowQualityStreamSize({ source: { width: 640, height: 360 }, quality: 'ultra-2160', aspectRatio: 16 / 9 })).toEqual({ width: 640, height: 360 });
  });

  it('resolves locked orientation from the available viewport', () => {
    expect(resolveRemoteWindowTargetAspectRatio({ viewport: { width: 1080, height: 1920 }, orientation: 'portrait' })).toBeCloseTo(1080 / 1920);
    expect(resolveRemoteWindowTargetAspectRatio({ viewport: { width: 1080, height: 1920 }, orientation: 'landscape' })).toBeCloseTo(1920 / 1080);
    expect(resolveRemoteWindowTargetAspectRatio({ viewport: { width: 1920, height: 1080 }, orientation: 'follow-device' })).toBeCloseTo(1920 / 1080);
  });
});
