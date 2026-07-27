import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  RemoteWindowInputEventPayload,
  RemoteWindowStreamRect,
  RemoteWindowStreamTargetManifest,
} from '@zterm/shared/protocol';
import { MACOS_REMOTE_WINDOW_INPUT_SWIFT } from './remote-window-scripts';
import { REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS } from './remote-window-support';

const REMOTE_WINDOW_INPUT_STALE_MS = 1_000;
const REMOTE_WINDOW_INPUT_FOCUS_TIMEOUT_MS = 3_000;
const REMOTE_WINDOW_INPUT_FOCUS_PAIR_GRACE_MS = 25;
const REMOTE_WINDOW_INPUT_HELPER_READY_TIMEOUT_MS = 15_000;

export function buildRemoteWindowImagePasteInputPayloads(options: {
  requestPrefix: string;
  streamId: string;
  targetId: string;
  now?: () => number;
}): RemoteWindowInputEventPayload[] {
  const now = options.now ?? Date.now;
  return [
    {
      requestId: `${options.requestPrefix}-0`,
      streamId: options.streamId,
      targetId: options.targetId,
      clientSentAt: now(),
      event: {
        kind: 'key',
        phase: 'down',
        key: 'v',
        code: 'KeyV',
        metaKey: true,
      },
    },
    {
      requestId: `${options.requestPrefix}-1`,
      streamId: options.streamId,
      targetId: options.targetId,
      clientSentAt: now(),
      event: {
        kind: 'key',
        phase: 'up',
        key: 'v',
        code: 'KeyV',
        metaKey: true,
      },
    },
  ];
}

export type RemoteWindowInputEventRunner = (
  payload: RemoteWindowInputEventPayload,
  target: RemoteWindowStreamTargetManifest,
  options: {
    swiftBinary: string;
    runTmux: (args: string[]) => { ok: true; stdout: string };
    daemonReceivedAtMs: number;
  },
) => Promise<void>;

export interface RemoteWindowInputConfig {
  daemonReceivedAtMs: number;
  clientSentAt?: number;
  pid: number;
  appBundleId: string;
  focusPolicy: RemoteWindowStreamTargetManifest['focusPolicy'];
  window: {
    windowId: string;
    title: string;
    bounds: RemoteWindowStreamRect;
  };
  event: RemoteWindowInputEventPayload['event'];
}

export interface RemoteWindowInputHelper {
  warm: () => Promise<void>;
  send: (config: RemoteWindowInputConfig) => Promise<void>;
  dispose: () => void;
}

type RemoteWindowInputHelperChildProcess = ChildProcessWithoutNullStreams & {
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};

interface PendingRemoteWindowInputHelperRequest {
  config: RemoteWindowInputConfig;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  pairGraceTimer: ReturnType<typeof setTimeout> | null;
  pairGraceExpired: boolean;
  refreshReceivedAtAfterFocusConfig: RemoteWindowInputConfig | null;
  refreshReceivedAtAfterRealInputConfig: RemoteWindowInputConfig | null;
}

interface PendingRemoteWindowInputHelperWarm {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export function isRemoteWindowFocusInputConfig(config: Pick<RemoteWindowInputConfig, 'event'>) {
  return config.event.kind === 'focus';
}

function isRemoteWindowRealInputConfig(config: Pick<RemoteWindowInputConfig, 'event'>) {
  return config.event.kind !== 'focus'
    && config.event.kind !== 'window-resize';
}

export function resolveRemoteWindowInputHelperTimeoutMs(config: Pick<RemoteWindowInputConfig, 'event'>) {
  return isRemoteWindowFocusInputConfig(config) || isRemoteWindowRealInputConfig(config)
    ? REMOTE_WINDOW_INPUT_FOCUS_TIMEOUT_MS
    : REMOTE_WINDOW_INPUT_STALE_MS;
}

export function resolveRemoteWindowInputConfigStaleMs(config: Pick<RemoteWindowInputConfig, 'event'>) {
  return isRemoteWindowRealInputConfig(config)
    ? REMOTE_WINDOW_INPUT_STALE_MS
    : resolveRemoteWindowInputHelperTimeoutMs(config);
}

function remoteWindowInputConfigsShareTarget(
  lhs: RemoteWindowInputConfig,
  rhs: RemoteWindowInputConfig,
) {
  return lhs.pid === rhs.pid
    && lhs.appBundleId === rhs.appBundleId
    && lhs.focusPolicy === rhs.focusPolicy
    && lhs.window.windowId === rhs.window.windowId;
}

export function shouldRefreshRemoteWindowQueuedInputAfterFocus(
  focusConfig: RemoteWindowInputConfig,
  queuedConfig: RemoteWindowInputConfig,
) {
  return isRemoteWindowFocusInputConfig(focusConfig)
    && !isRemoteWindowFocusInputConfig(queuedConfig)
    && remoteWindowInputConfigsShareTarget(focusConfig, queuedConfig);
}

export function shouldCoalesceRemoteWindowQueuedFocusBeforeInput(
  focusConfig: RemoteWindowInputConfig,
  queuedConfig: RemoteWindowInputConfig,
) {
  return isRemoteWindowFocusInputConfig(focusConfig)
    && (isRemoteWindowFocusInputConfig(queuedConfig) || isRemoteWindowRealInputConfig(queuedConfig))
    && remoteWindowInputConfigsShareTarget(focusConfig, queuedConfig);
}

export function shouldRefreshRemoteWindowQueuedInputAfterRealInput(
  completedConfig: RemoteWindowInputConfig,
  queuedConfig: RemoteWindowInputConfig,
) {
  return isRemoteWindowRealInputConfig(completedConfig)
    && isRemoteWindowRealInputConfig(queuedConfig)
    && remoteWindowInputConfigsShareTarget(completedConfig, queuedConfig);
}

type RemoteWindowInputHelperProcessFactory = (
  command: string,
  args: string[],
  options: { windowsHide: boolean; env: NodeJS.ProcessEnv },
) => RemoteWindowInputHelperChildProcess;

export function createDefaultRemoteWindowInputHelper(options: {
  swiftBinary: string;
  processFactory?: RemoteWindowInputHelperProcessFactory;
}): RemoteWindowInputHelper {
  let child: RemoteWindowInputHelperChildProcess | null = null;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let active: PendingRemoteWindowInputHelperRequest | null = null;
  const queue: PendingRemoteWindowInputHelperRequest[] = [];
  const warmWaiters: PendingRemoteWindowInputHelperWarm[] = [];
  let disposed = false;
  let ready = false;
  let waitingForReadyPump = false;

  const stderrSummary = () => stderrBuffer.trim().slice(-REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS);

  const rejectWarmWaiters = (error: Error) => {
    while (warmWaiters.length > 0) {
      const waiter = warmWaiters.shift();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  };

  const resolveWarmWaiters = () => {
    while (warmWaiters.length > 0) {
      const waiter = warmWaiters.shift();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  };

  const rejectIfStale = (request: PendingRemoteWindowInputHelperRequest) => {
    if (isRemoteWindowInputConfigStale(
      request.config,
      Date.now(),
      resolveRemoteWindowInputConfigStaleMs(request.config),
    )) {
      rejectRequest(request, new Error('remote window input stale'));
      return true;
    }
    return false;
  };

  const rejectRequest = (request: PendingRemoteWindowInputHelperRequest | null, error: Error) => {
    if (!request) {
      return;
    }
    if (request.timeout) {
      clearTimeout(request.timeout);
      request.timeout = null;
    }
    if (request.pairGraceTimer) {
      clearTimeout(request.pairGraceTimer);
      request.pairGraceTimer = null;
    }
    request.reject(error);
  };

  const resolveRequest = (request: PendingRemoteWindowInputHelperRequest) => {
    if (request.timeout) {
      clearTimeout(request.timeout);
      request.timeout = null;
    }
    if (request.pairGraceTimer) {
      clearTimeout(request.pairGraceTimer);
      request.pairGraceTimer = null;
    }
    request.resolve();
  };

  const rejectAll = (error: Error) => {
    rejectRequest(active, error);
    active = null;
    while (queue.length > 0) {
      rejectRequest(queue.shift() || null, error);
    }
  };

  const refreshQueueAfterSuccessfulFocus = (focusConfig: RemoteWindowInputConfig) => {
    if (!isRemoteWindowFocusInputConfig(focusConfig)) {
      return;
    }
    const receivedAtMs = Date.now();
    for (const request of queue) {
      if (
        request.refreshReceivedAtAfterFocusConfig === focusConfig
        && shouldRefreshRemoteWindowQueuedInputAfterFocus(focusConfig, request.config)
      ) {
        request.config.daemonReceivedAtMs = receivedAtMs;
        request.refreshReceivedAtAfterFocusConfig = null;
      }
    }
  };

  const refreshQueueAfterSuccessfulRealInput = (completedConfig: RemoteWindowInputConfig) => {
    if (!isRemoteWindowRealInputConfig(completedConfig)) {
      return;
    }
    const receivedAtMs = Date.now();
    for (const request of queue) {
      if (
        request.refreshReceivedAtAfterRealInputConfig === completedConfig
        && shouldRefreshRemoteWindowQueuedInputAfterRealInput(completedConfig, request.config)
      ) {
        request.config.daemonReceivedAtMs = receivedAtMs;
        request.refreshReceivedAtAfterRealInputConfig = null;
      }
    }
  };

  const startChild = () => {
    if (child && !child.killed) {
      return child;
    }
    stderrBuffer = '';
    stdoutBuffer = '';
    const createProcess = options.processFactory || ((command, args, spawnOptions) => (
      spawn(command, args, spawnOptions) as RemoteWindowInputHelperChildProcess
    ));
    const currentChild = createProcess(options.swiftBinary, ['-e', MACOS_REMOTE_WINDOW_INPUT_SWIFT], {
      windowsHide: true,
      env: process.env,
    });
    child = currentChild;
    ready = false;
    currentChild.stdout.setEncoding('utf8');
    currentChild.stderr.setEncoding('utf8');
    currentChild.stdout.on('data', (chunk) => {
      stdoutBuffer += String(chunk);
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const rawLine = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (rawLine) {
          try {
            const response = JSON.parse(rawLine) as { ok?: unknown; ready?: unknown; error?: unknown };
            if (response.ready === true) {
              ready = true;
              resolveWarmWaiters();
              pump();
              newlineIndex = stdoutBuffer.indexOf('\n');
              continue;
            }
            if (active) {
              const request = active;
              active = null;
              if (request.timeout) {
                clearTimeout(request.timeout);
                request.timeout = null;
              }
              if (response.ok === true) {
                refreshQueueAfterSuccessfulFocus(request.config);
                refreshQueueAfterSuccessfulRealInput(request.config);
                resolveRequest(request);
              } else {
                request.reject(new Error(String(response.error || 'remote window input event failed')));
              }
              pump();
            }
          } catch (error) {
            if (active) {
              const request = active;
              active = null;
              if (request.timeout) {
                clearTimeout(request.timeout);
                request.timeout = null;
              }
              request.reject(error instanceof Error ? error : new Error('remote window input helper returned invalid JSON'));
              pump();
            }
          }
        }
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });
    currentChild.stderr.on('data', (chunk) => {
      stderrBuffer = (stderrBuffer + String(chunk)).slice(-4096);
    });
    currentChild.on('error', (error) => {
      const message = stderrSummary();
      if (child === currentChild) {
        child = null;
        ready = false;
      }
      const wrapped = new Error(message ? `${error.message}\n${message}` : error.message);
      rejectWarmWaiters(wrapped);
      rejectAll(wrapped);
    });
    currentChild.on('exit', (code, signal) => {
      const message = [
        `remote window input helper exited code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        stderrSummary(),
      ].filter(Boolean).join('\n');
      if (child === currentChild) {
        child = null;
        ready = false;
      }
      if (!disposed) {
        const error = new Error(message);
        rejectWarmWaiters(error);
        rejectAll(error);
      }
    });
    return currentChild;
  };

  const waitUntilReady = () => {
    if (disposed) {
      return Promise.reject(new Error('remote window input helper is disposed'));
    }
    const helperProcess = startChild();
    if (ready && child === helperProcess && !helperProcess.killed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: PendingRemoteWindowInputHelperWarm = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = warmWaiters.indexOf(waiter);
          if (index >= 0) {
            warmWaiters.splice(index, 1);
          }
          const message = stderrSummary();
          const error = new Error(message
            ? `remote window input helper did not become ready before timeout: ${message}`
            : 'remote window input helper did not become ready before timeout');
          if (child === helperProcess && !helperProcess.killed) {
            child.kill('SIGTERM');
            child = null;
            ready = false;
          }
          reject(error);
        }, REMOTE_WINDOW_INPUT_HELPER_READY_TIMEOUT_MS),
      };
      warmWaiters.push(waiter);
    });
  };

  const startReadyPump = () => {
    if (waitingForReadyPump) {
      return;
    }
    waitingForReadyPump = true;
    waitUntilReady()
      .then(() => {
        waitingForReadyPump = false;
        pump();
      })
      .catch((error: Error) => {
        waitingForReadyPump = false;
        rejectAll(error);
      });
  };

  const pump = () => {
    if (disposed || active || queue.length === 0) {
      return;
    }
    const nextRequest = queue[0];
    if (
      nextRequest
      && isRemoteWindowFocusInputConfig(nextRequest.config)
    ) {
      const followingRequest = queue[1] || null;
      if (
        followingRequest
        && shouldCoalesceRemoteWindowQueuedFocusBeforeInput(nextRequest.config, followingRequest.config)
      ) {
        queue.shift();
        if (shouldRefreshRemoteWindowQueuedInputAfterFocus(nextRequest.config, followingRequest.config)) {
          followingRequest.config.daemonReceivedAtMs = Date.now();
          followingRequest.refreshReceivedAtAfterFocusConfig = null;
        }
        resolveRequest(nextRequest);
        pump();
        return;
      }
      if (!nextRequest.pairGraceExpired && !nextRequest.pairGraceTimer) {
        nextRequest.pairGraceTimer = setTimeout(() => {
          nextRequest.pairGraceTimer = null;
          nextRequest.pairGraceExpired = true;
          pump();
        }, REMOTE_WINDOW_INPUT_FOCUS_PAIR_GRACE_MS);
      }
      if (!nextRequest.pairGraceExpired) {
        return;
      }
    }
    const request = queue.shift();
    if (!request) {
      return;
    }
    if (rejectIfStale(request)) {
      pump();
      return;
    }
    const helperProcess = startChild();
    if (!ready) {
      queue.unshift(request);
      startReadyPump();
      return;
    }
    active = request;
    request.timeout = setTimeout(() => {
      if (active !== request) {
        return;
      }
      active = null;
      rejectRequest(request, new Error('remote window input helper timed out'));
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
      if (child === helperProcess) {
        child = null;
        ready = false;
      }
      pump();
    }, resolveRemoteWindowInputHelperTimeoutMs(request.config));
    helperProcess.stdin.write(`${JSON.stringify(request.config)}\n`, (error) => {
      if (!error || active !== request) {
        return;
      }
      active = null;
      rejectRequest(request, error);
      pump();
    });
  };

  const findFocusConfigForQueuedInput = (config: RemoteWindowInputConfig) => {
    if (active && shouldRefreshRemoteWindowQueuedInputAfterFocus(active.config, config)) {
      return active.config;
    }
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const queuedConfig = queue[index]!.config;
      if (!remoteWindowInputConfigsShareTarget(queuedConfig, config)) {
        continue;
      }
      return shouldRefreshRemoteWindowQueuedInputAfterFocus(queuedConfig, config)
        ? queuedConfig
        : null;
    }
    return null;
  };

  const findRealInputConfigForQueuedInput = (config: RemoteWindowInputConfig) => {
    if (!isRemoteWindowRealInputConfig(config)) {
      return null;
    }
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const queuedConfig = queue[index]!.config;
      if (!remoteWindowInputConfigsShareTarget(queuedConfig, config)) {
        continue;
      }
      return shouldRefreshRemoteWindowQueuedInputAfterRealInput(queuedConfig, config)
        ? queuedConfig
        : null;
    }
    if (active && shouldRefreshRemoteWindowQueuedInputAfterRealInput(active.config, config)) {
      return active.config;
    }
    return null;
  };

  return {
    warm() {
      return waitUntilReady();
    },
    send(config) {
      if (disposed) {
        return Promise.reject(new Error('remote window input helper is disposed'));
      }
      return new Promise<void>((resolve, reject) => {
        queue.push({
          config,
          resolve,
          reject,
          timeout: null,
          pairGraceTimer: null,
          pairGraceExpired: false,
          refreshReceivedAtAfterFocusConfig: findFocusConfigForQueuedInput(config),
          refreshReceivedAtAfterRealInputConfig: findRealInputConfigForQueuedInput(config),
        });
        pump();
      });
    },
    dispose() {
      disposed = true;
      rejectWarmWaiters(new Error('remote window input helper disposed'));
      rejectAll(new Error('remote window input helper disposed'));
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
      child = null;
      ready = false;
    },
  };
}

export function buildRemoteWindowInputConfig(
  payload: RemoteWindowInputEventPayload,
  target: RemoteWindowStreamTargetManifest,
  options: { daemonReceivedAtMs?: number } = {},
): RemoteWindowInputConfig {
  return {
    daemonReceivedAtMs: Number.isFinite(options.daemonReceivedAtMs)
      ? Number(options.daemonReceivedAtMs)
      : Date.now(),
    pid: target.videoTarget.pid,
    appBundleId: target.videoTarget.appBundleId,
    focusPolicy: target.focusPolicy,
    window: {
      windowId: target.videoTarget.windowId,
      title: target.videoTarget.title,
      bounds: target.videoTarget.windowBoundsTopLeftPx,
    },
    clientSentAt: payload.clientSentAt,
    event: payload.event,
  };
}

export function isRemoteWindowInputConfigStale(
  config: Pick<RemoteWindowInputConfig, 'daemonReceivedAtMs'>,
  nowMs = Date.now(),
  staleMs = REMOTE_WINDOW_INPUT_STALE_MS,
) {
  if (!Number.isFinite(config.daemonReceivedAtMs)) {
    return true;
  }
  return nowMs - Number(config.daemonReceivedAtMs) > staleMs;
}
