import { describe, expect, it } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from '@zterm/shared/protocol';
import {
  buildScreenCaptureKitConfig,
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

describe('remote-window capture config', () => {
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
