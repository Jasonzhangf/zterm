import wrtc from '@roamhq/wrtc';
import type {
  RemoteWindowStreamIceCandidate,
  RemoteWindowStreamIceCandidatePayload,
  RemoteWindowInputEventPayload,
  RemoteWindowInputResultPayload,
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamRequestPayload,
  RemoteWindowStreamRtcDescription,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowStreamPurpose,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamStartRequestPayload,
  RemoteWindowStreamStatusPayload,
  RemoteWindowStreamStopRequestPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowVideoBitrateConfig,
} from '@zterm/shared/protocol';
import { ITERM2_CATALOG_PYTHON, MACOS_APP_WINDOW_CATALOG_SWIFT } from './remote-window-scripts';
import {
  remoteWindowError,
  summarizeRemoteWindowCatalogError,
  truncateRemoteWindowErrorMessage,
} from './remote-window-support';
import {
  DEFAULT_ITERM2_PYTHON_TIMEOUT_MS,
  DEFAULT_MACOS_APP_WINDOW_CATALOG_TIMEOUT_MS,
  buildMacosAppWindowTargets,
  buildRemoteWindowStreamTargets,
  parseIterm2Catalog,
  parseMacosAppWindowCatalog,
  parseTmuxClientTargets,
  runDefaultIterm2Python,
  runDefaultMacosAppWindowCatalog,
  type Iterm2RawCatalog,
  type MacosAppWindowCatalog,
  type TmuxClientTarget,
} from './remote-window-catalog';
import {
  buildRemoteWindowInputConfig,
  createDefaultRemoteWindowInputHelper,
  type RemoteWindowInputEventRunner,
  type RemoteWindowInputHelper,
} from './remote-window-input-helper';
import {
  DEFAULT_SCREEN_CAPTURE_KIT_STARTUP_TIMEOUT_MS,
  buildResizedRemoteWindowTarget,
  startScreenCaptureKitFrameSource,
  validateStreamTargetForCapture,
  type RemoteWindowCaptureFrame,
  type RemoteWindowCaptureFrameSource,
  type RemoteWindowCaptureSourceFactory,
} from './remote-window-capture';

export * from './remote-window-scripts';
export * from './remote-window-support';
export * from './remote-window-catalog';
export * from './remote-window-input-helper';
export * from './remote-window-capture';

const DEFAULT_REMOTE_WINDOW_FRAME_RATE = 30;
const DEFAULT_REMOTE_WINDOW_TARGET_CATALOG_CACHE_TTL_MS = 60_000;
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
  injectInput: (
    payload: RemoteWindowInputEventPayload,
  ) => Promise<RemoteWindowInputResultPayload | RemoteWindowStreamErrorPayload>;
  dispose: (reason?: string) => void;
}

interface RemoteWindowTargetCatalogCacheEntry {
  updatedAtMs: number;
  response: RemoteWindowStreamTargetsResponsePayload;
}

export interface RemoteWindowStreamDaemonHandlers {
  sendIceCandidate?: (payload: RemoteWindowStreamIceCandidatePayload) => void;
  sendStatus?: (payload: RemoteWindowStreamStatusPayload) => void;
}

interface ActiveRemoteWindowStream {
  streamId: string;
  purpose: RemoteWindowStreamPurpose;
  requestId: string;
  targetId: string;
  target: RemoteWindowStreamTargetManifest;
  peerConnection: RTCPeerConnection;
  videoSender: RTCRtpSender | null;
  videoSource: RtcVideoSourceLike;
  videoTrack: MediaStreamTrack;
  videoBitrate: RemoteWindowVideoBitrateConfig | null;
  captureSource: RemoteWindowCaptureFrameSource | null;
  compositePollTimer: ReturnType<typeof setInterval> | null;
  handlers: RemoteWindowStreamDaemonHandlers;
  framesSent: number;
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

function buildRemoteWindowTargetCatalogCacheKey(payload: RemoteWindowStreamRequestPayload) {
  return [
    payload.includeAppWindows !== false ? 'app' : 'no-app',
    payload.includeIterm2 !== false ? 'iterm2' : 'no-iterm2',
  ].join('|');
}

function cloneRemoteWindowTargetCatalogResponse(
  response: RemoteWindowStreamTargetsResponsePayload,
  requestId: string,
): RemoteWindowStreamTargetsResponsePayload {
  return {
    requestId,
    targets: response.targets.slice(),
    ...(response.errors
      ? {
          errors: response.errors.map((error) => ({
            ...error,
            requestId,
          })),
        }
      : {}),
  };
}

function cloneRemoteWindowTargetCatalogResult(
  result: RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload,
  requestId: string,
) {
  if ('targets' in result) {
    return cloneRemoteWindowTargetCatalogResponse(result, requestId);
  }
  return {
    ...result,
    requestId,
  };
}

function normalizeRtcDescription(
  description: RTCSessionDescriptionInit | RTCSessionDescription | null,
  expectedType: RemoteWindowStreamRtcDescription['type'],
): RemoteWindowStreamRtcDescription {
  if (!description || description.type !== expectedType || typeof description.sdp !== 'string') {
    throw new Error(`remote window daemon expected ${expectedType} description`);
  }
  return {
    type: expectedType,
    sdp: description.sdp,
  };
}

function normalizeIceCandidate(candidate: RTCIceCandidate): RemoteWindowStreamIceCandidate {
  const candidateLike = typeof candidate.toJSON === 'function'
    ? candidate.toJSON()
    : candidate;
  return {
    candidate: String(candidateLike.candidate || ''),
    sdpMid: candidateLike.sdpMid ?? null,
    sdpMLineIndex: candidateLike.sdpMLineIndex ?? null,
    usernameFragment: candidateLike.usernameFragment ?? null,
  };
}

function normalizeRemoteWindowVideoBitrateConfig(
  input: RemoteWindowVideoBitrateConfig | undefined,
): RemoteWindowVideoBitrateConfig | null {
  if (!input) {
    return null;
  }
  const defaults = (() => {
    switch (input.preset) {
      case '2mbps':
        return { bitrateMbps: 2 as const, maxFrameRateFps: 30 as const };
      case '5mbps':
        return { bitrateMbps: 5 as const, maxFrameRateFps: 30 as const };
      case '10mbps':
        return { bitrateMbps: 10 as const, maxFrameRateFps: 30 as const };
      case '20mbps':
        return { bitrateMbps: 20 as const, maxFrameRateFps: 30 as const };
      case 'fullscreen':
        return { bitrateMbps: 20 as const, maxFrameRateFps: 60 as const };
      default:
        throw new Error(`remote window video bitrate preset is invalid: ${String(input.preset)}`);
    }
  })();
  const bitrateMbps = defaults.bitrateMbps;
  const maxBitrateBps = bitrateMbps * 1_000_000;
  if (
    input.bitrateMbps !== bitrateMbps
    || !Number.isFinite(input.maxBitrateBps)
    || input.maxBitrateBps <= 0
    || input.maxBitrateBps > maxBitrateBps
  ) {
    throw new Error('remote window video bitrate config does not match its preset');
  }
  const maxFrameRateFps = input.maxFrameRateFps ?? defaults.maxFrameRateFps;
  if (
    !Number.isFinite(maxFrameRateFps)
    || maxFrameRateFps < 5
    || maxFrameRateFps > defaults.maxFrameRateFps
  ) {
    throw new Error('remote window video frame-rate config does not match its preset');
  }
  return {
    preset: input.preset,
    bitrateMbps,
    maxBitrateBps: Math.floor(input.maxBitrateBps),
    maxFrameRateFps,
  };
}

type RemoteWindowVideoBitrateApplyResult =
  | { applied: true; videoBitrate: RemoteWindowVideoBitrateConfig }
  | { applied: false; reason: string };

async function applyRemoteWindowVideoBitrate(
  sender: RTCRtpSender | null,
  config: RemoteWindowVideoBitrateConfig,
): Promise<RemoteWindowVideoBitrateApplyResult> {
  if (
    !sender
    || typeof sender.getParameters !== 'function'
    || typeof sender.setParameters !== 'function'
  ) {
    return {
      applied: false,
      reason: 'remote window video bitrate control is not available on this WebRTC sender',
    };
  }
  const currentParameters = sender.getParameters();
  const currentEncodings = Array.isArray(currentParameters.encodings)
    ? currentParameters.encodings
    : [];
  if (currentEncodings.length === 0) {
    return {
      applied: false,
      reason: 'remote window video bitrate sender has no encodings to update',
    };
  }
  const nextParameters = {
    ...currentParameters,
    encodings: currentEncodings.map((encoding) => ({
      ...encoding,
      maxBitrate: config.maxBitrateBps,
      maxFramerate: config.maxFrameRateFps,
    })),
  } as RTCRtpSendParameters;
  await sender.setParameters(nextParameters);
  return { applied: true, videoBitrate: config };
}

function formatRemoteWindowVideoBitrateError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name || 'remote window video bitrate could not be applied';
  }
  const message = String(error || '').trim();
  return message || 'remote window video bitrate could not be applied';
}

function addRemoteWindowVideoTrack(
  peerConnection: RTCPeerConnection,
  videoTrack: MediaStreamTrack,
) {
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

function convertRgbaToI420Frame(
  frame: RemoteWindowCaptureFrame,
  convert: (rgba: RtcVideoFrame, i420: RtcVideoFrame) => void,
): RtcVideoFrame {
  const width = Math.max(1, Math.floor(frame.width));
  const height = Math.max(1, Math.floor(frame.height));
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const i420 = {
    width,
    height,
    data: new Uint8Array(width * height + chromaWidth * chromaHeight * 2),
  };
  convert({
    width,
    height,
    data: frame.rgba,
  }, i420);
  return i420;
}

export function createRemoteWindowStreamDaemonRuntime(
  deps: RemoteWindowStreamDaemonDeps,
): RemoteWindowStreamDaemonRuntime {
  const platform = deps.platform || process.platform;
  const pythonBinary = (deps.pythonBinary || process.env.ZTERM_ITERM2_PYTHON || 'python3').trim();
  const swiftBinary = (deps.swiftBinary || process.env.ZTERM_MACOS_SWIFT || 'swift').trim();
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
  const targetCatalogCache = new Map<string, RemoteWindowTargetCatalogCacheEntry>();
  const targetCatalogRefreshes = new Map<string, Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload>>();

  async function queryIterm2Catalog() {
    const stdout = await runIterm2Python(ITERM2_CATALOG_PYTHON, {
      pythonBinary,
      timeoutMs: iterm2PythonTimeoutMs,
    });
    return parseIterm2Catalog(stdout);
  }

  async function queryMacosAppWindowCatalog() {
    const stdout = await runMacosAppWindowCatalog(MACOS_APP_WINDOW_CATALOG_SWIFT, {
      swiftBinary,
      timeoutMs: appWindowCatalogTimeoutMs,
    });
    return parseMacosAppWindowCatalog(stdout);
  }

  async function listTargetsLive(
    payload: RemoteWindowStreamRequestPayload,
  ): Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload> {
    const createdAt = now();
    const includeAppWindows = payload.includeAppWindows !== false;
    const includeIterm2 = payload.includeIterm2 !== false;
    const targets: RemoteWindowStreamTargetManifest[] = [];
    const errors: RemoteWindowStreamErrorPayload[] = [];

    let macosAppWindowCatalogOk = false;
    let macosAppWindowCatalog: MacosAppWindowCatalog | null = null;
    if (includeAppWindows) {
      try {
        macosAppWindowCatalog = await queryMacosAppWindowCatalog();
        targets.push(...buildMacosAppWindowTargets(macosAppWindowCatalog, createdAt));
        macosAppWindowCatalogOk = true;
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, 'macOS app window catalog unavailable');
        errors.push(remoteWindowError(payload, 'app_window_catalog_unavailable', message || 'macOS app window catalog unavailable'));
      }
    }

    let catalog: Iterm2RawCatalog | null = null;
    if (includeIterm2) {
      try {
        catalog = await queryIterm2Catalog();
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, 'iTerm2 Python API unavailable');
        errors.push(remoteWindowError(payload, 'iterm2_api_unavailable', message || 'iTerm2 Python API unavailable'));
      }
    }

    let tmuxTargets = new Map<string, TmuxClientTarget>();
    if (catalog) {
      if (!macosAppWindowCatalogOk) {
        try {
          macosAppWindowCatalog = await queryMacosAppWindowCatalog();
          macosAppWindowCatalogOk = true;
        } catch (error) {
          const message = summarizeRemoteWindowCatalogError(error, 'macOS app window catalog unavailable');
          errors.push(remoteWindowError(payload, 'app_window_catalog_unavailable', message || 'macOS app window catalog unavailable'));
        }
      }
      try {
        tmuxTargets = parseTmuxClientTargets(deps.runTmux([
          'list-clients',
          '-F',
          '#{client_tty}\t#{session_name}\t#{window_id}\t#{pane_id}',
        ]).stdout);
      } catch {
        tmuxTargets = new Map<string, TmuxClientTarget>();
      }
    }

    if (catalog) {
      try {
        targets.push(...buildRemoteWindowStreamTargets(catalog, tmuxTargets, createdAt, {
          includeAppWindowTargets: false,
          macosAppWindowCatalog,
          requireCaptureWindowForPanes: true,
        }));
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, 'remote window target manifest invalid');
        errors.push(remoteWindowError(payload, 'remote_window_manifest_invalid', message || 'remote window target manifest invalid'));
      }
    }

    if (targets.length > 0) {
      return {
        requestId: payload.requestId,
        targets,
        ...(errors.length > 0 ? { errors } : {}),
      };
    }
    return errors[0] || {
      requestId: payload.requestId,
      targets: [],
    };
  }

  function startTargetCatalogRefresh(
    cacheKey: string,
    payload: RemoteWindowStreamRequestPayload,
  ) {
    const existing = targetCatalogRefreshes.get(cacheKey);
    if (existing) {
      return existing;
    }
    const refreshPayload = {
      ...payload,
      requestId: payload.requestId || `rw-catalog-refresh-${nowMs()}`,
    };
    const refresh = listTargetsLive(refreshPayload)
      .catch((error: unknown) => remoteWindowError(
        refreshPayload,
        'remote_window_catalog_failed',
        error instanceof Error ? error.message : 'remote window catalog failed',
      ))
      .then((result) => {
        if ('targets' in result) {
          targetCatalogCache.set(cacheKey, {
            updatedAtMs: nowMs(),
            response: cloneRemoteWindowTargetCatalogResponse(result, result.requestId),
          });
        }
        return result;
      })
      .finally(() => {
        if (targetCatalogRefreshes.get(cacheKey) === refresh) {
          targetCatalogRefreshes.delete(cacheKey);
        }
      });
    targetCatalogRefreshes.set(cacheKey, refresh);
    return refresh;
  }

  async function refreshTargetCatalog(
    cacheKey: string,
    payload: RemoteWindowStreamRequestPayload,
  ) {
    const result = await startTargetCatalogRefresh(cacheKey, payload);
    return cloneRemoteWindowTargetCatalogResult(result, payload.requestId);
  }

  function warmTargetCatalog() {
    if (platform !== 'darwin') {
      return;
    }
    const payload: RemoteWindowStreamRequestPayload = {
      requestId: `rw-catalog-warm-${nowMs()}`,
      includeAppWindows: true,
      includeIterm2: true,
    };
    void startTargetCatalogRefresh(
      buildRemoteWindowTargetCatalogCacheKey(payload),
      payload,
    );
  }

  async function listTargets(
    payload: RemoteWindowStreamRequestPayload,
  ): Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload> {
    if (!payload.requestId) {
      return remoteWindowError(payload, 'remote_window_request_invalid', 'remote window target request requires requestId');
    }
    if (platform !== 'darwin') {
      return remoteWindowError(payload, 'remote_window_platform_unsupported', 'remote window stream catalog is only available on macOS daemon hosts');
    }
    const cacheKey = buildRemoteWindowTargetCatalogCacheKey(payload);
    const cached = targetCatalogCache.get(cacheKey) || null;
    const cacheAgeMs = cached ? nowMs() - cached.updatedAtMs : Number.POSITIVE_INFINITY;
    const cacheFresh = Boolean(cached && cacheAgeMs >= 0 && cacheAgeMs < targetCatalogCacheTtlMs);
    if (!payload.forceRefresh && cached && cacheFresh) {
      return cloneRemoteWindowTargetCatalogResponse(cached.response, payload.requestId);
    }
    if (!payload.forceRefresh && cached) {
      void startTargetCatalogRefresh(cacheKey, payload);
      return cloneRemoteWindowTargetCatalogResponse(cached.response, payload.requestId);
    }
    return refreshTargetCatalog(cacheKey, payload);
  }

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
    try {
      entry.captureSource?.stop();
    } catch {
      // Capture cleanup must not prevent peer cleanup.
    }
    entry.captureSource = null;
    try {
      entry.videoTrack.stop();
    } catch {
      // Track cleanup must remain exactly once even if the track is already stopped.
    }
    entry.peerConnection.onicecandidate = null;
    entry.peerConnection.onconnectionstatechange = null;
    try {
      entry.peerConnection.close();
    } catch {
      // Peer cleanup must not mask the stream cleanup path.
    }
    entry.handlers.sendStatus?.({
      requestId: entry.requestId,
      streamId: entry.streamId,
      purpose: entry.purpose,
      phase: 'stopped',
      framesSent: entry.framesSent,
      message: reason,
    });
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
  ) {
    const i420Frame = convertRgbaToI420Frame(captureFrame, rgbaToI420);
    entry.videoSource.onFrame(i420Frame);
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
      });
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
  ) {
    if (!isCurrentStream(entry)) {
      return;
    }
    if (!isRemoteWindowPeerMediaReady(entry)) {
      entry.pendingVideoFrame = {
        frame: {
          width: captureFrame.width,
          height: captureFrame.height,
          rgba: new Uint8Array(captureFrame.rgba),
        },
      };
      return;
    }
    try {
      sendRemoteWindowVideoFrame(entry, captureFrame);
    } catch (error) {
      cleanupStream(
        entry,
        `remote window frame conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function validateRemoteWindowInput(payload: RemoteWindowInputEventPayload, entry: ActiveRemoteWindowStream) {
    if (!payload.requestId || !payload.streamId || !payload.targetId) {
      throw new Error('remote window input requires requestId, streamId, and targetId');
    }
    if (payload.targetId !== entry.targetId) {
      throw new Error(`remote window input target mismatch: ${payload.targetId}`);
    }
    if (entry.target.inputRoute === 'os-event' && entry.target.focusPolicy !== 'bring-to-focus') {
      throw new Error('remote window OS input requires bring-to-focus policy');
    }
    if (entry.target.inputRoute !== 'os-event') {
      throw new Error(`remote window input route is not implemented: ${entry.target.inputRoute}`);
    }
    if (payload.event.kind === 'focus') {
      return;
    }
    if (payload.event.kind === 'window-resize') {
      if (
        !Number.isFinite(payload.event.width)
        || !Number.isFinite(payload.event.height)
        || payload.event.width < 120
        || payload.event.height < 120
      ) {
        throw new Error('remote window resize dimensions are invalid');
      }
      return;
    }
    if (payload.event.kind === 'click') {
      const values = [
        payload.event.x,
        payload.event.y,
        payload.event.normalizedX,
        payload.event.normalizedY,
      ];
      if (!values.every((value) => Number.isFinite(value))) {
        throw new Error('remote window click input coordinates are invalid');
      }
      if (payload.event.normalizedX < 0 || payload.event.normalizedX > 1 || payload.event.normalizedY < 0 || payload.event.normalizedY > 1) {
        throw new Error('remote window click input normalized coordinates are out of range');
      }
      if (payload.event.button !== 'left' && payload.event.button !== 'middle' && payload.event.button !== 'right') {
        throw new Error('remote window click input button is invalid');
      }
      if (
        payload.event.clickCount !== undefined
        && (
          !Number.isInteger(payload.event.clickCount)
          || payload.event.clickCount < 1
          || payload.event.clickCount > 3
        )
      ) {
        throw new Error('remote window click input click count is invalid');
      }
    }
    if (payload.event.kind === 'pointer') {
      const values = [
        payload.event.x,
        payload.event.y,
        payload.event.normalizedX,
        payload.event.normalizedY,
      ];
      if (!values.every((value) => Number.isFinite(value))) {
        throw new Error('remote window pointer input coordinates are invalid');
      }
      if (payload.event.normalizedX < 0 || payload.event.normalizedX > 1 || payload.event.normalizedY < 0 || payload.event.normalizedY > 1) {
        throw new Error('remote window pointer input normalized coordinates are out of range');
      }
    }
    if (payload.event.kind === 'scroll') {
      const values = [
        payload.event.x,
        payload.event.y,
        payload.event.normalizedX,
        payload.event.normalizedY,
        payload.event.deltaX,
        payload.event.deltaY,
      ];
      if (!values.every((value) => Number.isFinite(value))) {
        throw new Error('remote window scroll input coordinates or delta are invalid');
      }
      if (payload.event.normalizedX < 0 || payload.event.normalizedX > 1 || payload.event.normalizedY < 0 || payload.event.normalizedY > 1) {
        throw new Error('remote window scroll input normalized coordinates are out of range');
      }
      if (payload.event.unit !== 'pixel') {
        throw new Error('remote window scroll input unit is invalid');
      }
    }
    if (payload.event.kind === 'gesture') {
      const values = [
        payload.event.startX,
        payload.event.startY,
        payload.event.x,
        payload.event.y,
        payload.event.startNormalizedX,
        payload.event.startNormalizedY,
        payload.event.normalizedX,
        payload.event.normalizedY,
        payload.event.deltaX,
        payload.event.deltaY,
        payload.event.durationMs,
        payload.event.velocityX,
        payload.event.velocityY,
      ];
      if (!values.every((value) => Number.isFinite(value))) {
        throw new Error('remote window gesture input coordinates, delta, or timing are invalid');
      }
      if (
        payload.event.startNormalizedX < 0
        || payload.event.startNormalizedX > 1
        || payload.event.startNormalizedY < 0
        || payload.event.startNormalizedY > 1
        || payload.event.normalizedX < 0
        || payload.event.normalizedX > 1
        || payload.event.normalizedY < 0
        || payload.event.normalizedY > 1
      ) {
        throw new Error('remote window gesture input normalized coordinates are out of range');
      }
      if (
        payload.event.gesture !== 'swipe'
        || payload.event.phase !== 'end'
        || payload.event.unit !== 'pixel'
        || payload.event.durationMs <= 0
      ) {
        throw new Error('remote window gesture input contract is invalid');
      }
    }
    if (payload.event.kind === 'key' && payload.event.phase !== 'down' && payload.event.phase !== 'up') {
      throw new Error('remote window key input phase is invalid');
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
      let videoBitrate: RemoteWindowVideoBitrateConfig | null = null;
      let videoBitrateWarning: string | null = null;

      entry = {
        streamId: payload.streamId,
        purpose,
        requestId: payload.requestId,
        targetId: payload.target.streamTargetId,
        target: payload.target,
        peerConnection,
        videoSender: videoSender || null,
        videoSource,
        videoTrack,
        videoBitrate,
        captureSource: null,
        compositePollTimer: null,
        handlers,
        framesSent: 0,
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

      const captureSource = await captureSourceFactory(payload.target, {
        frameRate: streamFrameRate,
        startupTimeoutMs: captureStartupTimeoutMs,
        swiftBinary,
        onFrame: (frame) => {
          if (!entry || !isCurrentStream(entry)) {
            return;
          }
          handleRemoteWindowCaptureFrame(entry, frame);
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
      // 组合模式自动增删：周期刷新同 app 窗口 catalog → 窗口增删 → 重建 capture
      if ((payload.target.compositeWindows ?? []).length > 0) {
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
              const catalog = await queryMacosAppWindowCatalog();
              const targets = buildMacosAppWindowTargets(catalog, now());
              const sameApp = targets.filter((item) => (
                item.videoTarget.kind === 'app-window'
                && item.videoTarget.appBundleId === activeEntry.target.videoTarget.appBundleId
              ));
              const currentIds = new Set([
                activeEntry.target.videoTarget.windowId,
                ...(activeEntry.target.compositeWindows ?? []).map((w) => w.windowId),
              ]);
              const nextIds = sameApp.map((item) => item.videoTarget.windowId);
              if (
                nextIds.length === currentIds.size
                && nextIds.every((id) => currentIds.has(id))
              ) {
                return;
              }
              if (!activeEntry.captureSource) {
                return;
              }
              const nextTarget: RemoteWindowStreamTargetManifest = {
                ...activeEntry.target,
                compositeWindows: sameApp
                  .filter((item) => item.streamTargetId !== activeEntry.target.streamTargetId)
                  .map((item) => ({
                    windowId: item.videoTarget.windowId,
                    title: item.videoTarget.title,
                    windowBoundsTopLeftPx: item.videoTarget.windowBoundsTopLeftPx,
                    cropRectTopLeftPx: item.videoTarget.cropRectTopLeftPx,
                  })),
              };
              const captureSource = activeEntry.captureSource;
              if (!captureSource?.updateTarget) {
                return;
              }
              await captureSource.updateTarget(nextTarget);
              activeEntry.target = nextTarget;
              activeEntry.targetId = nextTarget.streamTargetId;
            } catch {
              // 自动增删轮询失败不打断串流
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
          const applyResult = await applyRemoteWindowVideoBitrate(videoSender || null, requestedVideoBitrate);
          if (applyResult.applied) {
            videoBitrate = applyResult.videoBitrate;
            entry.videoBitrate = videoBitrate;
          } else {
            videoBitrateWarning = applyResult.reason;
          }
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
      return buildStreamError(payload, 'remote_window_stream_quality_target_mismatch', `remote window stream quality target mismatch: ${payload.targetId}`);
    }
    try {
      const videoBitrate = normalizeRemoteWindowVideoBitrateConfig(payload.videoBitrate);
      if (!videoBitrate) {
        throw new Error('remote window stream quality requires videoBitrate');
      }
      const applyResult = await applyRemoteWindowVideoBitrate(entry.videoSender, videoBitrate);
      if (!applyResult.applied) {
        throw new Error(applyResult.reason);
      }
      entry.videoBitrate = applyResult.videoBitrate;
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        purpose: entry.purpose,
        targetId: payload.targetId,
        accepted: true,
        videoBitrate: applyResult.videoBitrate,
      };
    } catch (error) {
      return buildStreamError(
        payload,
        'remote_window_stream_quality_failed',
        formatRemoteWindowVideoBitrateError(error),
      );
    }
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
      validateRemoteWindowInput(payload, entry);
      await runRemoteWindowInputEvent(payload, entry.target, {
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
    targetCatalogCache.clear();
    targetCatalogRefreshes.clear();
    remoteWindowInputHelper?.dispose();
    remoteWindowInputHelper = null;
  }

  if (deps.warmTargetCatalogOnStart) {
    warmTargetCatalog();
  }

  return {
    listTargets,
    startStream,
    addIceCandidate,
    stopStream,
    updateStreamQuality,
    injectInput,
    dispose,
  };
}
