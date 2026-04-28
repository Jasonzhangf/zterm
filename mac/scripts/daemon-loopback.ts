/**
 * Mac daemon loopback test — mirrors android/scripts/daemon-mirror-lab.ts pattern.
 *
 * Connects to the running daemon via WebSocket, creates a test tmux session,
 * verifies: connect → buffer-sync → input echo → tmux oracle comparison.
 *
 * Usage:
 *   cd mac && ./node_modules/.bin/tsx scripts/daemon-loopback.ts [--case=initial-sync|local-input-echo|all]
 *   cd mac && ./node_modules/.bin/tsx scripts/daemon-loopback.ts --case=all --host=127.0.0.1 --port=3333
 */

import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WebSocket } from 'ws';
import {
  cellsToLine,
  normalizeWireLines,
  replayBufferSyncHistory,
} from '@zterm/shared/terminal-buffer';
import { DEFAULT_TERMINAL_CACHE_LINES } from '@zterm/shared/mobile-config';
import type {
  TerminalBufferPayload,
  TerminalCell,
  BufferSyncRequestPayload,
} from '@zterm/shared/types';
import type {
  BridgeServerMessage,
} from '@zterm/shared/protocol';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAB_SESSION_NAME = 'zterm_mac_loopback';
const LAB_COLS = 80;
const LAB_ROWS = 24;
const WAIT_TIMEOUT_MS = 8000;

type CaseName = 'initial-sync' | 'local-input-echo' | 'all';

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
  caseName: string;
  ok: boolean;
  reason?: string;
  oracle: OracleSnapshot;
  daemonPayload: TerminalBufferPayload | null;
  compare: CompareResult;
  clientMirrorCompare?: CompareResult;
  steps?: CaseStepResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowStamp() {
  return new Date().toISOString();
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
    if (cell.width === 0) continue;
    line += cell.char >= 32 ? String.fromCodePoint(cell.char) : ' ';
  }
  return normalizeLine(line);
}

function currentDateFolder() {
  return new Date().toISOString().slice(0, 10);
}

function runTmux(args: string[], options?: { allowFailure?: boolean }) {
  const result = spawnSync('tmux', args, {
    encoding: 'utf-8',
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options?.allowFailure) {
    throw new Error(result.stderr?.trim() || `tmux ${args.join(' ')} exited with ${result.status}`);
  }
  return result.stdout || '';
}

function sessionExists(sessionName: string) {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], {
    encoding: 'utf-8',
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  return result.status === 0;
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
  const paneId = runTmux(['display-message', '-p', '-t', LAB_SESSION_NAME, '#{pane_id}']).trim() || LAB_SESSION_NAME;
  const metricText = runTmux([
    'display-message', '-p', '-t', paneId,
    '#{pane_height}\t#{pane_width}\t#{history_size}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}\t#{alternate_on}\t#{pane_current_command}',
  ]).trim();

  const [
    rowsRaw = '24', colsRaw = '80', historyRaw = '0',
    cursorXRaw = '0', cursorYRaw = '0', cursorVisibleRaw = '0',
    alternateOnRaw = '0', paneCommandRaw = '',
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
    'capture-pane', '-p', '-M', '-N', '-t', paneId,
    '-S', '0', '-E', `${Math.max(0, paneRows - 1)}`,
  ]);
  const visibleLines = normalizeCapture(rawCapture);
  const paddedLines = Array.from({ length: paneRows }, (_, index) => normalizeLine(visibleLines[index] || ''));

  return { sessionName: LAB_SESSION_NAME, paneId, paneRows, paneCols, historySize, cursorX, cursorY, cursorVisible, alternateOn, paneCommand, lines: paddedLines };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compareTail(oracle: OracleSnapshot, payload: TerminalBufferPayload | null): CompareResult {
  const expected = oracle.lines;
  if (!payload) {
    return { ok: false, mismatchIndex: 0, expected, actual: Array.from({ length: oracle.paneRows }, () => '') };
  }

  const rowCount = Math.max(1, payload.rows || oracle.paneRows);
  const viewportBottom = Math.max(0, Number.isFinite(payload.availableEndIndex) ? payload.availableEndIndex! : payload.endIndex);
  const startIndex = Math.max(0, viewportBottom - rowCount);
  const linesByIndex = new Map<number, string>();
  for (const line of normalizeWireLines(payload.lines as any, payload.cols || oracle.paneCols)) {
    linesByIndex.set(line.index, cellsToText(line.cells));
  }

  const actual = Array.from({ length: rowCount }, (_, offset) => normalizeLine(linesByIndex.get(startIndex + offset) || ''));

  let mismatchIndex: number | null = null;
  const compareLength = Math.max(expected.length, actual.length);
  for (let index = 0; index < compareLength; index += 1) {
    if ((expected[index] || '') !== (actual[index] || '')) {
      mismatchIndex = index;
      break;
    }
  }

  return { ok: mismatchIndex === null, mismatchIndex, expected, actual };
}

function deriveRenderRows(options: { lines: TerminalCell[][]; startIndex: number; viewportEndIndex: number; viewportRows: number }) {
  const viewportRows = Math.max(1, Math.floor(options.viewportRows || 24));
  const viewportBottomIndex = Math.max(0, Math.floor(options.viewportEndIndex));
  const viewportTopIndex = Math.max(0, viewportBottomIndex - viewportRows);
  const rows: Array<{ index: number; row: TerminalCell[] }> = [];
  for (let index = viewportTopIndex; index < viewportBottomIndex; index += 1) {
    const rowOffset = index - options.startIndex;
    rows.push({ index, row: rowOffset >= 0 && rowOffset < options.lines.length ? options.lines[rowOffset] || [] : [] });
  }
  return { viewportTopIndex, viewportBottomIndex, rows };
}

function replayClientMirrorCompare(oracle: OracleSnapshot, history: Array<{ at: string; type: string; payload: TerminalBufferPayload }>): CompareResult {
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

  return { ok: mismatchIndex === null, mismatchIndex, expected, actual };
}

function buildStepResult(label: string, oracle: OracleSnapshot, daemonPayload: TerminalBufferPayload | null, history: Array<{ at: string; type: string; payload: TerminalBufferPayload }>, reasonWhenFailed: string): CaseStepResult {
  const compare = compareTail(oracle, daemonPayload);
  const clientMirrorCompare = replayClientMirrorCompare(oracle, history);
  const ok = compare.ok && clientMirrorCompare.ok;
  return {
    label,
    ok,
    reason: compare.ok ? (clientMirrorCompare.ok ? undefined : 'client local mirror diverged from tmux truth') : reasonWhenFailed,
    oracle,
    daemonPayload,
    compare,
    clientMirrorCompare,
    historyLength: history.length,
  };
}

function finalizeCase(caseName: string, steps: CaseStepResult[]): CaseResult {
  const failedStep = steps.find((step) => !step.ok);
  const primary = failedStep || steps[steps.length - 1];
  return { caseName, ok: !failedStep, reason: failedStep?.reason, oracle: primary.oracle, daemonPayload: primary.daemonPayload, compare: primary.compare, steps };
}

// ---------------------------------------------------------------------------
// DaemonProbe
// ---------------------------------------------------------------------------

class DaemonProbe {
  private readonly wsUrl: string;
  private readonly authToken: string;
  private readonly clientSessionId: string;
  private ws: WebSocket | null = null;
  private connected = false;
  private lastPayload: TerminalBufferPayload | null = null;
  private lastHead: { revision: number; latestEndIndex: number } | null = null;
  private lastHeadRequestedAt = 0;
  private readonly payloadHistory: Array<{ at: string; type: string; payload: TerminalBufferPayload }> = [];
  private readonly eventHistory: ProbeEventEntry[] = [];

  constructor(wsUrl: string, authToken: string) {
    this.wsUrl = authToken ? `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(authToken)}` : wsUrl;
    this.authToken = authToken;
    this.clientSessionId = `mac-probe-${Math.random().toString(36).slice(2, 10)}`;
  }

  get payload() { return this.lastPayload; }
  get history() { return this.payloadHistory; }
  get events() { return this.eventHistory; }

  async connect() {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      let settled = false;
      this.ws = ws;

      ws.on('open', () => {
        const connectMessage = {
          type: 'connect' as const,
          payload: {
            clientSessionId: this.clientSessionId,
            name: LAB_SESSION_NAME,
            bridgeHost: '127.0.0.1',
            bridgePort: 0,
            sessionName: LAB_SESSION_NAME,
            cols: LAB_COLS,
            rows: LAB_ROWS,
            authToken: this.authToken,
            authType: 'password' as const,
          },
        };
        this.eventHistory.push({ at: nowStamp(), direction: 'sent', type: connectMessage.type, payload: connectMessage.payload });
        ws.send(JSON.stringify(connectMessage));
      });

      ws.on('message', (raw) => {
        const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
        const message = JSON.parse(text) as BridgeServerMessage;
        this.eventHistory.push({ at: nowStamp(), direction: 'recv', type: message.type, payload: 'payload' in message ? (message as any).payload : undefined });

        if (message.type === 'connected') {
          this.connected = true;
          this.requestHead(true);
          if (!settled) { settled = true; resolve(); }
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
          this.payloadHistory.push({ at: nowStamp(), type: message.type, payload: message.payload });
        }
        if (message.type === 'error') {
          const error = new Error(message.payload.message);
          if (!settled) { settled = true; reject(error); }
        }
      });

      ws.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
      ws.on('close', () => { if (!settled) { settled = true; reject(new Error('daemon websocket closed before connect')); } });
    });

    await this.waitForPayload('initial buffer-sync');
  }

  close() { this.ws?.close(); this.ws = null; }

  sendInput(data: string) {
    if (!this.ws || !this.connected) throw new Error('probe is not connected');
    const message = { type: 'input' as const, payload: data };
    this.eventHistory.push({ at: nowStamp(), direction: 'sent', type: message.type, payload: message.payload });
    this.ws.send(JSON.stringify(message));
    this.requestHead(true);
  }

  async waitForPayload(label: string, predicate?: (payload: TerminalBufferPayload) => boolean, timeoutMs: number = WAIT_TIMEOUT_MS) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      this.requestHead();
      if (this.lastPayload && (!predicate || predicate(this.lastPayload))) return this.lastPayload;
      await sleep(80);
    }
    throw new Error(`timeout waiting for payload: ${label}`);
  }

  async waitForMarker(marker: string, timeoutMs: number = WAIT_TIMEOUT_MS) {
    return this.waitForPayload(`marker ${marker}`, (payload) => {
      const joined = normalizeWireLines(payload.lines as any, payload.cols || LAB_COLS)
        .map((line) => cellsToText(line.cells))
        .join('\n');
      return joined.includes(marker);
    }, timeoutMs);
  }

  sendMessage(message: Record<string, unknown>) {
    if (!this.ws || !this.connected) throw new Error('probe is not connected');
    this.eventHistory.push({ at: nowStamp(), direction: 'sent', type: message.type as string, payload: message.payload });
    this.ws.send(JSON.stringify(message));
  }

  private requestHead(force = false) {
    if (!this.ws || !this.connected) return;
    const now = Date.now();
    if (!force && now - this.lastHeadRequestedAt < 80) return;
    this.lastHeadRequestedAt = now;
    this.ws.send(JSON.stringify({ type: 'buffer-head-request' }));
  }

  private requestFollowWindow(viewportEndIndex: number) {
    if (!this.ws || !this.connected) return;
    const requestEndIndex = Math.max(0, Math.floor(viewportEndIndex || this.lastPayload?.availableEndIndex || this.lastPayload?.endIndex || 0));
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
    this.ws.send(JSON.stringify({ type: 'buffer-sync-request', payload }));
  }
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

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

  const markerA = '__mac_loopback_a__';
  probe.sendInput(`printf 'hello-mac-a\\n${markerA}\\n'\r`);
  const payloadA = await probe.waitForMarker(markerA);
  await sleep(200);
  const oracleA = captureOracleSnapshot();
  steps.push(buildStepResult('local-input-echo-a', oracleA, payloadA, probe.history, 'daemon local-input mirror diverged from tmux truth'));
  if (!steps[steps.length - 1]?.ok) return finalizeCase('local-input-echo', steps);

  const markerB = '__mac_loopback_b__';
  probe.sendInput(`printf 'hello-mac-b\\n${markerB}\\n'\r`);
  const payloadB = await probe.waitForMarker(markerB);
  await sleep(200);
  const oracleB = captureOracleSnapshot();
  steps.push(buildStepResult('local-input-echo-b', oracleB, payloadB, probe.history, 'daemon second local-input mirror diverged from tmux truth'));

  return finalizeCase('local-input-echo', steps);
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function ensureCaseDir(caseName: string) {
  const dir = join(process.cwd(), 'evidence', 'daemon-loopback', currentDateFolder(), caseName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCaseEvidence(result: CaseResult, probe: DaemonProbe) {
  const caseDir = ensureCaseDir(result.caseName);
  writeFileSync(join(caseDir, 'tmux-capture.txt'), `${result.oracle.lines.join('\n')}\n`);
  writeFileSync(join(caseDir, 'probe-history.json'), `${JSON.stringify(probe.history, null, 2)}\n`);
  writeFileSync(join(caseDir, 'probe-events.json'), `${JSON.stringify(probe.events, null, 2)}\n`);
  writeFileSync(join(caseDir, 'comparison.json'), `${JSON.stringify(result.compare, null, 2)}\n`);
  if (result.clientMirrorCompare) {
    writeFileSync(join(caseDir, 'client-mirror-comparison.json'), `${JSON.stringify(result.clientMirrorCompare, null, 2)}\n`);
  }
  if (result.steps?.length) {
    writeFileSync(join(caseDir, 'step-results.json'), `${JSON.stringify(result.steps, null, 2)}\n`);
  }
  writeFileSync(join(caseDir, 'summary.txt'), [
    `case=${result.caseName}`, `ok=${result.ok}`, `reason=${result.reason || ''}`,
    `mismatchIndex=${result.compare.mismatchIndex ?? 'none'}`, `generatedAt=${nowStamp()}`,
  ].join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const caseArg = args.find((a) => a.startsWith('--case='))?.split('=')[1] || 'all';
  const host = args.find((a) => a.startsWith('--host='))?.split('=')[1] || '127.0.0.1';
  const port = args.find((a) => a.startsWith('--port='))?.split('=')[1] || '3333';
  const authToken = args.find((a) => a.startsWith('--token='))?.split('=')[1] || 'wterm-4123456';
  return { caseArg, host, port, authToken };
}

async function main() {
  const { caseArg, host, port, authToken } = parseArgs();
  const wsUrl = `ws://${host}:${port}/ws`;
  const cases: string[] = caseArg === 'all' ? ['initial-sync', 'local-input-echo'] : [caseArg];

  console.log(`[mac-loopback] connecting to ${wsUrl} (cases: ${cases.join(', ')})`);

  const results: CaseResult[] = [];

  for (const caseName of cases) {
    console.log(`\n[mac-loopback] === ${caseName} ===`);
    resetLabSession();
    await sleep(150);

    const probe = new DaemonProbe(wsUrl, authToken);
    try {
      await probe.connect();
      console.log(`[mac-loopback] connected, session=${LAB_SESSION_NAME}`);

      let result: CaseResult;
      switch (caseName) {
        case 'initial-sync':
          result = await runInitialSyncCase(probe);
          break;
        case 'local-input-echo':
          result = await runLocalInputCase(probe);
          break;
        default:
          throw new Error(`unsupported case: ${caseName}`);
      }

      // Always run client-mirror replay compare
      result.clientMirrorCompare = replayClientMirrorCompare(result.oracle, probe.history);
      if (!result.clientMirrorCompare.ok) {
        result.ok = false;
        result.reason = result.reason || 'client local mirror diverged from tmux truth';
      }

      writeCaseEvidence(result, probe);
      results.push(result);

      console.log(`[mac-loopback] ${caseName}: ${result.ok ? 'PASS ✅' : 'FAIL ❌'}`);
      if (!result.ok) {
        console.log(`  reason: ${result.reason}`);
        if (result.compare.mismatchIndex !== null) {
          console.log(`  mismatch at row ${result.compare.mismatchIndex}:`);
          console.log(`    expected: "${result.compare.expected[result.compare.mismatchIndex] || ''}"`);
          console.log(`    actual:   "${result.compare.actual[result.compare.mismatchIndex] || ''}"`);
        }
        process.exitCode = 1;
        break;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`[mac-loopback] ${caseName}: FAIL ❌ (error)`);
      console.log(`  reason: ${reason}`);
      process.exitCode = 1;
      break;
    } finally {
      probe.close();
      cleanupLabSession();
    }
  }

  // Summary
  const summaryDir = join(process.cwd(), 'evidence', 'daemon-loopback', currentDateFolder());
  mkdirSync(summaryDir, { recursive: true });
  const summaryPath = join(summaryDir, 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\n[mac-loopback] summary: ${summaryPath}`);

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`[mac-loopback] ${passed}/${total} cases passed`);
}

void main().catch((error) => {
  console.error(`[mac-loopback] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
