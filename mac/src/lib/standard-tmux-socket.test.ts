import { describe, expect, it } from 'vitest';
import { resolveStandardTmuxSocketArgs } from '../../electron/standard-tmux-socket';

const HOME_FIXTURE = '/Users/zterm-fixture';

describe('mac standard tmux socket args', () => {
  it('targets the shared standard socket when it exists', () => {
    expect(resolveStandardTmuxSocketArgs({
      platform: 'darwin',
      homeDir: HOME_FIXTURE,
      uid: 501,
      hasStandardSocket: true,
    })).toEqual(['-S', `${HOME_FIXTURE}/.tmux/run/tmux-501/default`]);
  });

  it('falls back to the tmux CLI default when the standard socket is absent', () => {
    expect(resolveStandardTmuxSocketArgs({
      platform: 'darwin',
      homeDir: HOME_FIXTURE,
      uid: 501,
      hasStandardSocket: false,
    })).toEqual([]);
  });

  it('falls back to the tmux CLI default when HOME is missing', () => {
    expect(resolveStandardTmuxSocketArgs({
      platform: 'darwin',
      homeDir: undefined,
      uid: 501,
      hasStandardSocket: true,
    })).toEqual([]);
  });

  it('falls back to the tmux CLI default when the uid is unavailable', () => {
    expect(resolveStandardTmuxSocketArgs({
      platform: 'linux',
      homeDir: HOME_FIXTURE,
      uid: undefined,
      hasStandardSocket: true,
    })).toEqual([]);
  });

  it('falls back to the tmux CLI default on non-unix platforms', () => {
    expect(resolveStandardTmuxSocketArgs({
      platform: 'win32',
      homeDir: HOME_FIXTURE,
      uid: 501,
      hasStandardSocket: true,
    })).toEqual([]);
  });
});
