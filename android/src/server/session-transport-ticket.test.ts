import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('daemon truth freeze - no session transport ticket module', () => {
  it('removes session-transport-ticket.ts from daemon source tree', () => {
    const tsPath = join(process.cwd(), 'src', 'server', 'session-transport-ticket.ts');
    expect(() => readFileSync(tsPath, 'utf8')).toThrow();
  });
});
