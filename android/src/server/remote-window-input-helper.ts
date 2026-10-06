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
const REMOTE_WINDOW_INPUT_QUIESCE_EXIT_MS = 1_500;

/** Native release observation uses the existing helper deadline budget. */
export const REMOTE_WINDOW_INPUT_RELEASE_OBSERVE_MS = REMOTE_WINDOW_INPUT_FOCUS_TIMEOUT_MS - 500;

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
) => Promise<RemoteWindowNativeOperationResult>;

export interface RemoteWindowNativeResizePosition {
  x: number;
  y: number;
}

export interface RemoteWindowNativeResizeSize {
  width: number;
  height: number;
}

/** Typed native operation result for window resize. Non-resize results stay void. */
export interface RemoteWindowNativeResizeOperation {
  kind: 'window-resize';
  position: RemoteWindowNativeResizePosition;
  size: RemoteWindowNativeResizeSize;
}

export type RemoteWindowNativeOperationResult = RemoteWindowNativeResizeOperation | undefined;

export interface RemoteWindowNativeModifierFlags {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Native key carrier produced by the single normalization source. */
export interface RemoteWindowNativeKeyCarrier {
  kind: 'key';
  /** CGKeyCode when the code maps to a physical key; null means Unicode virtualKey 0 carrier. */
  nativeKeyCode: number | null;
  /** Unicode text carrier when nativeKeyCode is null; null for physical keys. */
  nativeKeyText: string | null;
  flags: RemoteWindowNativeModifierFlags;
}

/** Native pointer-button carrier. */
export interface RemoteWindowNativePointerCarrier {
  kind: 'pointer';
  button: string;
  x: number;
  y: number;
}

export type RemoteWindowNativeCarrier = RemoteWindowNativeKeyCarrier | RemoteWindowNativePointerCarrier;

/** Exact key-code mapping used by both key injection and the close injection. */
const REMOTE_WINDOW_NATIVE_KEY_CODES: Readonly<Record<string, number>> = Object.freeze({
  KeyA: 0,
  Enter: 36,
  NumpadEnter: 76,
  Escape: 53,
  Backspace: 51,
  Tab: 48,
  Space: 49,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126,
  KeyV: 9,
  KeyW: 13,
  Delete: 117,
  Home: 115,
  End: 119,
  PageUp: 116,
  PageDown: 121,
});

/**
 * Move the existing key mapping and Unicode virtualKey0 rule into this helper's
 * typed normalization. Swift receives only the normalized native carrier and no
 * longer keeps its duplicate key-code table or selection branches.
 */
export function normalizeRemoteWindowNativeKey(
  event: Extract<RemoteWindowInputEventPayload['event'], { kind: 'key' }>,
): RemoteWindowNativeKeyCarrier {
  const flags: RemoteWindowNativeModifierFlags = {
    shiftKey: event.shiftKey === true,
    altKey: event.altKey === true,
    ctrlKey: event.ctrlKey === true,
    metaKey: event.metaKey === true,
  };
  const code = event.code ?? '';
  const mappedKeyCode = REMOTE_WINDOW_NATIVE_KEY_CODES[code];
  if (typeof mappedKeyCode === 'number') {
    return { kind: 'key', nativeKeyCode: mappedKeyCode, nativeKeyText: null, flags };
  }
  const text = event.text ?? event.key ?? '';
  if (text.length > 0) {
    // Unicode carrier uses virtualKey 0; keyState(0) is the observed physical key.
    return { kind: 'key', nativeKeyCode: null, nativeKeyText: text, flags };
  }
  throw new Error(`remote window key input unsupported: ${code}`);
}

/** Pointer-button carrier from a pointer down/up event. */
export function normalizeRemoteWindowNativePointer(
  event: Extract<RemoteWindowInputEventPayload['event'], { kind: 'pointer' }>,
): RemoteWindowNativePointerCarrier {
  const button = event.button ?? 'left';
  if (typeof event.x !== 'number' || typeof event.y !== 'number') {
    throw new Error('remote window pointer input missing coordinates');
  }
  return { kind: 'pointer', button, x: event.x, y: event.y };
}

/** Stable carrier identity used as the lease-table key. */
export function remoteWindowNativeCarrierKey(carrier: RemoteWindowNativeCarrier): string {
  if (carrier.kind === 'key') {
    // Unicode carriers post through virtualKey 0 and mapped KeyA is code 0.
    // Both share the physical resource identity so the lease table can arbitrate
    // cross-stream collision while preserving the original Unicode text carrier.
    return `key:${carrier.nativeKeyCode ?? 0}`;
  }
  return `pointer:${carrier.button}`;
}

export function isRemoteWindowNativeCarrierReleased(carrier: RemoteWindowNativeCarrier): boolean {
  if (carrier.kind === 'key') {
    return carrier.nativeKeyCode === null && (carrier.nativeKeyText ?? '').length === 0;
  }
  return false;
}

export interface RemoteWindowInputConfig {
  streamId: string;
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
  /**
   * Internal typed native carrier for key events. It is the only native key
   * source the Swift child receives; user input payloads never carry it.
   */
  native?: RemoteWindowNativeKeyCarrier;
  /**
   * Present only on final-holder release requests produced by releaseStream().
   * Swift posts the exact native up and observes combinedSessionState.
   */
  release?: RemoteWindowInputReleaseOperation;
}

export interface RemoteWindowInputReleaseOperation {
  carrierKey: string;
  kind: 'key' | 'pointer';
  nativeKeyCode?: number | null;
  nativeKeyText?: string | null;
  flags?: RemoteWindowNativeModifierFlags;
  button?: string;
  x?: number;
  y?: number;
  /** Combined-session-state keycode to observe after the up (0 for Unicode carriers). */
  observeKeyCode?: number | null;
  observeDeadlineMs?: number;
}

export type RemoteWindowInputStreamReleaseStatus = 'released' | 'failed' | 'unverified';

export interface RemoteWindowInputStreamReleaseResult {
  streamId: string;
  status: RemoteWindowInputStreamReleaseStatus;
  /** Carriers this stream fully released from (final holder). */
  released: string[];
  /** Carriers this stream withdrew from while another stream still held them. */
  sharedReleased: string[];
  /** Carriers still held by this stream because release failed or is unverified. */
  remaining: string[];
  errors: string[];
}

export interface RemoteWindowInputHelper {
  warm: () => Promise<void>;
  send: (
    config: RemoteWindowInputConfig,
    delivery?: { lane: 'reliable' | 'continuous'; maxAgeMs?: number },
  ) => Promise<RemoteWindowNativeOperationResult>;
  releaseStream: (streamId: string) => Promise<RemoteWindowInputStreamReleaseResult>;
  dispose: () => Promise<void>;
  hasLease: (streamId: string) => boolean;
}

type RemoteWindowInputHelperChildProcess = ChildProcessWithoutNullStreams & {
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};

interface PendingRemoteWindowInputHelperRequest {
  config: RemoteWindowInputConfig;
  delivery: { lane: 'reliable' | 'continuous'; maxAgeMs?: number };
  resolve: (result: RemoteWindowNativeOperationResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  pairGraceTimer: ReturnType<typeof setTimeout> | null;
  pairGraceExpired: boolean;
  /** Carrier registered by a reliable down; removed on explicit native not-posted rejection. */
  leaseCarrier?: RemoteWindowNativeCarrier;
}

interface PendingRemoteWindowInputHelperWarm {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function parseRemoteWindowNativeOperationResult(
  response: { operation?: unknown },
): RemoteWindowNativeOperationResult {
  const operation = response.operation;
  if (!operation || typeof operation !== 'object') {
    return undefined;
  }
  const kind = (operation as { kind?: unknown }).kind;
  if (kind !== 'window-resize') {
    return undefined;
  }
  const position = (operation as { position?: unknown }).position;
  const size = (operation as { size?: unknown }).size;
  if (
    !position
    || typeof position !== 'object'
    || !size
    || typeof size !== 'object'
  ) {
    return undefined;
  }
  const pos = position as { x?: unknown; y?: unknown };
  const dim = size as { width?: unknown; height?: unknown };
  if (
    !Number.isFinite(pos.x)
    || !Number.isFinite(pos.y)
    || !Number.isFinite(dim.width)
    || !Number.isFinite(dim.height)
  ) {
    return undefined;
  }
  return {
    kind: 'window-resize',
    position: { x: pos.x as number, y: pos.y as number },
    size: { width: dim.width as number, height: dim.height as number },
  };
}

interface RemoteWindowInputLeaseEntry {
  holders: Map<string, RemoteWindowInputLeaseHolderState>;
}

/** Exact release parameters recorded for one stream holder. */
interface RemoteWindowInputLeaseHolderState {
  carrier: RemoteWindowNativeCarrier;
  /** Input target/context attached to this holder for exact release bookkeeping. */
  sourceTarget: Pick<RemoteWindowInputConfig, 'pid' | 'appBundleId' | 'focusPolicy' | 'window'>;
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

function remoteWindowInputDownCarrier(config: RemoteWindowInputConfig): RemoteWindowNativeCarrier | null {
  if (config.event.kind === 'key' && config.event.phase === 'down' && config.native) {
    return config.native;
  }
  if (config.event.kind === 'pointer' && config.event.phase === 'down') {
    return normalizeRemoteWindowNativePointer(config.event);
  }
  return null;
}

function remoteWindowInputUpCarrier(config: RemoteWindowInputConfig): RemoteWindowNativeCarrier | null {
  if (config.event.kind === 'key' && config.event.phase === 'up' && config.native) {
    return config.native;
  }
  if (config.event.kind === 'pointer' && config.event.phase === 'up') {
    return normalizeRemoteWindowNativePointer(config.event);
  }
  return null;
}

function buildRemoteWindowReleaseOperation(
  carrier: RemoteWindowNativeCarrier,
  observeDeadlineMs: number,
): RemoteWindowInputReleaseOperation {
  if (carrier.kind === 'key') {
    return {
      carrierKey: remoteWindowNativeCarrierKey(carrier),
      kind: 'key',
      nativeKeyCode: carrier.nativeKeyCode,
      nativeKeyText: carrier.nativeKeyText,
      flags: carrier.flags,
      observeKeyCode: carrier.nativeKeyCode ?? 0,
      observeDeadlineMs,
    };
  }
  return {
    carrierKey: remoteWindowNativeCarrierKey(carrier),
    kind: 'pointer',
    button: carrier.button,
    x: carrier.x,
    y: carrier.y,
    observeDeadlineMs,
  };
}

type RemoteWindowInputHelperQueueItem =
  | { kind: 'input'; request: PendingRemoteWindowInputHelperRequest }
  | { kind: 'release'; request: PendingRemoteWindowInputHelperRelease };

interface PendingRemoteWindowInputHelperRelease {
  streamId: string;
  carrierKey: string;
  operation: RemoteWindowInputReleaseOperation;
  /** Clear the holder only when the native release is observed as released. */
  clearOnReleased: boolean;
  settle: (result: { status: RemoteWindowInputStreamReleaseStatus; error?: string }) => void;
  timeout: ReturnType<typeof setTimeout> | null;
}

function resolveRemoteWindowNativeCarrier(
  event: RemoteWindowInputEventPayload['event'],
): RemoteWindowNativeKeyCarrier | null {
  if (event.kind === 'key') {
    return normalizeRemoteWindowNativeKey(event);
  }
  if (event.kind === 'close-window') {
    return {
      kind: 'key',
      nativeKeyCode: REMOTE_WINDOW_NATIVE_KEY_CODES.KeyW as number,
      nativeKeyText: null,
      flags: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: true },
    };
  }
  return null;
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
  const event = mapRemoteWindowInputToCompositeTarget(payload.event, target, options.canvasLayout ?? null);
  const native = resolveRemoteWindowNativeCarrier(event);
  return {
    streamId: payload.streamId,
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
    event,
    ...(native ? { native } : {}),
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

export function createDefaultRemoteWindowInputHelper(options: {
  swiftBinary: string;
  processFactory?: RemoteWindowInputHelperProcessFactory;
}): RemoteWindowInputHelper {
  let child: RemoteWindowInputHelperChildProcess | null = null;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let active: RemoteWindowInputHelperQueueItem | null = null;
  const queue: RemoteWindowInputHelperQueueItem[] = [];
  const warmWaiters: PendingRemoteWindowInputHelperWarm[] = [];
  const leases = new Map<string, RemoteWindowInputLeaseEntry>();
  let disposed = false;
  let ready = false;
  let waitingForReadyPump = false;
  let quiescing: Promise<void> | null = null;
  let expectedExit: RemoteWindowInputHelperChildProcess | null = null;
  let activeSettlement: Promise<void> | null = null;
  let resolveActiveSettlement: (() => void) | null = null;
  let disposePromise: Promise<void> | null = null;

  const stderrSummary = () => stderrBuffer.trim().slice(-REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS);

  const settleActive = () => {
    const resolve = resolveActiveSettlement;
    resolveActiveSettlement = null;
    activeSettlement = null;
    if (resolve) {
      resolve();
    }
  };

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

  const registerLeaseHolder = (
    carrier: RemoteWindowNativeCarrier,
    streamId: string,
    config: RemoteWindowInputConfig,
  ) => {
    const key = remoteWindowNativeCarrierKey(carrier);
    let entry = leases.get(key);
    if (!entry) {
      entry = { holders: new Map() };
      leases.set(key, entry);
    }
    entry.holders.set(streamId, {
      carrier,
      sourceTarget: {
        pid: config.pid,
        appBundleId: config.appBundleId,
        focusPolicy: config.focusPolicy,
        window: config.window,
      },
    });
  };

  const clearLeaseHolder = (carrierKey: string, streamId: string) => {
    const entry = leases.get(carrierKey);
    if (!entry) {
      return;
    }
    entry.holders.delete(streamId);
    if (entry.holders.size === 0) {
      leases.delete(carrierKey);
    }
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

  const resolveRequest = (request: PendingRemoteWindowInputHelperRequest, result?: RemoteWindowNativeOperationResult) => {
    if (request.timeout) {
      clearTimeout(request.timeout);
      request.timeout = null;
    }
    if (request.pairGraceTimer) {
      clearTimeout(request.pairGraceTimer);
      request.pairGraceTimer = null;
    }
    request.resolve(result);
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

  const settleRelease = (
    request: PendingRemoteWindowInputHelperRelease,
    result: { status: RemoteWindowInputStreamReleaseStatus; error?: string },
  ) => {
    if (request.timeout) {
      clearTimeout(request.timeout);
      request.timeout = null;
    }
    if (result.status === 'released' && request.clearOnReleased) {
      clearLeaseHolder(request.carrierKey, request.streamId);
    }
    request.settle(result);
  };

  const failItem = (item: RemoteWindowInputHelperQueueItem, error: Error) => {
    if (item.kind === 'input') {
      rejectRequest(item.request, error);
    } else {
      settleRelease(item.request, { status: 'failed', error: error.message });
    }
  };

  const rejectAll = (error: Error) => {
    if (active) {
      failItem(active, error);
      active = null;
      settleActive();
    }
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) {
        failItem(item, error);
      }
    }
  };

  const awaitChildQuiescence = (proc: RemoteWindowInputHelperChildProcess): Promise<void> => (
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // best-effort bounded quiescence of the specific child only
        }
        finish();
      }, REMOTE_WINDOW_INPUT_QUIESCE_EXIT_MS);
      proc.once('exit', finish);
      proc.once('error', finish);
    })
  );

  const killChildAndQuiesce = () => {
    const dying = child;
    if (!dying) {
      return;
    }
    expectedExit = dying;
    if (!dying.killed) {
      try {
        dying.kill('SIGTERM');
      } catch {
        // best-effort bounded quiescence of the specific child only
      }
    }
    if (child === dying) {
      child = null;
      ready = false;
    }
    if (!quiescing) {
      const gate = awaitChildQuiescence(dying);
      quiescing = gate;
      gate.then(() => {
        quiescing = null;
        pump();
      });
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
      if (child !== currentChild) {
        return;
      }
      stdoutBuffer += String(chunk);
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const rawLine = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (rawLine) {
          try {
            const response = JSON.parse(rawLine) as {
              ok?: unknown;
              ready?: unknown;
              error?: unknown;
              release?: { status?: unknown; error?: unknown };
              operation?: unknown;
            };
            if (response.ready === true) {
              ready = true;
              resolveWarmWaiters();
              pump();
              newlineIndex = stdoutBuffer.indexOf('\n');
              continue;
            }
            if (active) {
              const item = active;
              active = null;
              settleActive();
              if (item.kind === 'input') {
                const request = item.request;
                rejectOrResolveInput(request, response);
              } else {
                const request = item.request;
                const release = response.release;
                if (
                  response.ok === true
                  && release
                  && (release.status === 'released' || release.status === 'failed' || release.status === 'unverified')
                ) {
                  settleRelease(request, {
                    status: release.status,
                    error: typeof release.error === 'string' ? release.error : undefined,
                  });
                } else if (response.ok === true) {
                  settleRelease(request, { status: 'unverified' });
                } else {
                  settleRelease(request, {
                    status: 'failed',
                    error: String(response.error || 'remote window native release failed'),
                  });
                }
              }
              pump();
            }
          } catch (error) {
            if (active) {
              const item = active;
              active = null;
              settleActive();
              if (item.kind === 'input') {
                rejectRequest(item.request, error instanceof Error ? error : new Error('remote window input helper returned invalid JSON'));
              } else {
                settleRelease(item.request, {
                  status: 'failed',
                  error: error instanceof Error ? error.message : 'remote window input helper returned invalid JSON',
                });
              }
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
      if (child !== currentChild) {
        return;
      }
      const message = stderrSummary();
      child = null;
      ready = false;
      const wrapped = new Error(message ? `${error.message}\n${message}` : error.message);
      rejectWarmWaiters(wrapped);
      rejectAll(wrapped);
    });
    currentChild.on('exit', (code, signal) => {
      const expected = expectedExit === currentChild;
      if (expected) {
        expectedExit = null;
      }
      const message = [
        `remote window input helper exited code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        stderrSummary(),
      ].filter(Boolean).join('\n');
      if (child === currentChild) {
        child = null;
        ready = false;
      }
      if (!disposed && !expected) {
        const error = new Error(message);
        rejectWarmWaiters(error);
        rejectAll(error);
      }
    });
    return currentChild;
  };

  const rejectOrResolveInput = (
    request: PendingRemoteWindowInputHelperRequest,
    response: { ok?: unknown; error?: unknown; operation?: unknown },
  ) => {
    if (request.timeout) {
      clearTimeout(request.timeout);
      request.timeout = null;
    }
    if (request.pairGraceTimer) {
      clearTimeout(request.pairGraceTimer);
      request.pairGraceTimer = null;
    }
    if (response.ok === true) {
      const operation = parseRemoteWindowNativeOperationResult(response);
      if (request.config.event.kind === 'window-resize' && !operation) {
        request.reject(new Error('remote window resize readback missing or invalid'));
        return;
      }
      request.resolve(operation);
    } else {
      request.reject(new Error(String(response.error || 'remote window input event failed')));
    }
  };


  const waitUntilReady = (): Promise<void> => {
    if (disposed) {
      return Promise.reject(new Error('remote window input helper is disposed'));
    }
    const gate = quiescing ?? Promise.resolve();
    return gate.then(() => {
      if (disposed) {
        throw new Error('remote window input helper is disposed');
      }
      const helperProcess = startChild();
      if (ready && child === helperProcess && !helperProcess.killed) {
        return;
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
              killChildAndQuiesce();
            }
            reject(error);
          }, REMOTE_WINDOW_INPUT_HELPER_READY_TIMEOUT_MS),
        };
        warmWaiters.push(waiter);
      });
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

  const resolveRemoteWindowLeaseUpKey = (config: RemoteWindowInputConfig): string | null => {
    if (!isRemoteWindowRealInputConfig(config)) {
      return null;
    }
    const carrier = remoteWindowInputUpCarrier(config);
    if (!carrier) {
      return null;
    }
    const key = remoteWindowNativeCarrierKey(carrier);
    const entry = leases.get(key);
    if (!entry || !entry.holders.has(config.streamId)) {
      return null;
    }
    return key;
  };

  const handleLeaseUp = (
    item: { kind: 'input'; request: PendingRemoteWindowInputHelperRequest },
    carrierKey: string,
  ) => {
    const request = item.request;
    const entry = leases.get(carrierKey);
    if (!entry) {
      pump();
      return;
    }
    if (entry.holders.size > 1) {
      entry.holders.delete(request.config.streamId);
      resolveRequest(request);
      pump();
      return;
    }
    const holder = entry.holders.get(request.config.streamId);
    if (!holder) {
      pump();
      return;
    }
    const operation = buildRemoteWindowReleaseOperation(holder.carrier, REMOTE_WINDOW_INPUT_RELEASE_OBSERVE_MS);
    queue.unshift({
      kind: 'release',
      request: {
        streamId: request.config.streamId,
        carrierKey,
        operation,
        clearOnReleased: true,
        timeout: null,
        settle: (result) => {
          if (result.status === 'released') {
            resolveRequest(request);
          } else {
            request.reject(new Error(
              `remote window native release ${result.status}${result.error ? `: ${result.error}` : ''}`,
            ));
          }
        },
      },
    });
    pump();
  };

  const pump = () => {
    if (active || queue.length === 0 || quiescing) {
      return;
    }
    const head = queue[0];
    if (head && head.kind === 'input') {
      const headRequest = head.request;
      if (isRemoteWindowFocusInputConfig(headRequest.config)) {
        const following = queue[1];
        if (
          following
          && following.kind === 'input'
          && shouldCoalesceRemoteWindowQueuedFocusBeforeInput(headRequest.config, following.request.config)
        ) {
          queue.shift();
          resolveRequest(headRequest);
          pump();
          return;
        }
        if (!headRequest.pairGraceExpired && !headRequest.pairGraceTimer) {
          headRequest.pairGraceTimer = setTimeout(() => {
            headRequest.pairGraceTimer = null;
            headRequest.pairGraceExpired = true;
            pump();
          }, REMOTE_WINDOW_INPUT_FOCUS_PAIR_GRACE_MS);
        }
        if (!headRequest.pairGraceExpired) {
          return;
        }
      }
    }
    const item = queue.shift();
    if (!item) {
      return;
    }
    if (item.kind === 'input') {
      const request = item.request;
      if (rejectIfStale(request)) {
        pump();
        return;
      }
      const leaseKey = resolveRemoteWindowLeaseUpKey(request.config);
      if (leaseKey) {
        handleLeaseUp(item, leaseKey);
        return;
      }
    }
    const helperProcess = startChild();
    if (!ready) {
      queue.unshift(item);
      startReadyPump();
      return;
    }
    active = item;
    activeSettlement = new Promise<void>((resolve) => {
      resolveActiveSettlement = resolve;
    });
    if (item.kind === 'input') {
      const request = item.request;
      request.timeout = setTimeout(() => {
        if (active !== item) {
          return;
        }
        active = null;
        settleActive();
        rejectRequest(request, new Error('remote window input helper timed out'));
        killChildAndQuiesce();
        pump();
      }, resolveRemoteWindowInputHelperTimeoutMs(request.config));
      const carrier = remoteWindowInputDownCarrier(request.config);
      if (carrier) {
        registerLeaseHolder(carrier, request.config.streamId, request.config);
        request.leaseCarrier = carrier;
      }
      helperProcess.stdin.write(`${JSON.stringify(request.config)}\n`, (error) => {
        if (!error || active !== item) {
          return;
        }
        active = null;
        settleActive();
        rejectRequest(request, error);
        pump();
      });
    } else {
      const request = item.request;
      request.timeout = setTimeout(() => {
        if (active !== item) {
          return;
        }
        active = null;
        settleActive();
        settleRelease(request, { status: 'unverified', error: 'remote window native release timed out' });
        killChildAndQuiesce();
        pump();
      }, REMOTE_WINDOW_INPUT_FOCUS_TIMEOUT_MS);
      helperProcess.stdin.write(`${JSON.stringify({ release: request.operation })}\n`, (error) => {
        if (!error || active !== item) {
          return;
        }
        active = null;
        settleActive();
        settleRelease(request, { status: 'failed', error: `remote window native release stdin write failed: ${error.message}` });
        pump();
      });
    }
  };

  const releaseStream = async (streamId: string): Promise<RemoteWindowInputStreamReleaseResult> => {
    const released: string[] = [];
    const sharedReleased: string[] = [];
    const remaining: string[] = [];
    const errors: string[] = [];
    let worst: RemoteWindowInputStreamReleaseStatus = 'released';
    const heldKeys = [...leases.entries()]
      .filter(([, entry]) => entry.holders.has(streamId))
      .map(([key]) => key);
    for (const carrierKey of heldKeys) {
      const entry = leases.get(carrierKey);
      if (!entry) {
        continue;
      }
      if (entry.holders.size > 1) {
        entry.holders.delete(streamId);
        sharedReleased.push(carrierKey);
        continue;
      }
      const holder = entry.holders.get(streamId);
      if (!holder) {
        continue;
      }
      const operation = buildRemoteWindowReleaseOperation(holder.carrier, REMOTE_WINDOW_INPUT_RELEASE_OBSERVE_MS);
      const result = await new Promise<{ status: RemoteWindowInputStreamReleaseStatus; error?: string }>((resolve) => {
        queue.push({
          kind: 'release',
          request: { streamId, carrierKey, operation, clearOnReleased: true, timeout: null, settle: resolve },
        });
        pump();
      });
      if (result.status === 'released') {
        released.push(carrierKey);
        continue;
      }
      remaining.push(carrierKey);
      if (result.error) {
        errors.push(result.error);
      }
      if (result.status === 'failed') {
        worst = 'failed';
      } else if (worst === 'released') {
        worst = 'unverified';
      }
    }
    return { streamId, status: worst, released, sharedReleased, remaining, errors };
  };

  const terminateChild = async () => {
    const dying = child;
    if (!dying) {
      return;
    }
    expectedExit = dying;
    if (!dying.killed) {
      try {
        dying.kill('SIGTERM');
      } catch {
        // best-effort bounded termination of the specific helper child
      }
    }
    if (child === dying) {
      child = null;
      ready = false;
    }
    await awaitChildQuiescence(dying);
  };

  return {
    warm() {
      return waitUntilReady();
    },
    send(config, delivery = { lane: 'reliable' }) {
      if (disposed) {
        return Promise.reject(new Error('remote window input helper is disposed'));
      }
      const normalizedConfig = config.event.kind === 'key' && !config.native
        ? { ...config, native: normalizeRemoteWindowNativeKey(config.event) }
        : config;
      return new Promise<RemoteWindowNativeOperationResult>((resolve, reject) => {
        const request: PendingRemoteWindowInputHelperRequest = {
          config: normalizedConfig,
          delivery,
          resolve,
          reject,
          timeout: null,
          pairGraceTimer: null,
          pairGraceExpired: false,
        };
        if (delivery.lane === 'continuous') {
          // Continuous motion is latest-wins: never let stale gesture samples
          // accumulate behind the helper process or a reliable release.
          for (let index = queue.length - 1; index >= 0; index -= 1) {
            const queued = queue[index];
            if (
              queued
              && queued.kind === 'input'
              && queued.request.delivery.lane === 'continuous'
              && remoteWindowInputConfigsShareTarget(queued.request.config, normalizedConfig)
              && queued.request.config.event.kind === normalizedConfig.event.kind
            ) {
              queue.splice(index, 1);
              resolveRequest(queued.request);
            }
          }
          queue.push({ kind: 'input', request });
        } else {
          // Reliable down/up/cancel must pass queued motion so release cannot
          // be delayed by a stale continuous sample.
          const firstContinuousIndex = queue.findIndex((queued) => (
            queued.kind === 'input' && queued.request.delivery.lane === 'continuous'
          ));
          if (firstContinuousIndex >= 0) {
            queue.splice(firstContinuousIndex, 0, { kind: 'input', request });
          } else {
            queue.push({ kind: 'input', request });
          }
        }
        pump();
      });
    },
    releaseStream,
    async dispose() {
      if (disposePromise) {
        return disposePromise;
      }
      disposePromise = (async () => {
        disposed = true;
        rejectWarmWaiters(new Error('remote window input helper disposed'));
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          const item = queue[index];
          if (item && item.kind === 'input') {
            queue.splice(index, 1);
            rejectRequest(item.request, new Error('remote window input helper disposed'));
          }
        }
        if (activeSettlement) {
          await activeSettlement;
        }
        const streamIds = new Set<string>();
        for (const entry of leases.values()) {
          for (const streamId of entry.holders.keys()) {
            streamIds.add(streamId);
          }
        }
        const failures: string[] = [];
        for (const streamId of streamIds) {
          const result = await releaseStream(streamId);
          if (result.status !== 'released') {
            failures.push(`${streamId} status=${result.status} remaining=${result.remaining.join('|') || 'none'}`);
          }
        }
        await terminateChild();
        if (failures.length > 0) {
          throw new Error(`remote window input helper disposal failed to release ${failures.join('; ')}`);
        }
      })();
      return disposePromise;
    },
    hasLease(streamId) {
      return [...leases.values()].some((entry) => entry.holders.has(streamId));
    },
  };
}
