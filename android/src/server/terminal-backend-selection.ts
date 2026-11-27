import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, resolve, join } from 'node:path';
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

export function resolveRexExecutable(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const explicit = (env.ZTERM_REX_EXE || '').trim();
  if (explicit) return explicit;
  const isExecutable = (file: string) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  for (const directory of (env.PATH || '').split(delimiter)) {
    const executable = resolve(directory, 'rex');
    if (isExecutable(executable)) return executable;
  }
  if (platform === 'darwin') {
    const installed = join(homedir(), 'Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex');
    if (isExecutable(installed)) return installed;
  }
  return 'rex';
}

export function isHerdrExecutableAvailable(executable = resolveHerdrExecutable()) {
  const probe = spawnSync(executable, ['--help'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return probe.error == null && (probe.status === 0 || probe.status === 1);
}

export function isRexExecutableAvailable(executable = resolveRexExecutable()) {
  const probe = spawnSync(executable, ['--help'], {
    stdio: 'ignore',
    timeout: 2_000,
  });
  return !probe.error && probe.status === 0;
}
