import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_SESSION_VIEWPORT, resolveAttachViewport } from './mirror-geometry';

describe('resolveAttachViewport', () => {
  it('prefers the explicit client-requested viewport when present', () => {
    expect(resolveAttachViewport({
      requestedViewport: { cols: 120, rows: 36 },
      currentMirrorViewport: { cols: 132, rows: 40 },
      existingTmuxViewport: { cols: 140, rows: 44 },
      previousSessionViewport: { cols: 80, rows: 24 },
    })).toEqual({ cols: 120, rows: 36 });
  });

  it('reuses the current connected mirror geometry when the client omits viewport rows/cols', () => {
    expect(resolveAttachViewport({
      requestedViewport: null,
      currentMirrorViewport: { cols: 132, rows: 40 },
      existingTmuxViewport: { cols: 140, rows: 44 },
      previousSessionViewport: { cols: 80, rows: 24 },
    })).toEqual({ cols: 132, rows: 40 });
  });

  it('reuses existing tmux geometry before first mirror attach when the client omits viewport rows/cols', () => {
    expect(resolveAttachViewport({
      requestedViewport: null,
      currentMirrorViewport: null,
      existingTmuxViewport: { cols: 140, rows: 44 },
      previousSessionViewport: { cols: 80, rows: 24 },
    })).toEqual({ cols: 140, rows: 44 });
  });

  it('falls back to the previous session/default viewport only when no upstream geometry truth exists', () => {
    expect(resolveAttachViewport({
      requestedViewport: null,
      currentMirrorViewport: null,
      existingTmuxViewport: null,
      previousSessionViewport: DEFAULT_TERMINAL_SESSION_VIEWPORT,
    })).toEqual(DEFAULT_TERMINAL_SESSION_VIEWPORT);
  });
});
