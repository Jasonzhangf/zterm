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
  ResolvedTerminalSession,
  TerminalSourceAdapter,
  TerminalSessionIdentity,
  TerminalSessionIdentityResolution,
  TerminalSourceKind,
  TmuxTerminalSessionTarget,
} from './terminal-source-adapter';
import {
  buildTmuxSessionStableId,
  parseTerminalSessionStableId,
} from './terminal-source-adapter';

const DEFAULT_MANUAL_TERMINAL_COLS = 80;
const DEFAULT_MANUAL_TERMINAL_ROWS = 80;
const DEFAULT_TMUX_COMMAND_TIMEOUT_MS = 10_000;

export type TerminalControlBackendKind = TerminalSourceKind;

export interface TerminalSessionCatalogEntry {
  name: string;
  backend: 'tmux' | 'herdr';
  stableId?: string;
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
  tmuxCommandTimeoutMs?: number;
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
  runTmuxForSession: (args: string[], sessionName: string) => { ok: true; stdout: string };
  runTmuxAsyncForSession: (args: string[], sessionName: string) => Promise<{ ok: true; stdout: string }>;
  runTmuxAsyncForTarget: (args: string[], target: TmuxTerminalSessionTarget) => Promise<{ ok: true; stdout: string }>;
  runTmuxAcrossSockets: (args: string[]) => { ok: true; stdout: string };
  runTmuxAsyncAcrossSockets: (args: string[]) => Promise<{ ok: true; stdout: string }>;
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
  readSessionIdentity: (target: {
    backend: 'tmux' | 'herdr';
    sessionName: string;
  }) => TerminalSessionIdentity | null;
  resolveExistingSession: (
    stableId: string,
    backend: 'tmux' | 'herdr',
    requestedSessionName?: string,
  ) => TerminalSessionIdentityResolution;
  bindResolvedSession: (session: ResolvedTerminalSession) => void;
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
  const sessionNativeTargets = new Map<string, TmuxTerminalSessionTarget>();

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

  function resolveTmuxCommandTimeoutMs() {
    const configured = deps.tmuxCommandTimeoutMs;
    return Number.isFinite(configured) && configured !== undefined
      ? Math.max(1, Math.floor(configured))
      : DEFAULT_TMUX_COMMAND_TIMEOUT_MS;
  }

  function runTmuxAsyncChild(args: string[], env: Record<string, string>) {
    return new Promise<{ ok: true; stdout: string }>((resolve, reject) => {
      const timeoutMs = resolveTmuxCommandTimeoutMs();
      const child = spawn(deps.tmuxBinary, args, {
        cwd: process.env.HOME || homedir(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish();
      };
      const timer = setTimeout(() => {
        settle(() => {
          child.kill('SIGKILL');
          reject(new Error(`tmux command timed out after ${timeoutMs}ms: ${args.join(' ')}`));
        });
      }, timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        settle(() => reject(error));
      });
      child.on('close', (code) => {
        settle(() => {
          if (code !== 0) {
            reject(new Error(stderr.trim() || `tmux exited with status ${code ?? 'unknown'}`));
            return;
          }
          resolve({ ok: true, stdout });
        });
      });
    });
  }

  function runTmuxAsyncWithSocketPath(args: string[], socketPath: string) {
    return runTmuxAsyncChild(['-S', socketPath, ...args], cleanEnv('default'));
  }

  function resolveSessionSocketPath(sessionName: string) {
    // A pinned native target owns its route. A DEFAULT-socket binding has no
    // socketPath, and that undefined is authoritative: listTmuxSessions keeps
    // rebuilding the discovery cache from the first same-name entry, so it must
    // never override a pinned route.
    const pinned = sessionNativeTargets.get(sessionName);
    if (pinned) return pinned.socketPath;
    return sessionSocketPaths.get(sessionName);
  }

  function resolveExactTmuxSessionTarget(sessionName: string) {
    const nativeTarget = sessionNativeTargets.get(sessionName);
    return nativeTarget
      ? nativeTarget.sessionId
      : buildExactTmuxSessionTarget(sessionName);
  }

  function resolveExactTmuxPaneTarget(sessionName: string) {
    return `${resolveExactTmuxSessionTarget(sessionName)}:.{top-left}`;
  }

  function rewriteTmuxSessionTargets(args: string[], sessionName: string) {
    const byNameSessionTarget = buildExactTmuxSessionTarget(sessionName);
    const byNamePaneTarget = buildExactTmuxPaneTarget(sessionName);
    const exactSessionTarget = resolveExactTmuxSessionTarget(sessionName);
    const exactPaneTarget = resolveExactTmuxPaneTarget(sessionName);
    return args.map((arg) => {
      if (arg === byNameSessionTarget) return exactSessionTarget;
      if (arg === byNamePaneTarget) return exactPaneTarget;
      return arg;
    });
  }

  function runTmuxForSession(args: string[], sessionName: string) {
    const socketPath = resolveSessionSocketPath(sessionName);
    const exactArgs = rewriteTmuxSessionTargets(args, sessionName);
    return socketPath ? runTmuxWithSocketPath(exactArgs, socketPath) : runTmux(exactArgs);
  }

  function runTmuxAsyncForSession(args: string[], sessionName: string) {
    const socketPath = resolveSessionSocketPath(sessionName);
    const exactArgs = rewriteTmuxSessionTargets(args, sessionName);
    return socketPath ? runTmuxAsyncWithSocketPath(exactArgs, socketPath) : runTmuxAsync(exactArgs);
  }

  function runTmuxAsyncForTarget(args: string[], target: TmuxTerminalSessionTarget) {
    return target.socketPath
      ? runTmuxAsyncWithSocketPath(args, target.socketPath)
      : runTmuxAsync(args);
  }

  // Global session/panee enumerations must span every live socket, exactly like
  // listTmuxSessions. Running them on the single latched socket would hide
  // sessions that live on another discovered socket, and would gate
  // session-targeted reads (e.g. capture-pane) on a missing pane fact.
  function tmuxSocketTargets(): Array<string | undefined> {
    return [undefined, ...socketPaths()];
  }

  function runTmuxAcrossSockets(args: string[]): { ok: true; stdout: string } {
    const outputs: string[] = [];
    let firstError: unknown;
    let reached = false;
    for (const socketPath of tmuxSocketTargets()) {
      try {
        const result = socketPath ? runTmuxWithSocketPath(args, socketPath) : runTmux(args);
        // Each tmux stdout is newline-terminated; strip it before joining so a
        // multi-socket merge does not emit a blank boundary line.
        outputs.push(result.stdout.replace(/\n$/u, ''));
        reached = true;
      } catch (error) {
        if (firstError === undefined) firstError = error;
      }
    }
    if (!reached) {
      throw firstError instanceof Error ? firstError : new Error('no reachable tmux socket');
    }
    return { ok: true as const, stdout: outputs.join('\n') };
  }

  async function runTmuxAsyncAcrossSockets(args: string[]): Promise<{ ok: true; stdout: string }> {
    const outputs: string[] = [];
    let firstError: unknown;
    let reached = false;
    for (const socketPath of tmuxSocketTargets()) {
      try {
        const result = socketPath
          ? await runTmuxAsyncWithSocketPath(args, socketPath)
          : await runTmuxAsync(args);
        // Each tmux stdout is newline-terminated; strip it before joining so a
        // multi-socket merge does not emit a blank boundary line.
        outputs.push(result.stdout.replace(/\n$/u, ''));
        reached = true;
      } catch (error) {
        if (firstError === undefined) firstError = error;
      }
    }
    if (!reached) {
      throw firstError instanceof Error ? firstError : new Error('no reachable tmux socket');
    }
    return { ok: true as const, stdout: outputs.join('\n') };
  }

  function readTmuxSessionTargets(): TmuxTerminalSessionTarget[] {
    const targets: TmuxTerminalSessionTarget[] = [];
    let firstError: unknown;
    let reached = false;
    for (const socketPath of tmuxSocketTargets()) {
      try {
        const result = socketPath
          ? runTmuxWithSocketPath([
              'list-sessions',
              '-F',
              '#{session_name}\t#{session_id}\t#{session_created}\t#{pid}',
            ], socketPath)
          : runTmux([
              'list-sessions',
              '-F',
              '#{session_name}\t#{session_id}\t#{session_created}\t#{pid}',
            ]);
        reached = true;
        for (const line of result.stdout.split('\n')) {
          const [sessionNameRaw, sessionId, createdAtRaw, serverPidRaw] = line.split('\t');
          const sessionName = sessionNameRaw?.trim() || '';
          const createdAt = Number.parseInt(createdAtRaw || '', 10);
          const serverPid = serverPidRaw?.trim() || '';
          if (
            !sessionName
            || deps.hiddenTmuxSessions.has(sessionName)
            || !sessionId
            || !Number.isFinite(createdAt)
            || !serverPid
          ) {
            continue;
          }
          targets.push({
            backend: 'tmux',
            sessionName,
            stableId: buildTmuxSessionStableId({
              ...(socketPath ? { socketPath } : {}),
              serverPid,
              sessionId,
              createdAt,
            }),
            ...(socketPath ? { socketPath } : {}),
            serverPid,
            sessionId,
            createdAt,
          });
        }
      } catch (error) {
        if (firstError === undefined) firstError = error;
      }
    }
    if (!reached) {
      throw firstError instanceof Error ? firstError : new Error('no reachable tmux socket');
    }
    return targets;
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
    return runTmuxAsyncChild(args, cleanEnv(socketMode));
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
    const target = resolveExactTmuxPaneTarget(sessionName);
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
    for (const socketPath of tmuxSocketTargets()) {
      try {
        results.push({
          stdout: socketPath
            ? runTmuxWithSocketPath(['list-sessions', '-F', '#S'], socketPath).stdout
            : runTmux(['list-sessions', '-F', '#S']).stdout,
          ...(socketPath ? { socketPath } : {}),
        });
      } catch (error) {
        // The latched socket is authoritative when it answers; a configured
        // socket may also disappear during refresh.
        if (!socketPath && !deps.tmuxSocketPaths) throw error;
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
      const tmuxTargets = selectedBackend === 'tmux'
        ? (() => {
            try {
              return readTmuxSessionTargets();
            } catch {
              return [];
            }
          })()
        : [];
      if (selectedBackend === 'tmux') {
        try {
          const paneResult = runTmuxAcrossSockets(['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}']);
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
      const seenNativeTargets = new Set<string>();
      const distinctTmuxTargets: TmuxTerminalSessionTarget[] = [];
      for (const target of tmuxTargets) {
        const nativeKey = `${target.backend}\u0000${target.serverPid}\u0000${target.sessionId}\u0000${target.createdAt}`;
        if (seenNativeTargets.has(nativeKey)) {
          continue;
        }
        seenNativeTargets.add(nativeKey);
        distinctTmuxTargets.push(target);
      }
      const targetsBySession = new Map<string, TmuxTerminalSessionTarget[]>();
      for (const target of distinctTmuxTargets) {
        const targets = targetsBySession.get(target.sessionName);
        if (targets) {
          targets.push(target);
        } else {
          targetsBySession.set(target.sessionName, [target]);
        }
      }
      for (const sessionName of listTmuxSessions('tmux')) {
        const cwd = cwdBySession.get(sessionName);
        const targets = targetsBySession.get(sessionName) || [];
        if (targets.length === 0) {
          entries.push({
            name: sessionName,
            backend: 'tmux',
            ...(cwd ? { cwd } : {}),
          });
          continue;
        }
        for (const target of targets) {
          entries.push({
            name: sessionName,
            backend: 'tmux',
            stableId: target.stableId,
            ...(targets.length === 1 && cwd ? { cwd } : {}),
          });
        }
      }
    }
    if (deps.backendRuntimes?.herdr || deps.defaultBackend === 'herdr') {
      for (const sessionName of listTmuxSessions('herdr')) {
        const session = deps.backendRuntimes?.herdr?.listSessions().find((item) => item.sessionName === sessionName);
        const stableId = deps.backendRuntimes?.herdr?.readSessionIdentity?.(sessionName)?.stableId
          || session?.stableId;
        entries.push({
          name: sessionName,
          backend: 'herdr',
          ...(stableId ? { stableId } : {}),
          ...(session?.cwd ? { cwd: session.cwd } : {}),
        });
      }
    }
    return entries.sort((left, right) => {
      const nameOrder = left.name.localeCompare(right.name);
      const backendOrder = left.backend.localeCompare(right.backend);
      return nameOrder
        || backendOrder
        || (left.stableId || '').localeCompare(right.stableId || '');
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

  function readSessionIdentity(target: {
    backend: 'tmux' | 'herdr';
    sessionName: string;
  }): TerminalSessionIdentity | null {
    const sessionName = deps.sanitizeSessionName(target.sessionName);
    if (target.backend === 'herdr') {
      const herdr = deps.backendRuntimes?.herdr;
      return herdr?.readSessionIdentity?.(sessionName) || null;
    }

    const targets = readTmuxSessionTargets();
    const pinned = sessionNativeTargets.get(sessionName);
    const pinnedTarget = pinned
      ? targets.find((entry) =>
          entry.stableId === pinned.stableId
          && entry.socketPath === pinned.socketPath)
      : null;
    const matches = pinnedTarget
      ? [pinnedTarget]
      : targets.filter((entry) => entry.sessionName === sessionName);
    if (matches.length > 1) {
      throw new Error(`terminal session identity is ambiguous: ${sessionName}`);
    }
    const resolved = matches[0];
    if (!resolved) {
      return null;
    }
    return {
      backend: 'tmux',
      sessionName: resolved.sessionName,
      stableId: resolved.stableId,
    };
  }

  function resolveExistingSession(
    stableId: string,
    backend: 'tmux' | 'herdr',
    requestedSessionName?: string,
  ): TerminalSessionIdentityResolution {
    const parsed = parseTerminalSessionStableId(stableId);
    if (!parsed || parsed.backend !== backend) {
      return {
        ok: false,
        code: 'session_identity_mismatch',
        message: `expected session identity does not belong to backend ${backend}`,
      };
    }

    let resolved: ResolvedTerminalSession | null = null;
    if (backend === 'tmux') {
      const target = readTmuxSessionTargets().find((entry) => entry.stableId === stableId);
      if (target) {
        resolved = {
          identity: {
            backend: 'tmux',
            sessionName: target.sessionName,
            stableId: target.stableId,
          },
          target,
        };
      }
    } else {
      resolved = deps.backendRuntimes?.herdr?.resolveExistingSession?.(stableId) || null;
    }
    if (resolved?.identity.stableId === stableId) {
      return { ok: true, session: resolved };
    }

    const requestedName = requestedSessionName
      ? deps.sanitizeSessionName(requestedSessionName)
      : '';
    if (requestedName) {
      try {
        if (readSessionIdentity({ backend, sessionName: requestedName })) {
          return {
            ok: false,
            code: 'session_identity_mismatch',
            message: `display name ${requestedName} belongs to a different ${backend} session identity`,
          };
        }
      } catch {
        // Ambiguous display names cannot establish an identity match.
        return {
          ok: false,
          code: 'session_identity_mismatch',
          message: `display name ${requestedName} is ambiguous for ${backend}`,
        };
      }
    }
    return {
      ok: false,
      code: 'session_not_found',
      message: `${backend} session identity is no longer present`,
    };
  }

  function bindResolvedSession(session: ResolvedTerminalSession) {
    if (session.target.backend === 'herdr') {
      deps.backendRuntimes?.herdr?.bindResolvedSession?.(session);
      return;
    }
    const existing = sessionNativeTargets.get(session.target.sessionName);
    if (existing && existing.stableId !== session.target.stableId) {
      const existingStillLive = readTmuxSessionTargets().some((entry) =>
        entry.stableId === existing.stableId
        && entry.socketPath === existing.socketPath);
      if (existingStillLive) {
        throw new Error(
          `session name ${session.target.sessionName} is already bound to a different live tmux identity`,
        );
      }
    }
    sessionNativeTargets.set(session.target.sessionName, session.target);
    sessionSocketPaths.set(session.target.sessionName, session.target.socketPath);
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
    const target = readTmuxSessionTargets().find((entry) => entry.sessionName === sessionName);
    if (target) {
      bindResolvedSession({
        identity: {
          backend: 'tmux',
          sessionName,
          stableId: target.stableId,
        },
        target,
      });
    }
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
    sessionSocketPaths.delete(sessionName);
    sessionNativeTargets.delete(sessionName);
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
    const socketPath = sessionSocketPaths.get(sessionName);
    const nativeTarget = sessionNativeTargets.get(sessionName);
    sessionSocketPaths.set(nextSessionName, socketPath);
    if (nativeTarget) {
      sessionNativeTargets.set(nextSessionName, {
        ...nativeTarget,
        sessionName: nextSessionName,
      });
    }
    sessionSocketPaths.delete(sessionName);
    sessionNativeTargets.delete(sessionName);
    return nextSessionName;
  }

  return {
    runTmux,
    ensureTmuxServerRunning,
    runTmuxAsync,
    runTmuxForSession,
    runTmuxAsyncForSession,
    runTmuxAsyncForTarget,
    runTmuxAcrossSockets,
    runTmuxAsyncAcrossSockets,
    runCommand,
    writeBackendInputGroup,
    resolveBackendInputMaxChunkBytes,
    listTmuxSessions,
    listTerminalSessions,
    listTerminalSessionCatalog,
    readSessionIdentity,
    resolveExistingSession,
    bindResolvedSession,
    resolveTerminalSessionBackend,
    createDetachedTmuxSession,
    closeDetachedTerminalSession,
    renameTmuxSession,
    buildExactTmuxSessionTarget,
    buildExactTmuxPaneTarget,
  };
}
