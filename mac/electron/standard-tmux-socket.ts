import { resolveStandardTmuxSocketPath } from '@zterm/shared/terminal/tmux-socket-path';

/**
 * Resolve the tmux socket args for the macOS local provider.
 *
 * zterm standard host config keeps the tmux server at the shared resolver's
 * `~/.tmux/run/tmux-<uid>/default` (`TMUX_TMPDIR=$HOME/.tmux/run`). The Electron
 * process may be launched without that env, so target the standard socket
 * explicitly and fall back to the tmux CLI default when no server socket exists.
 */
export function resolveStandardTmuxSocketArgs(options: {
  platform: string;
  homeDir?: string;
  uid?: number;
  hasStandardSocket: boolean;
}): string[] {
  if (options.platform !== 'darwin' && options.platform !== 'linux') {
    return [];
  }
  const { uid, homeDir } = options;
  if (uid === undefined || !homeDir || !options.hasStandardSocket) {
    return [];
  }
  return ['-S', resolveStandardTmuxSocketPath(homeDir, uid)];
}
