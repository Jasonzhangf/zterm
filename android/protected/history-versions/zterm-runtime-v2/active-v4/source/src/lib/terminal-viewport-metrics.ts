export interface TerminalViewportMetrics {
  layoutWidth: number;
  layoutHeight: number;
  visualWidth: number;
  visualHeight: number;
  visualOffsetTop: number;
  visualOffsetLeft: number;
  visualBottom: number;
  orientation: 'portrait' | 'landscape';
}

const maxStableLayoutHeightByOrientation: Record<TerminalViewportMetrics['orientation'], number> = {
  portrait: 0,
  landscape: 0,
};

export function resolveTerminalViewportMetrics(): TerminalViewportMetrics {
  if (typeof window === 'undefined') {
    return {
      layoutWidth: 0,
      layoutHeight: 0,
      visualWidth: 0,
      visualHeight: 0,
      visualOffsetTop: 0,
      visualOffsetLeft: 0,
      visualBottom: 0,
      orientation: 'portrait',
    };
  }

  const visualViewport = window.visualViewport;
  const visualWidth = Math.max(0, Math.round(visualViewport?.width || 0));
  const visualHeight = Math.max(0, Math.round(visualViewport?.height || 0));
  const visualOffsetTop = Math.max(0, Math.round(visualViewport?.offsetTop || 0));
  const visualOffsetLeft = Math.max(0, Math.round(visualViewport?.offsetLeft || 0));
  const visualBottom = Math.max(0, visualHeight + visualOffsetTop);
  const layoutWidth = Math.max(
    0,
    Math.round(
      Math.max(
        window.innerWidth || 0,
        window.document?.documentElement?.clientWidth || 0,
        visualWidth + visualOffsetLeft,
      ),
    ),
  );
  const currentClientHeight = Math.max(
    0,
    Math.round(window.document?.documentElement?.clientHeight || 0),
  );
  const orientationHeight = Math.max(
    0,
    Math.round(
      Math.max(currentClientHeight, visualBottom),
    ),
  );
  const orientation: TerminalViewportMetrics['orientation'] = layoutWidth > orientationHeight ? 'landscape' : 'portrait';
  if (currentClientHeight > maxStableLayoutHeightByOrientation[orientation]) {
    maxStableLayoutHeightByOrientation[orientation] = currentClientHeight;
  }
  // Keyboard popup truth:
  // - Android WebView may shrink both innerHeight/clientHeight during IME popup.
  // - We keep a monotonic stable layout height (max seen clientHeight).
  // - layoutHeight should stay on stable full-height truth while keyboard is visible.
  const layoutHeight = Math.max(
    0,
    Math.round(
      Math.max(currentClientHeight, maxStableLayoutHeightByOrientation[orientation], visualBottom),
    ),
  );

  return {
    layoutWidth,
    layoutHeight,
    visualWidth,
    visualHeight,
    visualOffsetTop,
    visualOffsetLeft,
    visualBottom,
    orientation,
  };
}

export function resolveTerminalOrientation() {
  return resolveTerminalViewportMetrics().orientation;
}
