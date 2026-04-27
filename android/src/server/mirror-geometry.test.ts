import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_SESSION_VIEWPORT, resolveAttachGeometry, resolveMirrorSubscriberGeometry } from './mirror-geometry';

describe('resolveAttachGeometry', () => {
  it('only lets client request narrow the upstream width and never overwrite tmux rows', () => {
    expect(resolveAttachGeometry({
      requestedGeometry: { cols: 120, rows: 36 },
      currentMirrorGeometry: { cols: 132, rows: 40 },
      existingTmuxGeometry: { cols: 140, rows: 44 },
      previousSessionGeometry: { cols: 80, rows: 24 },
    })).toEqual({ cols: 120, rows: 40 });
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

describe('resolveMirrorSubscriberGeometry', () => {
  it('keeps baseline rows even when adaptive-phone subscribers request narrower widths', () => {
    expect(resolveMirrorSubscriberGeometry({
      baselineGeometry: { cols: 140, rows: 44 },
      subscribers: [
        { widthMode: 'adaptive-phone', requestedCols: 96 },
      ],
    })).toEqual({ cols: 96, rows: 44 });
  });

  it('ignores mirror-fixed subscribers for upstream width writes', () => {
    expect(resolveMirrorSubscriberGeometry({
      baselineGeometry: { cols: 140, rows: 44 },
      subscribers: [
        { widthMode: 'mirror-fixed', requestedCols: 80 },
      ],
    })).toEqual({ cols: 140, rows: 44 });
  });

  it('uses the narrowest adaptive-phone width when multiple active subscribers exist', () => {
    expect(resolveMirrorSubscriberGeometry({
      baselineGeometry: { cols: 140, rows: 44 },
      subscribers: [
        { widthMode: 'adaptive-phone', requestedCols: 110 },
        { widthMode: 'adaptive-phone', requestedCols: 92 },
        { widthMode: 'mirror-fixed', requestedCols: 60 },
      ],
    })).toEqual({ cols: 92, rows: 44 });
  });
});
