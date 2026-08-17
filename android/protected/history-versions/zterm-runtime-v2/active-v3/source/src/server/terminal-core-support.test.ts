import { describe, expect, it } from 'vitest';
import { createTerminalCoreSupport } from './terminal-core-support';

describe('terminal core mirror identity', () => {
  it('namespaces equal session names by backend', () => {
    const support = createTerminalCoreSupport({
      defaultSessionName: 'zterm',
      maxCapturedScrollbackLines: 100,
    });

    expect(support.getMirrorKey('cmd', 'tmux')).toBe('tmux:cmd');
    expect(support.getMirrorKey('cmd', 'herdr')).toBe('herdr:cmd');
    expect(support.getMirrorKey('cmd', 'tmux')).not.toBe(support.getMirrorKey('cmd', 'herdr'));
  });
});
