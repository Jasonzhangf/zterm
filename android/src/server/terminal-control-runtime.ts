import { spawn, spawnSync } from 'child_process';
import { mkdirSync, readdirSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  TERMINAL_INPUT_CHUNK_BYTES,
  TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES,
  TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS,
} from '@zterm/shared/terminal/input-chunking';
import type {
  TerminalSourceAdapter,
  TerminalSourceKind,
} from './terminal-source-adapter';

const DEFAULT_MANUAL_TERMINAL_COLS = 80;
const DEFAULT_MANUAL_TERMINAL_ROWS = 80;

export type TerminalControlBackendKind = TerminalSourceKind;

export interface TerminalSessionCatalogEntry {
  name: string;
  backend: 'tmux' | 'herdr';
  cwd?: string;
}

export interface TerminalControlRuntimeDeps {
  tmuxBinary: string;
  defaultSessionName: string;
  hiddenTmuxSessions: Set<string>;
  tmuxSocketDir?: string;
  tmuxSocketPaths?: () => string[];
  sanitizeSessionName: (input?: string) => string;
  daemonRuntimeDebug?: (scope: string, payload?: unknown) => void;
  wezTermBackend?: TerminalSourceAdapter | null;
  backendRuntimes?: Partial<Record<'herdr' | 'wezterm', TerminalSourceAdapter>>;
  defaultBackend?: TerminalControlBackendKind;
}

/** Enumerate live tmux sockets without persisting a session catalog. */
export function discoverTmuxSocketPaths(options: {
  stableSocketDir?: string;
  cliDefaultRoot?: string;
  uid?: number;
} = {}) {
  const uid = options.uid ?? process.getuid?.();
  const socketDirName = uid === undefined ? undefined : `tmux-${uid}`;
  const roots = [process.env.TMUX_TMPDIR || tmpdir(), options.cliDefaultRoot ?? '/tmp', options.stableSocketDir]
    .filter((root): root is string => Boolean(root));
  const paths = new Set<string>();
  for (const root of roots) {
    const directory = socketDirName ? join(root, socketDirName) : root;
    let entries: string[];
    try {
      entries = socketDirName ? readdirSync(directory) : [];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const socketPath = join(directory, entry);
      try {
        if (
          statSync(socketPath).isSocket()
          && (entry === 'default' || root === options.stableSocketDir)
        ) {
          paths.add(socketPath);
        }
      } catch {
        // Socket may disappear during a live refresh.
      }
    }
  }
  return [...paths].sort();
}

export interface TerminalControlRuntime {
  runTmux: (args: string[]) => { ok: true; stdout: string };
  runTmuxAsync: (args: string[]) => Promise<{ ok: true; stdout: string }>;
  runCommand: (command: string, args: string[]) => ReturnType<typeof spawnSync>;
  ensureTmuxServerRunning: () => void;
  writeBackendInputGroup: (
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    backend?: TerminalControlBackendKind,
  ) => Promise<void>;
  resolveBackendInputMaxChunkBytes: () => number;
  listTmuxSessions: (backend?: TerminalControlBackendKind) => string[];
  listTerminalSessions: () => string[];
  listTerminalSessionCatalog: () => TerminalSessionCatalogEntry[];
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
  type TmuxSocketMode = 'default' | 'stable';
  let tmuxSocketMode: TmuxSocketMode = 'default';
  let tmuxSocketPathOverride: string | undefined;
  const sessionSocketPaths = new Map<string, string | undefined>();

  function socketPaths() {
    return [...new Set((deps.tmuxSocketPaths?.() || []).filter(Boolean))];
  }

  function runTmuxWithSocketPath(args: string[], socketPath: string) {
    const result = spawnSync(deps.tmuxBinary, ['-S', socketPath, ...args], {
      encoding: 'utf-8',
      cwd: process.env.HOME || homedir(),
      env: cleanEnv('default'),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() || '';
      throw new Error(stderr || `tmux exited with status ${result.status}`);
    }
    return { ok: true as const, stdout: result.stdout || '' };
  }

  function runTmuxAsyncWithSocketPath(args: string[], socketPath: string) {
    return new Promise<{ ok: true; stdout: string }>((resolve, reject) => {
      const child = spawn(deps.tmuxBinary, ['-S', socketPath, ...args], {
        cwd: process.env.HOME || homedir(),
        env: cleanEnv('default'),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `tmux exited with status ${code ?? 'unknown'}`));
          return;
        }
        resolve({ ok: true, stdout });
      });
    });
  }

  function resolveSessionSocketPath(sessionName: string) {
    return sessionSocketPaths.get(sessionName);
  }

  function runTmuxForSession(args: string[], sessionName: string) {
    const socketPath = resolveSessionSocketPath(sessionName);
    return socketPath ? runTmuxWithSocketPath(args, socketPath) : runTmux(args);
  }

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

  function cleanEnv(socketMode: TmuxSocketMode = tmuxSocketMode): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.TMUX_TMPDIR;
    if (socketMode === 'stable') {
      if (!deps.tmuxSocketDir) {
        throw new Error('stable tmux socket directory is not configured');
      }
      env.TMUX_TMPDIR = deps.tmuxSocketDir;
    }
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

  function runTmuxWithSocketMode(args: string[], socketMode: TmuxSocketMode) {
    const result = spawnSync(deps.tmuxBinary, args, {
      encoding: 'utf-8',
      cwd: process.env.HOME || homedir(),
      env: cleanEnv(socketMode),
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.trim() || '';
      throw new Error(stderr || `tmux exited with status ${result.status}`);
    }

    return { ok: true as const, stdout: result.stdout || '' };
  }

  function runTmux(args: string[]) {
    if (tmuxSocketPathOverride) return runTmuxWithSocketPath(args, tmuxSocketPathOverride);
    return runTmuxWithSocketMode(args, tmuxSocketMode);
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

  function runTmuxAsyncWithSocketMode(args: string[], socketMode: TmuxSocketMode) {
    return new Promise<{ ok: true; stdout: string }>((resolve, reject) => {
      const child = spawn(deps.tmuxBinary, args, {
        cwd: process.env.HOME || homedir(),
        env: cleanEnv(socketMode),
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
          reject(new Error(trimmedStderr || `tmux exited with status ${code ?? 'unknown'}`));
          return;
        }
        resolve({ ok: true, stdout });
      });
    });
  }

  function runTmuxAsync(args: string[]) {
    if (tmuxSocketPathOverride) return runTmuxAsyncWithSocketPath(args, tmuxSocketPathOverride);
    return runTmuxAsyncWithSocketMode(args, tmuxSocketMode);
  }

  function ensureTmuxServerRunning() {
    const keepalive = 'zterm-daemon-keepalive';
    // Reuse an already-running interactive tmux server so its live sessions stay
    // visible. If the default socket is unavailable, daemon-owned tmux uses the
    // stable ~/.zterm/tmux directory; no session catalog is persisted to disk.
    try {
      runTmuxWithSocketMode(['list-sessions'], 'default');
      tmuxSocketMode = 'default';
      tmuxSocketPathOverride = undefined;
      return;
    } catch {
      // The default socket may be absent while another live user socket exists.
      for (const socketPath of socketPaths()) {
        try {
          runTmuxWithSocketPath(['list-sessions'], socketPath);
          tmuxSocketPathOverride = socketPath;
          return;
        } catch {
          // Probe the next live socket.
        }
      }
      // No reachable user server; select the stable daemon-owned socket.
    }

    if (!deps.tmuxSocketDir) {
      throw new Error('tmux default socket is unavailable and no stable socket directory is configured');
    }
    mkdirSync(deps.tmuxSocketDir, { recursive: true });
    tmuxSocketMode = 'stable';
    tmuxSocketPathOverride = undefined;

    try {
      runTmux(['has-session', '-t', buildExactTmuxSessionTarget(keepalive)]);
      return;
    } catch {
      // Stable server or keepalive session is missing; create both below.
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

  async function writeBackendInputGroup(
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    backendKind?: TerminalControlBackendKind,
  ) {
    const externalBackend = resolveExternalBackend(backendKind);
    if (externalBackend) {
      if (payload) {
        externalBackend.writeInput(sessionName, payload);
      }
      if (appendEnter) {
        externalBackend.writeInput(sessionName, '\r');
      }
      return;
    }
    const target = buildExactTmuxPaneTarget(sessionName);
    if (payload) {
      const segments = payload.split('\x04');
      for (let index = 0; index < segments.length; index += 1) {
        if (segments[index]) {
          const socketPath = resolveSessionSocketPath(sessionName);
          if (socketPath) {
            await runTmuxAsyncWithSocketPath(['send-keys', '-t', target, '-l', '--', segments[index]!], socketPath);
          } else {
            await runTmuxAsync(['send-keys', '-t', target, '-l', '--', segments[index]!]);
          }
        }
        if (index < segments.length - 1) {
          const socketPath = resolveSessionSocketPath(sessionName);
          if (socketPath) {
            await runTmuxAsyncWithSocketPath(['send-keys', '-H', '-t', target, '04'], socketPath);
          } else {
            await runTmuxAsync(['send-keys', '-H', '-t', target, '04']);
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS);
          });
        }
      }
    }
    if (appendEnter) {
      const socketPath = resolveSessionSocketPath(sessionName);
      if (socketPath) {
        await runTmuxAsyncWithSocketPath(['send-keys', '-t', target, 'Enter'], socketPath);
      } else {
        await runTmuxAsync(['send-keys', '-t', target, 'Enter']);
      }
    }
  }

  function resolveBackendInputMaxChunkBytes() {
    return resolveExternalBackend(deps.defaultBackend || (deps.wezTermBackend ? 'wezterm' : 'tmux'))
      ? TERMINAL_INPUT_CHUNK_BYTES
      : TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES;
  }

  function listTmuxSessions(backendKind?: TerminalControlBackendKind) {
    const externalBackend = resolveExternalBackend(backendKind);
    if (externalBackend) {
      return externalBackend.listSessions().map((session) => session.sessionName);
    }
    sessionSocketPaths.clear();
    const results: Array<{ stdout: string; socketPath?: string }> = [];
    try {
      results.push({ stdout: runTmux(['list-sessions', '-F', '#S']).stdout });
    } catch (error) {
      if (!deps.tmuxSocketPaths) throw error;
    }
    if (deps.tmuxSocketPaths) {
      for (const socketPath of socketPaths()) {
        try {
          results.push({ stdout: runTmuxWithSocketPath(['list-sessions', '-F', '#S'], socketPath).stdout, socketPath });
        } catch {
          // A configured socket may disappear during refresh.
        }
      }
    }
    if (results.length === 0) throw new Error('no reachable tmux socket');
    const sessions: string[] = [];
    for (const result of results) {
      for (const line of result.stdout.split('\n').map((value) => value.trim())) {
        if (!line || deps.hiddenTmuxSessions.has(line)) continue; // visible iff !deps.hiddenTmuxSessions.has(line)
        if (!sessionSocketPaths.has(line)) sessionSocketPaths.set(line, result.socketPath);
        if (!sessions.includes(line)) sessions.push(line);
      }
    }
    return sessions;
  }

  function buildTerminalSessionCatalog(): TerminalSessionCatalogEntry[] {
    const entries: TerminalSessionCatalogEntry[] = [];
    const selectedBackend = deps.defaultBackend || (deps.wezTermBackend ? 'wezterm' : 'tmux');
    if (selectedBackend === 'tmux' || selectedBackend === 'wezterm') {
      const cwdBySession = new Map<string, string>();
      if (selectedBackend === 'tmux') {
        try {
          const paneResult = runTmux(['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}']);
          for (const line of paneResult.stdout.split('\n')) {
            const [sessionName, cwd] = line.split('\t');
            if (sessionName?.trim() && cwd?.trim() && !cwdBySession.has(sessionName.trim())) {
              cwdBySession.set(sessionName.trim(), cwd.trim());
            }
          }
        } catch {
          // Session names remain authoritative when pane metadata is unavailable.
        }
      }
      for (const sessionName of listTmuxSessions('tmux')) {
        const cwd = cwdBySession.get(sessionName);
        entries.push({ name: sessionName, backend: 'tmux', ...(cwd ? { cwd } : {}) });
      }
    }
    if (deps.backendRuntimes?.herdr || deps.defaultBackend === 'herdr') {
      for (const sessionName of listTmuxSessions('herdr')) {
        const session = deps.backendRuntimes?.herdr?.listSessions().find((item) => item.sessionName === sessionName);
        entries.push({ name: sessionName, backend: 'herdr', ...(session?.cwd ? { cwd: session.cwd } : {}) });
      }
    }
    return entries.sort((left, right) => {
      const nameOrder = left.name.localeCompare(right.name);
      return nameOrder || left.backend.localeCompare(right.backend);
    });
  }

  function listTerminalSessionCatalog() {
    return buildTerminalSessionCatalog();
  }

  function listTerminalSessions() {
    return [...new Set(listTerminalSessionCatalog().map((entry) => entry.name))].sort((left, right) => left.localeCompare(right));
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
    const args = [
      'new-session', '-d', '-s', sessionName,
      '-x', String(DEFAULT_MANUAL_TERMINAL_COLS),
      '-y', String(DEFAULT_MANUAL_TERMINAL_ROWS),
    ];
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
    runTmuxForSession(['kill-session', '-t', buildExactTmuxSessionTarget(sessionName)], sessionName);
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
    runTmuxForSession(['rename-session', '-t', buildExactTmuxSessionTarget(sessionName), nextSessionName], sessionName);
    sessionSocketPaths.set(nextSessionName, sessionSocketPaths.get(sessionName));
    sessionSocketPaths.delete(sessionName);
    return nextSessionName;
  }

  return {
    runTmux,
    ensureTmuxServerRunning,
    runTmuxAsync,
    runCommand,
    writeBackendInputGroup,
    resolveBackendInputMaxChunkBytes,
    listTmuxSessions,
    listTerminalSessions,
    listTerminalSessionCatalog,
    resolveTerminalSessionBackend,
    createDetachedTmuxSession,
    closeDetachedTerminalSession,
    renameTmuxSession,
    buildExactTmuxSessionTarget,
    buildExactTmuxPaneTarget,
  };
}
