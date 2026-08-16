import { describe, expect, it } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from '@zterm/shared/protocol';
import {
  buildScreenCaptureKitConfig,
  resolveRemoteWindowCompositeLayout,
} from './remote-window-capture';

function makeTarget(overrides: Partial<RemoteWindowStreamTargetManifest> = {}): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: 'app-window:1:100',
    videoTarget: {
      kind: 'app-window',
      appBundleId: 'com.tencent.xinWeChat',
      pid: 100,
      windowId: '100',
      title: 'WeChat',
      windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      cropRectTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
    },
    inputTarget: { kind: 'app-window' },
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: '2026-08-08T00:00:00.000Z',
    },
    ...overrides,
  } as RemoteWindowStreamTargetManifest;
}

describe('remote-window composite pane layout', () => {
  it('returns null when the target has no composite windows', () => {
    expect(resolveRemoteWindowCompositeLayout(makeTarget())).toBeNull();
  });

  it('lays out same-app windows in a single row (Σ width × max height)', () => {
    const target = makeTarget({
      compositeWindows: [
        {
          windowId: '200',
          title: 'WeChat Image Preview',
          windowBoundsTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
          cropRectTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
        },
      ],
    });
    const layout = resolveRemoteWindowCompositeLayout(target);
    expect(layout).not.toBeNull();
    expect(layout!.canvasWidth).toBe(1920);
    expect(layout!.canvasHeight).toBe(1080);
    expect(layout!.windows).toHaveLength(2);
    expect(layout!.windows[0]).toMatchObject({ windowId: '100', offsetX: 0, offsetY: 0 });
    expect(layout!.windows[1]).toMatchObject({ windowId: '200', offsetX: 800, offsetY: 0 });
  });

  it('deduplicates the primary entry and fits oversized rows into the 1080P canvas', () => {
    const target = makeTarget({
      compositeWindows: [
        {
          windowId: '100',
          title: 'Synthetic primary',
          windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
          cropRectTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
        },
        ...['200', '300', '400'].map((windowId) => ({
          windowId,
          title: windowId,
          windowBoundsTopLeftPx: { x: 0, y: 0, width: 1000, height: 1000 },
          cropRectTopLeftPx: { x: 0, y: 0, width: 1000, height: 1000 },
        })),
      ],
    });
    const layout = resolveRemoteWindowCompositeLayout(target);
    expect(layout!.windows.map((window) => window.windowId)).toEqual(['100', '200', '300', '400']);
    const last = layout!.windows[layout!.windows.length - 1]!;
    expect(last.offsetX + last.outputWidth).toBeLessThanOrEqual(layout!.canvasWidth);
    expect(last.outputHeight).toBeLessThanOrEqual(layout!.canvasHeight);
  });

  it('builds a capture config carrying composite windows and canvas size', () => {
    const target = makeTarget({
      compositeWindows: [
        {
          windowId: '200',
          title: 'Preview',
          windowBoundsTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
          cropRectTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
        },
      ],
    });
    const config = buildScreenCaptureKitConfig(target, 30);
    expect(config.canvasWidth).toBe(1920);
    expect(config.canvasHeight).toBe(1080);
    expect(config.compositeWindows).toHaveLength(1);
    expect(config.compositeWindows![0]).toMatchObject({ windowId: '200', offsetX: 800, offsetY: 0 });
  });

  it('keeps a single-window capture config unchanged when no composites', () => {
    const config = buildScreenCaptureKitConfig(makeTarget(), 30);
    expect(config.canvasWidth).toBeUndefined();
    expect(config.compositeWindows).toBeUndefined();
    expect(config.windowId).toBe('100');
  });
});
