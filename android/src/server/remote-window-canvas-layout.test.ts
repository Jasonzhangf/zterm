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
  it('publishes the only source-to-canvas mapping with its generation', () => {
    expect(buildRemoteWindowCanvasLayoutV1(makeTarget(), 7)).toEqual({
      version: 1,
      layoutGeneration: 7,
      canvasSize: { width: 1920, height: 1080 },
      focusTargetId: 'app-window:12:main',
      windows: [
        {
          windowId: 'main',
          sourceRectTopLeftPx: { x: 10, y: 20, width: 1200, height: 800 },
          canvasRectPx: { x: 0, y: 0, width: 1200, height: 800 },
          zIndex: 0,
        },
        {
          windowId: 'child',
          sourceRectTopLeftPx: { x: 1300, y: 20, width: 600, height: 400 },
          canvasRectPx: { x: 1200, y: 0, width: 600, height: 400 },
          zIndex: 1,
        },
      ],
    });
  });

  it('rejects invalid generations and does not invent a single-window canvas', () => {
    expect(() => buildRemoteWindowCanvasLayoutV1(makeTarget(), 0)).toThrow(/generation/);
    expect(buildRemoteWindowCanvasLayoutV1({ ...makeTarget(), compositeWindows: [] }, 1)).toBeNull();
  });
});
