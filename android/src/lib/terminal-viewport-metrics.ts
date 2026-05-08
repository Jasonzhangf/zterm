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
  const layoutHeight = Math.max(
    0,
    Math.round(
      Math.max(
        window.innerHeight || 0,
        window.document?.documentElement?.clientHeight || 0,
        visualBottom,
      ),
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
    orientation: layoutWidth > layoutHeight ? 'landscape' : 'portrait',
  };
}

export function resolveTerminalOrientation() {
  return resolveTerminalViewportMetrics().orientation;
}
