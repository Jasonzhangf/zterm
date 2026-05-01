import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + 1800);
}

describe('server mirror capture truth gates', () => {
  it('canonicalizes captured lines directly instead of replaying a joined screen snapshot into synthetic scrollback', () => {
    const source = readServerSource();
    const block = extractBlock(source, 'async function captureMirrorAuthoritativeBufferFromTmux');

    expect(block).toContain('canonicalizeCapturedMirrorLines');
    expect(block).not.toContain("writeString(capturedLines.join('\\r\\n'))");
    expect(block).not.toContain('getScrollbackCount()');
    expect(block).not.toContain('readScrollbackRangeByOldestIndex(');
  });
});
