import { describe, expect, it } from 'vitest';
import { findChangedIndexedRange, resolveCanonicalAvailableLineCount } from './canonical-buffer';

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
  it('does not add paneRows on top of tmux history_size', () => {
    expect(resolveCanonicalAvailableLineCount({
      paneRows: 24,
      historySize: 381,
      capturedLineCount: 381,
      scratchLineCount: 381,
    })).toBe(381);
  });

  it('keeps at least one viewport for near-empty sessions', () => {
    expect(resolveCanonicalAvailableLineCount({
      paneRows: 24,
      historySize: 0,
      capturedLineCount: 1,
      scratchLineCount: 24,
    })).toBe(24);
  });
});

describe('findChangedIndexedRange', () => {
  it('returns only the changed tail span for append-style updates', () => {
    expect(findChangedIndexedRange({
      previousStartIndex: 100,
      previousLines: [row('a'), row('b'), row('c'), row('d')],
      nextStartIndex: 100,
      nextLines: [row('a'), row('b'), row('C'), row('D'), row('E')],
    })).toEqual({
      startIndex: 102,
      endIndex: 105,
    });
  });

  it('returns the shifted kept window when authoritative start advances', () => {
    expect(findChangedIndexedRange({
      previousStartIndex: 100,
      previousLines: [row('a'), row('b'), row('c'), row('d')],
      nextStartIndex: 101,
      nextLines: [row('b'), row('c'), row('d'), row('e')],
    })).toEqual({
      startIndex: 100,
      endIndex: 105,
    });
  });

  it('returns null when there is no effective line change', () => {
    expect(findChangedIndexedRange({
      previousStartIndex: 100,
      previousLines: [row('a'), row('b')],
      nextStartIndex: 100,
      nextLines: [row('a'), row('b')],
    })).toBeNull();
  });
});
