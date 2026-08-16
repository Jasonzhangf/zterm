import { describe, expect, it, vi } from 'vitest';
import { createSessionRenderBufferStore } from './session-render-buffer-store';
import type { SessionRenderBufferSnapshot, TerminalCell } from './types';

function makeCell(char: string): TerminalCell {
  return {
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  };
}

function makeSnapshot(lines: TerminalCell[][], revision: number): SessionRenderBufferSnapshot {
  return {
    lines,
    gapRanges: [],
    startIndex: 0,
    endIndex: lines.length,
    bufferHeadStartIndex: 0,
    bufferTailEndIndex: lines.length,
    daemonHeadRevision: revision,
    daemonHeadEndIndex: lines.length,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    cursor: null,
    revision,
  };
}

describe('session-render-buffer-store', () => {
  it('does not publish again when render-gate reuses the exact same snapshot object', () => {
    const store = createSessionRenderBufferStore();
    const snapshot = makeSnapshot([[makeCell('a')]], 1);

    expect(store.setBuffer('s1', snapshot)).toBe(true);
    expect(store.setBuffer('s1', snapshot)).toBe(false);
    expect(store.getSnapshot('s1').revision).toBe(1);
  });

  it('treats render-gate snapshots as authoritative and does not deep-compare every cell on publish', () => {
    const store = createSessionRenderBufferStore();
    const first = makeSnapshot([[makeCell('a')], [makeCell('b')]], 1);
    expect(store.setBuffer('s1', first)).toBe(true);

    let charReads = 0;
    const expensiveCell = {} as TerminalCell;
    Object.defineProperties(expensiveCell, {
      char: {
        get() {
          charReads += 1;
          return 'c'.codePointAt(0) || 32;
        },
      },
      fg: { value: 256, enumerable: true },
      bg: { value: 256, enumerable: true },
      flags: { value: 0, enumerable: true },
      width: { value: 1, enumerable: true },
    });

    const second = makeSnapshot([[makeCell('a')], [expensiveCell]], 2);
    expect(store.setBuffer('s1', second)).toBe(true);
    expect(charReads).toBe(0);
    expect(store.getSnapshot('s1').buffer).not.toBe(second);
  });

  it('reuses unchanged source rows by reference without reading their cells again', () => {
    const store = createSessionRenderBufferStore();
    let charReads = 0;
    const expensiveCell = {} as TerminalCell;
    Object.defineProperties(expensiveCell, {
      char: {
        get() {
          charReads += 1;
          return 'b'.codePointAt(0) || 32;
        },
        enumerable: true,
      },
      fg: { value: 256, enumerable: true },
      bg: { value: 256, enumerable: true },
      flags: { value: 0, enumerable: true },
      width: { value: 1, enumerable: true },
    });

    const unchangedRow = [expensiveCell];
    const first = makeSnapshot([[makeCell('a')], unchangedRow], 1);
    expect(store.setBuffer('s1', first)).toBe(true);

    charReads = 0;
    const second = makeSnapshot([[makeCell('c')], unchangedRow], 2);
    expect(store.setBuffer('s1', second)).toBe(true);
    expect(charReads).toBe(0);
    expect(store.getSnapshot('s1').buffer.lines[1]).not.toBe(second.lines[1]);
  });

  it('keeps an immutable render snapshot after publish even if the source snapshot mutates later', () => {
    const store = createSessionRenderBufferStore();
    const snapshot = makeSnapshot([[makeCell('a')], [makeCell('b')]], 1);

    expect(store.setBuffer('s1', snapshot)).toBe(true);

    snapshot.lines[0]![0]!.char = 'z'.codePointAt(0) || 32;
    snapshot.gapRanges.push({ startIndex: 1, endIndex: 2 });
    snapshot.cursor = { rowIndex: 3, col: 4, visible: true };

    const stored = store.getSnapshot('s1').buffer;
    expect(String.fromCodePoint(stored.lines[0]![0]!.char)).toBe('a');
    expect(stored.gapRanges).toHaveLength(0);
    expect(stored.cursor).toBeNull();
  });

  it('accepts an explicitly immutable projection without cloning it again', () => {
    const store = createSessionRenderBufferStore();
    const snapshot = makeSnapshot([[makeCell('a')]], 1);

    expect(store.setBuffer('s1', snapshot, { immutableProjection: true })).toBe(true);
    // This is the deterministic negative guard for the production path: if the
    // immutable projection ever deep-clones rows, this assertion fails.
    expect(store.getSnapshot('s1').buffer.lines).toBe(snapshot.lines);
    expect(store.getSnapshot('s1').buffer.lines[0]).toBe(snapshot.lines[0]);
  });

  it('never aliases live source rows after an immutable publish switches to a non-immutable publish', () => {
    const store = createSessionRenderBufferStore();
    const sourceRow = [makeCell('a')];
    const first = makeSnapshot([sourceRow], 1);
    first.gapRanges = [{ startIndex: 1, endIndex: 2 }];
    first.cursor = { rowIndex: 4, col: 5, visible: true };

    expect(store.setBuffer('s1', first, { immutableProjection: true })).toBe(true);
    expect(store.getSnapshot('s1').buffer.lines[0]).toBe(sourceRow);

    sourceRow[0]!.char = 'z'.codePointAt(0) || 32;
    const second = makeSnapshot([sourceRow], 2);
    second.gapRanges = first.gapRanges;
    second.cursor = first.cursor;
    expect(store.setBuffer('s1', second)).toBe(true);

    const stored = store.getSnapshot('s1').buffer;
    expect(stored.lines[0]).not.toBe(sourceRow);
    expect(String.fromCodePoint(stored.lines[0]![0]!.char)).toBe('z');
    expect(stored.gapRanges).not.toBe(first.gapRanges);
    expect(stored.cursor).not.toBe(first.cursor);

    sourceRow[0]!.char = 'q'.codePointAt(0) || 32;
    first.gapRanges[0]!.startIndex = 9;
    first.cursor.rowIndex = 8;
    expect(String.fromCodePoint(stored.lines[0]![0]!.char)).toBe('z');
    expect(stored.gapRanges[0]!.startIndex).toBe(1);
    expect(stored.cursor?.rowIndex).toBe(4);
  });

  it('rejects a lower-revision render snapshot instead of publishing older rows over newer rows', () => {
    const runtimeDebug = vi.fn();
    const store = createSessionRenderBufferStore({ runtimeDebug });
    const newer = makeSnapshot([[makeCell('n')]], 12);
    const older = makeSnapshot([[makeCell('o')]], 11);

    expect(store.setBuffer('s1', newer)).toBe(true);
    expect(store.setBuffer('s1', older)).toBe(false);

    const stored = store.getSnapshot('s1');
    expect(stored.buffer.revision).toBe(12);
    expect(String.fromCodePoint(stored.buffer.lines[0]![0]!.char)).toBe('n');
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.render-store.revision-regression-drop',
      expect.objectContaining({
        sessionId: 's1',
        previousRevision: 12,
        incomingRevision: 11,
      }),
    );
  });

  it('publishes an explicitly authorized lower-revision reset without dropping subscribers', () => {
    const store = createSessionRenderBufferStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe('s1', listener);

    expect(store.setBuffer('s1', makeSnapshot([[makeCell('n')]], 12))).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(
      store.setBuffer('s1', makeSnapshot([[makeCell('r')]], 3), {
        allowRevisionRegression: true,
      }),
    ).toBe(true);

    const stored = store.getSnapshot('s1');
    expect(stored.buffer.revision).toBe(3);
    expect(String.fromCodePoint(stored.buffer.lines[0]![0]!.char)).toBe('r');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('allows a lower render revision only after explicit session deletion resets render truth', () => {
    const store = createSessionRenderBufferStore();

    expect(store.setBuffer('s1', makeSnapshot([[makeCell('n')]], 12))).toBe(true);
    store.deleteSession('s1');
    expect(store.setBuffer('s1', makeSnapshot([[makeCell('r')]], 1))).toBe(true);

    const stored = store.getSnapshot('s1');
    expect(stored.buffer.revision).toBe(1);
    expect(String.fromCodePoint(stored.buffer.lines[0]![0]!.char)).toBe('r');
  });
});

describe('session-render-buffer-store perf', () => {
  it('production immutable render publish cost stays bounded for a realistic 1000x80 buffer', () => {
    const store = createSessionRenderBufferStore();
    const cols = 80;
    const rows = 1000;
    const lines: TerminalCell[][] = Array.from({ length: rows }, (_, row) =>
      Array.from({ length: cols }, (_, col) => ({
        char: ((row * cols + col) % 95) + 32,
        fg: 256,
        bg: 256,
        flags: 0,
        width: 1,
      })),
    );
    const snapshot = makeSnapshot(lines, 1);

    // Warm up before measuring so JIT and lazy paths do not turn a stable
    // publish into a cold-start flake under a loaded dev machine. This is the
    // exact render-gate projection mode used on every daemon push.
    store.setBuffer('s1', snapshot, { immutableProjection: true });
    const warmupIterations = 20;
    for (let i = 0; i < warmupIterations; i += 1) {
      snapshot.lines[0] = snapshot.lines[0]!.map((cell, col) => (
        col === 0
          ? {
              ...cell,
              char: (((cell.char || 32) + 1) % 95) + 32,
            }
          : cell
      ));
      snapshot.revision = i + 2;
      store.setBuffer('s1', snapshot, { immutableProjection: true });
    }

    const iterations = 50;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      snapshot.lines[0] = snapshot.lines[0]!.map((cell, col) => (
        col === 0
          ? {
              ...cell,
              char: (((cell.char || 32) + 1) % 95) + 32,
            }
          : cell
      ));
      snapshot.revision = i + warmupIterations + 2;
      store.setBuffer('s1', snapshot, { immutableProjection: true });
    }
    const elapsed = performance.now() - start;
    const perPublish = elapsed / iterations;
    // CI baseline observed: well under 1ms per immutable projection publish
    // (M-series dev box, Node 26, vitest 1.6). Hard guard at 16ms (one 60Hz
    // frame): a single publish must NOT eat a full frame because this runs on
    // every daemon push and would compound across many sessions.
    // Real-device numbers should be measured via a true device Profiler run.
    expect(perPublish).toBeLessThan(16);
  });
});
