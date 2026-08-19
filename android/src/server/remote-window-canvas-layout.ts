import type {
  RemoteWindowCanvasLayoutV1,
  RemoteWindowStreamTargetManifest,
} from '@zterm/shared/protocol';

const REMOTE_WINDOW_CANVAS_WIDTH = 1920;
const REMOTE_WINDOW_CANVAS_HEIGHT = 1080;

export function buildRemoteWindowCanvasLayoutV1(
  target: RemoteWindowStreamTargetManifest,
  layoutGeneration: number,
): RemoteWindowCanvasLayoutV1 | null {
  if (!Number.isSafeInteger(layoutGeneration) || layoutGeneration <= 0) {
    throw new Error('remote window canvas layout generation must be a positive integer');
  }
  const compositeWindows = target.compositeWindows ?? [];
  if (compositeWindows.length === 0) {
    return null;
  }
  const candidates = [
    {
      windowId: target.videoTarget.windowId,
      sourceRectTopLeftPx: target.videoTarget.cropRectTopLeftPx
        ?? target.videoTarget.windowBoundsTopLeftPx,
    },
    ...compositeWindows.map((window) => ({
      windowId: window.windowId,
      sourceRectTopLeftPx: window.cropRectTopLeftPx ?? window.windowBoundsTopLeftPx,
    })),
  ];
  const windows = candidates.filter((window, index) => (
    candidates.findIndex((candidate) => candidate.windowId === window.windowId) === index
  ));
  if (windows.length <= 1) {
    return null;
  }
  const totalWidth = windows.reduce(
    (sum, window) => sum + Math.max(1, window.sourceRectTopLeftPx.width),
    0,
  );
  const maxHeight = windows.reduce(
    (maximum, window) => Math.max(maximum, Math.max(1, window.sourceRectTopLeftPx.height)),
    1,
  );
  const scale = Math.min(
    1,
    REMOTE_WINDOW_CANVAS_WIDTH / totalWidth,
    REMOTE_WINDOW_CANVAS_HEIGHT / maxHeight,
  );
  let offsetX = 0;
  return {
    version: 1,
    layoutGeneration,
    canvasSize: {
      width: REMOTE_WINDOW_CANVAS_WIDTH,
      height: REMOTE_WINDOW_CANVAS_HEIGHT,
    },
    focusTargetId: target.streamTargetId,
    windows: windows.map((window, index) => {
      const width = Math.max(1, Math.round(window.sourceRectTopLeftPx.width * scale));
      const height = Math.max(1, Math.round(window.sourceRectTopLeftPx.height * scale));
      const result = {
        windowId: window.windowId,
        sourceRectTopLeftPx: { ...window.sourceRectTopLeftPx },
        canvasRectPx: {
          x: offsetX,
          y: 0,
          width,
          height,
        },
        zIndex: index,
      };
      offsetX += width;
      return result;
    }),
  };
}
