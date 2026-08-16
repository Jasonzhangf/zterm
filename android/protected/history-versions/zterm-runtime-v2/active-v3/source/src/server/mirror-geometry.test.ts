import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_SESSION_VIEWPORT, resolveAttachGeometry } from './mirror-geometry';

describe('resolveAttachGeometry', () => {
  it('uses requested adaptive width and never overwrites tmux rows', () => {
    expect(resolveAttachGeometry({
      requestedGeometry: { cols: 120, rows: 36 },
      currentMirrorGeometry: { cols: 132, rows: 40 },
      existingTmuxGeometry: { cols: 140, rows: 44 },
      previousSessionGeometry: { cols: 80, rows: 24 },
    })).toEqual({ cols: 120, rows: 40 });
  });

  it('allows requested adaptive width to widen beyond the current baseline', () => {
    expect(resolveAttachGeometry({
      requestedGeometry: { cols: 200, rows: 12 },
      currentMirrorGeometry: { cols: 132, rows: 40 },
      existingTmuxGeometry: { cols: 140, rows: 44 },
      previousSessionGeometry: { cols: 80, rows: 24 },
    })).toEqual({ cols: 200, rows: 40 });
  });

  it('reuses the current connected mirror geometry when the client omits rows/cols', () => {
    expect(resolveAttachGeometry({
      requestedGeometry: null,
      currentMirrorGeometry: { cols: 132, rows: 40 },
      existingTmuxGeometry: { cols: 140, rows: 44 },
      previousSessionGeometry: { cols: 80, rows: 24 },
    })).toEqual({ cols: 132, rows: 40 });
  });

  it('reuses existing tmux geometry before first mirror attach when the client omits rows/cols', () => {
    expect(resolveAttachGeometry({
      requestedGeometry: null,
      currentMirrorGeometry: null,
      existingTmuxGeometry: { cols: 140, rows: 44 },
      previousSessionGeometry: { cols: 80, rows: 24 },
    })).toEqual({ cols: 140, rows: 44 });
  });

  it('falls back to the previous session/default geometry only when no upstream geometry truth exists', () => {
    expect(resolveAttachGeometry({
      requestedGeometry: null,
      currentMirrorGeometry: null,
      existingTmuxGeometry: null,
      previousSessionGeometry: DEFAULT_TERMINAL_SESSION_VIEWPORT,
    })).toEqual(DEFAULT_TERMINAL_SESSION_VIEWPORT);
  });
});
