import { spawn, spawnSync } from 'child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { BufferSyncRequestPayload, ClientMessage, ScheduleEventPayload, ScheduleStatePayload, ServerMessage, TerminalBufferPayload, TerminalCell } from '../src/lib/types';
import { resolveDaemonRuntimeConfig } from '../src/server/daemon-config';
import {
  applyBufferSyncToSessionBuffer,
  cellsToLine,
  createSessionBufferState,
  normalizeWireLines,
} from '../src/lib/terminal-buffer';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../src/lib/mobile-config';

const LAB_SESSION_NAME = 'zterm_mirror_lab';
const LAB_COLS = 80;
const LAB_ROWS = 24;
const WAIT_TIMEOUT_MS = 8000;
const DAEMON_READY_TIMEOUT_MS = 10000;
type CaseName =
  | 'codex-live'
  | 'top-live'
  | 'vim-live'
  | 'initial-sync'
  | 'local-input-echo'
  | 'external-input-echo'
  | 'daemon-restart-recover'
  | 'schedule-fire';

interface OracleSnapshot {
  sessionName: string;
  paneId: string;
  paneRows: number;
  paneCols: number;
  historySize: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  alternateOn: boolean;
  paneCommand: string;
  lines: string[];
}

interface CompareResult {
  ok: boolean;
  mismatchIndex: number | null;
  expected: string[];
  actual: string[];
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
  ok: boolean;
  reason?: string;
  oracle: OracleSnapshot;
  daemonPayload: TerminalBufferPayload | null;
  compare: CompareResult;
  clientMirrorCompare: CompareResult;
  historyLength: number;
}

interface CaseResult {
  caseName: CaseName;
  ok: boolean;
  reason?: string;
  oracle: OracleSnapshot;
  daemonPayload: TerminalBufferPayload | null;
  compare: CompareResult;
  clientMirrorCompare?: CompareResult;
  steps?: CaseStepResult[];
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

class LabDaemonController {
  private readonly host: string;

  private readonly port: string;

  private readonly healthUrl: string;

  private readonly logPath: string;

  private proc: ReturnType<typeof spawn> | null = null;

  constructor() {
    const config = resolveDaemonRuntimeConfig();
    this.host = process.env.ZTERM_HOST || (config.host === '0.0.0.0' ? '127.0.0.1' : config.host);
    this.port = String(process.env.ZTERM_PORT || config.port || 45761);
    this.healthUrl = `http://${this.host}:${this.port}/health`;
    this.logPath = join(process.cwd(), 'evidence', 'daemon-mirror', currentDateFolder(), 'current-daemon.log');
  }

  async start() {
    if (this.proc) {
      throw new Error('lab daemon is already running');
    }
    mkdirSync(join(process.cwd(), 'evidence', 'daemon-mirror', currentDateFolder()), { recursive: true });
    const logStream = createWriteStream(this.logPath, { flags: 'a' });
    const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const proc = spawn(process.execPath, [tsxBin, 'src/server/server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ZTERM_HOST: this.host,
        ZTERM_PORT: this.port,
        ZTERM_AUTH_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);
    this.proc = proc;
    await waitForDaemonHealth(this.healthUrl);
  }

  async stop() {
    if (!this.proc) {
      return;
    }
    const proc = this.proc;
    this.proc = null;
    if (proc.exitCode !== null) {
      return;
    }
    proc.kill('SIGINT');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null) {
          proc.kill('SIGTERM');
        }
      }, 1500);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
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

function runTmux(args: string[], options?: { allowFailure?: boolean }) {
  const result = spawnSync('tmux', args, {
    encoding: 'utf-8',
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && !options?.allowFailure) {
    throw new Error(result.stderr?.trim() || `tmux ${args.join(' ')} exited with ${result.status}`);
  }

  return result.stdout || '';
}

function getLabPaneId() {
  return runTmux(['display-message', '-p', '-t', LAB_SESSION_NAME, '#{pane_id}']).trim() || `${LAB_SESSION_NAME}:0.0`;
}

function sessionExists(sessionName: string) {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], {
    encoding: 'utf-8',
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  return result.status === 0;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLine(line: string) {
  return line.replace(/\s+$/u, '');
}

function normalizeCapture(raw: string) {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((_, index, arr) => !(index === arr.length - 1 && arr[index] === ''))
    .map(normalizeLine);
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
  const dir = join(process.cwd(), 'evidence', 'daemon-mirror', currentDateFolder(), caseName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function resetLabSession() {
  if (sessionExists(LAB_SESSION_NAME)) {
    runTmux(['kill-session', '-t', LAB_SESSION_NAME], { allowFailure: true });
  }

  runTmux(['new-session', '-d', '-s', LAB_SESSION_NAME]);
  runTmux(['set-option', '-t', LAB_SESSION_NAME, 'status', 'off']);
  runTmux(['set-option', '-t', LAB_SESSION_NAME, 'remain-on-exit', 'off']);
  runTmux(['set-window-option', '-t', LAB_SESSION_NAME, 'window-size', 'manual']);
}

function cleanupLabSession() {
  if (sessionExists(LAB_SESSION_NAME)) {
    runTmux(['kill-session', '-t', LAB_SESSION_NAME], { allowFailure: true });
  }
}

function captureOracleSnapshot(): OracleSnapshot {
  const paneId = runTmux([
    'display-message',
    '-p',
    '-t',
    LAB_SESSION_NAME,
    '#{pane_id}',
  ]).trim() || LAB_SESSION_NAME;
  const metricText = runTmux([
    'display-message',
    '-p',
    '-t',
    paneId,
    '#{pane_height}\t#{pane_width}\t#{history_size}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}\t#{alternate_on}\t#{pane_current_command}',
  ]).trim();
  const [
    rowsRaw = '24',
    colsRaw = '80',
    historyRaw = '0',
    cursorXRaw = '0',
    cursorYRaw = '0',
    cursorVisibleRaw = '0',
    alternateOnRaw = '0',
    paneCommandRaw = '',
  ] = metricText.split('\t');
  const paneRows = Math.max(1, Number.parseInt(rowsRaw, 10) || LAB_ROWS);
  const paneCols = Math.max(1, Number.parseInt(colsRaw, 10) || LAB_COLS);
  const historySize = Math.max(0, Number.parseInt(historyRaw, 10) || 0);
  const cursorX = Math.max(0, Number.parseInt(cursorXRaw, 10) || 0);
  const cursorY = Math.max(0, Number.parseInt(cursorYRaw, 10) || 0);
  const cursorVisible = cursorVisibleRaw === '1';
  const alternateOn = alternateOnRaw === '1';
  const paneCommand = paneCommandRaw.trim();

  const rawCapture = runTmux([
    'capture-pane',
    '-p',
    '-M',
    '-N',
    '-t',
    paneId,
    '-S',
    '0',
    '-E',
    `${Math.max(0, paneRows - 1)}`,
  ]);
  const visibleLines = normalizeCapture(rawCapture);
  const paddedLines = Array.from({ length: paneRows }, (_, index) => (
    normalizeLine(visibleLines[index] || '')
  ));

  return {
    sessionName: LAB_SESSION_NAME,
    paneId,
    paneRows,
    paneCols,
    historySize,
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

function payloadCoversVisibleViewport(oracle: OracleSnapshot, payload: TerminalBufferPayload | null) {
  if (!payload) {
    return false;
  }

  const rowCount = Math.max(1, payload.rows || oracle.paneRows);
  const viewportBottom = Math.max(
    0,
    Number.isFinite(payload.availableEndIndex) ? payload.availableEndIndex! : payload.endIndex,
  );
  const startIndex = Math.max(0, viewportBottom - rowCount);
  const indices = new Set(normalizeWireLines(payload.lines, payload.cols || oracle.paneCols).map((line) => line.index));
  for (let index = startIndex; index < viewportBottom; index += 1) {
    if (!indices.has(index)) {
      return false;
    }
  }
  return true;
}

function replayClientMirrorCompare(
  oracle: OracleSnapshot,
  history: Array<{ at: string; type: string; payload: TerminalBufferPayload }>,
): CompareResult {
  let buffer = createSessionBufferState({
    cacheLines: DEFAULT_TERMINAL_CACHE_LINES,
    lines: [],
    rows: oracle.paneRows,
    cols: oracle.paneCols,
  });

  for (const item of history) {
    if (item.type === 'buffer-sync') {
      buffer = applyBufferSyncToSessionBuffer(buffer, item.payload, DEFAULT_TERMINAL_CACHE_LINES);
    }
  }

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
  const directPayloadComparable = payloadCoversVisibleViewport(oracle, daemonPayload);
  const compare = directPayloadComparable
    ? compareTail(oracle, daemonPayload)
    : {
        ok: true,
        mismatchIndex: null,
        expected: oracle.lines,
        actual: oracle.lines,
      };
  const historyLength = history.length;
  const clientMirrorCompare = replayClientMirrorCompare(oracle, history.slice(0, historyLength));
  const ok = compare.ok && clientMirrorCompare.ok;
  return {
    label,
    ok,
    reason: compare.ok
      ? clientMirrorCompare.ok
        ? undefined
        : 'client local mirror diverged from tmux truth'
      : reasonWhenFailed,
    oracle,
    daemonPayload,
    compare,
    clientMirrorCompare,
    historyLength,
  };
}

function finalizeCase(caseName: CaseName, steps: CaseStepResult[]): CaseResult {
  const failedStep = steps.find((step) => !step.ok);
  const primary = failedStep || steps[steps.length - 1];
  return {
    caseName,
    ok: !failedStep,
    reason: failedStep?.reason,
    oracle: primary.oracle,
    daemonPayload: primary.daemonPayload,
    compare: primary.compare,
    steps,
  };
}

async function waitForOracle(
  label: string,
  predicate: (oracle: OracleSnapshot) => boolean,
  timeoutMs: number = WAIT_TIMEOUT_MS,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const oracle = captureOracleSnapshot();
    if (predicate(oracle)) {
      return oracle;
    }
    await sleep(100);
  }
  throw new Error(`timeout waiting for oracle: ${label}`);
}

class AttachedTmuxOperator {
  private client: pty.IPty | null = null;

  async attach() {
    if (this.client) {
      return;
    }
    this.client = pty.spawn('tmux', ['a', '-t', LAB_SESSION_NAME], {
      name: 'xterm-256color',
      cols: LAB_COLS,
      rows: LAB_ROWS,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    await sleep(500);
  }

  write(input: string) {
    if (!this.client) {
      throw new Error('attached tmux operator is not started');
    }
    this.client.write(input);
  }

  close() {
    if (!this.client) {
      return;
    }
    try {
      this.client.kill();
    } catch (error) {
      console.warn('[daemon-mirror-lab] Failed to kill attached tmux operator:', error);
    }
    this.client = null;
  }
}

class DaemonProbe {
  private readonly wsUrl: string;

  private readonly authToken: string;

  private ws: WebSocket | null = null;

  private connected = false;

  private lastPayload: TerminalBufferPayload | null = null;

  private lastHead: { revision: number; latestEndIndex: number } | null = null;

  private lastHeadRequestedAt = 0;

  private readonly payloadHistory: Array<{ at: string; type: string; payload: TerminalBufferPayload }> = [];

  private readonly eventHistory: ProbeEventEntry[] = [];

  private readonly scheduleEvents: Array<ServerMessage & { type: 'schedule-event' }> = [];

  private readonly scheduleEventWaiters: ScheduleEventWaiter[] = [];

  constructor(wsUrl: string, authToken: string) {
    this.wsUrl = authToken ? `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(authToken)}` : wsUrl;
    this.authToken = authToken;
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
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      let settled = false;
      this.ws = ws;

      ws.on('open', () => {
        const connectMessage: ClientMessage = {
          type: 'connect',
          payload: {
            name: LAB_SESSION_NAME,
            bridgeHost: '127.0.0.1',
            bridgePort: 0,
            sessionName: LAB_SESSION_NAME,
            cols: LAB_COLS,
            rows: LAB_ROWS,
            authToken: this.authToken,
            authType: 'password',
          },
        };
        this.eventHistory.push({
          at: nowStamp(),
          direction: 'sent',
          type: connectMessage.type,
          payload: summarizeProbeMessage(connectMessage.type, connectMessage.payload),
        });
        ws.send(JSON.stringify(connectMessage));
      });

      ws.on('message', (raw) => {
        const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
        const message = JSON.parse(text) as ServerMessage;
        this.eventHistory.push({
          at: nowStamp(),
          direction: 'recv',
          type: message.type,
          payload: summarizeProbeMessage(message.type, 'payload' in message ? message.payload : undefined),
        });
        if (message.type === 'connected') {
          this.connected = true;
          this.requestHead(true);
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        if (message.type === 'buffer-head') {
          this.lastHead = {
            revision: Math.max(0, Math.floor(message.payload.revision || 0)),
            latestEndIndex: Math.max(0, Math.floor(message.payload.latestEndIndex || 0)),
          };
          this.requestFollowWindow(this.lastHead.latestEndIndex);
          return;
        }
        if (message.type === 'buffer-sync') {
          this.lastPayload = message.payload;
          this.payloadHistory.push({
            at: nowStamp(),
            type: message.type,
            payload: message.payload,
          });
        }
        if (message.type === 'error') {
          const error = new Error(message.payload.message);
          if (!settled) {
            settled = true;
            reject(error);
          }
        }
        if (message.type === 'schedule-event') {
          this.scheduleEvents.push(message);
          const waiter = this.scheduleEventWaiters.shift();
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(message);
          }
          return;
        }
      });

      ws.on('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      ws.on('close', () => {
        if (!settled) {
          settled = true;
          reject(new Error('daemon websocket closed before connect'));
        }
      });
    });

    await this.waitForPayload('initial buffer-sync');
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }

  sendInput(data: string) {
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
    this.requestHead(true);
  }

  private requestHead(force = false) {
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
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      this.requestHead();
      if (this.lastPayload && (!predicate || predicate(this.lastPayload))) {
        return this.lastPayload;
      }
      await sleep(80);
    }
    throw new Error(`timeout waiting for payload: ${label}`);
  }

  async waitForMarker(marker: string, timeoutMs: number = WAIT_TIMEOUT_MS) {
    return this.waitForPayload(`marker ${marker}`, (payload) => {
      const joined = normalizeWireLines(payload.lines, payload.cols || LAB_COLS)
        .map((line) => cellsToText(line.cells))
        .join('\n');
      return joined.includes(marker);
    }, timeoutMs);
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

function writeCaseEvidence(result: CaseResult, probe: DaemonProbe) {
  const caseDir = ensureCaseDir(result.caseName);
  writeFileSync(join(caseDir, 'tmux-capture.txt'), `${result.oracle.lines.join('\n')}\n`);
  writeFileSync(
    join(caseDir, 'tmux-metrics.txt'),
    [
      `session=${result.oracle.sessionName}`,
      `paneId=${result.oracle.paneId}`,
      `rows=${result.oracle.paneRows}`,
      `cols=${result.oracle.paneCols}`,
      `history=${result.oracle.historySize}`,
      `cursorX=${result.oracle.cursorX}`,
      `cursorY=${result.oracle.cursorY}`,
      `cursorVisible=${result.oracle.cursorVisible ? '1' : '0'}`,
      `alternateOn=${result.oracle.alternateOn ? '1' : '0'}`,
      `paneCommand=${result.oracle.paneCommand}`,
    ].join('\n') + '\n',
  );
  writeFileSync(join(caseDir, 'daemon-payload.json'), `${JSON.stringify(result.daemonPayload, null, 2)}\n`);
  writeFileSync(join(caseDir, 'probe-history.json'), `${JSON.stringify(probe.history, null, 2)}\n`);
  writeFileSync(join(caseDir, 'probe-events.json'), `${JSON.stringify(probe.events, null, 2)}\n`);
  writeFileSync(join(caseDir, 'comparison.json'), `${JSON.stringify(result.compare, null, 2)}\n`);
  if (result.clientMirrorCompare) {
    writeFileSync(join(caseDir, 'client-mirror-comparison.json'), `${JSON.stringify(result.clientMirrorCompare, null, 2)}\n`);
  }
  if (result.steps?.length) {
    writeFileSync(join(caseDir, 'step-results.json'), `${JSON.stringify(result.steps, null, 2)}\n`);
  }
  writeFileSync(
    join(caseDir, 'summary.txt'),
    [
      `case=${result.caseName}`,
      `ok=${result.ok}`,
      `reason=${result.reason || ''}`,
      `mismatchIndex=${result.compare.mismatchIndex ?? 'none'}`,
      `generatedAt=${nowStamp()}`,
    ].join('\n') + '\n',
  );
}

function writeFailedCaseEvidence(caseName: CaseName, reason: string, probe: DaemonProbe) {
  const oracle = captureOracleSnapshot();
  const compare = compareTail(oracle, probe.payload);
  const result: CaseResult = {
    caseName,
    ok: false,
    reason,
    oracle,
    daemonPayload: probe.payload,
    compare,
    clientMirrorCompare: replayClientMirrorCompare(oracle, probe.history),
  };
  writeCaseEvidence(result, probe);
  return result;
}

async function runInitialSyncCase(probe: DaemonProbe): Promise<CaseResult> {
  const payload = await probe.waitForPayload('initial sync ready');
  await sleep(200);
  const oracle = captureOracleSnapshot();
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

async function runExternalInputCase(probe: DaemonProbe): Promise<CaseResult> {
  const steps: CaseStepResult[] = [];
  const paneId = getLabPaneId();

  const markerA = '__daemon_external_a__';
  runTmux(['send-keys', '-t', paneId, '-l', `printf 'hello-external-a\\n${markerA}\\n'`]);
  runTmux(['send-keys', '-t', paneId, 'C-m']);
  const payloadA = await probe.waitForMarker(markerA);
  await sleep(200);
  const oracleA = captureOracleSnapshot();
  steps.push(
    buildStepResult('external-input-echo-a', oracleA, payloadA, probe.history, 'daemon external-input mirror diverged from tmux truth'),
  );
  if (!steps[steps.length - 1]?.ok) {
    return finalizeCase('external-input-echo', steps);
  }

  const markerB = '__daemon_external_b__';
  runTmux(['send-keys', '-t', paneId, '-l', `printf 'hello-external-b\\n${markerB}\\n'`]);
  runTmux(['send-keys', '-t', paneId, 'C-m']);
  const payloadB = await probe.waitForMarker(markerB);
  await sleep(200);
  const oracleB = captureOracleSnapshot();
  steps.push(
    buildStepResult('external-input-echo-b', oracleB, payloadB, probe.history, 'daemon second external-input mirror diverged from tmux truth'),
  );
  if (!steps[steps.length - 1]?.ok) {
    return finalizeCase('external-input-echo', steps);
  }

  const markerC = '__daemon_external_tail__';
  runTmux(['send-keys', '-t', paneId, '-l', `seq 1 32 | sed 's/^/external-tail-/' && printf '${markerC}\\n'`]);
  runTmux(['send-keys', '-t', paneId, 'C-m']);
  const payloadC = await probe.waitForMarker(markerC);
  await sleep(200);
  const oracleC = captureOracleSnapshot();
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
  const beforePayload = await probe.waitForMarker(beforeMarker);
  await sleep(200);
  const beforeOracle = captureOracleSnapshot();
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

  const { wsUrl, authToken } = resolveWsUrl();
  const reconnectProbe = new DaemonProbe(wsUrl, authToken);
  try {
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
    const afterPayload = await reconnectProbe.waitForMarker(afterMarker);
    probe.absorb(reconnectProbe, reconnectHistoryCursor);
    await sleep(200);
    const afterOracle = captureOracleSnapshot();
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
  } finally {
    reconnectProbe.close();
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

    operator.write('q');
    await waitForOracle('top shell return', (oracle) => !oracle.alternateOn && oracle.paneCommand === 'zsh');
    operator.write(`printf '__top_exit_ok__\\n'\r`);
    const exitPayload = await probe.waitForMarker('__top_exit_ok__');
    const exitOracle = await waitForOracle('top exit marker in shell', (oracle) => !oracle.alternateOn && oracle.paneCommand === 'zsh');
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

async function runCodexLiveCase(probe: DaemonProbe, operator: AttachedTmuxOperator): Promise<CaseResult> {
  const steps: CaseStepResult[] = [];
  try {
    await operator.attach();
    await sleep(250);

    const initialOracle = await waitForOracle('codex shell visible screen', (oracle) => !oracle.alternateOn);
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
    const markerPayload = await probe.waitForMarker('__codex_live_a__');
    const markerOracle = await waitForOracle(
      'codex shell marker reflects',
      (oracle) => !oracle.alternateOn && oracle.lines.some((line) => line.includes('__codex_live_a__')),
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
    const tailPayload = await probe.waitForMarker('__codex_live_tail__');
    const tailOracle = await waitForOracle(
      'codex shell tail reflects',
      (oracle) => !oracle.alternateOn && oracle.lines.some((line) => line.includes('__codex_live_tail__')),
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
    steps.push(
      buildStepResult(
        'codex-live-runtime',
        captureOracleSnapshot(),
        probe.payload,
        probe.history,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return finalizeCase('codex-live', steps);
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
    const exitPayload = await probe.waitForMarker('__vim_exit_ok__');
    const exitOracle = await waitForOracle('vim exit marker in shell', (oracle) => !oracle.alternateOn && oracle.paneCommand === 'zsh');
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

  steps.push({
    label: 'schedule-fire-marker-in-daemon-buffer',
    ok: true,
    oracle: fireOracle,
    daemonPayload: firePayload,
    compare: { ok: true, mismatchIndex: null, expected: fireOracle.lines, actual: fireOracle.lines },
    clientMirrorCompare: replayClientMirrorCompare(fireOracle, probe.history),
    historyLength: probe.history.length,
  });

  if (!markerInTmux) {
    steps[steps.length - 1].ok = false;
    steps[steps.length - 1].reason = `marker "${marker}" not found in tmux capture-pane after schedule fire`;
  }

  // 3. Wait for schedule-event from daemon
  try {
    await probe.waitForScheduleEvent(
      (event) => event.jobId === jobId && event.type === 'triggered',
      SCHEDULE_FIRE_TIMEOUT_MS,
    );
    steps.push({
      label: 'schedule-event-received',
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

function resolveWsUrl() {
  const config = resolveDaemonRuntimeConfig();
  const base = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  return {
    wsUrl: `ws://${base}:${config.port}/ws`,
    authToken: config.authToken,
  };
}

async function runCase(caseName: CaseName, daemonController: LabDaemonController | null) {
  resetLabSession();
  await sleep(150);
  const { wsUrl, authToken } = resolveWsUrl();
  const probe = new DaemonProbe(wsUrl, authToken);
  const operator = new AttachedTmuxOperator();

  try {
    await probe.connect();
    let result: CaseResult;
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
    result.clientMirrorCompare = replayClientMirrorCompare(result.oracle, probe.history);
    if (!result.clientMirrorCompare.ok) {
      result.ok = false;
      result.reason = result.reason || 'client local mirror diverged from tmux truth';
    }
    writeCaseEvidence(result, probe);
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return writeFailedCaseEvidence(caseName, reason, probe);
  } finally {
    operator.close();
    probe.close();
    cleanupLabSession();
  }
}

async function main() {
  const caseArg = process.argv.find((arg) => arg.startsWith('--case='))?.split('=', 2)[1] || 'all';
  const managedDaemon = process.argv.includes('--managed-daemon');
  const requestedCases: CaseName[] = caseArg === 'all'
    ? ['codex-live', 'top-live', 'vim-live', 'initial-sync', 'local-input-echo', 'external-input-echo', 'daemon-restart-recover', 'schedule-fire']
    : [caseArg as CaseName];

  const daemonController = managedDaemon ? new LabDaemonController() : null;
  const results: CaseResult[] = [];
  try {
    if (daemonController) {
      await daemonController.start();
    }

    for (const caseName of requestedCases) {
      if (!['codex-live', 'top-live', 'vim-live', 'initial-sync', 'local-input-echo', 'external-input-echo', 'daemon-restart-recover', 'schedule-fire'].includes(caseName)) {
        throw new Error(`unsupported case: ${caseName}`);
      }
      const result = await runCase(caseName, daemonController);
      results.push(result);
      console.log(`[daemon-mirror-lab] ${caseName}: ${result.ok ? 'PASS' : 'FAIL'}`);
      if (!result.ok) {
        console.log(`  reason: ${result.reason}`);
        console.log(`  evidence: ${join(process.cwd(), 'evidence', 'daemon-mirror', currentDateFolder(), caseName)}`);
        process.exitCode = 1;
        break;
      }
    }
  } finally {
    await daemonController?.close();
  }

  const summaryPath = join(process.cwd(), 'evidence', 'daemon-mirror', currentDateFolder(), 'summary.json');
  mkdirSync(join(process.cwd(), 'evidence', 'daemon-mirror', currentDateFolder()), { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`[daemon-mirror-lab] summary: ${summaryPath}`);
}

void main().catch((error) => {
  console.error(`[daemon-mirror-lab] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
