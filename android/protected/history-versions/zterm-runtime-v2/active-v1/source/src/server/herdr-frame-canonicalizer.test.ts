import { describe, expect, it } from 'vitest';
import { HerdrFrameCanonicalizer, type HerdrTerminalFrame } from './herdr-frame-canonicalizer';

function frame(bytes: string, seq: number, full: boolean, width = 12, height = 3): HerdrTerminalFrame {
  return {
    type: 'terminal.frame',
    bytes: Buffer.from(bytes, 'utf8').toString('base64'),
    seq,
    full,
    width,
    height,
  };
}

function rowText(snapshot: Awaited<ReturnType<HerdrFrameCanonicalizer['apply']>>, row: number) {
  return snapshot.bufferLines[row]!
    .filter((cell) => cell.width !== 0)
    .map((cell) => String.fromCodePoint(cell.char))
    .join('')
    .replace(/\s+$/u, '');
}

describe('Herdr frame canonicalizer', () => {
  it('replays full and contiguous delta frames through the shared VT core', async () => {
    const canonicalizer = await HerdrFrameCanonicalizer.create();
    const first = canonicalizer.apply(frame('hello', 1, true));
    const second = canonicalizer.apply(frame('\x1b[2;1Hworld', 2, false));

    expect(rowText(first, 0)).toBe('hello');
    expect(rowText(second, 1)).toBe('world');
    expect(second.ztermRevision).toBe(2);
    expect(second.absoluteRange).toMatchObject({ startIndex: 0, endIndex: 3, availableStartIndex: 0, availableEndIndex: 3 });
    expect(second.capabilityGaps).toEqual([]);
  });

  it('keeps zterm revision independent from attachment sequence resets', async () => {
    const canonicalizer = await HerdrFrameCanonicalizer.create();
    expect(canonicalizer.apply(frame('one', 7, true)).ztermRevision).toBe(1);

    canonicalizer.resetAttachment();
    const reconnect = canonicalizer.apply(frame('two', 1, true));

    expect(reconnect.attachmentSeq).toBe(1);
    expect(reconnect.ztermRevision).toBe(2);
  });

  it('accepts a contiguous full frame when the same attachment changes geometry', async () => {
    const canonicalizer = await HerdrFrameCanonicalizer.create();
    canonicalizer.apply(frame('baseline', 1, true, 12, 3));

    const resized = canonicalizer.apply(frame('resized', 2, true, 16, 4));

    expect(resized.ztermRevision).toBe(2);
    expect(resized.attachmentSeq).toBe(2);
    expect(resized.cols).toBe(16);
    expect(resized.rows).toBe(4);
  });

  it('canonicalizes SGR, erase, scroll, alternate screen, OSC, kitty graphics, and wide cells', async () => {
    const canonicalizer = await HerdrFrameCanonicalizer.create();
    const snapshot = canonicalizer.apply({
      ...frame(
        '\x1b[2J\x1b[H\x1b[31mRED\x1b[0m\x1b[2;1H漢🙂'
        + '\x1b[4;1HERASE_ME\x1b[4;1H\x1b[K'
        + '\x1b[5;1HSCROLL_ME\x1b[1S'
        + '\x1b[?1049h\x1b[HALT_SCREEN\x1b[?1049l'
        + '\x1b]0;ZTERM_PARITY\x07\x1b_Ga=T,f=24;AAAA\x1b\\'
        + '\x1b[3;4H\x1b[?25l',
        1,
        true,
        12,
        6,
      ),
      scroll: { maxOffsetFromBottom: 4, offsetFromBottom: 0, viewportRows: 6 },
    });

    expect(rowText(snapshot, 0)).toBe('RED');
    expect(rowText(snapshot, 1)).toBe('漢🙂');
    expect(rowText(snapshot, 4)).toBe('SCROLL_ME');
    expect(snapshot.bufferLines[1]![0]).toMatchObject({ char: '漢'.codePointAt(0), width: 2 });
    expect(snapshot.bufferLines[1]![2]).toMatchObject({ char: '🙂'.codePointAt(0), width: 2 });
    expect(snapshot.alternateScreen).toBe(false);
    expect(snapshot.localCursor).toMatchObject({ row: 2, col: 3, visible: false });
    expect(snapshot.cursor).toMatchObject({ rowIndex: 3, col: 3, visible: false });
    expect(snapshot.capabilityGaps).toEqual([]);
  });

  it('wraps through the same VT owner without dropping the continuation delta', async () => {
    const canonicalizer = await HerdrFrameCanonicalizer.create();
    const first = canonicalizer.apply(frame('1234567890AB', 1, true, 5, 3));
    const second = canonicalizer.apply(frame('\x1b[3;1HCD', 2, false, 5, 3));

    expect(rowText(first, 0)).toBe('12345');
    expect(rowText(first, 1)).toBe('67890');
    expect(rowText(first, 2)).toBe('AB');
    expect(rowText(second, 2)).toBe('CD');
    expect(second.ztermRevision).toBe(2);
  });

  it('projects canonicalizer-owned VT scrollback into absolute rows', async () => {
    const canonicalizer = await HerdrFrameCanonicalizer.create();
    const snapshot = canonicalizer.apply({
      ...frame(Array.from({ length: 12 }, (_, index) => `LINE_${index}\r\n`).join(''), 1, true, 12, 3),
    });

    expect(snapshot.scrollbackCount).toBeGreaterThan(0);
    expect(snapshot.bufferLines.length).toBe(snapshot.scrollbackCount + snapshot.rows);
    expect(snapshot.absoluteRange).toMatchObject({
      startIndex: 0,
      endIndex: snapshot.bufferLines.length,
      availableStartIndex: 0,
      availableEndIndex: snapshot.bufferLines.length,
      origin: 'herdr-canonicalizer-scrollback',
    });
  });

  it('uses canonicalizer-owned scrollback identities, not host viewport offsets', async () => {
    const canonicalizer = await HerdrFrameCanonicalizer.create();
    const bottom = canonicalizer.apply({
      ...frame('abc', 1, true),
      scroll: { maxOffsetFromBottom: 5, offsetFromBottom: 0, viewportRows: 3 },
    });
    expect(bottom.absoluteRange).toMatchObject({ startIndex: 0, endIndex: 3, availableStartIndex: 0, availableEndIndex: 3 });
    expect(bottom.cursor?.rowIndex).toBe(0);
    expect(bottom.capabilityGaps).toEqual([]);

    const scrolled = canonicalizer.apply({
      ...frame('\x1b[1;1Hold', 2, false),
      scroll: { maxOffsetFromBottom: 4, offsetFromBottom: 1, viewportRows: 3 },
    });
    expect(scrolled.absoluteRange).toMatchObject({ startIndex: 0, endIndex: 3, availableEndIndex: 3 });
    expect(scrolled.cursor).toBeNull();
    expect(scrolled.capabilityGaps).toContain('absolute-cursor-unavailable-while-host-scrolled');
  });

  it('does not treat host viewport offset changes as zterm range truth', async () => {
    const canonicalizer = await HerdrFrameCanonicalizer.create();
    canonicalizer.apply({
      ...frame('base', 1, true),
      scroll: { maxOffsetFromBottom: 5, offsetFromBottom: 0, viewportRows: 3 },
    });

    expect(() => canonicalizer.apply({
      ...frame('bad', 2, false),
      scroll: { maxOffsetFromBottom: 2, offsetFromBottom: 0, viewportRows: 3 },
    })).not.toThrow();
    expect(canonicalizer.getRevision()).toBe(2);
  });

  it('resets canonicalizer-owned range at attachment reconnects', async () => {
    const canonicalizer = await HerdrFrameCanonicalizer.create();
    canonicalizer.apply({
      ...frame('first', 1, true),
      scroll: { maxOffsetFromBottom: 20, offsetFromBottom: 0, viewportRows: 3 },
    });
    canonicalizer.resetAttachment();

    const reconnect = canonicalizer.apply({
      ...frame('reconnect', 1, true),
      scroll: { maxOffsetFromBottom: 1, offsetFromBottom: 0, viewportRows: 3 },
    });

    expect(reconnect.absoluteRange).toMatchObject({ startIndex: 0, endIndex: 3, availableEndIndex: 3 });
    expect(reconnect.ztermRevision).toBe(2);
    expect(reconnect.attachmentSeq).toBe(1);
  });

  it('rejects duplicate, reordered, and missing delta frames without advancing truth', async () => {
    const canonicalizer = await HerdrFrameCanonicalizer.create();
    canonicalizer.apply(frame('baseline', 4, true));

    for (const invalidSeq of [4, 6, 8]) {
      expect(() => canonicalizer.apply(frame('bad', invalidSeq, false))).toThrow(/cannot advance/);
      expect(canonicalizer.getRevision()).toBe(1);
    }
  });

  it('rejects a first delta and a duplicate full frame without advancing truth', async () => {
    const canonicalizer = await HerdrFrameCanonicalizer.create();

    expect(() => canonicalizer.apply(frame('bad', 1, false))).toThrow(
      'first terminal.frame must be full',
    );
    expect(canonicalizer.getRevision()).toBe(0);

    canonicalizer.apply(frame('baseline', 1, true));
    expect(() => canonicalizer.apply(frame('duplicate', 1, true))).toThrow(/cannot advance/);
    expect(canonicalizer.getRevision()).toBe(1);
  });

  it('rejects malformed frame bytes before touching the VT state', async () => {
    const canonicalizer = await HerdrFrameCanonicalizer.create();
    canonicalizer.apply(frame('baseline', 1, true));

    expect(() => canonicalizer.apply({
      ...frame('next', 2, false),
      bytes: 'not-base64',
    })).toThrow(/base64/);
    expect(canonicalizer.getRevision()).toBe(1);
  });
});
