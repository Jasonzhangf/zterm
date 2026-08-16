import { describe, expect, it } from 'vitest';
import { decodeKeySequence, encodeKeySequence } from './key-sequence';

describe('key-sequence', () => {
  it('decodes common terminal escape sequences', () => {
    expect(decodeKeySequence('plain\\r\\n\\t\\x1b^C^?')).toBe('plain\r\n\t\x1b\x03\x7f');
  });

  it('decodes unicode escapes', () => {
    expect(decodeKeySequence('A\\u4e2d\\u6587')).toBe('A中文');
  });

  it('round trips control characters', () => {
    const sequence = '\x1b[A\r\n\t\x03\x04\x7f';
    expect(decodeKeySequence(encodeKeySequence(sequence))).toBe(sequence);
  });
});
