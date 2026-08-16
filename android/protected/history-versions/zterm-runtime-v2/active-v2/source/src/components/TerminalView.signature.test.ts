import { describe, expect, it } from 'vitest';
import { terminalRowRenderSignature } from './TerminalView';

describe('terminalRowRenderSignature', () => {
  it('returns stable signature for identical row content', () => {
    const row = [
      { char: 97, fg: 7, bg: 0, flags: 0, width: 1 },
      { char: 98, fg: 7, bg: 0, flags: 0, width: 1 },
    ];
    expect(terminalRowRenderSignature(row)).toBe('97:7:0:0:1;98:7:0:0:1');
  });

  it('content-sensitive: same row reference with changed cell style must change signature (in-place mutation contract)', () => {
    const row = [
      { char: 97, fg: 7, bg: 0, flags: 0, width: 1 },
    ];
    const before = terminalRowRenderSignature(row);
    // 原地修改行内容（行引用不变）：签名必须反映真实内容变化，
    // 保证 VisibleRow memo 不会因引用相同而跳过重绘（bottom-stale 回归契约）。
    row[0]!.bg = 1;
    const after = terminalRowRenderSignature(row);
    expect(after).not.toBe(before);
  });

  it('recomputes signature for a new row reference (changed row)', () => {
    const rowA = [{ char: 97, fg: 7, bg: 0, flags: 0, width: 1 }];
    const rowB = [{ char: 122, fg: 7, bg: 0, flags: 0, width: 1 }];
    expect(terminalRowRenderSignature(rowA)).not.toBe(terminalRowRenderSignature(rowB));
  });

  it('handles null / undefined / empty rows', () => {
    expect(terminalRowRenderSignature(null)).toBe('');
    expect(terminalRowRenderSignature(undefined)).toBe('');
    expect(terminalRowRenderSignature([])).toBe('');
  });
});
