import { spawn, spawnSync } from 'child_process';
import { homedir } from 'os';
import {
  TERMINAL_INPUT_CHUNK_BYTES,
  TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES,
  TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS,
  getTerminalInputUtf8ByteLength,
  splitTerminalInputUtf8Chunks,
} from '@zterm/shared/terminal/input-chunking';
import type { SessionMirror } from './terminal-runtime-types';
import type { WezTermBackendRuntime } from './wezterm-backend';

export type TerminalControlBackendKind = 'tmux' | 'herdr' | 'wezterm';

export interface TerminalControlRuntimeDeps {
  tmuxBinary: string;
  defaultSessionName: string;
  hiddenTmuxSessions: Set<string>;
  mirrors: Map<string, SessionMirror>;
  tmuxSocketDir?: string;
  getMirrorKey: (sessionName: string, backend?: 'tmux' | 'herdr') => string;
  sanitizeSessionName: (input?: string) => string;
  daemonRuntimeDebug?: (scope: string, payload?: unknown) => void;
  wezTermBackend?: WezTermBackendRuntime | null;
  backendRuntimes?: Partial<Record<'herdr' | 'wezterm', WezTermBackendRuntime>>;
  defaultBackend?: TerminalControlBackendKind;
}

export interface TerminalControlRuntime {
  runTmux: (args: string[]) => { ok: true; stdout: string };
  runTmuxAsync: (args: string[]) => Promise<{ ok: true; stdout: string }>;
  runCommand: (command: string, args: string[]) => ReturnType<typeof spawnSync>;
  writeToTmuxSession: (sessionName: string, payload: string, appendEnter: boolean, backend?: TerminalControlBackendKind) => void;
  ensureTmuxServerRunning: () => void;
  writeToLiveMirror: (sessionName: string, payload: string, appendEnter: boolean, backend?: TerminalControlBackendKind) => boolean;
  enqueueLiveMirrorInput: (
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    shouldWrite?: () => boolean,
    backend?: TerminalControlBackendKind,
  ) => Promise<boolean>;
  disposeLiveMirrorInputBatch: (sessionName: string, reason: string, backend?: TerminalControlBackendKind) => number;
  listTmuxSessions: (backend?: TerminalControlBackendKind) => string[];
  listTerminalSessions: () => string[];
  resolveTerminalSessionBackend: (sessionName: string) => Exclude<TerminalControlBackendKind, 'wezterm'>;
  createDetachedTmuxSession: (input?: string, cwd?: string, backend?: TerminalControlBackendKind) => string;
  closeDetachedTerminalSession: (sessionName: string, backend?: TerminalControlBackendKind) => void;
  renameTmuxSession: (currentName?: string, nextName?: string, backend?: TerminalControlBackendKind) => string;
  buildExactTmuxSessionTarget: (sessionName: string) => string;
  buildExactTmuxPaneTarget: (sessionName: string) => string;
}

export function buildExactTmuxSessionTarget(sessionName: string) {
  const normalized = sessionName.trim();
  if (!normalized) {
    throw new Error('tmux exact session target requires a session name');
  }
  return `=${normalized}`;
}

export function buildExactTmuxPaneTarget(sessionName: string) {
  return `${buildExactTmuxSessionTarget(sessionName)}:.{top-left}`;
}

export function createTerminalControlRuntime(
  deps: TerminalControlRuntimeDeps,
): TerminalControlRuntime {
  type LiveMirrorInputItem = {
    payload: string;
    appendEnter: boolean;
    shouldWrite?: () => boolean;
    resolve: (value: boolean) => void;
    reject: (reason?: unknown) => void;
  };
  type LiveMirrorInputGroup = {
    payload: string;
    appendEnter: boolean;
    items: LiveMirrorInputItem[];
  };
  function resolveExternalBackend(kind = deps.defaultBackend || (deps.wezTermBackend ? 'wezterm' : 'tmux')) {
    const effectiveKind = kind === 'tmux' && deps.defaultBackend === 'wezterm' ? 'wezterm' : kind;
    if (effectiveKind === 'tmux') {
      return null;
    }
    const backend = deps.backendRuntimes?.[effectiveKind] || (effectiveKind === 'wezterm' ? deps.wezTermBackend : null);
    if (!backend) {
      throw new Error(`${effectiveKind} backend is not available`);
    }
    return backend;
  }
  const liveMirrorInputBatches = new Map<string, {
    items: LiveMirrorInputItem[];
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

  function isTmuxNoServerForListSessions(stderr: string, args: string[]) {
    if (args[0] !== 'list-sessions') {
      return false;
    }
    return stderr.includes('no server running on')
      || (stderr.includes('error connecting to') && stderr.includes('No such file or directory'));
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
      if (isTmuxNoServerForListSessions(stderr, args)) {
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
          if (isTmuxNoServerForListSessions(trimmedStderr, args)) {
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

  function sleepTmuxWriteSettleSync() {
    if (TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS <= 0) {
      return;
    }
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS,
    );
  }

  function sleepTmuxWriteSettleAsync() {
    if (TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      setTimeout(resolve, TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS);
    });
  }

  function writeTmuxLiteralChunksSync(payload: string, target: string) {
    const chunks = splitTerminalInputUtf8Chunks(
      payload,
      TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES,
    );
    for (let index = 0; index < chunks.length; index += 1) {
      runTmux(['send-keys', '-t', target, '-l', '--', chunks[index]!]);
      if (index < chunks.length - 1) {
        sleepTmuxWriteSettleSync();
      }
    }
  }

  // Daemon shares the system-default tmux socket so that sessions created by
  // the user's interactive `tmux` shell are visible to the client and vice
  // versa. Using a private socket would hide user sessions and break the
  // "all sessions visible" requirement.
  function ensureTmuxServerRunning() {
    const keepalive = 'zterm-daemon-keepalive';
    // If server is already running (user's or ours), just ensure keepalive exists
    try {
      runTmux(['has-session', '-t', buildExactTmuxSessionTarget(keepalive)]);
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

  function writeToTmuxSession(sessionName: string, payload: string, appendEnter: boolean, backendKind?: TerminalControlBackendKind) {
    const externalBackend = resolveExternalBackend(backendKind);
    if (externalBackend) {
      const chunks = splitTerminalInputUtf8Chunks(payload, TERMINAL_INPUT_CHUNK_BYTES);
      if (chunks.length <= 1) {
        externalBackend.writeInput(sessionName, `${chunks[0] || ''}${appendEnter ? '\r' : ''}`);
        return;
      }
      for (const chunk of chunks) {
        externalBackend.writeInput(sessionName, chunk);
      }
      if (appendEnter) {
        externalBackend.writeInput(sessionName, '\r');
      }
      return;
    }
    const target = buildExactTmuxPaneTarget(sessionName);
    writeTmuxLiteralChunksSync(payload, target);
    if (appendEnter) {
      runTmux(['send-keys', '-t', target, 'Enter']);
    }
  }

  function writeToLiveMirror(sessionName: string, payload: string, appendEnter: boolean, backendKind?: TerminalControlBackendKind) {
    const mirror = deps.mirrors.get(deps.getMirrorKey(sessionName, backendKind === 'herdr' ? 'herdr' : 'tmux'));
    if (!mirror || mirror.lifecycle !== 'ready') {
      return false;
    }
    const externalBackend = resolveExternalBackend(backendKind);
    if (externalBackend) {
      const chunks = splitTerminalInputUtf8Chunks(payload, TERMINAL_INPUT_CHUNK_BYTES);
      if (chunks.length <= 1) {
        externalBackend.writeInput(sessionName, `${chunks[0] || ''}${appendEnter ? '\r' : ''}`);
        return true;
      }
      for (const chunk of chunks) {
        externalBackend.writeInput(sessionName, chunk);
      }
      if (appendEnter) {
        externalBackend.writeInput(sessionName, '\r');
      }
      return true;
    }
    const target = buildExactTmuxPaneTarget(sessionName);
    writeTmuxLiteralChunksSync(payload, target);
    if (appendEnter) {
      runTmux(['send-keys', '-t', target, 'Enter']);
    }
    return true;
  }

  function buildLiveMirrorInputGroups(items: LiveMirrorInputItem[]): LiveMirrorInputGroup[] {
    const maxGroupBytes = resolveExternalBackend(deps.defaultBackend || (deps.wezTermBackend ? 'wezterm' : 'tmux'))
      ? TERMINAL_INPUT_CHUNK_BYTES
      : TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES;
    const groups: LiveMirrorInputGroup[] = [];
    let groupPayload = '';
    let groupBytes = 0;
    const groupItems = new Set<LiveMirrorInputItem>();
    const flushGroup = (appendEnter: boolean) => {
      if (!groupPayload && groupItems.size === 0 && !appendEnter) {
        return;
      }
      groups.push({
        payload: groupPayload,
        appendEnter,
        items: Array.from(groupItems),
      });
      groupPayload = '';
      groupBytes = 0;
      groupItems.clear();
    };

    for (const item of items) {
      const chunks = splitTerminalInputUtf8Chunks(item.payload, maxGroupBytes);
      if (chunks.length === 0) {
        groupItems.add(item);
        if (item.appendEnter) {
          flushGroup(true);
        }
        continue;
      }
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const chunkBytes = getTerminalInputUtf8ByteLength(chunk);
        if (groupBytes > 0 && groupBytes + chunkBytes > maxGroupBytes) {
          flushGroup(false);
        }
        groupPayload += chunk;
        groupBytes += chunkBytes;
        groupItems.add(item);
        if (item.appendEnter && index === chunks.length - 1) {
          flushGroup(true);
        }
      }
    }

    flushGroup(false);
    return groups;
  }

  function createLiveMirrorInputGroupSettler(
    writableItems: LiveMirrorInputItem[],
    groups: LiveMirrorInputGroup[],
  ) {
    const unresolved = new Set(writableItems);
    const failedItems = new Set<LiveMirrorInputItem>();
    const pendingGroupCounts = new Map<LiveMirrorInputItem, number>();
    for (const group of groups) {
      for (const item of group.items) {
        pendingGroupCounts.set(item, (pendingGroupCounts.get(item) || 0) + 1);
      }
    }
    const settleGroup = (group: LiveMirrorInputGroup, value: boolean) => {
      for (const item of group.items) {
        if (!unresolved.has(item)) {
          continue;
        }
        if (!value) {
          failedItems.add(item);
        }
        const nextCount = (pendingGroupCounts.get(item) || 1) - 1;
        if (nextCount > 0) {
          pendingGroupCounts.set(item, nextCount);
          continue;
        }
        pendingGroupCounts.delete(item);
        unresolved.delete(item);
        item.resolve(!failedItems.has(item));
      }
    };
    return {
      unresolved,
      settleGroup,
    };
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

    const groups = buildLiveMirrorInputGroups(writableItems);
    const { unresolved, settleGroup } = createLiveMirrorInputGroupSettler(writableItems, groups);
    const isGroupWritable = (group: LiveMirrorInputGroup) =>
      group.items.every((item) => !item.shouldWrite || item.shouldWrite());

    const externalBackend = resolveExternalBackend(mirror.backend);
    if (externalBackend) {
      try {
        for (const group of groups) {
          if (!isGroupWritable(group)) {
            settleGroup(group, false);
            continue;
          }
          if (group.payload) {
            externalBackend.writeInput(mirror.sessionName, group.payload);
          }
          if (group.appendEnter) {
            if (!isGroupWritable(group)) {
              settleGroup(group, false);
              continue;
            }
            externalBackend.writeInput(mirror.sessionName, '\r');
          }
          settleGroup(group, true);
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
      return;
    }

    try {
      const target = buildExactTmuxPaneTarget(mirror.sessionName);
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        const group = groups[groupIndex]!;
        if (!isGroupWritable(group)) {
          settleGroup(group, false);
          continue;
        }
        if (group.payload) {
          await runTmuxAsync(['send-keys', '-t', target, '-l', '--', group.payload]);
        }
        if (group.appendEnter) {
          if (!isGroupWritable(group)) {
            settleGroup(group, false);
            continue;
          }
          await runTmuxAsync(['send-keys', '-t', target, 'Enter']);
        }
        settleGroup(group, true);
        if (groupIndex < groups.length - 1) {
          await sleepTmuxWriteSettleAsync();
        }
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
    backendKind?: TerminalControlBackendKind,
  ) {
    const mirrorKey = deps.getMirrorKey(sessionName, backendKind === 'herdr' ? 'herdr' : 'tmux');
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
  function disposeLiveMirrorInputBatch(sessionName: string, reason: string, backendKind?: TerminalControlBackendKind) {
    const mirrorKey = deps.getMirrorKey(sessionName, backendKind === 'herdr' ? 'herdr' : 'tmux');
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

  function listTmuxSessions(backendKind?: TerminalControlBackendKind) {
    const externalBackend = resolveExternalBackend(backendKind);
    if (externalBackend) {
      return externalBackend.listSessions().map((session) => session.sessionName);
    }
    const result = runTmux(['list-sessions', '-F', '#S']);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => Boolean(line) && !deps.hiddenTmuxSessions.has(line));
  }

  function listTerminalSessions() {
    const sessions = new Set<string>();
    if (deps.defaultBackend !== 'herdr') {
      for (const sessionName of listTmuxSessions('tmux')) {
        sessions.add(sessionName);
      }
    }
    if (deps.backendRuntimes?.herdr || deps.defaultBackend === 'herdr') {
      for (const sessionName of listTmuxSessions('herdr')) {
        sessions.add(sessionName);
      }
    }
    return [...sessions].sort((left, right) => left.localeCompare(right));
  }

  function resolveTerminalSessionBackend(sessionName: string): Exclude<TerminalControlBackendKind, 'wezterm'> {
    const normalized = deps.sanitizeSessionName(sessionName);
    if (deps.defaultBackend === 'wezterm') {
      if (!listTmuxSessions('tmux').includes(normalized)) {
        throw new Error(`wezterm session not found: ${normalized}`);
      }
      return 'tmux';
    }
    const matches: Array<Exclude<TerminalControlBackendKind, 'wezterm'>> = [];
    if (deps.defaultBackend !== 'herdr' && listTmuxSessions('tmux').includes(normalized)) {
      matches.push('tmux');
    }
    if (deps.backendRuntimes?.herdr || deps.defaultBackend === 'herdr') {
      if (listTmuxSessions('herdr').includes(normalized)) matches.push('herdr');
    }
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `terminal session not found: ${normalized}`
        : `terminal session backend is ambiguous: ${normalized}`);
    }
    return matches[0]!;
  }

  function createDetachedTmuxSession(input?: string, cwd?: string, backendKind?: TerminalControlBackendKind) {
    const externalBackend = resolveExternalBackend(backendKind);
    if (externalBackend) {
      return externalBackend.createSession({ sessionName: input, cwd }).sessionName;
    }
    const sessionName = deps.sanitizeSessionName(input || deps.defaultSessionName);
    const args = ['new-session', '-d', '-s', sessionName];
    if (cwd) {
      args.push('-c', cwd);
    }
    runTmux(args);
    return sessionName;
  }

  function closeDetachedTerminalSession(input: string, backendKind?: TerminalControlBackendKind) {
    const sessionName = deps.sanitizeSessionName(input);
    const externalBackend = resolveExternalBackend(backendKind);
    if (externalBackend) {
      externalBackend.closeSession(sessionName);
      return;
    }
    runTmux(['kill-session', '-t', buildExactTmuxSessionTarget(sessionName)]);
  }

  function renameTmuxSession(currentName?: string, nextName?: string, backendKind?: TerminalControlBackendKind) {
    const externalBackend = resolveExternalBackend(backendKind);
    if (externalBackend) {
      if (externalBackend.supportsSessionRename === false) {
        throw new Error('selected terminal backend does not support session rename');
      }
      if (externalBackend.renameSession) {
        return externalBackend.renameSession(
          deps.sanitizeSessionName(currentName),
          deps.sanitizeSessionName(nextName),
        );
      }
      throw new Error(`${backendKind || 'external'} backend does not support session rename`);
    }
    const sessionName = deps.sanitizeSessionName(currentName);
    const nextSessionName = deps.sanitizeSessionName(nextName);
    runTmux(['rename-session', '-t', buildExactTmuxSessionTarget(sessionName), nextSessionName]);
    return nextSessionName;
  }

  return {
    runTmux,
    ensureTmuxServerRunning,
    runTmuxAsync,
    runCommand,
    writeToTmuxSession,
    writeToLiveMirror,
    enqueueLiveMirrorInput,
    disposeLiveMirrorInputBatch,
    listTmuxSessions,
    listTerminalSessions,
    resolveTerminalSessionBackend,
    createDetachedTmuxSession,
    closeDetachedTerminalSession,
    renameTmuxSession,
    buildExactTmuxSessionTarget,
    buildExactTmuxPaneTarget,
  };
}
