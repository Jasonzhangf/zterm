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

  const layoutViewportWidth = Math.max(
    0,
    Math.round(
      Math.max(window.innerWidth || 0, window.document?.documentElement?.clientWidth || 0),
    ),
  );
  const keyboardLiftCapRatio = layoutViewportWidth > layoutViewportHeight ? 0.5 : 0.6;
  const keyboardLiftCapPx = Math.max(0, Math.round(layoutViewportHeight * keyboardLiftCapRatio));
  const safeCappedInset = keyboardLiftCapPx > 0
    ? Math.min(safeReportedInset, keyboardLiftCapPx)
    : safeReportedInset;

  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return safeCappedInset;
  }

  const visualViewportHeight = Math.max(0, Math.round(visualViewport.height || 0));
  const visualViewportOffsetTop = Math.max(0, Math.round(visualViewport.offsetTop || 0));
  const visualViewportBottom = Math.max(0, visualViewportHeight + visualViewportOffsetTop);
  const currentLayoutViewportHeight = Math.max(
    0,
    Math.round(
      Math.max(window.innerHeight || 0, window.document?.documentElement?.clientHeight || 0),
    ),
  );

  // Resize-mode truth: on some Android devices the WebView already shrinks the
  // whole layout viewport above the IME (adjustResize-like behavior). In this
  // mode, applying an extra lift causes double-count over-lift for quickbar.
  const viewportAlreadyResizedByIme =
    currentLayoutViewportHeight > 0
    && Math.abs(layoutViewportHeight - currentLayoutViewportHeight) <= 2
    && Math.abs(currentLayoutViewportHeight - visualViewportBottom) <= 2
    && safeCappedInset >= 24;
  if (viewportAlreadyResizedByIme) {
    return 0;
  }
  const occludedBottom = Math.max(0, layoutViewportHeight - visualViewportBottom);

  if (occludedBottom <= 0) {
    return safeCappedInset;
  }

  return Math.min(safeCappedInset, occludedBottom);
}
