import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import type {
  BridgeClientMessage,
  BridgeServerMessage,
} from '@zterm/shared';
import type {
  BufferHeadPayload,
  BufferSyncRequestPayload,
  TerminalBufferPayload,
} from '@zterm/shared';

interface SubscriberCounters {
  receivedBytes: number;
  bufferSyncBytes: number;
  bufferSyncCount: number;
  bufferHeadBytes: number;
  bufferHeadCount: number;
  messageCount: number;
}

interface ProbeOptions {
  wsUrl: string;
  token: string;
  sessionName: string;
  label: string;
  cols: number;
  rows: number;
}

function emptyCounters(): SubscriberCounters {
  return {
    receivedBytes: 0,
    bufferSyncBytes: 0,
    bufferSyncCount: 0,
    bufferHeadBytes: 0,
    bufferHeadCount: 0,
    messageCount: 0,
  };
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      promise.finally(() => clearTimeout(timer)).catch(() => undefined);
    }),
  ]);
}

function rawByteLength(raw: WebSocket.RawData) {
  if (typeof raw === 'string') {
    return Buffer.byteLength(raw);
  }
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength;
  }
  if (Array.isArray(raw)) {
    return raw.reduce((total, part) => total + part.length, 0);
  }
  return raw.length;
}

function rawText(raw: WebSocket.RawData) {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString('utf8');
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8');
  }
  return raw.toString('utf8');
}

class TerminalProtocolSubscriber {
  private readonly options: ProbeOptions;
  private controlSocket: WebSocket | null = null;
  private sessionSocket: WebSocket | null = null;
  private counters = emptyCounters();
  private connected = false;
  private sessionSocketOpenCount = 0;
  private sessionSocketCloseCount = 0;
  private lastHead: BufferHeadPayload | null = null;
  private lastPayloadBounds: {
    revision: number;
    startIndex: number;
    endIndex: number;
    availableStartIndex: number;
    availableEndIndex: number;
  } | null = null;
  private maxRevision = 0;
  private bodyRevisionReceivedAtMap = new Map<number, number>();
  private fatalError: Error | null = null;

  constructor(options: ProbeOptions) {
    this.options = options;
  }

  private transportUrl(role: 'control' | 'session') {
    const url = new URL(this.options.wsUrl);
    url.searchParams.set('ztermTransport', role);
    if (this.options.token) {
      url.searchParams.set('token', this.options.token);
    }
    return url.toString();
  }

  private send(message: BridgeClientMessage) {
    if (!this.sessionSocket || this.sessionSocket.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.options.label} session socket is not open`);
    }
    this.sessionSocket.send(JSON.stringify(message));
  }

  async connect() {
    const openRequestId = `perf-${this.options.label}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    const ticket = new Promise<{
      openRequestId: string;
      sessionTransportToken: string;
      sessionName: string;
    }>((resolve, reject) => {
      const control = new WebSocket(this.transportUrl('control'));
      this.controlSocket = control;
      control.once('open', () => {
        const message: BridgeClientMessage = {
          type: 'session-open',
          payload: {
            openRequestId,
            sessionName: this.options.sessionName,
            cols: this.options.cols,
            rows: this.options.rows,
            widthMode: 'mirror-fixed',
          },
        };
        control.send(JSON.stringify(message));
      });
      control.on('message', (raw) => {
        const message = JSON.parse(rawText(raw)) as BridgeServerMessage;
        if (
          message.type === 'session-ticket' &&
          message.payload.openRequestId === openRequestId
        ) {
          resolve(message.payload);
          return;
        }
        if (message.type === 'session-open-failed' || message.type === 'error') {
          reject(
            new Error(
              `${this.options.label} control failed: ${message.payload.message}`,
            ),
          );
        }
      });
      control.once('error', reject);
      control.once('close', () => {
        if (!this.connected) {
          reject(
            new Error(
              `${this.options.label} control closed before session ticket`,
            ),
          );
        }
      });
    });

    const resolvedTicket = await withTimeout(
      ticket,
      8_000,
      `${this.options.label} session ticket`,
    );
    const connected = new Promise<void>((resolve, reject) => {
      const session = new WebSocket(this.transportUrl('session'));
      this.sessionSocket = session;
      session.once('open', () => {
        this.sessionSocketOpenCount += 1;
        const message: BridgeClientMessage = {
          type: 'connect',
          payload: {
            openRequestId: resolvedTicket.openRequestId,
            sessionTransportToken:
              resolvedTicket.sessionTransportToken,
            sessionName: resolvedTicket.sessionName,
            cols: this.options.cols,
            rows: this.options.rows,
            widthMode: 'mirror-fixed',
          },
        };
        session.send(JSON.stringify(message));
      });
      session.on('message', (raw) => {
        this.handleMessage(raw);
        if (this.connected) {
          resolve();
        }
      });
      session.once('error', (error) => {
        this.fatalError =
          error instanceof Error ? error : new Error(String(error));
        reject(this.fatalError);
      });
      session.once('close', () => {
        this.sessionSocketCloseCount += 1;
        if (!this.connected) {
          reject(
            new Error(
              `${this.options.label} session socket closed before connect`,
            ),
          );
        }
      });
    });
    await withTimeout(
      connected,
      10_000,
      `${this.options.label} session connect`,
    );
    this.setBodySubscribed(true);
    this.requestHead();
    await this.waitFor(
      () => this.lastHead !== null,
      8_000,
      'initial buffer head',
    );
    this.requestCurrentRange();
    await this.waitFor(
      () => this.lastPayloadBounds !== null,
      8_000,
      'initial buffer body',
    );
  }

  private handleMessage(raw: WebSocket.RawData) {
    const bytes = rawByteLength(raw);
    const message = JSON.parse(rawText(raw)) as BridgeServerMessage;
    this.counters.receivedBytes += bytes;
    this.counters.messageCount += 1;
    if (message.type === 'connected') {
      this.connected = true;
      return;
    }
    if (message.type === 'buffer-head') {
      this.lastHead = message.payload;
      this.maxRevision = Math.max(
        this.maxRevision,
        Math.max(0, Math.floor(message.payload.revision || 0)),
      );
      this.counters.bufferHeadBytes += bytes;
      this.counters.bufferHeadCount += 1;
      return;
    }
    if (message.type === 'buffer-sync') {
      const payload = message.payload as TerminalBufferPayload;
      const revision = Math.max(0, Math.floor(payload.revision || 0));
      this.maxRevision = Math.max(this.maxRevision, revision);
      this.bodyRevisionReceivedAtMap.set(revision, Date.now());
      this.lastPayloadBounds = {
        revision,
        startIndex: Math.max(0, Math.floor(payload.startIndex || 0)),
        endIndex: Math.max(0, Math.floor(payload.endIndex || 0)),
        availableStartIndex: Math.max(
          0,
          Math.floor(
            payload.availableStartIndex ?? payload.startIndex ?? 0,
          ),
        ),
        availableEndIndex: Math.max(
          0,
          Math.floor(
            payload.availableEndIndex ?? payload.endIndex ?? 0,
          ),
        ),
      };
      this.counters.bufferSyncBytes += bytes;
      this.counters.bufferSyncCount += 1;
      return;
    }
    if (message.type === 'error') {
      this.fatalError = new Error(
        `${this.options.label} daemon error: ${message.payload.message}`,
      );
    }
  }

  resetCounters() {
    this.counters = emptyCounters();
  }

  snapshot() {
    return {
      label: this.options.label,
      connected: this.connected,
      sessionSocketOpenCount: this.sessionSocketOpenCount,
      sessionSocketCloseCount: this.sessionSocketCloseCount,
      maxRevision: this.maxRevision,
      lastHeadRevision: this.lastHead?.revision ?? null,
      latestBodyRevisionReceivedAt:
        this.bodyRevisionReceivedAtMap.get(this.maxRevision) ?? null,
      counters: { ...this.counters },
      errorCode: this.fatalError ? 'subscriber_runtime_error' : null,
    };
  }

  currentRevision() {
    return this.maxRevision;
  }

  bodyRevisionReceivedAt(revision: number) {
    return this.bodyRevisionReceivedAtMap.get(revision) ?? null;
  }

  setBodySubscribed(subscribed: boolean) {
    this.send({
      type: 'body-subscription',
      payload: {
        version: 1,
        subscribed,
      },
    });
  }

  requestHead() {
    this.send({ type: 'buffer-head-request' });
  }

  requestCurrentRange() {
    const latestEndIndex = Math.max(
      0,
      Math.floor(
        this.lastHead?.latestEndIndex ??
          this.lastPayloadBounds?.availableEndIndex ??
          0,
      ),
    );
    const availableStartIndex = Math.max(
      0,
      Math.floor(
        this.lastHead?.availableStartIndex ??
          this.lastPayloadBounds?.availableStartIndex ??
          0,
      ),
    );
    const requestStartIndex = Math.max(
      availableStartIndex,
      latestEndIndex - this.options.rows * 3,
    );
    const payload: BufferSyncRequestPayload = {
      knownRevision: this.lastPayloadBounds?.revision ?? 0,
      localStartIndex: this.lastPayloadBounds?.startIndex ?? 0,
      localEndIndex: this.lastPayloadBounds?.endIndex ?? 0,
      requestStartIndex,
      requestEndIndex: latestEndIndex,
      targetHeadRevision: this.lastHead?.revision,
    };
    this.send({
      type: 'buffer-sync-request',
      payload,
    });
  }

  async waitFor(
    predicate: () => boolean,
    timeoutMs: number,
    label: string,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.fatalError) {
        throw this.fatalError;
      }
      if (predicate()) {
        return;
      }
      await wait(20);
    }
    throw new Error(`${this.options.label} ${label} timed out`);
  }

  async close() {
    this.connected = false;
    await Promise.all([
      closeSocket(this.controlSocket),
      closeSocket(this.sessionSocket),
    ]);
    this.controlSocket = null;
    this.sessionSocket = null;
  }
}

async function closeSocket(socket: WebSocket | null) {
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 300);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
    if (socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
  });
}

function runTmux(
  tmuxBinary: string,
  args: string[],
  operation: string,
) {
  const result = spawnSync(tmuxBinary, args, {
    encoding: 'utf8',
    timeout: 8_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${operation} failed: ${
        result.error?.message ||
        result.stderr.trim() ||
        `exit ${result.status}`
      }`,
    );
  }
}

function generateTmuxSample(
  tmuxBinary: string,
  sessionName: string,
  phase: string,
  lineCount: number,
  lineWidth: number,
) {
  if (!/^[A-Za-z0-9_.:-]+$/.test(sessionName)) {
    throw new Error('sessionName contains unsupported characters');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(phase)) {
    throw new Error('phase contains unsupported characters');
  }
  const width = Math.max(16, Math.min(512, Math.floor(lineWidth)));
  const count = Math.max(1, Math.min(10_000, Math.floor(lineCount)));
  const command =
    `i=1; while [ $i -le ${count} ]; do ` +
    `printf 'zterm-${phase}-%04d-%0${width}d\\n' \"$i\" \"$i\"; ` +
    `i=$((i+1)); done`;
  runTmux(
    tmuxBinary,
    ['send-keys', '-t', sessionName, '-l', command],
    'tmux send sample command',
  );
  runTmux(
    tmuxBinary,
    ['send-keys', '-t', sessionName, 'Enter'],
    'tmux execute sample command',
  );
}

function readArg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readNumberArg(
  name: string,
  fallback: number,
  minimum: number,
) {
  const value = Number(readArg(name) ?? fallback);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be >= ${minimum}`);
  }
  return value;
}

async function runInactiveBodyProbe() {
  const wsUrl = readArg('--ws-url') ?? 'ws://127.0.0.1:3333/ws';
  const inactiveWsUrl = readArg('--inactive-ws-url') ?? wsUrl;
  const token = readArg('--token') ?? '';
  const sessionName = readArg('--session') ?? '';
  const tmuxBinary = readArg('--tmux') ?? '/opt/homebrew/bin/tmux';
  const lineCount = readNumberArg('--sample-lines', 80, 1);
  const lineWidth = readNumberArg('--sample-width', 96, 16);
  if (!sessionName) {
    throw new Error('--session is required');
  }
  const active = new TerminalProtocolSubscriber({
    wsUrl,
    token,
    sessionName,
    label: 'healthy-active',
    cols: 120,
    rows: 40,
  });
  const inactive = new TerminalProtocolSubscriber({
    wsUrl: inactiveWsUrl,
    token,
    sessionName,
    label: 'inactive',
    cols: 120,
    rows: 40,
  });

  try {
    await active.connect();
    await inactive.connect();

    const baselineStartRevision = active.currentRevision();
    active.resetCounters();
    inactive.resetCounters();
    generateTmuxSample(
      tmuxBinary,
      sessionName,
      `baseline-${Date.now()}`,
      lineCount,
      lineWidth,
    );
    await active.waitFor(
      () => active.currentRevision() > baselineStartRevision,
      8_000,
      'baseline active revision',
    );
    const baselineRevision = active.currentRevision();
    await inactive.waitFor(
      () => inactive.currentRevision() >= baselineRevision,
      8_000,
      'baseline inactive revision',
    );
    await wait(300);
    const baselineActive = active.snapshot();
    const baselineInactive = inactive.snapshot();

    inactive.setBodySubscribed(false);
    await wait(150);
    const unsubscribedStartRevision = active.currentRevision();
    active.resetCounters();
    inactive.resetCounters();
    generateTmuxSample(
      tmuxBinary,
      sessionName,
      `unsubscribed-${Date.now()}`,
      lineCount,
      lineWidth,
    );
    await active.waitFor(
      () => active.currentRevision() > unsubscribedStartRevision,
      8_000,
      'unsubscribed active revision',
    );
    const unsubscribedRevision = active.currentRevision();
    await wait(600);
    const unsubscribedActive = active.snapshot();
    const unsubscribedInactive = inactive.snapshot();

    inactive.requestHead();
    await inactive.waitFor(
      () =>
        (inactive.snapshot().lastHeadRevision ?? 0) >=
        unsubscribedRevision,
      4_000,
      'explicit head while body unsubscribed',
    );
    const openCountBeforeResubscribe =
      inactive.snapshot().sessionSocketOpenCount;
    inactive.setBodySubscribed(true);
    inactive.requestCurrentRange();
    await inactive.waitFor(
      () => inactive.currentRevision() >= unsubscribedRevision,
      6_000,
      'resubscribe latest revision',
    );
    const resubscribedInactive = inactive.snapshot();

    const baselineBodyBytes =
      baselineInactive.counters.bufferSyncBytes;
    const inactiveBodyBytes =
      unsubscribedInactive.counters.bufferSyncBytes;
    const reduction =
      baselineBodyBytes > 0
        ? 1 - inactiveBodyBytes / baselineBodyBytes
        : 0;
    const result = {
      mode: 'inactive-body',
      sessionName,
      sample: {
        lineCount,
        lineWidth,
      },
      baseline: {
        revision: baselineRevision,
        active: baselineActive,
        inactive: baselineInactive,
      },
      unsubscribed: {
        revision: unsubscribedRevision,
        active: unsubscribedActive,
        inactive: unsubscribedInactive,
      },
      resubscribed: resubscribedInactive,
      metrics: {
        baselineInactiveBodyBytes: baselineBodyBytes,
        inactiveBodyBytes,
        inactiveBodyReductionRatio: reduction,
        transportRecreated:
          resubscribedInactive.sessionSocketOpenCount !==
          openCountBeforeResubscribe,
        finalRevisionMatched:
          resubscribedInactive.maxRevision >= unsubscribedRevision,
      },
      pass:
        baselineBodyBytes > 0 &&
        reduction >= 0.95 &&
        inactiveBodyBytes === 0 &&
        resubscribedInactive.sessionSocketOpenCount ===
          openCountBeforeResubscribe &&
        resubscribedInactive.maxRevision >= unsubscribedRevision,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.pass) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all([active.close(), inactive.close()]);
  }
}

async function runHealthySlowProbe() {
  const wsUrl = readArg('--ws-url') ?? 'ws://127.0.0.1:3333/ws';
  const slowWsUrl = readArg('--slow-ws-url') ?? wsUrl;
  const token = readArg('--token') ?? '';
  const sessionName = readArg('--session') ?? '';
  const tmuxBinary = readArg('--tmux') ?? '/opt/homebrew/bin/tmux';
  const lineCount = readNumberArg('--sample-lines', 40, 1);
  const lineWidth = readNumberArg('--sample-width', 96, 16);
  const measuredRttMs = readNumberArg('--measured-rtt-ms', 300, 1);
  if (!sessionName) {
    throw new Error('--session is required');
  }

  const healthy = new TerminalProtocolSubscriber({
    wsUrl,
    token,
    sessionName,
    label: 'healthy-direct',
    cols: 120,
    rows: 40,
  });
  const slow = new TerminalProtocolSubscriber({
    wsUrl: slowWsUrl,
    token,
    sessionName,
    label: 'slow-shaped',
    cols: 120,
    rows: 40,
  });

  try {
    await healthy.connect();
    await slow.connect();
    healthy.resetCounters();
    slow.resetCounters();
    const startRevision = Math.max(
      healthy.currentRevision(),
      slow.currentRevision(),
    );
    const sampleStartedAt = Date.now();
    generateTmuxSample(
      tmuxBinary,
      sessionName,
      `healthy-slow-${Date.now()}`,
      lineCount,
      lineWidth,
    );
    await healthy.waitFor(
      () => healthy.currentRevision() > startRevision,
      8_000,
      'healthy latest revision',
    );
    const targetRevision = healthy.currentRevision();
    const healthyReceivedAt =
      healthy.bodyRevisionReceivedAt(targetRevision) ?? Date.now();
    await slow.waitFor(
      () => slow.currentRevision() >= targetRevision,
      12_000,
      'slow latest revision',
    );
    const slowReceivedAt =
      slow.bodyRevisionReceivedAt(targetRevision) ?? Date.now();
    await wait(200);

    const maxDrainMs = Math.max(1000, 2 * measuredRttMs);
    const healthyLatencyMs = healthyReceivedAt - sampleStartedAt;
    const slowLatencyMs = slowReceivedAt - sampleStartedAt;
    const drainAfterHealthyMs = slowReceivedAt - healthyReceivedAt;
    const result = {
      mode: 'healthy-slow',
      sessionName,
      sample: {
        lineCount,
        lineWidth,
        measuredRttMs,
      },
      targetRevision,
      healthy: healthy.snapshot(),
      slow: slow.snapshot(),
      metrics: {
        healthyLatencyMs,
        slowLatencyMs,
        drainAfterHealthyMs,
        maxDrainMs,
        healthyReceivedBody:
          healthy.bodyRevisionReceivedAt(targetRevision) !== null,
        slowReceivedBody:
          slow.bodyRevisionReceivedAt(targetRevision) !== null,
        slowFinalRevisionMatched:
          slow.currentRevision() >= targetRevision,
      },
      pass:
        healthy.bodyRevisionReceivedAt(targetRevision) !== null &&
        slow.bodyRevisionReceivedAt(targetRevision) !== null &&
        slow.currentRevision() >= targetRevision &&
        drainAfterHealthyMs <= maxDrainMs &&
        healthyLatencyMs <= maxDrainMs,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.pass) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all([healthy.close(), slow.close()]);
  }
}

async function runCli() {
  const mode = readArg('--mode') ?? 'inactive-body';
  if (mode === 'inactive-body') {
    await runInactiveBodyProbe();
    return;
  }
  if (mode === 'healthy-slow') {
    await runHealthySlowProbe();
    return;
  }
  {
    throw new Error(`unsupported probe mode: ${mode}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
