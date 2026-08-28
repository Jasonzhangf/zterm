import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { TerminalCell } from '@zterm/shared/types';
import { normalizeCapturedLineBlock } from './canonical-buffer';
import { canonicalizeCapturedMirrorLines } from './mirror-line-canonicalizer';
import type {
  TerminalSourceAdapter,
  TerminalSourceMirrorSnapshot,
  TerminalSourceSession,
} from './terminal-source-adapter';
import {
  parseHerdrScrollMetrics,
  parseHerdrPaneGeometry,
  resolveHerdrTerminalFromNamedSession,
  startHerdrProcessSessionAdapter,
  type HerdrProcessSessionAdapter,
} from './herdr-process-transport';
import type {
  HerdrCanonicalSnapshot,
  HerdrScrollMetrics,
} from './herdr-frame-canonicalizer';

export interface HerdrBackendRuntimeOptions {
  executable: string;
  maxMirrorLines?: number;
  onLiveActivity?: (sessionName: string) => void;
}

export interface HerdrHistorySnapshot {
  bufferLines: TerminalCell[][];
  sourceEndIndex: number;
  cols: number;
  rows: number;
  refreshedAt: number;
}

interface ManagedHerdrSession extends TerminalSourceSession {
  herdrSessionName: string;
  terminalId: string;
  herdrPaneId: string;
  adapterBundle: HerdrProcessSessionAdapter | null;
  adapterPromise: Promise<HerdrProcessSessionAdapter> | null;
  latestSnapshot: HerdrCanonicalSnapshot | null;
  historySnapshot: HerdrHistorySnapshot | null;
  historyRefreshPromise: Promise<void> | null;
  historyRefreshTimer: ReturnType<typeof setTimeout> | null;
  historyRefreshRequested: boolean;
  lastScrollMetrics: HerdrScrollMetrics | null;
  lastScrollMetricsAt: number;
  hostScrollState: boolean | null;
  failure: Error | null;
  serverProcess: ChildProcessWithoutNullStreams | null;
}

const HERDR_HISTORY_REFRESH_MS = 1000;
const HERDR_HISTORY_LIMIT = 1000;
const HERDR_HISTORY_READ_MAX_ATTEMPTS = 3;

export class HerdrSessionLifecycleError extends Error {
  constructor(
    public readonly operation: 'create' | 'close',
    public readonly sessionName: string,
    message: string,
  ) {
    super(`herdr session lifecycle (${operation} ${sessionName}): ${message}`);
    this.name = 'HerdrSessionLifecycleError';
  }
}

export function advanceHerdrHistoryLiveTailWindow(
  history: HerdrHistorySnapshot,
  live: HerdrCanonicalSnapshot,
  options: {
    overlayMetrics?: HerdrScrollMetrics | null;
    canAdvanceSourceEnd?: boolean;
  } = {},
): { bufferLines: TerminalCell[][]; sourceEndIndex: number; canOverlay: boolean } {
  const metrics = live.scrollMetrics ?? options.overlayMetrics ?? null;
  const canAdvanceSourceEnd = Boolean(live.scrollMetrics && options.canAdvanceSourceEnd !== false);
  const canOverlay = metrics?.offsetFromBottom === 0
    && history.cols === live.cols
    && history.rows === live.rows;
  if (!canOverlay) {
    return {
      bufferLines: history.bufferLines,
      sourceEndIndex: history.sourceEndIndex,
      canOverlay: false,
    };
  }
  const liveRows = live.bufferLines.slice(-live.rows);
  const sourceEndIndex = canAdvanceSourceEnd
    ? Math.max(history.sourceEndIndex, metrics!.maxOffsetFromBottom + metrics!.viewportRows)
    : history.sourceEndIndex;
  const growth = sourceEndIndex - history.sourceEndIndex;
  if (
    liveRows.length !== live.rows
    || history.bufferLines.length < live.rows
    || growth > live.rows
    || growth >= history.bufferLines.length
  ) {
    return {
      bufferLines: history.bufferLines,
      sourceEndIndex: history.sourceEndIndex,
      canOverlay: false,
    };
  }
  return {
    bufferLines: [
      ...history.bufferLines.slice(
        growth,
        growth + history.bufferLines.length - live.rows,
      ),
      ...liveRows,
    ],
    sourceEndIndex,
    canOverlay: true,
  };
}

function waitForHerdrReadinessWindow(milliseconds: number) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function waitForHerdrProcessExit(process: ChildProcessWithoutNullStreams, timeoutMs: number) {
  // ChildProcess#killed records that the requested signal was delivered. Herdr
  // server processes can remain as an unreaped zombie while the daemon is
  // synchronously closing a detached child, so polling kill(pid, 0) alone can
  // report a false non-exit after an explicit SIGTERM/SIGKILL.
  if (process.killed || process.exitCode !== null) return true;
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

function parseWorkspaceCreate(raw: string): { terminalId: string; paneId: string; cwd: string } {
  const response = JSON.parse(raw) as {
    result?: { root_pane?: { terminal_id?: string; pane_id?: string; cwd?: string } };
  };
  const rootPane = response.result?.root_pane;
  if (!rootPane?.terminal_id || !rootPane.pane_id || !rootPane.cwd) {
    throw new Error(`Herdr workspace create did not return a root terminal: ${raw}`);
  }
  return {
    terminalId: rootPane.terminal_id,
    paneId: rootPane.pane_id,
    cwd: rootPane.cwd,
  };
}

export function createHerdrBackendRuntime(options: HerdrBackendRuntimeOptions): TerminalSourceAdapter {
  // Herdr is an external compatibility source, like tmux. Every running
  // official Herdr named session is discoverable verbatim; zterm must not
  // reserve or filter a name prefix. Herdr layout/workspace state still never
  // enters zterm truth.
  const maxMirrorLines = Math.max(1, Math.floor(options.maxMirrorLines || 1000));
  const sessions = new Map<string, ManagedHerdrSession>();

  function cli(sessionName: string, args: string[]) {
    return execFileSync(options.executable, ['--session', sessionName, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function readHerdrScrollMetrics(session: ManagedHerdrSession) {
    try {
      const metrics = parseHerdrScrollMetrics(
        cli(session.herdrSessionName, ['pane', 'get', session.herdrPaneId]),
      );
      session.lastScrollMetrics = metrics;
      session.lastScrollMetricsAt = Date.now();
      return metrics;
    } catch (error) {
      console.warn(
        `[herdr] pane scroll metrics read failed for ${session.sessionName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  function scheduleHerdrHistoryRefresh(session: ManagedHerdrSession, immediate = false) {
    if (!immediate && session.historyRefreshTimer) {
      return;
    }
    if (session.historyRefreshTimer) {
      clearTimeout(session.historyRefreshTimer);
      session.historyRefreshTimer = null;
    }
    if (immediate) {
      if (session.historyRefreshPromise) {
        session.historyRefreshRequested = true;
        return;
      }
      void refreshHerdrHistory(session).catch((error) => {
        console.error(
          `[herdr] immediate history refresh failed for ${session.sessionName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      return;
    }
    session.historyRefreshTimer = setTimeout(() => {
      session.historyRefreshTimer = null;
      if (session.historyRefreshPromise) {
        session.historyRefreshRequested = true;
        return;
      }
      void refreshHerdrHistory(session).catch((error) => {
        console.error(
          `[herdr] scheduled history refresh failed for ${session.sessionName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, HERDR_HISTORY_REFRESH_MS);
    session.historyRefreshTimer.unref?.();
  }

  async function refreshHerdrHistory(session: ManagedHerdrSession) {
    if (session.historyRefreshPromise) {
      return session.historyRefreshPromise;
    }
    const promise = (async () => {
      const lineLimit = Math.min(maxMirrorLines, HERDR_HISTORY_LIMIT);
      for (let attempt = 0; attempt < HERDR_HISTORY_READ_MAX_ATTEMPTS; attempt += 1) {
        const readSnapshot = session.latestSnapshot;
        if (!readSnapshot) {
          throw new Error(`Herdr session ${session.sessionName} produced no canonical frame before history read`);
        }
        const raw = cli(session.herdrSessionName, [
          'pane',
          'read',
          session.herdrPaneId,
          '--source',
          'recent',
          '--lines',
          String(lineLimit),
          '--format',
          'ansi',
          '--raw',
        ]);
        if (!raw) {
          throw new Error(`Herdr pane read returned empty recent history for ${session.sessionName}`);
        }
        const capturedLines = normalizeCapturedLineBlock(raw);
        if (capturedLines.length === 0) {
          throw new Error(`Herdr pane read returned no recent history rows for ${session.sessionName}`);
        }
        const canonicalLines = await canonicalizeCapturedMirrorLines(
          capturedLines,
          readSnapshot.cols || session.cols,
        );
        if (canonicalLines.length === 0) {
          throw new Error(`Herdr pane read canonicalization returned no rows for ${session.sessionName}`);
        }
        const currentSnapshot = session.latestSnapshot;
        if (!currentSnapshot) {
          throw new Error(`Herdr session ${session.sessionName} lost its canonical frame during history read`);
        }
        const geometryChanged = (
          currentSnapshot.cols !== readSnapshot.cols
          || currentSnapshot.rows !== readSnapshot.rows
        );
        if (geometryChanged) {
          if (attempt < HERDR_HISTORY_READ_MAX_ATTEMPTS - 1) {
            continue;
          }
          throw new Error(
            `Herdr geometry changed during history read for ${session.sessionName}; refusing stale history`,
          );
        }
        const metrics = readHerdrScrollMetrics(session);
        if (!metrics) {
          throw new Error(
            `Herdr pane scroll metrics unavailable for ${session.sessionName}; refusing to publish history at a stale absolute index`,
          );
        }
        const previousEnd = session.historySnapshot?.sourceEndIndex || 0;
        const sourceEndIndex = Math.max(
          previousEnd,
          canonicalLines.length,
          metrics.maxOffsetFromBottom + metrics.viewportRows,
        );
        session.historySnapshot = {
          bufferLines: canonicalLines,
          sourceEndIndex,
          cols: currentSnapshot.cols,
          rows: currentSnapshot.rows,
          refreshedAt: Date.now(),
        };
        options.onLiveActivity?.(session.sessionName);
        return;
      }
      throw new Error(`Herdr history refresh did not stabilize for ${session.sessionName}`);
    })().finally(() => {
      if (session.historyRefreshPromise === promise) {
        session.historyRefreshPromise = null;
      }
      if (session.historyRefreshRequested) {
        session.historyRefreshRequested = false;
        scheduleHerdrHistoryRefresh(session, true);
      }
    });
    session.historyRefreshPromise = promise;
    void promise.then(() => undefined, () => undefined);
    return promise;
  }

  async function ensureHerdrHistorySnapshot(session: ManagedHerdrSession) {
    if (!session.historySnapshot) {
      if (!session.historyRefreshPromise) {
        scheduleHerdrHistoryRefresh(session, true);
      }
      await session.historyRefreshPromise;
      if (!session.historySnapshot) {
        throw new Error(`Herdr history snapshot unavailable for ${session.sessionName}`);
      }
      return session.historySnapshot;
    }
    if (Date.now() - session.historySnapshot.refreshedAt >= HERDR_HISTORY_REFRESH_MS) {
      scheduleHerdrHistoryRefresh(session, false);
    }
    return session.historySnapshot;
  }

  function buildMergedHerdrMirrorSnapshot(
    session: ManagedHerdrSession,
    history: HerdrHistorySnapshot,
  ): TerminalSourceMirrorSnapshot {
    const live = session.latestSnapshot;
    if (!live) {
      throw new Error(`Herdr session ${session.sessionName} produced no canonical frame`);
    }
    if (history.cols !== live.cols || history.rows !== live.rows) {
      throw new Error(
        `Herdr live geometry changed for ${session.sessionName}; refusing stale mirror publish`,
      );
    }
    const merged = advanceHerdrHistoryLiveTailWindow(history, live, {
      overlayMetrics: session.lastScrollMetrics,
      canAdvanceSourceEnd: Boolean(live.scrollMetrics),
    });
    let bufferLines = merged.bufferLines;
    let cursor: TerminalSourceMirrorSnapshot['cursor'] = null;
    if (merged.canOverlay) {
      history.bufferLines = merged.bufferLines;
      history.sourceEndIndex = merged.sourceEndIndex;
      cursor = live.localCursor
        ? {
            rowIndex: merged.sourceEndIndex - live.rows + live.localCursor.row,
            col: live.localCursor.col,
            visible: live.localCursor.visible,
          }
        : null;
    }
    const bufferStartIndex = Math.max(0, merged.sourceEndIndex - bufferLines.length);
    const availableEndIndex = merged.sourceEndIndex;
    return {
      revision: live.ztermRevision,
      bufferStartIndex,
      bufferLines,
      cols: live.cols,
      rows: live.rows,
      cursorKeysApp: live.cursorKeysApp,
      cursor,
      lastScrollbackCount: Math.max(0, bufferLines.length - live.rows),
      availableStartIndex: bufferStartIndex,
      availableEndIndex,
      totalAvailableLines: availableEndIndex,
      visibleTopIndex: Math.max(bufferStartIndex, availableEndIndex - live.rows),
      capturedLineCount: bufferLines.length,
      canonicalLineCount: bufferLines.length,
      captureDurationMs: 0,
      canonicalizeDurationMs: 0,
      captureStartedAt: Date.now(),
      captureDoneAt: Date.now(),
      canonicalizeDoneAt: Date.now(),
      source: 'herdr',
      capabilityGaps: ['herdr-history-limit-1000'],
    };
  }

  function handleHerdrCanonicalFrame(session: ManagedHerdrSession, snapshot: HerdrCanonicalSnapshot) {
    session.latestSnapshot = snapshot;
    session.cols = snapshot.cols;
    session.rows = snapshot.rows;
    if (snapshot.scrollMetrics) {
      session.lastScrollMetrics = snapshot.scrollMetrics;
      session.lastScrollMetricsAt = Date.now();
    }
    const confirmedHostScrolled = snapshot.scrollMetrics
      ? snapshot.scrollMetrics.offsetFromBottom !== 0
      : session.hostScrollState === true;
    const hostScrollChanged = session.hostScrollState !== null
      && session.hostScrollState !== confirmedHostScrolled;
    const history = session.historySnapshot;
    const geometryChanged = Boolean(
      history
      && (history.cols !== snapshot.cols || history.rows !== snapshot.rows),
    );
    if (history && (hostScrollChanged || geometryChanged)) {
      scheduleHerdrHistoryRefresh(session, true);
    }
    session.hostScrollState = confirmedHostScrolled;
    options.onLiveActivity?.(session.sessionName);
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
    if (!sessionName) {
      throw new HerdrSessionLifecycleError('create', sessionName, 'sessionName is required');
    }
    if (sessions.has(sessionName)) {
      throw new HerdrSessionLifecycleError(
        'create',
        sessionName,
        'session already exists in the zterm Herdr backend runtime',
      );
    }
    const herdrSessionName = sessionName;
    const serverProcess = startServer(herdrSessionName);
    let root: ReturnType<typeof parseWorkspaceCreate>;
    let geometry: { cols: number; rows: number };
    try {
      root = parseWorkspaceCreate(cli(herdrSessionName, [
        'workspace', 'create',
        '--cwd', input?.cwd || process.cwd(),
        '--no-focus',
      ]));
      geometry = parseHerdrPaneGeometry(
        cli(herdrSessionName, ['api', 'snapshot']),
        root.paneId,
        herdrSessionName,
      );
    } catch (error) {
      if (!serverProcess.killed) serverProcess.kill('SIGTERM');
      try {
        cli(herdrSessionName, ['server', 'stop']);
      } catch {
        // Preserve the original workspace-create failure.
      }
      throw new HerdrSessionLifecycleError(
        'create',
        sessionName,
        `workspace-create or pane-geometry failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const managed: ManagedHerdrSession = {
      sessionName,
      paneId: root.paneId,
      title: sessionName,
      cwd: root.cwd,
      cols: geometry.cols,
      rows: geometry.rows,
      herdrSessionName,
      terminalId: root.terminalId,
      herdrPaneId: root.paneId,
      adapterBundle: null,
      adapterPromise: null,
      latestSnapshot: null,
      historySnapshot: null,
      historyRefreshPromise: null,
      historyRefreshTimer: null,
      historyRefreshRequested: false,
      lastScrollMetrics: null,
      lastScrollMetricsAt: 0,
      hostScrollState: null,
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
    const runningNames = new Set<string>();
    for (const entry of response.sessions || []) {
      if (!entry.running || typeof entry.name !== 'string') continue;
      const sessionName = entry.name;
      if (!sessionName) continue;
      runningNames.add(sessionName);
      if (sessions.has(sessionName)) continue;
      discoverSession(sessionName);
    }
    for (const sessionName of sessions.keys()) {
      if (!runningNames.has(sessionName)) sessions.delete(sessionName);
    }
    return Array.from(sessions.values());
  }

  function discoverSession(sessionName: string) {
    const herdrSessionName = sessionName;
    const resolved = resolveHerdrTerminalFromNamedSession({
      executable: options.executable,
      sessionName: herdrSessionName,
    });
    const geometry = parseHerdrPaneGeometry(
      cli(herdrSessionName, ['api', 'snapshot']),
      resolved.paneId,
      herdrSessionName,
    );
    const managed: ManagedHerdrSession = {
      sessionName,
      paneId: resolved.paneId,
      title: sessionName,
      cwd: process.cwd(),
      cols: geometry.cols,
      rows: geometry.rows,
      herdrSessionName,
      terminalId: resolved.terminalId,
      herdrPaneId: resolved.paneId,
      adapterBundle: null,
      adapterPromise: null,
      latestSnapshot: null,
      historySnapshot: null,
      historyRefreshPromise: null,
      historyRefreshTimer: null,
      historyRefreshRequested: false,
      lastScrollMetrics: null,
      lastScrollMetricsAt: 0,
      hostScrollState: null,
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
        onCanonicalFrame: (snapshot) => handleHerdrCanonicalFrame(session, snapshot),
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
      if (session.latestSnapshot) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    if (!session.latestSnapshot) {
      throw new Error(`Herdr session ${session.sessionName} produced no canonical frame`);
    }
    const history = await ensureHerdrHistorySnapshot(session);
    return buildMergedHerdrMirrorSnapshot(session, history);
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
    const session = sessions.get(sessionName);
    if (!session) {
      throw new HerdrSessionLifecycleError(
        'close',
        sessionName,
        'session is not tracked by the zterm Herdr backend runtime',
      );
    }
    sessions.delete(sessionName);
    if (session.historyRefreshTimer) {
      clearTimeout(session.historyRefreshTimer);
      session.historyRefreshTimer = null;
    }
    session.historyRefreshPromise = null;
    session.adapterPromise = null;
    let closeError: unknown = null;
    try {
      const bundle = session.adapterBundle;
      session.adapterBundle = null;
      if (bundle) {
        bundle.adapter.release();
        bundle.transport.dispose();
      }
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
        try {
          if (!waitForHerdrProcessExit(session.serverProcess, 100)) closeError ||= error;
        } catch {
          closeError ||= error;
        }
      }
    }
    if (!cliStopSucceeded && (!session.serverProcess || !serverProcessStopped)) closeError ||= cliStopError;
    if (closeError) throw closeError;
  }

  return {
    kind: 'herdr',
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
