import { describe, it, expect } from 'vitest';
import { resolveTerminalRequestWindowLines } from './viewport-utils';

describe('resolveTerminalRequestWindowLines', () => {
  it('returns 2.5x visible rows for typical viewport', () => {
    expect(resolveTerminalRequestWindowLines(24)).toBe(60);
    expect(resolveTerminalRequestWindowLines(30)).toBe(75);
  });

  it('clamps to at least 1 visible row', () => {
    expect(resolveTerminalRequestWindowLines(0)).toBe(2); // floor(0*2.5)=0, max with safeRows=1 → 2? Actually safeRows=1, 1*2.5=2.5 floor=2
    expect(resolveTerminalRequestWindowLines(-5)).toBe(2);
  });

  it('handles non-integer rows', () => {
    expect(resolveTerminalRequestWindowLines(24.7)).toBe(60); // floor(24.7)=24, 24*2.5=60
    expect(resolveTerminalRequestWindowLines(30.2)).toBe(75);
  });
});
