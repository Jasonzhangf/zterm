import { spawn, spawnSync } from 'child_process';
import { chmodSync, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, delimiter, dirname, join, resolve, sep } from 'path';
import { performance } from 'perf_hooks';
import { createConnection, createServer } from 'net';
import { pathToFileURL } from 'url';
import { WebSocket } from 'ws';
import { splitTerminalInputUtf8Chunks, TERMINAL_INPUT_CHUNK_BYTES } from '@zterm/shared/terminal/input-chunking';
import type { BufferSyncRequestPayload, ClientMessage, ScheduleEventPayload, ScheduleStatePayload, ServerMessage, TerminalBufferPayload, TerminalCell } from '../src/lib/types';
import { resolveDaemonRuntimeConfig } from '../src/server/daemon-config';
import { loadScheduleStore, saveScheduleStore } from '../src/server/schedule-store';
import {
  cellsToLine,
  normalizeWireLines,
} from '../src/lib/terminal-buffer';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../src/lib/mobile-config';
import { replayBufferSyncHistory } from '../src/lib/terminal-buffer-replay';

const LAB_SESSION_NAME = `zterm_mirror_lab_${process.pid}`;
const LAB_COLS = 80;
const LAB_ROWS = 24;
const WAIT_TIMEOUT_MS = 8000;
const DAEMON_READY_TIMEOUT_MS = 10000;
const PROBE_HANDSHAKE_TIMEOUT_MS = 10000;
const MANAGED_DAEMON_TEST_PORT = process.env.ZTERM_TEST_DAEMON_PORT?.trim() || '';
const TMUX_CLEANUP_TIMEOUT_MS = 2000;
const ORACLE_SAMPLE_LIMIT = 8;
const ORACLE_STABLE_INTERVAL_MS = 100;
const LAB_HISTORY_LIMIT = 2048;
const LAB_TASK_ROOT = process.env.HOME?.trim() || '';
const LAB_TMUX_TMPDIR = process.env.TMUX_TMPDIR?.trim() || (
  LAB_TASK_ROOT ? join(LAB_TASK_ROOT, '.zterm', 'tmux') : ''
);
const LAB_TMUX_SOCKET = LAB_TMUX_TMPDIR
  ? join(
    LAB_TMUX_TMPDIR,
    `tmux-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
    'default',
  )
  : '';
const LAB_TMUX_BOUNDARY = LAB_TASK_ROOT ? join(LAB_TASK_ROOT, 'bin', 'tmux') : '';
const LAB_EVIDENCE_RUN_ID = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let acquiredLabSessionId: string | null = null;
let focusedResourcesValidated = false;
type CaseName =
  | 'codex-live'
  | 'top-live'
  | 'vim-live'
  | 'initial-sync'
  | 'local-input-echo'
  | 'long-input-echo'
  | 'external-input-echo'
  | 'daemon-restart-recover'
  | 'schedule-fire';

interface OracleSnapshot {
  capturedAt: string;
  capturedAtMonotonicMs: number;
  captureArgs: string[];
  captureWindowStart: number;
  captureWindowEnd: number;
  captureAbsoluteStartIndex: number;
  captureAbsoluteEndIndex: number;
  rawCapture: string;
  captureLines: string[];
  sessionName: string;
  tmuxSocket: string;
  paneId: string;
  paneRows: number;
  paneCols: number;
  historySize: number;
  historyLimit: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  alternateOn: boolean;
  paneCommand: string;
  lines: string[];
}

interface OracleWaitSample {
  capturedAt: string;
  capturedAtMonotonicMs: number;
  elapsedSincePreviousWallMs: number | null;
  elapsedSincePreviousMonotonicMs: number | null;
  predicateMatched: boolean;
  stable: boolean;
  snapshot: OracleSnapshot;
}

interface OracleSamplesEvidence {
  idleShellCommand: string;
  idleBaseline: OracleWaitSample[];
  targetPayloadObserved: OracleWaitSample[];
  shellSettled: OracleWaitSample[];
}

interface CaseFailureCause {
  stage: string;
  message: string;
}

class OracleTimeoutError extends Error {
  readonly phase: string;

  readonly samples: OracleWaitSample[];

  readonly lastSnapshot: OracleSnapshot | null;

  constructor(phase: string, samples: OracleWaitSample[]) {
    super(`timeout waiting for oracle: ${phase}`);
    this.name = 'OracleTimeoutError';
    this.phase = phase;
    this.samples = samples;
    this.lastSnapshot = samples[samples.length - 1]?.snapshot || null;
  }
}

class OracleObservationError extends Error {
  readonly phase: string;

  readonly samples: OracleWaitSample[];

  readonly lastSnapshot: OracleSnapshot | null;

  readonly originalError: unknown;

  constructor(phase: string, originalError: unknown, samples: OracleWaitSample[]) {
    super(`oracle observation failed during ${phase}: ${errorMessage(originalError)}`);
    this.name = 'OracleObservationError';
    this.phase = phase;
    this.samples = samples;
    this.lastSnapshot = samples[samples.length - 1]?.snapshot || null;
    this.originalError = originalError;
  }
}

interface TmuxRunOptions {
  allowFailure?: boolean;
  timeoutMs?: number;
  deadlineAt?: number;
  oraclePhase?: string;
  oracleSamples?: OracleWaitSample[];
}

class OracleCaptureTimeoutError extends Error {
  readonly phase: string;

  readonly samples: OracleWaitSample[];

  readonly lastSnapshot: OracleSnapshot | null;

  constructor(phase: string, samples: OracleWaitSample[]) {
    super(`timeout waiting for oracle: ${phase}`);
    this.name = 'OracleCaptureTimeoutError';
    this.phase = phase;
    this.samples = samples;
    this.lastSnapshot = samples[samples.length - 1]?.snapshot || null;
  }
}

interface CompareResult {
  ok: boolean;
  mismatchIndex: number | null;
  expected: string[];
  actual: string[];
  range?: {
    markerIndex: number | null;
    settledMarkerIndex: number | null;
  };
  expectedStartIndex?: number;
  expectedEndIndex?: number;
  actualStartIndex?: number;
  actualEndIndex?: number;
  missingIndices?: number[];
  coverageComplete?: boolean;
}

interface ProbeEventEntry {
  at: string;
  direction: 'sent' | 'recv';
  type: string;
  payload?: unknown;
}

interface ScheduleEventWaiter {
  resolve: (event: ServerMessage & { type: 'schedule-event' }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CaseStepResult {
  label: string;
  verificationMode: 'source-only' | 'source-and-client-render';
  ok: boolean;
  reason?: string;
  oracle: OracleSnapshot;
  daemonPayload?: TerminalBufferPayload | null;
  compare?: CompareResult;
  clientMirrorCompare?: CompareResult;
  historyLength: number;
  details?: Record<string, unknown>;
}

interface CaseResult {
  caseName: CaseName;
  ok: boolean;
  reason?: string;
  classification?: 'PASS' | 'UNVERIFIED_ORACLE_TIMEOUT' | 'UNVERIFIED_CLEANUP' | 'FAIL_PRODUCT_COMPARISON' | 'FAIL';
  oracle?: OracleSnapshot | null;
  daemonPayload: TerminalBufferPayload | null;
  compare?: CompareResult;
  clientMirrorCompare?: CompareResult;
  steps?: CaseStepResult[];
  failureCauses?: CaseFailureCause[];
  oracleSamples?: OracleSamplesEvidence;
  comparisonScope?: 'focused-settled';
}

function deriveRenderRows(options: {
  lines: TerminalCell[][];
  startIndex: number;
  viewportEndIndex: number;
  viewportRows: number;
}) {
  const viewportRows = Math.max(1, Math.floor(options.viewportRows || 24));
  const viewportBottomIndex = Math.max(0, Math.floor(options.viewportEndIndex));
  const viewportTopIndex = Math.max(0, viewportBottomIndex - viewportRows);
  const rows: Array<{ index: number; row: TerminalCell[] }> = [];

  for (let index = viewportTopIndex; index < viewportBottomIndex; index += 1) {
    const rowOffset = index - options.startIndex;
    rows.push({
      index,
      row:
        rowOffset >= 0 && rowOffset < options.lines.length
          ? options.lines[rowOffset] || []
          : [],
    });
  }

  return {
    viewportTopIndex,
    viewportBottomIndex,
    rows,
  };
}

function nowStamp() {
  return new Date().toISOString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function currentDateFolder() {
  return new Date().toISOString().slice(0, 10);
}

function summarizeProbeMessage(type: string, payload: unknown) {
  if (type === 'schedule-upsert' && payload && typeof payload === 'object') {
    const job = (payload as { job?: Record<string, unknown> }).job || {};
    return {
      targetSessionName: job.targetSessionName ?? null,
      label: job.label ?? null,
      enabled: job.enabled ?? true,
      ruleKind: (job.rule as Record<string, unknown>)?.kind ?? null,
      payloadPreview: typeof (job.payload as Record<string, unknown>)?.text === 'string'
        ? ((job.payload as Record<string, unknown>).text as string).slice(0, 80)
        : '',
    };
  }
  if (type === 'schedule-delete' && payload && typeof payload === 'object') {
    return { jobId: (payload as { jobId?: string }).jobId ?? null };
  }
  if (type === 'schedule-run-now' && payload && typeof payload === 'object') {
    return { jobId: (payload as { jobId?: string }).jobId ?? null };
  }
  if (type === 'schedule-event' && payload && typeof payload === 'object') {
    const event = payload as ScheduleEventPayload;
    return {
      sessionName: event.sessionName,
      jobId: event.jobId,
      eventType: event.type,
      at: event.at,
      message: event.message ?? null,
    };
  }
  if (type === 'schedule-state' && payload && typeof payload === 'object') {
    const state = payload as ScheduleStatePayload;
    return {
      sessionName: state.sessionName,
      jobCount: Array.isArray(state.jobs) ? state.jobs.length : 0,
    };
  }
  if (type === 'buffer-sync' && payload && typeof payload === 'object') {
    const bufferPayload = payload as TerminalBufferPayload;
    return {
      revision: bufferPayload.revision,
      startIndex: bufferPayload.startIndex,
      endIndex: bufferPayload.endIndex,
      availableStartIndex: bufferPayload.availableStartIndex ?? null,
      availableEndIndex: bufferPayload.availableEndIndex ?? null,
      rows: bufferPayload.rows,
      cols: bufferPayload.cols,
      lineCount: Array.isArray(bufferPayload.lines) ? bufferPayload.lines.length : 0,
    };
  }
  if (type === 'buffer-head' && payload && typeof payload === 'object') {
    const headPayload = payload as { revision?: number; latestEndIndex?: number; availableStartIndex?: number; availableEndIndex?: number };
    return {
      revision: headPayload.revision ?? 0,
      latestEndIndex: headPayload.latestEndIndex ?? 0,
      availableStartIndex: headPayload.availableStartIndex ?? null,
      availableEndIndex: headPayload.availableEndIndex ?? null,
    };
  }
  if (type === 'buffer-sync-request' && payload && typeof payload === 'object') {
    const syncRequest = payload as BufferSyncRequestPayload;
    return {
      knownRevision: syncRequest.knownRevision,
      localStartIndex: syncRequest.localStartIndex,
      localEndIndex: syncRequest.localEndIndex,
      requestStartIndex: syncRequest.requestStartIndex,
      requestEndIndex: syncRequest.requestEndIndex,
      missingRanges: syncRequest.missingRanges || [],
    };
  }
  if (type === 'connect' && payload && typeof payload === 'object') {
    const connectPayload = payload as { sessionName?: string; cols?: number; rows?: number };
    return {
      sessionName: connectPayload.sessionName ?? null,
      cols: connectPayload.cols ?? null,
      rows: connectPayload.rows ?? null,
    };
  }
  if (type === 'input') {
    return {
      preview: typeof payload === 'string' ? payload.slice(0, 120) : '',
      length: typeof payload === 'string' ? payload.length : 0,
    };
  }
  if (type === 'connected' || type === 'title' || type === 'error' || type === 'closed') {
    return payload;
  }
  return payload;
}

function detectBufferSyncWireKind(rawText: string) {
  if (/"lines":\[\{"i":/u.test(rawText)) {
    return 'compact';
  }
  if (/"lines":\[\{"index":/u.test(rawText)) {
    return 'legacy';
  }
  return 'unknown';
}

async function waitForDaemonHealth(healthUrl: string, timeoutMs: number = DAEMON_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return await response.json();
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(150);
  }
  throw new Error(`daemon health timeout: ${lastError}`);
}

async function findAvailablePort(host: string) {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to resolve dynamic daemon port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function resolveTmuxBinary(allowOverride = true) {
  const override = allowOverride ? process.env.ZTERM_TMUX_BINARY?.trim() : '';
  if (override) {
    return override;
  }
  const candidates = [
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
    'tmux',
  ];
  const existingCandidate = candidates.find((candidate) => candidate === 'tmux' || existsSync(candidate));
  return existingCandidate || 'tmux';
}

const isMainModule = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
const TMUX_BINARY = isMainModule
  ? resolveTmuxBinary(!process.argv.includes('--managed-daemon') || !process.argv.includes('--case=long-input-echo'))
  : '';

class LabDaemonController {
  private readonly host: string;

  private port = '';

  private readonly logPath: string;

  private proc: ReturnType<typeof spawn> | null = null;

  constructor(private readonly focused = false) {
    const config = resolveDaemonRuntimeConfig();
    this.host = focused ? '127.0.0.1' : process.env.ZTERM_HOST || (config.host === '0.0.0.0' ? '127.0.0.1' : config.host);
    this.logPath = join(ensureEvidenceRunDir(), 'current-daemon.log');
  }

  getPort() {
    return this.port;
  }

  getHost() {
    return this.host;
  }

  async start() {
    if (this.proc) {
      throw new Error('lab daemon is already running');
    }
    this.port = (!this.focused && MANAGED_DAEMON_TEST_PORT) || String(await findAvailablePort(this.host));
    const healthUrl = `http://${this.host}:${this.port}/health`;
    mkdirSync(ensureEvidenceRunDir(), { recursive: true });
    const logStream = createWriteStream(this.logPath, { flags: 'a' });
    const env = { ...process.env };
    if (this.focused) {
      // A private HOME is not sufficient when relay credentials or Node hooks are inherited.
      for (const key of Object.keys(env)) {
        if (/^(?:ZTERM|WTERM)_(?:TRAVERSAL|RELAY)(?:_|$)/u.test(key)
          || key === 'NODE_OPTIONS' || key === 'NODE_PATH'
          || key === 'ZTERM_REX_EXE' || key === 'ZTERM_HERDR_EXE'
          || key === 'ZTERM_WEZTERM_EXE' || key === 'ZTERM_TERMINAL_BACKEND') {
          delete env[key];
        }
      }
      env.ZTERM_TERMINAL_BACKEND = 'tmux';
      env.ZTERM_REX_EXE = join(LAB_TASK_ROOT, 'rex-disabled');
      env.ZTERM_HERDR_EXE = join(LAB_TASK_ROOT, 'herdr-disabled');
      env.ZTERM_WEZTERM_EXE = '';
      env.TMUX_TMPDIR = LAB_TMUX_TMPDIR;
      env.HOME = LAB_TASK_ROOT;
      env.WTERM_HOME = LAB_TASK_ROOT;
      env.ZTERM_HOME = LAB_TASK_ROOT;
      env.TMPDIR = LAB_TASK_ROOT;
      env.TMP = LAB_TASK_ROOT;
      env.TEMP = LAB_TASK_ROOT;
      env.XDG_CONFIG_HOME = join(LAB_TASK_ROOT, '.config');
      env.XDG_DATA_HOME = join(LAB_TASK_ROOT, '.local', 'share');
      env.XDG_CACHE_HOME = join(LAB_TASK_ROOT, '.cache');
      env.ZTERM_TMUX_BINARY = LAB_TMUX_BOUNDARY;
      env.PATH = Array.from(new Set([
        dirname(process.execPath),
        '/usr/bin',
        '/bin',
      ])).join(delimiter);
    }
    const tsxLoader = pathToFileURL(join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    // The owned child is the server itself, rather than the tsx CLI's wrapper process.
    const proc = spawn(process.execPath, ['--import', tsxLoader, 'src/server/server.ts'], {
      cwd: process.cwd(),
      env: {
        ...env,
        ZTERM_HOST: this.host,
        ZTERM_PORT: this.port,
        ZTERM_AUTH_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);
    this.proc = proc;
    if (this.focused) {
      // Only this child's successful listen callback can establish readiness.
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const listening = `zterm tmux bridge listening on ws://${this.host}:${this.port}`;
        const finish = (error?: Error) => {
          clearTimeout(timer);
          proc.stdout.off('data', onData);
          proc.off('error', onError);
          proc.off('exit', onExit);
          error ? reject(error) : resolve();
        };
        const onData = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-4096);
          if (output.includes(listening)) finish();
        };
        const onError = (error: Error) => finish(error);
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          finish(new Error(`managed daemon exited before listening: code=${code} signal=${signal}`));
        };
        const timer = setTimeout(() => finish(new Error('managed daemon child readiness timeout')), DAEMON_READY_TIMEOUT_MS);
        proc.stdout.on('data', onData);
        proc.once('error', onError);
        proc.once('exit', onExit);
      });
    } else {
      await waitForDaemonHealth(healthUrl);
    }
  }

  async stop() {
    if (!this.proc) {
      return;
    }
    const proc = this.proc;
    this.proc = null;
    const deadlineAt = performance.now() + 4500;
    if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (proc.exitCode === null) {
            proc.kill('SIGTERM');
          }
        }, 1500);
        const killTimer = setTimeout(() => proc.kill('SIGKILL'), 3000);
        const deadlineTimer = setTimeout(() => {
          proc.off('exit', onExit);
          reject(new Error(`managed daemon cleanup deadline exceeded for server PID ${proc.pid}`));
        }, Math.max(1, Math.ceil(deadlineAt - performance.now())));
        const onExit = () => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          clearTimeout(deadlineTimer);
          resolve();
        };
        proc.once('exit', onExit);
        proc.kill('SIGINT');
      });
    }
    // Process exit alone is not a cleanup receipt: the task listener must also close.
    while (performance.now() < deadlineAt) {
      const closed = await new Promise<boolean>((resolve, reject) => {
        const socket = createConnection({ host: this.host, port: Number(this.port) });
        const finish = (error?: Error, absent = false) => {
          socket.removeAllListeners();
          socket.destroy();
          error ? reject(error) : resolve(absent);
        };
        socket.setTimeout(Math.max(1, Math.min(100, Math.ceil(deadlineAt - performance.now()))));
        socket.once('connect', () => finish());
        socket.once('timeout', () => finish(new Error(`managed daemon listener cleanup probe timed out: ${this.host}:${this.port}`)));
        socket.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'ECONNREFUSED') finish(undefined, true);
          else finish(error);
        });
      });
      if (closed) return;
      await sleep(Math.min(25, Math.max(0, deadlineAt - performance.now())));
    }
    throw new Error(`managed daemon listener remains open after server PID ${proc.pid} exit: ${this.host}:${this.port}`);
  }

  async restart() {
    await this.stop();
    await sleep(200);
    await this.start();
  }

  close() {
    return this.stop();
  }
}

function runTmux(args: string[], options?: TmuxRunOptions) {
  if (!LAB_TMUX_SOCKET) {
    throw new Error('tmux task socket is missing: HOME must name the private focused-run root');
  }
  if (options?.deadlineAt !== undefined && performance.now() >= options.deadlineAt) {
    if (options.oraclePhase) {
      throw new OracleCaptureTimeoutError(options.oraclePhase, options.oracleSamples || []);
    }
    throw new Error(`tmux ${args.join(' ')} deadline exceeded`);
  }
  const result = spawnSync(TMUX_BINARY, ['-S', LAB_TMUX_SOCKET, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      ...(focusedResourcesValidated ? { TMUX_TMPDIR: LAB_TMUX_TMPDIR } : {}),
    },
    timeout: options?.deadlineAt === undefined
      ? options?.timeoutMs
      : Math.max(1, Math.ceil(options.deadlineAt - performance.now())),
    killSignal: options?.deadlineAt === undefined && options?.timeoutMs === undefined ? 'SIGTERM' : 'SIGKILL',
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' && options?.oraclePhase) {
      throw new OracleCaptureTimeoutError(options.oraclePhase, options.oracleSamples || []);
    }
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`tmux ${args.join(' ')} timed out: ${errorMessage(result.error)}`);
    }
    throw result.error;
  }

  if (result.status !== 0 && !options?.allowFailure) {
    throw new Error(result.stderr?.trim() || `tmux ${args.join(' ')} exited with ${result.status}`);
  }

  return result.stdout || '';
}

function getLabPaneId(command = runTmux, target = labSessionTarget()) {
  const paneIds = command(['list-panes', '-t', `=${target}`, '-F', '#{pane_id}'])
    .split(/\r?\n/u)
    .map((paneId) => paneId.trim())
    .filter(Boolean);
  if (paneIds.length !== 1 || !/^%\d+$/u.test(paneIds[0]!)) {
    throw new Error(`tmux returned invalid native pane ids for ${target}: ${paneIds.join(', ') || '(empty)'}`);
  }
  return paneIds[0]!;
}

type SessionPresence =
  | { status: 'present' }
  | { status: 'absent' }
  | { status: 'probe-failed'; error: Error };

function probeSessionPresence(
  sessionName: string,
  options?: { deadlineAt?: number },
): SessionPresence {
  if (!LAB_TMUX_SOCKET) {
    return { status: 'probe-failed', error: new Error('tmux task socket is missing') };
  }
  if (options?.deadlineAt !== undefined && performance.now() >= options.deadlineAt) {
    return { status: 'probe-failed', error: new Error(`tmux has-session deadline exceeded for ${sessionName}`) };
  }
  const remainingMs = options?.deadlineAt === undefined
    ? undefined
    : Math.max(1, Math.ceil(options.deadlineAt - performance.now()));
  const result = spawnSync(TMUX_BINARY, ['-S', LAB_TMUX_SOCKET, 'has-session', '-t', sessionName], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      ...(focusedResourcesValidated ? { TMUX_TMPDIR: LAB_TMUX_TMPDIR } : {}),
    },
    timeout: remainingMs,
    killSignal: 'SIGKILL',
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      return {
        status: 'probe-failed',
        error: new Error(`tmux has-session timed out for ${sessionName}`),
      };
    }
    return { status: 'probe-failed', error: result.error };
  }
  if (result.status === 0) {
    return { status: 'present' };
  }
  if (result.status === 1) {
    return { status: 'absent' };
  }
  return {
    status: 'probe-failed',
    error: new Error(result.stderr?.trim() || `tmux has-session exited with ${result.status}`),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLine(line: string) {
  return line.replace(/\s+$/u, '');
}

function splitCaptureLines(raw: string) {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((_, index, arr) => !(index === arr.length - 1 && arr[index] === ''));
}

function cellsToText(cells: TerminalCell[]) {
  let line = '';
  for (const cell of cells) {
    if (cell.width === 0) {
      continue;
    }
    line += cell.char >= 32 ? String.fromCodePoint(cell.char) : ' ';
  }
  return normalizeLine(line);
}

function ensureCaseDir(caseName: CaseName) {
  const dir = join(ensureEvidenceRunDir(), caseName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureEvidenceRunDir() {
  const dateDir = join(process.cwd(), 'evidence', 'daemon-mirror', currentDateFolder());
  const caseArg = process.argv.find((arg) => arg.startsWith('--case='))?.split('=', 2)[1] || 'all';
  const dir = caseArg === 'long-input-echo' ? join(dateDir, 'runs', LAB_EVIDENCE_RUN_ID) : dateDir;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function probePathPresence(path: string): 'present' | 'absent' {
  try {
    lstatSync(path);
    return 'present';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'absent';
    }
    throw error;
  }
}

function requirePrivateLongInputResources() {
  if (!LAB_TASK_ROOT) {
    throw new Error('long-input task root is unavailable: HOME is empty');
  }
  const taskRootStat = statSync(LAB_TASK_ROOT);
  const canonicalTaskRoot = realpathSync(LAB_TASK_ROOT);
  const canonicalTmpRoot = realpathSync('/tmp');
  const canonicalParent = dirname(canonicalTaskRoot);
  if (canonicalParent !== canonicalTmpRoot) {
    throw new Error(`long-input task root is not directly under /tmp: ${LAB_TASK_ROOT}`);
  }
  const expectedRoot = join(canonicalTmpRoot, basename(resolve(LAB_TASK_ROOT)));
  if (canonicalTaskRoot !== expectedRoot || process.env.HOME !== LAB_TASK_ROOT
    || ![join('/tmp', basename(expectedRoot)), expectedRoot].includes(LAB_TASK_ROOT)) {
    throw new Error(`long-input HOME must name the fresh task root directly under /tmp: ${LAB_TASK_ROOT}`);
  }
  if (!taskRootStat.isDirectory()) {
    throw new Error(`long-input task root is not a directory: ${LAB_TASK_ROOT}`);
  }
  if ((taskRootStat.mode & 0o777) !== 0o700) {
    throw new Error(`long-input task root is not mode 0700: ${LAB_TASK_ROOT}`);
  }
  if (typeof process.getuid === 'function' && taskRootStat.uid !== process.getuid()) {
    throw new Error(`long-input task root is not owned by the current user: ${LAB_TASK_ROOT}`);
  }
  const expectedTmuxTmpdir = join(LAB_TASK_ROOT, '.zterm', 'tmux');
  const actualTmuxTmpdir = process.env.TMUX_TMPDIR?.trim() || '';
  if (!actualTmuxTmpdir || resolve(actualTmuxTmpdir) !== expectedTmuxTmpdir) {
    throw new Error(`long-input TMUX_TMPDIR must be <task-root>/.zterm/tmux: ${actualTmuxTmpdir}`);
  }
  if (!resolve(actualTmuxTmpdir).startsWith(`${resolve(LAB_TASK_ROOT)}${sep}`)) {
    throw new Error(`long-input TMUX_TMPDIR is outside the task root: ${actualTmuxTmpdir}`);
  }
  if (!LAB_TMUX_SOCKET || Buffer.byteLength(LAB_TMUX_SOCKET, 'utf8') >= 100) {
    throw new Error(`long-input tmux socket must be shorter than 100 bytes: ${LAB_TMUX_SOCKET}`);
  }
  if (!resolve(LAB_TMUX_SOCKET).startsWith(`${resolve(LAB_TASK_ROOT)}${sep}`)
    || !resolve(LAB_TMUX_SOCKET).startsWith(`${resolve(LAB_TMUX_TMPDIR)}${sep}`)) {
    throw new Error(`long-input tmux socket is outside the task root: ${LAB_TMUX_SOCKET}`);
  }
  if (process.env.ZTERM_MIRROR_LAB_TMUX_SOCKET || process.env.ZTERM_MIRROR_LAB_SESSION) {
    throw new Error('long-input focused run does not accept caller-owned socket or session overrides');
  }
  if (readdirSync(LAB_TASK_ROOT).length !== 0) {
    throw new Error(`long-input task root is not fresh and empty: ${LAB_TASK_ROOT}`);
  }
  const privateTmuxRoot = join(LAB_TASK_ROOT, '.zterm', 'tmux');
  const privateTempRoot = join(LAB_TASK_ROOT, 'tmp');
  const privateDirs = [
    join(LAB_TASK_ROOT, '.zterm'), privateTmuxRoot, privateTempRoot,
    join(LAB_TASK_ROOT, '.config'), join(LAB_TASK_ROOT, '.local'),
    join(LAB_TASK_ROOT, '.local', 'share'), join(LAB_TASK_ROOT, '.cache'),
    join(LAB_TASK_ROOT, 'bin'),
  ];
  for (const privateDir of privateDirs) {
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    chmodSync(privateDir, 0o700);
    const privateStat = statSync(privateDir);
    if (!privateStat.isDirectory() || (privateStat.mode & 0o777) !== 0o700
      || (typeof process.getuid === 'function' && privateStat.uid !== process.getuid())) {
      throw new Error(`long-input private runtime directory is not owned mode 0700: ${privateDir}`);
    }
  }
  if (probePathPresence(LAB_TMUX_SOCKET) !== 'absent') {
    throw new Error(`long-input default tmux socket already exists: ${LAB_TMUX_SOCKET}`);
  }
  const defaultSocket = join('/tmp', `tmux-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`, 'default');
  if (probePathPresence(defaultSocket) !== 'absent') {
    throw new Error(`long-input refuses an existing default tmux socket: ${defaultSocket}`);
  }
  if (!existsSync(resolve(TMUX_BINARY))) {
    throw new Error(`long-input tmux executable is unavailable: ${TMUX_BINARY}`);
  }
  focusedResourcesValidated = true;
}

function installFocusedTmuxBoundary() {
  if (!LAB_TMUX_BOUNDARY || !focusedResourcesValidated) {
    throw new Error('focused tmux command boundary requires validated private resources');
  }
  const shellQuote = (value: string) => `'${value.replace(/'/gu, `'"'"'`)}'`;
  const launcher = [
    '#!/bin/sh',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -S|-L) [ "$#" -ge 2 ] || exit 2; shift 2 ;;',
    '    *) break ;;',
    '  esac',
    'done',
    `exec ${shellQuote(resolve(TMUX_BINARY))} -S ${shellQuote(LAB_TMUX_SOCKET)} "$@"`,
    '',
  ].join('\n');
  writeFileSync(LAB_TMUX_BOUNDARY, launcher, { mode: 0o700 });
  chmodSync(LAB_TMUX_BOUNDARY, 0o700);
}

function labSessionTarget() {
  return LAB_SESSION_NAME;
}

function exactLabSessionTarget() {
  return `=${LAB_SESSION_NAME}`;
}

function resetLabSession(focused = false) {
  if (focused) {
    if (!focusedResourcesValidated) {
      throw new Error('focused resource preflight has not completed');
    }
    mkdirSync(dirname(LAB_TMUX_SOCKET), { recursive: true, mode: 0o700 });
    acquiredLabSessionId = exactLabSessionTarget();
    const created = runTmux([
      'start-server', ';', 'set-option', '-g', 'history-limit', String(LAB_HISTORY_LIMIT), ';',
      'new-session', '-d', '-s', LAB_SESSION_NAME,
      '-P', '-F', '#{session_id}',
    ], { timeoutMs: WAIT_TIMEOUT_MS }).trim();
    if (!/^\$[0-9]+$/u.test(created)) {
      throw new Error(`tmux did not return an exact created session ID: ${created}`);
    }
    acquiredLabSessionId = created;
    runTmux(['set-option', '-t', created, 'status', 'off'], { timeoutMs: WAIT_TIMEOUT_MS });
    runTmux(['set-option', '-t', created, 'remain-on-exit', 'off'], { timeoutMs: WAIT_TIMEOUT_MS });
    runTmux(['set-window-option', '-t', created, 'window-size', 'manual'], { timeoutMs: WAIT_TIMEOUT_MS });
    return;
  }
  const store = loadScheduleStore();
  const nextJobs = store.jobs.filter((job) => job.targetSessionName !== labSessionTarget());
  if (nextJobs.length !== store.jobs.length) {
    saveScheduleStore(nextJobs);
  }

  const presence = probeSessionPresence(exactLabSessionTarget());
  if (presence.status === 'probe-failed') {
    throw new Error(`failed to probe task-owned tmux session before reset: ${presence.error.message}`);
  }
  if (presence.status === 'present') {
    runTmux(['kill-session', '-t', exactLabSessionTarget()]);
    if (probeSessionPresence(exactLabSessionTarget()).status !== 'absent') {
      throw new Error(`failed to confirm task-owned tmux session absence before reset: ${LAB_SESSION_NAME}`);
    }
  }

  mkdirSync(dirname(LAB_TMUX_SOCKET), { recursive: true, mode: 0o700 });
  acquiredLabSessionId = exactLabSessionTarget();
  const created = runTmux([
    'start-server',
    ';',
    'set-option',
    '-g',
    'history-limit',
    String(LAB_HISTORY_LIMIT),
    ';',
    'new-session',
    '-d',
    '-s',
    LAB_SESSION_NAME,
    '-P',
    '-F',
    '#{session_id}',
  ]).trim();
  if (!/^\$[0-9]+$/u.test(created)) {
    throw new Error(`tmux did not return an exact created session ID: ${created}`);
  }
  acquiredLabSessionId = created;
  runTmux(['set-option', '-t', created, 'status', 'off']);
  runTmux(['set-option', '-t', created, 'remain-on-exit', 'off']);
  runTmux(['set-window-option', '-t', created, 'window-size', 'manual']);
}

function cleanupLabSession() {
  if (!acquiredLabSessionId) {
    return;
  }
  const target = acquiredLabSessionId;
  const deadlineAt = performance.now() + TMUX_CLEANUP_TIMEOUT_MS;
  const before = probeSessionPresence(target, { deadlineAt });
  if (before.status === 'probe-failed') {
    throw new Error(`failed to probe task-owned tmux session for cleanup: ${before.error.message}`);
  }
  if (before.status === 'absent') {
    acquiredLabSessionId = null;
    return;
  }
  let killFailure: unknown = null;
  try {
    runTmux(['kill-session', '-t', target], { deadlineAt });
  } catch (error) {
    killFailure = error;
  }
  const after = probeSessionPresence(target, { deadlineAt });
  if (after.status === 'probe-failed') {
    const confirmationError = new Error(`failed to confirm acquired tmux session cleanup: ${after.error.message}`);
    if (killFailure) {
      throw new Error(`${errorMessage(killFailure)}; ${confirmationError.message}`);
    }
    throw confirmationError;
  }
  if (after.status === 'present') {
    const presenceError = new Error(`acquired tmux session still exists after cleanup: ${target}`);
    if (killFailure) {
      throw new Error(`${errorMessage(killFailure)}; ${presenceError.message}`);
    }
    throw presenceError;
  }
  if (killFailure) {
    throw killFailure;
  }
  acquiredLabSessionId = null;
}

function captureOracleSnapshot(
  expectedPaneId?: string,
  captureOptions?: { deadlineAt?: number; phase?: string; samples?: OracleWaitSample[] },
): OracleSnapshot {
  const commandOptions = {
    deadlineAt: captureOptions?.deadlineAt,
    oraclePhase: captureOptions?.phase,
    oracleSamples: captureOptions?.samples,
  };
  const target = labSessionTarget();
  const paneId = getLabPaneId((args) => runTmux(args, commandOptions));
  if (expectedPaneId && paneId !== expectedPaneId) {
    throw new Error(`tmux oracle pane changed from ${expectedPaneId} to ${paneId}`);
  }
  if (captureOptions?.deadlineAt !== undefined && performance.now() >= captureOptions.deadlineAt) {
    throw new OracleCaptureTimeoutError(captureOptions.phase || 'oracle capture', captureOptions.samples || []);
  }
  const metricText = runTmux([
    'display-message',
    '-p',
    '-t',
    paneId,
    '#{pane_height}\t#{pane_width}\t#{history_size}\t#{history_limit}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}\t#{alternate_on}\t#{pane_current_command}',
  ], commandOptions).trim();
  const [
    rowsRaw = '24',
    colsRaw = '80',
    historyRaw = '0',
    historyLimitRaw = String(LAB_HISTORY_LIMIT),
    cursorXRaw = '0',
    cursorYRaw = '0',
    cursorVisibleRaw = '0',
    alternateOnRaw = '0',
    paneCommandRaw = '',
  ] = metricText.split('\t');
  const paneRows = Math.max(1, Number.parseInt(rowsRaw, 10) || LAB_ROWS);
  const paneCols = Math.max(1, Number.parseInt(colsRaw, 10) || LAB_COLS);
  const historySize = Math.max(0, Number.parseInt(historyRaw, 10) || 0);
  const historyLimit = Math.max(1, Number.parseInt(historyLimitRaw, 10) || 0);
  const cursorX = Math.max(0, Number.parseInt(cursorXRaw, 10) || 0);
  const cursorY = Math.max(0, Number.parseInt(cursorYRaw, 10) || 0);
  const cursorVisible = cursorVisibleRaw === '1';
  const alternateOn = alternateOnRaw === '1';
  const paneCommand = paneCommandRaw.trim();

  const captureWindowStart = -historySize;
  const captureWindowEnd = Math.max(0, paneRows - 1);
  const captureArgs = [
    'capture-pane',
    '-p',
    '-M',
    '-N',
    '-t',
    paneId,
    '-S',
    String(captureWindowStart),
    '-E',
    String(captureWindowEnd),
  ];
  const rawCapture = runTmux(captureArgs, commandOptions);
  if (captureOptions?.deadlineAt !== undefined && performance.now() >= captureOptions.deadlineAt) {
    throw new OracleCaptureTimeoutError(captureOptions.phase || 'oracle capture', captureOptions.samples || []);
  }
  const captureLines = splitCaptureLines(rawCapture);
  const visibleLines = captureLines.slice(Math.max(0, captureLines.length - paneRows));
  const paddedLines = Array.from({ length: paneRows }, (_, index) => (
    normalizeLine(visibleLines[index] || '')
  ));

  return {
    capturedAt: nowStamp(),
    capturedAtMonotonicMs: performance.now(),
    captureArgs,
    captureWindowStart,
    captureWindowEnd,
    captureAbsoluteStartIndex: 0,
    captureAbsoluteEndIndex: historySize + paneRows - 1,
    rawCapture,
    captureLines,
    sessionName: target,
    tmuxSocket: LAB_TMUX_SOCKET,
    paneId,
    paneRows,
    paneCols,
    historySize,
    historyLimit,
    cursorX,
    cursorY,
    cursorVisible,
    alternateOn,
    paneCommand,
    lines: paddedLines,
  };
}

function compareTail(oracle: OracleSnapshot, payload: TerminalBufferPayload | null): CompareResult {
  const expected = oracle.lines;
  if (!payload) {
    return {
      ok: false,
      mismatchIndex: 0,
      expected,
      actual: Array.from({ length: oracle.paneRows }, () => ''),
    };
  }

  const rowCount = Math.max(1, payload.rows || oracle.paneRows);
  const viewportBottom = Math.max(
    0,
    Number.isFinite(payload.availableEndIndex) ? payload.availableEndIndex! : payload.endIndex,
  );
  const startIndex = Math.max(0, viewportBottom - rowCount);
  const linesByIndex = new Map<number, string>();
  for (const line of normalizeWireLines(payload.lines, payload.cols || oracle.paneCols)) {
    linesByIndex.set(line.index, cellsToText(line.cells));
  }

  const actual = Array.from({ length: rowCount }, (_, offset) => (
    normalizeLine(linesByIndex.get(startIndex + offset) || '')
  ));

  let mismatchIndex: number | null = null;
  const compareLength = Math.max(expected.length, actual.length);
  for (let index = 0; index < compareLength; index += 1) {
    if ((expected[index] || '') !== (actual[index] || '')) {
      mismatchIndex = index;
      break;
    }
  }

  return {
    ok: mismatchIndex === null,
    mismatchIndex,
    expected,
    actual,
  };
}

function replayClientMirrorCompare(
  oracle: OracleSnapshot,
  history: Array<{ at: string; type: string; payload: TerminalBufferPayload }>,
): CompareResult {
  const buffer = replayBufferSyncHistory({
    history,
    rows: oracle.paneRows,
    cols: oracle.paneCols,
    cacheLines: DEFAULT_TERMINAL_CACHE_LINES,
  });

  const renderWindow = deriveRenderRows({
    lines: buffer.lines,
    startIndex: buffer.startIndex,
    viewportEndIndex: buffer.bufferTailEndIndex,
    viewportRows: oracle.paneRows,
  });

  const actual = renderWindow.rows.map((entry) => cellsToLine(entry.row));
  const expected = oracle.lines;
  let mismatchIndex: number | null = null;
  const compareLength = Math.max(expected.length, actual.length);
  for (let index = 0; index < compareLength; index += 1) {
    if ((expected[index] || '') !== (actual[index] || '')) {
      mismatchIndex = index;
      break;
    }
  }

  return {
    ok: mismatchIndex === null,
    mismatchIndex,
    expected,
    actual,
  };
}

function buildStepResult(
  label: string,
  oracle: OracleSnapshot,
  daemonPayload: TerminalBufferPayload | null,
  history: Array<{ at: string; type: string; payload: TerminalBufferPayload }>,
  reasonWhenFailed: string,
): CaseStepResult {
  const historyLength = history.length;
  const compare = compareTail(oracle, daemonPayload);
  const clientMirrorCompare = replayClientMirrorCompare(oracle, history.slice(0, historyLength));
  const ok = compare.ok && clientMirrorCompare.ok;
  return {
    label,
    verificationMode: 'source-and-client-render',
    ok,
    reason: !compare.ok
      ? reasonWhenFailed
      : clientMirrorCompare.ok
        ? undefined
        : 'client local mirror diverged from tmux truth',
    oracle,
    daemonPayload,
    compare,
    clientMirrorCompare,
    historyLength,
  };
}

export function compareMarkerDelimitedPayload(
  oracle: Pick<OracleSnapshot, 'captureLines'>,
  marker: string,
  settledMarker: string,
  expected: string[],
): CompareResult {
  const matchesRow = (actual: string, expectedRow: string) =>
    actual.startsWith(expectedRow) && /^ *$/u.test(actual.slice(expectedRow.length));
  const markerIndices = oracle.captureLines.flatMap((line, index) => matchesRow(line, marker) ? [index] : []);
  const settledMarkerIndices = oracle.captureLines.flatMap((line, index) => matchesRow(line, settledMarker) ? [index] : []);
  const markerIndex = markerIndices[0] ?? -1;
  const settledMarkerIndex = settledMarkerIndices[0] ?? -1;
  const markersOrdered = markerIndex >= 0
    && settledMarkerIndex > markerIndex
    && markerIndices.length === 1
    && settledMarkerIndices.length === 1;
  const actual = markersOrdered
    ? oracle.captureLines.slice(markerIndex + 1, settledMarkerIndex)
    : [];
  let mismatchIndex: number | null = null;
  const compareLength = Math.max(expected.length, actual.length);
  for (let index = 0; index < compareLength; index += 1) {
    if (expected[index] === undefined || actual[index] === undefined || !matchesRow(actual[index], expected[index])) {
      mismatchIndex = index;
      break;
    }
  }
  return {
    ok: expected.length > 0 && markersOrdered && actual.length === expected.length && mismatchIndex === null,
    mismatchIndex,
    expected,
    actual,
    range: {
      markerIndex: markerIndex >= 0 ? markerIndex : null,
      settledMarkerIndex: markersOrdered ? settledMarkerIndex : null,
    },
  };
}

function focusedViewportRange(oracle: OracleSnapshot) {
  const endIndex = oracle.captureAbsoluteEndIndex + 1;
  return {
    startIndex: endIndex - oracle.paneRows,
    endIndex,
  };
}

function compareOrderedRows(options: {
  expected: string[];
  actual: string[];
  expectedStartIndex: number;
  actualStartIndex: number;
  actualEndIndex: number;
  coverageComplete: boolean;
  missingIndices: number[];
}) {
  let mismatchIndex: number | null = null;
  const compareLength = Math.max(options.expected.length, options.actual.length);
  for (let index = 0; index < compareLength; index += 1) {
    if ((options.expected[index] ?? '') !== (options.actual[index] ?? '')) {
      mismatchIndex = index;
      break;
    }
  }
  const endIndex = options.expectedStartIndex + options.expected.length;
  return {
    ok: options.coverageComplete
      && options.actual.length === options.expected.length
      && mismatchIndex === null,
    mismatchIndex,
    expected: options.expected,
    actual: options.actual,
    expectedStartIndex: options.expectedStartIndex,
    expectedEndIndex: endIndex,
    actualStartIndex: options.actualStartIndex,
    actualEndIndex: options.actualEndIndex,
    missingIndices: options.missingIndices,
    coverageComplete: options.coverageComplete,
  } satisfies CompareResult;
}

function payloadRowsAtRange(
  oracle: OracleSnapshot,
  payload: TerminalBufferPayload | null,
) {
  const range = focusedViewportRange(oracle);
  if (!payload) {
    const missingIndices = Array.from({ length: oracle.paneRows }, (_, offset) => range.startIndex + offset);
    return {
      rows: [],
      coverageComplete: false,
      actualStartIndex: null,
      actualEndIndex: null,
      missingIndices,
    };
  }
  const rowsByIndex = new Map<number, string>();
  for (const line of normalizeWireLines(payload.lines, payload.cols || oracle.paneCols)) {
    rowsByIndex.set(line.index, cellsToText(line.cells));
  }
  const actualIndices = Array.from({ length: oracle.paneRows }, (_, offset) => range.startIndex + offset)
    .filter((index) => rowsByIndex.has(index));
  const missingIndices = Array.from({ length: oracle.paneRows }, (_, offset) => range.startIndex + offset)
    .filter((index) => !rowsByIndex.has(index));
  const rows = actualIndices.map((index) => rowsByIndex.get(index)!);
  return {
    rows,
    coverageComplete: missingIndices.length === 0
      && payload.startIndex <= range.startIndex
      && payload.endIndex >= range.endIndex,
    actualStartIndex: actualIndices[0] ?? null,
    actualEndIndex: actualIndices.length ? actualIndices[actualIndices.length - 1]! + 1 : null,
    missingIndices,
  };
}

function replayRowsAtRange(
  oracle: OracleSnapshot,
  payload: TerminalBufferPayload | null,
  history: Array<{ at: string; type: string; payload: TerminalBufferPayload }>,
) {
  const range = focusedViewportRange(oracle);
  const buffer = replayBufferSyncHistory({
    history,
    rows: oracle.paneRows,
    cols: oracle.paneCols,
    cacheLines: DEFAULT_TERMINAL_CACHE_LINES,
  });
  const rowsByIndex = new Map<number, string>();
  const rows = Array.from({ length: oracle.paneRows }, (_, offset) => {
    const absoluteIndex = range.startIndex + offset;
    const rowOffset = absoluteIndex - buffer.startIndex;
    if (rowOffset < 0 || rowOffset >= buffer.lines.length || buffer.lines[rowOffset] === undefined
      || buffer.gapRanges.some((gap) => absoluteIndex >= gap.startIndex && absoluteIndex < gap.endIndex)) {
      return undefined;
    }
    const line = cellsToLine(buffer.lines[rowOffset]!);
    rowsByIndex.set(absoluteIndex, line);
    return line;
  });
  const coveredRows = rows.filter((line): line is string => line !== undefined);
  return {
    rows: coveredRows,
    coverageComplete: coveredRows.length === oracle.paneRows
      && buffer.gapRanges.every((gap) => gap.endIndex <= range.startIndex || gap.startIndex >= range.endIndex)
      && buffer.startIndex <= range.startIndex
      && buffer.bufferTailEndIndex >= range.endIndex
      && Boolean(payload),
    actualStartIndex: rowsByIndex.keys().next().value ?? null,
    actualEndIndex: rowsByIndex.size ? Math.max(...rowsByIndex.keys()) + 1 : null,
    missingIndices: Array.from({ length: oracle.paneRows }, (_, offset) => range.startIndex + offset)
      .filter((index) => !rowsByIndex.has(index)),
  };
}

function compareSettledDaemonWindow(
  oracle: OracleSnapshot,
  payload: TerminalBufferPayload | null,
): CompareResult {
  const range = focusedViewportRange(oracle);
  const daemonWindow = payloadRowsAtRange(oracle, payload);
  return compareOrderedRows({
    expected: oracle.lines,
    actual: daemonWindow.rows,
    expectedStartIndex: range.startIndex,
    actualStartIndex: daemonWindow.actualStartIndex ?? -1,
    actualEndIndex: daemonWindow.actualEndIndex ?? -1,
    coverageComplete: daemonWindow.coverageComplete,
    missingIndices: daemonWindow.missingIndices,
  });
}

function compareSettledClientWindow(
  oracle: OracleSnapshot,
  payload: TerminalBufferPayload | null,
  history: Array<{ at: string; type: string; payload: TerminalBufferPayload }>,
): CompareResult {
  const range = focusedViewportRange(oracle);
  const daemonWindow = payloadRowsAtRange(oracle, payload);
  const clientWindow = replayRowsAtRange(oracle, payload, history);
  return compareOrderedRows({
    expected: daemonWindow.rows,
    actual: clientWindow.rows,
    expectedStartIndex: range.startIndex,
    actualStartIndex: clientWindow.actualStartIndex ?? -1,
    actualEndIndex: clientWindow.actualEndIndex ?? -1,
    coverageComplete: daemonWindow.coverageComplete && clientWindow.coverageComplete,
    missingIndices: [...daemonWindow.missingIndices, ...clientWindow.missingIndices],
  });
}

function buildLongInputSourceStep(options: {
  oracle: OracleSnapshot;
  marker: string;
  settledMarker: string;
  expectedLines: string[];
  payloadLineCount: number;
  preludeChunkCount: number;
  bodyChunkCount: number;
  bodyBytes: number;
}) {
  const compare = compareMarkerDelimitedPayload(
    options.oracle,
    options.marker,
    options.settledMarker,
    options.expectedLines,
  );
  const ok = compare.ok && options.bodyChunkCount > 1;
  return {
    label: 'long-input-source-target-payload',
    verificationMode: 'source-only',
    ok,
    reason: ok ? undefined : 'long-input target payload was not reproduced exactly by tmux',
    oracle: options.oracle,
    compare,
    historyLength: 0,
    details: {
      payloadLineCount: options.payloadLineCount,
      preludeChunkCount: options.preludeChunkCount,
      bodyChunkCount: options.bodyChunkCount,
      bodyBytes: options.bodyBytes,
    },
  } satisfies CaseStepResult;
}

export function finalizeCase(caseName: CaseName, steps: CaseStepResult[]): CaseResult {
  const failedStep = steps.find((step) => !step.ok);
  const primary = failedStep || steps[steps.length - 1];
  const result: CaseResult = {
    caseName,
    ok: !failedStep,
    reason: failedStep?.reason,
    oracle: primary?.oracle ?? null,
    daemonPayload: primary?.daemonPayload ?? null,
    compare: primary?.compare,
    steps,
  };
  if (caseName === 'codex-live' && result.ok) {
    const required = ['codex-shell-visible', 'codex-shell-local-echo', 'codex-shell-tail-refresh'];
    if (steps.length !== required.length || required.some((label, index) => steps[index]?.label !== label)) {
      result.ok = false;
      result.reason = `incomplete codex-live stages: require ordered ${required.join(', ')}`;
    }
  }
  return result;
}

async function waitForOracle(
  label: string,
  predicate: (oracle: OracleSnapshot) => boolean,
  timeoutMs: number = WAIT_TIMEOUT_MS,
  samples?: OracleWaitSample[],
  paneId?: string,
  deadlineAt: number = performance.now() + timeoutMs,
) {
  const retainedSamples = samples || [];
  let previousSignature: string | null = null;
  let previousWallCapturedAtMs: number | null = null;
  let previousMonotonicCapturedAtMs: number | null = null;
  while (performance.now() < deadlineAt) {
    let oracle: OracleSnapshot;
    let predicateMatched: boolean;
    try {
      oracle = captureOracleSnapshot(paneId, { deadlineAt, phase: label, samples: retainedSamples });
      if (performance.now() > deadlineAt) {
        throw new OracleCaptureTimeoutError(label, retainedSamples);
      }
      predicateMatched = predicate(oracle);
    } catch (error) {
      if (error instanceof OracleCaptureTimeoutError) {
        throw new OracleTimeoutError(label, retainedSamples);
      }
      throw new OracleObservationError(label, error, retainedSamples);
    }
    const wallCapturedAtMs = Date.parse(oracle.capturedAt);
    const monotonicCapturedAtMs = oracle.capturedAtMonotonicMs;
    const elapsedSincePreviousWallMs = previousWallCapturedAtMs === null
      ? null
      : wallCapturedAtMs - previousWallCapturedAtMs;
    const elapsedSincePreviousMonotonicMs = previousMonotonicCapturedAtMs === null
      ? null
      : monotonicCapturedAtMs - previousMonotonicCapturedAtMs;
    const signature = JSON.stringify([
        oracle.sessionName,
        oracle.tmuxSocket,
        oracle.paneId,
        oracle.paneRows,
        oracle.paneCols,
        oracle.historySize,
        oracle.historyLimit,
        oracle.captureWindowStart,
        oracle.captureWindowEnd,
        oracle.captureAbsoluteStartIndex,
        oracle.captureAbsoluteEndIndex,
        oracle.cursorX,
        oracle.cursorY,
        oracle.cursorVisible,
        oracle.alternateOn,
        oracle.paneCommand,
        oracle.captureLines,
    ]);
    const stable = predicateMatched
      && signature === previousSignature
      && elapsedSincePreviousMonotonicMs !== null
      && elapsedSincePreviousMonotonicMs >= ORACLE_STABLE_INTERVAL_MS;
    retainedSamples.push({
        capturedAt: oracle.capturedAt,
        capturedAtMonotonicMs: monotonicCapturedAtMs,
        elapsedSincePreviousWallMs,
        elapsedSincePreviousMonotonicMs,
        predicateMatched,
        stable,
        snapshot: oracle,
    });
    if (retainedSamples.length > ORACLE_SAMPLE_LIMIT) {
      retainedSamples.shift();
    }
    if (stable) {
      if (performance.now() >= deadlineAt) {
        throw new OracleTimeoutError(label, retainedSamples);
      }
      return oracle;
    }
    if (predicateMatched) {
      previousSignature = signature;
      previousWallCapturedAtMs = wallCapturedAtMs;
      previousMonotonicCapturedAtMs = monotonicCapturedAtMs;
    } else {
      previousSignature = null;
      previousWallCapturedAtMs = null;
      previousMonotonicCapturedAtMs = null;
    }
    const sleepMs = Math.min(100, Math.max(0, deadlineAt - performance.now()));
    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  }
  throw new OracleTimeoutError(label, retainedSamples);
}

async function waitForPayloadToMatchOracle(
  probe: Pick<DaemonProbe, 'payload' | 'history' | 'waitForHistory'>,
  label: string,
  oracle: OracleSnapshot,
  timeoutMs: number = WAIT_TIMEOUT_MS,
) {
  return probe.waitForHistory(
    label,
    () => (
      compareTail(oracle, probe.payload).ok
      && replayClientMirrorCompare(oracle, probe.history).ok
    ),
    timeoutMs,
  );
}

export class AttachedTmuxOperator {
  constructor(private readonly command = runTmux, private readonly sessionTarget = labSessionTarget()) {}

  async attach() {
    return;
  }

  write(input: string) {
    const paneId = getLabPaneId(this.command, this.sessionTarget);
    const enter = input.endsWith('\r');
    const text = enter ? input.slice(0, -1) : input;
    if (text) {
      this.command(['send-keys', '-t', paneId, '-l', '--', text]);
    }
    if (enter) {
      this.command(['send-keys', '-t', paneId, 'C-m']);
    }
  }

  close() {
    return;
  }
}

class DaemonProbe {
  private readonly wsUrl: string;

  private readonly openRequestId: string;

  private controlWs: WebSocket | null = null;

  private ws: WebSocket | null = null;

  private connected = false;

  private lastPayload: TerminalBufferPayload | null = null;

  private lastHead: { revision: number; latestEndIndex: number } | null = null;

  private lastHeadRequestedAt = 0;

  private readonly payloadHistory: Array<{ at: string; type: string; payload: TerminalBufferPayload }> = [];

  private readonly eventHistory: ProbeEventEntry[] = [];

  private readonly scheduleEvents: Array<ServerMessage & { type: 'schedule-event' }> = [];

  private readonly scheduleEventWaiters: ScheduleEventWaiter[] = [];

  private attachHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private cleanupFailure: Error | null = null;

  private readonly deferredCleanupFailures: unknown[] = [];

  constructor(wsUrl: string, authToken: string) {
    this.wsUrl = authToken ? `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(authToken)}` : wsUrl;
    this.openRequestId = `probe-${Math.random().toString(36).slice(2, 10)}`;
  }

  get payload() {
    return this.lastPayload;
  }

  get history() {
    return this.payloadHistory;
  }

  get events() {
    return this.eventHistory;
  }

  deferCleanupFailure(error: unknown) {
    this.deferredCleanupFailures.push(error);
  }

  consumeDeferredCleanupFailures() {
    return this.deferredCleanupFailures.splice(0);
  }

  private buildTransportUrl(role: 'control' | 'session') {
    const url = new URL(this.wsUrl);
    url.searchParams.set('ztermTransport', role);
    return url.toString();
  }

  absorb(other: DaemonProbe, fromHistoryIndex = 0) {
    if (other.payload) {
      this.lastPayload = other.payload;
    }
    if (other.lastHead) {
      this.lastHead = other.lastHead;
    }
    this.payloadHistory.push(...other.history.slice(fromHistoryIndex));
    this.eventHistory.push(...other.events);
  }

  async connect() {
    const handshakeDeadlineAt = performance.now() + PROBE_HANDSHAKE_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      const controlWs = new WebSocket(this.buildTransportUrl('control'));
      let establishment: 'pending' | 'failed' | 'established' = 'pending';
      let pendingPayload: { at: string; type: string; payload: TerminalBufferPayload } | null = null;
      const handshakeTimer = setTimeout(() => {
        fail(new Error(`daemon probe handshake timed out after ${PROBE_HANDSHAKE_TIMEOUT_MS}ms`));
      }, Math.max(1, handshakeDeadlineAt - performance.now()));
      const fail = (error: Error) => {
        if (establishment === 'pending') {
          establishment = 'failed';
          pendingPayload = null;
          clearTimeout(handshakeTimer);
          reject(error);
        }
      };
      const succeed = () => {
        if (establishment === 'pending' && this.connected && pendingPayload) {
          if (performance.now() >= handshakeDeadlineAt) {
            fail(new Error(`daemon probe handshake timed out after ${PROBE_HANDSHAKE_TIMEOUT_MS}ms`));
            return;
          }
          establishment = 'established';
          this.lastPayload = pendingPayload.payload;
          this.payloadHistory.push(pendingPayload);
          pendingPayload = null;
          clearTimeout(handshakeTimer);
          resolve();
        }
      };
      this.controlWs = controlWs;

      controlWs.on('open', () => {
        if (establishment === 'failed') return;
        const sessionOpenPayload = {
          openRequestId: this.openRequestId,
          sessionName: labSessionTarget(),
          cols: LAB_COLS,
          rows: LAB_ROWS,
        };
        const sessionOpenMessage: ClientMessage = {
          type: 'session-open',
          payload: sessionOpenPayload,
        };
        this.eventHistory.push({
          at: nowStamp(),
          direction: 'sent',
          type: sessionOpenMessage.type,
          payload: summarizeProbeMessage(sessionOpenMessage.type, sessionOpenPayload),
        });
        controlWs.send(JSON.stringify(sessionOpenMessage));
      });

      controlWs.on('message', (raw) => {
        if (establishment === 'failed') return;
        const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
        const message = JSON.parse(text) as ServerMessage;
        this.eventHistory.push({
          at: nowStamp(),
          direction: 'recv',
          type: message.type,
          payload: (
            message.type === 'buffer-sync'
              ? {
                  ...summarizeProbeMessage(message.type, 'payload' in message ? message.payload : undefined) as Record<string, unknown>,
                  wireKind: detectBufferSyncWireKind(text),
                }
              : summarizeProbeMessage(message.type, 'payload' in message ? message.payload : undefined)
          ),
        });
        if (message.type === 'session-ticket') {
          const sessionWs = new WebSocket(this.buildTransportUrl('session'));
          this.ws = sessionWs;
          sessionWs.on('open', () => {
            if (establishment === 'failed') return;
            const connectPayload = {
              openRequestId: this.openRequestId,
              sessionTransportToken: message.payload.sessionTransportToken,
              sessionName: labSessionTarget(),
              cols: LAB_COLS,
              rows: LAB_ROWS,
            };
            const connectMessage: ClientMessage = {
              type: 'connect',
              payload: connectPayload,
            };
            this.eventHistory.push({
              at: nowStamp(),
              direction: 'sent',
              type: connectMessage.type,
              payload: summarizeProbeMessage(connectMessage.type, connectPayload),
            });
            sessionWs.send(JSON.stringify(connectMessage));
          });
          sessionWs.on('message', (sessionRaw) => {
            if (establishment === 'failed') return;
            const sessionText = typeof sessionRaw === 'string' ? sessionRaw : sessionRaw.toString('utf-8');
            const sessionMessage = JSON.parse(sessionText) as ServerMessage;
            this.eventHistory.push({
              at: nowStamp(),
              direction: 'recv',
              type: sessionMessage.type,
              payload: (
                sessionMessage.type === 'buffer-sync'
                  ? {
                      ...summarizeProbeMessage(sessionMessage.type, 'payload' in sessionMessage ? sessionMessage.payload : undefined) as Record<string, unknown>,
                      wireKind: detectBufferSyncWireKind(sessionText),
                    }
                  : summarizeProbeMessage(sessionMessage.type, 'payload' in sessionMessage ? sessionMessage.payload : undefined)
              ),
            });
            if (sessionMessage.type === 'connected') {
              if (establishment === 'pending' && performance.now() >= handshakeDeadlineAt) {
                fail(new Error(`daemon probe handshake timed out after ${PROBE_HANDSHAKE_TIMEOUT_MS}ms`));
                return;
              }
              this.connected = true;
              this.startAttachHeartbeat();
              this.requestHead(true);
              succeed();
              return;
            }
            if (sessionMessage.type === 'buffer-head') {
              this.lastHead = {
                revision: Math.max(0, Math.floor(sessionMessage.payload.revision || 0)),
                latestEndIndex: Math.max(0, Math.floor(sessionMessage.payload.latestEndIndex || 0)),
              };
              this.requestFollowWindow(this.lastHead.latestEndIndex);
              return;
            }
            if (sessionMessage.type === 'buffer-sync') {
              if (establishment === 'pending' && performance.now() >= handshakeDeadlineAt) {
                fail(new Error(`daemon probe handshake timed out after ${PROBE_HANDSHAKE_TIMEOUT_MS}ms`));
                return;
              }
              const entry = {
                at: nowStamp(),
                type: sessionMessage.type,
                payload: sessionMessage.payload,
              };
              if (establishment === 'pending') {
                pendingPayload ||= entry;
                succeed();
              } else {
                this.lastPayload = entry.payload;
                this.payloadHistory.push(entry);
              }
            }
            if (sessionMessage.type === 'error') {
              fail(new Error(sessionMessage.payload.message));
              return;
            }
            if (sessionMessage.type === 'schedule-event') {
              this.scheduleEvents.push(sessionMessage);
              const waiter = this.scheduleEventWaiters.shift();
              if (waiter) {
                clearTimeout(waiter.timer);
                waiter.resolve(sessionMessage);
              }
            }
          });
          sessionWs.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
          sessionWs.on('close', (code, reason) => {
            if (establishment === 'pending') {
              fail(new Error(`daemon session websocket closed before initial buffer-sync: code=${code} reason=${reason.toString('utf-8')}`));
            }
          });
          return;
        }
        if (message.type === 'session-open-failed' || message.type === 'error') {
          fail(new Error('payload' in message && message.payload && typeof message.payload === 'object' && 'message' in message.payload
            ? String((message.payload as { message?: string }).message || 'daemon control error')
            : 'daemon control error'));
          return;
        }
      });

      controlWs.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));

      controlWs.on('close', (code, reason) => {
        if (establishment === 'pending') {
          fail(new Error(`daemon control websocket closed before initial buffer-sync: code=${code} reason=${reason.toString('utf-8')}`));
        }
      });
    });
  }

  private async closeSocket(ws: WebSocket | null, role: 'control' | 'session') {
    if (!ws) {
      return;
    }
    if (ws.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let terminating = false;
      let terminationError: unknown;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        ws.off('close', onClose);
        ws.off('error', terminate);
        if (error) reject(error);
        else resolve();
      };
      const onClose = () => finish();
      const terminate = () => {
        if (settled || terminating) return;
        terminating = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error(
          `daemon probe ${role} websocket cleanup unconfirmed: no close event within 300ms after terminate${terminationError ? `; terminate: ${errorMessage(terminationError)}` : ''}`,
        )), 300);
        try {
          ws.terminate();
        } catch (error) {
          terminationError = error;
        }
      };
      timer = setTimeout(terminate, 300);
      ws.once('close', onClose);
      ws.on('error', terminate);
      if (ws.readyState < WebSocket.CLOSING) {
        try {
          ws.close();
        } catch {
          terminate();
        }
      }
    });
  }

  async close() {
    if (this.attachHeartbeatTimer) {
      clearInterval(this.attachHeartbeatTimer);
      this.attachHeartbeatTimer = null;
    }
    const controlWs = this.controlWs;
    const sessionWs = this.ws;
    await Promise.all([
      this.closeSocket(controlWs, 'control'),
      this.closeSocket(sessionWs, 'session'),
    ].map(async (closure) => {
      try {
        await closure;
      } catch (error) {
        this.cleanupFailure ||= error instanceof Error ? error : new Error(String(error));
      }
    }));
    this.controlWs = null;
    this.ws = null;
    if (this.cleanupFailure) throw this.cleanupFailure;
  }

  private startAttachHeartbeat() {
    if (this.attachHeartbeatTimer) {
      return;
    }
    const sendHeartbeat = () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const message = {
        type: 'body-subscription',
        payload: { version: 1, subscribed: true },
      } satisfies ClientMessage;
      this.ws.send(JSON.stringify(message));
      this.eventHistory.push({
        at: nowStamp(),
        direction: 'sent',
        type: message.type,
        payload: message.payload,
      });
    };
    sendHeartbeat();
    this.attachHeartbeatTimer = setInterval(sendHeartbeat, 30_000);
    this.attachHeartbeatTimer.unref?.();
  }

  sendInput(data: string, options?: { requestHead?: boolean }) {
    if (!this.ws || !this.connected) {
      throw new Error('probe is not connected');
    }
    const message: ClientMessage = { type: 'input', payload: data };
    this.eventHistory.push({
      at: nowStamp(),
      direction: 'sent',
      type: message.type,
      payload: summarizeProbeMessage(message.type, message.payload),
    });
    this.ws.send(JSON.stringify(message));
    if (options?.requestHead !== false) {
      this.requestHead(true);
    }
  }

  requestHead(force = false) {
    if (!this.ws || !this.connected) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastHeadRequestedAt < 80) {
      return;
    }
    this.lastHeadRequestedAt = now;
    const message = { type: 'buffer-head-request' } satisfies ClientMessage;
    this.eventHistory.push({
      at: nowStamp(),
      direction: 'sent',
      type: message.type,
      payload: undefined,
    });
    this.ws.send(JSON.stringify(message));
  }

  private requestFollowWindow(viewportEndIndex: number) {
    if (!this.ws || !this.connected) {
      return;
    }
    const requestEndIndex = Math.max(
      0,
      Math.floor(
        viewportEndIndex
        || this.lastPayload?.availableEndIndex
        || this.lastPayload?.endIndex
        || 0,
      ),
    );
    const requestStartIndex = Math.max(
      Math.max(0, Math.floor(this.lastPayload?.availableStartIndex || this.lastPayload?.startIndex || 0)),
      requestEndIndex - LAB_ROWS * 3,
    );
    const payload: BufferSyncRequestPayload = {
      knownRevision: Math.max(0, Math.floor(this.lastPayload?.revision || 0)),
      localStartIndex: Math.max(0, Math.floor(this.lastPayload?.startIndex || 0)),
      localEndIndex: Math.max(0, Math.floor(this.lastPayload?.endIndex || 0)),
      requestStartIndex,
      requestEndIndex,
    };
    const message = {
      type: 'buffer-sync-request',
      payload,
    } satisfies ClientMessage;
    this.eventHistory.push({
      at: nowStamp(),
      direction: 'sent',
      type: message.type,
      payload: summarizeProbeMessage(message.type, message.payload),
    });
    this.ws.send(JSON.stringify(message));
  }

  async waitForPayload(label: string, predicate?: (payload: TerminalBufferPayload) => boolean, timeoutMs: number = WAIT_TIMEOUT_MS) {
    const deadlineAt = performance.now() + timeoutMs;
    while (performance.now() < deadlineAt) {
      this.requestHead();
      if (this.lastPayload && (!predicate || predicate(this.lastPayload))) {
        if (performance.now() >= deadlineAt) break;
        return this.lastPayload;
      }
      await sleep(Math.min(80, Math.max(0, deadlineAt - performance.now())));
    }
    throw new Error(`timeout waiting for payload: ${label}`);
  }

  async waitForHistory(label: string, predicate: () => boolean, timeoutMs: number = WAIT_TIMEOUT_MS) {
    const deadlineAt = performance.now() + timeoutMs;
    while (performance.now() < deadlineAt) {
      this.requestHead();
      if (performance.now() < deadlineAt && this.lastPayload && predicate()) {
        if (performance.now() >= deadlineAt) break;
        return this.lastPayload;
      }
      await sleep(Math.min(80, Math.max(0, deadlineAt - performance.now())));
    }
    throw new Error(`timeout waiting for payload history: ${label}`);
  }

  private historyText() {
    const rows = Math.max(1, this.lastPayload?.rows || LAB_ROWS);
    const cols = Math.max(1, this.lastPayload?.cols || LAB_COLS);
    const buffer = replayBufferSyncHistory({
      history: this.payloadHistory,
      rows,
      cols,
      cacheLines: DEFAULT_TERMINAL_CACHE_LINES,
    });
    const renderWindow = deriveRenderRows({
      lines: buffer.lines,
      startIndex: buffer.startIndex,
      viewportEndIndex: buffer.bufferTailEndIndex,
      viewportRows: rows,
    });
    return renderWindow.rows.map((entry) => cellsToLine(entry.row)).join('\n');
  }

  async waitForMarker(marker: string, timeoutMs: number = WAIT_TIMEOUT_MS) {
    return this.waitForHistory(
      `marker ${marker}`,
      () => this.historyText().includes(marker),
      timeoutMs,
    );
  }

  sendMessage(message: ClientMessage) {
    if (!this.ws || !this.connected) {
      throw new Error('probe is not connected');
    }
    this.eventHistory.push({
      at: nowStamp(),
      direction: 'sent',
      type: message.type,
      payload: summarizeProbeMessage(message.type, 'payload' in message ? (message as Record<string, unknown>).payload : undefined),
    });
    this.ws.send(JSON.stringify(message));
  }

  waitForScheduleEvent(predicate?: (event: ScheduleEventPayload) => boolean, timeoutMs: number = 5000) {
    return new Promise<ServerMessage & { type: 'schedule-event' }>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.scheduleEventWaiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) {
          this.scheduleEventWaiters.splice(idx, 1);
        }
        reject(new Error('timeout waiting for schedule-event'));
      }, timeoutMs);
      this.scheduleEventWaiters.push({
        resolve: (event) => {
          if (!predicate || predicate(event.payload)) {
            resolve(event);
          } else {
            // re-queue: doesn't match predicate yet
            this.waitForScheduleEvent(predicate, timeoutMs).then(resolve, reject);
          }
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      // also check already-received events
      const existing = this.scheduleEvents.find((e) => !predicate || predicate(e.payload));
      if (existing) {
        const w = this.scheduleEventWaiters.pop();
        if (w) {
          clearTimeout(w.timer);
          w.resolve(existing);
        }
      }
    });
  }
}

function writeCaseEvidence(result: CaseResult, probe: DaemonProbe | null) {
  const caseDir = ensureCaseDir(result.caseName);
  // Dated --case=all paths are reused; absent current comparisons must retire old ones.
  if (!result.compare) rmSync(join(caseDir, 'comparison.json'), { force: true });
  if (!result.clientMirrorCompare) rmSync(join(caseDir, 'client-mirror-comparison.json'), { force: true });
  if (result.oracle) {
    writeFileSync(join(caseDir, 'tmux-capture.txt'), `${result.oracle.lines.join('\n')}\n`);
    writeFileSync(join(caseDir, 'tmux-capture-raw.txt'), result.oracle.rawCapture);
    writeFileSync(
      join(caseDir, 'tmux-metrics.txt'),
      [
        `session=${result.oracle.sessionName}`,
        `socket=${result.oracle.tmuxSocket}`,
        `paneId=${result.oracle.paneId}`,
        `rows=${result.oracle.paneRows}`,
        `cols=${result.oracle.paneCols}`,
        `history=${result.oracle.historySize}`,
        `historyLimit=${result.oracle.historyLimit}`,
        `captureWindowStart=${result.oracle.captureWindowStart}`,
        `captureWindowEnd=${result.oracle.captureWindowEnd}`,
        `captureAbsoluteStartIndex=${result.oracle.captureAbsoluteStartIndex}`,
        `captureAbsoluteEndIndex=${result.oracle.captureAbsoluteEndIndex}`,
        `cursorX=${result.oracle.cursorX}`,
        `cursorY=${result.oracle.cursorY}`,
        `cursorVisible=${result.oracle.cursorVisible ? '1' : '0'}`,
        `alternateOn=${result.oracle.alternateOn ? '1' : '0'}`,
        `paneCommand=${result.oracle.paneCommand}`,
      ].join('\n') + '\n',
    );
  }
  writeFileSync(join(caseDir, 'daemon-payload.json'), `${JSON.stringify(result.daemonPayload, null, 2)}\n`);
  if (probe) {
    writeFileSync(join(caseDir, 'probe-history.json'), `${JSON.stringify(probe.history, null, 2)}\n`);
    writeFileSync(join(caseDir, 'probe-events.json'), `${JSON.stringify(probe.events, null, 2)}\n`);
  }
  if (result.compare) {
    writeFileSync(join(caseDir, 'comparison.json'), `${JSON.stringify(result.compare, null, 2)}\n`);
  }
  if (result.clientMirrorCompare) {
    writeFileSync(join(caseDir, 'client-mirror-comparison.json'), `${JSON.stringify(result.clientMirrorCompare, null, 2)}\n`);
  }
  if (result.steps?.length) {
    writeFileSync(join(caseDir, 'step-results.json'), `${JSON.stringify(result.steps, null, 2)}\n`);
  }
  if (result.oracleSamples) {
    writeFileSync(
      join(caseDir, 'oracle-samples.json'),
      `${JSON.stringify({
        generatedAt: nowStamp(),
        classification: classifyCaseResult(result),
        failureCauses: result.failureCauses || [],
        sampleLimit: ORACLE_SAMPLE_LIMIT,
        stableIntervalMs: ORACLE_STABLE_INTERVAL_MS,
        ...result.oracleSamples,
      }, null, 2)}\n`,
    );
  }
  writeFileSync(
    join(caseDir, 'summary.txt'),
    [
      `case=${result.caseName}`,
      `ok=${result.ok}`,
      `reason=${result.reason || ''}`,
      `failureCauses=${JSON.stringify(result.failureCauses || [])}`,
      `mismatchIndex=${result.compare?.mismatchIndex ?? 'none'}`,
      `classification=${classifyCaseResult(result)}`,
      `generatedAt=${nowStamp()}`,
    ].join('\n') + '\n',
  );
}

function classifyCaseResult(result: CaseResult) {
  if (result.classification) {
    return result.classification;
  }
  if (result.ok) {
    return 'PASS';
  }
  if (result.caseName === 'long-input-echo' && result.reason?.includes('timeout waiting for oracle')) {
    return 'UNVERIFIED_ORACLE_TIMEOUT';
  }
  return result.caseName === 'long-input-echo' ? 'FAIL_PRODUCT_COMPARISON' : 'FAIL';
}

function appendFailureCause(result: CaseResult, stage: string, error: unknown) {
  const wasSuccessful = result.ok;
  const message = errorMessage(error);
  result.failureCauses ||= [];
  if (!result.failureCauses.some((cause) => cause.stage === stage && cause.message === message)) {
    result.failureCauses.push({ stage, message });
  }
  result.ok = false;
  result.reason = result.reason ? `${result.reason}; ${stage}: ${message}` : `${stage}: ${message}`;
  if ((stage === 'tmux-cleanup'
    || stage === 'socket-cleanup'
    || stage === 'probe-cleanup'
    || stage === 'payload-cleanup'
    || stage === 'daemon-cleanup')
    && wasSuccessful) {
    result.classification = 'UNVERIFIED_CLEANUP';
  } else if (!result.classification || result.classification === 'PASS') {
    result.classification = 'FAIL';
  }
}

function retainedOracleFromError(error: unknown) {
  if (error instanceof OracleTimeoutError || error instanceof OracleCaptureTimeoutError || error instanceof OracleObservationError) {
    return error.lastSnapshot;
  }
  return null;
}

function buildFailedCaseResult(
  caseName: CaseName,
  error: unknown,
  probe: Pick<DaemonProbe, 'payload'> | null,
  oracle: OracleSnapshot | null = retainedOracleFromError(error),
) {
  return {
    caseName,
    ok: false,
    reason: errorMessage(error),
    classification: 'FAIL',
    oracle,
    daemonPayload: probe?.payload || null,
    failureCauses: [{ stage: 'case', message: errorMessage(error) }],
  } satisfies CaseResult;
}

async function runInitialSyncCase(probe: DaemonProbe): Promise<CaseResult> {
  const oracle = captureOracleSnapshot();
  const payload = await waitForPayloadToMatchOracle(
    probe,
    'initial sync settled payload',
    oracle,
  );
  return finalizeCase('initial-sync', [
    buildStepResult('initial-sync', oracle, payload, probe.history, 'daemon last screen != tmux last screen on initial sync'),
  ]);
}

async function runLocalInputCase(probe: DaemonProbe): Promise<CaseResult> {
  const steps: CaseStepResult[] = [];

  const markerA = '__daemon_local_a__';
  probe.sendInput(`printf 'hello-daemon-a\\n${markerA}\\n'\r`);
  const payloadA = await probe.waitForMarker(markerA);
  await sleep(200);
  const oracleA = captureOracleSnapshot();
  steps.push(
    buildStepResult('local-input-echo-a', oracleA, payloadA, probe.history, 'daemon local-input mirror diverged from tmux truth'),
  );
  if (!steps[steps.length - 1]?.ok) {
    return finalizeCase('local-input-echo', steps);
  }

  const markerB = '__daemon_local_b__';
  probe.sendInput(`printf 'hello-daemon-b\\n${markerB}\\n'\r`);
  const payloadB = await probe.waitForMarker(markerB);
  await sleep(200);
  const oracleB = captureOracleSnapshot();
  steps.push(
    buildStepResult('local-input-echo-b', oracleB, payloadB, probe.history, 'daemon second local-input mirror diverged from tmux truth'),
  );

  return finalizeCase('local-input-echo', steps);
}

export function buildLongInputOracleProbe() {
  const taskRoot = LAB_TASK_ROOT;
  const lines: string[] = [];
  for (let index = 0; index < 1200; index += 1) {
    lines.push(`zterm-long-input-${String(index).padStart(3, '0')}-${'abc123XYZ'.repeat(5)}-${index.toString(36)}`);
  }
  const fileContent = `${lines.join('\n')}\n`;
  const markerToken = `${Date.now().toString(36)}_${process.pid.toString(36)}`;
  const filePath = join(taskRoot, `.zterm-long-input-${markerToken}.txt`);
  const marker = `__zterm_long_input_start_${markerToken}__`;
  const readyMarker = `__zterm_long_input_ready_${markerToken}__`;
  const settledMarker = `__zterm_long_input_settled_${markerToken}__`;
  const preludeInput = `stty -echo; printf '${readyMarker}\\n'; cat > '${filePath}'\r`;
  const bodyInput = `${fileContent}\x04printf '${marker}\\n' && cat '${filePath}' && printf '${settledMarker}\\n' && stty echo\r`;
  return {
    marker,
    readyMarker,
    settledMarker,
    fileContent,
    payloadLines: lines,
    filePath,
    preludeInput,
    bodyInput,
  };
}

function resolveIdleShellCommand(deadlineAt: number, phase: string, samples: OracleWaitSample[]) {
  const defaultShell = runTmux(['show-options', '-gv', 'default-shell'], {
    deadlineAt,
    oraclePhase: phase,
    oracleSamples: samples,
  }).trim();
  if (!defaultShell) {
    throw new Error('long-input default-shell is unavailable from the task-owned tmux server');
  }
  return basename(defaultShell).toLowerCase();
}

function buildLongInputSettledStep(
  oracle: OracleSnapshot,
  payload: TerminalBufferPayload | null,
  history: Array<{ at: string; type: string; payload: TerminalBufferPayload }>,
  failureReason?: string,
): CaseStepResult {
  const daemonCompare = compareSettledDaemonWindow(oracle, payload);
  const clientCompare = compareSettledClientWindow(oracle, payload, history);
  const ok = failureReason === undefined && daemonCompare.ok && clientCompare.ok;
  return {
    label: 'long-input-settled-daemon-client-windows',
    verificationMode: 'source-and-client-render',
    ok,
    reason: ok
      ? undefined
      : failureReason || (!daemonCompare.ok
        ? 'daemon output did not cover the settled tmux viewport at the expected absolute range'
        : 'client replay did not match daemon history at the settled absolute range'),
    oracle,
    daemonPayload: payload,
    compare: failureReason === undefined ? daemonCompare : undefined,
    clientMirrorCompare: failureReason === undefined ? clientCompare : undefined,
    historyLength: history.length,
    details: {
      comparisonUse: failureReason === undefined ? 'verification' : 'diagnosis-after-failed-wait',
      ...(failureReason === undefined ? {} : { daemonCompare, clientCompare }),
      expectedStartIndex: daemonCompare.expectedStartIndex,
      expectedEndIndex: daemonCompare.expectedEndIndex,
      daemonStartIndex: daemonCompare.actualStartIndex,
      daemonEndIndex: daemonCompare.actualEndIndex,
      clientStartIndex: clientCompare.actualStartIndex,
      clientEndIndex: clientCompare.actualEndIndex,
      daemonCoverageComplete: daemonCompare.coverageComplete,
      clientCoverageComplete: clientCompare.coverageComplete,
    },
  };
}

function finalizeLongInputCase(steps: CaseStepResult[], samples: OracleSamplesEvidence): CaseResult {
  const result = finalizeCase('long-input-echo', steps);
  result.oracleSamples = samples;
  result.comparisonScope = 'focused-settled';
  const settledStep = steps.find((step) => step.label === 'long-input-settled-daemon-client-windows');
  if (settledStep?.details?.comparisonUse === 'diagnosis-after-failed-wait') {
    result.compare = undefined;
    result.clientMirrorCompare = undefined;
    result.classification = 'FAIL';
    result.failureCauses = [{ stage: 'history-wait', message: settledStep.reason || 'history wait failed' }];
    return result;
  }
  if (settledStep?.clientMirrorCompare) {
    result.clientMirrorCompare = settledStep.clientMirrorCompare;
  }
  if (steps.length === 1 && steps[0]?.verificationMode === 'source-only') {
    result.clientMirrorCompare = undefined;
    result.compare = undefined;
  }
  if (!result.ok) {
    result.classification = steps.length === 1 && steps[0]?.verificationMode === 'source-only'
      ? 'FAIL'
      : 'FAIL_PRODUCT_COMPARISON';
  }
  return result;
}

async function executeLongInputCase(
  probe: DaemonProbe,
  fixture: ReturnType<typeof buildLongInputOracleProbe>,
): Promise<CaseResult> {
  const { marker, readyMarker, settledMarker, fileContent, payloadLines, preludeInput, bodyInput } = fixture;
  const baselineSamples: OracleWaitSample[] = [];
  const targetSamples: OracleWaitSample[] = [];
  const settledSamples: OracleWaitSample[] = [];
  let expectedShellCommand = '';
  let retainedOracle: OracleSnapshot | null = null;
  try {
    const baselinePhase = 'long input verified idle shell baseline';
    const baselineDeadlineAt = performance.now() + 120000;
    expectedShellCommand = resolveIdleShellCommand(baselineDeadlineAt, baselinePhase, baselineSamples);
    const baselineOracle = await waitForOracle(
      baselinePhase,
      (oracle) => (
        oracle.paneCommand.toLowerCase() === expectedShellCommand
        && oracle.cursorVisible
        && !oracle.alternateOn
      ),
      120000,
      baselineSamples,
      undefined,
      baselineDeadlineAt,
    );
    retainedOracle = baselineOracle;
    const preludeChunks = splitTerminalInputUtf8Chunks(preludeInput, TERMINAL_INPUT_CHUNK_BYTES);
    for (const chunk of preludeChunks) {
      probe.sendInput(chunk);
    }
    await probe.waitForMarker(readyMarker, 8000);
    await sleep(150);

    const bodyChunks = splitTerminalInputUtf8Chunks(bodyInput, TERMINAL_INPUT_CHUNK_BYTES);
    if (bodyChunks.length <= 1) {
      throw new Error('long-input case did not exceed one terminal input chunk');
    }
    for (const chunk of bodyChunks) {
      probe.sendInput(chunk, { requestHead: false });
    }
    probe.requestHead(true);

    const targetOracle = await waitForOracle(
      'long input target payload reflects in tmux',
      (oracle) => (
        oracle.paneId === baselineOracle.paneId
        && compareMarkerDelimitedPayload(oracle, marker, settledMarker, payloadLines).ok
      ),
      120000,
      targetSamples,
      baselineOracle.paneId,
    );
    retainedOracle = targetOracle;
    const settledOracle = await waitForOracle(
      'long input shell settled after target payload',
      (oracle) => (
        oracle.paneId === baselineOracle.paneId
        && compareMarkerDelimitedPayload(oracle, marker, settledMarker, payloadLines).ok
        && oracle.paneCommand.toLowerCase() === expectedShellCommand
        && oracle.cursorVisible
        && !oracle.alternateOn
      ),
      120000,
      settledSamples,
      baselineOracle.paneId,
    );
    retainedOracle = settledOracle;
    const samples = { idleShellCommand: expectedShellCommand, idleBaseline: baselineSamples, targetPayloadObserved: targetSamples, shellSettled: settledSamples };
    const steps: CaseStepResult[] = [
      buildLongInputSourceStep({
        oracle: targetOracle,
        marker,
        settledMarker,
        expectedLines: payloadLines,
        payloadLineCount: payloadLines.length,
        preludeChunkCount: preludeChunks.length,
        bodyChunkCount: bodyChunks.length,
        bodyBytes: Buffer.byteLength(fileContent, 'utf8'),
      }),
    ];
    if (!steps[0]?.ok) {
      return finalizeLongInputCase(steps, samples);
    }

    let payload: TerminalBufferPayload;
    try {
      payload = await probe.waitForHistory(
        'long input settled daemon and client windows',
        () => (
          compareSettledDaemonWindow(settledOracle, probe.payload).ok
          && compareSettledClientWindow(settledOracle, probe.payload, probe.history).ok
        ),
        20000,
      );
      steps.push(buildLongInputSettledStep(settledOracle, payload, probe.history));
    } catch (error) {
      steps.push(buildLongInputSettledStep(settledOracle, probe.payload, probe.history, errorMessage(error)));
    }

    return finalizeLongInputCase(steps, samples);
  } catch (error) {
    const snapshot = error instanceof OracleTimeoutError
      || error instanceof OracleCaptureTimeoutError
      || error instanceof OracleObservationError
      ? error.lastSnapshot || retainedOracle
      : retainedOracle;
    return {
      caseName: 'long-input-echo',
      ok: false,
      reason: errorMessage(error),
      classification: error instanceof OracleTimeoutError || error instanceof OracleCaptureTimeoutError
        ? 'UNVERIFIED_ORACLE_TIMEOUT'
        : 'FAIL',
      oracle: snapshot,
      daemonPayload: probe.payload,
      steps: [],
      failureCauses: [{ stage: 'oracle', message: errorMessage(error) }],
      oracleSamples: {
        idleShellCommand: expectedShellCommand,
        idleBaseline: baselineSamples,
        targetPayloadObserved: targetSamples,
        shellSettled: settledSamples,
      },
      comparisonScope: 'focused-settled',
    };
  }
}

async function runLongInputCase(probe: DaemonProbe): Promise<CaseResult> {
  let fixture: ReturnType<typeof buildLongInputOracleProbe> | null = null;
  let result: CaseResult | null = null;
  let failure: unknown = null;
  let cleanupFailure: unknown = null;
  try {
    fixture = buildLongInputOracleProbe();
    result = await executeLongInputCase(probe, fixture);
  } catch (error) {
    failure = error;
  } finally {
    if (fixture) {
      try {
        if (probePathPresence(fixture.filePath) === 'present') {
          rmSync(fixture.filePath, { force: true });
        }
        if (probePathPresence(fixture.filePath) !== 'absent') {
          throw new Error(`long-input payload still exists after cleanup: ${fixture.filePath}`);
        }
      } catch (error) {
        cleanupFailure = error;
      }
    }
  }

  if (failure) {
    result = buildFailedCaseResult('long-input-echo', failure, probe, retainedOracleFromError(failure));
  }
  if (cleanupFailure) {
    if (!result) {
      result = buildFailedCaseResult('long-input-echo', failure || cleanupFailure, probe);
      if (!failure) result.classification = 'UNVERIFIED_CLEANUP';
    }
    appendFailureCause(result, 'payload-cleanup', cleanupFailure);
  }
  if (!result) {
    throw new Error('long-input case completed without a result');
  }
  return result;
}

async function runExternalInputCase(probe: DaemonProbe): Promise<CaseResult> {
  const steps: CaseStepResult[] = [];
  const paneId = getLabPaneId();

  const markerA = '__daemon_external_a__';
  runTmux(['send-keys', '-t', paneId, '-l', `printf 'hello-external-a\\n${markerA}\\n'`]);
  runTmux(['send-keys', '-t', paneId, 'C-m']);
  await probe.waitForMarker(markerA);
  const oracleA = await waitForOracle(
    'external-input-a marker reflects',
    (oracle) => !oracle.alternateOn && oracle.lines.some((line) => line.includes(markerA)),
  );
  const payloadA = await waitForPayloadToMatchOracle(
    probe,
    'external-input-a settled payload',
    oracleA,
  );
  steps.push(
    buildStepResult('external-input-echo-a', oracleA, payloadA, probe.history, 'daemon external-input mirror diverged from tmux truth'),
  );
  if (!steps[steps.length - 1]?.ok) {
    return finalizeCase('external-input-echo', steps);
  }

  const markerB = '__daemon_external_b__';
  runTmux(['send-keys', '-t', paneId, '-l', `printf 'hello-external-b\\n${markerB}\\n'`]);
  runTmux(['send-keys', '-t', paneId, 'C-m']);
  await probe.waitForMarker(markerB);
  const oracleB = await waitForOracle(
    'external-input-b marker reflects',
    (oracle) => !oracle.alternateOn && oracle.lines.some((line) => line.includes(markerB)),
  );
  const payloadB = await waitForPayloadToMatchOracle(
    probe,
    'external-input-b settled payload',
    oracleB,
  );
  steps.push(
    buildStepResult('external-input-echo-b', oracleB, payloadB, probe.history, 'daemon second external-input mirror diverged from tmux truth'),
  );
  if (!steps[steps.length - 1]?.ok) {
    return finalizeCase('external-input-echo', steps);
  }

  const markerC = '__daemon_external_tail__';
  runTmux(['send-keys', '-t', paneId, '-l', `seq 1 32 | sed 's/^/external-tail-/' && printf '${markerC}\\n'`]);
  runTmux(['send-keys', '-t', paneId, 'C-m']);
  await probe.waitForMarker(markerC);
  const oracleC = await waitForOracle(
    'external-input-tail marker reflects',
    (oracle) => !oracle.alternateOn && oracle.lines.some((line) => line.includes(markerC)),
  );
  const payloadC = await waitForPayloadToMatchOracle(
    probe,
    'external-input-tail settled payload',
    oracleC,
  );
  steps.push(
    buildStepResult('external-input-echo-tail', oracleC, payloadC, probe.history, 'daemon external tail refresh diverged from tmux truth'),
  );

  return finalizeCase('external-input-echo', steps);
}

async function runDaemonRestartRecoverCase(
  probe: DaemonProbe,
  controller: LabDaemonController | null,
): Promise<CaseResult> {
  if (!controller) {
    throw new Error('daemon restart recover requires a managed daemon controller');
  }

  const steps: CaseStepResult[] = [];
  const paneId = getLabPaneId();

  const beforeMarker = '__daemon_restart_before__';
  runTmux(['send-keys', '-t', paneId, '-l', `printf 'before-restart\\n${beforeMarker}\\n'`]);
  runTmux(['send-keys', '-t', paneId, 'C-m']);
  await probe.waitForMarker(beforeMarker);
  const beforeOracle = await waitForOracle(
    'daemon restart before marker reflects',
    (oracle) => !oracle.alternateOn && oracle.lines.some((line) => line.includes(beforeMarker)),
  );
  const beforePayload = await waitForPayloadToMatchOracle(
    probe,
    'daemon restart before settled payload',
    beforeOracle,
  );
  steps.push(
    buildStepResult(
      'daemon-restart-before',
      beforeOracle,
      beforePayload,
      probe.history,
      'daemon mirror diverged from tmux truth before restart',
    ),
  );
  if (!steps[steps.length - 1]?.ok) {
    return finalizeCase('daemon-restart-recover', steps);
  }

  await controller.restart();

  const { wsUrl, authToken } = resolveWsUrl(Boolean(controller), controller);
  const reconnectProbe = new DaemonProbe(wsUrl, authToken);
  let result: CaseResult;
  try {
    result = await runReconnect();
  } catch (error) {
    result = buildFailedCaseResult('daemon-restart-recover', error, probe);
  }
  try {
    await reconnectProbe.close();
  } catch (error) {
    probe.deferCleanupFailure(error);
  }
  return result;

  async function runReconnect(): Promise<CaseResult> {
    await reconnectProbe.connect();
    probe.absorb(reconnectProbe);
    let reconnectHistoryCursor = reconnectProbe.history.length;

    const reconnectPayload = await reconnectProbe.waitForPayload('post-restart reconnect payload');
    await sleep(200);
    const reconnectOracle = captureOracleSnapshot();
    steps.push(
      buildStepResult(
        'daemon-restart-reconnect',
        reconnectOracle,
        reconnectPayload,
        probe.history,
        'daemon did not recover shell truth after restart',
      ),
    );
    if (!steps[steps.length - 1]?.ok) {
      return finalizeCase('daemon-restart-recover', steps);
    }

    const afterMarker = '__daemon_restart_after__';
    runTmux(['send-keys', '-t', paneId, '-l', `printf 'after-restart\\n${afterMarker}\\n'`]);
    runTmux(['send-keys', '-t', paneId, 'C-m']);
    await reconnectProbe.waitForMarker(afterMarker);
    probe.absorb(reconnectProbe, reconnectHistoryCursor);
    const afterOracle = await waitForOracle(
      'daemon restart after marker reflects',
      (oracle) => !oracle.alternateOn && oracle.lines.some((line) => line.includes(afterMarker)),
    );
    const afterPayload = await waitForPayloadToMatchOracle(
      reconnectProbe,
      'daemon restart after settled payload',
      afterOracle,
    );
    probe.absorb(reconnectProbe, reconnectHistoryCursor);
    steps.push(
      buildStepResult(
        'daemon-restart-after',
        afterOracle,
        afterPayload,
        probe.history,
        'daemon failed to mirror new tmux writes after restart',
      ),
    );

    return finalizeCase('daemon-restart-recover', steps);
  }
}

async function runTopLiveCase(probe: DaemonProbe, operator: AttachedTmuxOperator): Promise<CaseResult> {
  const steps: CaseStepResult[] = [];
  try {
    await operator.attach();
    await sleep(250);

    operator.write('top\r');
    const topPayload = await probe.waitForMarker('Processes:');
    const topOracle = await waitForOracle('top visible screen', (oracle) => oracle.alternateOn && oracle.paneCommand === 'top');
    steps.push(
      buildStepResult(
        'top-visible-screen',
        topOracle,
        topPayload,
        probe.history,
        'daemon top screen diverged from tmux visible screen',
      ),
    );
    if (!steps[steps.length - 1]?.ok) {
      return finalizeCase('top-live', steps);
    }

    const topVisibleSignature = topOracle.lines.join('\n');
    operator.write('\r');
    const enterOracle = await waitForOracle(
      'top enter refresh visible screen',
      (oracle) => (
        oracle.alternateOn
        && oracle.paneCommand === 'top'
        && oracle.lines.join('\n') !== topVisibleSignature
      ),
      WAIT_TIMEOUT_MS + 4000,
    );
    const enterPayload = await waitForPayloadToMatchOracle(
      probe,
      'top enter settled payload',
      enterOracle,
      WAIT_TIMEOUT_MS + 4000,
    );
    steps.push(
      buildStepResult(
        'top-enter-refresh',
        enterOracle,
        enterPayload,
        probe.history,
        'daemon did not mirror top refresh after Enter',
      ),
    );
    if (!steps[steps.length - 1]?.ok) {
      return finalizeCase('top-live', steps);
    }

    const enterSignature = enterOracle.lines.join('\n');
    const continuedOracle = await waitForOracle(
      'top continued refresh after enter',
      (oracle) => (
        oracle.alternateOn
        && oracle.paneCommand === 'top'
        && oracle.lines.join('\n') !== enterSignature
      ),
      WAIT_TIMEOUT_MS + 4000,
    );
    const continuedPayload = await waitForPayloadToMatchOracle(
      probe,
      'top continued settled payload',
      continuedOracle,
      WAIT_TIMEOUT_MS + 4000,
    );
    steps.push(
      buildStepResult(
        'top-enter-continued-refresh',
        continuedOracle,
        continuedPayload,
        probe.history,
        'daemon did not keep mirroring continued top refresh after Enter',
      ),
    );
    if (!steps[steps.length - 1]?.ok) {
      return finalizeCase('top-live', steps);
    }

    operator.write('q');
    await waitForOracle('top shell return', (oracle) => !oracle.alternateOn && oracle.paneCommand === 'zsh');
    operator.write(`printf '__top_exit_ok__\\n'\r`);
    const exitOracle = await waitForOracle('top exit marker in shell', (oracle) => !oracle.alternateOn && oracle.paneCommand === 'zsh');
    const exitPayload = await waitForPayloadToMatchOracle(
      probe,
      'top exit settled payload',
      exitOracle,
    );
    steps.push(
      buildStepResult(
        'top-exit-shell-return',
        exitOracle,
        exitPayload,
        probe.history,
        'daemon did not return to shell truth after exiting top',
      ),
    );

    return finalizeCase('top-live', steps);
  } catch (error) {
    steps.push(
      buildStepResult(
        'top-live-runtime',
        captureOracleSnapshot(),
        probe.payload,
        probe.history,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return finalizeCase('top-live', steps);
  }
}

type CodexLiveProbe = Pick<DaemonProbe, 'payload' | 'history' | 'waitForMarker' | 'waitForHistory'>;

const codexLiveOperations = {
  sleep,
  waitForOracle,
  waitForPayloadToMatchOracle,
};

export async function runCodexLiveCase(
  probe: CodexLiveProbe,
  operator: Pick<AttachedTmuxOperator, 'attach' | 'write'>,
  operations = codexLiveOperations,
): Promise<CaseResult> {
  const steps: CaseStepResult[] = [];
  let lastOracle: OracleSnapshot | null = null;
  try {
    await operator.attach();
    await operations.sleep(250);

    const initialOracle = await operations.waitForOracle('codex shell visible screen', (oracle) => !oracle.alternateOn);
    lastOracle = initialOracle;
    steps.push(
      buildStepResult(
        'codex-shell-visible',
        initialOracle,
        probe.payload,
        probe.history,
        'daemon initial codex shell screen diverged from tmux visible screen',
      ),
    );
    if (!steps[steps.length - 1]?.ok) {
      return finalizeCase('codex-live', steps);
    }

    operator.write(`printf '__codex_live_a__\\n'\r`);
    await probe.waitForMarker('__codex_live_a__');
    const markerOracle = await operations.waitForOracle(
      'codex shell marker reflects',
      (oracle) => !oracle.alternateOn && oracle.lines.some((line) => line.trimEnd() === '__codex_live_a__'),
    );
    lastOracle = markerOracle;
    const markerPayload = await operations.waitForPayloadToMatchOracle(
      probe,
      'codex shell marker settled payload',
      markerOracle,
    );
    steps.push(
      buildStepResult(
        'codex-shell-local-echo',
        markerOracle,
        markerPayload,
        probe.history,
        'daemon codex shell local echo diverged from tmux truth',
      ),
    );
    if (!steps[steps.length - 1]?.ok) {
      return finalizeCase('codex-live', steps);
    }

    operator.write(`seq 1 36 | sed 's/^/codex-live-/' && printf '__codex_live_tail__\\n'\r`);
    await probe.waitForMarker('__codex_live_tail__');
    const tailOracle = await operations.waitForOracle(
      'codex shell tail reflects',
      (oracle) => !oracle.alternateOn
        && oracle.lines.some((line) => line.trimEnd() === '__codex_live_tail__')
        && oracle.lines.some((line) => line.trimEnd() === 'codex-live-36'),
    );
    lastOracle = tailOracle;
    const tailPayload = await operations.waitForPayloadToMatchOracle(
      probe,
      'codex shell tail settled payload',
      tailOracle,
    );
    steps.push(
      buildStepResult(
        'codex-shell-tail-refresh',
        tailOracle,
        tailPayload,
        probe.history,
        'daemon codex shell tail refresh diverged from tmux truth',
      ),
    );

    return finalizeCase('codex-live', steps);
  } catch (error) {
    const result: CaseResult = buildFailedCaseResult('codex-live', error, probe);
    result.oracle = retainedOracleFromError(error) ?? lastOracle;
    if (result.oracle) {
      steps.push({
        label: 'codex-live-runtime',
        verificationMode: 'source-and-client-render',
        ok: false,
        reason: errorMessage(error),
        oracle: result.oracle,
        daemonPayload: probe.payload,
        historyLength: probe.history.length,
      });
    }
    result.steps = steps;
    return result;
  }
}

async function runVimLiveCase(probe: DaemonProbe, operator: AttachedTmuxOperator): Promise<CaseResult> {
  const steps: CaseStepResult[] = [];
  try {
    await operator.attach();
    await sleep(250);

    operator.write('vim -Nu NONE\r');
    const vimPayload = await probe.waitForMarker('VIM - Vi IMproved');
    const vimOracle = await waitForOracle('vim visible screen', (oracle) => oracle.alternateOn && oracle.paneCommand === 'vim');
    steps.push(
      buildStepResult(
        'vim-visible-screen',
        vimOracle,
        vimPayload,
        probe.history,
        'daemon vim screen diverged from tmux visible screen',
      ),
    );
    if (!steps[steps.length - 1]?.ok) {
      return finalizeCase('vim-live', steps);
    }

    operator.write(':call setline(1, map(range(1,80), \'printf("row-%03d", v:val)\')) | normal! G\r');
    const fillPayload = await probe.waitForMarker('row-080');
    const fillOracle = await waitForOracle(
      'vim dynamic fill reflects',
      (oracle) => oracle.alternateOn && oracle.paneCommand === 'vim' && oracle.lines.some((line) => line.includes('row-080')),
    );
    steps.push(
      buildStepResult(
        'vim-fill-bottom-tail',
        fillOracle,
        fillPayload,
        probe.history,
        'daemon did not mirror vim bottom-tail fill',
      ),
    );
    if (!steps[steps.length - 1]?.ok) {
      return finalizeCase('vim-live', steps);
    }

    operator.write('gg0iTOP_MARKER-\u001b');
    const topPayload = await probe.waitForMarker('TOP_MARKER-');
    const topOracle = await waitForOracle(
      'vim top marker reflects',
      (oracle) => oracle.alternateOn && oracle.paneCommand === 'vim' && oracle.lines.some((line) => line.includes('TOP_MARKER-')),
    );
    steps.push(
      buildStepResult(
        'vim-top-refresh',
        topOracle,
        topPayload,
        probe.history,
        'daemon did not mirror vim top refresh',
      ),
    );
    if (!steps[steps.length - 1]?.ok) {
      return finalizeCase('vim-live', steps);
    }

    operator.write('G0iBOTTOM_MARKER-\u001b');
    const bottomPayload = await probe.waitForMarker('BOTTOM_MARKER-');
    const bottomOracle = await waitForOracle(
      'vim bottom marker reflects',
      (oracle) => oracle.alternateOn && oracle.paneCommand === 'vim' && oracle.lines.some((line) => line.includes('BOTTOM_MARKER-')),
    );
    steps.push(
      buildStepResult(
        'vim-bottom-refresh',
        bottomOracle,
        bottomPayload,
        probe.history,
        'daemon did not mirror vim bottom refresh',
      ),
    );
    if (!steps[steps.length - 1]?.ok) {
      return finalizeCase('vim-live', steps);
    }

    operator.write('GoAPPEND_MARKER-\u001b');
    const appendPayload = await probe.waitForMarker('APPEND_MARKER-');
    const appendOracle = await waitForOracle(
      'vim append marker reflects',
      (oracle) => oracle.alternateOn && oracle.paneCommand === 'vim' && oracle.lines.some((line) => line.includes('APPEND_MARKER-')),
    );
    steps.push(
      buildStepResult(
        'vim-append-refresh',
        appendOracle,
        appendPayload,
        probe.history,
        'daemon did not mirror vim append refresh',
      ),
    );
    if (!steps[steps.length - 1]?.ok) {
      return finalizeCase('vim-live', steps);
    }

    operator.write(':q!\r');
    await waitForOracle('vim shell return', (oracle) => !oracle.alternateOn && oracle.paneCommand === 'zsh');
    operator.write(`printf '__vim_exit_ok__\\n'\r`);
    const exitOracle = await waitForOracle('vim exit marker in shell', (oracle) => !oracle.alternateOn && oracle.paneCommand === 'zsh');
    const exitPayload = await waitForPayloadToMatchOracle(
      probe,
      'vim exit settled payload',
      exitOracle,
    );
    steps.push(
      buildStepResult(
        'vim-exit-shell-return',
        exitOracle,
        exitPayload,
        probe.history,
        'daemon did not return to shell truth after exiting vim',
      ),
    );

    return finalizeCase('vim-live', steps);
  } catch (error) {
    steps.push(
      buildStepResult(
        'vim-live-runtime',
        captureOracleSnapshot(),
        probe.payload,
        probe.history,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return finalizeCase('vim-live', steps);
  }
}

async function runScheduleFireCase(probe: DaemonProbe): Promise<CaseResult> {
  const steps: CaseStepResult[] = [];
  const marker = `__sched_fire_${Date.now()}__`;
  const jobId = `lab-sched-${Date.now()}`;

  // 1. Create an interval schedule that fires in ~1s
  probe.sendMessage({
    type: 'schedule-upsert',
    payload: {
      job: {
        id: jobId,
        targetSessionName: LAB_SESSION_NAME,
        label: 'lab-schedule-fire-test',
        enabled: true,
        payload: {
          text: `printf '${marker}\\n'`,
          appendEnter: true,
        },
        rule: {
          kind: 'interval',
          intervalMs: 1000,
          startAt: new Date().toISOString(),
        },
      },
    },
  });

  // 2. Wait for the marker to appear in tmux via daemon buffer
  const SCHEDULE_FIRE_TIMEOUT_MS = 10000;
  let firePayload: TerminalBufferPayload;
  try {
    firePayload = await probe.waitForMarker(marker, SCHEDULE_FIRE_TIMEOUT_MS);
  } catch (error) {
    // cleanup schedule even on failure
    probe.sendMessage({ type: 'schedule-delete', payload: { jobId } });
    throw error;
  }
  await sleep(300);
  const fireOracle = captureOracleSnapshot();
  const markerInTmux = fireOracle.lines.some((line) => line.includes(marker));

  const scheduleFireStep = buildStepResult(
    'schedule-fire-marker-in-daemon-buffer',
    fireOracle,
    firePayload,
    probe.history,
    'scheduled marker source/client render diverged from tmux truth',
  );
  if (!markerInTmux) {
    scheduleFireStep.ok = false;
    scheduleFireStep.reason = `marker "${marker}" not found in tmux capture-pane after schedule fire`;
  }
  steps.push(scheduleFireStep);

  // 3. Wait for schedule-event from daemon
  try {
    await probe.waitForScheduleEvent(
      (event) => event.jobId === jobId && event.type === 'triggered',
      SCHEDULE_FIRE_TIMEOUT_MS,
    );
    steps.push({
      label: 'schedule-event-received',
      verificationMode: 'source-only',
      ok: true,
      oracle: captureOracleSnapshot(),
      daemonPayload: firePayload,
      compare: { ok: true, mismatchIndex: null, expected: [], actual: [] },
      clientMirrorCompare: replayClientMirrorCompare(fireOracle, probe.history),
      historyLength: probe.history.length,
    });
  } catch (error) {
    steps.push({
      label: 'schedule-event-received',
      verificationMode: 'source-only',
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      oracle: captureOracleSnapshot(),
      daemonPayload: firePayload,
      compare: { ok: false, mismatchIndex: 0, expected: [], actual: [] },
      clientMirrorCompare: { ok: false, mismatchIndex: null, expected: [], actual: [] },
      historyLength: probe.history.length,
    });
  }

  // 4. Cleanup: delete the schedule
  probe.sendMessage({ type: 'schedule-delete', payload: { jobId } });
  await sleep(200);

  // Build oracle from the fire step for the final result
  return {
    caseName: 'schedule-fire',
    ok: steps.every((s) => s.ok),
    reason: steps.find((s) => !s.ok)?.reason,
    oracle: fireOracle,
    daemonPayload: firePayload,
    compare: {
      ok: markerInTmux,
      mismatchIndex: markerInTmux ? null : 0,
      expected: [marker],
      actual: markerInTmux ? [marker] : [],
    },
    clientMirrorCompare: replayClientMirrorCompare(fireOracle, probe.history),
    steps,
  };
}

function resolveWsUrl(useManagedDaemon: boolean, daemonController: LabDaemonController | null) {
  const config = resolveDaemonRuntimeConfig();
  const base = useManagedDaemon
    ? daemonController!.getHost()
    : config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  const port = useManagedDaemon
    ? String(daemonController?.getPort() || MANAGED_DAEMON_TEST_PORT || config.port)
    : String(config.port);
  return {
    wsUrl: `ws://${base}:${port}/ws`,
    authToken: useManagedDaemon ? '' : config.authToken,
  };
}

async function confirmTmuxSocketAbsent() {
  if (!LAB_TMUX_SOCKET || !LAB_TASK_ROOT) {
    throw new Error('focused tmux socket path is unavailable during cleanup verification');
  }
  const deadline = Date.now() + 2000;
  while (Date.now() <= deadline) {
    if (probePathPresence(LAB_TMUX_SOCKET) === 'absent') {
      return;
    }
    await sleep(25);
  }
  throw new Error(`task-owned tmux socket still exists after cleanup: ${LAB_TMUX_SOCKET}`);
}

async function runCase(
  caseName: CaseName,
  daemonController: LabDaemonController | null,
): Promise<{ result: CaseResult; probe: DaemonProbe | null }> {
  let probe: DaemonProbe | null = null;
  let operator: AttachedTmuxOperator | null = null;
  let result: CaseResult | null = null;
  let failure: unknown = null;
  const cleanupFailures: Array<{ stage: string; error: unknown }> = [];
  const focused = caseName === 'long-input-echo' && focusedResourcesValidated;
  let sessionAcquired = false;

  try {
    resetLabSession(focused);
    sessionAcquired = Boolean(acquiredLabSessionId);
    if (focused) {
      if (!daemonController) throw new Error('focused long-input-echo requires its managed daemon');
      installFocusedTmuxBoundary();
      await daemonController.start();
    }
    await sleep(150);
    const { wsUrl, authToken } = resolveWsUrl(Boolean(daemonController), daemonController);
    probe = new DaemonProbe(wsUrl, authToken);
    operator = new AttachedTmuxOperator();
    await probe.connect();
    switch (caseName) {
      case 'codex-live':
        result = await runCodexLiveCase(probe, operator);
        break;
      case 'top-live':
        result = await runTopLiveCase(probe, operator);
        break;
      case 'vim-live':
        result = await runVimLiveCase(probe, operator);
        break;
      case 'initial-sync':
        result = await runInitialSyncCase(probe);
        break;
      case 'local-input-echo':
        result = await runLocalInputCase(probe);
        break;
      case 'long-input-echo':
        result = await runLongInputCase(probe);
        break;
      case 'external-input-echo':
        result = await runExternalInputCase(probe);
        break;
      case 'daemon-restart-recover':
        result = await runDaemonRestartRecoverCase(probe, daemonController);
        break;
      case 'schedule-fire':
        result = await runScheduleFireCase(probe);
        break;
    }
    if (!result) {
      throw new Error(`case ${caseName} produced no result`);
    }
    if (!result.classification && result.oracle && result.comparisonScope !== 'focused-settled') {
      result.clientMirrorCompare = replayClientMirrorCompare(result.oracle, probe.history);
      if (!result.clientMirrorCompare.ok) {
        result.ok = false;
        result.reason = result.reason || 'client local mirror diverged from tmux truth';
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    // Keep reconnect cleanup secondary to the eligible client replay above.
    for (const error of probe?.consumeDeferredCleanupFailures() || []) {
      cleanupFailures.push({ stage: 'probe-cleanup', error });
    }
    try {
      operator?.close();
      await probe?.close();
      await sleep(150);
    } catch (error) {
      cleanupFailures.push({ stage: 'probe-cleanup', error });
    }
    if (focused) {
      try {
        await daemonController?.close();
      } catch (error) {
        cleanupFailures.push({ stage: 'daemon-cleanup', error });
      }
    }
    sessionAcquired ||= Boolean(acquiredLabSessionId);
    if (acquiredLabSessionId) {
      try {
        cleanupLabSession();
      } catch (error) {
        cleanupFailures.push({ stage: 'tmux-cleanup', error });
      }
    }
    if (caseName === 'long-input-echo' && focusedResourcesValidated && sessionAcquired) {
      try {
        await confirmTmuxSocketAbsent();
      } catch (error) {
        cleanupFailures.push({ stage: 'socket-cleanup', error });
      }
    }
    if (caseName === 'long-input-echo' && focusedResourcesValidated) {
      rmSync(LAB_TMUX_BOUNDARY, { force: true });
    }
  }

  if (failure) {
    result = buildFailedCaseResult(caseName, failure, probe);
  }
  if (cleanupFailures.length) {
    if (!result) {
      result = buildFailedCaseResult(caseName, failure || cleanupFailures[0]!.error, probe);
      if (!failure) result.classification = 'UNVERIFIED_CLEANUP';
    }
    for (const cleanupFailure of cleanupFailures) {
      appendFailureCause(result, cleanupFailure.stage, cleanupFailure.error);
    }
  }
  if (!result) {
    throw new Error(`case ${caseName} ended without a result`);
  }
  return { result, probe };
}

async function main() {
  const caseArg = process.argv.find((arg) => arg.startsWith('--case='))?.split('=', 2)[1] || 'all';
  const focusedLongInputRun = caseArg === 'long-input-echo';
  const managedDaemon = process.argv.includes('--managed-daemon');
  const requestedCases: CaseName[] = caseArg === 'all'
    ? ['codex-live', 'top-live', 'vim-live', 'initial-sync', 'local-input-echo', 'long-input-echo', 'external-input-echo', 'daemon-restart-recover', 'schedule-fire']
    : [caseArg as CaseName];

  if (caseArg === 'all') {
    const runDir = ensureEvidenceRunDir();
    rmSync(join(runDir, 'summary.json'), { force: true });
    for (const caseName of requestedCases) {
      const caseDir = join(runDir, caseName);
      rmSync(join(caseDir, 'comparison.json'), { force: true });
      rmSync(join(caseDir, 'client-mirror-comparison.json'), { force: true });
    }
  }

  if (focusedLongInputRun) {
    if (!managedDaemon) {
      throw new Error('focused long-input-echo requires --managed-daemon');
    }
    for (const key of ['ZTERM_TEST_DAEMON_PORT', 'ZTERM_PORT', 'PORT']) {
      if (process.env[key]?.trim()) {
        throw new Error(`focused long-input-echo rejects fixed or inherited ${key}; a private port is required`);
      }
    }
    for (const key of ['ZTERM_HOST', 'HOST']) {
      const host = process.env[key]?.trim();
      if (host && host !== '127.0.0.1') {
        throw new Error(`focused long-input-echo rejects non-private ${key}: ${host}`);
      }
    }
    requirePrivateLongInputResources();
  }
  const daemonController = managedDaemon ? new LabDaemonController(focusedLongInputRun) : null;
  const results: CaseResult[] = [];
  const completed: Array<{ result: CaseResult; probe: DaemonProbe | null }> = [];
  let daemonCleanupFailure: unknown = null;
  try {
    if (daemonController && !focusedLongInputRun) {
      await daemonController.start();
    }

    for (const caseName of requestedCases) {
      if (!['codex-live', 'top-live', 'vim-live', 'initial-sync', 'local-input-echo', 'long-input-echo', 'external-input-echo', 'daemon-restart-recover', 'schedule-fire'].includes(caseName)) {
        throw new Error(`unsupported case: ${caseName}`);
      }
      const completedCase = await runCase(caseName, daemonController);
      const { result } = completedCase;
      completed.push(completedCase);
      results.push(result);
      if (!result.ok) {
        break;
      }
    }
  } finally {
    try {
      await daemonController?.close();
    } catch (error) {
      daemonCleanupFailure = error;
    }
  }

  if (daemonCleanupFailure) {
    const last = completed[completed.length - 1]?.result;
    if (last) {
      appendFailureCause(last, 'daemon-cleanup', daemonCleanupFailure);
    } else {
      throw daemonCleanupFailure;
    }
  }

  for (const completedCase of completed) {
    try {
      writeCaseEvidence(completedCase.result, completedCase.probe);
    } catch (error) {
      appendFailureCause(completedCase.result, 'evidence-write', error);
    }
    const { result } = completedCase;
    const classification = classifyCaseResult(result);
    console.log(`[daemon-mirror-lab] ${result.caseName}: ${classification}`);
    if (!result.ok) {
      console.log(`  reason: ${result.reason}`);
      console.log(`  evidence: ${ensureCaseDir(result.caseName)}`);
      process.exitCode = 1;
    }
  }

  const summaryPath = join(ensureEvidenceRunDir(), 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`[daemon-mirror-lab] summary: ${summaryPath}`);
}

if (isMainModule) void main().catch((error) => {
  console.error(`[daemon-mirror-lab] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
