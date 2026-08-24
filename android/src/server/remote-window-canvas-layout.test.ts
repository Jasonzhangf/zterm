import { describe, expect, it } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from '@zterm/shared/protocol';
import { buildRemoteWindowCanvasLayoutV1 } from './remote-window-canvas-layout';

function makeTarget(): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: 'app-window:12:main',
    videoTarget: {
      kind: 'app-window',
      appBundleId: 'example.app',
      pid: 12,
      windowId: 'main',
      title: 'Main',
      windowBoundsTopLeftPx: { x: 10, y: 20, width: 1200, height: 800 },
      cropRectTopLeftPx: { x: 10, y: 20, width: 1200, height: 800 },
    },
    compositeWindows: [
      {
        windowId: 'child',
        title: 'Child',
        windowBoundsTopLeftPx: { x: 1300, y: 20, width: 600, height: 400 },
        cropRectTopLeftPx: { x: 1300, y: 20, width: 600, height: 400 },
      },
    ],
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
}

describe('remote window canvas layout owner', () => {
  it('publishes focus-plus-rail geometry with focus below the sibling rail', () => {
    const layout = buildRemoteWindowCanvasLayoutV1(makeTarget(), 7);
    expect(layout).not.toBeNull();
    const focus = layout!.windows.find((window) => window.windowId === 'main');
    const child = layout!.windows.find((window) => window.windowId === 'child');
    expect(focus).toBeDefined();
    expect(child).toBeDefined();
    const railBottom = Math.round(layout!.canvasSize.height * 0.3);
    expect(child!.canvasRectPx.y).toBeGreaterThanOrEqual(0);
    expect(child!.canvasRectPx.y + child!.canvasRectPx.height).toBeLessThanOrEqual(railBottom);
    expect(focus!.canvasRectPx.y).toBeGreaterThanOrEqual(railBottom);
    expect(focus!.zIndex).toBeGreaterThan(child!.zIndex);
    expect(layout!.layoutGeneration).toBe(7);
    expect(layout!.canvasSize).toEqual({ width: 1920, height: 1080 });
  });

  it('caps the published rail at three siblings', () => {
    const target = makeTarget();
    target.compositeWindows = ['a', 'b', 'c', 'd'].map((id) => ({
      windowId: id,
      title: id,
      windowBoundsTopLeftPx: { x: 0, y: 0, width: 100, height: 100 },
      cropRectTopLeftPx: { x: 0, y: 0, width: 100, height: 100 },
    }));
    const layout = buildRemoteWindowCanvasLayoutV1(target, 8);
    expect(layout!.windows.filter((window) => window.windowId !== 'main')).toHaveLength(3);
    expect(layout!.windows.some((window) => window.windowId === 'd')).toBe(false);
  });

  it('rejects invalid generations and does not invent a single-window canvas', () => {
    expect(() => buildRemoteWindowCanvasLayoutV1(makeTarget(), 0)).toThrow(/generation/);
    expect(buildRemoteWindowCanvasLayoutV1({ ...makeTarget(), compositeWindows: [] }, 1)).toBeNull();
  });
});
