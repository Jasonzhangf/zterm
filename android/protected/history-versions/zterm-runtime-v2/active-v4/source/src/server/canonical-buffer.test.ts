import { describe, expect, it } from 'vitest';
import {
  findChangedIndexedRanges,
  normalizeMirrorCaptureLines,
  normalizeCapturedLineBlock,
  resolveCanonicalAvailableLineCount,
  trimTrailingDefaultCells,
} from './canonical-buffer';

function row(text: string) {
  return Array.from(text).map((char) => ({
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  }));
}

describe('resolveCanonicalAvailableLineCount', () => {
  it('does not add paneRows on top of tmux available-line hint', () => {
    expect(resolveCanonicalAvailableLineCount({
      paneRows: 24,
      tmuxAvailableLineCountHint: 381,
      capturedLineCount: 381,
      scratchLineCount: 381,
    })).toBe(381);
  });

  it('keeps at least one visible pane for near-empty sessions', () => {
    expect(resolveCanonicalAvailableLineCount({
      paneRows: 24,
      tmuxAvailableLineCountHint: 0,
      capturedLineCount: 1,
      scratchLineCount: 24,
    })).toBe(24);
  });
});

describe('normalizeMirrorCaptureLines', () => {
  it('does not pad alternate-screen captures into a pane-height-only window', () => {
    expect(normalizeMirrorCaptureLines('row-1\nrow-2\n', {
      paneRows: 4,
      alternateOn: true,
    })).toEqual([
      'row-1',
      'row-2',
    ]);
  });

  it('does not append a second visible block in normal mode', () => {
    expect(normalizeMirrorCaptureLines('hist-1\nhist-2\nvis-1\nvis-2\n', {
      paneRows: 2,
      alternateOn: false,
    })).toEqual([
      'hist-1',
      'hist-2',
      'vis-1',
      'vis-2',
    ]);
  });
});

describe('normalizeCapturedLineBlock', () => {
  it('preserves trailing blank pane rows when an expected pane height is provided', () => {
    expect(normalizeCapturedLineBlock('row-1\nrow-2\n', 3)).toEqual([
      'row-1',
      'row-2',
      '',
    ]);
  });

  it('pads alternate-screen captures up to the requested pane height', () => {
    expect(normalizeCapturedLineBlock('row-1\nrow-2', 4)).toEqual([
      'row-1',
      'row-2',
      '',
      '',
    ]);
  });

  it('still trims the trailing separator for non-alternate captures', () => {
    expect(normalizeCapturedLineBlock('row-1\nrow-2\n')).toEqual([
      'row-1',
      'row-2',
    ]);
  });
});

describe('trimTrailingDefaultCells', () => {
  it('removes only pure default trailing blanks', () => {
    expect(trimTrailingDefaultCells([
      row('x')[0]!,
      { char: 32, fg: 256, bg: 256, flags: 0, width: 1 },
      { char: 32, fg: 256, bg: 256, flags: 0, width: 1 },
    ])).toEqual([
      row('x')[0]!,
    ]);
  });

  it('keeps trailing cells that still carry visual meaning', () => {
    expect(trimTrailingDefaultCells([
      row('x')[0]!,
      { char: 32, fg: 256, bg: 1, flags: 0, width: 1 },
    ])).toEqual([
      row('x')[0]!,
      { char: 32, fg: 256, bg: 1, flags: 0, width: 1 },
    ]);
  });
});

describe('findChangedIndexedRanges', () => {
  it('returns only the changed tail span for append-style updates', () => {
    expect(findChangedIndexedRanges({
      previousStartIndex: 100,
      previousLines: [row('a'), row('b'), row('c'), row('d')],
      nextStartIndex: 100,
      nextLines: [row('a'), row('b'), row('C'), row('D'), row('E')],
    })).toEqual([
      {
        startIndex: 102,
        endIndex: 105,
      },
    ]);
  });

  it('returns the shifted kept window when authoritative start advances', () => {
    expect(findChangedIndexedRanges({
      previousStartIndex: 100,
      previousLines: [row('a'), row('b'), row('c'), row('d')],
      nextStartIndex: 101,
      nextLines: [row('b'), row('c'), row('d'), row('e')],
    })).toEqual([
      {
        startIndex: 104,
        endIndex: 105,
      },
    ]);
  });

  it('returns the prepended prefix span when the authoritative window expands upward', () => {
    expect(findChangedIndexedRanges({
      previousStartIndex: 101,
      previousLines: [row('b'), row('c'), row('d'), row('e')],
      nextStartIndex: 100,
      nextLines: [row('a'), row('b'), row('c'), row('d'), row('e')],
    })).toEqual([
      {
        startIndex: 100,
        endIndex: 101,
      },
    ]);
  });

  it('returns null when there is no effective line change', () => {
    expect(findChangedIndexedRanges({
      previousStartIndex: 100,
      previousLines: [row('a'), row('b')],
      nextStartIndex: 100,
      nextLines: [row('a'), row('b')],
    })).toEqual([]);
  });

  it('keeps top and bottom changes as separate sparse ranges', () => {
    expect(findChangedIndexedRanges({
      previousStartIndex: 100,
      previousLines: [row('a'), row('b'), row('c'), row('d'), row('e'), row('f')],
      nextStartIndex: 100,
      nextLines: [row('A'), row('b'), row('c'), row('d'), row('E'), row('F')],
    })).toEqual([
      {
        startIndex: 100,
        endIndex: 101,
      },
      {
        startIndex: 104,
        endIndex: 106,
      },
    ]);
  });
});
