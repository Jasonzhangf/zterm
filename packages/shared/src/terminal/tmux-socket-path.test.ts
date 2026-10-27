import { describe, expect, it } from 'vitest';
import {
  resolveStandardTmuxRunRoot,
  resolveStandardTmuxSocketDir,
  resolveStandardTmuxSocketPath,
} from './tmux-socket-path';

describe('standard tmux socket path', () => {
  it('resolves the standard tmux run root under the user home', () => {
    expect(resolveStandardTmuxRunRoot('/Users/demo')).toBe('/Users/demo/.tmux/run');
    expect(resolveStandardTmuxRunRoot('/home/demo/')).toBe('/home/demo/.tmux/run');
  });

  it('resolves the per-user socket dir and default socket', () => {
    expect(resolveStandardTmuxSocketDir('/Users/demo', 501)).toBe('/Users/demo/.tmux/run/tmux-501');
    expect(resolveStandardTmuxSocketPath('/Users/demo', 501)).toBe(
      '/Users/demo/.tmux/run/tmux-501/default',
    );
    expect(resolveStandardTmuxSocketPath('/Users/demo', 501, 'work')).toBe(
      '/Users/demo/.tmux/run/tmux-501/work',
    );
  });
});
