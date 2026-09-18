/**
 * Submodule tests: remote-window-overlay-helpers (client.remote_window_overlay).
 */
import { describe, expect, it } from 'vitest';
import {
  buildRemoteWindowAppTargetGroups,
  clampFloatingOffset,
  clampFullscreenViewport,
  resolveFloatingOverlayBounds,
  toFloatingOverlayClampRect,
  formatTargetKind,
  isRemoteWindowChromeTarget,
  resolveAspectRect,
  resolveZoomedContentRect,
  resolveRemoteWindowTargetResizeSize,
  safeRemoteWindowGroupId,
} from './remote-window-overlay-helpers';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';

function appTarget(appBundleId: string): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: `app:${appBundleId}`,
    videoTarget: { kind: 'app-window', appBundleId, pid: 1, windowId: '1', title: 'Chrome', windowBoundsTopLeftPx: { x: 0, y: 0, width: 800, height: 600 } },
    inputTarget: { kind: 'app-window' }, streamMode: 'interactive', focusPolicy: 'bring-to-focus', inputRoute: 'os-event',
    capture: { source: 'ScreenCaptureKit', coordinateSpace: 'macos-top-left-px', scale: 1, createdAt: 'now' },
  };
}

describe('remote-window-overlay-helpers', () => {
  it('classifies Chrome targets for browser mode', () => {
    expect(isRemoteWindowChromeTarget(appTarget('com.google.Chrome'))).toBe(true);
    expect(isRemoteWindowChromeTarget(appTarget('com.google.Chrome.canary'))).toBe(true);
    expect(isRemoteWindowChromeTarget(appTarget('com.apple.Safari'))).toBe(false);
  });

  it('clamps offsets and numbers to bounds', () => {
    expect(clampFloatingOffset(150, 10, 100)).toBe(100);
    expect(clampFloatingOffset(5, 10, 100)).toBe(10);
    expect(clampFloatingOffset(50, 10, 100)).toBe(50);
  });

  it('clamps floating overlays to the visible stage without weakening the viewport safe top', () => {
    expect(resolveFloatingOverlayBounds({
      viewport: { left: 0, top: 0, right: 1280, bottom: 800 },
      container: { left: 0, top: 79, right: 1280, bottom: 800 },
      overlay: { width: 420, height: 522 },
      margin: 8,
      topSafeMargin: 48,
    })).toEqual({ minLeft: 8, maxLeft: 852, minTop: 87, maxTop: 270 });

    expect(resolveFloatingOverlayBounds({
      viewport: { left: 0, top: 0, right: 1280, bottom: 800 },
      container: { left: 0, top: 0, right: 1280, bottom: 800 },
      overlay: { width: 420, height: 300 },
      margin: 8,
      topSafeMargin: 48,
    }).minTop).toBe(48);
  });

  it('uses visualViewport offsetLeft and ignores a container that cannot hold the overlay', () => {
    expect(toFloatingOverlayClampRect(undefined)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(resolveFloatingOverlayBounds({
      viewport: { left: 120, top: 16, right: 760, bottom: 736 },
      container: { left: 0, top: 0, right: 0, bottom: 0 },
      overlay: { width: 420, height: 300 },
      margin: 8,
      topSafeMargin: 48,
    })).toEqual({
      minLeft: 128,
      maxLeft: 332,
      minTop: 64,
      maxTop: 428,
    });
    expect(resolveFloatingOverlayBounds({
      viewport: { left: 0, top: 0, right: 1024, bottom: 768 },
      container: { left: 0, top: 0, right: 360, bottom: 225 },
      overlay: { width: 360, height: 225 },
      margin: 8,
      topSafeMargin: 48,
    })).toEqual({
      minLeft: 8,
      maxLeft: 656,
      minTop: 48,
      maxTop: 535,
    });
  });

  it('resolves aspect-fit rects from source to surface', () => {
    const rect = resolveAspectRect(
      { width: 100, height: 100 },
      { width: 200, height: 100 },
      'fit',
    );
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(50);
    expect(rect.left).toBe(0);
    expect(rect.top).toBe(25);
  });

  it('resolves a point-to-point remote window resize from the container size and DPR', () => {
    const target = appTarget('com.apple.TextEdit');
    target.videoTarget.windowBoundsTopLeftPx = { x: 0, y: 0, width: 900, height: 700 };
    target.videoTarget.cropRectTopLeftPx = { x: 0, y: 0, width: 900, height: 700 };
    expect(resolveRemoteWindowTargetResizeSize({
      viewport: { width: 1280, height: 800 },
      devicePixelRatio: 2,
      target,
    })).toEqual({ width: 2560, height: 1600 });
  });

  it('scales the container aspect ratio down to fit inside the display bounds', () => {
    const target = appTarget('com.apple.TextEdit');
    target.videoTarget.windowBoundsTopLeftPx = { x: 0, y: 0, width: 900, height: 700 };
    target.videoTarget.cropRectTopLeftPx = { x: 0, y: 0, width: 900, height: 700 };
    target.capture.displayBoundsTopLeftPx = { x: 0, y: 0, width: 1920, height: 1080 };
    const resized = resolveRemoteWindowTargetResizeSize({
      viewport: { width: 1280, height: 800 },
      devicePixelRatio: 2,
      target,
    });
    expect(resized).not.toBeNull();
    if (!resized) throw new Error('expected resized target');
    expect(resized).toEqual({ width: 1728, height: 1080 });
    expect(resized.width / resized.height).toBeCloseTo(1280 / 800, 5);
    expect(resized.width).toBeLessThanOrEqual(1920);
    expect(resized.height).toBeLessThanOrEqual(1080);
    const rect = resolveAspectRect(
      { width: 1280, height: 800 },
      resized,
      'fit',
    );
    expect(rect.left).toBeCloseTo((1280 - rect.width) / 2, 5);
    expect(rect.top).toBeCloseTo((800 - rect.height) / 2, 5);
  });

  it('subtracts the current window origin before clamping to the display bounds', () => {
    const target = appTarget('com.apple.TextEdit');
    target.videoTarget.windowBoundsTopLeftPx = { x: 200, y: 200, width: 900, height: 700 };
    target.videoTarget.cropRectTopLeftPx = { x: 200, y: 200, width: 900, height: 700 };
    target.capture.displayBoundsTopLeftPx = { x: 0, y: 0, width: 1920, height: 1080 };
    const resized = resolveRemoteWindowTargetResizeSize({
      viewport: { width: 1280, height: 800 },
      devicePixelRatio: 2,
      target,
    });
    expect(resized).not.toBeNull();
    if (!resized) throw new Error('expected resized target');
    // 可用宽高是 display 减去窗口原点：1720 x 880，按容器比例回缩后不越界。
    expect(resized.width).toBeLessThanOrEqual(1920 - 200);
    expect(resized.height).toBeLessThanOrEqual(1080 - 200);
    expect(resized.width / resized.height).toBeCloseTo(1280 / 800, 5);
  });

  it('returns null when the display has no drawable space at the target origin', () => {
    const target = appTarget('com.apple.TextEdit');
    target.videoTarget.windowBoundsTopLeftPx = { x: 1900, y: 1000, width: 900, height: 700 };
    target.videoTarget.cropRectTopLeftPx = { x: 1900, y: 1000, width: 900, height: 700 };
    target.capture.displayBoundsTopLeftPx = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(resolveRemoteWindowTargetResizeSize({
      viewport: { width: 1280, height: 800 },
      devicePixelRatio: 2,
      target,
    })).toBeNull();
  });

  it('fills fullscreen geometry while preserving fit geometry', () => {
    const rect = resolveAspectRect(
      { width: 100, height: 100 },
      { width: 200, height: 100 },
      'fill',
    );
    expect(rect).toMatchObject({ width: 200, height: 100, left: -50, top: 0 });
    const clamped = clampFullscreenViewport(
      { scale: 2, panX: 0, panY: 0 },
      { width: 100, height: 100 },
      { width: 200, height: 100 },
      'fill',
    );
    expect(clamped.scale).toBe(2);
  });

  it('keeps tablet fill bottom reachable when the source is taller than the surface', () => {
    const surface = { width: 1180, height: 820 };
    const source = { width: 400, height: 800 };
    const clamped = clampFullscreenViewport(
      { scale: 2, panX: 0, panY: -99999 },
      surface,
      source,
      'fill',
    );
    const rect = resolveZoomedContentRect(surface, source, clamped, 'fill');
    expect(clamped.panY).toBeLessThan(0);
    expect(rect.content.top + rect.content.height).toBeCloseTo(surface.height, 1);
  });

  it('keeps fullscreen viewports clamped to the surface', () => {
    const clamped = clampFullscreenViewport(
      { scale: 8, panX: 9999, panY: -9999 },
      { width: 100, height: 100 },
      { width: 300, height: 300 },
    );
    expect(clamped.scale).toBeLessThanOrEqual(4);
    expect(clamped.panX).toBeGreaterThanOrEqual(-50);
  });

  it('projects a landscape window point-to-point inside a portrait surface', () => {
    const { content } = resolveZoomedContentRect(
      { width: 390, height: 844 },
      { width: 1600, height: 900 },
      { scale: 1, panX: 0, panY: 0 },
      'fit',
    );
    expect(content.width).toBeCloseTo(390, 1);
    expect(content.height).toBeCloseTo(219.375, 1);
    expect(content.left).toBeCloseTo(0, 1);
    expect(content.top).toBeCloseTo((844 - content.height) / 2, 1);
  });

  it('projects a standard 4:3 window inside the surface without crop', () => {
    const { content } = resolveZoomedContentRect(
      { width: 390, height: 844 },
      { width: 1024, height: 768 },
      { scale: 1, panX: 0, panY: 0 },
      'fit',
    );
    expect(content.width).toBeCloseTo(390, 1);
    expect(content.height).toBeCloseTo(292.5, 1);
    expect(content.left).toBeCloseTo(0, 1);
    expect(content.top).toBeCloseTo((844 - content.height) / 2, 1);
  });

  it('projects a narrow tall window centered inside a landscape surface', () => {
    const { content } = resolveZoomedContentRect(
      { width: 844, height: 390 },
      { width: 400, height: 1200 },
      { scale: 1, panX: 0, panY: 0 },
      'fit',
    );
    expect(content.width).toBeCloseTo(130, 1);
    expect(content.height).toBeCloseTo(390, 1);
    expect(content.left).toBeCloseTo((844 - content.width) / 2, 1);
    expect(content.top).toBeCloseTo(0, 1);
  });

  it('formats target kinds and groups app targets by bundle', () => {
    expect(formatTargetKind({ videoTarget: { kind: 'app-window' } } as never)).toBeTruthy();
    expect(safeRemoteWindowGroupId('a/b:c')).toBe('a-b-c');
  });

  it('builds app target groups with a composite group for multi-window apps', () => {
    const groups = buildRemoteWindowAppTargetGroups([
      { videoTarget: { kind: 'app-window', appBundleId: 'com.app', title: 'App', windowId: 'w1', pid: 1, windowBoundsTopLeftPx: { left: 0, top: 0, width: 100, height: 100 } }, streamTargetId: 's1' } as never,
      { videoTarget: { kind: 'app-window', appBundleId: 'com.app', title: 'App', windowId: 'w2', pid: 1, windowBoundsTopLeftPx: { left: 200, top: 0, width: 100, height: 100 } }, streamTargetId: 's2' } as never,
    ]);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.some((g) => g.targets.length >= 2)).toBe(true);
  });
});
