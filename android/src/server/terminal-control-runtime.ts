import { spawn, spawnSync } from 'child_process';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SessionMirror } from './terminal-runtime-types';

export interface TerminalControlRuntimeDeps {
  tmuxBinary: string;
  defaultSessionName: string;
  hiddenTmuxSessions: Set<string>;
  mirrors: Map<string, SessionMirror>;
  tmuxSocketDir?: string;
  getMirrorKey: (sessionName: string) => string;
  sanitizeSessionName: (input?: string) => string;
  daemonRuntimeDebug?: (scope: string, payload?: unknown) => void;
}

export interface TerminalControlRuntime {
  runTmux: (args: string[]) => { ok: true; stdout: string };
  runTmuxAsync: (args: string[]) => Promise<{ ok: true; stdout: string }>;
  runCommand: (command: string, args: string[]) => ReturnType<typeof spawnSync>;
  ensureTmuxSessionAlternateScreenDisabled: (sessionName: string) => void;
  writeToTmuxSession: (sessionName: string, payload: string, appendEnter: boolean) => void;
  ensureTmuxServerRunning: () => void;
  writeToLiveMirror: (sessionName: string, payload: string, appendEnter: boolean) => boolean;
  enqueueLiveMirrorInput: (
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    shouldWrite?: () => boolean,
  ) => Promise<boolean>;
  disposeLiveMirrorInputBatch: (sessionName: string, reason: string) => number;
  listTmuxSessions: () => string[];
  createDetachedTmuxSession: (input?: string, cwd?: string) => string;
  renameTmuxSession: (currentName?: string, nextName?: string) => string;
}

export function createTerminalControlRuntime(
  deps: TerminalControlRuntimeDeps,
): TerminalControlRuntime {
  const liveMirrorInputBatches = new Map<string, {
    items: Array<{
      payload: string;
      appendEnter: boolean;
      shouldWrite?: () => boolean;
      resolve: (value: boolean) => void;
      reject: (reason?: unknown) => void;
    }>;
    scheduled: boolean;
    flushing: boolean;

  }>();



  function cleanEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.TMUX_TMPDIR;
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

  // Daemon shares the system-default tmux socket so that sessions created by
  // the user's interactive `tmux` shell are visible to the client and vice
  // versa. Using a private socket would hide user sessions and break the
  // "all sessions visible" requirement.
  function ensureTmuxServerRunning() {
    const keepalive = 'zterm-daemon-keepalive';
    // If server is already running (user's or ours), just ensure keepalive exists
    try {
      runTmux(['has-session', '-t', keepalive]);
      return; // server + keepalive alive
    } catch {
      // server or session missing — continue
    }
    try {
      // tmux 3.6a: start-server alone creates a server that exits immediately
      // when no session exists. new-session -d both creates the server AND a
      // live session to keep it running.
      runTmux(['new-session', '-d', '-s', keepalive, '-x', '80', '-y', '24']);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already exists')) {
        console.warn(`[terminal-control] tmux new-session: ${message}`);
      }
    }
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

  async function flushPendingLiveMirrorInput(mirrorKey: string) {
    const pending = liveMirrorInputBatches.get(mirrorKey);
    if (!pending) {
      return;
    }
    if (pending.flushing) {
      return;
    }
    pending.scheduled = false;
    pending.flushing = true;
    const items = pending.items.splice(0);
    const mirror = deps.mirrors.get(mirrorKey);
    if (!mirror || mirror.lifecycle !== 'ready') {
      for (const item of items) {
        item.resolve(false);
      }
      pending.flushing = false;
      if (pending.items.length === 0) {
        liveMirrorInputBatches.delete(mirrorKey);
      } else {
        schedulePendingLiveMirrorInput(mirrorKey);
      }
      return;
    }

    const writableItems: typeof items = [];
    for (const item of items) {
      if (item.shouldWrite && !item.shouldWrite()) {
        item.resolve(false);
        continue;
      }
      writableItems.push(item);
    }

    if (writableItems.length === 0) {
      pending.flushing = false;
      if (pending.items.length === 0) {
        liveMirrorInputBatches.delete(mirrorKey);
      } else {
        schedulePendingLiveMirrorInput(mirrorKey);
      }
      return;
    }

    const groups: Array<{
      payload: string;
      appendEnter: boolean;
      items: typeof writableItems;
    }> = [];
    let groupPayload = '';
    let groupItems: typeof writableItems = [];
    for (const item of writableItems) {
      groupPayload += item.payload;
      groupItems.push(item);
      if (item.appendEnter) {
        groups.push({ payload: groupPayload, appendEnter: true, items: groupItems });
        groupPayload = '';
        groupItems = [];
      }
    }
    if (groupItems.length > 0) {
      groups.push({ payload: groupPayload, appendEnter: false, items: groupItems });
    }

    const unresolved = new Set(writableItems);
    const resolveGroup = (group: typeof groups[number], value: boolean) => {
      for (const item of group.items) {
        unresolved.delete(item);
        item.resolve(value);
      }
    };
    const isGroupWritable = (group: typeof groups[number]) =>
      group.items.every((item) => !item.shouldWrite || item.shouldWrite());

    try {
      for (const group of groups) {
        if (!isGroupWritable(group)) {
          resolveGroup(group, false);
          continue;
        }
        if (group.payload) {
          await runTmuxAsync(['send-keys', '-t', mirror.sessionName, '-l', '--', group.payload]);
        }
        if (group.appendEnter) {
          if (!isGroupWritable(group)) {
            resolveGroup(group, false);
            continue;
          }
          await runTmuxAsync(['send-keys', '-t', mirror.sessionName, 'Enter']);
        }
        resolveGroup(group, true);
      }
    } catch (error) {
      for (const item of unresolved) {
        item.reject(error);
      }
    } finally {
      pending.flushing = false;
      if (pending.items.length === 0) {
        liveMirrorInputBatches.delete(mirrorKey);
      } else {
        schedulePendingLiveMirrorInput(mirrorKey);
      }
    }
  }

  function schedulePendingLiveMirrorInput(mirrorKey: string) {
    const pending = liveMirrorInputBatches.get(mirrorKey);
    if (!pending || pending.scheduled || pending.flushing) {
      return;
    }
    pending.scheduled = true;
    queueMicrotask(() => flushPendingLiveMirrorInput(mirrorKey));
  }

  function enqueueLiveMirrorInput(
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    shouldWrite?: () => boolean,
  ) {
    const mirrorKey = deps.getMirrorKey(sessionName);
    let pending = liveMirrorInputBatches.get(mirrorKey);
    if (!pending) {
      pending = {
        items: [],
        scheduled: false,
        flushing: false,
      };
      liveMirrorInputBatches.set(mirrorKey, pending);
    }
    const result = new Promise<boolean>((resolve, reject) => {
      pending?.items.push({
        payload,
        appendEnter,
        shouldWrite,
        resolve,
        reject,
      });
    });
    schedulePendingLiveMirrorInput(mirrorKey);
    return result;
  }

  // R3 closeout: caller MUST invoke this on transport close / mirror destroy /
  // session detach to evict any pending input items for that mirror. Items
  // already flushing are not touched; their promise resolution is driven by
  // the in-flight tmux spawn.
  // Returns the number of items evicted for telemetry.
  function disposeLiveMirrorInputBatch(sessionName: string, reason: string) {
    const mirrorKey = deps.getMirrorKey(sessionName);
    const pending = liveMirrorInputBatches.get(mirrorKey);
    if (!pending) {
      return 0;
    }
    let evicted = 0;
    if (!pending.flushing) {
      const items = pending.items.splice(0);
      for (const item of items) {
        item.resolve(false);
        evicted += 1;
      }
      liveMirrorInputBatches.delete(mirrorKey);
    } else {
      // flushing=true: in-flight tmux spawn cannot be cancelled; drain the
      // items buffer so any further enqueue starts clean. The in-flight spawn
      // resolves naturally; new enqueue creates a fresh batch entry.
      const remaining = pending.items.splice(0);
      for (const item of remaining) {
        item.resolve(false);
        evicted += 1;
      }
    }
    deps.daemonRuntimeDebug?.('input-dispose', {
      mirrorKey,
      reason,
      evicted,
    });
    return evicted;
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
    ensureTmuxServerRunning,
    runTmuxAsync,
    runCommand,
    ensureTmuxSessionAlternateScreenDisabled,
    writeToTmuxSession,
    writeToLiveMirror,
    enqueueLiveMirrorInput,
    disposeLiveMirrorInputBatch,
    listTmuxSessions,
    createDetachedTmuxSession,
    renameTmuxSession,
  };
}
