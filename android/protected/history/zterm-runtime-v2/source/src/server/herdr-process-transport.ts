import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  createHerdrBackendSessionAdapter,
  type HerdrBackendEvents,
  type HerdrBackendSessionAdapter,
  type HerdrBackendTransport,
  type HerdrSourceMessage,
} from './herdr-backend';
import { HerdrFrameCanonicalizer, type HerdrScrollMetrics } from './herdr-frame-canonicalizer';

export interface HerdrProcessTransportOptions {
  executable: string;
  sessionName: string;
  terminalId: string;
  paneId?: string;
  cols: number;
  rows: number;
  cwd?: string;
  stderrLogPath?: string;
  attachScrollMetrics?: boolean;
  serverProcess?: ChildProcessWithoutNullStreams;
  serverReady?: boolean;
}

export interface HerdrProcessTransport extends HerdrBackendTransport {
  process: ChildProcessWithoutNullStreams;
  dispose: () => void;
}

export interface HerdrProcessSessionAdapter {
  adapter: HerdrBackendSessionAdapter;
  transport: HerdrProcessTransport;
}

export const HERDR_SCROLL_METRICS_THROTTLE_MS = 100;

export function shouldRefreshHerdrScrollMetrics(
  now: number,
  lastReadAt: number,
  frameHeight: number,
  lastMetrics: HerdrScrollMetrics | null,
) {
  return !lastMetrics
    || lastMetrics.viewportRows !== frameHeight
    || now - lastReadAt >= HERDR_SCROLL_METRICS_THROTTLE_MS;
}

export function shouldPublishHerdrScrollMetrics(
  now: number,
  lastReadAt: number,
  frameHeight: number,
  lastMetrics: HerdrScrollMetrics | null,
) {
  return now === lastReadAt
    && lastMetrics !== null
    && lastMetrics.viewportRows === frameHeight;
}

function waitForHerdrReadinessWindow(milliseconds: number) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export function selectHerdrTerminalPane(
  panes: Array<{ terminal_id?: string; pane_id?: string }>,
  options: { terminalId?: string; paneId?: string },
  sessionName: string,
): { terminalId: string; paneId: string } {
  const hasIdentity = Boolean(options.terminalId || options.paneId);
  const candidates = panes.filter((candidate) => (
    (!options.terminalId || candidate.terminal_id === options.terminalId)
    && (!options.paneId || candidate.pane_id === options.paneId)
  ));
  if (!hasIdentity && candidates.length !== 1) {
    throw new Error(
      `Herdr named session ${sessionName} does not have one unambiguous terminal surface (${candidates.length} panes)`,
    );
  }
  if (candidates.length !== 1) {
    throw new Error(`Herdr named session ${sessionName} terminal surface identity is missing or ambiguous`);
  }
  const pane = candidates[0]!;
  if (!pane.terminal_id || !pane.pane_id) {
    throw new Error(`Herdr named session ${sessionName} has an invalid terminal surface identity`);
  }
  return { terminalId: pane.terminal_id, paneId: pane.pane_id };
}

export function resolveHerdrTerminalFromNamedSession(options: {
  executable: string;
  sessionName: string;
  terminalId?: string;
  paneId?: string;
}): { terminalId: string; paneId: string } {
  const argsPrefix = ['--session', assertIdentifier(options.sessionName, 'session name')];
  const raw = execFileSync(options.executable, [...argsPrefix, 'pane', 'list'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const response = JSON.parse(raw) as { result?: { panes?: Array<{ terminal_id?: string; pane_id?: string }> } };
  return selectHerdrTerminalPane(response.result?.panes || [], options, options.sessionName);
}

function assertIdentifier(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Herdr ${label} is required`);
  }
  return normalized;
}

function writeJsonLine(process: ChildProcessWithoutNullStreams, message: object) {
  if (!process.stdin.writable) {
    throw new Error('Herdr control stdin is closed');
  }
  process.stdin.write(`${JSON.stringify(message)}\n`);
}

export function parseHerdrScrollMetrics(raw: string): HerdrScrollMetrics {
  const response = JSON.parse(raw) as {
    result?: {
      pane?: { scroll?: Record<string, unknown> };
      scroll?: Record<string, unknown>;
    };
  };
  const scroll = response.result?.pane?.scroll ?? response.result?.scroll;
  const maxOffsetFromBottom = scroll?.max_offset_from_bottom;
  const offsetFromBottom = scroll?.offset_from_bottom;
  const viewportRows = scroll?.viewport_rows;
  const isNonNegativeInteger = (value: unknown): value is number =>
    Number.isInteger(value) && (value as number) >= 0;
  const isPositiveInteger = (value: unknown): value is number =>
    isNonNegativeInteger(value) && value > 0;
  if (
    !isNonNegativeInteger(maxOffsetFromBottom)
    || !isNonNegativeInteger(offsetFromBottom)
    || !isPositiveInteger(viewportRows)
    || offsetFromBottom > maxOffsetFromBottom
  ) {
    throw new Error(`Herdr pane response did not contain valid scroll metrics: ${raw}`);
  }
  return {
    maxOffsetFromBottom,
    offsetFromBottom,
    viewportRows,
  };
}

export function parseHerdrPaneGeometry(raw: string, paneId: string, sessionName: string) {
  const response = JSON.parse(raw) as {
    result?: {
      snapshot?: {
        layouts?: Array<{
          panes?: Array<{
            pane_id?: string;
            rect?: { width?: unknown; height?: unknown };
          }>;
        }>;
      };
    };
  };
  const candidates = (response.result?.snapshot?.layouts || []).flatMap((layout) =>
    (layout.panes || [])
      .filter((pane) => pane.pane_id === paneId)
      .map((pane) => pane.rect),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Herdr named session ${sessionName} does not have one unambiguous layout rect for pane ${paneId} (${candidates.length} matches)`,
    );
  }
  const rect = candidates[0]!;
  const isPositiveInteger = (value: unknown): value is number =>
    Number.isInteger(value) && (value as number) > 0;
  if (!isPositiveInteger(rect?.width) || !isPositiveInteger(rect?.height)) {
    throw new Error(
      `Herdr named session ${sessionName} has an invalid layout rect for pane ${paneId}: ${raw}`,
    );
  }
  return {
    cols: rect.width,
    rows: rect.height,
  };
}

function resolvePaneIdFromList(raw: string, terminalId: string) {
  const response = JSON.parse(raw) as {
    result?: { panes?: Array<{ pane_id?: string; terminal_id?: string }> };
  };
  const pane = response.result?.panes?.find((candidate) => candidate.terminal_id === terminalId);
  if (!pane?.pane_id) {
    throw new Error(`Herdr terminal ${terminalId} is not present in pane list`);
  }
  return pane.pane_id;
}

export function startHerdrProcessTransport(
  options: HerdrProcessTransportOptions,
  onMessage: (message: HerdrSourceMessage) => void,
): HerdrProcessTransport {
  const executable = assertIdentifier(options.executable, 'executable');
  const sessionName = assertIdentifier(options.sessionName, 'session name');
  const terminalId = assertIdentifier(options.terminalId, 'terminal id');
  if (!Number.isInteger(options.cols) || options.cols < 1 || !Number.isInteger(options.rows) || options.rows < 1) {
    throw new Error(`invalid Herdr process geometry: ${options.cols}x${options.rows}`);
  }

  const argsPrefix = ['--session', sessionName];
  const runCli = (args: string[]) => execFileSync(executable, [...argsPrefix, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const attachScrollMetrics = options.attachScrollMetrics !== false;
  let paneId = options.paneId?.trim() || '';

  const server = options.serverProcess || (options.serverReady ? null : spawn(executable, [...argsPrefix, 'server'], {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const ownsServerProcess = Boolean(server && !options.serverProcess);
  let serverReady = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    waitForHerdrReadinessWindow(25);
    try {
      runCli(['api', 'snapshot']);
      serverReady = true;
      break;
    } catch {
      // The official server starts asynchronously; retry only readiness,
      // never terminal operations or payloads.
    }
  }
  if (!serverReady) {
    if (server) server.kill('SIGTERM');
    throw new Error('Herdr server did not become ready');
  }
  if (attachScrollMetrics && !paneId) {
    paneId = resolvePaneIdFromList(runCli(['pane', 'list']), terminalId);
  }
  let lastScrollMetrics: HerdrScrollMetrics | null = null;
  let lastScrollMetricsReadAt = 0;

  const attachScrollMetricsToFrame = (
    message: Extract<HerdrSourceMessage, { type: 'terminal.frame' }>,
  ) => {
    const now = Date.now();
    const shouldRead = shouldRefreshHerdrScrollMetrics(
      now,
      lastScrollMetricsReadAt,
      message.height,
      lastScrollMetrics,
    );
    if (shouldRead) {
      try {
        lastScrollMetrics = parseHerdrScrollMetrics(runCli(['pane', 'get', paneId]));
        lastScrollMetricsReadAt = now;
      } catch {
        // A metrics read cannot invalidate or drop a frame: doing so would
        // manufacture a transport sequence gap. The frame remains valid;
        // host metrics only affect viewport-relative cursor capability.
        lastScrollMetrics = null;
        lastScrollMetricsReadAt = now;
      }
    }
    if (shouldPublishHerdrScrollMetrics(now, lastScrollMetricsReadAt, message.height, lastScrollMetrics)) {
      const scroll = lastScrollMetrics;
      if (scroll) return { ...message, scroll };
    }
    return message;
  };

  const controller = spawn(executable, [
    ...argsPrefix,
    'terminal',
    'session',
    'control',
    terminalId,
    '--takeover',
    '--cols',
    String(options.cols),
    '--rows',
    String(options.rows),
  ], { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '';
  controller.stdout.setEncoding('utf8');
  controller.stdout.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as HerdrSourceMessage;
        if (message.type === 'terminal.frame' && attachScrollMetrics) {
          onMessage(attachScrollMetricsToFrame(message));
        } else {
          onMessage(message);
        }
      } catch (error) {
        onMessage({
          type: 'terminal.error',
          code: 'invalid-herdr-jsonl',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  controller.stderr.setEncoding('utf8');
  controller.stderr.on('data', (chunk: string) => {
    if (options.stderrLogPath) {
      appendFileSync(options.stderrLogPath, chunk);
    }
  });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (!controller.killed) controller.kill('SIGTERM');
    if (server && ownsServerProcess && !server.killed) server.kill('SIGTERM');
    try {
      runCli(['server', 'stop']);
    } catch {
      // Process termination is explicit; server stop is only cleanup.
    }
  };

  return {
    process: controller,
    send: (message) => writeJsonLine(controller, message),
    close: (reason) => {
      if (!disposed) {
        writeJsonLine(controller, { type: 'terminal.release', reason });
      }
    },
    dispose,
  };
}

export async function startHerdrProcessSessionAdapter(
  options: HerdrProcessTransportOptions,
  events: HerdrBackendEvents,
): Promise<HerdrProcessSessionAdapter> {
  const canonicalizer = await HerdrFrameCanonicalizer.create();
  let adapter: HerdrBackendSessionAdapter | null = null;
  const pendingMessages: HerdrSourceMessage[] = [];
  const transport = startHerdrProcessTransport(options, (message) => {
    if (!adapter) {
      pendingMessages.push(message);
      return;
    }
    adapter.receive(message);
  });
  adapter = createHerdrBackendSessionAdapter({ canonicalizer, transport, events });
  for (const message of pendingMessages.splice(0)) {
    adapter.receive(message);
  }
  return { adapter, transport };
}
