import type { TerminalWidthMode } from '../lib/types';

export const DEFAULT_TERMINAL_SESSION_VIEWPORT = {
  cols: 80,
  rows: 24,
} as const;

type TerminalGeometry = {
  cols: number;
  rows: number;
};

function normalizeGeometry(geometry: TerminalGeometry | null | undefined): TerminalGeometry | null {
  if (!geometry) {
    return null;
  }
  if (!Number.isFinite(geometry.cols) || !Number.isFinite(geometry.rows)) {
    return null;
  }
  const cols = Math.max(1, Math.floor(geometry.cols));
  const rows = Math.max(1, Math.floor(geometry.rows));
  return { cols, rows };
}

export function resolveAttachGeometry(input: {
  requestedGeometry?: TerminalGeometry | null;
  currentMirrorGeometry?: TerminalGeometry | null;
  existingTmuxGeometry?: TerminalGeometry | null;
  previousSessionGeometry?: TerminalGeometry | null;
}) {
  const baseline =
    normalizeGeometry(input.currentMirrorGeometry)
    || normalizeGeometry(input.existingTmuxGeometry)
    || normalizeGeometry(input.previousSessionGeometry)
    || { ...DEFAULT_TERMINAL_SESSION_VIEWPORT };
  const requested = normalizeGeometry(input.requestedGeometry);
  return {
    cols: requested?.cols ?? baseline.cols,
    rows: baseline.rows,
  };
}

export function resolveMirrorSubscriberGeometry(input: {
  baselineGeometry: TerminalGeometry;
  subscribers: Array<{
    widthMode: TerminalWidthMode;
    requestedCols?: number | null;
  }>;
}) {
  const baseline = normalizeGeometry(input.baselineGeometry) || { ...DEFAULT_TERMINAL_SESSION_VIEWPORT };
  let minAdaptiveCols = Number.POSITIVE_INFINITY;

  for (const subscriber of input.subscribers) {
    if (subscriber.widthMode !== 'adaptive-phone') {
      continue;
    }
    const requestedCols =
      typeof subscriber.requestedCols === 'number' && Number.isFinite(subscriber.requestedCols)
        ? Math.max(1, Math.floor(subscriber.requestedCols))
        : 0;
    if (requestedCols > 0) {
      minAdaptiveCols = Math.min(minAdaptiveCols, requestedCols);
    }
  }

  return {
    cols: Number.isFinite(minAdaptiveCols) ? minAdaptiveCols : baseline.cols,
    rows: baseline.rows,
  };
}
