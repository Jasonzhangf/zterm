import { describe, expect, it } from 'vitest';
import type { TerminalCell } from '../../shared/src/connection/types.js';
import {
  createRendererWindow,
  type AbsoluteBufferSnapshot,
  type RendererSnapshot,
} from './renderer-window.js';

function cell(char: string, overrides: Partial<TerminalCell> = {}): TerminalCell {
  return {
    char: char.codePointAt(0) || 0x20,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
    ...overrides,
  };
}

function row(text: string): TerminalCell[] {
  return [...text].map((value) => cell(value));
}

function buffer(options: {
  endIndex: number;
  cols?: number;
  rows?: number;
  revision?: number;
  lines?: Array<[number, TerminalCell[]]>;
}): AbsoluteBufferSnapshot {
  return {
    revision: options.revision ?? 1,
    startIndex: 0,
    endIndex: options.endIndex,
    latestEndIndex: options.endIndex,
    availableStartIndex: 0,
    availableEndIndex: options.endIndex,
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    lines: new Map(options.lines ?? []),
    cursor: null,
  };
}

function rowText(snapshot: RendererSnapshot, screenRow: number) {
  return snapshot.rows[screenRow]?.cells.map((value) => String.fromCodePoint(value.char)).join('') || '';
}

describe('renderer-window public contract', () => {
  it('uses metadata for absolute demand without committing body and preserves reading anchors', () => {
    const renderer = createRendererWindow({ visibleRows: 24 });
    expect(renderer.setHead({ latestEndIndex: 124, availableStartIndex: 100, availableEndIndex: 124 }))
      .toMatchObject({ startIndex: 100, endIndex: 124 });
    expect(renderer.snapshot().revision).toBe(0);
    renderer.setHead({ latestEndIndex: 148, availableStartIndex: 100, availableEndIndex: 148 });
    renderer.scrollLines(-12);
    expect(renderer.setHead({ latestEndIndex: 172, availableStartIndex: 100, availableEndIndex: 172 }))
      .toMatchObject({ startIndex: 112, endIndex: 136, mode: 'reading' });
    expect(renderer.setHead({ latestEndIndex: 0, availableStartIndex: 0, availableEndIndex: 0 }))
      .toMatchObject({ startIndex: 0, endIndex: 0, mode: 'follow' });
  });

  it('retains effective availability when body coverage is partial', () => {
    const renderer = createRendererWindow({ visibleRows: 24 });
    const snapshot = renderer.commit({
      ...buffer({ endIndex: 124 }), startIndex: 100,
      latestEndIndex: 148, availableStartIndex: 100, availableEndIndex: 148,
    });
    expect(snapshot.visibleDemand).toMatchObject({ startIndex: 124, endIndex: 148 });
    expect(snapshot.rows.every((value) => value.gap)).toBe(true);
  });

  it('follows live absolute tails and emits visible demand without pulling transport', () => {
    const renderer = createRendererWindow({ visibleRows: 3, visibleCols: 10 });
    const first = renderer.commit(buffer({
      endIndex: 10,
      lines: [[7, row('a')], [8, row('b')], [9, row('c')]],
    }));

    expect(first.state.mode).toBe('follow');
    expect(first.state.renderBottomIndex).toBe(10);
    expect(first.visibleDemand).toEqual({
      startIndex: 7,
      endIndex: 10,
      visibleRows: 3,
      mode: 'follow',
    });
    expect(first.rows.map(({ absoluteIndex }) => absoluteIndex)).toEqual([7, 8, 9]);

    const live = renderer.commit(buffer({
      endIndex: 12,
      revision: 2,
      lines: [[9, row('c')], [10, row('d')], [11, row('e')]],
    }));
    expect(live.state.renderBottomIndex).toBe(12);
    expect(live.rows.map(({ absoluteIndex }) => absoluteIndex)).toEqual([9, 10, 11]);
  });

  it('keeps reading position when a live tail arrives and projects gaps as blank rows', () => {
    const renderer = createRendererWindow({ visibleRows: 3, visibleCols: 10 });
    renderer.commit(buffer({
      endIndex: 10,
      lines: [[7, row('a')], [8, row('b')], [9, row('c')]],
    }));

    const reading = renderer.scrollPages(-1);
    expect(reading.state.mode).toBe('reading');
    expect(reading.state.renderBottomIndex).toBe(7);

    const live = renderer.commit(buffer({
      endIndex: 20,
      revision: 2,
      lines: [[4, row('d')], [6, row('f')]],
    }));
    expect(live.state.mode).toBe('reading');
    expect(live.state.renderBottomIndex).toBe(7);
    expect(live.rows.map(({ absoluteIndex, gap }) => ({ absoluteIndex, gap }))).toEqual([
      { absoluteIndex: 4, gap: false },
      { absoluteIndex: 5, gap: true },
      { absoluteIndex: 6, gap: false },
    ]);
    expect(live.rows[1]?.cells).toEqual([]);
  });

  it('leaves reading on explicit follow, remote input, or a downward move that reaches the tail', () => {
    const renderer = createRendererWindow({ visibleRows: 2, visibleCols: 10 });
    renderer.commit(buffer({ endIndex: 10 }));

    renderer.scrollLines(-2);
    expect(renderer.noteRemoteInput().state.mode).toBe('follow');

    renderer.scrollLines(-2);
    const bottom = renderer.scrollPages(20);
    expect(bottom.state.mode).toBe('follow');
    expect(bottom.state.renderBottomIndex).toBe(10);

    renderer.scrollLines(-1);
    expect(renderer.follow().state.mode).toBe('follow');
  });

  it('owns horizontal offset in columns and never rewrites absolute cell truth', () => {
    const renderer = createRendererWindow({ visibleRows: 1, visibleCols: 4 });
    const line = row('abcdefg');
    const initial = renderer.commit(buffer({
      endIndex: 1,
      cols: 7,
      lines: [[0, line]],
    }));
    expect(rowText(initial, 0)).toBe('abcd');

    const panned = renderer.panColumns(3);
    expect(panned.state.horizontalOffset).toBe(3);
    expect(rowText(panned, 0)).toBe('defg');

    const clamped = renderer.panColumns(100);
    expect(clamped.state.horizontalOffset).toBe(3);
    expect(line.map((value) => value.char)).toEqual([...'abcdefg'].map((value) => value.codePointAt(0)));
  });

  it('keeps wide characters intact when a horizontal window would start on a continuation cell', () => {
    const wide = cell('你', { width: 2 });
    const continuation = cell(' ', { width: 0 });
    const line = [cell('A'), wide, continuation, cell('B')];
    const renderer = createRendererWindow({ visibleRows: 1, visibleCols: 3 });
    renderer.commit(buffer({ endIndex: 1, cols: 4, lines: [[0, line]] }));

    const panned = renderer.panColumns(2);
    expect(panned.state.horizontalOffset).toBe(1);
    expect(rowText(panned, 0)).toBe('你B');
  });

  it('recomputes demand on viewport changes while follow remains pinned to tail', () => {
    const renderer = createRendererWindow({ visibleRows: 2, visibleCols: 5 });
    renderer.commit(buffer({ endIndex: 8 }));

    const resized = renderer.setViewport({ visibleRows: 4, visibleCols: 3 });
    expect(resized.state.renderBottomIndex).toBe(8);
    expect(resized.visibleDemand).toMatchObject({
      startIndex: 4,
      endIndex: 8,
      visibleRows: 4,
      mode: 'follow',
    });
    expect(resized.rows).toHaveLength(4);
  });
});
