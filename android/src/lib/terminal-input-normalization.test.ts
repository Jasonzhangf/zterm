import { describe, expect, it } from 'vitest';
import { normalizeTerminalCommittedText } from './terminal-input-normalization';

describe('normalizeTerminalCommittedText', () => {
  it('keeps CJK unchanged while converting full-width ascii block and ideographic space to half-width', () => {
    expect(normalizeTerminalCommittedText('ＡＢＣ１２３，．！　中文')).toBe('ABC123,.! 中文');
  });

  it('keeps CJK, emoji, and non-ascii symbols while converting IME line breaks into spaces', () => {
    expect(normalizeTerminalCommittedText('第一行😀￥\n第二行\r\n第三行、完成')).toBe(
      '第一行😀￥ 第二行 第三行、完成',
    );
  });

  it('returns empty string unchanged', () => {
    expect(normalizeTerminalCommittedText('')).toBe('');
  });
});
