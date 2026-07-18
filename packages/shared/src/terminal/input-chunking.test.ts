import { describe, expect, it } from 'vitest';
import {
  getTerminalInputUtf8ByteLength,
  splitTerminalInputUtf8Chunks,
} from './input-chunking';

describe('terminal input chunking', () => {
  it('splits by UTF-8 byte budget and preserves exact payload order', () => {
    const source = `${'a'.repeat(7)}中文😀${'b'.repeat(7)}`;
    const chunks = splitTerminalInputUtf8Chunks(source, 10);

    expect(chunks.join('')).toBe(source);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(getTerminalInputUtf8ByteLength(chunk)).toBeLessThanOrEqual(10);
    }
  });

  it('does not split surrogate pairs across chunk boundaries', () => {
    const source = `a${'😀'.repeat(4)}z`;
    const chunks = splitTerminalInputUtf8Chunks(source, 5);

    expect(chunks.join('')).toBe(source);
    expect(chunks).toContain('😀');
    for (const chunk of chunks) {
      expect(getTerminalInputUtf8ByteLength(chunk)).toBeLessThanOrEqual(5);
      const first = chunk.charCodeAt(0);
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(first < 0xdc00 || first > 0xdfff).toBe(true);
      expect(last < 0xd800 || last > 0xdbff).toBe(true);
    }
  });

  it('rejects chunk sizes that cannot carry one UTF-8 code point', () => {
    expect(() => splitTerminalInputUtf8Chunks('a', 3)).toThrow(
      'terminal input chunk size must be at least 4 UTF-8 bytes',
    );
  });
});
