export type TerminalBackendKind = 'tmux' | 'wezterm' | 'herdr';

export interface ResolveTerminalBackendKindOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

export function resolveTerminalBackendKind(options: ResolveTerminalBackendKindOptions = {}): TerminalBackendKind {
  const env = options.env || process.env;
  const explicit = (env.ZTERM_TERMINAL_BACKEND || '').trim().toLowerCase();
  if (explicit === 'tmux' || explicit === 'wezterm' || explicit === 'herdr') {
    return explicit;
  }
  if (explicit) {
    throw new Error(`unsupported ZTERM_TERMINAL_BACKEND: ${explicit}`);
  }
  return (options.platform || process.platform) === 'win32' ? 'wezterm' : 'tmux';
}

export function resolveWezTermExecutable(env: Record<string, string | undefined> = process.env) {
  const explicit = (env.ZTERM_WEZTERM_EXE || '').trim();
  if (explicit) {
    return explicit;
  }
  return 'wezterm.exe';
}

export function resolveHerdrExecutable(env: Record<string, string | undefined> = process.env) {
  const explicit = (env.ZTERM_HERDR_EXE || '').trim();
  return explicit || 'herdr';
}
