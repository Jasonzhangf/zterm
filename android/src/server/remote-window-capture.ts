import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  RemoteWindowInputEventPayload,
  RemoteWindowStreamTargetManifest,
} from '@zterm/shared/protocol';
import { SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT } from './remote-window-scripts';
import {
  buildScreenCaptureKitStartupTimeoutMessage,
  truncateRemoteWindowErrorMessage,
  validateRect,
} from './remote-window-support';
import { assertPaneCropWithinWindow } from './remote-window-catalog';

export const DEFAULT_SCREEN_CAPTURE_KIT_STARTUP_TIMEOUT_MS = 20000;

const REMOTE_WINDOW_CAPTURE_UPDATE_TIMEOUT_MS = 3_000;
const REMOTE_WINDOW_CAPTURE_UPDATE_STDERR_PREFIX = 'ZTERM_REMOTE_WINDOW_CAPTURE_UPDATE ';

const REMOTE_WINDOW_CAPTURE_FRAME_MAGIC = Buffer.from('ZRW1');

export interface RemoteWindowCompositeLayoutWindow {
  windowId: string;
  windowBounds: { x: number; y: number; width: number; height: number };
  cropRect: { x: number; y: number; width: number; height: number };
  offsetX: number;
  offsetY: number;
}

export interface RemoteWindowCompositeLayout {
  windows: RemoteWindowCompositeLayoutWindow[];
  canvasWidth: number;
  canvasHeight: number;
}

// 同 app 多窗口组合推流：平铺布局（单行：Σ宽 × max高）
export function resolveRemoteWindowCompositeLayout(
  target: RemoteWindowStreamTargetManifest,
): RemoteWindowCompositeLayout | null {
  const compositeWindows = target.compositeWindows ?? [];
  if (compositeWindows.length === 0) {
    return null;
  }
  const main = {
    windowId: target.videoTarget.windowId,
    windowBounds: target.videoTarget.windowBoundsTopLeftPx,
    cropRect: target.videoTarget.cropRectTopLeftPx ?? target.videoTarget.windowBoundsTopLeftPx,
  };
  const windows = [main, ...compositeWindows.map((w) => ({
    windowId: w.windowId,
    windowBounds: w.windowBoundsTopLeftPx,
    cropRect: w.cropRectTopLeftPx ?? w.windowBoundsTopLeftPx,
  }))];
  let offsetX = 0;
  let canvasHeight = 0;
  const laidOut = windows.map((w) => {
    const win: RemoteWindowCompositeLayoutWindow = {
      windowId: w.windowId,
      windowBounds: w.windowBounds,
      cropRect: w.cropRect,
      offsetX,
      offsetY: 0,
    };
    offsetX += Math.max(1, Math.round(w.cropRect.width));
    canvasHeight = Math.max(canvasHeight, Math.round(w.cropRect.height));
    return win;
  });
  return {
    windows: laidOut,
    canvasWidth: offsetX,
    canvasHeight,
  };
}

export interface RemoteWindowCaptureFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface RemoteWindowCaptureFrameSource {
  width: number;
  height: number;
  frameRate: number;
  updateTarget?: (target: RemoteWindowStreamTargetManifest) => Promise<void>;
  stop: () => void;
}

export type RemoteWindowCaptureSourceFactory = (
  target: RemoteWindowStreamTargetManifest,
  options: {
    frameRate: number;
    startupTimeoutMs: number;
    swiftBinary: string;
    onFrame: (frame: RemoteWindowCaptureFrame) => void;
    onError: (error: Error) => void;
  },
) => Promise<RemoteWindowCaptureFrameSource>;

interface RemoteWindowCaptureUpdateAck {
  seq: number;
  ok: boolean;
  width?: number;
  height?: number;
  error?: string;
}

interface PendingRemoteWindowCaptureUpdate {
  target: RemoteWindowStreamTargetManifest;
  timer: ReturnType<typeof setTimeout>;
  resolve: (ack: RemoteWindowCaptureUpdateAck) => void;
  reject: (error: Error) => void;
}

type RemoteWindowCaptureChildProcess = ChildProcessWithoutNullStreams & {
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  removeListener(event: 'error', listener: (error: Error) => void): void;
  removeListener(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};

export function validateStreamTargetForCapture(target: RemoteWindowStreamTargetManifest) {
  if (!target.streamTargetId.trim()) {
    throw new Error('remote window stream target id is required');
  }
  const windowBounds = validateRect(target.videoTarget.windowBoundsTopLeftPx, 'remote-window.windowBoundsTopLeftPx');
  const cropRect = target.videoTarget.cropRectTopLeftPx
    ? validateRect(target.videoTarget.cropRectTopLeftPx, 'remote-window.cropRectTopLeftPx')
    : null;
  if (!cropRect) {
    throw new Error('remote window stream target requires cropRectTopLeftPx');
  }
  if (cropRect.width <= 0 || cropRect.height <= 0) {
    throw new Error('remote window stream crop rectangle must be drawable');
  }
  assertPaneCropWithinWindow(windowBounds, cropRect, target.streamTargetId);
  return {
    windowBounds,
    cropRect,
  };
}

export function buildResizedRemoteWindowTarget(
  target: RemoteWindowStreamTargetManifest,
  event: Extract<RemoteWindowInputEventPayload['event'], { kind: 'window-resize' }>,
  createdAt: string,
): RemoteWindowStreamTargetManifest {
  if (target.videoTarget.kind !== 'app-window') {
    throw new Error('remote window resize is only supported for app-window targets');
  }
  const currentWindow = validateRect(
    target.videoTarget.windowBoundsTopLeftPx,
    'remote-window.windowBoundsTopLeftPx',
  );
  const width = Math.max(120, Math.round(event.width));
  const height = Math.max(120, Math.round(event.height));
  const nextWindowBounds = {
    ...currentWindow,
    width,
    height,
  };
  const nextTarget: RemoteWindowStreamTargetManifest = {
    ...target,
    videoTarget: {
      ...target.videoTarget,
      windowBoundsTopLeftPx: nextWindowBounds,
      cropRectTopLeftPx: nextWindowBounds,
    },
    capture: {
      ...target.capture,
      createdAt,
    },
  };
  validateStreamTargetForCapture(nextTarget);
  return nextTarget;
}

export function buildScreenCaptureKitConfig(target: RemoteWindowStreamTargetManifest, frameRate: number) {
  const { windowBounds, cropRect } = validateStreamTargetForCapture(target);
  const compositeLayout = resolveRemoteWindowCompositeLayout(target);
  return {
    windowId: target.videoTarget.windowId,
    appBundleId: target.videoTarget.appBundleId,
    title: target.videoTarget.title,
    windowBounds,
    cropRect,
    frameRate: Math.max(1, Math.floor(frameRate)),
    queueDepth: 3,
    compositeWindows: compositeLayout?.windows.slice(1).map((w) => ({
      windowId: w.windowId,
      windowBounds: w.windowBounds,
      cropRect: w.cropRect,
      offsetX: w.offsetX,
      offsetY: w.offsetY,
    })),
    canvasWidth: compositeLayout?.canvasWidth,
    canvasHeight: compositeLayout?.canvasHeight,
  };
}

function stopChildProcess(child: RemoteWindowCaptureChildProcess) {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  child.kill('SIGTERM');
}

export function startScreenCaptureKitFrameSource(
  target: RemoteWindowStreamTargetManifest,
  options: {
    frameRate: number;
    startupTimeoutMs: number;
    swiftBinary: string;
    onFrame: (frame: RemoteWindowCaptureFrame) => void;
    onError: (error: Error) => void;
  },
): Promise<RemoteWindowCaptureFrameSource> {
  let captureConfig = buildScreenCaptureKitConfig(target, options.frameRate);
  const child = spawn(options.swiftBinary, ['-e', SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT], {
    env: {
      ...process.env,
      ZTERM_REMOTE_WINDOW_CAPTURE_CONFIG: JSON.stringify(captureConfig),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as RemoteWindowCaptureChildProcess;
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = '';
  let stderrLineBuffer = '';
  let firstFrameResolved = false;
  let stopped = false;
  let frameWidth = Math.max(1, Math.floor(captureConfig.cropRect.width));
  let frameHeight = Math.max(1, Math.floor(captureConfig.cropRect.height));
  let captureUpdateSeq = 0;
  const pendingCaptureUpdates = new Map<number, PendingRemoteWindowCaptureUpdate>();

  const rejectPendingCaptureUpdates = (error: Error) => {
    for (const [seq, pending] of pendingCaptureUpdates) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pendingCaptureUpdates.delete(seq);
    }
  };

  const cleanupListeners = () => {
    child.stdout.removeListener('data', onStdout);
    child.stderr.removeListener('data', onStderr);
    child.removeListener('error', onChildError);
    child.removeListener('exit', onChildExit);
  };

  const frameSource: RemoteWindowCaptureFrameSource = {
    get width() {
      return frameWidth;
    },
    get height() {
      return frameHeight;
    },
    frameRate: Math.max(1, Math.floor(options.frameRate)),
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      cleanupListeners();
      rejectPendingCaptureUpdates(new Error('ScreenCaptureKit capture source stopped'));
      stopChildProcess(child);
    },
  };

  frameSource.updateTarget = async (nextTarget) => {
    if (stopped) {
      throw new Error('ScreenCaptureKit capture source is stopped');
    }
    if (!child.stdin.writable || child.stdin.destroyed) {
      throw new Error('ScreenCaptureKit capture command channel is closed');
    }
    const nextConfig = buildScreenCaptureKitConfig(nextTarget, frameSource.frameRate);
    const seq = captureUpdateSeq + 1;
    captureUpdateSeq = seq;
    const command = {
      kind: 'update-config',
      seq,
      windowBounds: nextConfig.windowBounds,
      cropRect: nextConfig.cropRect,
      frameRate: nextConfig.frameRate,
      queueDepth: nextConfig.queueDepth,
      compositeWindows: nextConfig.compositeWindows,
      canvasWidth: nextConfig.canvasWidth,
      canvasHeight: nextConfig.canvasHeight,
    };
    const ack = await new Promise<RemoteWindowCaptureUpdateAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCaptureUpdates.delete(seq);
        reject(new Error(`ScreenCaptureKit capture update timed out after ${REMOTE_WINDOW_CAPTURE_UPDATE_TIMEOUT_MS}ms`));
      }, REMOTE_WINDOW_CAPTURE_UPDATE_TIMEOUT_MS);
      pendingCaptureUpdates.set(seq, {
        target: nextTarget,
        timer,
        resolve,
        reject,
      });
      child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
        if (!error) {
          return;
        }
        const pending = pendingCaptureUpdates.get(seq);
        if (!pending) {
          return;
        }
        pendingCaptureUpdates.delete(seq);
        clearTimeout(pending.timer);
        pending.reject(new Error(`ScreenCaptureKit capture command write failed: ${error.message}`));
      });
    });
    if (!ack.ok) {
      throw new Error(ack.error || 'ScreenCaptureKit capture update failed');
    }
    captureConfig = nextConfig;
    frameWidth = Math.max(1, Math.floor(ack.width ?? nextConfig.cropRect.width));
    frameHeight = Math.max(1, Math.floor(ack.height ?? nextConfig.cropRect.height));
  };

  let resolveStart: (source: RemoteWindowCaptureFrameSource) => void = () => undefined;
  let rejectStart: (error: Error) => void = () => undefined;
  const startup = new Promise<RemoteWindowCaptureFrameSource>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });

  const startupTimer = setTimeout(() => {
    if (firstFrameResolved || stopped) {
      return;
    }
    frameSource.stop();
    rejectStart(new Error(buildScreenCaptureKitStartupTimeoutMessage(
      stderrBuffer,
      options.startupTimeoutMs,
    )));
  }, Math.max(1, options.startupTimeoutMs));

  function fail(error: Error) {
    if (!firstFrameResolved) {
      clearTimeout(startupTimer);
      frameSource.stop();
      rejectStart(error);
      return;
    }
    options.onError(error);
  }

  function emitFrame(width: number, height: number, rgba: Buffer) {
    frameWidth = width;
    frameHeight = height;
    const frame = {
      width,
      height,
      rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    };
    options.onFrame(frame);
    if (!firstFrameResolved) {
      firstFrameResolved = true;
      clearTimeout(startupTimer);
      resolveStart(frameSource);
    }
  }

  function onStdout(chunk: Buffer) {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    while (stdoutBuffer.length >= 16) {
      if (!stdoutBuffer.subarray(0, 4).equals(REMOTE_WINDOW_CAPTURE_FRAME_MAGIC)) {
        fail(new Error('ScreenCaptureKit frame stream header mismatch'));
        return;
      }
      const width = stdoutBuffer.readUInt32LE(4);
      const height = stdoutBuffer.readUInt32LE(8);
      const byteLength = stdoutBuffer.readUInt32LE(12);
      if (width === 0 || height === 0 || byteLength !== width * height * 4) {
        fail(new Error('ScreenCaptureKit frame stream emitted invalid frame dimensions'));
        return;
      }
      const packetLength = 16 + byteLength;
      if (stdoutBuffer.length < packetLength) {
        return;
      }
      const rgba = Buffer.from(stdoutBuffer.subarray(16, packetLength));
      stdoutBuffer = stdoutBuffer.subarray(packetLength);
      if (!stopped) {
        emitFrame(width, height, rgba);
      }
    }
  }

  function handleCaptureUpdateAckLine(line: string) {
    if (!line.startsWith(REMOTE_WINDOW_CAPTURE_UPDATE_STDERR_PREFIX)) {
      return false;
    }
    const rawJson = line.slice(REMOTE_WINDOW_CAPTURE_UPDATE_STDERR_PREFIX.length).trim();
    try {
      const parsed = JSON.parse(rawJson) as Partial<RemoteWindowCaptureUpdateAck>;
      if (!Number.isInteger(parsed.seq)) {
        return true;
      }
      const seq = Number(parsed.seq);
      const pending = pendingCaptureUpdates.get(seq);
      if (!pending) {
        return true;
      }
      pendingCaptureUpdates.delete(seq);
      clearTimeout(pending.timer);
      const ack: RemoteWindowCaptureUpdateAck = {
        seq,
        ok: Boolean(parsed.ok),
        ...(Number.isFinite(parsed.width) ? { width: Number(parsed.width) } : {}),
        ...(Number.isFinite(parsed.height) ? { height: Number(parsed.height) } : {}),
        ...(typeof parsed.error === 'string' && parsed.error.trim() ? { error: parsed.error } : {}),
      };
      pending.resolve(ack);
    } catch (error) {
      options.onError(new Error(`ScreenCaptureKit capture update ack parse failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    return true;
  }

  function onStderr(chunk: Buffer) {
    const text = chunk.toString('utf8');
    stderrLineBuffer = `${stderrLineBuffer}${text}`;
    const lines = stderrLineBuffer.split(/\r?\n/);
    stderrLineBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line) {
        continue;
      }
      handleCaptureUpdateAckLine(line);
    }
    stderrBuffer = `${stderrBuffer}${text}`;
    stderrBuffer = stderrBuffer.slice(-1200);
  }

  function onChildError(error: Error) {
    rejectPendingCaptureUpdates(new Error(`ScreenCaptureKit capture process failed: ${error.message}`));
    fail(new Error(`ScreenCaptureKit capture process failed: ${error.message}`));
  }

  function onChildExit(code: number | null, signal: NodeJS.Signals | null) {
    if (stopped) {
      return;
    }
    rejectPendingCaptureUpdates(new Error(`ScreenCaptureKit capture process exited code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    const detail = truncateRemoteWindowErrorMessage(stderrBuffer || `capture process exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    fail(new Error(`ScreenCaptureKit capture process exited: ${detail}`));
  }

  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);
  child.on('error', onChildError);
  child.on('exit', onChildExit);

  return startup;
}
