import wrtc from '@roamhq/wrtc';

import {
  normalizeRtcDescription,
  normalizeIceCandidate,
  normalizeRemoteWindowVideoProfile,
  formatRemoteWindowVideoProfileError,
  convertRgbaToI420Frame,
} from './remote-window-stream-daemon-helpers';
import type {
  RemoteWindowStreamIceCandidatePayload,
  RemoteWindowInputEventPayload,
  RemoteWindowInputAckControl,
  RemoteWindowInputDeliveryControl,
  RemoteWindowInputResultPayload,
  RemoteWindowCanvasLayoutV1,
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamRequestPayload,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowStreamPurpose,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamStartedOfferV2Payload,
  RemoteWindowStreamMediaBinding,
  RemoteWindowStreamAnswerV2Payload,
  RemoteWindowStreamStartRequestV2Payload,
  RemoteWindowStreamStatusPayload,
  RemoteWindowStreamStopRequestPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowStreamUpdateFocusRequestPayload,
  RemoteWindowStreamFocusResultPayload,
  RemoteWindowStreamFailureStage,
  RemoteWindowVideoProfile,
  RemoteWindowBrowserUserAgentRequestPayload,
  RemoteWindowBrowserUserAgentResultPayload,
  RemoteWindowCloseRequestPayload,
  RemoteWindowCloseResultPayload,
  RemoteWindowStreamCleanupResult,
  RemoteWindowStreamCleanupResourceError,
  RemoteWindowStreamInputReleaseProjection,
} from '@zterm/shared/protocol';
import {
  getRemoteWindowMediaPlanV2Contract,
  REMOTE_WINDOW_STREAM_ANSWER_CANCELLED_CODE,
} from '@zterm/shared/protocol';
import { buildRemoteWindowCanvasLayoutV1 } from './remote-window-canvas-layout';
import {
  applyRemoteWindowStreamGroupQuality,
  RemoteWindowQualityUnsupportedError,
  REMOTE_WINDOW_STREAM_QUALITY_UNSUPPORTED_CODE,
} from './remote-window-quality';
import { runPhase4RemoteWindow, type DagpipeResult } from './dagpipe-bridge';
import {
  releaseRemoteWindowStreamSessionResources,
  type RemoteWindowStreamSessionResources,
} from './remote-window-stream-session';
import {
  truncateRemoteWindowErrorMessage,
} from './remote-window-support';
import {
  DEFAULT_ITERM2_PYTHON_TIMEOUT_MS,
  DEFAULT_MACOS_APP_WINDOW_CATALOG_TIMEOUT_MS,
  runDefaultIterm2Python,
  runDefaultMacosAppWindowCatalog,
  setChromeWindowUserAgent,
} from './remote-window-catalog';
import { createRemoteWindowCatalogRuntime } from './remote-window-catalog-runtime';
import {
  buildRemoteWindowInputConfig,
  createDefaultRemoteWindowInputHelper,
  type RemoteWindowInputEventRunner,
  type RemoteWindowInputHelper,
  type RemoteWindowNativeResizeOperation,
} from './remote-window-input-helper';
import { validateRemoteWindowInputPayload } from './remote-window-input-policy';
import {
  DEFAULT_SCREEN_CAPTURE_KIT_STARTUP_TIMEOUT_MS,
  RemoteWindowCaptureTargetOutOfDisplayError,
  RemoteWindowCaptureTargetUnavailableError,
  buildResizedRemoteWindowTarget,
  startScreenCaptureKitFrameSource,
  validateStreamTargetForCapture,
  type RemoteWindowCaptureFrame,
  type RemoteWindowCaptureSourceFactory,
} from './remote-window-capture';

export * from './remote-window-scripts';
export * from './remote-window-support';
export * from './remote-window-catalog';
export * from './remote-window-input-helper';
export * from './remote-window-capture';

const DEFAULT_REMOTE_WINDOW_TARGET_CATALOG_REFRESH_INTERVAL_MS = 5_000;

interface RemoteWindowDagpipeGateOptions {
  requestId: string;
  targetId: string;
  windows?: Array<{ id: string; name?: string }>;
  touch?: { kind: string; x?: number; y?: number };
  quality?: { targetId: string; mode?: string };
  policy?: { allowStream?: boolean; allowQuality?: boolean; allowInput?: boolean; fps?: number };
  executionId?: string;
}

function runRemoteWindowDagpipeGate(options: RemoteWindowDagpipeGateOptions): DagpipeResult {
  return runPhase4RemoteWindow({
    execution_id: options.executionId ?? 'remote-window-stream-gate',
    attempt_id: '1',
    inputs: {
      'arc.catalog_request': {
        requestId: options.requestId,
        windows: options.windows ?? [{ id: options.targetId }],
      },
      'arc.stream_start_intent': {
        requestId: options.requestId,
        targetId: options.targetId,
      },
      'arc.touch_action': options.touch ?? { kind: 'none', x: 0, y: 0 },
      'arc.quality_intent': options.quality ?? {
        targetId: options.targetId,
        mode: 'balanced',
      },
      'arc.stream_policy': options.policy ?? {
        allowStream: true,
        allowQuality: true,
        allowInput: true,
        fps: 30,
      },
    },
  });
}

function isRemoteWindowDagpipeProjectionReady(result: DagpipeResult): boolean {
  if (!result.ok) {
    return false;
  }
  const outputs = result.outputs as Record<string, { state?: string }>;
  return outputs['arc.overlay_directory']?.state === 'ready'
    && outputs['arc.overlay_projection']?.state === 'projected'
    && outputs['arc.input_result']?.state === 'injected';
}

type RtcPeerConnectionCtor = typeof globalThis.RTCPeerConnection;
type RtcSessionDescriptionCtor = typeof globalThis.RTCSessionDescription;
type RtcIceCandidateCtor = typeof globalThis.RTCIceCandidate;

interface RtcVideoFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

interface RtcVideoSourceLike {
  createTrack(): MediaStreamTrack;
  onFrame(frame: RtcVideoFrame): void;
}

const {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  MediaStream,
  nonstandard,
} = wrtc as unknown as {
  RTCPeerConnection: RtcPeerConnectionCtor;
  RTCSessionDescription: RtcSessionDescriptionCtor;
  RTCIceCandidate: RtcIceCandidateCtor;
  MediaStream: { new (init: { id: string }): MediaStream };
  nonstandard: {
    RTCVideoSource: { new (init?: { isScreencast?: boolean; needsDenoising?: boolean }): RtcVideoSourceLike };
    rgbaToI420: (rgba: RtcVideoFrame, i420: RtcVideoFrame) => void;
  };
};

export interface RemoteWindowStreamDaemonDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => string;
  pythonBinary?: string;
  swiftBinary?: string;
  captureBinary?: string;
  iterm2PythonTimeoutMs?: number;
  appWindowCatalogTimeoutMs?: number;
  targetCatalogRefreshIntervalMs?: number;
  nowMs?: () => number;
  warmTargetCatalogOnStart?: boolean;
  captureStartupTimeoutMs?: number;
  frameRate?: number;
  runIterm2Python?: (script: string, options: { pythonBinary: string; timeoutMs: number }) => Promise<string>;
  runMacosAppWindowCatalog?: (script: string, options: { swiftBinary: string; timeoutMs: number }) => Promise<string>;
  remoteWindowInputHelperFactory?: (options: { swiftBinary: string }) => RemoteWindowInputHelper;
  captureSourceFactory?: RemoteWindowCaptureSourceFactory;
  runRemoteWindowInputEvent?: RemoteWindowInputEventRunner;
  peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
  rtcSessionDescriptionFactory?: (description: RTCSessionDescriptionInit) => RTCSessionDescription;
  rtcIceCandidateFactory?: (candidate: RTCIceCandidateInit) => RTCIceCandidate;
  videoSourceFactory?: () => RtcVideoSourceLike;
  rgbaToI420?: (rgba: RtcVideoFrame, i420: RtcVideoFrame) => void;
  runTmux: (args: string[]) => { ok: true; stdout: string };
}

export interface RemoteWindowStreamDaemonRuntime {
  listTargets: (
    payload: RemoteWindowStreamRequestPayload,
  ) => Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload>;
  startStream: (
    payload: RemoteWindowStreamStartRequestV2Payload,
    handlers?: RemoteWindowStreamDaemonHandlers,
  ) => Promise<RemoteWindowStreamStartedPayload | RemoteWindowStreamStartedOfferV2Payload | RemoteWindowStreamErrorPayload>;
  acceptAnswer?: (payload: RemoteWindowStreamAnswerV2Payload) => Promise<boolean>;
  addIceCandidate: (payload: RemoteWindowStreamIceCandidatePayload) => Promise<boolean>;
  stopStream: (
    payload: RemoteWindowStreamStopRequestPayload,
  ) => Promise<RemoteWindowStreamStatusPayload | RemoteWindowStreamErrorPayload>;
  requestRemoteWindowClose: (
    payload: RemoteWindowCloseRequestPayload,
  ) => Promise<RemoteWindowCloseResultPayload>;
  updateStreamQuality: (
    payload: RemoteWindowStreamQualityRequestPayload,
  ) => Promise<RemoteWindowStreamQualityResultPayload | RemoteWindowStreamErrorPayload>;
  updateFocus: (
    payload: RemoteWindowStreamUpdateFocusRequestPayload,
  ) => Promise<RemoteWindowStreamFocusResultPayload | RemoteWindowStreamErrorPayload>;
  injectInput: (
    payload: RemoteWindowInputEventPayload,
    control: RemoteWindowInputDeliveryControl,
  ) => Promise<RemoteWindowInputAck | null>;
  setBrowserUserAgent: (
    payload: RemoteWindowBrowserUserAgentRequestPayload,
  ) => Promise<RemoteWindowBrowserUserAgentResultPayload>;
  dispose: (reason?: string) => Promise<void>;
}

export interface RemoteWindowStreamDaemonHandlers {
  sendIceCandidate?: (payload: RemoteWindowStreamIceCandidatePayload) => void;
  sendStatus?: (payload: RemoteWindowStreamStatusPayload) => void;
  sendFocusResult?: (payload: RemoteWindowStreamFocusResultPayload) => void;
  sendOffer?: (payload: RemoteWindowStreamStartedOfferV2Payload) => void;
}

interface ActiveRemoteWindowStream extends Omit<RemoteWindowStreamSessionResources, 'sendStatus'> {
  streamId: string;
  purpose: RemoteWindowStreamPurpose;
  requestId: string;
  targetId: string;
  target: RemoteWindowStreamTargetManifest;
  canvasLayout: RemoteWindowCanvasLayoutV1 | null;
  layoutGeneration: number;
  qualityRevision: number;
  pendingQualityRevision: number | null;
  streamGroupId: string;
  mediaPlan: RemoteWindowStreamStartRequestV2Payload['mediaPlan'];
  mediaPlanVersion: 2;
  overviewTarget: RemoteWindowStreamTargetManifest | null;
  // overview 画布主窗口固定为流的初始 target：focus 切换只改 entry.target，
  // 不漂移 overview 画布（client 的 state.target 也不随 focus 切换更新，
  // 两者必须保持对齐，否则缩略图/crop 坐标错位）。
  overviewMainTarget: RemoteWindowStreamTargetManifest | null;
  // focus（高码率主窗口）流：主 track
  videoSender: RTCRtpSender | null;
  videoSource: RtcVideoSourceLike;
  videoProfile: RemoteWindowVideoProfile | null;
  maxFrameAgeMs: number;
  // overview（低码率总览）流：组合 target 时启用
  overviewVideoSender?: RTCRtpSender | null;
  overviewVideoSource?: RtcVideoSourceLike;
  overviewFramesSent?: number;
  framesDropped: number;
  compositePollTimer: ReturnType<typeof setInterval> | null;
  handlers: RemoteWindowStreamDaemonHandlers;
  focusRevision: number;
  pendingFocusReady: RemoteWindowStreamFocusResultPayload | null;
  pendingFocusFrame: RemoteWindowPendingMediaFrame | null;
  pendingOverviewFrame?: RemoteWindowPendingMediaFrame | null;
  focusFrameDrainScheduled: boolean;
  overviewFrameDrainScheduled: boolean;
  remoteDescriptionApplied: boolean;
  pendingIceCandidates: RTCIceCandidateInit[];
  focusCaptureStartedReported: boolean;
  overviewCaptureStartedReported: boolean;
  cleanupDone: boolean;
  admissionClosed: boolean;
  reliableInputTail: Promise<void>;
  reliableInputInFlightBySequence: Map<string, Promise<RemoteWindowInputAck>>;
  reliableInputCompletedBySequence: Map<string, RemoteWindowInputAck>;
  continuousGestureState: Map<string, { lastSampledAtMs: number; ended: boolean }>;
}

interface RemoteWindowInputAck {
  control: RemoteWindowInputAckControl;
  payload: RemoteWindowInputResultPayload;
}

/**
 * The stream release capability the input helper exposes for r5 lifecycle.
 * It is declared optional here because the concrete helper owner may land
 * after this backend author; a missing capability is surfaced as an explicit
 * failed input release, never a silent success.
 */
interface RemoteWindowStreamInputHelperRelease {
  releaseStream?: (streamId: string) => Promise<RemoteWindowStreamInputReleaseProjection>;
  hasLease?: (streamId: string) => boolean;
}

interface RemoteWindowPendingMediaFrame {
  frame: RemoteWindowCaptureFrame;
  capturedAtMs: number;
}

interface PendingRemoteWindowAnswer {
  streamId: string;
  requestId: string;
  resolve: (answer: RTCSessionDescriptionInit) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * The single serialized async stop owner for one remote-window stream. Concurrent
 * callers observe the same pending operation/result.
 */
interface RemoteWindowStopOperation {
  promise: Promise<RemoteWindowStreamStatusPayload | RemoteWindowStreamErrorPayload>;
  result?: RemoteWindowStreamStatusPayload | RemoteWindowStreamErrorPayload;
}





















interface RemoteWindowResizeApplyResult {
  target: RemoteWindowStreamTargetManifest;
  capture: {
    source: 'ScreenCaptureKit';
    frameWidth: number;
    frameHeight: number;
    frameRate?: number;
    targetKind: RemoteWindowStreamTargetManifest['videoTarget']['kind'];
  };
}

function buildObservedRemoteWindowTarget(
  target: RemoteWindowStreamTargetManifest,
  observation: RemoteWindowNativeResizeOperation,
  createdAt: string,
): RemoteWindowStreamTargetManifest {
  if (
    target.videoTarget.kind !== 'app-window'
  ) {
    throw new Error('remote window resize readback identity mismatch');
  }
  const bounds = {
    x: Math.round(observation.position.x),
    y: Math.round(observation.position.y),
    width: Math.round(observation.size.width),
    height: Math.round(observation.size.height),
  };
  const nextTarget: RemoteWindowStreamTargetManifest = {
    ...target,
    videoTarget: {
      ...target.videoTarget,
      windowBoundsTopLeftPx: bounds,
      cropRectTopLeftPx: bounds,
    },
    capture: {
      ...target.capture,
      createdAt,
    },
  };
  validateStreamTargetForCapture(nextTarget);
  return nextTarget;
}







function enqueueRemoteWindowLatestFrame(
  entry: Pick<ActiveRemoteWindowStream, 'pendingFocusFrame' | 'pendingOverviewFrame'>,
  lane: 'focus' | 'overview',
  frame: RemoteWindowCaptureFrame,
) {
  const pending: RemoteWindowPendingMediaFrame = {
    frame,
    capturedAtMs: frame.capturedAtMs ?? Date.now(),
  };
  if (lane === 'overview') {
    entry.pendingOverviewFrame = pending;
    return;
  }
  entry.pendingFocusFrame = pending;
}

function takeRemoteWindowLatestFrame(
  entry: Pick<ActiveRemoteWindowStream, 'pendingFocusFrame' | 'pendingOverviewFrame'>,
  lane: 'focus' | 'overview',
) {
  if (lane === 'overview') {
    const pending = entry.pendingOverviewFrame ?? null;
    entry.pendingOverviewFrame = null;
    return pending;
  }
  const pending = entry.pendingFocusFrame;
  entry.pendingFocusFrame = null;
  return pending;
}

async function applyRemoteWindowTargetResize(
  entry: ActiveRemoteWindowStream,
  observation: RemoteWindowNativeResizeOperation,
  createdAt: string,
  assertCurrentTarget: () => void,
): Promise<RemoteWindowResizeApplyResult> {
  const captureSource = entry.captureSource;
  if (!captureSource?.updateTarget) {
    throw new Error('remote window active capture source cannot update target resize');
  }
  const nextTarget = buildObservedRemoteWindowTarget(entry.target, observation, createdAt);
  await captureSource.updateTarget(nextTarget);
  assertCurrentTarget();
  entry.target = nextTarget;
  entry.targetId = nextTarget.streamTargetId;
  return {
    target: nextTarget,
    capture: {
      source: 'ScreenCaptureKit',
      frameWidth: captureSource.width,
      frameHeight: captureSource.height,
      frameRate: captureSource.frameRate,
      targetKind: nextTarget.videoTarget.kind,
    },
  };
}


export function createRemoteWindowStreamDaemonRuntime(
  deps: RemoteWindowStreamDaemonDeps,
): RemoteWindowStreamDaemonRuntime {
  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;
  const pythonBinary = (deps.pythonBinary || process.env.ZTERM_ITERM2_PYTHON || 'python3').trim();
  const swiftBinary = (deps.swiftBinary || process.env.ZTERM_MACOS_SWIFT || 'swift').trim();
  const captureBinary = (deps.captureBinary ?? process.env.ZTERM_DAEMON_NATIVE ?? '').trim();
  const iterm2PythonTimeoutMs = deps.iterm2PythonTimeoutMs || DEFAULT_ITERM2_PYTHON_TIMEOUT_MS;
  const appWindowCatalogTimeoutMs = deps.appWindowCatalogTimeoutMs || DEFAULT_MACOS_APP_WINDOW_CATALOG_TIMEOUT_MS;
  const captureStartupTimeoutMs = deps.captureStartupTimeoutMs || DEFAULT_SCREEN_CAPTURE_KIT_STARTUP_TIMEOUT_MS;
  const runIterm2Python = deps.runIterm2Python || runDefaultIterm2Python;
  const runMacosAppWindowCatalog = deps.runMacosAppWindowCatalog || runDefaultMacosAppWindowCatalog;
  let remoteWindowInputHelper: (RemoteWindowInputHelper & RemoteWindowStreamInputHelperRelease) | null = null;
  const getRemoteWindowInputHelper = () => {
    if (!remoteWindowInputHelper) {
      remoteWindowInputHelper = deps.remoteWindowInputHelperFactory
        ? deps.remoteWindowInputHelperFactory({ swiftBinary })
        : createDefaultRemoteWindowInputHelper({ swiftBinary });
    }
    return remoteWindowInputHelper;
  };
  const warmRemoteWindowInputHelperForTarget = async (target: RemoteWindowStreamTargetManifest) => {
    if (
      platform !== 'darwin'
      || deps.runRemoteWindowInputEvent
      || target.inputRoute !== 'os-event'
      || target.focusPolicy !== 'bring-to-focus'
    ) {
      return;
    }
    await getRemoteWindowInputHelper().warm();
  };
  const runRemoteWindowInputEvent = deps.runRemoteWindowInputEvent || ((payload, target, options) => {
    // 每个业务输入都在同一持久 helper 队列内完成前台/窗口校验后再注入。
    // 禁止时间防抖跳过校验：用户可在任意时刻把另一窗口置前。
    return getRemoteWindowInputHelper().send({
      ...buildRemoteWindowInputConfig(payload, target, {
        daemonReceivedAtMs: options.daemonReceivedAtMs,
      }),
      // The helper owns the per-stream lease table; the daemon passes the
      // stream identity so releaseStream can withdraw exactly this stream.
      streamId: payload.streamId,
    } as unknown as Parameters<RemoteWindowInputHelper['send']>[0], options.delivery);
  });
  const now = deps.now || (() => new Date().toISOString());
  const captureSourceFactory = deps.captureSourceFactory || startScreenCaptureKitFrameSource;
  const createPeerConnection = deps.peerConnectionFactory || ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
  const createRtcSessionDescription = deps.rtcSessionDescriptionFactory || ((description: RTCSessionDescriptionInit) => new RTCSessionDescription(description));
  const createRtcIceCandidate = deps.rtcIceCandidateFactory || ((candidate: RTCIceCandidateInit) => new RTCIceCandidate(candidate));
  const createVideoSource = deps.videoSourceFactory || (() => new nonstandard.RTCVideoSource({ isScreencast: true }));
  const rgbaToI420 = deps.rgbaToI420 || nonstandard.rgbaToI420;
  const activeStreams = new Map<string, ActiveRemoteWindowStream>();
  const pendingAnswers = new Map<string, PendingRemoteWindowAnswer>();
  const pendingIceCandidatesByStream = new Map<string, RTCIceCandidateInit[]>();
  const iceCandidateFingerprintsByStream = new Map<string, Set<string>>();
  const pendingStops = new Map<string, RemoteWindowStopOperation>();
  const completedStops = new Map<string, RemoteWindowStreamStatusPayload>();
  let disposePromise: Promise<void> | null = null;
  const targetCatalogRefreshIntervalMs = Math.max(
    1_000,
    Math.floor(deps.targetCatalogRefreshIntervalMs ?? DEFAULT_REMOTE_WINDOW_TARGET_CATALOG_REFRESH_INTERVAL_MS),
  );
  const nowMs = deps.nowMs || Date.now;
  const catalogRuntime = createRemoteWindowCatalogRuntime({
    platform,
    pythonBinary,
    swiftBinary,
    iterm2PythonTimeoutMs,
    appWindowCatalogTimeoutMs,
    targetCatalogRefreshIntervalMs,
    now,
    nowMs,
    runIterm2Python,
    runMacosAppWindowCatalog,
    runTmux: deps.runTmux,
  });

  const answerKey = (streamId: string, requestId: string) => `${streamId}\u0000${requestId}`;
  const iceGenerationKey = (streamId: string, requestId?: string) => requestId
    ? answerKey(streamId, requestId)
    : streamId;

  function waitForRemoteWindowAnswer(streamId: string, requestId: string) {
    const key = answerKey(streamId, requestId);
    return new Promise<RTCSessionDescriptionInit>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingAnswers.delete(key);
        reject(new Error('remote window stream answer timed out'));
      }, 25_000);
      pendingAnswers.set(key, { streamId, requestId, resolve, reject, timeoutId });
    });
  }

  /**
   * Cancels the original pending-answer owner at the admission boundary: clears
   * its existing timer, deletes the pending entry, and rejects its original
   * promise with the typed cancellation code. Returns true when a pending
   * answer was cancelled.
   */
  function cancelPendingRemoteWindowAnswer(streamId: string, requestId?: string) {
    let cancelled = false;
    for (const [key, pending] of Array.from(pendingAnswers.entries())) {
      if (pending.streamId !== streamId) {
        continue;
      }
      if (requestId !== undefined && pending.requestId !== requestId) {
        continue;
      }
      clearTimeout(pending.timeoutId);
      pendingAnswers.delete(key);
      const error = new Error(`remote window stream answer cancelled: ${streamId}/${pending.requestId}`);
      error.name = REMOTE_WINDOW_STREAM_ANSWER_CANCELLED_CODE;
      pending.reject(error);
      cancelled = true;
    }
    return cancelled;
  }

  function buildStreamError(
    payload: { requestId?: string; streamId?: string },
    code: string,
    message: string,
    failureStage?: RemoteWindowStreamFailureStage,
  ): RemoteWindowStreamErrorPayload {
    return {
      requestId: payload.requestId || '',
      ...(payload.streamId ? { streamId: payload.streamId } : {}),
      code,
      message: truncateRemoteWindowErrorMessage(message || code),
      ...(failureStage ? { failureStage } : {}),
    };
  }

  async function setBrowserUserAgent(
    payload: RemoteWindowBrowserUserAgentRequestPayload,
  ): Promise<RemoteWindowBrowserUserAgentResultPayload> {
    try {
      const result = await setChromeWindowUserAgent(payload.target, payload.userAgent);
      return {
        requestId: payload.requestId,
        targetId: payload.target.streamTargetId,
        userAgent: payload.userAgent,
        status: 'applied',
        cdpTargetId: result.cdpTargetId,
      };
    } catch (error) {
      return {
        requestId: payload.requestId,
        targetId: payload.target.streamTargetId,
        userAgent: payload.userAgent,
        status: 'rejected',
        error: {
          code: 'remote_window_browser_cdp_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * Drops the buffered ICE/fingerprint state for one stream id at real
   * retirement. r5 keeps no closed-stream tombstone: cancellation truth is the
   * active entry's admissionClosed flag plus the existing completedStops cache.
   */
  function clearRemoteWindowStreamIceState(streamId: string) {
    for (const key of pendingIceCandidatesByStream.keys()) {
      if (key === streamId || key.startsWith(`${streamId}\u0000`)) pendingIceCandidatesByStream.delete(key);
    }
    for (const key of iceCandidateFingerprintsByStream.keys()) {
      if (key === streamId || key.startsWith(`${streamId}\u0000`)) iceCandidateFingerprintsByStream.delete(key);
    }
  }

  /**
   * Releases this stream's input-helper leases. A missing helper release
   * capability is surfaced as an explicit failed projection with the input
   * lease retained for retry, never manufactured as released.
   */
  function releaseRemoteWindowStreamInput(entry: ActiveRemoteWindowStream): Promise<RemoteWindowStreamInputReleaseProjection> {
    const helper = getRemoteWindowInputHelper();
    if (typeof helper.releaseStream !== 'function') {
      return Promise.resolve({
        status: 'failed',
        released: [],
        sharedReleased: [],
        remaining: [`input:${entry.streamId}`],
        errors: ['remote window input helper release capability is unavailable'],
      });
    }
    return helper.releaseStream(entry.streamId).then(
      (release) => ({
        status: release.status,
        released: release.released,
        sharedReleased: release.sharedReleased,
        remaining: release.remaining,
        errors: release.errors,
      }),
      (error) => ({
        status: 'failed',
        released: [],
        sharedReleased: [],
        remaining: [`input:${entry.streamId}`],
        errors: [error instanceof Error ? error.message : String(error)],
      }),
    );
  }

  /**
   * Retires an entry after a fully successful release: removes it from the
   * active registry and caches the stream id in the existing bounded
   * completed-stream cache. Incomplete cleanup keeps the entry so a repeat
   * stop retries the preserved resources.
   */
  function retireRemoteWindowStream(entry: ActiveRemoteWindowStream) {
    if (entry.cleanupDone) {
      return;
    }
    entry.cleanupDone = true;
    if (entry.compositePollTimer) {
      clearInterval(entry.compositePollTimer);
      entry.compositePollTimer = null;
    }
    activeStreams.delete(entry.streamId);
    clearRemoteWindowStreamIceState(entry.streamId);
    entry.pendingFocusFrame = null;
    entry.pendingOverviewFrame = null;
    entry.reliableInputInFlightBySequence.clear();
    entry.reliableInputCompletedBySequence.clear();
    entry.continuousGestureState.clear();
  }

  function buildRemoteWindowStreamCleanupResult(
    sessionResult: ReturnType<typeof releaseRemoteWindowStreamSessionResources>,
    inputRelease?: RemoteWindowStreamInputReleaseProjection,
  ): RemoteWindowStreamCleanupResult {
    const remainingResources = [
      ...sessionResult.remainingResources,
      ...(inputRelease?.remaining ?? []),
    ];
    const errors: RemoteWindowStreamCleanupResourceError[] = [
      ...sessionResult.errors.map((error) => ({ resource: error.resource, message: error.message })),
      ...(inputRelease?.errors.map((message) => ({ message })) ?? []),
    ];
    let status: RemoteWindowStreamCleanupResult['status'];
    if (remainingResources.length === 0) {
      status = 'released';
    } else if (inputRelease?.status === 'failed') {
      status = 'failed';
    } else if (inputRelease?.status === 'unverified') {
      status = 'unverified';
    } else {
      status = 'cleanup_failed';
    }
    return { status, remainingResources, errors };
  }

  /**
   * Settles reliable input that was already admitted before the lease release.
   * The reliable tail never rejects; this simply waits for in-flight work to
   * drain so a native down cannot land after release.
   */
  async function settleReliableInputTail(entry: ActiveRemoteWindowStream) {
    await entry.reliableInputTail;
  }

  const cacheCompletedStop = (streamId: string, payload: RemoteWindowStreamStatusPayload) => {
    completedStops.set(streamId, payload);
    if (completedStops.size > 128) {
      const oldest = completedStops.keys().next().value;
      if (typeof oldest === 'string') {
        completedStops.delete(oldest);
      }
    }
  };

  /**
   * A stop whose release failed keeps the stream and its resources for retry.
   * Event-driven callers must surface that typed failure; they never discard
   * the promise silently.
   */
  const reportStopFailure = (entry: ActiveRemoteWindowStream, error: unknown) => {
    entry.handlers.sendStatus?.({
      requestId: entry.requestId,
      streamId: entry.streamId,
      purpose: entry.purpose,
      phase: 'streaming',
      framesSent: entry.framesSent,
      framesDropped: entry.framesDropped,
      message: `remote window stream stop failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  };

  /**
   * Fire-and-forget stop for event-driven triggers. The stop owner never
   * rejects; an incomplete cleanup is surfaced with its typed remaining
   * resources and preserved for retry.
   */
  const stopAndSurface = (entry: ActiveRemoteWindowStream, reason: string) => {
    void requestRemoteWindowStreamStop(entry.streamId, reason).then(
      (result) => {
        if ('cleanup' in result && result.cleanup && result.cleanup.status !== 'released' && result.cleanup.status !== 'absent') {
          reportStopFailure(entry, result.cleanup.errors.map((error) => error.message).join('; ') || result.cleanup.status);
        }
      },
      (error: unknown) => {
        reportStopFailure(entry, error);
      },
    );
  };

  /**
   * The one serialized async stop owner. Admission closes immediately, pending
   * answers are cancelled before any negotiation continuation, already admitted
   * input settles, then input-helper leases and session resources are released.
   * Any failure leaves the real session entry and resource references in place
   * for a retry with the same owner.
   */
  async function performRemoteWindowStreamStop(
    streamId: string,
    reason: string,
    requestId: string,
    purpose?: RemoteWindowStreamPurpose,
  ): Promise<RemoteWindowStreamStatusPayload | RemoteWindowStreamErrorPayload> {
    const entry = activeStreams.get(streamId);
    if (!entry) {
      const cachedReleased = completedStops.get(streamId);
      if (cachedReleased) {
        return {
          ...cachedReleased,
          requestId,
          ...(purpose ? { purpose } : {}),
        };
      }
      return {
        requestId,
        streamId,
        ...(purpose ? { purpose } : {}),
        phase: 'stopped',
        framesSent: 0,
        cleanup: { status: 'absent', remainingResources: [], errors: [] },
        message: 'remote window stream was not active',
      };
    }

    entry.admissionClosed = true;
    cancelPendingRemoteWindowAnswer(streamId);

    // Settle already admitted input before lease release.
    await settleReliableInputTail(entry);

    const inputReleasePromise = releaseRemoteWindowStreamInput(entry);
    const sessionResult = releaseRemoteWindowStreamSessionResources(entry);
    const inputRelease = await inputReleasePromise;
    const cleanup = buildRemoteWindowStreamCleanupResult(sessionResult, inputRelease);
    const message = cleanup.remainingResources.length === 0
      ? `remote window stream stopped: ${reason}`
      : `remote window stream cleanup incomplete: ${reason}`;

    if (cleanup.status === 'released') {
      retireRemoteWindowStream(entry);
      cacheCompletedStop(streamId, {
        requestId,
        streamId,
        purpose: entry.purpose,
        phase: 'stopped',
        framesSent: entry.framesSent,
        framesDropped: entry.framesDropped,
        cleanup,
        inputRelease,
        message,
      });
    }

    return {
      requestId,
      streamId,
      purpose: entry.purpose,
      phase: 'stopped',
      framesSent: entry.framesSent,
      framesDropped: entry.framesDropped,
      cleanup,
      inputRelease,
      message,
    };
  }

  function requestRemoteWindowStreamStop(
    streamId: string,
    reason: string,
    requestId?: string,
    purpose?: RemoteWindowStreamPurpose,
  ): Promise<RemoteWindowStreamStatusPayload | RemoteWindowStreamErrorPayload> {
    const existing = pendingStops.get(streamId);
    if (existing) {
      return existing.promise;
    }
    const entry = activeStreams.get(streamId);
    const requestIdForStatus = requestId || entry?.requestId || `rw-stop-${streamId}`;
    const operation: RemoteWindowStopOperation = {
      promise: performRemoteWindowStreamStop(streamId, reason, requestIdForStatus, purpose ?? entry?.purpose),
    };
    pendingStops.set(streamId, operation);
    void operation.promise.then(
      (result) => {
        if (pendingStops.get(streamId) === operation) {
          operation.result = result;
          pendingStops.delete(streamId);
        }
      },
      () => {
        if (pendingStops.get(streamId) === operation) {
          pendingStops.delete(streamId);
        }
      },
    );
    return operation.promise;
  }

  function isCurrentStream(entry: ActiveRemoteWindowStream) {
    return activeStreams.get(entry.streamId) === entry && !entry.cleanupDone && !entry.admissionClosed;
  }

  function isRemoteWindowPeerMediaReady(
    entry: ActiveRemoteWindowStream,
    lane: 'focus' | 'overview' = 'focus',
  ) {
    // A local description only means that the offer was created. Feeding the
    // RTCVideoSource before ICE is connected lets the encoder emit delta
    // frames while the receiver is still negotiating; Android then has no
    // decodable reference frame and builds an avoidable decoder backlog.
    // `answer-accepted` is a control-plane milestone, not streaming truth.
    // The lane's own capture source must be assigned before this lane may
    // dispatch its retained pending frame. Overview readiness never reuses the
    // focus source assignment.
    if (entry.admissionClosed) {
      return false;
    }
    const captureSource = lane === 'overview' ? entry.overviewCaptureSource : entry.captureSource;
    if (!captureSource) {
      return false;
    }
    const peerConnection = entry.peerConnection;
    if (!peerConnection) {
      return false;
    }
    return Boolean(
      peerConnection.localDescription
      && entry.remoteDescriptionApplied
      && (
        peerConnection.connectionState === 'connected'
        || peerConnection.iceConnectionState === 'connected'
        || peerConnection.iceConnectionState === 'completed'
      ),
    );
  }

  function sendRemoteWindowVideoFrame(
    entry: ActiveRemoteWindowStream,
    captureFrame: RemoteWindowCaptureFrame,
    lane: 'focus' | 'overview' = 'focus',
  ) {
    const i420Frame = convertRgbaToI420Frame(captureFrame, rgbaToI420);
    const videoSource = lane === 'overview' ? entry.overviewVideoSource : entry.videoSource;
    if (!videoSource) {
      return;
    }
    videoSource.onFrame(i420Frame);
    if (lane === 'overview') {
      entry.overviewFramesSent = (entry.overviewFramesSent ?? 0) + 1;
      return;
    }
    entry.framesSent += 1;
    if (entry.framesSent === 1) {
      entry.handlers.sendStatus?.({
        requestId: entry.requestId,
        streamId: entry.streamId,
        purpose: entry.purpose,
        phase: 'streaming',
        framesSent: entry.framesSent,
        frameWidth: captureFrame.width,
        frameHeight: captureFrame.height,
        ...(entry.canvasLayout ? { canvasLayout: entry.canvasLayout } : {}),
      });
    }
    if (entry.pendingFocusReady) {
      entry.handlers.sendFocusResult?.({
        ...entry.pendingFocusReady,
        phase: 'ready',
      });
      entry.pendingFocusReady = null;
    }
  }

  function scheduleRemoteWindowFrameDrain(
    entry: ActiveRemoteWindowStream,
    lane: 'focus' | 'overview',
  ) {
    const scheduledKey = lane === 'overview' ? 'overviewFrameDrainScheduled' : 'focusFrameDrainScheduled';
    if (entry[scheduledKey]) {
      return;
    }
    entry[scheduledKey] = true;
    setImmediate(() => {
      entry[scheduledKey] = false;
      if (!isCurrentStream(entry) || !isRemoteWindowPeerMediaReady(entry, lane)) {
        return;
      }
      const pending = takeRemoteWindowLatestFrame(entry, lane);
      if (!pending) {
        return;
      }
      if (nowMs() - pending.capturedAtMs > entry.maxFrameAgeMs) {
        const frameAgeMs = Math.max(0, nowMs() - pending.capturedAtMs);
        entry.framesDropped += 1;
        // An expired frame that never became visible must not surface as
        // streaming truth; the drop telemetry only claims streaming once the
        // stream has actually dispatched a first visible frame.
        entry.handlers.sendStatus?.({
          requestId: entry.requestId,
          streamId: entry.streamId,
          purpose: entry.purpose,
          phase: entry.framesSent > 0 ? 'streaming' : 'starting',
          lane,
          framesSent: entry.framesSent,
          framesDropped: entry.framesDropped,
          frameAgeMs,
          message: 'remote window capture frame expired',
        });
        if (lane === 'overview' ? entry.pendingOverviewFrame : entry.pendingFocusFrame) {
          scheduleRemoteWindowFrameDrain(entry, lane);
        }
        return;
      }
      try {
        sendRemoteWindowVideoFrame(entry, pending.frame, lane);
      } catch (error) {
        stopAndSurface(
          entry,
          `remote window frame conversion failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      if (lane === 'overview' ? entry.pendingOverviewFrame : entry.pendingFocusFrame) {
        scheduleRemoteWindowFrameDrain(entry, lane);
      }
    });
  }

  function flushPendingRemoteWindowVideoFrame(entry: ActiveRemoteWindowStream) {
    scheduleRemoteWindowFrameDrain(entry, 'focus');
  }

  function handleRemoteWindowCaptureFrame(
    entry: ActiveRemoteWindowStream,
    captureFrame: RemoteWindowCaptureFrame,
    lane: 'focus' | 'overview' = 'focus',
  ) {
    if (!isCurrentStream(entry)) {
      return;
    }
    enqueueRemoteWindowLatestFrame(entry, lane, captureFrame);
    if (isRemoteWindowPeerMediaReady(entry, lane)) {
      scheduleRemoteWindowFrameDrain(entry, lane);
    }
  }

  async function startStream(
    payload: RemoteWindowStreamStartRequestV2Payload,
    handlers: RemoteWindowStreamDaemonHandlers = {},
  ): Promise<RemoteWindowStreamStartedPayload | RemoteWindowStreamStartedOfferV2Payload | RemoteWindowStreamErrorPayload> {
    if (!payload.requestId || !payload.streamId) {
      return buildStreamError(payload, 'remote_window_stream_request_invalid', 'remote window stream start requires requestId and streamId', 'request-validation');
    }
    const targetId = payload.target?.streamTargetId || payload.streamId;
    const gate = runRemoteWindowDagpipeGate({
      requestId: payload.requestId,
      targetId,
      policy: { allowStream: true, allowQuality: true, fps: 30 },
    });
    if (!gate.ok || !isRemoteWindowDagpipeProjectionReady(gate)) {
      clearRemoteWindowStreamIceState(payload.streamId);
      return buildStreamError(
        payload,
        'remote_window_dagpipe_rejected',
        `DAGpipe remote window gate rejected stream start: ${gate.ok ? 'output contract missing' : gate.error}`,
        'stream-lifecycle',
      );
    }
    if (platform !== 'darwin') {
      clearRemoteWindowStreamIceState(payload.streamId);
      return buildStreamError(payload, 'remote_window_platform_unsupported', 'remote window stream is only available on macOS daemon hosts', 'platform-capability');
    }
    if (arch !== 'arm64' && arch !== 'x64') {
      clearRemoteWindowStreamIceState(payload.streamId);
      return buildStreamError(payload, 'remote_window_webrtc_abi_unsupported', `remote window WebRTC ABI is unsupported: ${platform}-${arch}`, 'platform-capability');
    }
    if (!captureBinary) {
      clearRemoteWindowStreamIceState(payload.streamId);
      return buildStreamError(
        payload,
        'remote_window_capture_binary_missing',
        'installed ScreenCaptureKit capture binary is required',
        'platform-capability',
      );
    }
    if (
      typeof RTCPeerConnection !== 'function'
      || typeof RTCSessionDescription !== 'function'
      || typeof RTCIceCandidate !== 'function'
      || typeof nonstandard?.RTCVideoSource !== 'function'
      || typeof nonstandard?.rgbaToI420 !== 'function'
    ) {
      clearRemoteWindowStreamIceState(payload.streamId);
      return buildStreamError(payload, 'remote_window_wrtc_capability_missing', 'remote window requires the native @roamhq/wrtc peer, video source, and RGBA converter capabilities', 'platform-capability');
    }
    if (activeStreams.has(payload.streamId)) {
      return buildStreamError(payload, 'remote_window_stream_exists', `remote window stream already exists: ${payload.streamId}`, 'stream-lifecycle');
    }
    const purpose: RemoteWindowStreamPurpose = payload.purpose ?? 'focus';
    let entry: ActiveRemoteWindowStream | null = null;
    let failureStage: RemoteWindowStreamFailureStage = 'request-validation';
    try {
      validateStreamTargetForCapture(payload.target);
      failureStage = 'media-plan-validation';
      const hasCompositeWindows = (payload.target.compositeWindows ?? []).length > 0;
      const expectedMediaPlan = hasCompositeWindows ? 'overview-plus-focus' : 'single-focus';
      const mediaPlanContract = getRemoteWindowMediaPlanV2Contract(expectedMediaPlan);
      const hasOverviewLane = mediaPlanContract.lanes.some((lane) => lane.role === 'overview');
      if (payload.mediaPlan !== expectedMediaPlan) {
        clearRemoteWindowStreamIceState(payload.streamId);
        return buildStreamError(
          payload,
          'remote_window_stream_media_plan_mismatch',
          `remote window media plan mismatch: expected ${expectedMediaPlan}, got ${payload.mediaPlan}`,
          'media-plan-validation',
        );
      }
      if (payload.mediaPlanVersion !== mediaPlanContract.version) {
        clearRemoteWindowStreamIceState(payload.streamId);
        return buildStreamError(
          payload,
          'remote_window_stream_media_plan_version_mismatch',
          `remote window media plan version mismatch: expected ${mediaPlanContract.version}, got ${String(payload.mediaPlanVersion)}`,
          'media-plan-validation',
        );
      }
      handlers.sendStatus?.({
        requestId: payload.requestId,
        streamId: payload.streamId,
        purpose,
        phase: 'starting',
        stage: 'capability-verified',
        capability: {
          mediaPlan: expectedMediaPlan,
          mediaPlanVersion: mediaPlanContract.version,
          lanes: mediaPlanContract.lanes,
          maxVideoLanes: mediaPlanContract.lanes.length === 2 ? 2 : 1,
          screenCaptureKit: true,
          typedPerLaneStatus: true,
          preflight: {
            wrtc: 'available',
            abi: 'supported',
            swiftHelper: 'configured',
            screenRecordingPermission: 'pending-capture',
            capture: 'pending',
            senderNegotiation: 'pending',
          },
        },
      });
      const inputHelperWarm = warmRemoteWindowInputHelperForTarget(payload.target)
        .then(() => null, (error: unknown) => (
          error instanceof Error ? error : new Error('remote window input helper warm failed')
        ));
      const peerConnection = createPeerConnection({
        iceServers: Array.isArray(payload.iceServers) ? payload.iceServers as unknown as RTCIceServer[] : [],
      });
      const videoSource = createVideoSource();
      const videoTrack = videoSource.createTrack();
      const requestedVideoProfile = normalizeRemoteWindowVideoProfile(payload.videoProfile);
      if (!requestedVideoProfile) {
        throw new Error('remote window stream start requires videoProfile');
      }
      // @ponytail: wrtc's sendonly transceiver path can negotiate an inactive
      // answer on real Android receivers. Attach a normal sender first; the
      // quality owner applies encodings after the answer is established.
      const videoSender = peerConnection.addTrack(
        videoTrack,
        new MediaStream({ id: videoTrack.id }),
      );
      const mediaBindings: RemoteWindowStreamMediaBinding[] = [{
        role: 'focus',
        epoch: 0,
        mediaStreamId: videoTrack.id,
        trackId: videoTrack.id,
      }];
      const streamFrameRate = requestedVideoProfile.maxFrameRateFps;
      const overviewFrameRate = requestedVideoProfile.overviewMaxFrameRateFps;
      let videoProfile: RemoteWindowVideoProfile | null = null;
      let videoProfileWarning: string | null = null;

      const initialPendingIceCandidates = [...pendingIceCandidatesByStream.entries()]
        .filter(([key]) => key === payload.streamId || key.startsWith(`${payload.streamId}\u0000`))
        .flatMap(([, candidates]) => candidates);
      const streamEntry: ActiveRemoteWindowStream = {
        streamId: payload.streamId,
        purpose,
        requestId: payload.requestId,
        targetId: payload.target.streamTargetId,
        target: payload.target,
        canvasLayout: buildRemoteWindowCanvasLayoutV1(payload.target, 1),
        layoutGeneration: 1,
        qualityRevision: 0,
        pendingQualityRevision: null,
        streamGroupId: payload.streamId,
        mediaPlan: payload.mediaPlan,
        mediaPlanVersion: payload.mediaPlanVersion,
        overviewTarget: null,
        overviewMainTarget: payload.target,
        peerConnection,
        videoSender: videoSender || null,
        videoSource,
        videoTrack,
        videoProfile,
        maxFrameAgeMs: requestedVideoProfile.maxFrameAgeMs,
        captureSource: null,
        compositePollTimer: null,
        handlers,
        framesSent: 0,
        framesDropped: 0,
        focusRevision: 0,
        pendingFocusReady: null,
        pendingFocusFrame: null,
        pendingOverviewFrame: hasOverviewLane ? null : undefined,
        focusFrameDrainScheduled: false,
        overviewFrameDrainScheduled: false,
        remoteDescriptionApplied: false,
        pendingIceCandidates: initialPendingIceCandidates,
        focusCaptureStartedReported: false,
        overviewCaptureStartedReported: false,
        cleanupDone: false,
        admissionClosed: false,
        reliableInputTail: Promise.resolve(),
        reliableInputInFlightBySequence: new Map(),
        reliableInputCompletedBySequence: new Map(),
        continuousGestureState: new Map(),
      };
      pendingIceCandidatesByStream.delete(iceGenerationKey(payload.streamId, payload.requestId));
      pendingIceCandidatesByStream.delete(payload.streamId);
      for (const key of pendingIceCandidatesByStream.keys()) {
        if (key.startsWith(`${payload.streamId}\u0000`)) pendingIceCandidatesByStream.delete(key);
      }
      entry = streamEntry;
      activeStreams.set(payload.streamId, streamEntry);

      if (hasOverviewLane) {
        streamEntry.overviewVideoSource = createVideoSource();
        streamEntry.overviewVideoTrack = streamEntry.overviewVideoSource.createTrack();
        streamEntry.overviewVideoSender = peerConnection.addTrack(
          streamEntry.overviewVideoTrack,
          new MediaStream({ id: 'overview' }),
        );
        mediaBindings.push({
          role: 'overview',
          epoch: 0,
          mediaStreamId: 'overview',
          trackId: streamEntry.overviewVideoTrack.id,
        });
      }

      peerConnection.onicecandidate = (event) => {
        if (!isCurrentStream(streamEntry) || !event.candidate) {
          return;
        }
        handlers.sendIceCandidate?.({
          requestId: payload.requestId,
          streamId: payload.streamId,
          purpose,
          candidate: normalizeIceCandidate(event.candidate),
        });
      };
      peerConnection.onconnectionstatechange = () => {
        if (!isCurrentStream(streamEntry)) {
          return;
        }
        const state = peerConnection.connectionState;
        if (state === 'connected') {
          flushPendingRemoteWindowVideoFrame(streamEntry);
          if (streamEntry.pendingOverviewFrame !== undefined && streamEntry.overviewVideoSource) {
            scheduleRemoteWindowFrameDrain(streamEntry, 'overview');
          }
        }
        if (state === 'failed' || state === 'closed') {
          stopAndSurface(streamEntry, `remote window WebRTC connection ${state}`);
        }
      };

      handlers.sendStatus?.({
        requestId: payload.requestId,
        streamId: payload.streamId,
        purpose,
        phase: 'starting',
        ...(videoProfileWarning
          ? { message: `video profile not applied: ${videoProfileWarning}` }
          : {}),
      });

      failureStage = 'offer-apply';
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      const answerPromise = waitForRemoteWindowAnswer(payload.streamId, payload.requestId);
      handlers.sendOffer?.({
          requestId: payload.requestId,
          streamId: payload.streamId,
          purpose,
          mediaPlan: expectedMediaPlan,
          mediaPlanVersion: 2,
          targetId: payload.target.streamTargetId,
          offer: normalizeRtcDescription(peerConnection.localDescription || offer, 'offer'),
          mediaBindings: Object.freeze(mediaBindings.map((binding) => Object.freeze({ ...binding }))),
          capture: {
            source: 'ScreenCaptureKit',
            frameWidth: 1,
            frameHeight: 1,
            frameRate: streamFrameRate,
            targetKind: payload.target.videoTarget.kind,
          },
          ...(streamEntry.canvasLayout ? { canvasLayout: streamEntry.canvasLayout } : {}),
          transport: { kind: 'webrtc-video' },
      });
      const answer = await answerPromise;
      await peerConnection.setRemoteDescription(createRtcSessionDescription(answer));
      streamEntry.remoteDescriptionApplied = true;
      for (const candidate of streamEntry.pendingIceCandidates.splice(0)) {
        await peerConnection.addIceCandidate(createRtcIceCandidate(candidate));
      }

      // Overview lane 只对真正组合（多个窗口）启用；单 app-window 目标不
      // 启动第二路 capture，避免 focus 与 overview 出现双份全分辨率采样。
      // focus（高码率主窗口）流：主窗口单独捕获全分辨率；组合模式时剥离 compositeWindows
      const focusTarget: RemoteWindowStreamTargetManifest = hasCompositeWindows
        ? { ...payload.target, compositeWindows: undefined }
        : payload.target;
      failureStage = 'focus-capture-start';
      const captureSource = await captureSourceFactory(focusTarget, {
        frameRate: streamFrameRate,
        maxCaptureWidth: requestedVideoProfile.maxCaptureWidth,
        maxCaptureHeight: requestedVideoProfile.maxCaptureHeight,
        startupTimeoutMs: captureStartupTimeoutMs,
        swiftBinary,
        captureBinary,
        onFrame: (frame) => {
          // A capture implementation may emit its first frame before this
          // factory promise resolves. Keep that frame in the single pending
          // media slot; the status owner publishes ready only after
          // streamEntry.captureSource is assigned and the frame is dispatched.
          if (isCurrentStream(streamEntry)) {
            handleRemoteWindowCaptureFrame(streamEntry, frame, 'focus');
          }
        },
        onError: (error) => {
          if (!isCurrentStream(streamEntry)) {
            return;
          }
          stopAndSurface(streamEntry, error.message || 'remote window capture failed');
        },
      });
      if (!isCurrentStream(streamEntry)) {
        captureSource.stop();
        throw new Error('remote window stream was closed before capture started');
      }
      streamEntry.captureSource = captureSource;
      // Source assignment is the readiness cause: dispatch the retained first
      // frame through the existing pending-frame drain, without a second
      // capture callback or a second ready state.
      flushPendingRemoteWindowVideoFrame(streamEntry);
      if (!streamEntry.focusCaptureStartedReported) {
        streamEntry.focusCaptureStartedReported = true;
        handlers.sendStatus?.({
          requestId: payload.requestId,
          streamId: payload.streamId,
          purpose,
          phase: 'starting',
          stage: 'capture-started',
          lane: 'focus',
        });
      }
      failureStage = 'input-helper-warm';
      const inputHelperWarmError = await inputHelperWarm;
      if (inputHelperWarmError) {
        throw inputHelperWarmError;
      }

      // 双流：组合 target 额外启动低码率总览（overview）捕获（全部窗口平铺 canvas）
      if (hasOverviewLane) {
        failureStage = 'overview-capture-start';
        const overviewCaptureSource = await captureSourceFactory(payload.target, {
          frameRate: overviewFrameRate,
          maxCaptureWidth: Math.min(960, requestedVideoProfile.maxCaptureWidth),
          maxCaptureHeight: Math.min(600, requestedVideoProfile.maxCaptureHeight),
          startupTimeoutMs: captureStartupTimeoutMs,
          swiftBinary,
          captureBinary,
          onFrame: (frame) => {
            if (!isCurrentStream(streamEntry)) {
              return;
            }
            if (!streamEntry.overviewCaptureStartedReported) {
              streamEntry.overviewCaptureStartedReported = true;
              streamEntry.handlers.sendStatus?.({
                requestId: streamEntry.requestId,
                streamId: streamEntry.streamId,
                purpose: streamEntry.purpose,
                phase: 'starting',
                stage: 'capture-started',
                lane: 'overview',
              });
            }
            handleRemoteWindowCaptureFrame(streamEntry, frame, 'overview');
          },
          onError: (error) => {
            if (!isCurrentStream(streamEntry)) {
              return;
            }
            stopAndSurface(streamEntry, error.message || 'remote window overview capture failed');
          },
        });
        if (!isCurrentStream(streamEntry)) {
          overviewCaptureSource.stop();
          throw new Error('remote window stream was closed before overview capture started');
        }
        streamEntry.overviewCaptureSource = overviewCaptureSource;
        scheduleRemoteWindowFrameDrain(streamEntry, 'overview');
        if (!streamEntry.overviewCaptureStartedReported) {
          streamEntry.overviewCaptureStartedReported = true;
          handlers.sendStatus?.({
            requestId: payload.requestId,
            streamId: payload.streamId,
            purpose,
            phase: 'starting',
            stage: 'capture-started',
            lane: 'overview',
          });
        }
        // 组合模式自动增删：周期刷新同 app 窗口 catalog → 只更新 overview 捕获
        streamEntry.compositePollTimer = setInterval(() => {
          if (!isCurrentStream(streamEntry)) {
            return;
          }
          void (async () => {
            const activeEntry = streamEntry;
            if (!activeEntry || !isCurrentStream(activeEntry)) {
              return;
            }
            try {
              // Composite auto-add/remove keeps its capture-layer live query cadence.
              const targets = await catalogRuntime.listAppWindowTargets();
              const sameApp = targets.filter((item) => (
                item.videoTarget.kind === 'app-window'
                && item.videoTarget.appBundleId === activeEntry.target.videoTarget.appBundleId
              ));
              const overviewTarget = activeEntry.overviewMainTarget ?? activeEntry.overviewTarget ?? activeEntry.target;
              const currentIds = new Set([
                overviewTarget.videoTarget.windowId,
                ...(overviewTarget.compositeWindows ?? []).map((w) => w.windowId),
              ]);
              const nextIds = sameApp.map((item) => item.videoTarget.windowId);
              if (
                nextIds.length === currentIds.size
                && nextIds.every((id) => currentIds.has(id))
              ) {
                return;
              }
              const overviewCapture = activeEntry.overviewCaptureSource;
              if (!overviewCapture?.updateTarget) {
                return;
              }
              const nextOverviewTarget: RemoteWindowStreamTargetManifest = {
                ...overviewTarget,
                compositeWindows: sameApp
                  .filter((item) => item.streamTargetId !== activeEntry.target.streamTargetId)
                  .map((item) => ({
                    windowId: item.videoTarget.windowId,
                    title: item.videoTarget.title,
                    windowBoundsTopLeftPx: item.videoTarget.windowBoundsTopLeftPx,
                    cropRectTopLeftPx: item.videoTarget.cropRectTopLeftPx,
                  })),
              };
              await overviewCapture.updateTarget(nextOverviewTarget);
              activeEntry.overviewTarget = nextOverviewTarget;
              activeEntry.layoutGeneration += 1;
              activeEntry.canvasLayout = buildRemoteWindowCanvasLayoutV1(
                nextOverviewTarget,
                activeEntry.layoutGeneration,
              );
              if (activeEntry.canvasLayout) {
                activeEntry.handlers.sendStatus?.({
                  requestId: activeEntry.requestId,
                  streamId: activeEntry.streamId,
                  purpose: activeEntry.purpose,
                  phase: 'streaming',
                  framesSent: activeEntry.framesSent,
                  canvasLayout: activeEntry.canvasLayout,
                });
              }
            } catch (error) {
              activeEntry.handlers.sendStatus?.({
                requestId: activeEntry.requestId,
                streamId: activeEntry.streamId,
                purpose: activeEntry.purpose,
                phase: 'streaming',
                framesSent: activeEntry.framesSent,
                message: `overview catalog/layout update rejected: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          })();
        }, 3_000);
      }

      if (!isCurrentStream(streamEntry)) {
        throw new Error('remote window stream was closed before media negotiation completed');
      }
      flushPendingRemoteWindowVideoFrame(streamEntry);
      try {
        await applyRemoteWindowStreamGroupQuality({
          requested: requestedVideoProfile,
          focusSender: videoSender || null,
          focusCaptureSource: streamEntry.captureSource,
          overviewSender: streamEntry.overviewVideoSender,
          overviewCaptureSource: streamEntry.overviewCaptureSource,
        });
        videoProfile = requestedVideoProfile;
        streamEntry.videoProfile = videoProfile;
      } catch (error) {
        videoProfileWarning = formatRemoteWindowVideoProfileError(error);
      }
      if (videoProfileWarning) {
        handlers.sendStatus?.({
          requestId: payload.requestId,
          streamId: payload.streamId,
          purpose,
          phase: 'starting',
          message: `video profile not applied: ${videoProfileWarning}`,
        });
      }

      return {
          requestId: payload.requestId,
          streamId: payload.streamId,
          purpose,
          mediaPlan: expectedMediaPlan,
          mediaPlanVersion: 2,
          targetId: payload.target.streamTargetId,
          offer: normalizeRtcDescription(peerConnection.localDescription, 'offer'),
          mediaBindings: Object.freeze(mediaBindings.map((binding) => Object.freeze({ ...binding }))),
          capture: {
            source: 'ScreenCaptureKit',
            frameWidth: captureSource.width,
            frameHeight: captureSource.height,
            frameRate: captureSource.frameRate,
            targetKind: payload.target.videoTarget.kind,
          },
          ...(streamEntry.canvasLayout ? { canvasLayout: streamEntry.canvasLayout } : {}),
          transport: { kind: 'webrtc-video' },
      };
    } catch (error) {
      const targetUnavailable = error instanceof RemoteWindowCaptureTargetUnavailableError;
      const targetOutOfDisplay = error instanceof RemoteWindowCaptureTargetOutOfDisplayError;
      const startErrorMessage = error instanceof Error ? error.message : 'remote window stream start failed';
      let cleanupMessage = '';
      if (entry) {
        // Rejected-start cleanup uses the same serialized stop owner; it can
        // never overwrite a successful stop or revive the stream.
        const stopResult = await requestRemoteWindowStreamStop(entry.streamId, startErrorMessage);
        if ('cleanup' in stopResult && stopResult.cleanup
          && stopResult.cleanup.status !== 'released' && stopResult.cleanup.status !== 'absent') {
          const detail = stopResult.cleanup.errors.map((item) => item.message).join('; ')
            || stopResult.cleanup.remainingResources.join(', ')
            || stopResult.cleanup.status;
          cleanupMessage = `; cleanup ${stopResult.cleanup.status}: ${detail}`;
        }
      }
      return buildStreamError(
        payload,
        targetUnavailable
          ? 'remote_window_target_not_found'
          : targetOutOfDisplay
            ? 'remote_window_target_out_of_display'
            : 'remote_window_stream_start_failed',
        `${startErrorMessage}${cleanupMessage}`,
        targetUnavailable || targetOutOfDisplay ? 'target-validation' : failureStage,
      );
    }
  }

  async function addIceCandidate(payload: RemoteWindowStreamIceCandidatePayload) {
    const candidate = {
      candidate: payload.candidate.candidate,
      sdpMid: payload.candidate.sdpMid ?? null,
      sdpMLineIndex: payload.candidate.sdpMLineIndex ?? null,
      usernameFragment: payload.candidate.usernameFragment ?? null,
    };
    const candidateFingerprint = JSON.stringify(candidate);
    const candidateError = (code: string, message: string) => {
      const error = new Error(message);
      error.name = code;
      return error;
    };
    const generationKey = iceGenerationKey(payload.streamId, payload.requestId);
    const fingerprints = iceCandidateFingerprintsByStream.get(generationKey) ?? new Set<string>();
    const streamFingerprints = iceCandidateFingerprintsByStream.get(payload.streamId);
    if (fingerprints.has(candidateFingerprint) || streamFingerprints?.has(candidateFingerprint)) {
      throw candidateError('remote_window_stream_candidate_duplicate', `remote window ICE candidate was already received: ${payload.streamId}`);
    }
    const entry = activeStreams.get(payload.streamId);
    if (!entry || entry.cleanupDone) {
      if (!pendingIceCandidatesByStream.has(generationKey) && pendingIceCandidatesByStream.size >= 32) {
        throw candidateError('remote_window_stream_candidate_queue_full', 'remote window ICE candidate stream queue is full');
      }
      const pending = pendingIceCandidatesByStream.get(generationKey) ?? [];
      if (pending.length >= 32) {
        throw candidateError('remote_window_stream_candidate_queue_full', `remote window ICE candidate queue is full: ${payload.streamId}`);
      }
      pending.push(candidate);
      pendingIceCandidatesByStream.set(generationKey, pending);
      fingerprints.add(candidateFingerprint);
      iceCandidateFingerprintsByStream.set(generationKey, fingerprints);
      if (generationKey !== payload.streamId) iceCandidateFingerprintsByStream.set(payload.streamId, new Set(fingerprints));
      return true;
    }
    if (!entry.remoteDescriptionApplied) {
      if (entry.pendingIceCandidates.length >= 32) {
        throw candidateError('remote_window_stream_candidate_queue_full', `remote window ICE candidate queue is full: ${payload.streamId}`);
      }
      entry.pendingIceCandidates.push(candidate);
      fingerprints.add(candidateFingerprint);
      iceCandidateFingerprintsByStream.set(generationKey, fingerprints);
      if (generationKey !== payload.streamId) iceCandidateFingerprintsByStream.set(payload.streamId, new Set(fingerprints));
      return true;
    }
    const peerConnection = entry.peerConnection;
    if (!peerConnection) {
      throw candidateError('remote_window_stream_candidate_unavailable', `remote window ICE candidate found no active peer connection: ${payload.streamId}`);
    }
    await peerConnection.addIceCandidate(createRtcIceCandidate(candidate));
    fingerprints.add(candidateFingerprint);
    iceCandidateFingerprintsByStream.set(generationKey, fingerprints);
    if (generationKey !== payload.streamId) iceCandidateFingerprintsByStream.set(payload.streamId, new Set(fingerprints));
    flushPendingRemoteWindowVideoFrame(entry);
    return true;
  }

  async function acceptAnswer(payload: RemoteWindowStreamAnswerV2Payload) {
    if (payload.mediaPlanVersion !== 2 || payload.answer.type !== 'answer') {
      throw new Error('remote window v2 answer contract is invalid');
    }
    const key = answerKey(payload.streamId, payload.requestId);
    const pending = pendingAnswers.get(key);
    if (!pending) {
      const entry = activeStreams.get(payload.streamId);
      if ((entry && (entry.admissionClosed || entry.cleanupDone)) || completedStops.has(payload.streamId)) {
        const cancelled = new Error(`remote window stream answer cancelled: ${payload.streamId}/${payload.requestId}`);
        cancelled.name = REMOTE_WINDOW_STREAM_ANSWER_CANCELLED_CODE;
        throw cancelled;
      }
      throw new Error(`remote window v2 answer has no pending offer: ${payload.streamId}/${payload.requestId}`);
    }
    pendingAnswers.delete(key);
    clearTimeout(pending.timeoutId);
    const entry = activeStreams.get(payload.streamId);
    if (entry && (entry.admissionClosed || entry.cleanupDone)) {
      const cancelled = new Error(`remote window stream answer cancelled: ${payload.streamId}/${payload.requestId}`);
      cancelled.name = REMOTE_WINDOW_STREAM_ANSWER_CANCELLED_CODE;
      pending.reject(cancelled);
      return false;
    }
    pending.resolve({ type: 'answer', sdp: payload.answer.sdp });
    return true;
  }

  async function stopStream(
    payload: RemoteWindowStreamStopRequestPayload,
  ): Promise<RemoteWindowStreamStatusPayload | RemoteWindowStreamErrorPayload> {
    if (!payload.requestId || !payload.streamId) {
      return buildStreamError(payload, 'remote_window_stream_stop_invalid', 'remote window stream stop requires requestId and streamId');
    }
    return requestRemoteWindowStreamStop(
      payload.streamId,
      'remote window stream stopped',
      payload.requestId,
      payload.purpose,
    );
  }

  async function updateStreamQuality(
    payload: RemoteWindowStreamQualityRequestPayload,
  ): Promise<RemoteWindowStreamQualityResultPayload | RemoteWindowStreamErrorPayload> {
    if (!payload.requestId || !payload.streamId || !payload.targetId) {
      return buildStreamError(payload, 'remote_window_stream_quality_invalid', 'remote window stream quality requires requestId, streamId, and targetId');
    }
    const entry = activeStreams.get(payload.streamId);
    if (!entry || entry.cleanupDone) {
      return buildStreamError(payload, 'remote_window_stream_quality_missing', `remote window stream is not active: ${payload.streamId}`);
    }
    if (payload.targetId !== entry.targetId) {
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        streamGroupId: payload.streamGroupId,
        mediaPlan: payload.mediaPlan,
        mediaPlanVersion: payload.mediaPlanVersion,
        revision: payload.revision,
        purpose: entry.purpose,
        targetId: payload.targetId,
        status: 'rejected',
        requestedVideoProfile: payload.videoProfile,
        error: {
          code: 'remote_window_stream_quality_target_mismatch',
          message: `remote window stream quality target mismatch: ${payload.targetId}`,
        },
      };
    }
    if (payload.mediaPlan !== entry.mediaPlan || payload.mediaPlanVersion !== entry.mediaPlanVersion) {
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        streamGroupId: payload.streamGroupId,
        mediaPlan: payload.mediaPlan,
        mediaPlanVersion: payload.mediaPlanVersion,
        revision: payload.revision,
        purpose: entry.purpose,
        targetId: payload.targetId,
        status: 'rejected',
        requestedVideoProfile: payload.videoProfile,
        error: {
          code: 'remote_window_stream_quality_media_plan_mismatch',
          message: `remote window stream quality media plan mismatch: expected ${entry.mediaPlan}@${entry.mediaPlanVersion}, got ${payload.mediaPlan}@${payload.mediaPlanVersion}`,
        },
      };
    }
    if (payload.streamGroupId !== entry.streamGroupId || !Number.isSafeInteger(payload.revision) || payload.revision <= entry.qualityRevision) {
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        streamGroupId: payload.streamGroupId,
        mediaPlan: payload.mediaPlan,
        mediaPlanVersion: payload.mediaPlanVersion,
        revision: payload.revision,
        purpose: entry.purpose,
        targetId: payload.targetId,
        status: 'rejected',
        requestedVideoProfile: payload.videoProfile,
        error: {
          code: 'remote_window_stream_quality_stale',
          message: `remote window stream quality revision is stale: ${payload.revision}`,
        },
      };
    }
    if (entry.pendingQualityRevision !== null) {
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        streamGroupId: payload.streamGroupId,
        mediaPlan: payload.mediaPlan,
        mediaPlanVersion: payload.mediaPlanVersion,
        revision: payload.revision,
        purpose: entry.purpose,
        targetId: payload.targetId,
        status: 'rejected',
        requestedVideoProfile: payload.videoProfile,
        error: {
          code: 'remote_window_stream_quality_busy',
          message: `remote window stream quality revision ${entry.pendingQualityRevision} is still applying`,
        },
      };
    }
    const qualityGate = runRemoteWindowDagpipeGate({
      requestId: payload.requestId,
      targetId: payload.targetId,
      quality: {
        targetId: payload.targetId,
        mode: payload.videoProfile.preference,
      },
      policy: { allowStream: true, allowQuality: true, fps: payload.videoProfile.maxFrameRateFps },
    });
    if (!qualityGate.ok || !isRemoteWindowDagpipeProjectionReady(qualityGate)) {
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        streamGroupId: payload.streamGroupId,
        mediaPlan: payload.mediaPlan,
        mediaPlanVersion: payload.mediaPlanVersion,
        revision: payload.revision,
        purpose: entry.purpose,
        targetId: payload.targetId,
        status: 'rejected',
        requestedVideoProfile: payload.videoProfile,
        error: {
          code: 'remote_window_dagpipe_rejected',
          message: `DAGpipe remote window quality gate rejected: ${qualityGate.ok ? 'output contract missing' : qualityGate.error}`,
        },
      };
    }
    entry.pendingQualityRevision = payload.revision;
    try {
      const videoProfile = normalizeRemoteWindowVideoProfile(payload.videoProfile);
      if (!videoProfile) {
        throw new Error('remote window stream quality requires videoProfile');
      }
      const appliedGroupBudget = await applyRemoteWindowStreamGroupQuality({
        requested: videoProfile,
        focusSender: entry.videoSender,
        focusCaptureSource: entry.captureSource,
        overviewSender: entry.overviewVideoSender,
        overviewCaptureSource: entry.overviewCaptureSource,
      });
      entry.videoProfile = videoProfile;
      entry.maxFrameAgeMs = videoProfile.maxFrameAgeMs;
      entry.qualityRevision = payload.revision;
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        streamGroupId: payload.streamGroupId,
        mediaPlan: payload.mediaPlan,
        mediaPlanVersion: payload.mediaPlanVersion,
        revision: payload.revision,
        purpose: entry.purpose,
        targetId: payload.targetId,
        status: 'applied',
        requestedVideoProfile: payload.videoProfile,
        appliedVideoProfile: videoProfile,
        appliedGroupBudget,
      };
    } catch (error) {
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        streamGroupId: payload.streamGroupId,
        mediaPlan: payload.mediaPlan,
        mediaPlanVersion: payload.mediaPlanVersion,
        revision: payload.revision,
        purpose: entry.purpose,
        targetId: payload.targetId,
        status: 'rejected',
        requestedVideoProfile: payload.videoProfile,
        error: {
          code: error instanceof RemoteWindowQualityUnsupportedError
            ? REMOTE_WINDOW_STREAM_QUALITY_UNSUPPORTED_CODE
            : 'remote_window_stream_quality_failed',
          message: formatRemoteWindowVideoProfileError(error),
        },
      };
    } finally {
      if (entry.pendingQualityRevision === payload.revision) {
        entry.pendingQualityRevision = null;
      }
    }
  }

  async function updateFocus(
    payload: RemoteWindowStreamUpdateFocusRequestPayload,
  ): Promise<RemoteWindowStreamFocusResultPayload | RemoteWindowStreamErrorPayload> {
    if (!payload.requestId || !payload.streamId || !payload.target?.videoTarget?.windowId) {
      return buildStreamError(payload, 'remote_window_stream_update_focus_invalid', 'remote window update focus requires requestId, streamId, and target');
    }
    const entry = activeStreams.get(payload.streamId);
    if (!entry || entry.cleanupDone) {
      return buildStreamError(payload, 'remote_window_stream_missing', `remote window stream is not active: ${payload.streamId}`);
    }
    if (!Number.isInteger(payload.revision) || payload.revision <= entry.focusRevision) {
      return buildStreamError(payload, 'remote_window_stream_update_focus_stale', `remote window focus revision is stale: ${payload.revision}`);
    }
    if (entry.pendingFocusReady) {
      // A focus-ready for the previous revision is still pending (its first
      // frame has not been emitted yet). Accepting another update would
      // overwrite that pending ready and the earlier client switch would hang
      // in focus-updating forever. Reject explicitly so the client fails the
      // switch instead.
      return buildStreamError(payload, 'remote_window_stream_update_focus_busy', 'remote window focus update already in flight');
    }
    const captureSource = entry.captureSource;
    if (!captureSource?.updateTarget) {
      return buildStreamError(payload, 'remote_window_stream_update_focus_unsupported', 'focus capture source cannot update target');
    }
    // focus（高码率主窗口）流剥离组合窗口，只捕获新主窗口
    const focusTarget: RemoteWindowStreamTargetManifest = {
      ...payload.target,
      compositeWindows: undefined,
    };
    await captureSource.updateTarget(focusTarget);
    entry.focusRevision = payload.revision;
    entry.pendingFocusReady = {
      requestId: payload.requestId,
      streamId: payload.streamId,
      revision: payload.revision,
      targetId: payload.target.streamTargetId,
      phase: 'accepted',
    };
    // 保留组合窗口清单（overview 流用），只替换主窗口
    entry.target = {
      ...entry.target,
      videoTarget: payload.target.videoTarget,
    };
    entry.targetId = payload.target.streamTargetId;
    return {
      requestId: payload.requestId,
      streamId: payload.streamId,
      revision: payload.revision,
      targetId: payload.target.streamTargetId,
      phase: 'accepted',
    };
  }

  const buildInputAck = (
    control: RemoteWindowInputDeliveryControl,
    payload: RemoteWindowInputEventPayload,
    options: {
      accepted: boolean;
      duplicate?: boolean;
      error?: { code: string; message: string; retryable?: boolean };
      result?: Omit<RemoteWindowInputResultPayload, 'streamId' | 'targetId'>;
    },
  ): RemoteWindowInputAck => ({
    control: {
      version: 1,
      sequence: control.sequence,
      accepted: options.accepted,
      retryable: options.error?.retryable === true,
      duplicate: options.duplicate === true,
      receivedAtMs: nowMs(),
      ...(options.error ? {
        error: {
          code: options.error.code,
          message: truncateRemoteWindowErrorMessage(options.error.message),
        },
      } : {}),
    },
    payload: {
      streamId: payload.streamId,
      targetId: payload.targetId,
      ...options.result,
    },
  });

  const validateInputDeliveryControl = (
    payload: RemoteWindowInputEventPayload,
    control: RemoteWindowInputDeliveryControl,
  ) => {
    if (
      control.version !== 1
      || !control.sequence.trim()
      || !Number.isInteger(control.attempt)
      || control.attempt < 1
      || !Number.isFinite(control.sentAtMs)
    ) {
      throw new Error('remote window input delivery control is invalid');
    }
    const continuous = payload.event.kind === 'scroll'
      || (payload.event.kind === 'pointer' && payload.event.phase === 'move');
    const expectedLane = continuous ? 'continuous' : 'reliable';
    if (payload.deliveryKind !== undefined && payload.deliveryKind !== (continuous ? 'sample' : 'action')) {
      throw new Error(`remote window input delivery kind mismatch: expected ${continuous ? 'sample' : 'action'}`);
    }
    if (control.lane !== expectedLane) {
      throw new Error(`remote window input delivery lane mismatch: expected ${expectedLane}`);
    }
  };

  const executeInput = async (
    entry: ActiveRemoteWindowStream,
    payload: RemoteWindowInputEventPayload,
    control: RemoteWindowInputDeliveryControl,
    daemonReceivedAtMs: number,
  ): Promise<RemoteWindowInputResultPayload> => {
    validateRemoteWindowInputPayload(payload, {
      targetId: entry.targetId,
      target: entry.target,
      canvasLayout: entry.canvasLayout,
    });
    const mappedPayload: RemoteWindowInputEventPayload = {
      ...payload,
      event: buildRemoteWindowInputConfig(payload, entry.target, {
        daemonReceivedAtMs,
        canvasLayout: entry.canvasLayout,
      }).event,
    };
    const action = mappedPayload.event;
    const inputGate = runRemoteWindowDagpipeGate({
      requestId: entry.requestId,
      targetId: entry.targetId,
      windows: [{ id: entry.targetId }],
      touch: {
        kind: action.kind,
        ...('x' in action ? { x: action.x } : {}),
        ...('y' in action ? { y: action.y } : {}),
      },
      quality: { targetId: entry.targetId, mode: 'balanced' },
      policy: { allowStream: true, allowQuality: true, fps: 30 },
    });
    if (!inputGate.ok || !isRemoteWindowDagpipeProjectionReady(inputGate)) {
      throw new Error(
        `dagpipe remote window input gate rejected: ${inputGate.ok ? 'output contract missing' : inputGate.error}`,
      );
    }
    if (payload.event.kind === 'window-resize') {
      // Preflight uses only the existing display-bound guard. The ACK/capture
      // target is still built from the native readback, never this prediction.
      validateStreamTargetForCapture(buildResizedRemoteWindowTarget(
        entry.target,
        payload.event,
        now(),
      ));
    }
    const operationResult = await runRemoteWindowInputEvent(mappedPayload, entry.target, {
      swiftBinary,
      runTmux: deps.runTmux,
      daemonReceivedAtMs,
      delivery: {
        lane: control.lane,
        ...(control.lane === 'continuous' ? { maxAgeMs: entry.maxFrameAgeMs } : {}),
      },
    });
    if (payload.event.kind === 'window-resize') {
      if (operationResult?.kind !== 'window-resize') {
        throw new Error('remote window resize native readback missing');
      }
      const resized = await applyRemoteWindowTargetResize(
        entry,
        operationResult,
        now(),
        () => {
          if (!isCurrentStream(entry)) {
            throw new Error('remote window stream closed during resize');
          }
        },
      );
      return {
        streamId: payload.streamId,
        targetId: payload.targetId,
        target: resized.target,
        capture: resized.capture,
      };
    }
    return {
      streamId: payload.streamId,
      targetId: payload.targetId,
    };
  };

  const rememberCompletedReliableInput = (
    entry: ActiveRemoteWindowStream,
    sequence: string,
    message: RemoteWindowInputAck,
  ) => {
    entry.reliableInputCompletedBySequence.set(sequence, message);
    if (entry.reliableInputCompletedBySequence.size > 256) {
      const oldest = entry.reliableInputCompletedBySequence.keys().next().value;
      if (typeof oldest === 'string') {
        entry.reliableInputCompletedBySequence.delete(oldest);
      }
    }
  };

  async function injectInput(
    payload: RemoteWindowInputEventPayload,
    control: RemoteWindowInputDeliveryControl,
  ): Promise<RemoteWindowInputAck | null> {
    try {
      validateInputDeliveryControl(payload, control);
    } catch (error) {
      return buildInputAck(control, payload, {
        accepted: false,
        error: {
          code: 'remote_window_input_delivery_invalid',
          message: error instanceof Error ? error.message : 'remote window input delivery control is invalid',
        },
      });
    }
    const entry = activeStreams.get(payload.streamId);
    if (!entry || entry.cleanupDone || entry.admissionClosed) {
      return buildInputAck(control, payload, {
        accepted: false,
        error: {
          code: 'remote_window_input_stream_missing',
          message: `remote window stream is not active: ${payload.streamId || 'missing'}`,
        },
      });
    }
    if (payload.event.kind === 'close-window') {
      // The single remote-window close owner is requestRemoteWindowClose
      // (forwarded through remote-window-close-request). Rejecting the legacy
      // close-window input lane avoids a second, unobserved close injection.
      return buildInputAck(control, payload, {
        accepted: false,
        error: {
          code: 'remote_window_close_unsupported',
          message: 'remote window close must use the remote-window-close-request control path',
        },
      });
    }
    const daemonReceivedAtMs = nowMs();
    if (control.lane === 'continuous') {
      if (payload.event.kind === 'scroll' && payload.event.gestureId && Number.isFinite(payload.sampledAtMs)) {
        const phase = payload.event.phase;
        const previous = entry.continuousGestureState.get(payload.event.gestureId);
        if (previous && (previous.ended || Number(payload.sampledAtMs) < previous.lastSampledAtMs)) {
          return null;
        }
        if (phase === 'start' && previous) {
          return null;
        }
        if (phase === 'update' && previous?.ended) {
          return null;
        }
        entry.continuousGestureState.set(payload.event.gestureId, {
          lastSampledAtMs: Math.max(previous?.lastSampledAtMs ?? Number(payload.sampledAtMs), Number(payload.sampledAtMs)),
          ended: phase === 'end',
        });
      }
      try {
        const result = await executeInput(entry, payload, control, daemonReceivedAtMs);
        return buildInputAck(control, payload, {
          accepted: true,
          result: {
            ...(result.target ? { target: result.target } : {}),
            ...(result.capture ? { capture: result.capture } : {}),
          },
        });
      } catch (error) {
        return buildInputAck(control, payload, {
          accepted: false,
          error: {
            code: 'remote_window_input_failed',
            message: error instanceof Error ? error.message : 'remote window input failed',
          },
        });
      }
    }
    const completed = entry.reliableInputCompletedBySequence.get(control.sequence);
    if (completed) {
      return {
        ...completed,
        control: { ...completed.control, duplicate: true, receivedAtMs: nowMs() },
      };
    }
    const active = entry.reliableInputInFlightBySequence.get(control.sequence);
    if (active) {
      const result = await active;
      return {
        ...result,
        control: { ...result.control, duplicate: true, receivedAtMs: nowMs() },
      };
    }
    const task = entry.reliableInputTail.then(async () => {
      if (!isCurrentStream(entry)) {
        return buildInputAck(control, payload, {
          accepted: false,
          error: {
            code: 'remote_window_input_stream_missing',
            message: `remote window stream is not active: ${payload.streamId || 'missing'}`,
          },
        });
      }
      try {
        const result = await executeInput(entry, payload, control, daemonReceivedAtMs);
        return buildInputAck(control, payload, {
          accepted: true,
          result: {
            ...(result.target ? { target: result.target } : {}),
            ...(result.capture ? { capture: result.capture } : {}),
          },
        });
      } catch (error) {
        return buildInputAck(control, payload, {
          accepted: false,
          error: {
            code: 'remote_window_input_failed',
            message: error instanceof Error ? error.message : 'remote window input failed',
          },
        });
      }
    });
    entry.reliableInputTail = task.then(() => undefined, () => undefined);
    entry.reliableInputInFlightBySequence.set(control.sequence, task);
    const result = await task;
    if (entry.reliableInputInFlightBySequence.get(control.sequence) === task) {
      entry.reliableInputInFlightBySequence.delete(control.sequence);
    }
    if (isCurrentStream(entry)) {
      rememberCompletedReliableInput(entry, control.sequence, result);
    }
    return result;
  }

  async function requestRemoteWindowClose(
    payload: RemoteWindowCloseRequestPayload,
  ): Promise<RemoteWindowCloseResultPayload> {
    const base = {
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      streamId: payload.streamId,
      targetId: payload.targetId,
    };
    if (!payload.requestId || !payload.sessionId || !payload.streamId || !payload.targetId) {
      return { ...base, status: 'failed', error: 'remote window close request requires requestId, sessionId, streamId, and targetId' };
    }
    const entry = activeStreams.get(payload.streamId);
    if (!entry || entry.cleanupDone) {
      return { ...base, status: 'failed', error: `remote window stream is not active: ${payload.streamId}` };
    }
    if (payload.targetId !== entry.targetId) {
      return { ...base, status: 'failed', error: `remote window close target mismatch: ${payload.targetId}` };
    }
    const supportedTarget = entry.target.videoTarget.kind === 'app-window'
      && entry.target.inputRoute === 'os-event'
      && entry.target.streamMode === 'interactive';
    if (!supportedTarget) {
      return { ...base, status: 'unsupported', error: 'remote window close is only supported for interactive app-window OS-event targets' };
    }
    try {
      const closePayload: RemoteWindowInputEventPayload = {
        streamId: entry.streamId,
        targetId: entry.targetId,
        event: { kind: 'close-window' },
      };
      await runRemoteWindowInputEvent(closePayload, entry.target, {
        swiftBinary,
        runTmux: deps.runTmux,
        daemonReceivedAtMs: nowMs(),
        delivery: { lane: 'reliable' },
      });
    } catch (error) {
      return { ...base, status: 'failed', error: `remote window close injection failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const injectedAtMs = nowMs();
    const observation = await catalogRuntime.awaitAppWindowCloseObservation({
      windowId: entry.target.videoTarget.windowId,
      ...(typeof entry.target.videoTarget.pid === 'number' ? { pid: entry.target.videoTarget.pid } : {}),
      injectedAtMs,
    });
    if (observation.status === 'closed' || observation.status === 'not_closed') {
      return { ...base, status: observation.status };
    }
    return { ...base, status: observation.status, error: observation.error };
  }

  /**
   * Async runtime disposal. Every active stream is released through the same
   * serialized stop owner, then the catalog and input helper are disposed. The
   * returned promise is the single disposal outcome; callers must await it
   * before process exit, and a failed release rejects instead of being
   * swallowed. Concurrent callers share the same promise.
   */
  function dispose(reason = 'remote window daemon runtime disposed'): Promise<void> {
    if (!disposePromise) {
      disposePromise = (async () => {
        const stopResults = await Promise.all(
          Array.from(activeStreams.values()).map((entry) => requestRemoteWindowStreamStop(entry.streamId, reason)),
        );
        pendingIceCandidatesByStream.clear();
        iceCandidateFingerprintsByStream.clear();
        catalogRuntime.dispose();
        const helper = remoteWindowInputHelper as (RemoteWindowInputHelper & RemoteWindowStreamInputHelperRelease) | null;
        remoteWindowInputHelper = null;
        if (helper) {
          await helper.dispose();
        }
        const unreleased = stopResults.filter((result) => (
          'cleanup' in result && result.cleanup
          && result.cleanup.status !== 'released' && result.cleanup.status !== 'absent'
        ));
        if (unreleased.length > 0) {
          throw new Error(
            `remote window daemon disposal left ${unreleased.length} stream(s) unreleased: ${unreleased
              .map((result) => ('cleanup' in result && result.cleanup ? `${result.streamId}:${result.cleanup.status}` : result.streamId))
              .join(', ')}`,
          );
        }
      })();
    }
    return disposePromise;
  }

  if (deps.warmTargetCatalogOnStart) {
    catalogRuntime.warm();
  }

  return {
    listTargets: async (payload) => {
      const result = await catalogRuntime.listTargets(payload);
      if ('targets' in result && result.targets.length > 0) {
        const firstTarget = result.targets[0]!;
        const gate = runRemoteWindowDagpipeGate({
          requestId: payload.requestId,
          targetId: firstTarget.streamTargetId,
          windows: result.targets.map((target) => ({
            id: target.streamTargetId,
            name: target.videoTarget.title ?? '',
          })),
          quality: { targetId: firstTarget.streamTargetId, mode: 'balanced' },
        });
        if (!gate.ok || !isRemoteWindowDagpipeProjectionReady(gate)) {
          return buildStreamError(
            payload,
            'remote_window_dagpipe_rejected',
            `DAGpipe remote window catalog gate rejected: ${gate.ok ? 'output contract missing' : gate.error}`,
          );
        }
      }
      return result;
    },
    startStream,
    acceptAnswer,
    addIceCandidate,
    stopStream,
    requestRemoteWindowClose,
    updateStreamQuality,
    updateFocus,
    injectInput,
    setBrowserUserAgent,
    dispose,
  };
}
