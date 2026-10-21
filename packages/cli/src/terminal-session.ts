import type {
  TerminalInputAckPayload,
  TerminalMuxChannelServerMessage,
  TerminalReliableInputPayload,
} from '../../shared/src/connection/protocol.js';
import type { SharedConfigStore } from '../../shared/src/node/shared-config.js';
import {
  cliNoReplayPolicy,
  createReliableInputQueue,
  TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS,
  type ReliableInputFailure,
  type ReliableInputQueue,
  type ReliableInputRuntimeEvent,
  type ReliableInputSettlement,
  type ReliableInputTransportSnapshot,
} from '../../shared/src/terminal/reliable-input/reliable-input-queue.js';
import {
  resolveTerminalResizeCommitPlan,
} from '../../shared/src/terminal/renderer/viewport.js';
import { readStoredCliAuth } from './commands/auth.js';
import type {
  SessionConnection,
  SessionConnectionEvent,
  SessionChannel,
} from './connection.js';
import {
  createAnsiProjection,
  type AnsiProjectionCommit,
} from './ansi-projection.js';
import {
  createLocalInputParser,
  type LocalInputIntent,
  type LocalInputParser,
} from './local-input.js';
import {
  createMirrorConsumer,
  type MirrorCommitEvent,
  type MirrorRequestMessage,
} from './mirror-consumer.js';
import {
  createRendererWindow,
  type RendererSnapshot,
} from './renderer-window.js';
import type { CliSlotBinding } from './slot-store.js';
import {
  createTerminalLifecycle,
  type TerminalCleanupCause,
  type TerminalCleanupResult,
  type TerminalSignal,
} from './terminal-lifecycle.js';

export interface TerminalSessionIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export interface RunTerminalSessionOptions {
  store: SharedConfigStore;
  binding: CliSlotBinding;
  connection: SessionConnection;
  signal?: AbortSignal;
  io?: TerminalSessionIo;
}

interface Viewport {
  cols: number;
  rows: number;
}

interface InputFailure {
  kind: 'uncertain' | 'rejected';
  code: string;
  message?: string;
}

interface TerminalFailure {
  exitCode: number;
  message?: string;
}

interface IdleWaiter {
  resolve(value: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const AUTH_MONITOR_INTERVAL_MS = 1_000;
// Android renews the foreground attach lease on this same cadence.
const BODY_SUBSCRIPTION_HEARTBEAT_MS = 30_000;
const RESIZE_DEBOUNCE_MS = 60;
const EOF_DRAIN_TIMEOUT_MS = TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS + 500;
const INPUT_SIGNALS: readonly TerminalSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function positiveDimension(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function safeErrorCode(error: unknown) {
  const rawServerCode = error && typeof error === 'object' && 'serverCode' in error
    ? (error as { serverCode?: unknown }).serverCode
    : undefined;
  const rawCode = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  const rawName = error instanceof Error ? error.name : '';
  const candidate = typeof rawServerCode === 'string' && rawServerCode.trim()
    ? rawServerCode.trim()
    : typeof rawCode === 'string' && rawCode.trim()
      ? rawCode.trim()
      : rawName || 'unknown_error';
  const safe = candidate.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 96);
  return safe || 'unknown_error';
}

function hasEpipeCode(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'EPIPE',
  );
}

function codedError(code: string) {
  return Object.assign(new Error(code), { code });
}

function signalExitCode(signal: TerminalSignal) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 129;
}

function failureMessage(stage: string, error: unknown) {
  const code = safeErrorCode(error);
  if (stage === 'open') return `会话打开失败（${code}）。`;
  if (stage === 'input') return `输入处理失败（${code}）。`;
  if (stage === 'output') return `终端输出失败（${code}）。`;
  if (stage === 'auth') return 'CLI 登录态已失效，请重新运行 zterm login。';
  return `会话连接失败（${code}）。`;
}

function timerUnref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>) {
  (timer as { unref?: () => void }).unref?.();
}

export async function runTerminalSession(
  options: RunTerminalSessionOptions,
): Promise<{ exitCode: number; message?: string }> {
  const {
    store,
    binding,
    connection,
    signal,
    io,
  } = options;
  const input = io?.stdin ?? process.stdin;
  const output = io?.stdout ?? process.stdout;

  if (signal?.aborted) {
    try {
      connection.close('terminal_session_cancelled');
    } catch {
      // The caller already cancelled this attempt.
    }
    return { exitCode: 1, message: '终端会话已取消。' };
  }

  let initialLoginId: string;
  try {
    const auth = await readStoredCliAuth(store, signal);
    if (!auth?.loginId) {
      try {
        connection.close('auth_invalid');
      } catch {
        // Preserve the authentication failure as the terminal result.
      }
      return {
        exitCode: 1,
        message: 'CLI 登录态已失效，请重新运行 zterm login。',
      };
    }
    initialLoginId = auth.loginId;
  } catch (error) {
    if (signal?.aborted) {
      return { exitCode: 1, message: '终端会话已取消。' };
    }
    return {
      exitCode: 1,
      message: failureMessage('auth', error),
    };
  }

  let viewport: Viewport = {
    cols: positiveDimension(output.columns, DEFAULT_COLS),
    rows: positiveDimension(output.rows, DEFAULT_ROWS),
  };
  let previousViewport: Viewport = { ...viewport };
  let channel: SessionChannel | null = null;
  let openedChannelId: string | null = null;
  let generation: string | null = null;
  let channelClosed = false;
  let acceptingInput = true;
  let hasBodyCommitted = false;
  let cleanupStarted = false;
  let terminalFailure: TerminalFailure | null = null;
  let inputFailure: InputFailure | null = null;
  let reliableQueue: ReliableInputQueue | null = null;
  let eventUnsubscribe: (() => void) | null = null;
  let authTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingResize: Viewport | null = null;
  let drainWaiter: {
    promise: Promise<void>;
    resolve(): void;
    listener(): void;
  } | null = null;
  const idleWaiters = new Set<IdleWaiter>();
  const processListeners: Array<{
    event: TerminalSignal | 'SIGWINCH';
    listener: () => void;
  }> = [];
  const openAbortController = new AbortController();
  let resolveTerminal!: (result: { exitCode: number; message?: string }) => void;
  const terminalResult = new Promise<{ exitCode: number; message?: string }>((resolve) => {
    resolveTerminal = resolve;
  });

  const renderer = createRendererWindow({
    visibleCols: viewport.cols,
    visibleRows: viewport.rows,
  });
  let projection: ReturnType<typeof createAnsiProjection>;
  let parser: LocalInputParser;

  function recordFailure(exitCode: number, message?: string) {
    if (!terminalFailure) {
      terminalFailure = message === undefined
        ? { exitCode }
        : { exitCode, message };
    }
  }

  function recordInputFailure(failure: InputFailure) {
    if (!inputFailure) {
      inputFailure = failure;
    }
  }

  function resolveIdleWaiters(value: boolean) {
    for (const waiter of [...idleWaiters]) {
      idleWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  }

  function currentGeneration() {
    if (!openedChannelId) return null;
    generation ??= [
      binding.server.daemonHostId,
      binding.session.backend,
      binding.session.stableId,
      openedChannelId,
    ].join(':');
    return generation;
  }

  function clearResizeTimer() {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    pendingResize = null;
  }

  function clearRuntimeTimers() {
    if (authTimer) {
      clearInterval(authTimer);
      authTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    clearResizeTimer();
    releaseOutputDrainWaiter();
    resolveIdleWaiters(false);
  }

  function detachProcessListeners() {
    for (const entry of processListeners.splice(0)) {
      process.removeListener(entry.event, entry.listener);
    }
    if (input.listenerCount('SIGWINCH') === 0) {
      // Keep this branch side-effect free for injected streams.
    }
  }

  function detachInputListeners() {
    input.removeListener('data', onInputData);
    input.removeListener('end', onInputEnd);
    input.removeListener('error', onInputError);
  }

  function detachOutputListeners() {
    output.removeListener('resize', onViewportResize);
    output.removeListener('error', onOutputError);
  }

  function finishTerminal(cleanup: TerminalCleanupResult) {
    let exitCode = terminalFailure?.exitCode ?? 0;
    let message = terminalFailure?.message;

    if (inputFailure) {
      if (exitCode === 0) exitCode = 1;
      message = inputFailure.kind === 'uncertain'
        ? [
          '部分输入可能已被远端接受，结果未确认。',
          '已停止后续输入并断开。请检查远端状态后重连。',
          `原因：${inputFailure.code}`,
        ].join('')
        : inputFailure.message || `输入未被接受（${inputFailure.code}）。`;
    }

    if (cleanup.kind === 'failed') {
      const stages = [...new Set(cleanup.cleanupErrors.map((error) => error.stage))];
      if (exitCode === 0) exitCode = 1;
      message ??= `本地终端恢复失败（${stages.join(',') || 'cleanup'}）。`;
    }

    resolveTerminal(message === undefined ? { exitCode } : { exitCode, message });
  }

  async function requestCleanup(cause: TerminalCleanupCause) {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;
    acceptingInput = false;
    openAbortController.abort(cause);
    try {
      input.pause();
    } catch {
      // Input teardown continues even if the stream is already gone.
    }
    const cleanup = await lifecycle.cleanup(cause);
    finishTerminal(cleanup);
  }

  function requestFailure(cause: TerminalCleanupCause, stage: string, error: unknown) {
    recordFailure(1, failureMessage(stage, error));
    void requestCleanup(cause);
  }

  function handleOutputFailure(error: unknown) {
    if (hasEpipeCode(error)) {
      recordFailure(1, '终端输出管道已关闭（EPIPE）。');
      void requestCleanup({ kind: 'epipe', error });
      return;
    }
    requestFailure({ kind: 'network-error', error }, 'output', error);
  }

  projection = createAnsiProjection({
    write(data) {
      try {
        return output.write(data);
      } catch (error) {
        handleOutputFailure(error);
        return false;
      }
    },
  });

  const mirror = createMirrorConsumer({
    visibleCols: viewport.cols,
    visibleRows: viewport.rows,
    sendRequest(message) {
      if (!channel || channelClosed || cleanupStarted) return false;
      try {
        channel.send(message);
        return true;
      } catch (error) {
        requestFailure({ kind: 'network-error', error }, 'connection', error);
        return false;
      }
    },
    onCommit(event: MirrorCommitEvent) {
      hasBodyCommitted = true;
      const rendererSnapshot = renderer.commit(event.snapshot);
      const projectionResult = projection.commit(rendererSnapshot);
      void resumeProjectionAfterBackpressure(projectionResult);
      if (openedChannelId) {
        mirror.setVisibleDemand(openedChannelId, rendererSnapshot.visibleDemand);
      }
    },
  });

  const lifecycle = createTerminalLifecycle({
    tty: {
      get isRaw() {
        return Boolean(input.isRaw);
      },
      setRawMode(value) {
        input.setRawMode(value);
      },
    },
    output: {
      write(value) {
        return output.write(value);
      },
    },
    hooks: {
      stopInput() {
        acceptingInput = false;
        clearRuntimeTimers();
        detachInputListeners();
        detachOutputListeners();
        detachProcessListeners();
        parser.discardPending();
      },
      settleInput() {
        reliableQueue?.close();
      },
      releaseConnection() {
        try {
          channel?.close('client_close');
        } catch {
          // Local transport release continues.
        }
        try {
          connection.close('client_close');
        } finally {
          eventUnsubscribe?.();
          eventUnsubscribe = null;
        }
      },
      restoreProjection() {
        return projection.restore();
      },
    },
  });

  parser = createLocalInputParser({
    onIntents(intents) {
      enqueueInputIntents(intents);
    },
  });

  async function readCurrentLoginId() {
    try {
      return (await readStoredCliAuth(store))?.loginId;
    } catch {
      return undefined;
    }
  }

  function invalidateLogin() {
    recordFailure(1, 'CLI 登录态已失效，请重新运行 zterm login。');
    void requestCleanup({ kind: 'network-error' });
  }

  async function verifyLogin() {
    if (cleanupStarted || !acceptingInput) return false;
    const currentLoginId = await readCurrentLoginId();
    if (cleanupStarted) return false;
    if (currentLoginId !== initialLoginId) {
      invalidateLogin();
      return false;
    }
    return true;
  }

  function publishRendererSnapshot(snapshot: RendererSnapshot) {
    if (hasBodyCommitted) {
      const projectionResult = projection.commit(snapshot);
      void resumeProjectionAfterBackpressure(projectionResult);
    }
    if (openedChannelId) {
      mirror.setVisibleDemand(openedChannelId, snapshot.visibleDemand);
    }
  }

  function runLocalCommand(command: Extract<LocalInputIntent, { kind: 'local-command' }>['command']) {
    if (command === 'close') {
      void requestCleanup({ kind: 'normal' });
      return;
    }
    let snapshot: RendererSnapshot;
    if (command === 'scroll-up') snapshot = renderer.scrollLines(-1);
    else if (command === 'scroll-down') snapshot = renderer.scrollLines(1);
    else if (command === 'page-up') snapshot = renderer.scrollPages(-1);
    else if (command === 'page-down') snapshot = renderer.scrollPages(1);
    else if (command === 'pan-left') snapshot = renderer.panColumns(-1);
    else if (command === 'pan-right') snapshot = renderer.panColumns(1);
    else snapshot = renderer.follow();
    publishRendererSnapshot(snapshot);
  }

  async function processIntent(intent: LocalInputIntent) {
    if (cleanupStarted) return;
    if (intent.kind === 'local-command') {
      runLocalCommand(intent.command);
      return;
    }
    if (!(await verifyLogin())) return;
    if (cleanupStarted || !reliableQueue) return;

    const rendererSnapshot = renderer.noteRemoteInput();
    publishRendererSnapshot(rendererSnapshot);
    const enqueued = reliableQueue.enqueueText(intent.data);
    if (enqueued.enqueued === 0 && reliableQueue.snapshot().closed) {
      throw codedError('input_queue_closed');
    }
  }

  let inputChain: Promise<void> = Promise.resolve();

  function enqueueInputIntents(intents: readonly LocalInputIntent[]) {
    for (const intent of intents) {
      inputChain = inputChain
        .then(() => processIntent(intent))
        .catch((error: unknown) => {
          const code = safeErrorCode(error);
          recordInputFailure({
            kind: 'rejected',
            code,
            message: `输入未被接受（${code}）。`,
          });
          acceptingInput = false;
          return requestCleanup({ kind: 'input-failure', error });
        });
    }
  }

  function onInputData(value: string | Uint8Array) {
    if (!acceptingInput || cleanupStarted) return;
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const parsed = parser.feed(bytes);
    enqueueInputIntents(parsed.intents);
    if (parsed.kind === 'failed') {
      acceptingInput = false;
      recordFailure(1, failureMessage('input', parsed.error));
      const chain = inputChain;
      void chain.then(() => requestCleanup({
        kind: 'input-failure',
        error: parsed.error,
      }));
    }
  }

  function waitForQueueIdle(timeoutMs: number) {
    if (reliableQueue?.snapshot().activeDepth === 0) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: IdleWaiter = {
        resolve,
        timer: setTimeout(() => {
          idleWaiters.delete(waiter);
          resolve(false);
        }, timeoutMs),
      };
      timerUnref(waiter.timer);
      idleWaiters.add(waiter);
    });
  }

  async function finishInput(chain: Promise<void>, parserFailed: boolean) {
    await chain;
    if (cleanupStarted || !reliableQueue) return;
    if (parserFailed) {
      await requestCleanup({
        kind: 'input-failure',
        error: codedError('input_encoding_invalid'),
      });
      return;
    }
    if (reliableQueue.snapshot().activeDepth === 0) {
      await requestCleanup({ kind: 'normal' });
      return;
    }
    const drained = await waitForQueueIdle(EOF_DRAIN_TIMEOUT_MS);
    if (cleanupStarted) return;
    if (drained) {
      await requestCleanup({ kind: 'normal' });
      return;
    }
    recordInputFailure({
      kind: 'uncertain',
      code: 'input_drain_timeout',
    });
    reliableQueue.close();
    await requestCleanup({
      kind: 'input-failure',
      error: codedError('input_drain_timeout'),
    });
  }

  function onInputEnd() {
    if (!acceptingInput || cleanupStarted) return;
    input.removeListener('data', onInputData);
    const parsed = parser.finish();
    enqueueInputIntents(parsed.intents);
    const failed = parsed.kind === 'failed';
    if (failed) {
      recordFailure(1, failureMessage('input', parsed.error));
    }
    void finishInput(inputChain, failed);
  }

  function onInputError(error: unknown) {
    requestFailure({ kind: 'input-failure', error }, 'input', error);
  }

  function waitForOutputDrain() {
    if (drainWaiter) return drainWaiter.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    const listener = () => {
      if (!drainWaiter) return;
      const waiter = drainWaiter;
      drainWaiter = null;
      output.removeListener('drain', listener);
      waiter.resolve();
    };
    drainWaiter = { promise, resolve, listener };
    output.once('drain', listener);
    return promise;
  }

  function releaseOutputDrainWaiter() {
    if (!drainWaiter) return;
    const waiter = drainWaiter;
    drainWaiter = null;
    output.removeListener('drain', waiter.listener);
    waiter.resolve();
  }

  async function resumeProjectionAfterBackpressure(result: AnsiProjectionCommit) {
    let current = result;
    while (current.blocked && !cleanupStarted) {
      await waitForOutputDrain();
      if (cleanupStarted) return;
      current = await projection.resume();
    }
  }

  function onOutputError(error: unknown) {
    handleOutputFailure(error);
  }

  function flushResize() {
    resizeTimer = null;
    const next = pendingResize;
    pendingResize = null;
    if (
      !next
      || binding.widthMode !== 'adaptive-phone'
      || !channel
      || channelClosed
      || cleanupStarted
    ) {
      return;
    }
    try {
      channel.send({
        type: 'resize',
        payload: {
          cols: next.cols,
          rows: next.rows,
          widthMode: 'adaptive-phone',
        },
      });
    } catch (error) {
      requestFailure({ kind: 'network-error', error }, 'connection', error);
    }
  }

  function scheduleResize(next: Viewport) {
    pendingResize = { ...next };
    if (resizeTimer) return;
    resizeTimer = setTimeout(flushResize, RESIZE_DEBOUNCE_MS);
    timerUnref(resizeTimer);
  }

  function onViewportResize() {
    if (cleanupStarted) return;
    const nextViewport = {
      cols: positiveDimension(output.columns, viewport.cols),
      rows: positiveDimension(output.rows, viewport.rows),
    };
    const resizePlan = resolveTerminalResizeCommitPlan({
      sessionId: openedChannelId,
      widthMode: binding.widthMode,
      previousViewport,
      nextViewport: {
        ...nextViewport,
        resolvedRowHeight: '',
        resolvedCellWidthPx: 0,
      },
    });
    viewport = nextViewport;
    previousViewport = { ...nextViewport };
    const rendererSnapshot = renderer.setViewport({
      visibleCols: viewport.cols,
      visibleRows: viewport.rows,
    });
    publishRendererSnapshot(rendererSnapshot);
    if (resizePlan.action === 'emit-resize') {
      scheduleResize(resizePlan.viewport);
    }
  }

  function sendBodySubscription() {
    if (!channel || channelClosed || cleanupStarted) return;
    try {
      channel.send({
        type: 'body-subscription',
        payload: {
          version: 1,
          subscribed: true,
          ...(binding.widthMode === 'adaptive-phone'
            ? {
                cols: viewport.cols,
                rows: viewport.rows,
                widthMode: 'adaptive-phone' as const,
              }
            : {}),
        },
      });
    } catch (error) {
      requestFailure({ kind: 'network-error', error }, 'connection', error);
    }
  }

  function onConnectionEvent(event: SessionConnectionEvent) {
    if (cleanupStarted) return;
    if (event.type === 'channel-opened') {
      if (
        event.sessionName !== binding.session.name
        || event.stableId !== binding.session.stableId
        || openedChannelId
      ) {
        return;
      }
      openedChannelId = event.channelId;
      currentGeneration();
      mirror.registerSession(event.channelId, {
        cols: viewport.cols,
        rows: viewport.rows,
      });
      return;
    }
    if (event.type === 'channel-message') {
      if (event.channelId !== openedChannelId) return;
      if (event.message.type !== 'input-ack') {
        mirror.handleMessage(event.channelId, event.message);
      }
      return;
    }
    if (event.type === 'input-ack') {
      if (event.channelId !== openedChannelId || !reliableQueue) return;
      reliableQueue.handleAck(event.payload, {
        channel: event.channelId,
        generation: currentGeneration(),
      });
      return;
    }
    if (event.type === 'channel-closed') {
      if (event.channelId !== openedChannelId) return;
      channelClosed = true;
      const error = codedError(event.code || 'channel_closed');
      requestFailure({ kind: 'network-error', error }, 'connection', error);
      return;
    }
    if (event.type === 'closed') {
      const error = codedError('connection_closed');
      requestFailure({ kind: 'network-error', error }, 'connection', error);
      return;
    }
    if (event.type === 'error') {
      requestFailure({ kind: 'network-error', error: event.error }, 'connection', event.error);
    }
  }

  function onSettled(settlement: ReliableInputSettlement) {
    if (settlement.outcome === 'uncertain' || settlement.outcome === 'rejected') {
      const failure: ReliableInputFailure | undefined = settlement.error;
      recordInputFailure({
        kind: settlement.outcome,
        code: failure?.code || 'input_unconfirmed',
        ...(settlement.outcome === 'rejected'
          ? { message: `输入未被接受（${failure?.code || 'input_unconfirmed'}）。` }
          : {}),
      });
      if (!cleanupStarted) {
        void requestCleanup({ kind: 'input-failure' });
      }
    }
    if (reliableQueue?.snapshot().activeDepth === 0) {
      resolveIdleWaiters(true);
    }
  }

  function onQueueEvent(event: ReliableInputRuntimeEvent) {
    if (event.kind === 'idle') {
      resolveIdleWaiters(true);
    }
  }

  function readTransport(): ReliableInputTransportSnapshot {
    const channelId = openedChannelId;
    const current = currentGeneration();
    if (!channel || !channelId || !current || channelClosed || cleanupStarted) {
      return {
        available: false,
        ready: false,
        backpressured: false,
        channel: channelId,
        generation: current,
        closed: true,
      };
    }
    return {
      available: true,
      ready: true,
      backpressured: false,
      channel: channelId,
      generation: current,
    };
  }

  reliableQueue = createReliableInputQueue({
    policy: cliNoReplayPolicy,
    readTransport,
    send(item) {
      if (!channel || channelClosed || cleanupStarted) {
        throw codedError('input_transport_unavailable');
      }
      const payload: TerminalReliableInputPayload = {
        version: 1,
        seq: item.seq,
        data: item.data,
        sentAt: item.sentAt,
        attempt: item.attempt,
      };
      channel.send({ type: 'input', payload });
    },
    onSettled,
    onEvent: onQueueEvent,
  });

  const started = await lifecycle.start();
  if (started.kind !== 'ok') {
    return {
      exitCode: 1,
      message: `终端初始化失败（${started.error.stage}）。`,
    };
  }

  output.on('resize', onViewportResize);
  output.on('error', onOutputError);
  input.on('data', onInputData);
  input.on('end', onInputEnd);
  input.on('error', onInputError);

  for (const inputSignal of INPUT_SIGNALS) {
    const listener = () => {
      openAbortController.abort(inputSignal);
      recordFailure(signalExitCode(inputSignal));
      void requestCleanup({ kind: 'signal', signal: inputSignal });
    };
    processListeners.push({ event: inputSignal, listener });
    process.on(inputSignal, listener);
  }
  const resizeSignalListener = () => onViewportResize();
  processListeners.push({ event: 'SIGWINCH', listener: resizeSignalListener });
  process.on('SIGWINCH', resizeSignalListener);

  const abortListener = () => {
    openAbortController.abort(signal?.reason);
    recordFailure(1, '终端会话已取消。');
    void requestCleanup({ kind: 'input-failure', error: signal?.reason });
  };
  signal?.addEventListener('abort', abortListener, { once: true });
  if (signal?.aborted) abortListener();
  if (cleanupStarted) {
    signal?.removeEventListener('abort', abortListener);
    return await terminalResult;
  }

  try {
    output.write(
      '本地命令：Ctrl+] q 断开；Ctrl+] Ctrl+] 发送字面前缀；'
      + 'k/j 滚动，u/d 翻页，h/l 横移，f 跟随\r\n',
    );
  } catch (error) {
    handleOutputFailure(error);
  }
  if (cleanupStarted) {
    signal?.removeEventListener('abort', abortListener);
    return await terminalResult;
  }

  eventUnsubscribe = connection.onEvent(onConnectionEvent);

  try {
    const openedChannel = await connection.openExisting({
      sessionName: binding.session.name,
      backend: binding.session.backend as 'tmux' | 'herdr',
      stableId: binding.session.stableId,
      ...(binding.widthMode === 'adaptive-phone'
        ? { cols: viewport.cols, widthMode: binding.widthMode }
        : { widthMode: binding.widthMode }),
      bodySubscribed: true,
    }, openAbortController.signal);
    if (cleanupStarted) {
      try {
        openedChannel.close('client_close');
      } catch {
        // The connection owner already completed release.
      }
      signal?.removeEventListener('abort', abortListener);
      return await terminalResult;
    }
    channel = openedChannel;
  } catch (error) {
    if (!cleanupStarted) {
      requestFailure(
        { kind: 'network-error', error },
        'open',
        error,
      );
    }
    signal?.removeEventListener('abort', abortListener);
    return await terminalResult;
  }

  signal?.removeEventListener('abort', abortListener);

  openedChannelId ??= channel.id;
  currentGeneration();
  if (!mirror.snapshot(channel.id)) {
    mirror.registerSession(channel.id, {
      cols: viewport.cols,
      rows: viewport.rows,
    });
  }
  const initialRenderer = renderer.setViewport({
    visibleCols: viewport.cols,
    visibleRows: viewport.rows,
  });
  mirror.setVisibleDemand(channel.id, initialRenderer.visibleDemand);
  sendBodySubscription();

  heartbeatTimer = setInterval(sendBodySubscription, BODY_SUBSCRIPTION_HEARTBEAT_MS);
  timerUnref(heartbeatTimer);
  authTimer = setInterval(() => {
    if (cleanupStarted) return;
    void readCurrentLoginId().then((currentLoginId) => {
      if (cleanupStarted) return;
      if (currentLoginId !== initialLoginId) {
        invalidateLogin();
      }
    });
  }, AUTH_MONITOR_INTERVAL_MS);
  timerUnref(authTimer);

  return await terminalResult;
}
