import { describe, expect, it } from 'vitest';
import {
  advanceKnownLocalWindowRange,
  findChangedIndexedRange,
  resolveCanonicalAvailableLineCount,
  resolveClientIncrementalPatchRange,
  resolveFollowTailSyncPlan,
  resolveIncrementalSyncRange,
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
      startIndex: 104,
      endIndex: 105,
    });
  });

  it('returns the prepended prefix span when the authoritative window expands upward', () => {
    expect(findChangedIndexedRange({
      previousStartIndex: 101,
      previousLines: [row('b'), row('c'), row('d'), row('e')],
      nextStartIndex: 100,
      nextLines: [row('a'), row('b'), row('c'), row('d'), row('e')],
    })).toEqual({
      startIndex: 100,
      endIndex: 101,
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

describe('resolveIncrementalSyncRange', () => {
  it('returns only the changed tail span for append-style updates', () => {
    expect(resolveIncrementalSyncRange({
      changedRange: {
        startIndex: 106,
        endIndex: 107,
      },
      bufferStartIndex: 101,
      bufferEndIndex: 107,
      viewportEndIndex: 107,
      viewportRows: 4,
    })).toEqual({
      startIndex: 106,
      endIndex: 107,
    });
  });

  it('returns only the changed span when a non-viewport range changes', () => {
    expect(resolveIncrementalSyncRange({
      changedRange: {
        startIndex: 120,
        endIndex: 123,
      },
      bufferStartIndex: 120,
      bufferEndIndex: 160,
      viewportEndIndex: 160,
      viewportRows: 6,
    })).toEqual({
      startIndex: 120,
      endIndex: 123,
    });
  });

  it('returns null when there is no effective change', () => {
    expect(resolveIncrementalSyncRange({
      changedRange: null,
      bufferStartIndex: 0,
      bufferEndIndex: 10,
      viewportEndIndex: 10,
      viewportRows: 4,
    })).toBeNull();
  });
});

describe('resolveClientIncrementalPatchRange', () => {
  it('returns only the changed span when the client is exactly one revision behind', () => {
    expect(resolveClientIncrementalPatchRange({
      knownRevision: 4,
      currentRevision: 5,
      lastDeltaFromRevision: 4,
      lastDeltaToRevision: 5,
      lastDeltaRange: {
        startIndex: 106,
        endIndex: 107,
      },
      bufferStartIndex: 101,
      bufferEndIndex: 107,
      localStartIndex: 100,
      localEndIndex: 106,
      viewportEndIndex: 107,
      viewportRows: 4,
    })).toEqual({
      startIndex: 106,
      endIndex: 107,
    });
  });

  it('returns null when the client is more than one revision behind', () => {
    expect(resolveClientIncrementalPatchRange({
      knownRevision: 3,
      currentRevision: 5,
      lastDeltaFromRevision: 4,
      lastDeltaToRevision: 5,
      lastDeltaRange: {
        startIndex: 106,
        endIndex: 107,
      },
      bufferStartIndex: 101,
      bufferEndIndex: 107,
      localStartIndex: 100,
      localEndIndex: 106,
      viewportEndIndex: 107,
      viewportRows: 4,
    })).toBeNull();
  });

  it('returns null when the local cache no longer overlaps current authoritative window', () => {
    expect(resolveClientIncrementalPatchRange({
      knownRevision: 4,
      currentRevision: 5,
      lastDeltaFromRevision: 4,
      lastDeltaToRevision: 5,
      lastDeltaRange: {
        startIndex: 106,
        endIndex: 107,
      },
      bufferStartIndex: 300,
      bufferEndIndex: 306,
      localStartIndex: 100,
      localEndIndex: 106,
      viewportEndIndex: 306,
      viewportRows: 4,
    })).toBeNull();
  });
});

describe('resolveFollowTailSyncPlan', () => {
  it('sends only the changed delta when the local tail window is already complete', () => {
    expect(resolveFollowTailSyncPlan({
      knownRevision: 4,
      currentRevision: 5,
      lastDeltaFromRevision: 4,
      lastDeltaToRevision: 5,
      lastDeltaRange: {
        startIndex: 198,
        endIndex: 200,
      },
      bufferStartIndex: 120,
      bufferEndIndex: 200,
      localStartIndex: 188,
      localEndIndex: 200,
      viewportRows: 4,
      cacheLines: 12,
    })).toEqual({
      windowStartIndex: 188,
      windowEndIndex: 200,
      ranges: [
        {
          startIndex: 198,
          endIndex: 200,
        },
      ],
    });
  });

  it('drops old backlog and resyncs only the latest tail window when local cache is stale', () => {
    expect(resolveFollowTailSyncPlan({
      knownRevision: 2,
      currentRevision: 5,
      lastDeltaFromRevision: 4,
      lastDeltaToRevision: 5,
      lastDeltaRange: {
        startIndex: 198,
        endIndex: 200,
      },
      bufferStartIndex: 0,
      bufferEndIndex: 200,
      localStartIndex: 0,
      localEndIndex: 96,
      viewportRows: 4,
      cacheLines: 12,
    })).toEqual({
      windowStartIndex: 188,
      windowEndIndex: 200,
      ranges: [
        {
          startIndex: 188,
          endIndex: 200,
        },
      ],
    });
  });
});

describe('advanceKnownLocalWindowRange', () => {
  it('keeps the existing tail window when the payload is only a changed tail delta', () => {
    expect(advanceKnownLocalWindowRange({
      localStartIndex: 188,
      localEndIndex: 200,
      payloadStartIndex: 198,
      payloadEndIndex: 200,
    })).toEqual({
      startIndex: 188,
      endIndex: 200,
    });
  });

  it('replaces the known window when the new payload is disjoint from stale local cache', () => {
    expect(advanceKnownLocalWindowRange({
      localStartIndex: 0,
      localEndIndex: 96,
      payloadStartIndex: 188,
      payloadEndIndex: 200,
    })).toEqual({
      startIndex: 188,
      endIndex: 200,
    });
  });
});
