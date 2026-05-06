import { describe, expect, it } from 'vitest';
import { WasmBridge } from '@jsonstudio/wtermmod-core';
import { encodePackedTruecolorColor } from '@zterm/shared/terminal/color';
import { canonicalizeCapturedMirrorLines } from './mirror-line-canonicalizer';

function rowGlyphText(cells: { char: number; width: number }[]) {
  return String.fromCodePoint(
    ...cells
      .filter((cell) => cell.width !== 0)
      .map((cell) => cell.char),
  ).trimEnd();
}

describe('canonicalizeCapturedMirrorLines', () => {
  it('canonicalizes each captured line independently instead of synthesizing scrollback from a joined snapshot', async () => {
    const bridge = await WasmBridge.load();
    const rows = await canonicalizeCapturedMirrorLines(
      [
        '\u001b[31mERR\u001b[0m 你好',
        'prompt-$ echo done',
      ],
      40,
      bridge,
    );

    expect(rows).toHaveLength(2);
    expect(rowGlyphText(rows[0])).toBe('ERR 你好');
    expect(rowGlyphText(rows[1])).toBe('prompt-$ echo done');
    expect(rows[0][0]).toMatchObject({
      char: 'E'.codePointAt(0),
      fg: 1,
      bg: 256,
      flags: 0,
      width: 1,
    });
    expect(rows[0][4]).toMatchObject({
      char: '你'.codePointAt(0),
      fg: 256,
      bg: 256,
      flags: 0,
      width: 2,
    });
    expect(rows[0][5]).toMatchObject({
      char: 32,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 0,
    });
  });

  it('preserves ANSI red/green background indices from tmux capture instead of collapsing them to grayscale', async () => {
    const bridge = await WasmBridge.load();
    const rows = await canonicalizeCapturedMirrorLines(
      [
        '\u001b[41mRED\u001b[0m',
        '\u001b[42mGREEN\u001b[0m',
      ],
      40,
      bridge,
    );

    expect(rows[0]?.slice(0, 3)).toEqual([
      expect.objectContaining({ char: 'R'.codePointAt(0), fg: 256, bg: 1, width: 1 }),
      expect.objectContaining({ char: 'E'.codePointAt(0), fg: 256, bg: 1, width: 1 }),
      expect.objectContaining({ char: 'D'.codePointAt(0), fg: 256, bg: 1, width: 1 }),
    ]);
    expect(rows[1]?.slice(0, 5)).toEqual([
      expect.objectContaining({ char: 'G'.codePointAt(0), fg: 256, bg: 2, width: 1 }),
      expect.objectContaining({ char: 'R'.codePointAt(0), fg: 256, bg: 2, width: 1 }),
      expect.objectContaining({ char: 'E'.codePointAt(0), fg: 256, bg: 2, width: 1 }),
      expect.objectContaining({ char: 'E'.codePointAt(0), fg: 256, bg: 2, width: 1 }),
      expect.objectContaining({ char: 'N'.codePointAt(0), fg: 256, bg: 2, width: 1 }),
    ]);
  });

  it('preserves colon-style extended truecolor backgrounds as packed rgb truth before parser canonicalization', async () => {
    const bridge = await WasmBridge.load();
    const rows = await canonicalizeCapturedMirrorLines(
      [
        '\u001b[48:2::255:0:0mRED\u001b[0m',
        '\u001b[48:2::0:255:0mGREEN\u001b[0m',
      ],
      40,
      bridge,
    );

    expect(rows[0]?.slice(0, 3)).toEqual([
      expect.objectContaining({ char: 'R'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(255, 0, 0), width: 1 }),
      expect.objectContaining({ char: 'E'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(255, 0, 0), width: 1 }),
      expect.objectContaining({ char: 'D'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(255, 0, 0), width: 1 }),
    ]);
    expect(rows[1]?.slice(0, 5)).toEqual([
      expect.objectContaining({ char: 'G'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(0, 255, 0), width: 1 }),
      expect.objectContaining({ char: 'R'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(0, 255, 0), width: 1 }),
      expect.objectContaining({ char: 'E'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(0, 255, 0), width: 1 }),
      expect.objectContaining({ char: 'E'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(0, 255, 0), width: 1 }),
      expect.objectContaining({ char: 'N'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(0, 255, 0), width: 1 }),
    ]);
  });

  it('preserves semicolon-style truecolor backgrounds as packed rgb truth instead of collapsing them to grayscale indices', async () => {
    const bridge = await WasmBridge.load();
    const rows = await canonicalizeCapturedMirrorLines(
      [
        '\u001b[48;2;120;80;80mDR\u001b[0m',
        '\u001b[48;2;80;120;80mDG\u001b[0m',
      ],
      40,
      bridge,
    );

    expect(rows[0]?.slice(0, 2)).toEqual([
      expect.objectContaining({ char: 'D'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(120, 80, 80), width: 1 }),
      expect.objectContaining({ char: 'R'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(120, 80, 80), width: 1 }),
    ]);
    expect(rows[1]?.slice(0, 2)).toEqual([
      expect.objectContaining({ char: 'D'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(80, 120, 80), width: 1 }),
      expect.objectContaining({ char: 'G'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(80, 120, 80), width: 1 }),
    ]);
  });

  it('preserves colon-style truecolor backgrounds as packed rgb truth instead of collapsing them to grayscale indices', async () => {
    const bridge = await WasmBridge.load();
    const rows = await canonicalizeCapturedMirrorLines(
      [
        '\u001b[48:2::120:80:80mCR\u001b[0m',
        '\u001b[48:2::80:120:80mCG\u001b[0m',
      ],
      40,
      bridge,
    );

    expect(rows[0]?.slice(0, 2)).toEqual([
      expect.objectContaining({ char: 'C'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(120, 80, 80), width: 1 }),
      expect.objectContaining({ char: 'R'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(120, 80, 80), width: 1 }),
    ]);
    expect(rows[1]?.slice(0, 2)).toEqual([
      expect.objectContaining({ char: 'C'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(80, 120, 80), width: 1 }),
      expect.objectContaining({ char: 'G'.codePointAt(0), fg: 256, bg: encodePackedTruecolorColor(80, 120, 80), width: 1 }),
    ]);
  });

  it('normalizes colon-style 256-color background tokens without dropping bg indices to default sentinel', async () => {
    const bridge = await WasmBridge.load();
    const rows = await canonicalizeCapturedMirrorLines(
      [
        '\u001b[48:5:22mGREEN256\u001b[0m',
        '\u001b[48:5:52mRED256\u001b[0m',
      ],
      40,
      bridge,
    );

    expect(rows[0]?.slice(0, 8)).toEqual([
      expect.objectContaining({ char: 'G'.codePointAt(0), fg: 256, bg: 22, width: 1 }),
      expect.objectContaining({ char: 'R'.codePointAt(0), fg: 256, bg: 22, width: 1 }),
      expect.objectContaining({ char: 'E'.codePointAt(0), fg: 256, bg: 22, width: 1 }),
      expect.objectContaining({ char: 'E'.codePointAt(0), fg: 256, bg: 22, width: 1 }),
      expect.objectContaining({ char: 'N'.codePointAt(0), fg: 256, bg: 22, width: 1 }),
      expect.objectContaining({ char: '2'.codePointAt(0), fg: 256, bg: 22, width: 1 }),
      expect.objectContaining({ char: '5'.codePointAt(0), fg: 256, bg: 22, width: 1 }),
      expect.objectContaining({ char: '6'.codePointAt(0), fg: 256, bg: 22, width: 1 }),
    ]);
    expect(rows[1]?.slice(0, 6)).toEqual([
      expect.objectContaining({ char: 'R'.codePointAt(0), fg: 256, bg: 52, width: 1 }),
      expect.objectContaining({ char: 'E'.codePointAt(0), fg: 256, bg: 52, width: 1 }),
      expect.objectContaining({ char: 'D'.codePointAt(0), fg: 256, bg: 52, width: 1 }),
      expect.objectContaining({ char: '2'.codePointAt(0), fg: 256, bg: 52, width: 1 }),
      expect.objectContaining({ char: '5'.codePointAt(0), fg: 256, bg: 52, width: 1 }),
      expect.objectContaining({ char: '6'.codePointAt(0), fg: 256, bg: 52, width: 1 }),
    ]);
  });
});
