import type {
  RemoteWindowCanvasLayoutV1,
  RemoteWindowStreamRect,
} from '@zterm/shared/protocol';

export interface RemoteWindowLayoutPlannerEntry {
  windowId: string;
  sourceRectTopLeftPx: RemoteWindowStreamRect;
}

export interface RemoteWindowLayoutPlannerOptions {
  focusTargetId: string;
  entries: RemoteWindowLayoutPlannerEntry[];
  layoutGeneration: number;
  canvasWidth?: number;
  canvasHeight?: number;
  orientation?: 'portrait' | 'landscape';
  maxRailWindows?: number;
}

const DEFAULT_CANVAS_WIDTH = 1920;
const DEFAULT_CANVAS_HEIGHT = 1080;
const RAIL_FRACTION = 0.3;
const DEFAULT_MAX_RAIL = 3;

function fitRect(
  source: RemoteWindowStreamRect,
  bounds: { x: number; y: number; width: number; height: number },
): RemoteWindowStreamRect {
  const sourceW = Math.max(1, source.width);
  const sourceH = Math.max(1, source.height);
  const scale = Math.min(bounds.width / sourceW, bounds.height / sourceH);
  const width = Math.max(1, Math.round(sourceW * scale));
  const height = Math.max(1, Math.round(sourceH * scale));
  return {
    x: bounds.x + Math.round((bounds.width - width) / 2),
    y: bounds.y + Math.round((bounds.height - height) / 2),
    width,
    height,
  };
}

export function planRemoteWindowFocusPlusRailLayout(
  options: RemoteWindowLayoutPlannerOptions,
): RemoteWindowCanvasLayoutV1 {
  if (!Number.isSafeInteger(options.layoutGeneration) || options.layoutGeneration <= 0) {
    throw new Error('layout generation must be a positive safe integer');
  }

  const canvasW = options.canvasWidth ?? DEFAULT_CANVAS_WIDTH;
  const canvasH = options.canvasHeight ?? DEFAULT_CANVAS_HEIGHT;
  if (!Number.isSafeInteger(canvasW) || canvasW <= 0 || !Number.isSafeInteger(canvasH) || canvasH <= 0) {
    throw new Error('canvas dimensions must be positive safe integers');
  }

  const seen = new Set<string>();
  const unique = options.entries.filter((entry) => {
    if (!entry.windowId || seen.has(entry.windowId)) {
      return false;
    }
    seen.add(entry.windowId);
    return true;
  });
  if (unique.length === 0) {
    throw new Error('at least one window entry is required');
  }

  const focusEntry = unique.find((entry) => entry.windowId === options.focusTargetId)
    ?? unique[0];
  const siblings = unique.filter((entry) => entry.windowId !== focusEntry.windowId);
  const maxRail = options.maxRailWindows ?? DEFAULT_MAX_RAIL;
  const railEntries = siblings.slice(0, maxRail);
  const droppedCount = siblings.length - railEntries.length;
  const orientation = options.orientation ?? 'portrait';

  const isLandscape = orientation === 'landscape';
  const railSize = isLandscape
    ? { width: Math.round(canvasW * RAIL_FRACTION), height: canvasH }
    : { width: canvasW, height: Math.round(canvasH * RAIL_FRACTION) };
  const focusBounds = isLandscape
    ? {
        x: railSize.width,
        y: 0,
        width: canvasW - railSize.width,
        height: canvasH,
      }
    : {
        x: 0,
        y: railSize.height,
        width: canvasW,
        height: canvasH - railSize.height,
      };

  const windows: RemoteWindowCanvasLayoutV1['windows'] = [];
  let zIndex = 0;

  for (let i = 0; i < railEntries.length; i++) {
    const entry = railEntries[i];
    let cellBounds: { x: number; y: number; width: number; height: number };
    if (isLandscape) {
      const cellHeight = Math.floor(railSize.height / railEntries.length);
      cellBounds = {
        x: 0,
        y: i * cellHeight,
        width: railSize.width,
        height: i === railEntries.length - 1 ? railSize.height - i * cellHeight : cellHeight,
      };
    } else {
      const cellWidth = Math.floor(railSize.width / railEntries.length);
      cellBounds = {
        x: i * cellWidth,
        y: 0,
        width: i === railEntries.length - 1 ? railSize.width - i * cellWidth : cellWidth,
        height: railSize.height,
      };
    }
    windows.push({
      windowId: entry.windowId,
      sourceRectTopLeftPx: { ...entry.sourceRectTopLeftPx },
      canvasRectPx: fitRect(entry.sourceRectTopLeftPx, cellBounds),
      zIndex: zIndex++,
    });
  }

  windows.push({
    windowId: focusEntry.windowId,
    sourceRectTopLeftPx: { ...focusEntry.sourceRectTopLeftPx },
    canvasRectPx: fitRect(focusEntry.sourceRectTopLeftPx, focusBounds),
    zIndex: zIndex++,
  });

  void droppedCount;

  return {
    version: 1,
    layoutGeneration: options.layoutGeneration,
    canvasSize: { width: canvasW, height: canvasH },
    focusTargetId: focusEntry.windowId,
    windows,
  };
}
