import { spawnSync } from 'node:child_process';
import {
  assertSupportedTerminalSourceKind,
  type TerminalSourceKind,
} from './terminal-source-adapter';

export type TerminalBackendKind = TerminalSourceKind;

export interface ResolveTerminalBackendKindOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

export function resolveTerminalBackendKind(options: ResolveTerminalBackendKindOptions = {}): TerminalBackendKind {
  const env = options.env || process.env;
  const explicit = (env.ZTERM_TERMINAL_BACKEND || '').trim().toLowerCase();
  if (explicit) return assertSupportedTerminalSourceKind(explicit);
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

export function isHerdrExecutableAvailable(executable = resolveHerdrExecutable()) {
  const probe = spawnSync(executable, ['--help'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return probe.error == null && (probe.status === 0 || probe.status === 1);
}
