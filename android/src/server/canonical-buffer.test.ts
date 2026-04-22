import { describe, expect, it } from 'vitest';
import { resolveCanonicalAvailableLineCount } from './canonical-buffer';

describe('resolveCanonicalAvailableLineCount', () => {
  it('does not add paneRows on top of tmux history_size', () => {
    expect(resolveCanonicalAvailableLineCount({
      paneRows: 24,
      historySize: 381,
      capturedLineCount: 381,
      scratchLineCount: 381,
    })).toBe(381);
  });

  it('keeps at least one viewport for near-empty sessions', () => {
    expect(resolveCanonicalAvailableLineCount({
      paneRows: 24,
      historySize: 0,
      capturedLineCount: 1,
      scratchLineCount: 24,
    })).toBe(24);
  });
});
