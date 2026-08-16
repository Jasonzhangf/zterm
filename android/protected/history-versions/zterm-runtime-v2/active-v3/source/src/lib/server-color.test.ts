import { describe, expect, it } from 'vitest';
import { getServerColorToneByKey } from './server-color';

function extractHue(color: string) {
  const match = color.match(/hsl[a]?\((\d+)/);
  return match ? Number.parseInt(match[1], 10) : Number.NaN;
}

describe('server color tone', () => {
  it('uses the approved red/yellow/blue/green palette instead of magenta-purple hues', () => {
    const keys = [
      'mac-studio',
      '100.86.84.63',
      'macbook-air',
      'server-a',
      'server-b',
      'server-c',
      'server-d',
      'server-e',
      'server-f',
      'server-g',
    ];

    const hues = keys.map((key) => extractHue(getServerColorToneByKey(key).accent));

    expect(hues.every((hue) => Number.isFinite(hue))).toBe(true);
    expect(hues.every((hue) => hue < 260 || hue > 330)).toBe(true);
    expect(hues.some((hue) => hue >= 188 && hue <= 224)).toBe(true);
    expect(hues.some((hue) => hue >= 120 && hue <= 190)).toBe(true);
    expect(hues.some((hue) => hue <= 45 || hue >= 350)).toBe(true);
    expect(getServerColorToneByKey('mac-studio').accent).not.toBe(getServerColorToneByKey('100.86.84.63').accent);
  });
});
