import { describe, expect, it } from 'vitest';
import { getServerColorToneByKey } from './server-color';

describe('server color tone', () => {
  it('keeps all server identity tones on the shared monochrome green palette', () => {
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

    const tones = keys.map((key) => getServerColorToneByKey(key));

    expect(tones.every((tone) => tone.accent === 'var(--zterm-panel-accent)')).toBe(true);
    expect(tones.every((tone) => tone.accentSoft === 'var(--zterm-panel-accent-soft)')).toBe(true);
    expect(tones.every((tone) => tone.lightCardBorder === 'var(--zterm-panel-border)')).toBe(true);
    expect(getServerColorToneByKey('mac-studio').key).toBe('mac-studio');
  });
});
