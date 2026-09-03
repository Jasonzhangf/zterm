import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  RemoteWindowInputEventPayload,
  RemoteWindowCanvasLayoutV1,
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
  return [
    {
      streamId: options.streamId,
      targetId: options.targetId,
      event: {
        kind: 'key',
        phase: 'down',
        key: 'v',
        code: 'KeyV',
        metaKey: true,
      },
    },
    {
      streamId: options.streamId,
      targetId: options.targetId,
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
    delivery?: { lane: 'reliable' | 'continuous'; maxAgeMs?: number };
  },
) => Promise<void>;

export interface RemoteWindowInputConfig {
  daemonReceivedAtMs: number;
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
  send: (
    config: RemoteWindowInputConfig,
    delivery?: { lane: 'reliable' | 'continuous'; maxAgeMs?: number },
  ) => Promise<void>;
  dispose: () => void;
}

type RemoteWindowInputHelperChildProcess = ChildProcessWithoutNullStreams & {
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};

interface PendingRemoteWindowInputHelperRequest {
  config: RemoteWindowInputConfig;
  delivery: { lane: 'reliable' | 'continuous'; maxAgeMs?: number };
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  pairGraceTimer: ReturnType<typeof setTimeout> | null;
  pairGraceExpired: boolean;
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

export function shouldCoalesceRemoteWindowQueuedFocusBeforeInput(
  focusConfig: RemoteWindowInputConfig,
  queuedConfig: RemoteWindowInputConfig,
) {
  return isRemoteWindowFocusInputConfig(focusConfig)
    && (isRemoteWindowFocusInputConfig(queuedConfig) || isRemoteWindowRealInputConfig(queuedConfig))
    && remoteWindowInputConfigsShareTarget(focusConfig, queuedConfig);
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
    if (request.delivery.lane !== 'continuous') {
      return false;
    }
    if (isRemoteWindowInputConfigStale(
      request.config,
      Date.now(),
      request.delivery.maxAgeMs ?? resolveRemoteWindowInputConfigStaleMs(request.config),
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

  const startChild = () => {
    if (child && !child.killed) {
      return child;
    }
    stderrBuffer = '';
    stdoutBuffer = '';
    const createProcess = options.processFactory || ((command, args, spawnOptions) => (
      spawn(command, args, spawnOptions) as RemoteWindowInputHelperChildProcess
    ));
    const currentChild = createProcess(options.swiftBinary, ['-swift-version', '5', '-e', MACOS_REMOTE_WINDOW_INPUT_SWIFT], {
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

  return {
    warm() {
      return waitUntilReady();
    },
    send(config, delivery = { lane: 'reliable' }) {
      if (disposed) {
        return Promise.reject(new Error('remote window input helper is disposed'));
      }
      return new Promise<void>((resolve, reject) => {
        const request = {
          config,
          delivery,
          resolve,
          reject,
          timeout: null,
          pairGraceTimer: null,
          pairGraceExpired: false,
        } satisfies PendingRemoteWindowInputHelperRequest;
        if (delivery.lane === 'continuous') {
          // Continuous motion is latest-wins: never let stale gesture samples
          // accumulate behind the helper process or a reliable release.
          for (let index = queue.length - 1; index >= 0; index -= 1) {
            const queued = queue[index];
            if (
              queued?.delivery.lane === 'continuous'
              && remoteWindowInputConfigsShareTarget(queued.config, config)
              && queued.config.event.kind === config.event.kind
            ) {
              queue.splice(index, 1);
              resolveRequest(queued);
            }
          }
          queue.push(request);
        } else {
          // Reliable down/up/cancel must pass queued motion so release cannot
          // be delayed by a stale continuous sample.
          const firstContinuousIndex = queue.findIndex((queued) => queued.delivery.lane === 'continuous');
          if (firstContinuousIndex >= 0) {
            queue.splice(firstContinuousIndex, 0, request);
          } else {
            queue.push(request);
          }
        }
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

export function mapRemoteWindowInputToCompositeTarget(
  event: RemoteWindowInputEventPayload['event'],
  target: RemoteWindowStreamTargetManifest,
  layout: RemoteWindowCanvasLayoutV1 | null,
): RemoteWindowInputEventPayload['event'] {
  if (!target.compositeWindows || target.compositeWindows.length === 0) {
    return event;
  }
  if (event.kind !== 'pointer' && event.kind !== 'click' && event.kind !== 'scroll' && event.kind !== 'gesture') {
    return event;
  }
  if (!layout) {
    return event;
  }
  const mainCrop = target.videoTarget.cropRectTopLeftPx ?? target.videoTarget.windowBoundsTopLeftPx;
  // client 的 x/y = 画布左上（主窗口 crop 左上）+ normalized × 画布尺寸 → 画布内坐标
  const anchorX = event.kind === 'gesture' ? event.startX : event.x;
  const anchorY = event.kind === 'gesture' ? event.startY : event.y;
  const canvasX = anchorX - mainCrop.x;
  const canvasY = anchorY - mainCrop.y;
  const hit = layout.windows.find((window) => (
    canvasX >= window.canvasRectPx.x
    && canvasX < window.canvasRectPx.x + window.canvasRectPx.width
    && canvasY >= window.canvasRectPx.y
    && canvasY < window.canvasRectPx.y + window.canvasRectPx.height
  ));
  if (!hit) {
    throw new Error('remote window canvas input is outside the published layout');
  }
  const windowSlot = hit;
  const sourceScaleX = windowSlot.sourceRectTopLeftPx.width / windowSlot.canvasRectPx.width;
  const sourceScaleY = windowSlot.sourceRectTopLeftPx.height / windowSlot.canvasRectPx.height;
  const mapPoint = (x: number, y: number) => ({
    x: windowSlot.sourceRectTopLeftPx.x
      + ((x - mainCrop.x - windowSlot.canvasRectPx.x) * sourceScaleX),
    y: windowSlot.sourceRectTopLeftPx.y
      + ((y - mainCrop.y - windowSlot.canvasRectPx.y) * sourceScaleY),
  });
  const mappedEnd = mapPoint(event.x, event.y);
  if (event.kind === 'gesture') {
    const mappedStart = mapPoint(event.startX, event.startY);
    return {
      ...event,
      startX: mappedStart.x,
      startY: mappedStart.y,
      x: mappedEnd.x,
      y: mappedEnd.y,
    };
  }
  return {
    ...event,
    x: mappedEnd.x,
    y: mappedEnd.y,
  };
}

export function buildRemoteWindowInputConfig(
  payload: RemoteWindowInputEventPayload,
  target: RemoteWindowStreamTargetManifest,
  options: { daemonReceivedAtMs?: number; canvasLayout?: RemoteWindowCanvasLayoutV1 | null } = {},
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
    event: mapRemoteWindowInputToCompositeTarget(payload.event, target, options.canvasLayout ?? null),
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
