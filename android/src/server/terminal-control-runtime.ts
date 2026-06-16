import { spawn, spawnSync } from 'child_process';
import { homedir } from 'os';
import type { SessionMirror } from './terminal-runtime-types';

export interface TerminalControlRuntimeDeps {
  tmuxBinary: string;
  defaultSessionName: string;
  hiddenTmuxSessions: Set<string>;
  mirrors: Map<string, SessionMirror>;
  getMirrorKey: (sessionName: string) => string;
  sanitizeSessionName: (input?: string) => string;
}

export interface TerminalControlRuntime {
  runTmux: (args: string[]) => { ok: true; stdout: string };
  runTmuxAsync: (args: string[]) => Promise<{ ok: true; stdout: string }>;
  runCommand: (command: string, args: string[]) => ReturnType<typeof spawnSync>;
  ensureTmuxSessionAlternateScreenDisabled: (sessionName: string) => void;
  writeToTmuxSession: (sessionName: string, payload: string, appendEnter: boolean) => void;
  writeToLiveMirror: (sessionName: string, payload: string, appendEnter: boolean) => boolean;
  enqueueLiveMirrorInput: (
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    shouldWrite?: () => boolean,
  ) => Promise<boolean>;
  listTmuxSessions: () => string[];
  createDetachedTmuxSession: (input?: string, cwd?: string) => string;
  renameTmuxSession: (currentName?: string, nextName?: string) => string;
}

export function createTerminalControlRuntime(
  deps: TerminalControlRuntimeDeps,
): TerminalControlRuntime {
  const liveMirrorInputChains = new Map<string, Promise<boolean>>();

  function cleanEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    delete env.TMUX;
    delete env.TMUX_PANE;
    env.TERM = 'xterm-256color';
    env.LANG = env.LANG || 'en_US.UTF-8';
    env.LC_CTYPE = env.LC_CTYPE || env.LANG;
    const currentPath = env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
    env.PATH = Array.from(new Set([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      currentPath,
    ])).join(':');
    return env;
  }

  function runTmux(args: string[]) {
    const result = spawnSync(deps.tmuxBinary, args, {
      encoding: 'utf-8',
      cwd: process.env.HOME || homedir(),
      env: cleanEnv(),
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.trim() || '';
      if (stderr.includes('no server running on') && args[0] === 'list-sessions') {
        return { ok: true as const, stdout: '' };
      }
      throw new Error(stderr || `tmux exited with status ${result.status}`);
    }

    return { ok: true as const, stdout: result.stdout || '' };
  }

  function runCommand(command: string, args: string[]) {
    const result = spawnSync(command, args, {
      encoding: 'utf-8',
      cwd: process.env.HOME || homedir(),
      env: cleanEnv(),
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `${command} exited with status ${result.status}`);
    }

    return result;
  }

  function runTmuxAsync(args: string[]) {
    return new Promise<{ ok: true; stdout: string }>((resolve, reject) => {
      const child = spawn(deps.tmuxBinary, args, {
        cwd: process.env.HOME || homedir(),
        env: cleanEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        if (code !== 0) {
          const trimmedStderr = stderr.trim();
          if (trimmedStderr.includes('no server running on') && args[0] === 'list-sessions') {
            resolve({ ok: true, stdout: '' });
            return;
          }
          reject(new Error(trimmedStderr || `tmux exited with status ${code ?? 'unknown'}`));
          return;
        }
        resolve({ ok: true, stdout });
      });
    });
  }

  function ensureTmuxSessionAlternateScreenDisabled(sessionName: string) {
    runTmux(['set-option', '-t', sessionName, 'alternate-screen', 'off']);
  }

  function writeToTmuxSession(sessionName: string, payload: string, appendEnter: boolean) {
    runTmux(['send-keys', '-t', sessionName, '-l', '--', payload]);
    if (appendEnter) {
      runTmux(['send-keys', '-t', sessionName, 'Enter']);
    }
  }

  function writeToLiveMirror(sessionName: string, payload: string, appendEnter: boolean) {
    const mirror = deps.mirrors.get(deps.getMirrorKey(sessionName));
    if (!mirror || mirror.lifecycle !== 'ready') {
      return false;
    }
    runTmux(['send-keys', '-t', sessionName, '-l', '--', payload]);
    if (appendEnter) {
      runTmux(['send-keys', '-t', sessionName, 'Enter']);
    }
    return true;
  }

  function enqueueLiveMirrorInput(
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    shouldWrite?: () => boolean,
  ) {
    const mirrorKey = deps.getMirrorKey(sessionName);
    const previous = liveMirrorInputChains.get(mirrorKey) || Promise.resolve(true);
    const next = previous
      .catch(() => false)
      .then(async () => {
        const mirror = deps.mirrors.get(mirrorKey);
        if (!mirror || mirror.lifecycle !== 'ready') {
          return false;
        }
        if (shouldWrite && !shouldWrite()) {
          return false;
        }
        await runTmuxAsync(['send-keys', '-t', sessionName, '-l', '--', payload]);
        if (appendEnter) {
          if (shouldWrite && !shouldWrite()) {
            return false;
          }
          await runTmuxAsync(['send-keys', '-t', sessionName, 'Enter']);
        }
        return true;
      })
      .finally(() => {
        if (liveMirrorInputChains.get(mirrorKey) === next) {
          liveMirrorInputChains.delete(mirrorKey);
        }
      });
    liveMirrorInputChains.set(mirrorKey, next);
    return next;
  }

  function listTmuxSessions() {
    const result = runTmux(['list-sessions', '-F', '#S']);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => Boolean(line) && !deps.hiddenTmuxSessions.has(line));
  }

  function createDetachedTmuxSession(input?: string, cwd?: string) {
    const sessionName = deps.sanitizeSessionName(input || deps.defaultSessionName);
    const args = ['new-session', '-d', '-s', sessionName];
    if (cwd) {
      args.push('-c', cwd);
    }
    runTmux(args);
    return sessionName;
  }

  function renameTmuxSession(currentName?: string, nextName?: string) {
    const sessionName = deps.sanitizeSessionName(currentName);
    const nextSessionName = deps.sanitizeSessionName(nextName);
    runTmux(['rename-session', '-t', sessionName, nextSessionName]);
    return nextSessionName;
  }

  return {
    runTmux,
    runTmuxAsync,
    runCommand,
    ensureTmuxSessionAlternateScreenDisabled,
    writeToTmuxSession,
    writeToLiveMirror,
    enqueueLiveMirrorInput,
    listTmuxSessions,
    createDetachedTmuxSession,
    renameTmuxSession,
  };
}
