import { describe, expect, it } from 'vitest';
import { HERDR_SINGLE_SESSION_WORKSPACE, mapHerdrCanonicalSnapshot } from './herdr-backend-runtime';
import type { HerdrCanonicalSnapshot } from './herdr-frame-canonicalizer';

function snapshot(overrides: Partial<HerdrCanonicalSnapshot> = {}): HerdrCanonicalSnapshot {
  return {
    ztermRevision: 7,
    attachmentSeq: 12,
    full: false,
    cols: 80,
    rows: 2,
    bufferLines: [[
      { char: 65, fg: 1, bg: 256, flags: 0, width: 1 },
      { char: 32, fg: 256, bg: 256, flags: 0, width: 1 },
    ]],
    cursor: { rowIndex: 100, col: 1, visible: true },
    localCursor: { row: 0, col: 1, visible: true },
    cursorKeysApp: true,
    alternateScreen: false,
    scrollbackCount: 0,
    absoluteRange: {
      startIndex: 100,
      endIndex: 101,
      availableStartIndex: 100,
      availableEndIndex: 101,
      origin: 'herdr-canonicalizer-scrollback',
    },
    capabilityGaps: [],
    ...overrides,
  };
}

describe('Herdr backend runtime mirror projection', () => {
  it('uses a synthetic single-surface workspace label instead of Herdr layout identity', () => {
    expect(HERDR_SINGLE_SESSION_WORKSPACE).toBe('herdr-single-session');
    expect(HERDR_SINGLE_SESSION_WORKSPACE).not.toContain(':');
  });

  it('projects canonical rows, range owner, cursor, geometry, and zterm revision without remapping seq', () => {
    const mapped = mapHerdrCanonicalSnapshot(snapshot());

    expect(mapped).toEqual({
      revision: 7,
      bufferStartIndex: 100,
      bufferLines: snapshot().bufferLines,
      cols: 80,
      rows: 2,
      cursorKeysApp: true,
      cursor: { rowIndex: 100, col: 1, visible: true },
    });
    expect(mapped.revision).not.toBe(snapshot().attachmentSeq);
  });

  it('fails explicitly when canonicalizer did not provide an absolute range', () => {
    expect(() => mapHerdrCanonicalSnapshot(snapshot({ absoluteRange: null }))).toThrow(
      'Herdr absolute range unavailable; refusing to publish a fabricated mirror range',
    );
  });

  it('fails explicitly when the absolute range does not cover the canonical body', () => {
    expect(() => mapHerdrCanonicalSnapshot(snapshot({
      absoluteRange: {
        startIndex: 100,
        endIndex: 102,
        availableStartIndex: 100,
        availableEndIndex: 102,
        origin: 'herdr-canonicalizer-scrollback',
      },
    }))).toThrow('Herdr canonical absolute range does not cover the canonical buffer body');
  });

  it('trims the canonical VT scrollback at the mirror edge while preserving absolute range identity', () => {
    const mapped = mapHerdrCanonicalSnapshot({
      ...snapshot(),
      absoluteRange: {
        startIndex: 100,
        endIndex: 104,
        availableStartIndex: 100,
        availableEndIndex: 104,
        origin: 'herdr-canonicalizer-scrollback',
      },
      bufferLines: [
        [{ char: 1, fg: 256, bg: 256, flags: 0, width: 1 }],
        [{ char: 2, fg: 256, bg: 256, flags: 0, width: 1 }],
        [{ char: 3, fg: 256, bg: 256, flags: 0, width: 1 }],
        [{ char: 4, fg: 256, bg: 256, flags: 0, width: 1 }],
      ],
      cursor: { rowIndex: 103, col: 1, visible: true },
    }, 2);

    expect(mapped.bufferStartIndex).toBe(102);
    expect(mapped.bufferLines.map((line) => line[0]?.char)).toEqual([3, 4]);
    expect(mapped.cursor).toEqual({ rowIndex: 103, col: 1, visible: true });
    expect(mapped.revision).toBe(snapshot().ztermRevision);
  });

  it('fails explicitly when a bounded mirror window would drop the canonical cursor', () => {
    expect(() => mapHerdrCanonicalSnapshot({
      ...snapshot({
        bufferLines: [
          [{ char: 1, fg: 256, bg: 256, flags: 0, width: 1 }],
          [{ char: 2, fg: 256, bg: 256, flags: 0, width: 1 }],
        ],
        cursor: { rowIndex: 0, col: 0, visible: true },
        absoluteRange: {
          startIndex: 0,
          endIndex: 2,
          availableStartIndex: 0,
          availableEndIndex: 2,
          origin: 'herdr-canonicalizer-scrollback',
        },
      }),
    }, 1)).toThrow('Herdr canonical cursor falls outside the bounded mirror window');
  });

});
