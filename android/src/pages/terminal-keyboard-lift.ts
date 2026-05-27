import { resolveTerminalViewportMetrics } from "../lib/terminal-viewport-metrics";

export function resolveLayoutViewportHeight() {
  return resolveTerminalViewportMetrics().layoutHeight;
}

export function resolveTerminalHeaderTopInsetPx(isAndroid: boolean) {
  if (typeof window === "undefined") {
    return isAndroid ? 16 : 0;
  }

  if (!isAndroid) {
    return Math.max(0, Math.round(window.visualViewport?.offsetTop || 0));
  }

  return 16;
}

export function resolveWindowWidth() {
  return resolveTerminalViewportMetrics().layoutWidth;
}

export function resolveKeyboardLiftPx(
  reportedKeyboardInset: number,
  layoutViewportHeightOverride?: number,
) {
  const safeReportedInset = Math.max(0, Math.round(reportedKeyboardInset || 0));
  if (safeReportedInset <= 0 || typeof window === "undefined") {
    return 0;
  }

  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return safeReportedInset;
  }

  const visualViewportHeight = Math.max(0, Math.round(visualViewport.height || 0));
  const visualViewportOffsetTop = Math.max(0, Math.round(visualViewport.offsetTop || 0));
  const visualViewportBottom = Math.max(0, visualViewportHeight + visualViewportOffsetTop);
  const resolvedLayoutViewportHeight = Math.max(
    0,
    Math.round(layoutViewportHeightOverride ?? resolveLayoutViewportHeight()),
  );
  const layoutViewportHeight =
    layoutViewportHeightOverride == null
      ? Math.max(
          resolvedLayoutViewportHeight,
          Math.max(0, Math.round(window.innerHeight || 0)),
        )
      : resolvedLayoutViewportHeight;
  const occludedBottom = Math.max(0, layoutViewportHeight - visualViewportBottom);

  if (occludedBottom <= 0) {
    return safeReportedInset;
  }

  return Math.min(safeReportedInset, occludedBottom);
}
