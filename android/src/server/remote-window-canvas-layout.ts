import type {
  RemoteWindowCanvasLayoutV1,
  RemoteWindowStreamTargetManifest,
} from '@zterm/shared/protocol';

const REMOTE_WINDOW_CANVAS_WIDTH = 1920;
const REMOTE_WINDOW_CANVAS_HEIGHT = 1080;
const REMOTE_WINDOW_SIBLING_RAIL_HEIGHT = Math.round(REMOTE_WINDOW_CANVAS_HEIGHT * 0.3);
const REMOTE_WINDOW_MAX_SIBLINGS = 3;

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
    ...compositeWindows.slice(0, REMOTE_WINDOW_MAX_SIBLINGS).map((window) => ({
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
  const siblings = windows.slice(1);
  const siblingSlotWidth = Math.floor(REMOTE_WINDOW_CANVAS_WIDTH / siblings.length);
  const projectedWindows = windows.map((window, index) => {
    const source = window.sourceRectTopLeftPx;
    if (index === 0) {
      const scale = Math.min(
        REMOTE_WINDOW_CANVAS_WIDTH / Math.max(1, source.width),
        (REMOTE_WINDOW_CANVAS_HEIGHT - REMOTE_WINDOW_SIBLING_RAIL_HEIGHT) / Math.max(1, source.height),
      );
      const width = Math.max(1, Math.round(source.width * scale));
      const height = Math.max(1, Math.round(source.height * scale));
      return {
        windowId: window.windowId,
        sourceRectTopLeftPx: { ...source },
        canvasRectPx: {
          x: Math.round((REMOTE_WINDOW_CANVAS_WIDTH - width) / 2),
          y: REMOTE_WINDOW_SIBLING_RAIL_HEIGHT + Math.round(
            (REMOTE_WINDOW_CANVAS_HEIGHT - REMOTE_WINDOW_SIBLING_RAIL_HEIGHT - height) / 2,
          ),
          width,
          height,
        },
        zIndex: windows.length,
      };
    }
    const siblingIndex = index - 1;
    const scale = Math.min(
      siblingSlotWidth / Math.max(1, source.width),
      REMOTE_WINDOW_SIBLING_RAIL_HEIGHT / Math.max(1, source.height),
    );
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    return {
      windowId: window.windowId,
      sourceRectTopLeftPx: { ...source },
      canvasRectPx: {
        x: siblingIndex * siblingSlotWidth + Math.round((siblingSlotWidth - width) / 2),
        y: Math.round((REMOTE_WINDOW_SIBLING_RAIL_HEIGHT - height) / 2),
        width,
        height,
      },
      zIndex: siblingIndex,
    };
  });
  return {
    version: 1,
    layoutGeneration,
    canvasSize: {
      width: REMOTE_WINDOW_CANVAS_WIDTH,
      height: REMOTE_WINDOW_CANVAS_HEIGHT,
    },
    focusTargetId: target.streamTargetId,
    windows: projectedWindows,
  };
}
