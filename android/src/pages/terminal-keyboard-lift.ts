import { resolveTerminalViewportMetrics } from "../lib/terminal-viewport-metrics";

export function resolveLayoutViewportHeight() {
  return resolveTerminalViewportMetrics().layoutHeight;
}

export function resolveCurrentLayoutViewportHeight() {
  if (typeof window === "undefined") {
    return 0;
  }
  const visualViewport = window.visualViewport;
  const visualViewportBottom = Math.max(
    0,
    Math.round((visualViewport?.height || 0) + (visualViewport?.offsetTop || 0)),
  );
  return Math.max(
    0,
    Math.round(
      Math.max(
        window.innerHeight || 0,
        window.document?.documentElement?.clientHeight || 0,
        visualViewportBottom,
      ),
    ),
  );
}

export function isKeyboardViewportAlreadyResized(
  reportedKeyboardInset: number,
  stableLayoutViewportHeightOverride?: number,
) {
  const safeReportedInset = Math.max(0, Math.round(reportedKeyboardInset || 0));
  if (safeReportedInset <= 0 || typeof window === "undefined") {
    return false;
  }

  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return false;
  }

  const stableLayoutViewportHeight = Math.max(
    0,
    Math.round(stableLayoutViewportHeightOverride ?? resolveLayoutViewportHeight()),
  );
  const currentLayoutViewportHeight = resolveCurrentLayoutViewportHeight();
  const visualViewportBottom = Math.max(
    0,
    Math.round((visualViewport.height || 0) + (visualViewport.offsetTop || 0)),
  );

  if (currentLayoutViewportHeight <= 0 || visualViewportBottom <= 0) {
    return false;
  }

  const viewportMatchesCurrentLayout =
    Math.abs(currentLayoutViewportHeight - visualViewportBottom) <= 2;
  if (!viewportMatchesCurrentLayout) {
    return false;
  }

  const stableShowsResize =
    stableLayoutViewportHeight > currentLayoutViewportHeight + 24;

  return stableShowsResize;
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

function normalizeReportedKeyboardInsetCssPx(
  reportedKeyboardInset: number,
  layoutViewportHeight: number,
) {
  const safeReportedInset = Math.max(0, Math.round(reportedKeyboardInset || 0));
  if (safeReportedInset <= 0 || typeof window === "undefined") {
    return safeReportedInset;
  }

  const devicePixelRatio = Math.max(1, Number(window.devicePixelRatio || 1));
  if (devicePixelRatio <= 1 || layoutViewportHeight <= 0) {
    return safeReportedInset;
  }

  const cssInset = Math.max(0, Math.round(safeReportedInset / devicePixelRatio));
  if (cssInset <= 0) {
    return safeReportedInset;
  }

  const reportedRatio = safeReportedInset / layoutViewportHeight;
  const cssRatio = cssInset / layoutViewportHeight;
  const looksLikePhysicalPixels = reportedRatio > 0.55 && cssRatio >= 0.18 && cssRatio <= 0.55;
  return looksLikePhysicalPixels ? cssInset : safeReportedInset;
}

export function resolveKeyboardLiftPx(
  reportedKeyboardInset: number,
  layoutViewportHeightOverride?: number,
) {
  const safeReportedInset = Math.max(0, Math.round(reportedKeyboardInset || 0));
  if (safeReportedInset <= 0 || typeof window === "undefined") {
    return 0;
  }

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
  const normalizedReportedInset = normalizeReportedKeyboardInsetCssPx(
    safeReportedInset,
    layoutViewportHeight,
  );

  const layoutViewportWidth = Math.max(
    0,
    Math.round(
      Math.max(window.innerWidth || 0, window.document?.documentElement?.clientWidth || 0),
    ),
  );
  const keyboardLiftCapRatio = layoutViewportWidth > layoutViewportHeight ? 0.38 : 0.45;
  const keyboardLiftCapPx = Math.max(0, Math.round(layoutViewportHeight * keyboardLiftCapRatio));
  const safeCappedInset = keyboardLiftCapPx > 0
    ? Math.min(normalizedReportedInset, keyboardLiftCapPx)
    : normalizedReportedInset;

  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return safeCappedInset;
  }

  const visualViewportHeight = Math.max(0, Math.round(visualViewport.height || 0));
  const visualViewportOffsetTop = Math.max(0, Math.round(visualViewport.offsetTop || 0));
  const visualViewportBottom = Math.max(0, visualViewportHeight + visualViewportOffsetTop);

  // Resize-mode truth: on some Android devices the WebView already shrinks the
  // whole layout viewport above the IME (adjustResize-like behavior). In this
  // mode, applying an extra lift causes double-count over-lift for quickbar.
  if (isKeyboardViewportAlreadyResized(safeCappedInset, layoutViewportHeight)) {
    return 0;
  }
  const occludedBottom = Math.max(0, layoutViewportHeight - visualViewportBottom);

  if (occludedBottom <= 0) {
    return safeCappedInset;
  }

  return Math.min(safeCappedInset, occludedBottom);
}
