import { spawn, spawnSync } from 'child_process';
import { homedir } from 'os';
import {
  TERMINAL_INPUT_CHUNK_BYTES,
  TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES,
  TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS,
  splitTerminalInputUtf8Chunks,
} from '@zterm/shared/terminal/input-chunking';
import type { SessionMirror } from './terminal-runtime-types';
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
  mirrors: Map<string, SessionMirror>;
  tmuxSocketDir?: string;
  getMirrorKey: (sessionName: string, backend?: 'tmux' | 'herdr') => string;
  sanitizeSessionName: (input?: string) => string;
  daemonRuntimeDebug?: (scope: string, payload?: unknown) => void;
  wezTermBackend?: TerminalSourceAdapter | null;
  backendRuntimes?: Partial<Record<'herdr' | 'wezterm', TerminalSourceAdapter>>;
  defaultBackend?: TerminalControlBackendKind;
}

export interface TerminalControlRuntime {
  runTmux: (args: string[]) => { ok: true; stdout: string };
  runTmuxAsync: (args: string[]) => Promise<{ ok: true; stdout: string }>;
  runCommand: (command: string, args: string[]) => ReturnType<typeof spawnSync>;
  writeToTmuxSession: (sessionName: string, payload: string, appendEnter: boolean, backend?: TerminalControlBackendKind) => void;
  ensureTmuxServerRunning: () => void;
  writeToLiveMirror: (sessionName: string, payload: string, appendEnter: boolean, backend?: TerminalControlBackendKind) => boolean;
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

  function writeTmuxLiteralChunksSync(payload: string, target: string) {
    const chunks = splitTerminalInputUtf8Chunks(
      payload,
      TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES,
    );
    for (let index = 0; index < chunks.length; index += 1) {
      const segments = chunks[index]!.split('\x04');
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        if (segments[segmentIndex]) {
          runTmux(['send-keys', '-t', target, '-l', '--', segments[segmentIndex]!]);
        }
        if (segmentIndex < segments.length - 1) {
          runTmux(['send-keys', '-H', '-t', target, '04']);
          sleepTmuxWriteSettleSync();
        }
      }
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
          await runTmuxAsync(['send-keys', '-t', target, '-l', '--', segments[index]!]);
        }
        if (index < segments.length - 1) {
          await runTmuxAsync(['send-keys', '-H', '-t', target, '04']);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS);
          });
        }
      }
    }
    if (appendEnter) {
      await runTmuxAsync(['send-keys', '-t', target, 'Enter']);
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
    const result = runTmux(['list-sessions', '-F', '#S']);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => Boolean(line) && !deps.hiddenTmuxSessions.has(line));
  }

  function listTerminalSessionCatalog() {
    const entries: TerminalSessionCatalogEntry[] = [];
    const selectedBackend = deps.defaultBackend || (deps.wezTermBackend ? 'wezterm' : 'tmux');
    if (selectedBackend === 'tmux' || selectedBackend === 'wezterm') {
      const paneResult = selectedBackend === 'tmux'
        ? runTmux(['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}'])
        : { stdout: '' };
      const cwdBySession = new Map<string, string>();
      for (const line of paneResult.stdout.split('\n')) {
        const [sessionName, cwd] = line.split('\t');
        if (sessionName?.trim() && cwd?.trim() && !cwdBySession.has(sessionName.trim())) {
          cwdBySession.set(sessionName.trim(), cwd.trim());
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
