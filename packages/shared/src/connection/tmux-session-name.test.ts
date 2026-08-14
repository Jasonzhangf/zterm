import { describe, expect, it } from 'vitest';
import { sanitizeTmuxSessionName } from './tmux-session-name';

describe('sanitizeTmuxSessionName', () => {
  it('matches daemon tmux identity normalization', () => {
    expect(sanitizeTmuxSessionName('  work stuff / notes  ')).toBe('work-stuff-notes');
    expect(sanitizeTmuxSessionName('alpha::beta')).toBe('alpha::beta');
  });

  it('uses the provided fallback when normalization is empty', () => {
    expect(sanitizeTmuxSessionName(' *** ', 'demo')).toBe('demo');
  });
});
