/**
 * Standard tmux server socket location.
 *
 * tmux serves each user from `<TMUX_TMPDIR>/tmux-<uid>/<socket name>`, where the
 * socket name is `default` unless `-L` is used. zterm standardizes the root at
 * `<home>/.tmux/run` so every zterm surface (daemon, desktop local provider and
 * the host setup script) resolves one path instead of depending on whatever
 * `TMUX_TMPDIR` a launching process happened to inherit.
 */
export const STANDARD_TMUX_RUN_DIR = '.tmux/run';
export const STANDARD_TMUX_SOCKET_NAME = 'default';

function joinPath(...parts: string[]) {
  const cleaned = parts
    .filter(Boolean)
    .map((part, index) => (
      index === 0
        ? part.replace(/\/+$/u, '')
        : part.replace(/^\/+/u, '').replace(/\/+$/u, '')
    ));
  const joined = cleaned.join('/');
  return joined === '' ? '/' : joined;
}

/** Root directory a standard-configured host exports as `TMUX_TMPDIR`. */
export function resolveStandardTmuxRunRoot(homeDir: string) {
  return joinPath(homeDir, STANDARD_TMUX_RUN_DIR);
}

/** Per-user socket directory inside the standard tmux run root. */
export function resolveStandardTmuxSocketDir(homeDir: string, uid: number) {
  return joinPath(resolveStandardTmuxRunRoot(homeDir), `tmux-${uid}`);
}

/** Exact `default` socket path of the standard-configured tmux server. */
export function resolveStandardTmuxSocketPath(
  homeDir: string,
  uid: number,
  socketName: string = STANDARD_TMUX_SOCKET_NAME,
) {
  return joinPath(resolveStandardTmuxSocketDir(homeDir, uid), socketName);
}
