import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('daemon truth freeze - no client session lifecycle module', () => {
  it('removes client-session-lifecycle.ts from daemon source tree', () => {
    const tsPath = join(process.cwd(), 'src', 'server', 'client-session-lifecycle.ts');
    expect(() => readFileSync(tsPath, 'utf8')).toThrow();
  });
});
