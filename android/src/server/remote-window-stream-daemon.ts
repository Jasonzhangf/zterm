import wrtc from '@roamhq/wrtc';

import {
  normalizeRtcDescription,
  normalizeIceCandidate,
  normalizeRemoteWindowVideoBitrateConfig,
  formatRemoteWindowVideoBitrateError,
  convertRgbaToI420Frame,
} from './remote-window-stream-daemon-helpers';
import type {
  RemoteWindowStreamIceCandidatePayload,
  RemoteWindowInputEventPayload,
  RemoteWindowInputResultPayload,
  RemoteWindowCanvasLayoutV1,
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamRequestPayload,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowStreamPurpose,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamStartRequestPayload,
  RemoteWindowStreamStatusPayload,
  RemoteWindowStreamStopRequestPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowStreamUpdateFocusRequestPayload,
  RemoteWindowStreamFocusResultPayload,
  RemoteWindowVideoBitrateConfig,
} from '@zterm/shared/protocol';
import { buildRemoteWindowCanvasLayoutV1 } from './remote-window-canvas-layout';
import { applyRemoteWindowStreamGroupQuality } from './remote-window-quality';
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
} from './remote-window-catalog';
import { createRemoteWindowCatalogRuntime } from './remote-window-catalog-runtime';
import {
  buildRemoteWindowInputConfig,
  createDefaultRemoteWindowInputHelper,
  type RemoteWindowInputEventRunner,
  type RemoteWindowInputHelper,
} from './remote-window-input-helper';
import { validateRemoteWindowInputPayload } from './remote-window-input-policy';
import {
  DEFAULT_SCREEN_CAPTURE_KIT_STARTUP_TIMEOUT_MS,
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

const DEFAULT_REMOTE_WINDOW_FRAME_RATE = 30;
const DEFAULT_REMOTE_WINDOW_TARGET_CATALOG_CACHE_TTL_MS = 60_000;
// 双流：总览（overview）流固定低码率 + 低帧率（组合画布整体预览/即时切换占位）
const OVERVIEW_FRAME_RATE_FPS = 8;
/** 远程窗口输入 bring-to-focus 防抖：该窗口内只每 3s 最多执行一次 focus 切换 */
const REMOTE_WINDOW_FOCUS_DEBOUNCE_MS = 15_000;

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
  nonstandard,
} = wrtc as unknown as {
  RTCPeerConnection: RtcPeerConnectionCtor;
  RTCSessionDescription: RtcSessionDescriptionCtor;
  RTCIceCandidate: RtcIceCandidateCtor;
  nonstandard: {
    RTCVideoSource: { new (init?: { isScreencast?: boolean; needsDenoising?: boolean }): RtcVideoSourceLike };
    rgbaToI420: (rgba: RtcVideoFrame, i420: RtcVideoFrame) => void;
  };
};

export interface RemoteWindowStreamDaemonDeps {
  platform?: NodeJS.Platform;
  now?: () => string;
  pythonBinary?: string;
  swiftBinary?: string;
  captureBinary?: string;
  iterm2PythonTimeoutMs?: number;
  appWindowCatalogTimeoutMs?: number;
  targetCatalogCacheTtlMs?: number;
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
    payload: RemoteWindowStreamStartRequestPayload,
    handlers?: RemoteWindowStreamDaemonHandlers,
  ) => Promise<RemoteWindowStreamStartedPayload | RemoteWindowStreamErrorPayload>;
  addIceCandidate: (payload: RemoteWindowStreamIceCandidatePayload) => Promise<boolean>;
  stopStream: (
    payload: RemoteWindowStreamStopRequestPayload,
  ) => Promise<RemoteWindowStreamStatusPayload | RemoteWindowStreamErrorPayload>;
  updateStreamQuality: (
    payload: RemoteWindowStreamQualityRequestPayload,
  ) => Promise<RemoteWindowStreamQualityResultPayload | RemoteWindowStreamErrorPayload>;
  updateFocus: (
    payload: RemoteWindowStreamUpdateFocusRequestPayload,
  ) => Promise<RemoteWindowStreamFocusResultPayload | RemoteWindowStreamErrorPayload>;
  injectInput: (
    payload: RemoteWindowInputEventPayload,
  ) => Promise<RemoteWindowInputResultPayload | RemoteWindowStreamErrorPayload>;
  dispose: (reason?: string) => void;
}

export interface RemoteWindowStreamDaemonHandlers {
  sendIceCandidate?: (payload: RemoteWindowStreamIceCandidatePayload) => void;
  sendStatus?: (payload: RemoteWindowStreamStatusPayload) => void;
  sendFocusResult?: (payload: RemoteWindowStreamFocusResultPayload) => void;
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
  overviewTarget: RemoteWindowStreamTargetManifest | null;
  // overview 画布主窗口固定为流的初始 target：focus 切换只改 entry.target，
  // 不漂移 overview 画布（client 的 state.target 也不随 focus 切换更新，
  // 两者必须保持对齐，否则缩略图/crop 坐标错位）。
  overviewMainTarget: RemoteWindowStreamTargetManifest | null;
  // focus（高码率主窗口）流：主 track
  videoSender: RTCRtpSender | null;
  videoSource: RtcVideoSourceLike;
  videoBitrate: RemoteWindowVideoBitrateConfig | null;
  // overview（低码率总览）流：组合 target 时启用
  overviewVideoSender?: RTCRtpSender | null;
  overviewVideoSource?: RtcVideoSourceLike;
  overviewFramesSent?: number;
  compositePollTimer: ReturnType<typeof setInterval> | null;
  handlers: RemoteWindowStreamDaemonHandlers;
  focusRevision: number;
  pendingFocusReady: RemoteWindowStreamFocusResultPayload | null;
  pendingVideoFrame: {
    frame: RemoteWindowCaptureFrame;
  } | null;
  cleanupDone: boolean;
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







function addRemoteWindowVideoTrack(
  peerConnection: RTCPeerConnection,
  videoTrack: MediaStreamTrack,
  streamId?: string,
) {
  if (streamId && typeof wrtc.MediaStream === 'function') {
    const stream = new (wrtc.MediaStream as unknown as new (init: { id: string }) => MediaStream)({ id: streamId });
    return peerConnection.addTrack(videoTrack, stream);
  }
  return peerConnection.addTrack(videoTrack);
}

async function applyRemoteWindowTargetResize(
  entry: ActiveRemoteWindowStream,
  event: Extract<RemoteWindowInputEventPayload['event'], { kind: 'window-resize' }>,
  createdAt: string,
): Promise<RemoteWindowResizeApplyResult> {
  const captureSource = entry.captureSource;
  if (!captureSource?.updateTarget) {
    throw new Error('remote window active capture source cannot update target resize');
  }
  const nextTarget = buildResizedRemoteWindowTarget(entry.target, event, createdAt);
  await captureSource.updateTarget(nextTarget);
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
  const pythonBinary = (deps.pythonBinary || process.env.ZTERM_ITERM2_PYTHON || 'python3').trim();
  const swiftBinary = (deps.swiftBinary || process.env.ZTERM_MACOS_SWIFT || 'swift').trim();
  const captureBinary = (deps.captureBinary || process.env.ZTERM_DAEMON_CAPTURE_NATIVE || '').trim() || undefined;
  const iterm2PythonTimeoutMs = deps.iterm2PythonTimeoutMs || DEFAULT_ITERM2_PYTHON_TIMEOUT_MS;
  const appWindowCatalogTimeoutMs = deps.appWindowCatalogTimeoutMs || DEFAULT_MACOS_APP_WINDOW_CATALOG_TIMEOUT_MS;
  const captureStartupTimeoutMs = deps.captureStartupTimeoutMs || DEFAULT_SCREEN_CAPTURE_KIT_STARTUP_TIMEOUT_MS;
  const defaultFrameRate = deps.frameRate || DEFAULT_REMOTE_WINDOW_FRAME_RATE;
  const runIterm2Python = deps.runIterm2Python || runDefaultIterm2Python;
  const runMacosAppWindowCatalog = deps.runMacosAppWindowCatalog || runDefaultMacosAppWindowCatalog;
  let remoteWindowInputHelper: RemoteWindowInputHelper | null = null;
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
    // focus 防抖：3s 内已执行过 focus（且当前不是显式 focus 事件）时跳过 swift 的 bring-to-focus，
    // 避免每次手势都切焦点导致系统窗口抖动
    const nowMs = Date.now();
    const isFocusEvent = payload.event.kind === 'focus';
    const skipFocus = !isFocusEvent && nowMs - lastRemoteWindowFocusAtMs < REMOTE_WINDOW_FOCUS_DEBOUNCE_MS;
    if (!skipFocus) {
      lastRemoteWindowFocusAtMs = nowMs;
    }
    return getRemoteWindowInputHelper().send(buildRemoteWindowInputConfig(payload, target, {
      daemonReceivedAtMs: options.daemonReceivedAtMs,
      skipFocus,
    }));
  });
  const now = deps.now || (() => new Date().toISOString());
  const captureSourceFactory = deps.captureSourceFactory || startScreenCaptureKitFrameSource;
  const createPeerConnection = deps.peerConnectionFactory || ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
  const createRtcSessionDescription = deps.rtcSessionDescriptionFactory || ((description: RTCSessionDescriptionInit) => new RTCSessionDescription(description));
  const createRtcIceCandidate = deps.rtcIceCandidateFactory || ((candidate: RTCIceCandidateInit) => new RTCIceCandidate(candidate));
  const createVideoSource = deps.videoSourceFactory || (() => new nonstandard.RTCVideoSource({ isScreencast: true }));
  const rgbaToI420 = deps.rgbaToI420 || nonstandard.rgbaToI420;
  const activeStreams = new Map<string, ActiveRemoteWindowStream>();
  let lastRemoteWindowFocusAtMs = 0;
  const targetCatalogCacheTtlMs = Math.max(
    0,
    Math.floor(deps.targetCatalogCacheTtlMs ?? DEFAULT_REMOTE_WINDOW_TARGET_CATALOG_CACHE_TTL_MS),
  );
  const nowMs = deps.nowMs || Date.now;
  const catalogRuntime = createRemoteWindowCatalogRuntime({
    platform,
    pythonBinary,
    swiftBinary,
    iterm2PythonTimeoutMs,
    appWindowCatalogTimeoutMs,
    targetCatalogCacheTtlMs,
    now,
    nowMs,
    runIterm2Python,
    runMacosAppWindowCatalog,
    runTmux: deps.runTmux,
  });

  function buildStreamError(
    payload: { requestId?: string; streamId?: string },
    code: string,
    message: string,
  ): RemoteWindowStreamErrorPayload {
    return {
      requestId: payload.requestId || '',
      ...(payload.streamId ? { streamId: payload.streamId } : {}),
      code,
      message: truncateRemoteWindowErrorMessage(message || code),
    };
  }

  function cleanupStream(entry: ActiveRemoteWindowStream, reason: string) {
    if (entry.cleanupDone) {
      return false;
    }
    entry.cleanupDone = true;
    if (entry.compositePollTimer) {
      clearInterval(entry.compositePollTimer);
      entry.compositePollTimer = null;
    }
    activeStreams.delete(entry.streamId);
    entry.pendingVideoFrame = null;
    releaseRemoteWindowStreamSessionResources({
      ...entry,
      sendStatus: entry.handlers.sendStatus,
    }, reason);
    entry.captureSource = null;
    entry.overviewCaptureSource = null;
    return true;
  }

  function isCurrentStream(entry: ActiveRemoteWindowStream) {
    return activeStreams.get(entry.streamId) === entry && !entry.cleanupDone;
  }

  function isRemoteWindowPeerMediaReady(entry: ActiveRemoteWindowStream) {
    return Boolean(entry.peerConnection.localDescription);
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
    if (entry.framesSent === 1 || entry.framesSent % 30 === 0) {
      // eslint-disable-next-line no-console
      console.log(`[remote-window] framesSent=${entry.framesSent} size=${captureFrame.width}x${captureFrame.height} streamId=${entry.streamId.slice(0, 8)}`);
    }
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

  function flushPendingRemoteWindowVideoFrame(entry: ActiveRemoteWindowStream) {
    if (!isCurrentStream(entry) || !isRemoteWindowPeerMediaReady(entry) || !entry.pendingVideoFrame) {
      return;
    }
    const pending = entry.pendingVideoFrame;
    entry.pendingVideoFrame = null;
    try {
      sendRemoteWindowVideoFrame(entry, pending.frame);
    } catch (error) {
      cleanupStream(
        entry,
        `remote window frame conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function handleRemoteWindowCaptureFrame(
    entry: ActiveRemoteWindowStream,
    captureFrame: RemoteWindowCaptureFrame,
    lane: 'focus' | 'overview' = 'focus',
  ) {
    if (!isCurrentStream(entry)) {
      return;
    }
    if (!isRemoteWindowPeerMediaReady(entry)) {
      if (lane === 'focus') {
        entry.pendingVideoFrame = {
          frame: {
            width: captureFrame.width,
            height: captureFrame.height,
            rgba: new Uint8Array(captureFrame.rgba),
          },
        };
      }
      return;
    }
    try {
      sendRemoteWindowVideoFrame(entry, captureFrame, lane);
    } catch (error) {
      cleanupStream(
        entry,
        `remote window frame conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function startStream(
    payload: RemoteWindowStreamStartRequestPayload,
    handlers: RemoteWindowStreamDaemonHandlers = {},
  ): Promise<RemoteWindowStreamStartedPayload | RemoteWindowStreamErrorPayload> {
    if (!payload.requestId || !payload.streamId) {
      return buildStreamError(payload, 'remote_window_stream_request_invalid', 'remote window stream start requires requestId and streamId');
    }
    if (platform !== 'darwin') {
      return buildStreamError(payload, 'remote_window_platform_unsupported', 'remote window stream is only available on macOS daemon hosts');
    }
    if (activeStreams.has(payload.streamId)) {
      return buildStreamError(payload, 'remote_window_stream_exists', `remote window stream already exists: ${payload.streamId}`);
    }

    const purpose: RemoteWindowStreamPurpose = payload.purpose ?? 'focus';
    let entry: ActiveRemoteWindowStream | null = null;
    try {
      validateStreamTargetForCapture(payload.target);
      const inputHelperWarm = warmRemoteWindowInputHelperForTarget(payload.target)
        .then(() => null, (error: unknown) => (
          error instanceof Error ? error : new Error('remote window input helper warm failed')
        ));
      const peerConnection = createPeerConnection({
        iceServers: Array.isArray(payload.iceServers) ? payload.iceServers as unknown as RTCIceServer[] : [],
      });
      const videoSource = createVideoSource();
      const videoTrack = videoSource.createTrack();
      const requestedVideoBitrate = normalizeRemoteWindowVideoBitrateConfig(payload.videoBitrate);
      const videoSender = addRemoteWindowVideoTrack(
        peerConnection,
        videoTrack,
      ) as RTCRtpSender | undefined;
      const streamFrameRate = requestedVideoBitrate?.maxFrameRateFps ?? defaultFrameRate;
      const overviewFrameRate = Math.min(streamFrameRate, OVERVIEW_FRAME_RATE_FPS);
      let videoBitrate: RemoteWindowVideoBitrateConfig | null = null;
      let videoBitrateWarning: string | null = null;

      entry = {
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
        overviewTarget: null,
        overviewMainTarget: payload.target,
        peerConnection,
        videoSender: videoSender || null,
        videoSource,
        videoTrack,
        videoBitrate,
        captureSource: null,
        compositePollTimer: null,
        handlers,
        framesSent: 0,
        focusRevision: 0,
        pendingFocusReady: null,
        pendingVideoFrame: null,
        cleanupDone: false,
      };
      activeStreams.set(payload.streamId, entry);

      peerConnection.onicecandidate = (event) => {
        if (!entry || !isCurrentStream(entry) || !event.candidate) {
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
        if (!entry || !isCurrentStream(entry)) {
          return;
        }
        const state = peerConnection.connectionState;
        if (state === 'connected') {
          flushPendingRemoteWindowVideoFrame(entry);
        }
        if (state === 'failed' || state === 'closed') {
          cleanupStream(entry, `remote window WebRTC connection ${state}`);
        }
      };

      handlers.sendStatus?.({
        requestId: payload.requestId,
        streamId: payload.streamId,
        purpose,
        phase: 'starting',
        ...(videoBitrateWarning
          ? { message: `video bitrate not applied: ${videoBitrateWarning}` }
          : {}),
      });

      await peerConnection.setRemoteDescription(createRtcSessionDescription({
        type: payload.offer.type,
        sdp: payload.offer.sdp,
      }));

      // Overview（低码率总览）lane 只对真正组合（多个窗口）启用。单个
      // app-window 目标强制启动 overview 会让 Swift 回退全分辨率单窗口捕获，
      // 造成 focus 与 overview 双份全分辨率 capture/带宽。
      const hasCompositeWindows = (payload.target.compositeWindows ?? []).length > 0;
      // focus（高码率主窗口）流：主窗口单独捕获全分辨率；组合模式时剥离 compositeWindows
      const focusTarget: RemoteWindowStreamTargetManifest = hasCompositeWindows
        ? { ...payload.target, compositeWindows: undefined }
        : payload.target;
      const captureSource = await captureSourceFactory(focusTarget, {
        frameRate: streamFrameRate,
        startupTimeoutMs: captureStartupTimeoutMs,
        swiftBinary,
        captureBinary,
        onFrame: (frame) => {
          if (!entry || !isCurrentStream(entry)) {
            return;
          }
          handleRemoteWindowCaptureFrame(entry, frame, 'focus');
        },
        onError: (error) => {
          if (!entry || !isCurrentStream(entry)) {
            return;
          }
          cleanupStream(entry, error.message || 'remote window capture failed');
        },
      });
      if (!isCurrentStream(entry)) {
        captureSource.stop();
        throw new Error('remote window stream was closed before capture started');
      }
      entry.captureSource = captureSource;
      const inputHelperWarmError = await inputHelperWarm;
      if (inputHelperWarmError) {
        throw inputHelperWarmError;
      }

      // 双流：组合 target 额外启动低码率总览（overview）捕获（全部窗口平铺 canvas）
      if (hasCompositeWindows) {
        const overviewVideoSource = createVideoSource();
        const overviewVideoTrack = overviewVideoSource.createTrack();
        const overviewVideoSender = addRemoteWindowVideoTrack(
          peerConnection,
          overviewVideoTrack,
          'overview',
        ) as RTCRtpSender | undefined;
        const overviewCaptureSource = await captureSourceFactory(payload.target, {
          frameRate: overviewFrameRate,
          startupTimeoutMs: captureStartupTimeoutMs,
          swiftBinary,
          captureBinary,
          onFrame: (frame) => {
            if (!entry || !isCurrentStream(entry)) {
              return;
            }
            handleRemoteWindowCaptureFrame(entry, frame, 'overview');
          },
          onError: (error) => {
            if (!entry || !isCurrentStream(entry)) {
              return;
            }
            cleanupStream(entry, error.message || 'remote window overview capture failed');
          },
        });
        if (!isCurrentStream(entry)) {
          overviewCaptureSource.stop();
          throw new Error('remote window stream was closed before overview capture started');
        }
        entry.overviewVideoSource = overviewVideoSource;
        entry.overviewVideoTrack = overviewVideoTrack;
        entry.overviewVideoSender = overviewVideoSender || null;
        entry.overviewCaptureSource = overviewCaptureSource;
        // 组合模式自动增删：周期刷新同 app 窗口 catalog → 只更新 overview 捕获
        entry.compositePollTimer = setInterval(() => {
          if (!entry || !isCurrentStream(entry)) {
            return;
          }
          void (async () => {
            const activeEntry = entry;
            if (!activeEntry || !isCurrentStream(activeEntry)) {
              return;
            }
            try {
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

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      if (!isCurrentStream(entry)) {
        throw new Error('remote window stream was closed before media negotiation completed');
      }
      flushPendingRemoteWindowVideoFrame(entry);
      if (requestedVideoBitrate) {
        try {
          await applyRemoteWindowStreamGroupQuality({
            requested: requestedVideoBitrate,
            focusSender: videoSender || null,
            focusCaptureSource: entry.captureSource,
            overviewSender: entry.overviewVideoSender,
            overviewCaptureSource: entry.overviewCaptureSource,
          });
          videoBitrate = requestedVideoBitrate;
          entry.videoBitrate = videoBitrate;
        } catch (error) {
          videoBitrateWarning = formatRemoteWindowVideoBitrateError(error);
        }
        if (videoBitrateWarning) {
          handlers.sendStatus?.({
            requestId: payload.requestId,
            streamId: payload.streamId,
            purpose,
            phase: 'starting',
            message: `video bitrate not applied: ${videoBitrateWarning}`,
          });
        }
      }

      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        purpose,
        targetId: payload.target.streamTargetId,
        answer: normalizeRtcDescription(peerConnection.localDescription || answer, 'answer'),
        capture: {
          source: 'ScreenCaptureKit',
          frameWidth: captureSource.width,
          frameHeight: captureSource.height,
          frameRate: captureSource.frameRate,
          ...(entry.videoBitrate ? { maxBitrateBps: entry.videoBitrate.maxBitrateBps } : {}),
          targetKind: payload.target.videoTarget.kind,
        },
        ...(entry.canvasLayout ? { canvasLayout: entry.canvasLayout } : {}),
        transport: {
          kind: 'webrtc-video',
        },
      };
    } catch (error) {
      if (entry) {
        cleanupStream(entry, error instanceof Error ? error.message : String(error));
      }
      return buildStreamError(
        payload,
        'remote_window_stream_start_failed',
        error instanceof Error ? error.message : 'remote window stream start failed',
      );
    }
  }

  async function addIceCandidate(payload: RemoteWindowStreamIceCandidatePayload) {
    const entry = activeStreams.get(payload.streamId);
    if (!entry || entry.cleanupDone) {
      return false;
    }
    await entry.peerConnection.addIceCandidate(createRtcIceCandidate({
      candidate: payload.candidate.candidate,
      sdpMid: payload.candidate.sdpMid ?? null,
      sdpMLineIndex: payload.candidate.sdpMLineIndex ?? null,
      usernameFragment: payload.candidate.usernameFragment ?? null,
    }));
    flushPendingRemoteWindowVideoFrame(entry);
    return true;
  }

  async function stopStream(
    payload: RemoteWindowStreamStopRequestPayload,
  ): Promise<RemoteWindowStreamStatusPayload | RemoteWindowStreamErrorPayload> {
    if (!payload.requestId || !payload.streamId) {
      return buildStreamError(payload, 'remote_window_stream_stop_invalid', 'remote window stream stop requires requestId and streamId');
    }
    const entry = activeStreams.get(payload.streamId);
    if (!entry) {
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        ...(payload.purpose ? { purpose: payload.purpose } : {}),
        phase: 'stopped',
        framesSent: 0,
        message: 'remote window stream already stopped',
      };
    }
    const framesSent = entry.framesSent;
    cleanupStream(entry, 'remote window stream stopped');
    return {
      requestId: payload.requestId,
      streamId: payload.streamId,
      purpose: entry.purpose,
      phase: 'stopped',
      framesSent,
      message: 'remote window stream stopped',
    };
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
        revision: payload.revision,
        purpose: entry.purpose,
        targetId: payload.targetId,
        status: 'rejected',
        requestedVideoBitrate: payload.videoBitrate,
        error: {
          code: 'remote_window_stream_quality_target_mismatch',
          message: `remote window stream quality target mismatch: ${payload.targetId}`,
        },
      };
    }
    if (payload.streamGroupId !== entry.streamGroupId || !Number.isSafeInteger(payload.revision) || payload.revision <= entry.qualityRevision) {
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        streamGroupId: payload.streamGroupId,
        revision: payload.revision,
        purpose: entry.purpose,
        targetId: payload.targetId,
        status: 'rejected',
        requestedVideoBitrate: payload.videoBitrate,
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
        revision: payload.revision,
        purpose: entry.purpose,
        targetId: payload.targetId,
        status: 'rejected',
        requestedVideoBitrate: payload.videoBitrate,
        error: {
          code: 'remote_window_stream_quality_busy',
          message: `remote window stream quality revision ${entry.pendingQualityRevision} is still applying`,
        },
      };
    }
    entry.pendingQualityRevision = payload.revision;
    try {
      const videoBitrate = normalizeRemoteWindowVideoBitrateConfig(payload.videoBitrate);
      if (!videoBitrate) {
        throw new Error('remote window stream quality requires videoBitrate');
      }
      const appliedGroupBudget = await applyRemoteWindowStreamGroupQuality({
        requested: videoBitrate,
        focusSender: entry.videoSender,
        focusCaptureSource: entry.captureSource,
        overviewSender: entry.overviewVideoSender,
        overviewCaptureSource: entry.overviewCaptureSource,
      });
      entry.videoBitrate = videoBitrate;
      entry.qualityRevision = payload.revision;
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        streamGroupId: payload.streamGroupId,
        revision: payload.revision,
        purpose: entry.purpose,
        targetId: payload.targetId,
        status: 'applied',
        requestedVideoBitrate: payload.videoBitrate,
        appliedVideoBitrate: videoBitrate,
        appliedGroupBudget,
      };
    } catch (error) {
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        streamGroupId: payload.streamGroupId,
        revision: payload.revision,
        purpose: entry.purpose,
        targetId: payload.targetId,
        status: 'rejected',
        requestedVideoBitrate: payload.videoBitrate,
        error: {
          code: 'remote_window_stream_quality_failed',
          message: formatRemoteWindowVideoBitrateError(error),
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

  async function injectInput(
    payload: RemoteWindowInputEventPayload,
  ): Promise<RemoteWindowInputResultPayload | RemoteWindowStreamErrorPayload> {
    const entry = activeStreams.get(payload.streamId);
    if (!entry || entry.cleanupDone) {
      return buildStreamError(payload, 'remote_window_input_stream_missing', `remote window stream is not active: ${payload.streamId || 'missing'}`);
    }
    const daemonReceivedAtMs = nowMs();
    try {
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
      await runRemoteWindowInputEvent(mappedPayload, entry.target, {
        swiftBinary,
        runTmux: deps.runTmux,
        daemonReceivedAtMs,
      });
      if (payload.event.kind === 'window-resize') {
        const resized = await applyRemoteWindowTargetResize(entry, payload.event, now());
        return {
          requestId: payload.requestId,
          streamId: payload.streamId,
          targetId: payload.targetId,
          accepted: true,
          target: resized.target,
          capture: resized.capture,
        };
      }
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        targetId: payload.targetId,
        accepted: true,
      };
    } catch (error) {
      return buildStreamError(
        payload,
        'remote_window_input_failed',
        error instanceof Error ? error.message : 'remote window input failed',
      );
    }
  }

  function dispose(reason = 'remote window daemon runtime disposed') {
    for (const entry of Array.from(activeStreams.values())) {
      cleanupStream(entry, reason);
    }
    catalogRuntime.dispose();
    remoteWindowInputHelper?.dispose();
    remoteWindowInputHelper = null;
  }

  if (deps.warmTargetCatalogOnStart) {
    catalogRuntime.warm();
  }

  return {
    listTargets: catalogRuntime.listTargets,
    startStream,
    addIceCandidate,
    stopStream,
    updateStreamQuality,
    updateFocus,
    injectInput,
    dispose,
  };
}
