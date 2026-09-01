/**
 * Submodule tests: remote-window-overlay-helpers (client.remote_window_overlay).
 */
import { describe, expect, it } from 'vitest';
import {
  buildRemoteWindowAppTargetGroups,
  clampFloatingOffset,
  clampFullscreenViewport,
  formatTargetKind,
  resolveAspectRect,
  safeRemoteWindowGroupId,
} from './remote-window-overlay-helpers';

describe('remote-window-overlay-helpers', () => {
  it('clamps offsets and numbers to bounds', () => {
    expect(clampFloatingOffset(150, 10, 100)).toBe(100);
    expect(clampFloatingOffset(5, 10, 100)).toBe(10);
    expect(clampFloatingOffset(50, 10, 100)).toBe(50);
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

  it('keeps local geometry aspect-fit while fill is implemented by remote resize', () => {
    const rect = resolveAspectRect(
      { width: 100, height: 100 },
      { width: 200, height: 100 },
      'fill',
    );
    expect(rect).toMatchObject({ width: 100, height: 50, left: 0, top: 25 });
    const clamped = clampFullscreenViewport(
      { scale: 2, panX: 0, panY: 0 },
      { width: 100, height: 100 },
      { width: 200, height: 100 },
      'fill',
    );
    expect(clamped.scale).toBe(2);
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
