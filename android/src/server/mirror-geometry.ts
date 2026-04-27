export const DEFAULT_TERMINAL_SESSION_VIEWPORT = {
  cols: 80,
  rows: 24,
} as const;

type Viewport = {
  cols: number;
  rows: number;
};

function normalizeViewport(viewport: Viewport | null | undefined): Viewport | null {
  if (!viewport) {
    return null;
  }
  if (!Number.isFinite(viewport.cols) || !Number.isFinite(viewport.rows)) {
    return null;
  }
  const cols = Math.max(1, Math.floor(viewport.cols));
  const rows = Math.max(1, Math.floor(viewport.rows));
  return { cols, rows };
}

export function resolveAttachViewport(input: {
  requestedViewport?: Viewport | null;
  currentMirrorViewport?: Viewport | null;
  existingTmuxViewport?: Viewport | null;
  previousSessionViewport?: Viewport | null;
}) {
  return (
    normalizeViewport(input.requestedViewport)
    || normalizeViewport(input.currentMirrorViewport)
    || normalizeViewport(input.existingTmuxViewport)
    || normalizeViewport(input.previousSessionViewport)
    || { ...DEFAULT_TERMINAL_SESSION_VIEWPORT }
  );
}
