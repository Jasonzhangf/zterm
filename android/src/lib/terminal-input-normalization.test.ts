import { describe, expect, it } from 'vitest';
import { normalizeTerminalCommittedText } from './terminal-input-normalization';

describe('normalizeTerminalCommittedText', () => {
  it('keeps CJK unchanged while converting full-width ascii block and ideographic space to half-width', () => {
    expect(normalizeTerminalCommittedText('ＡＢＣ１２３，．！　中文')).toBe('ABC123,.! 中文');
  });

  it('returns empty string unchanged', () => {
    expect(normalizeTerminalCommittedText('')).toBe('');
  });
});
