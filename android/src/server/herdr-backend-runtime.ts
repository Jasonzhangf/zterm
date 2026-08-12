import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { TerminalCell } from '@zterm/shared/types';
import { trimCanonicalBufferWindow } from './canonical-buffer';
import type { WezTermBackendRuntime, WezTermBackendSession, WezTermMirrorSnapshot } from './wezterm-backend';
import { parseHerdrScrollMetrics, resolveHerdrTerminalFromNamedSession, startHerdrProcessSessionAdapter, type HerdrProcessSessionAdapter } from './herdr-process-transport';
import type { HerdrCanonicalSnapshot } from './herdr-frame-canonicalizer';

export interface HerdrBackendRuntimeOptions {
  executable: string;
  workspacePrefix?: string;
  maxMirrorLines?: number;
}

// The shared backend-session shape still has a workspace field for tmux/WezTerm
// compatibility. Herdr layout identity must never cross that boundary.
export const HERDR_SINGLE_SESSION_WORKSPACE = 'herdr-single-session';

interface ManagedHerdrSession extends WezTermBackendSession {
  herdrSessionName: string;
  terminalId: string;
  herdrPaneId: string;
  adapterBundle: HerdrProcessSessionAdapter | null;
  adapterPromise: Promise<HerdrProcessSessionAdapter> | null;
  latestSnapshot: HerdrCanonicalSnapshot | null;
  failure: Error | null;
  serverProcess: ChildProcessWithoutNullStreams | null;
}

function waitForHerdrReadinessWindow(milliseconds: number) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function waitForHerdrProcessExit(process: ChildProcessWithoutNullStreams, timeoutMs: number) {
  if (!process.pid) return process.killed;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      globalThis.process.kill(process.pid, 0);
    } catch {
      return true;
    }
    waitForHerdrReadinessWindow(25);
  }
  try {
    globalThis.process.kill(process.pid, 0);
    return false;
  } catch {
    return true;
  }
}

function parseWorkspaceCreate(raw: string): { terminalId: string; paneId: string; cwd: string; viewportRows: number } {
  const response = JSON.parse(raw) as {
    result?: { root_pane?: { terminal_id?: string; pane_id?: string; cwd?: string; scroll?: { viewport_rows?: number } } };
  };
  const rootPane = response.result?.root_pane;
  if (!rootPane?.terminal_id || !rootPane.pane_id || !rootPane.cwd) {
    throw new Error(`Herdr workspace create did not return a root terminal: ${raw}`);
  }
  return {
    terminalId: rootPane.terminal_id,
    paneId: rootPane.pane_id,
    cwd: rootPane.cwd,
    viewportRows: rootPane.scroll?.viewport_rows || 24,
  };
}

export function mapHerdrCanonicalSnapshot(
  snapshot: HerdrCanonicalSnapshot,
  maxMirrorLines?: number,
): WezTermMirrorSnapshot {
  const absoluteRange = snapshot.absoluteRange;
  if (!absoluteRange) {
    throw new Error('Herdr absolute range unavailable; refusing to publish a fabricated mirror range');
  }
  if (
    !Number.isInteger(absoluteRange.startIndex)
    || !Number.isInteger(absoluteRange.endIndex)
    || !Number.isInteger(absoluteRange.availableStartIndex)
    || !Number.isInteger(absoluteRange.availableEndIndex)
    || absoluteRange.startIndex < 0
    || absoluteRange.endIndex < absoluteRange.startIndex
    || absoluteRange.availableStartIndex > absoluteRange.startIndex
    || absoluteRange.availableEndIndex < absoluteRange.endIndex
    || absoluteRange.endIndex - absoluteRange.startIndex !== snapshot.bufferLines.length
  ) {
    throw new Error('Herdr canonical absolute range does not cover the canonical buffer body');
  }
  const trimmed = trimCanonicalBufferWindow(
    absoluteRange.startIndex,
    snapshot.bufferLines as TerminalCell[][],
    maxMirrorLines === undefined ? snapshot.bufferLines.length : maxMirrorLines,
  );
  if (
    snapshot.cursor
    && (
      snapshot.cursor.rowIndex < trimmed.startIndex
      || snapshot.cursor.rowIndex >= trimmed.startIndex + trimmed.lines.length
    )
  ) {
    throw new Error('Herdr canonical cursor falls outside the bounded mirror window');
  }
  return {
    revision: snapshot.ztermRevision,
    bufferStartIndex: trimmed.startIndex,
    bufferLines: trimmed.lines,
    cols: snapshot.cols,
    rows: snapshot.rows,
    cursorKeysApp: snapshot.cursorKeysApp,
    cursor: snapshot.cursor,
  };
}

export function createHerdrBackendRuntime(options: HerdrBackendRuntimeOptions): WezTermBackendRuntime {
  const prefix = options.workspacePrefix || 'zterm-herdr-';
  const maxMirrorLines = Math.max(1, Math.floor(options.maxMirrorLines || 1000));
  const sessions = new Map<string, ManagedHerdrSession>();

  function cli(sessionName: string, args: string[]) {
    return execFileSync(options.executable, ['--session', sessionName, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function startServer(sessionName: string) {
    const server = spawn(options.executable, ['--session', sessionName, 'server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    server.unref();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      waitForHerdrReadinessWindow(25);
      try {
        cli(sessionName, ['api', 'snapshot']);
        return server;
      } catch {
        // Readiness only: terminal operations are never retried or replaced.
      }
    }
    if (!server.killed) server.kill('SIGTERM');
    throw new Error(`Herdr server did not become ready for session ${sessionName}`);
  }

  function createSession(input?: { sessionName?: string; cwd?: string; command?: string[] }) {
    const sessionName = (input?.sessionName || 'cmd').trim();
    if (!sessionName) throw new Error('Herdr sessionName is required');
    if (sessions.has(sessionName)) throw new Error(`Herdr session already exists: ${sessionName}`);
    const herdrSessionName = `${prefix}${sessionName}`;
    const serverProcess = startServer(herdrSessionName);
    let root;
    try {
      root = parseWorkspaceCreate(cli(herdrSessionName, [
        'workspace', 'create', '--cwd', input?.cwd || process.cwd(), '--no-focus',
      ]));
      const initialScroll = parseHerdrScrollMetrics(cli(herdrSessionName, ['pane', 'get', root.paneId]));
      root = { ...root, viewportRows: initialScroll.viewportRows };
    } catch (error) {
      if (!serverProcess.killed) serverProcess.kill('SIGTERM');
      try {
        cli(herdrSessionName, ['server', 'stop']);
      } catch {
        // Preserve the original workspace-create failure.
      }
      throw error;
    }
    const managed: ManagedHerdrSession = {
      sessionName,
      paneId: root.paneId,
      workspace: HERDR_SINGLE_SESSION_WORKSPACE,
      title: sessionName,
      cwd: root.cwd,
      cols: 80,
      rows: root.viewportRows,
      herdrSessionName,
      terminalId: root.terminalId,
      herdrPaneId: root.paneId,
      adapterBundle: null,
      adapterPromise: null,
      latestSnapshot: null,
      failure: null,
      serverProcess,
    };
    sessions.set(sessionName, managed);
    return managed;
  }

  function listSessions() {
    const raw = execFileSync(options.executable, ['session', 'list', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const response = JSON.parse(raw) as { sessions?: Array<{ name?: string; running?: boolean }> };
    for (const entry of response.sessions || []) {
      if (!entry.running || typeof entry.name !== 'string' || !entry.name.startsWith(prefix)) continue;
      const sessionName = entry.name.slice(prefix.length);
      if (!sessionName || sessions.has(sessionName)) continue;
      discoverSession(sessionName);
    }
    return Array.from(sessions.values());
  }

  function discoverSession(sessionName: string) {
    const herdrSessionName = `${prefix}${sessionName}`;
    const resolved = resolveHerdrTerminalFromNamedSession({
      executable: options.executable,
      sessionName: herdrSessionName,
    });
    const managed: ManagedHerdrSession = {
      sessionName,
      paneId: resolved.paneId,
      workspace: HERDR_SINGLE_SESSION_WORKSPACE,
      title: sessionName,
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      herdrSessionName,
      terminalId: resolved.terminalId,
      herdrPaneId: resolved.paneId,
      adapterBundle: null,
      adapterPromise: null,
      latestSnapshot: null,
      failure: null,
      serverProcess: null,
    };
    sessions.set(sessionName, managed);
    return managed;
  }

  function resolve(sessionName: string) {
    const existing = sessions.get(sessionName);
    if (existing) return existing;
    // Preserve the official list/pane discovery error. Converting an
    // ambiguous or malformed external surface into "not found" would be a
    // silent fallback and could make the caller choose another backend.
    return discoverSession(sessionName);
  }

  function ensureAdapter(session: ManagedHerdrSession) {
    if (session.adapterBundle) return Promise.resolve(session.adapterBundle);
    if (!session.adapterPromise) {
      session.adapterPromise = startHerdrProcessSessionAdapter({
        executable: options.executable,
        sessionName: session.herdrSessionName,
        terminalId: session.terminalId,
        paneId: session.herdrPaneId,
        serverReady: true,
        cols: session.cols,
        rows: session.rows,
      }, {
        onCanonicalFrame: (snapshot) => {
          session.latestSnapshot = snapshot;
          session.cols = snapshot.cols;
          session.rows = snapshot.rows;
        },
        onClosed: (reason) => { session.failure = new Error(`Herdr session ${session.sessionName} closed: ${reason}`); },
        onError: (error) => {
          session.failure = error;
        },
      }).then((bundle) => {
        session.adapterBundle = bundle;
        return bundle;
      });
    }
    return session.adapterPromise;
  }

  async function readSnapshot(sessionName: string) {
    const session = resolve(sessionName);
    await ensureAdapter(session);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (session.failure) throw session.failure;
      if (session.latestSnapshot) return mapHerdrCanonicalSnapshot(session.latestSnapshot, maxMirrorLines);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`Herdr session ${session.sessionName} produced no canonical frame`);
  }

  function writeInput(sessionName: string, input: Buffer | string) {
    const session = resolve(sessionName);
    if (session.failure) throw session.failure;
    const bundle = session.adapterBundle;
    if (!bundle) throw new Error(`Herdr session ${sessionName} transport is not ready`);
    if (typeof input === 'string') bundle.adapter.inputText(input);
    else bundle.adapter.input(new Uint8Array(input));
  }

  function resizeSession(sessionName: string, geometry: { cols: number; rows: number }) {
    const session = resolve(sessionName);
    if (session.failure) throw session.failure;
    if (!session.adapterBundle) throw new Error(`Herdr session ${sessionName} transport is not ready`);
    session.adapterBundle.adapter.resize(geometry);
  }

  function closeSession(sessionName: string) {
    const session = resolve(sessionName);
    let closeError: unknown = null;
    try {
      if (session.adapterBundle) session.adapterBundle.adapter.release();
      session.adapterBundle?.transport.dispose();
    } catch (error) {
      closeError = error;
    }
    let cliStopSucceeded = false;
    let cliStopError: unknown = null;
    try {
      cli(session.herdrSessionName, ['server', 'stop']);
      cliStopSucceeded = true;
    } catch (error) {
      cliStopError = error;
    }
    let serverProcessStopped = !session.serverProcess;
    if (session.serverProcess) {
      try {
        serverProcessStopped = waitForHerdrProcessExit(session.serverProcess, 100);
        if (!serverProcessStopped) {
          session.serverProcess.kill('SIGTERM');
          serverProcessStopped = waitForHerdrProcessExit(session.serverProcess, 500);
        }
        if (!serverProcessStopped) {
          session.serverProcess.kill('SIGKILL');
          serverProcessStopped = waitForHerdrProcessExit(session.serverProcess, 500);
          if (!serverProcessStopped) {
            throw new Error(`Herdr server process ${session.serverProcess.pid || 'unknown'} did not exit after SIGKILL`);
          }
        }
      } catch (error) {
        if (!waitForHerdrProcessExit(session.serverProcess, 100)) closeError ||= error;
      }
    }
    if (!cliStopSucceeded && (!session.serverProcess || !serverProcessStopped)) closeError ||= cliStopError;
    sessions.delete(sessionName);
    if (closeError) throw closeError;
  }

  return {
    listSessions,
    createSession,
    readSnapshot,
    writeInput,
    resizeSession,
    supportsSessionRename: false,
    closeSession,
    readCurrentPath: (sessionName) => resolve(sessionName).cwd,
  };
}
