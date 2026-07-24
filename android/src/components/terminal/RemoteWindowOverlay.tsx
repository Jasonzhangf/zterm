import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import ztermRemoteWindowLogoUrl from '../../../../assets/logo_engraved.png';
import { mobileTheme } from '../../lib/mobile-ui';
import type {
  RemoteWindowStreamErrorPayload,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowVideoBitrateConfig,
  RemoteWindowVideoBitratePreset,
} from '../../lib/types';
import {
  applyRemoteWindowTargetCatalog,
  attachRemoteWindowStreamReceiver,
  beginRemoteWindowStreamSetup,
  beginRemoteWindowTargetEnumeration,
  closeRemoteWindowOverlay,
  enterRemoteWindowFullscreen,
  failRemoteWindowStream,
  failRemoteWindowTargetCatalog,
  initialRemoteWindowOverlayState,
  selectRemoteWindowTarget,
  shrinkRemoteWindowOverlay,
  type RemoteWindowOverlayState,
} from '../../lib/remote-window-overlay-runtime';
import {
  REMOTE_WINDOW_VIDEO_BITRATE_PRESETS,
  buildRemoteWindowVideoBitrateConfig,
  getRemoteWindowSourceRect,
  readRemoteWindowVideoBitratePreset,
  resolveAdaptiveRemoteWindowVideoBitratePreset,
  resolveEffectiveRemoteWindowVideoBitratePreset,
  resolveRemoteWindowVideoAdaptiveDecision,
  writeRemoteWindowVideoBitratePreset,
  type RemoteWindowVideoAdaptiveState,
  type RemoteWindowVideoStatsSample,
  type RemoteWindowNetworkQualityInput,
} from '../../lib/remote-window-video-quality';
import {
  buildRemoteWindowFocusFirstInputEvents,
  createRemoteWindowTouchPointerState,
  dispatchRemoteWindowTouchInputActionsRuntime,
  isRemoteWindowInputSupportedTarget,
  resolveRemoteWindowTouchPointerCancelRuntime,
  resolveRemoteWindowTouchPointerDownRuntime,
  resolveRemoteWindowTouchPointerMoveRuntime,
  resolveRemoteWindowTouchPointerUpRuntime,
  resolveRemoteWindowTouchScrollDeltaRuntime,
  resolveRemoteWindowTouchSurfacePointRuntime,
  REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION,
  type RemoteWindowTouchInputDebugEvent,
  type RemoteWindowTouchLocalEffect,
  type RemoteWindowTouchPointerSample,
  type RemoteWindowTouchPointerState,
  type RemoteWindowTouchSurfaceGeometry,
  type RemoteWindowTouchSurfacePoint,
} from '../../lib/remote-window-touch-action-runtime';

interface RemoteWindowOverlayProps {
  activeSessionId?: string | null;
  appForegroundActive?: boolean;
  requestTargets?: (
    sessionId: string,
    options?: { forceRefresh?: boolean },
  ) => Promise<RemoteWindowStreamTargetsResponsePayload>;
  startStream?: (
    sessionId: string,
    target: RemoteWindowStreamTargetManifest,
    streamId: string,
    options?: { videoBitrate?: RemoteWindowVideoBitrateConfig },
  ) => Promise<RemoteWindowStreamStartResult>;
  updateStreamQuality?: (
    sessionId: string,
    payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>,
  ) => void;
  stopStream?: (sessionId: string, streamId: string) => unknown;
  requestScreenshot?: (
    sessionId: string,
    target: RemoteWindowStreamTargetManifest,
  ) => Promise<RemoteWindowScreenshotSaveResult>;
  sendInput?: (
    sessionId: string,
    payload: Omit<RemoteWindowInputEventPayload, 'requestId'>,
  ) => void;
  onInputDebug?: (event: RemoteWindowTouchInputDebugEvent) => void;
  bottomInsetPx?: number;
  bottomChromeInsetPx?: number;
  onOpenStateChange?: (open: boolean) => void;
  onBodySubscriptionSuppressedChange?: (suppressed: boolean) => void;
  onInputContextChange?: (context: RemoteWindowInputContext | null) => void;
  onRequestKeyboard?: () => void;
}

interface RemoteWindowStreamStartResult {
  streamId: string;
  mediaStream?: MediaStream | null;
  started?: RemoteWindowStreamStartedPayload;
  collectStats?: () => Promise<RemoteWindowVideoStatsSample | null>;
}

interface RemoteWindowScreenshotSaveResult {
  fileName: string;
  savedPath: string;
}

type RemoteWindowScreenshotStatus =
  | { phase: 'idle' }
  | { phase: 'capturing' }
  | { phase: 'saved'; fileName: string; savedPath: string }
  | { phase: 'failed'; message: string };

export interface RemoteWindowInputContext {
  sessionId: string;
  streamId: string;
  targetId: string;
  targetKind: RemoteWindowStreamTargetManifest['videoTarget']['kind'];
  inputTargetKind: RemoteWindowStreamTargetManifest['inputTarget']['kind'];
  focusPolicy: RemoteWindowStreamTargetManifest['focusPolicy'];
  inputRoute: RemoteWindowStreamTargetManifest['inputRoute'];
}

interface FloatingOverlayOffset {
  x: number;
  y: number;
}

interface RemoteWindowCatalogProjectionSnapshot {
  sessionId: string;
  payload: RemoteWindowStreamTargetsResponsePayload;
  updatedAt: number;
}

interface SurfaceSize {
  width: number;
  height: number;
}

interface SurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FullscreenViewportState {
  scale: number;
  panX: number;
  panY: number;
}

type FullscreenDisplayMode = 'fit' | 'fill';

const REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_OPTIONS = [0.125, 0.25, 0.5, 1] as const;
type RemoteWindowTouchScrollFraction = (typeof REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_OPTIONS)[number];

type NavigatorConnectionLike = EventTarget & {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
};

interface SurfacePointerPosition {
  clientX: number;
  clientY: number;
}

type SurfacePointerGesture =
  | RemoteWindowTouchPointerState
  | {
      mode: 'input';
      pointerId: number;
    }
  | {
      mode: 'pan';
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startPanX: number;
      startPanY: number;
      moved: boolean;
    }
  | {
      mode: 'pinch';
      pointerIds: [number, number];
      startDistance: number;
      startMidX: number;
      startMidY: number;
      startScale: number;
      startPanX: number;
      startPanY: number;
    }
  | {
      mode: 'twoFingerCandidate';
      pointerIds: [number, number];
      firstStart: SurfacePointerPosition;
      secondStart: SurfacePointerPosition;
      startDistance: number;
      startMidX: number;
      startMidY: number;
      lastMidX: number;
      lastMidY: number;
      startScale: number;
      startPanX: number;
      startPanY: number;
    }
  | {
      mode: 'twoFingerScroll';
      pointerIds: [number, number];
      lastMidX: number;
      lastMidY: number;
    };

interface FloatingOverlayDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startOffset: FloatingOverlayOffset;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  captureElement: HTMLDivElement | null;
}

interface FloatingOverlayResize {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startWidth: number;
  startOffset: FloatingOverlayOffset;
  minWidth: number;
  maxWidth: number;
  aspectRatio: number;
  anchor: FloatingResizeAnchor;
  captureElement: HTMLDivElement | null;
}

type FloatingResizeAnchor = 'left-bottom' | 'right-bottom';

interface FloatingEntryDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  baseLeft: number;
  baseTop: number;
  width: number;
  height: number;
  active: boolean;
  captureElement: HTMLButtonElement | null;
}

const FLOATING_OVERLAY_VIEWPORT_MARGIN_PX = 8;
const REMOTE_WINDOW_FLOATING_BOTTOM_BASE_PX = 118;
const FLOATING_ENTRY_VIEWPORT_MARGIN_PX = 10;
const FLOATING_ENTRY_TOP_MARGIN_PX = 28;
const FLOATING_ENTRY_DRAG_THRESHOLD_PX = 7;
const FLOATING_ENTRY_LONG_PRESS_MS = 280;
const FLOATING_OVERLAY_MIN_WIDTH_PX = 168;
const FLOATING_OVERLAY_MAX_WIDTH_PX = 560;
const FLOATING_OVERLAY_TOOLBAR_ESTIMATE_PX = 50;
const REMOTE_WINDOW_FULLSCREEN_MIN_SCALE = 1;
const REMOTE_WINDOW_FULLSCREEN_MAX_SCALE = 4;
const REMOTE_WINDOW_FULLSCREEN_PAN_TAP_THRESHOLD_PX = 8;
const REMOTE_WINDOW_FULLSCREEN_PINCH_SCALE_THRESHOLD = 0.08;
const REMOTE_WINDOW_FULLSCREEN_TWO_FINGER_SCROLL_THRESHOLD_PX = 8;
const REMOTE_WINDOW_CATALOG_UI_TIMEOUT_MS = 20_000;
const REMOTE_WINDOW_CATALOG_PROJECTION_CACHE_TTL_MS = 60_000;
const REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_STORAGE_KEY = 'zterm:remote-window:touch-scroll-fraction-v1';
const REMOTE_WINDOW_TOUCH_SCROLL_INVERTED_STORAGE_KEY = 'zterm:remote-window:touch-scroll-inverted-v1';

const initialFullscreenViewport: FullscreenViewportState = {
  scale: 1,
  panX: 0,
  panY: 0,
};

const initialFullscreenDisplayMode: FullscreenDisplayMode = 'fit';

function cloneRemoteWindowCatalogPayload(
  payload: RemoteWindowStreamTargetsResponsePayload,
): RemoteWindowStreamTargetsResponsePayload {
  return {
    requestId: payload.requestId,
    targets: Array.isArray(payload.targets) ? payload.targets.slice() : [],
    errors: Array.isArray(payload.errors) ? payload.errors.slice() : undefined,
  };
}

function clampFloatingOffset(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function resolveAspectRect(
  surface: SurfaceSize,
  source: { width: number; height: number },
  displayMode: FullscreenDisplayMode,
): SurfaceRect {
  const surfaceWidth = Math.max(1, surface.width);
  const surfaceHeight = Math.max(1, surface.height);
  const sourceWidth = Math.max(1, source.width);
  const sourceHeight = Math.max(1, source.height);
  const scale = displayMode === 'fill'
    ? Math.max(surfaceWidth / sourceWidth, surfaceHeight / sourceHeight)
    : Math.min(surfaceWidth / sourceWidth, surfaceHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    left: (surfaceWidth - width) / 2,
    top: (surfaceHeight - height) / 2,
    width,
    height,
  };
}

function resolveFullscreenViewportRect(
  surface: SurfaceSize,
  source: { width: number; height: number },
  displayMode: FullscreenDisplayMode,
): SurfaceRect {
  if (displayMode === 'fill') {
    return {
      left: 0,
      top: 0,
      width: Math.max(1, surface.width),
      height: Math.max(1, surface.height),
    };
  }
  return resolveAspectRect(surface, source, 'fit');
}

function clampFullscreenViewport(
  viewport: FullscreenViewportState,
  surface: SurfaceSize | null,
  source: { width: number; height: number } | null,
  displayMode: FullscreenDisplayMode = initialFullscreenDisplayMode,
  keyboardPanAllowancePx = 0,
): FullscreenViewportState {
  const scale = clampNumber(
    Number.isFinite(viewport.scale) ? viewport.scale : 1,
    REMOTE_WINDOW_FULLSCREEN_MIN_SCALE,
    REMOTE_WINDOW_FULLSCREEN_MAX_SCALE,
  );
  if (!surface || !source) {
    return { scale, panX: 0, panY: 0 };
  }
  const base = resolveAspectRect(surface, source, displayMode);
  const allowKeyboardPan = keyboardPanAllowancePx > 0;
  const viewportRect = allowKeyboardPan
    ? {
        left: 0,
        top: 0,
        width: Math.max(1, surface.width),
        height: Math.max(1, surface.height),
      }
    : resolveFullscreenViewportRect(surface, source, displayMode);
  const scaledWidth = base.width * scale;
  const scaledHeight = base.height * scale;
  const maxPanX = Math.max(0, Math.abs(scaledWidth - viewportRect.width) / 2);
  const maxPanY = Math.max(0, Math.abs(scaledHeight - viewportRect.height) / 2)
    + Math.max(0, keyboardPanAllowancePx);
  return {
    scale,
    panX: clampNumber(viewport.panX, -maxPanX, maxPanX),
    panY: clampNumber(viewport.panY, -maxPanY, maxPanY),
  };
}

function resolveZoomedContentRect(
  surface: SurfaceSize,
  source: { width: number; height: number },
  viewport: FullscreenViewportState,
  displayMode: FullscreenDisplayMode = initialFullscreenDisplayMode,
): { viewport: SurfaceRect; content: SurfaceRect } {
  const base = resolveAspectRect(surface, source, displayMode);
  const viewportRect = resolveFullscreenViewportRect(surface, source, displayMode);
  const scale = Math.max(1, viewport.scale);
  const width = base.width * scale;
  const height = base.height * scale;
  return {
    viewport: viewportRect,
    content: {
      left: base.left + (base.width - width) / 2 + viewport.panX,
      top: base.top + (base.height - height) / 2 + viewport.panY,
      width,
      height,
    },
  };
}

function resolvePointerDistance(a: SurfacePointerPosition, b: SurfacePointerPosition) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function resolvePointerMidpoint(a: SurfacePointerPosition, b: SurfacePointerPosition) {
  return {
    clientX: (a.clientX + b.clientX) / 2,
    clientY: (a.clientY + b.clientY) / 2,
  };
}

function hasPointerPositionMoved(start: SurfacePointerPosition, current: SurfacePointerPosition) {
  return resolvePointerDistance(start, current) >= 2;
}

function isPointerMovementAlongAxis(
  start: SurfacePointerPosition,
  current: SurfacePointerPosition,
  axisStart: SurfacePointerPosition,
  axisEnd: SurfacePointerPosition,
) {
  const axisX = axisEnd.clientX - axisStart.clientX;
  const axisY = axisEnd.clientY - axisStart.clientY;
  const axisLength = Math.max(1, Math.hypot(axisX, axisY));
  const deltaX = current.clientX - start.clientX;
  const deltaY = current.clientY - start.clientY;
  const projection = Math.abs((deltaX * axisX + deltaY * axisY) / axisLength);
  const perpendicular = Math.abs((deltaX * -axisY + deltaY * axisX) / axisLength);
  return projection >= 4 && projection >= perpendicular;
}

function isSurfacePointerPairGesture(
  gesture: SurfacePointerGesture,
): gesture is Extract<SurfacePointerGesture, {
  mode: 'pinch' | 'twoFingerCandidate' | 'twoFingerScroll';
}> {
  return gesture.mode === 'pinch'
    || gesture.mode === 'twoFingerCandidate'
    || gesture.mode === 'twoFingerScroll';
}

function resolveTouchScrollFractionPreset(value: unknown): RemoteWindowTouchScrollFraction {
  const parsed = typeof value === 'number' ? value : Number(value);
  const matched = REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_OPTIONS.find((option) => option === parsed);
  return matched ?? REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION;
}

function resolveRemoteWindowMinimapViewport(
  fit: SurfaceRect,
  content: SurfaceRect,
) {
  return {
    leftPct: clampNumber(((fit.left - content.left) / content.width) * 100, 0, 100),
    topPct: clampNumber(((fit.top - content.top) / content.height) * 100, 0, 100),
    widthPct: clampNumber((fit.width / content.width) * 100, 0, 100),
    heightPct: clampNumber((fit.height / content.height) * 100, 0, 100),
  };
}

function resolveFloatingOverlaySizing(source: { width: number; height: number }): Pick<CSSProperties, 'width' | 'maxWidth'> {
  const aspectRatio = Math.max(0.2, Math.min(5, source.width / Math.max(1, source.height)));
  if (aspectRatio < 0.85) {
    const maxWidthPx = Math.round(clampNumber(aspectRatio * 420, 220, 320));
    return { width: '64vw', maxWidth: `${maxWidthPx}px` };
  }
  if (aspectRatio > 1.55) {
    return { width: '84vw', maxWidth: '420px' };
  }
  return { width: '74vw', maxWidth: '360px' };
}

function resolveStartedCaptureFrameSize(started?: RemoteWindowStreamStartedPayload | null): SurfaceSize | null {
  const width = started?.capture?.frameWidth;
  const height = started?.capture?.frameHeight;
  if (
    typeof width !== 'number'
    || typeof height !== 'number'
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) {
    return null;
  }
  return {
    width,
    height,
  };
}

function resolveRemoteWindowDisplaySourceSize(
  target: RemoteWindowStreamTargetManifest,
  receiverFrameSize: SurfaceSize | null,
): SurfaceSize {
  if (receiverFrameSize) {
    return receiverFrameSize;
  }
  const sourceRect = getRemoteWindowSourceRect(target);
  return {
    width: sourceRect.width,
    height: sourceRect.height,
  };
}

function formatTargetKind(target: RemoteWindowStreamTargetManifest) {
  return target.videoTarget.kind === 'iterm2-pane' ? 'iTerm2 Pane' : 'App Window';
}

function formatInputRoute(target: RemoteWindowStreamTargetManifest) {
  switch (target.inputRoute) {
    case 'tmux-input':
      return 'tmux';
    case 'iterm2-api':
      return 'iTerm2 API';
    case 'os-event':
      return 'OS event';
  }
}

function isRemoteWindowInputSupported(target: RemoteWindowStreamTargetManifest) {
  return isRemoteWindowInputSupportedTarget(target);
}

function readRemoteWindowNetworkQuality(): RemoteWindowNetworkQualityInput | null {
  const connection = typeof navigator === 'undefined'
    ? null
    : ((navigator as Navigator & {
        connection?: NavigatorConnectionLike;
        mozConnection?: NavigatorConnectionLike;
        webkitConnection?: NavigatorConnectionLike;
      }).connection
      || (navigator as Navigator & { mozConnection?: NavigatorConnectionLike }).mozConnection
      || (navigator as Navigator & { webkitConnection?: NavigatorConnectionLike }).webkitConnection
      || null);
  if (!connection) {
    return null;
  }
  return {
    effectiveType: connection.effectiveType || null,
    downlinkMbps: typeof connection.downlink === 'number' ? connection.downlink : null,
    rttMs: typeof connection.rtt === 'number' ? connection.rtt : null,
    saveData: Boolean(connection.saveData),
  };
}

function mapMouseButton(button: number): 'left' | 'middle' | 'right' | 'none' {
  if (button === 0) {
    return 'left';
  }
  if (button === 1) {
    return 'middle';
  }
  if (button === 2) {
    return 'right';
  }
  return 'none';
}

function pointerSampleFromReactEvent(
  event: ReactPointerEvent<HTMLDivElement>,
): RemoteWindowTouchPointerSample {
  return {
    pointerId: event.pointerId,
    pointerType: event.pointerType || 'mouse',
    clientX: event.clientX,
    clientY: event.clientY,
    button: event.button,
    buttons: event.buttons,
    timeMs: Date.now(),
  };
}

function toOverlayTouchGesture(
  gesture: RemoteWindowTouchPointerState,
  currentViewport: FullscreenViewportState,
  localPanStart: { pointerId: number; startPanX: number; startPanY: number } | null,
): SurfacePointerGesture | null {
  if (gesture.mode === 'idle') {
    return null;
  }
  if (gesture.mode === 'pointerInput') {
    return {
      mode: 'input',
      pointerId: gesture.pointerId,
    };
  }
  if (gesture.mode === 'localPan') {
    const start = localPanStart || {
      pointerId: gesture.pointerId,
      startPanX: currentViewport.panX,
      startPanY: currentViewport.panY,
    };
    return {
      mode: 'pan',
      pointerId: gesture.pointerId,
      startClientX: gesture.startClientX,
      startClientY: gesture.startClientY,
      startPanX: start.startPanX,
      startPanY: start.startPanY,
      moved: gesture.moved,
    };
  }
  return gesture;
}

function toRemoteWindowTouchGestureState(
  gesture: SurfacePointerGesture | null,
): RemoteWindowTouchPointerState {
  if (!gesture) {
    return createRemoteWindowTouchPointerState();
  }
  if (gesture.mode === 'input') {
    return {
      mode: 'pointerInput',
      pointerId: gesture.pointerId,
    };
  }
  if (gesture.mode === 'pan') {
    return {
      mode: 'localPan',
      pointerId: gesture.pointerId,
      startClientX: gesture.startClientX,
      startClientY: gesture.startClientY,
      moved: gesture.moved,
    };
  }
  if (gesture.mode === 'touchPending' || gesture.mode === 'touchDrag') {
    return gesture;
  }
  return createRemoteWindowTouchPointerState();
}

function getRemoteWindowNetworkConnection(): NavigatorConnectionLike | null {
  if (typeof navigator === 'undefined') {
    return null;
  }
  return ((navigator as Navigator & {
    connection?: NavigatorConnectionLike;
    mozConnection?: NavigatorConnectionLike;
    webkitConnection?: NavigatorConnectionLike;
  }).connection
    || (navigator as Navigator & { mozConnection?: NavigatorConnectionLike }).mozConnection
    || (navigator as Navigator & { webkitConnection?: NavigatorConnectionLike }).webkitConnection
    || null);
}

function formatBitrateOption(preset: RemoteWindowVideoBitratePreset) {
  if (preset === 'fullscreen') {
    return '全屏 20 Mbps';
  }
  return `${buildRemoteWindowVideoBitrateConfig(preset).bitrateMbps} Mbps`;
}

function formatTouchScrollFractionOption(fraction: RemoteWindowTouchScrollFraction) {
  if (fraction === 1) {
    return '滚动 1 屏';
  }
  if (fraction === 0.5) {
    return '滚动 1/2 屏';
  }
  if (fraction === 0.25) {
    return '滚动 1/4 屏';
  }
  return '滚动 1/8 屏';
}

function readRemoteWindowTouchScrollFraction(): RemoteWindowTouchScrollFraction {
  if (typeof window === 'undefined') {
    return REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION;
  }
  return resolveTouchScrollFractionPreset(
    window.localStorage.getItem(REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_STORAGE_KEY),
  );
}

function writeRemoteWindowTouchScrollFraction(fraction: RemoteWindowTouchScrollFraction) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_STORAGE_KEY, String(fraction));
}

function readRemoteWindowTouchScrollInverted() {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.localStorage.getItem(REMOTE_WINDOW_TOUCH_SCROLL_INVERTED_STORAGE_KEY) === 'true';
}

function writeRemoteWindowTouchScrollInverted(inverted: boolean) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(REMOTE_WINDOW_TOUCH_SCROLL_INVERTED_STORAGE_KEY, inverted ? 'true' : 'false');
}

function formatTargetSubtitle(target: RemoteWindowStreamTargetManifest) {
  const tmux = target.inputTarget.tmuxSession
    ? `tmux ${target.inputTarget.tmuxSession}${target.inputTarget.tmuxPaneId ? ` ${target.inputTarget.tmuxPaneId}` : ''}`
    : '';
  const geometry = target.videoTarget.cropRectTopLeftPx || target.videoTarget.windowBoundsTopLeftPx;
  const route = formatInputRoute(target);
  const inputMode = isRemoteWindowInputSupported(target) ? '可操作' : '只读';
  return [tmux, `${geometry.width}x${geometry.height}`, route, inputMode].filter(Boolean).join(' · ');
}

function renderErrors(errors: RemoteWindowStreamErrorPayload[]) {
  if (errors.length === 0) {
    return null;
  }
  return (
    <div data-testid="remote-window-partial-errors" style={styles.errorStrip}>
      {errors.map((error) => (
        <div key={`${error.requestId}:${error.code}:${error.message}`}>
          {error.code}: {error.message}
        </div>
      ))}
    </div>
  );
}

export const RemoteWindowOverlay = memo(function RemoteWindowOverlay({
  activeSessionId,
  appForegroundActive = true,
  requestTargets,
  startStream,
  updateStreamQuality,
  stopStream,
  requestScreenshot,
  sendInput,
  onInputDebug,
  bottomInsetPx = 0,
  bottomChromeInsetPx = 0,
  onOpenStateChange,
  onBodySubscriptionSuppressedChange,
  onInputContextChange,
  onRequestKeyboard,
}: RemoteWindowOverlayProps) {
  const [state, setState] = useState<RemoteWindowOverlayState>(initialRemoteWindowOverlayState);
  const [floatingOffset, setFloatingOffsetState] = useState<FloatingOverlayOffset>({ x: 0, y: 0 });
  const [floatingOverlayWidthPx, setFloatingOverlayWidthPxState] = useState<number | null>(null);
  const [entryOffset, setEntryOffsetState] = useState<FloatingOverlayOffset>({ x: 0, y: 0 });
  const [surfaceSize, setSurfaceSize] = useState<SurfaceSize | null>(null);
  const [fullscreenViewport, setFullscreenViewportState] = useState<FullscreenViewportState>(initialFullscreenViewport);
  const [fullscreenDisplayMode, setFullscreenDisplayModeState] = useState<FullscreenDisplayMode>(initialFullscreenDisplayMode);
  const [bitratePreset, setBitratePreset] = useState<RemoteWindowVideoBitratePreset>('5mbps');
  const [touchScrollFraction, setTouchScrollFractionState] = useState<RemoteWindowTouchScrollFraction>(() => readRemoteWindowTouchScrollFraction());
  const [touchScrollInverted, setTouchScrollInvertedState] = useState(() => readRemoteWindowTouchScrollInverted());
  const [networkQuality, setNetworkQuality] = useState<RemoteWindowNetworkQualityInput | null>(() => readRemoteWindowNetworkQuality());
  const [videoHasPlayed, setVideoHasPlayed] = useState(false);
  const [receiverMediaStream, setReceiverMediaStream] = useState<MediaStream | null>(null);
  const [receiverFrameSize, setReceiverFrameSize] = useState<SurfaceSize | null>(null);
  const [itermPaneTargetsExpanded, setItermPaneTargetsExpanded] = useState(false);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [screenshotStatus, setScreenshotStatus] = useState<RemoteWindowScreenshotStatus>({ phase: 'idle' });
  const floatingOffsetRef = useRef(floatingOffset);
  const floatingOverlayWidthPxRef = useRef(floatingOverlayWidthPx);
  const entryOffsetRef = useRef(entryOffset);
  const fullscreenViewportRef = useRef(fullscreenViewport);
  const fullscreenDisplayModeRef = useRef<FullscreenDisplayMode>(fullscreenDisplayMode);
  const touchScrollFractionRef = useRef<RemoteWindowTouchScrollFraction>(touchScrollFraction);
  const touchScrollInvertedRef = useRef(touchScrollInverted);
  const floatingOverlayRef = useRef<HTMLDivElement | null>(null);
  const entryButtonRef = useRef<HTMLButtonElement | null>(null);
  const floatingDragRef = useRef<FloatingOverlayDrag | null>(null);
  const floatingResizeRef = useRef<FloatingOverlayResize | null>(null);
  const entryDragRef = useRef<FloatingEntryDrag | null>(null);
  const entryLongPressTimerRef = useRef<number | null>(null);
  const videoSurfaceRef = useRef<HTMLDivElement | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const activeStreamIdRef = useRef<string | null>(null);
  const collectStreamStatsRef = useRef<(() => Promise<RemoteWindowVideoStatsSample | null>) | null>(null);
  const adaptiveVideoStateRef = useRef<RemoteWindowVideoAdaptiveState | null>(null);
  const lastAppliedStreamQualityKeyRef = useRef<string | null>(null);
  const surfacePointersRef = useRef<Map<number, SurfacePointerPosition>>(new Map());
  const surfaceGestureRef = useRef<SurfacePointerGesture | null>(null);
  const surfaceLocalPanStartRef = useRef<{
    pointerId: number;
    startPanX: number;
    startPanY: number;
  } | null>(null);
  const catalogWatchdogRef = useRef<number | null>(null);
  const catalogWatchdogEpochRef = useRef<number | null>(null);
  const lastCatalogPayloadRef = useRef<RemoteWindowCatalogProjectionSnapshot | null>(null);
  const lastTouchEndAtRef = useRef(0);
  const lastReportedQuickBarSuppressionRef = useRef<boolean | null>(null);
  const lastReportedBodySuppressionRef = useRef<boolean | null>(null);
  const lastReportedInputContextKeyRef = useRef<string | null>(null);
  const suppressEntryClickRef = useRef(false);
  const bitratePresetTouchedRef = useRef(false);
  const lastAutoFullscreenImePanRef = useRef<{ key: string; panY: number } | null>(null);
  const quickBarSuppressed = state.phase === 'targetEnumerating'
    || state.phase === 'pickerOpen';
  const bodySubscriptionSuppressed = state.phase === 'targetEnumerating'
    || state.phase === 'pickerOpen'
    || (state.phase === 'targetLocked' && state.mode === 'fullscreen');
  const inputContext = state.phase === 'targetLocked'
    && state.streamId
    && state.streamStatus !== 'error'
    && isRemoteWindowInputSupported(state.target)
    && activeSessionId
    ? {
        sessionId: activeSessionId,
        streamId: state.streamId,
        targetId: state.target.streamTargetId,
        targetKind: state.target.videoTarget.kind,
        inputTargetKind: state.target.inputTarget.kind,
        focusPolicy: state.target.focusPolicy,
        inputRoute: state.target.inputRoute,
      }
    : null;
  const inputContextKey = inputContext
    ? [
        inputContext.sessionId,
        inputContext.streamId,
        inputContext.targetId,
        inputContext.targetKind,
        inputContext.inputTargetKind,
        inputContext.focusPolicy,
        inputContext.inputRoute,
      ].join('|')
    : '';

  const dispatchRemoteWindowInputEvents = useCallback((
    events: Array<RemoteWindowInputEventPayload['event']>,
  ) => {
    if (
      state.phase !== 'targetLocked'
      || !state.streamId
      || !activeSessionId
      || !isRemoteWindowInputSupported(state.target)
    ) {
      return false;
    }
    try {
      const result = dispatchRemoteWindowTouchInputActionsRuntime({
        source: 'overlay',
        sessionId: activeSessionId || null,
        streamId: state.streamId,
        target: state.target,
        events,
        sendInput,
        onDebug: onInputDebug,
      });
      return result.failedCount === 0 && result.sentCount === events.length;
    } catch (error) {
      console.warn('[RemoteWindowOverlay] remote input send failed:', error);
      onInputDebug?.({
        source: 'overlay',
        sent: false,
        sessionId: activeSessionId || null,
        streamId: state.streamId || null,
        targetId: state.target.streamTargetId || null,
        targetTitle: state.target.videoTarget.title || state.target.videoTarget.appBundleId || null,
        event: events[0] || { kind: 'focus' },
      });
      return false;
    }
  }, [activeSessionId, onInputDebug, sendInput, state]);

  const setFloatingOffset = useCallback((next: FloatingOverlayOffset) => {
    floatingOffsetRef.current = next;
    setFloatingOffsetState(next);
  }, []);

  const setFloatingOverlayWidthPx = useCallback((next: number | null) => {
    floatingOverlayWidthPxRef.current = next;
    setFloatingOverlayWidthPxState(next);
  }, []);

  const setEntryOffset = useCallback((next: FloatingOverlayOffset) => {
    entryOffsetRef.current = next;
    setEntryOffsetState(next);
  }, []);

  const resolveFloatingOverlayResizeBounds = useCallback((
    rect: { left: number; right: number; bottom: number; width: number },
    source: { width: number; height: number },
    anchor: FloatingResizeAnchor,
  ) => {
    const viewportWidth = Math.round(window.visualViewport?.width || window.innerWidth || 0);
    const viewportHeight = Math.round(window.visualViewport?.height || window.innerHeight || 0);
    const bottomReserve = REMOTE_WINDOW_FLOATING_BOTTOM_BASE_PX + Math.max(0, bottomInsetPx);
    const aspectRatio = Math.max(0.2, Math.min(5, source.width / Math.max(1, source.height)));
    const maxByHorizontalPosition = anchor === 'right-bottom'
      ? viewportWidth - FLOATING_OVERLAY_VIEWPORT_MARGIN_PX - rect.left
      : rect.right - FLOATING_OVERLAY_VIEWPORT_MARGIN_PX;
    const maxByWidth = Math.max(
      FLOATING_OVERLAY_MIN_WIDTH_PX,
      Math.min(
        viewportWidth - FLOATING_OVERLAY_VIEWPORT_MARGIN_PX * 2,
        maxByHorizontalPosition,
      ),
    );
    const maxByHeight = Math.max(
      FLOATING_OVERLAY_MIN_WIDTH_PX,
      (viewportHeight - bottomReserve - FLOATING_OVERLAY_VIEWPORT_MARGIN_PX - FLOATING_OVERLAY_TOOLBAR_ESTIMATE_PX) * aspectRatio,
    );
    const maxByReachableToolbar = Math.max(
      FLOATING_OVERLAY_MIN_WIDTH_PX,
      (rect.bottom - FLOATING_OVERLAY_VIEWPORT_MARGIN_PX - FLOATING_OVERLAY_TOOLBAR_ESTIMATE_PX) * aspectRatio,
    );
    const maxWidth = Math.max(
      FLOATING_OVERLAY_MIN_WIDTH_PX,
      Math.min(FLOATING_OVERLAY_MAX_WIDTH_PX, maxByWidth, maxByHeight, maxByReachableToolbar),
    );
    return {
      aspectRatio,
      minWidth: Math.min(maxWidth, FLOATING_OVERLAY_MIN_WIDTH_PX),
      maxWidth,
    };
  }, [bottomInsetPx]);

  const clampEntryOffset = useCallback((
    drag: FloatingEntryDrag,
    nextLeft: number,
    nextTop: number,
  ) => {
    const viewportWidth = Math.max(
      drag.width + FLOATING_ENTRY_VIEWPORT_MARGIN_PX * 2,
      Math.round(window.visualViewport?.width || window.innerWidth || 0),
    );
    const viewportHeight = Math.max(
      drag.height + FLOATING_ENTRY_VIEWPORT_MARGIN_PX * 2,
      Math.round(window.visualViewport?.height || window.innerHeight || 0),
    );
    const minLeft = FLOATING_ENTRY_VIEWPORT_MARGIN_PX;
    const minTop = FLOATING_ENTRY_TOP_MARGIN_PX;
    const maxLeft = Math.max(minLeft, viewportWidth - drag.width - FLOATING_ENTRY_VIEWPORT_MARGIN_PX);
    const maxTop = Math.max(minTop, viewportHeight - drag.height - FLOATING_ENTRY_VIEWPORT_MARGIN_PX);
    return {
      x: clampFloatingOffset(nextLeft, minLeft, maxLeft) - drag.baseLeft,
      y: clampFloatingOffset(nextTop, minTop, maxTop) - drag.baseTop,
    };
  }, []);

  const clearCatalogWatchdog = useCallback((requestEpoch?: number) => {
    if (
      typeof requestEpoch === 'number'
      && catalogWatchdogEpochRef.current !== requestEpoch
    ) {
      return;
    }
    if (catalogWatchdogRef.current !== null) {
      window.clearTimeout(catalogWatchdogRef.current);
      catalogWatchdogRef.current = null;
    }
    catalogWatchdogEpochRef.current = null;
  }, []);

  const clearEntryLongPressTimer = useCallback(() => {
    if (entryLongPressTimerRef.current !== null) {
      window.clearTimeout(entryLongPressTimerRef.current);
      entryLongPressTimerRef.current = null;
    }
  }, []);

  const readVideoSurfaceSize = useCallback((): SurfaceSize | null => {
    const rect = videoSurfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return surfaceSize;
    }
    return {
      width: rect.width,
      height: rect.height,
    };
  }, [surfaceSize]);

  const setFullscreenViewport = useCallback((
    next: FullscreenViewportState | ((current: FullscreenViewportState) => FullscreenViewportState),
  ) => {
    const measuredSurfaceSize = readVideoSurfaceSize();
    if (measuredSurfaceSize) {
      setSurfaceSize((current) => (
        current
        && current.width === measuredSurfaceSize.width
        && current.height === measuredSurfaceSize.height
          ? current
          : measuredSurfaceSize
      ));
    }
    setFullscreenViewportState((current) => {
      const raw = typeof next === 'function' ? next(current) : next;
      const displaySourceSize = state.phase === 'targetLocked'
        ? resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize)
        : null;
      const displayMode = state.phase === 'targetLocked' && state.mode === 'fullscreen'
        ? fullscreenDisplayModeRef.current
        : initialFullscreenDisplayMode;
      const clamped = clampFullscreenViewport(
        raw,
        measuredSurfaceSize,
        displaySourceSize,
        displayMode,
        bottomInsetPx,
      );
      fullscreenViewportRef.current = clamped;
      return clamped;
    });
  }, [bottomInsetPx, readVideoSurfaceSize, receiverFrameSize, state]);

  const resetFullscreenViewport = useCallback(() => {
    fullscreenViewportRef.current = initialFullscreenViewport;
    setFullscreenViewportState(initialFullscreenViewport);
    surfacePointersRef.current.clear();
    surfaceGestureRef.current = null;
  }, []);

  const setFullscreenDisplayMode = useCallback((next: FullscreenDisplayMode) => {
    fullscreenDisplayModeRef.current = next;
    setFullscreenDisplayModeState(next);
  }, []);

  const setTouchScrollFraction = useCallback((next: RemoteWindowTouchScrollFraction) => {
    touchScrollFractionRef.current = next;
    setTouchScrollFractionState(next);
    writeRemoteWindowTouchScrollFraction(next);
  }, []);

  const setTouchScrollInverted = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    setTouchScrollInvertedState((current) => {
      const resolved = typeof next === 'function' ? next(current) : next;
      touchScrollInvertedRef.current = resolved;
      writeRemoteWindowTouchScrollInverted(resolved);
      return resolved;
    });
  }, []);

  useLayoutEffect(() => {
    if (state.phase !== 'targetLocked') {
      setSurfaceSize(null);
      return;
    }
    const surface = videoSurfaceRef.current;
    if (!surface) {
      return;
    }
    const update = () => {
      const rect = surface.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const next = { width: rect.width, height: rect.height };
      setSurfaceSize((current) => (
        current && current.width === next.width && current.height === next.height ? current : next
      ));
      const displaySourceSize = resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize);
      const displayMode = state.mode === 'fullscreen'
        ? fullscreenDisplayMode
        : initialFullscreenDisplayMode;
      setFullscreenViewportState((current) => {
        const clamped = clampFullscreenViewport(current, next, displaySourceSize, displayMode, bottomInsetPx);
        fullscreenViewportRef.current = clamped;
        return clamped;
      });
    };
    update();
    const ResizeObserverCtor = typeof ResizeObserver === 'undefined' ? null : ResizeObserver;
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(update) : null;
    observer?.observe(surface);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [bottomInsetPx, fullscreenDisplayMode, receiverFrameSize, state]);

  useEffect(() => {
    if (
      state.phase !== 'targetLocked'
      || state.mode !== 'fullscreen'
      || !surfaceSize
    ) {
      lastAutoFullscreenImePanRef.current = null;
      return;
    }
    const safeBottomInsetPx = Math.max(0, Math.round(bottomInsetPx));
    const safeChromeInsetPx = Math.max(0, Math.min(
      safeBottomInsetPx,
      Math.round(bottomChromeInsetPx),
    ));
    const keyboardLiftPx = safeBottomInsetPx - safeChromeInsetPx;
    if (safeBottomInsetPx <= 0 || safeChromeInsetPx <= 0 || keyboardLiftPx <= 0) {
      lastAutoFullscreenImePanRef.current = null;
      return;
    }

    const displaySourceSize = resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize);
    const autoKey = [
      state.target.streamTargetId,
      fullscreenDisplayMode,
      displaySourceSize.width,
      displaySourceSize.height,
      surfaceSize.width,
      surfaceSize.height,
      safeBottomInsetPx,
      safeChromeInsetPx,
    ].join('|');
    const requestedPanY = -safeChromeInsetPx;
    setFullscreenViewportState((current) => {
      const lastAutoPan = lastAutoFullscreenImePanRef.current;
      const manualPanActive = lastAutoPan
        ? Math.abs(current.panY - lastAutoPan.panY) > 1
        : Math.abs(current.panY) > 1;
      if (manualPanActive) {
        return current;
      }
      const clamped = clampFullscreenViewport(
        { ...current, panY: requestedPanY },
        surfaceSize,
        displaySourceSize,
        fullscreenDisplayMode,
        safeBottomInsetPx,
      );
      lastAutoFullscreenImePanRef.current = { key: autoKey, panY: clamped.panY };
      fullscreenViewportRef.current = clamped;
      return clamped;
    });
  }, [bottomChromeInsetPx, bottomInsetPx, fullscreenDisplayMode, receiverFrameSize, state, surfaceSize]);

  const handleOpenPicker = useCallback((options?: { forceRefresh?: boolean }) => {
    clearCatalogWatchdog();
    setItermPaneTargetsExpanded(false);
    setReceiverFrameSize(null);
    const started = beginRemoteWindowTargetEnumeration(state);
    const targetSessionId = activeSessionId?.trim() || '';
    const cachedSnapshot = lastCatalogPayloadRef.current;
    const canProjectCachedCatalog = Boolean(
      cachedSnapshot
      && cachedSnapshot.sessionId === targetSessionId,
    );
    const forceRefresh = options?.forceRefresh === true;
    if (canProjectCachedCatalog && cachedSnapshot) {
      setState(applyRemoteWindowTargetCatalog(
        started.state,
        started.requestEpoch,
        cloneRemoteWindowCatalogPayload(cachedSnapshot.payload),
      ));
    } else {
      setState(started.state);
    }
    if (!targetSessionId || !requestTargets) {
      setCatalogRefreshing(false);
      setState((current) => (
        failRemoteWindowTargetCatalog(current, started.requestEpoch, new Error('当前没有可用的 daemon session'))
      ));
      return;
    }

    const cacheAgeMs = canProjectCachedCatalog && cachedSnapshot
      ? Date.now() - cachedSnapshot.updatedAt
      : Number.POSITIVE_INFINITY;
    if (
      canProjectCachedCatalog
      && cachedSnapshot
      && !forceRefresh
      && cacheAgeMs >= 0
      && cacheAgeMs < REMOTE_WINDOW_CATALOG_PROJECTION_CACHE_TTL_MS
    ) {
      setCatalogRefreshing(false);
      return;
    }

    setCatalogRefreshing(canProjectCachedCatalog);
    catalogWatchdogEpochRef.current = started.requestEpoch;
    catalogWatchdogRef.current = window.setTimeout(() => {
      catalogWatchdogRef.current = null;
      catalogWatchdogEpochRef.current = null;
      setCatalogRefreshing(false);
      setState((current) => (
        canProjectCachedCatalog
        && current.phase === 'pickerOpen'
        && current.requestEpoch === started.requestEpoch
          ? {
              ...current,
              errorMessage: '远程窗口列表读取超时，请检查 daemon 窗口枚举能力',
            }
          : failRemoteWindowTargetCatalog(
              current,
              started.requestEpoch,
              new Error('远程窗口列表读取超时，请检查 daemon 窗口枚举能力'),
            )
      ));
    }, REMOTE_WINDOW_CATALOG_UI_TIMEOUT_MS);

    const requestPromise = forceRefresh
      ? requestTargets(targetSessionId, { forceRefresh: true })
      : requestTargets(targetSessionId);
    void requestPromise
      .then((payload) => {
        clearCatalogWatchdog(started.requestEpoch);
        setCatalogRefreshing(false);
        const cachedPayload = cloneRemoteWindowCatalogPayload(payload);
        lastCatalogPayloadRef.current = {
          sessionId: targetSessionId,
          payload: cachedPayload,
          updatedAt: Date.now(),
        };
        setState((current) => applyRemoteWindowTargetCatalog(current, started.requestEpoch, cachedPayload));
      })
      .catch((error) => {
        clearCatalogWatchdog(started.requestEpoch);
        setCatalogRefreshing(false);
        setState((current) => (
          canProjectCachedCatalog
          && current.phase === 'pickerOpen'
          && current.requestEpoch === started.requestEpoch
            ? {
                ...current,
                errorMessage: error instanceof Error ? error.message : String(error),
              }
            : failRemoteWindowTargetCatalog(current, started.requestEpoch, error)
        ));
      });
  }, [activeSessionId, clearCatalogWatchdog, requestTargets, state]);

  const handleClose = useCallback(() => {
    clearCatalogWatchdog();
    setItermPaneTargetsExpanded(false);
    setCatalogRefreshing(false);
    floatingDragRef.current = null;
    floatingResizeRef.current = null;
    clearEntryLongPressTimer();
    surfacePointersRef.current.clear();
    surfaceGestureRef.current = null;
    bitratePresetTouchedRef.current = false;
    setScreenshotStatus({ phase: 'idle' });
    lastAutoFullscreenImePanRef.current = null;
    if (state.phase === 'targetLocked' && state.streamId && activeSessionId && stopStream) {
      void Promise.resolve(stopStream(activeSessionId, state.streamId)).catch((error) => {
        console.error('[RemoteWindowOverlay] remote stream stop failed:', error);
      });
    }
    activeStreamIdRef.current = null;
    collectStreamStatsRef.current = null;
    adaptiveVideoStateRef.current = null;
    lastAppliedStreamQualityKeyRef.current = null;
    setReceiverMediaStream(null);
    setReceiverFrameSize(null);
    collectStreamStatsRef.current = null;
    adaptiveVideoStateRef.current = null;
    setFloatingOffset({ x: 0, y: 0 });
    setFloatingOverlayWidthPx(null);
    resetFullscreenViewport();
    setFullscreenDisplayMode(initialFullscreenDisplayMode);
    setState((current) => closeRemoteWindowOverlay(current));
  }, [
    activeSessionId,
    clearCatalogWatchdog,
    clearEntryLongPressTimer,
    resetFullscreenViewport,
    setFloatingOffset,
    setFloatingOverlayWidthPx,
    setFullscreenDisplayMode,
    state,
    stopStream,
  ]);

  useEffect(() => {
    if (appForegroundActive !== false || state.phase === 'closed') {
      return;
    }
    handleClose();
  }, [appForegroundActive, handleClose, state.phase]);

  const publishRemoteWindowInputContext = useCallback(() => {
    if (!inputContext) {
      return;
    }
    lastReportedInputContextKeyRef.current = inputContextKey;
    onInputContextChange?.(inputContext);
  }, [inputContext, inputContextKey, onInputContextChange]);

  const handleShrink = useCallback(() => {
    resetFullscreenViewport();
    setState((current) => shrinkRemoteWindowOverlay(current));
  }, [resetFullscreenViewport]);

  const handleFullscreen = useCallback(() => {
    publishRemoteWindowInputContext();
    resetFullscreenViewport();
    setState((current) => enterRemoteWindowFullscreen(current));
  }, [publishRemoteWindowInputContext, resetFullscreenViewport]);

  const handleRequestKeyboard = useCallback(() => {
    publishRemoteWindowInputContext();
    onRequestKeyboard?.();
  }, [onRequestKeyboard, publishRemoteWindowInputContext]);

  const handleToggleFullscreenDisplayMode = useCallback(() => {
    resetFullscreenViewport();
    setFullscreenDisplayMode(fullscreenDisplayMode === 'fit' ? 'fill' : 'fit');
  }, [fullscreenDisplayMode, resetFullscreenViewport, setFullscreenDisplayMode]);

  const handleBitratePresetChange = useCallback((nextPreset: RemoteWindowVideoBitratePreset) => {
    if (!REMOTE_WINDOW_VIDEO_BITRATE_PRESETS.includes(nextPreset)) {
      return;
    }
    bitratePresetTouchedRef.current = true;
    setBitratePreset(nextPreset);
    if (state.phase !== 'targetLocked') {
      return;
    }
    writeRemoteWindowVideoBitratePreset(state.target, nextPreset);
  }, [state]);

  const handleTouchScrollFractionChange = useCallback((value: string) => {
    setTouchScrollFraction(resolveTouchScrollFractionPreset(value));
  }, [setTouchScrollFraction]);

  const handleToggleTouchScrollDirection = useCallback(() => {
    setTouchScrollInverted((current) => !current);
  }, [setTouchScrollInverted]);

  const effectiveBitratePreset = state.phase === 'targetLocked'
    ? resolveEffectiveRemoteWindowVideoBitratePreset(bitratePreset, {
        mode: state.mode,
        fullscreenScale: fullscreenViewport.scale,
      })
    : null;
  const adaptiveBitratePreset = effectiveBitratePreset
    ? resolveAdaptiveRemoteWindowVideoBitratePreset(effectiveBitratePreset, networkQuality)
    : null;

  useEffect(() => {
    const connection = getRemoteWindowNetworkConnection();
    if (!connection || typeof connection.addEventListener !== 'function') {
      return;
    }
    const handleNetworkChange = () => {
      setNetworkQuality(readRemoteWindowNetworkQuality());
    };
    connection.addEventListener('change', handleNetworkChange);
    return () => {
      connection.removeEventListener('change', handleNetworkChange);
    };
  }, []);

  useEffect(() => {
    if (
      state.phase !== 'targetLocked'
      || !state.streamId
      || !state.streamStarted
      || !activeSessionId
      || !updateStreamQuality
      || !adaptiveBitratePreset
    ) {
      return;
    }
    const videoBitrate = buildRemoteWindowVideoBitrateConfig(adaptiveBitratePreset);
    const qualityKey = [
      activeSessionId,
      state.streamId,
      state.target.streamTargetId,
      adaptiveBitratePreset,
      videoBitrate.maxBitrateBps,
      videoBitrate.maxFrameRateFps ?? '',
    ].join('|');
    if (lastAppliedStreamQualityKeyRef.current === qualityKey) {
      return;
    }
    lastAppliedStreamQualityKeyRef.current = qualityKey;
    try {
      updateStreamQuality(activeSessionId, {
        streamId: state.streamId,
        targetId: state.target.streamTargetId,
        videoBitrate,
      });
    } catch (error) {
      console.warn('[RemoteWindowOverlay] remote window bitrate update failed:', error);
    }
  }, [activeSessionId, adaptiveBitratePreset, state, updateStreamQuality]);

  useEffect(() => {
    if (
      state.phase !== 'targetLocked'
      || !state.streamId
      || !state.streamStarted
      || !activeSessionId
      || !updateStreamQuality
      || !adaptiveBitratePreset
    ) {
      return;
    }
    const streamId = state.streamId;
    const targetId = state.target.streamTargetId;
    let stopped = false;
    const tick = async () => {
      const collectStats = collectStreamStatsRef.current;
      if (!collectStats) {
        return;
      }
      try {
        const sample = await collectStats();
        if (stopped || !sample) {
          return;
        }
        const baseline = buildRemoteWindowVideoBitrateConfig(adaptiveBitratePreset);
        const decision = resolveRemoteWindowVideoAdaptiveDecision({
          baseline,
          previous: adaptiveVideoStateRef.current,
          sample,
        });
        adaptiveVideoStateRef.current = decision.state;
        const qualityKey = [
          activeSessionId,
          streamId,
          targetId,
          decision.config.preset,
          decision.config.maxBitrateBps,
          decision.config.maxFrameRateFps ?? '',
        ].join('|');
        if (lastAppliedStreamQualityKeyRef.current === qualityKey) {
          return;
        }
        lastAppliedStreamQualityKeyRef.current = qualityKey;
        updateStreamQuality(activeSessionId, {
          streamId,
          targetId,
          videoBitrate: decision.config,
        });
      } catch (error) {
        console.warn('[RemoteWindowOverlay] remote window stats quality update failed:', error);
      }
    };
    const timer = window.setInterval(() => {
      void tick();
    }, 2000);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeSessionId, adaptiveBitratePreset, state, updateStreamQuality]);

  const updateFloatingDragFromPointer = useCallback((pointerId: number, clientX: number, clientY: number) => {
    const drag = floatingDragRef.current;
    if (!drag || drag.pointerId !== pointerId) {
      return false;
    }
    setFloatingOffset({
      x: clampFloatingOffset(
        drag.startOffset.x + clientX - drag.startClientX,
        drag.minX,
        drag.maxX,
      ),
      y: clampFloatingOffset(
        drag.startOffset.y + clientY - drag.startClientY,
        drag.minY,
        drag.maxY,
      ),
    });
    return true;
  }, [setFloatingOffset]);

  const finishFloatingDrag = useCallback((pointerId: number) => {
    const drag = floatingDragRef.current;
    if (!drag || drag.pointerId !== pointerId) {
      return false;
    }
    floatingDragRef.current = null;
    try {
      drag.captureElement?.releasePointerCapture?.(pointerId);
    } catch (error) {
      console.warn('[RemoteWindowOverlay] remote window overlay pointer release failed:', error);
    }
    return true;
  }, []);

  const updateFloatingResizeFromPointer = useCallback((pointerId: number, clientX: number, clientY: number) => {
    const resize = floatingResizeRef.current;
    if (!resize || resize.pointerId !== pointerId) {
      return false;
    }
    const horizontalDelta = resize.anchor === 'right-bottom'
      ? clientX - resize.startClientX
      : resize.startClientX - clientX;
    const verticalDelta = (clientY - resize.startClientY) * resize.aspectRatio;
    const widthDelta = Math.abs(verticalDelta) > Math.abs(horizontalDelta)
      ? verticalDelta
      : horizontalDelta;
    const nextWidth = Math.round(clampNumber(
      resize.startWidth + widthDelta,
      resize.minWidth,
      resize.maxWidth,
    ));
    setFloatingOverlayWidthPx(nextWidth);
    if (resize.anchor === 'right-bottom') {
      setFloatingOffset({
        ...resize.startOffset,
        x: resize.startOffset.x + nextWidth - resize.startWidth,
      });
    }
    return true;
  }, [setFloatingOffset, setFloatingOverlayWidthPx]);

  const finishFloatingResize = useCallback((pointerId: number) => {
    const resize = floatingResizeRef.current;
    if (!resize || resize.pointerId !== pointerId) {
      return false;
    }
    floatingResizeRef.current = null;
    try {
      resize.captureElement?.releasePointerCapture?.(pointerId);
    } catch (error) {
      console.warn('[RemoteWindowOverlay] remote window overlay resize pointer release failed:', error);
    }
    return true;
  }, []);

  const updateEntryDragFromPointer = useCallback((pointerId: number, clientX: number, clientY: number) => {
    const drag = entryDragRef.current;
    if (!drag || drag.pointerId !== pointerId) {
      return false;
    }
    const deltaX = clientX - drag.startClientX;
    const deltaY = clientY - drag.startClientY;
    if (!drag.active && Math.hypot(deltaX, deltaY) >= FLOATING_ENTRY_DRAG_THRESHOLD_PX) {
      clearEntryLongPressTimer();
      drag.active = true;
      suppressEntryClickRef.current = true;
    }
    if (!drag.active) {
      return false;
    }
    setEntryOffset(clampEntryOffset(
      drag,
      drag.baseLeft + deltaX,
      drag.baseTop + deltaY,
    ));
    return true;
  }, [clampEntryOffset, clearEntryLongPressTimer, setEntryOffset]);

  const finishEntryDrag = useCallback((pointerId: number, options: { suppressClick: boolean } = { suppressClick: true }) => {
    const drag = entryDragRef.current;
    if (!drag || drag.pointerId !== pointerId) {
      return false;
    }
    clearEntryLongPressTimer();
    if (drag.active && options.suppressClick) {
      suppressEntryClickRef.current = true;
      window.setTimeout(() => {
        suppressEntryClickRef.current = false;
      }, 180);
    }
    entryDragRef.current = null;
    try {
      drag.captureElement?.releasePointerCapture?.(pointerId);
    } catch (error) {
      console.warn('[RemoteWindowOverlay] remote window entry pointer release failed:', error);
    }
    return true;
  }, [clearEntryLongPressTimer]);

  const handleFloatingDragStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      state.phase !== 'targetLocked'
      || state.mode !== 'floating'
      || (event.pointerType === 'mouse' && event.button !== 0)
      || (
        event.target instanceof Element
        && event.target.closest('button, select, input, textarea, [data-no-drag="true"]')
      )
    ) {
      return;
    }
    const overlay = floatingOverlayRef.current;
    if (!overlay) {
      return;
    }
    const rect = overlay.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width || window.innerWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const startOffset = floatingOffsetRef.current;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch (error) {
      console.warn('[RemoteWindowOverlay] remote window overlay pointer capture failed:', error);
    }
    floatingDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffset,
      minX: startOffset.x + FLOATING_OVERLAY_VIEWPORT_MARGIN_PX - rect.left,
      maxX: startOffset.x + viewportWidth - FLOATING_OVERLAY_VIEWPORT_MARGIN_PX - rect.right,
      minY: startOffset.y + FLOATING_OVERLAY_VIEWPORT_MARGIN_PX - rect.top,
      maxY: startOffset.y + viewportHeight - FLOATING_OVERLAY_VIEWPORT_MARGIN_PX - rect.bottom,
      captureElement: event.currentTarget,
    };
    event.preventDefault();
    event.stopPropagation();
  }, [state]);

  const handleFloatingDragMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!updateFloatingDragFromPointer(event.pointerId, event.clientX, event.clientY)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, [updateFloatingDragFromPointer]);

  const handleFloatingDragEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!finishFloatingDrag(event.pointerId)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, [finishFloatingDrag]);

  const handleFloatingResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>, anchor: FloatingResizeAnchor) => {
    if (
      state.phase !== 'targetLocked'
      || state.mode !== 'floating'
      || (event.pointerType === 'mouse' && event.button !== 0)
    ) {
      return;
    }
    const overlay = floatingOverlayRef.current;
    if (!overlay) {
      return;
    }
    const rect = overlay.getBoundingClientRect();
    const displaySourceSize = resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize);
    const currentWidth = Math.max(
      FLOATING_OVERLAY_MIN_WIDTH_PX,
      Math.round(floatingOverlayWidthPxRef.current || rect.width || FLOATING_OVERLAY_MIN_WIDTH_PX),
    );
    const resizeBounds = resolveFloatingOverlayResizeBounds(rect, displaySourceSize, anchor);
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch (error) {
      console.warn('[RemoteWindowOverlay] remote window overlay resize pointer capture failed:', error);
    }
    floatingResizeRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWidth: clampNumber(currentWidth, resizeBounds.minWidth, resizeBounds.maxWidth),
      startOffset: floatingOffsetRef.current,
      minWidth: resizeBounds.minWidth,
      maxWidth: resizeBounds.maxWidth,
      aspectRatio: resizeBounds.aspectRatio,
      anchor,
      captureElement: event.currentTarget,
    };
    event.preventDefault();
    event.stopPropagation();
  }, [receiverFrameSize, resolveFloatingOverlayResizeBounds, state]);

  const handleFloatingResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!updateFloatingResizeFromPointer(event.pointerId, event.clientX, event.clientY)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, [updateFloatingResizeFromPointer]);

  const handleFloatingResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!finishFloatingResize(event.pointerId)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, [finishFloatingResize]);

  const handleEntryPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (state.phase !== 'closed') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    try {
      event.currentTarget.setPointerCapture?.(pointerId);
    } catch (error) {
      console.warn('[RemoteWindowOverlay] remote window entry pointer capture failed:', error);
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const currentOffset = entryOffsetRef.current;
    entryDragRef.current = {
      pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      baseLeft: rect.left - currentOffset.x,
      baseTop: rect.top - currentOffset.y,
      width: rect.width || 44,
      height: rect.height || 44,
      active: false,
      captureElement: event.currentTarget,
    };
    clearEntryLongPressTimer();
    entryLongPressTimerRef.current = window.setTimeout(() => {
      entryLongPressTimerRef.current = null;
      const drag = entryDragRef.current;
      if (!drag || drag.pointerId !== pointerId || drag.active) {
        return;
      }
      drag.active = true;
      suppressEntryClickRef.current = true;
    }, FLOATING_ENTRY_LONG_PRESS_MS);
  }, [clearEntryLongPressTimer, state]);

  const handleEntryPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!updateEntryDragFromPointer(event.pointerId, event.clientX, event.clientY)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, [updateEntryDragFromPointer]);

  const handleEntryPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (finishEntryDrag(event.pointerId)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, [finishEntryDrag]);

  const requestVideoPlayback = useCallback(() => {
    const video = videoElementRef.current;
    if (!video || !receiverMediaStream) {
      return;
    }
    if (video.srcObject !== receiverMediaStream) {
      video.srcObject = receiverMediaStream;
    }
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.controls = false;
    const playResult = typeof video.play === 'function' ? video.play() : null;
    if (playResult && typeof playResult.then === 'function') {
      playResult
        .then(() => setVideoHasPlayed(true))
        .catch(() => {
          // Android WebView can reject play() while still rendering a muted MediaStream.
        });
    }
  }, [receiverMediaStream]);

  const revealReceiverVideo = useCallback(() => {
    setVideoHasPlayed(true);
    requestVideoPlayback();
  }, [requestVideoPlayback]);

  const handleEntryPointerCancel = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (finishEntryDrag(event.pointerId, { suppressClick: false })) {
      suppressEntryClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }, [finishEntryDrag]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (updateFloatingDragFromPointer(event.pointerId, event.clientX, event.clientY)) {
        event.preventDefault();
      }
      if (updateFloatingResizeFromPointer(event.pointerId, event.clientX, event.clientY)) {
        event.preventDefault();
      }
      if (updateEntryDragFromPointer(event.pointerId, event.clientX, event.clientY)) {
        event.preventDefault();
      }
    };
    const handlePointerEnd = (event: PointerEvent) => {
      finishFloatingDrag(event.pointerId);
      finishFloatingResize(event.pointerId);
      finishEntryDrag(event.pointerId);
    };
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      floatingDragRef.current = null;
      floatingResizeRef.current = null;
      entryDragRef.current = null;
      clearEntryLongPressTimer();
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [
    clearEntryLongPressTimer,
    finishEntryDrag,
    finishFloatingDrag,
    finishFloatingResize,
    updateEntryDragFromPointer,
    updateFloatingDragFromPointer,
    updateFloatingResizeFromPointer,
  ]);

  useEffect(() => {
    const video = videoElementRef.current;
    if (!video) {
      return;
    }
    setVideoHasPlayed(false);
    requestVideoPlayback();
    if (!receiverMediaStream) {
      return;
    }
    const fallbackTimer = window.setTimeout(() => {
      if (videoElementRef.current?.srcObject === receiverMediaStream) {
        setVideoHasPlayed(true);
      }
    }, 1200);
    return () => {
      window.clearTimeout(fallbackTimer);
    };
  }, [receiverMediaStream, requestVideoPlayback]);

  useEffect(() => {
    if (lastReportedQuickBarSuppressionRef.current === quickBarSuppressed) {
      return;
    }
    lastReportedQuickBarSuppressionRef.current = quickBarSuppressed;
    onOpenStateChange?.(quickBarSuppressed);
  }, [onOpenStateChange, quickBarSuppressed]);

  useEffect(() => {
    if (lastReportedBodySuppressionRef.current === bodySubscriptionSuppressed) {
      return;
    }
    lastReportedBodySuppressionRef.current = bodySubscriptionSuppressed;
    onBodySubscriptionSuppressedChange?.(bodySubscriptionSuppressed);
  }, [bodySubscriptionSuppressed, onBodySubscriptionSuppressedChange]);

  useEffect(() => {
    if (lastReportedInputContextKeyRef.current === inputContextKey) {
      return;
    }
    lastReportedInputContextKeyRef.current = inputContextKey;
    onInputContextChange?.(inputContext);
  }, [inputContext, inputContextKey, onInputContextChange]);

  useEffect(() => () => {
    clearCatalogWatchdog();
    lastReportedQuickBarSuppressionRef.current = false;
    lastReportedBodySuppressionRef.current = false;
    lastReportedInputContextKeyRef.current = null;
    onOpenStateChange?.(false);
    onBodySubscriptionSuppressedChange?.(false);
    onInputContextChange?.(null);
  }, [clearCatalogWatchdog, onBodySubscriptionSuppressedChange, onInputContextChange, onOpenStateChange]);

  const handleSelectTarget = useCallback((target: RemoteWindowStreamTargetManifest) => {
    setFloatingOffset({ x: 0, y: 0 });
    setFloatingOverlayWidthPx(null);
    lastAppliedStreamQualityKeyRef.current = null;
    bitratePresetTouchedRef.current = false;
    lastAutoFullscreenImePanRef.current = null;
    setScreenshotStatus({ phase: 'idle' });
    resetFullscreenViewport();
    setFullscreenDisplayMode(initialFullscreenDisplayMode);
    setReceiverMediaStream(null);
    setReceiverFrameSize(null);
    const selectedBitratePreset = readRemoteWindowVideoBitratePreset(target);
    setBitratePreset(selectedBitratePreset);
    const effectiveStartBitratePreset = resolveEffectiveRemoteWindowVideoBitratePreset(selectedBitratePreset, {
      mode: 'floating',
      fullscreenScale: 1,
    });
    const adaptiveStartBitratePreset = resolveAdaptiveRemoteWindowVideoBitratePreset(effectiveStartBitratePreset, networkQuality);
    const videoBitrate = buildRemoteWindowVideoBitrateConfig(adaptiveStartBitratePreset);

    if (!startStream) {
      setState((current) => selectRemoteWindowTarget(current, target.streamTargetId));
      return;
    }

    const targetSessionId = activeSessionId?.trim() || '';
    const streamId = `rw-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeStreamIdRef.current = streamId;
    lastAppliedStreamQualityKeyRef.current = [
      targetSessionId,
      streamId,
      target.streamTargetId,
      adaptiveStartBitratePreset,
      videoBitrate.maxBitrateBps,
      videoBitrate.maxFrameRateFps ?? '',
    ].join('|');
    const startingState = (current: RemoteWindowOverlayState) => beginRemoteWindowStreamSetup(
      selectRemoteWindowTarget(current, target.streamTargetId),
      streamId,
    );

    if (!targetSessionId) {
      setState((current) => failRemoteWindowStream(
        startingState(current),
        streamId,
        new Error('当前没有可用的 daemon session'),
      ));
      return;
    }

    setState(startingState);
    void startStream(targetSessionId, target, streamId, { videoBitrate })
      .then((result) => {
        setState((current) => {
          return attachRemoteWindowStreamReceiver(startingState(current), result.streamId);
        });
        if (activeStreamIdRef.current === result.streamId) {
          setReceiverMediaStream(result.mediaStream || null);
          setReceiverFrameSize(resolveStartedCaptureFrameSize(result.started));
          collectStreamStatsRef.current = typeof result.collectStats === 'function' ? result.collectStats : null;
        }
      })
      .catch((error) => {
        if (activeStreamIdRef.current === streamId) {
          setReceiverMediaStream(null);
          setReceiverFrameSize(null);
          collectStreamStatsRef.current = null;
          adaptiveVideoStateRef.current = null;
        }
        setState((current) => failRemoteWindowStream(startingState(current), streamId, error));
      });
  }, [
    activeSessionId,
    networkQuality,
    resetFullscreenViewport,
    setFloatingOffset,
    setFloatingOverlayWidthPx,
    setFullscreenDisplayMode,
    startStream,
  ]);

  const handleRemoteWindowScreenshot = useCallback(() => {
    if (state.phase !== 'targetLocked') {
      return;
    }
    const targetSessionId = activeSessionId?.trim() || '';
    if (!targetSessionId || !requestScreenshot) {
      setScreenshotStatus({ phase: 'failed', message: '当前没有可用的截图通道' });
      return;
    }
    const target = state.target;
    setScreenshotStatus({ phase: 'capturing' });
    void requestScreenshot(targetSessionId, target)
      .then((result) => {
        setScreenshotStatus({
          phase: 'saved',
          fileName: result.fileName,
          savedPath: result.savedPath,
        });
      })
      .catch((error) => {
        setScreenshotStatus({
          phase: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [activeSessionId, requestScreenshot, state]);

  const resolveSurfaceInputGeometry = useCallback((): RemoteWindowTouchSurfaceGeometry | null => {
    if (state.phase !== 'targetLocked') {
      return null;
    }
    const surface = videoSurfaceRef.current;
    const surfaceRect = surface?.getBoundingClientRect();
    if (!surfaceRect || surfaceRect.width <= 0 || surfaceRect.height <= 0) {
      return null;
    }
    const displaySourceSize = resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize);
    const viewport = state.mode === 'fullscreen'
      ? fullscreenViewportRef.current
      : initialFullscreenViewport;
    const displayMode = state.mode === 'fullscreen'
      ? fullscreenDisplayModeRef.current
      : initialFullscreenDisplayMode;
    const { content } = resolveZoomedContentRect(
      { width: surfaceRect.width, height: surfaceRect.height },
      displaySourceSize,
      viewport,
      displayMode,
    );
    return {
      surfaceRect: {
        left: surfaceRect.left,
        top: surfaceRect.top,
        width: surfaceRect.width,
        height: surfaceRect.height,
      },
      contentRect: content,
      sourceRect: getRemoteWindowSourceRect(state.target),
    };
  }, [receiverFrameSize, state]);

  const resolveSurfaceInputPoint = useCallback((
    clientX: number,
    clientY: number,
  ): RemoteWindowTouchSurfacePoint | null => {
    const geometry = resolveSurfaceInputGeometry();
    return geometry ? resolveRemoteWindowTouchSurfacePointRuntime(geometry, clientX, clientY) : null;
  }, [resolveSurfaceInputGeometry]);

  const resolvePointerInputEvent = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    phase: 'move' | 'down' | 'up',
  ): RemoteWindowInputEventPayload['event'] | null => {
    const point = resolveSurfaceInputPoint(event.clientX, event.clientY);
    if (!point) {
      return null;
    }
    return {
      kind: 'pointer',
      phase,
      pointerId: event.pointerId,
      button: mapMouseButton(event.button),
      buttons: event.buttons,
      ...point,
    };
  }, [resolveSurfaceInputPoint]);

  const resolvePointerInputAtPoint = useCallback((
    pointerId: number,
    clientX: number,
    clientY: number,
    phase: 'move' | 'down' | 'up',
  ): RemoteWindowInputEventPayload['event'] | null => {
    const point = resolveSurfaceInputPoint(clientX, clientY);
    if (!point) {
      return null;
    }
    return {
      kind: 'pointer',
      phase,
      pointerId,
      button: 'left',
      buttons: phase === 'up' ? 0 : 1,
      ...point,
    };
  }, [resolveSurfaceInputPoint]);

  const resolveScrollInputEvent = useCallback((
    clientX: number,
    clientY: number,
    deltaX: number,
    deltaY: number,
  ): RemoteWindowInputEventPayload['event'] | null => {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      return null;
    }
    if (deltaX === 0 && deltaY === 0) {
      return null;
    }
    const geometry = resolveSurfaceInputGeometry();
    const point = geometry ? resolveRemoteWindowTouchSurfacePointRuntime(geometry, clientX, clientY) : null;
    if (!point) {
      return null;
    }
    return {
      kind: 'scroll',
      unit: 'pixel',
      deltaX,
      deltaY,
      ...point,
    };
  }, [resolveSurfaceInputGeometry]);

  const emitRemoteWindowInputAfterFocus = useCallback((
    eventPayload: RemoteWindowInputEventPayload['event'],
  ) => {
    return dispatchRemoteWindowInputEvents(buildRemoteWindowFocusFirstInputEvents([eventPayload]));
  }, [dispatchRemoteWindowInputEvents]);

  const emitPointerInputAfterFocus = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    phase: 'move' | 'down' | 'up',
  ) => {
    const pointerPayload = resolvePointerInputEvent(event, phase);
    if (pointerPayload) {
      emitRemoteWindowInputAfterFocus(pointerPayload);
    }
  }, [emitRemoteWindowInputAfterFocus, resolvePointerInputEvent]);

  const applyRemoteWindowTouchLocalEffect = useCallback((effect: RemoteWindowTouchLocalEffect) => {
    if (effect.kind === 'local-pan-start') {
      surfaceLocalPanStartRef.current = {
        pointerId: effect.pointerId,
        startPanX: fullscreenViewportRef.current.panX,
        startPanY: fullscreenViewportRef.current.panY,
      };
      return;
    }
    if (effect.kind === 'local-pan-move') {
      const start = surfaceLocalPanStartRef.current;
      if (!start || start.pointerId !== effect.pointerId) {
        return;
      }
      setFullscreenViewport({
        scale: fullscreenViewportRef.current.scale,
        panX: start.startPanX + effect.deltaX,
        panY: start.startPanY + effect.deltaY,
      });
      return;
    }
    if (effect.kind === 'local-pan-end') {
      surfaceLocalPanStartRef.current = null;
    }
  }, [setFullscreenViewport]);

  const applyRemoteWindowTouchPointerResult = useCallback((
    result: {
      nextState: RemoteWindowTouchPointerState;
      remoteEvents: Array<RemoteWindowInputEventPayload['event']>;
      localEffect: RemoteWindowTouchLocalEffect;
    },
  ) => {
    surfaceGestureRef.current = toOverlayTouchGesture(
      result.nextState,
      fullscreenViewportRef.current,
      surfaceLocalPanStartRef.current,
    );
    applyRemoteWindowTouchLocalEffect(result.localEffect);
    if (result.remoteEvents.length > 0) {
      dispatchRemoteWindowInputEvents(result.remoteEvents);
    }
  }, [applyRemoteWindowTouchLocalEffect, dispatchRemoteWindowInputEvents]);

  const handleVideoSurfacePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (state.phase !== 'targetLocked') {
      return;
    }
    requestVideoPlayback();
    if (event.pointerType === 'mouse' && event.button > 2) {
      return;
    }
    publishRemoteWindowInputContext();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    surfacePointersRef.current.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
    });

    const pointers = Array.from(surfacePointersRef.current.entries());
    if (state.mode === 'fullscreen' && pointers.length >= 2) {
      const [first, second] = pointers.slice(-2) as [
        [number, SurfacePointerPosition],
        [number, SurfacePointerPosition],
      ];
      const midpoint = resolvePointerMidpoint(first[1], second[1]);
      surfaceGestureRef.current = {
        mode: 'twoFingerCandidate',
        pointerIds: [first[0], second[0]],
        firstStart: { ...first[1] },
        secondStart: { ...second[1] },
        startDistance: Math.max(1, resolvePointerDistance(first[1], second[1])),
        startMidX: midpoint.clientX,
        startMidY: midpoint.clientY,
        lastMidX: midpoint.clientX,
        lastMidY: midpoint.clientY,
        startScale: fullscreenViewportRef.current.scale,
        startPanX: fullscreenViewportRef.current.panX,
        startPanY: fullscreenViewportRef.current.panY,
      };
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.pointerType === 'touch') {
      const geometry = resolveSurfaceInputGeometry();
      if (!geometry) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const result = resolveRemoteWindowTouchPointerDownRuntime({
        state: toRemoteWindowTouchGestureState(surfaceGestureRef.current),
        pointer: pointerSampleFromReactEvent(event),
        geometry,
        zoomedProjection: state.mode === 'fullscreen' && fullscreenViewportRef.current.scale > 1.01,
      });
      applyRemoteWindowTouchPointerResult(result);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    surfaceGestureRef.current = {
      mode: 'input',
      pointerId: event.pointerId,
    };
    emitPointerInputAfterFocus(event, 'down');
    event.preventDefault();
    event.stopPropagation();
  }, [
    emitPointerInputAfterFocus,
    applyRemoteWindowTouchPointerResult,
    publishRemoteWindowInputContext,
    requestVideoPlayback,
    resolveSurfaceInputGeometry,
    state,
  ]);

  const handleVideoSurfacePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (state.phase !== 'targetLocked') {
      return;
    }
    const previous = surfacePointersRef.current.get(event.pointerId);
    if (!previous) {
      return;
    }
    surfacePointersRef.current.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
    });
    const gesture = surfaceGestureRef.current;
    if (!gesture) {
      return;
    }

    if (isSurfacePointerPairGesture(gesture)) {
      const first = surfacePointersRef.current.get(gesture.pointerIds[0]);
      const second = surfacePointersRef.current.get(gesture.pointerIds[1]);
      if (!first || !second) {
        return;
      }
      const midpoint = resolvePointerMidpoint(first, second);
      if (gesture.mode === 'twoFingerScroll') {
        const midpointDeltaX = midpoint.clientX - gesture.lastMidX;
        const midpointDeltaY = midpoint.clientY - gesture.lastMidY;
        if (Math.hypot(midpointDeltaX, midpointDeltaY) < REMOTE_WINDOW_FULLSCREEN_TWO_FINGER_SCROLL_THRESHOLD_PX) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const geometry = resolveSurfaceInputGeometry();
        const scrollPayload = geometry
          ? resolveScrollInputEvent(
              midpoint.clientX,
              midpoint.clientY,
              resolveRemoteWindowTouchScrollDeltaRuntime(midpointDeltaX, geometry.sourceRect.width, {
                fraction: touchScrollFractionRef.current,
                inverted: touchScrollInvertedRef.current,
              }),
              resolveRemoteWindowTouchScrollDeltaRuntime(midpointDeltaY, geometry.sourceRect.height, {
                fraction: touchScrollFractionRef.current,
                inverted: touchScrollInvertedRef.current,
              }),
            )
          : null;
        surfaceGestureRef.current = {
          mode: 'twoFingerScroll',
          pointerIds: gesture.pointerIds,
          lastMidX: midpoint.clientX,
          lastMidY: midpoint.clientY,
        };
        if (scrollPayload) {
          emitRemoteWindowInputAfterFocus(scrollPayload);
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const distance = Math.max(1, resolvePointerDistance(first, second));
      const scaleRatio = distance / Math.max(1, gesture.startDistance);
      if (gesture.mode === 'pinch') {
        setFullscreenViewport({
          scale: gesture.startScale * scaleRatio,
          panX: gesture.startPanX + midpoint.clientX - gesture.startMidX,
          panY: gesture.startPanY + midpoint.clientY - gesture.startMidY,
        });
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const firstMoved = hasPointerPositionMoved(gesture.firstStart, first);
      const secondMoved = hasPointerPositionMoved(gesture.secondStart, second);
      const isPinchAxisMotion = isPointerMovementAlongAxis(
        gesture.firstStart,
        first,
        gesture.firstStart,
        gesture.secondStart,
      ) || isPointerMovementAlongAxis(
        gesture.secondStart,
        second,
        gesture.firstStart,
        gesture.secondStart,
      );
      if (
        Math.abs(scaleRatio - 1) >= REMOTE_WINDOW_FULLSCREEN_PINCH_SCALE_THRESHOLD
        && ((firstMoved && secondMoved) || isPinchAxisMotion)
      ) {
        surfaceGestureRef.current = {
          mode: 'pinch',
          pointerIds: gesture.pointerIds,
          startDistance: gesture.startDistance,
          startMidX: gesture.startMidX,
          startMidY: gesture.startMidY,
          startScale: gesture.startScale,
          startPanX: gesture.startPanX,
          startPanY: gesture.startPanY,
        };
        setFullscreenViewport({
          scale: gesture.startScale * scaleRatio,
          panX: gesture.startPanX + midpoint.clientX - gesture.startMidX,
          panY: gesture.startPanY + midpoint.clientY - gesture.startMidY,
        });
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const midpointDeltaX = midpoint.clientX - gesture.lastMidX;
      const midpointDeltaY = midpoint.clientY - gesture.lastMidY;
      if (
        !firstMoved
        || !secondMoved
        || Math.hypot(midpointDeltaX, midpointDeltaY) < REMOTE_WINDOW_FULLSCREEN_TWO_FINGER_SCROLL_THRESHOLD_PX
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const geometry = resolveSurfaceInputGeometry();
      const scrollPayload = geometry
        ? resolveScrollInputEvent(
            midpoint.clientX,
            midpoint.clientY,
            resolveRemoteWindowTouchScrollDeltaRuntime(midpointDeltaX, geometry.sourceRect.width, {
              fraction: touchScrollFractionRef.current,
              inverted: touchScrollInvertedRef.current,
            }),
            resolveRemoteWindowTouchScrollDeltaRuntime(midpointDeltaY, geometry.sourceRect.height, {
              fraction: touchScrollFractionRef.current,
              inverted: touchScrollInvertedRef.current,
            }),
          )
        : null;
      surfaceGestureRef.current = {
        mode: 'twoFingerScroll',
        pointerIds: gesture.pointerIds,
        lastMidX: midpoint.clientX,
        lastMidY: midpoint.clientY,
      };
      if (scrollPayload) {
        emitRemoteWindowInputAfterFocus(scrollPayload);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const runtimeGesture = toRemoteWindowTouchGestureState(gesture);
    if (runtimeGesture.mode !== 'idle') {
      const geometry = resolveSurfaceInputGeometry();
      if (geometry) {
        const result = resolveRemoteWindowTouchPointerMoveRuntime({
          state: runtimeGesture,
          pointer: pointerSampleFromReactEvent(event),
          geometry,
        });
        applyRemoteWindowTouchPointerResult(result);
        if (result.consumed) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    }

    if (gesture.mode === 'pan' && gesture.pointerId === event.pointerId) {
      const deltaX = event.clientX - gesture.startClientX;
      const deltaY = event.clientY - gesture.startClientY;
      if (Math.hypot(deltaX, deltaY) > REMOTE_WINDOW_FULLSCREEN_PAN_TAP_THRESHOLD_PX) {
        gesture.moved = true;
      }
      setFullscreenViewport({
        scale: fullscreenViewportRef.current.scale,
        panX: gesture.startPanX + deltaX,
        panY: gesture.startPanY + deltaY,
      });
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (gesture.mode === 'input' && gesture.pointerId === event.pointerId) {
      const pointerPayload = resolvePointerInputEvent(event, 'move');
      if (pointerPayload) {
        emitRemoteWindowInputAfterFocus(pointerPayload);
      }
      event.preventDefault();
      event.stopPropagation();
    }
  }, [
    applyRemoteWindowTouchPointerResult,
    emitRemoteWindowInputAfterFocus,
    resolvePointerInputEvent,
    resolveScrollInputEvent,
    resolveSurfaceInputGeometry,
    setFullscreenViewport,
    state,
  ]);

  const handleVideoSurfacePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = surfaceGestureRef.current;
    surfacePointersRef.current.delete(event.pointerId);
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (!gesture) {
      return;
    }
    const runtimeGesture = toRemoteWindowTouchGestureState(gesture);
    if (runtimeGesture.mode !== 'idle') {
      const geometry = resolveSurfaceInputGeometry();
      if (geometry) {
        const result = resolveRemoteWindowTouchPointerUpRuntime({
          state: runtimeGesture,
          pointer: pointerSampleFromReactEvent(event),
          geometry,
          scrollFraction: touchScrollFractionRef.current,
          invertGestureDirection: touchScrollInvertedRef.current,
        });
        applyRemoteWindowTouchPointerResult(result);
        if (result.consumed) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    }
    if (gesture.mode === 'input' && gesture.pointerId === event.pointerId) {
      const pointerPayload = resolvePointerInputEvent(event, 'up');
      if (pointerPayload) {
        emitRemoteWindowInputAfterFocus(pointerPayload);
      }
      surfaceGestureRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (gesture.mode === 'pan' && gesture.pointerId === event.pointerId) {
      if (!gesture.moved) {
        const downPayload = resolvePointerInputAtPoint(
          gesture.pointerId,
          gesture.startClientX,
          gesture.startClientY,
          'down',
        );
        const upPayload = resolvePointerInputAtPoint(
          gesture.pointerId,
          gesture.startClientX,
          gesture.startClientY,
          'up',
        );
        if (downPayload) {
          emitRemoteWindowInputAfterFocus(downPayload);
        }
        if (upPayload) {
          emitRemoteWindowInputAfterFocus(upPayload);
        }
      }
      surfaceGestureRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (isSurfacePointerPairGesture(gesture) && gesture.pointerIds.includes(event.pointerId)) {
      const remaining = Array.from(surfacePointersRef.current.entries())[0] || null;
      if (
        gesture.mode === 'pinch'
        && remaining
        && state.phase === 'targetLocked'
        && state.mode === 'fullscreen'
        && fullscreenViewportRef.current.scale > 1.01
      ) {
        surfaceGestureRef.current = {
          mode: 'pan',
          pointerId: remaining[0],
          startClientX: remaining[1].clientX,
          startClientY: remaining[1].clientY,
          startPanX: fullscreenViewportRef.current.panX,
          startPanY: fullscreenViewportRef.current.panY,
          moved: true,
        };
      } else {
        surfaceGestureRef.current = null;
      }
      event.preventDefault();
      event.stopPropagation();
    }
  }, [
    applyRemoteWindowTouchPointerResult,
    emitRemoteWindowInputAfterFocus,
    resolvePointerInputAtPoint,
    resolvePointerInputEvent,
    resolveSurfaceInputGeometry,
    state,
  ]);

  const handleVideoSurfacePointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = surfaceGestureRef.current;
    surfacePointersRef.current.delete(event.pointerId);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (
      gesture
      && (
        ('pointerId' in gesture && gesture.pointerId === event.pointerId)
        || (isSurfacePointerPairGesture(gesture) && gesture.pointerIds.includes(event.pointerId))
      )
    ) {
      const runtimeGesture = toRemoteWindowTouchGestureState(gesture);
      if (runtimeGesture.mode !== 'idle' && gesture.mode !== 'pinch' && gesture.mode !== 'twoFingerCandidate' && gesture.mode !== 'twoFingerScroll') {
        const geometry = resolveSurfaceInputGeometry();
        if (geometry) {
          const result = resolveRemoteWindowTouchPointerCancelRuntime({
            state: runtimeGesture,
            pointer: pointerSampleFromReactEvent(event),
            geometry,
          });
          applyRemoteWindowTouchPointerResult(result);
          if (result.consumed) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
      }
      surfaceGestureRef.current = null;
      event.preventDefault();
      event.stopPropagation();
    }
  }, [applyRemoteWindowTouchPointerResult, resolveSurfaceInputGeometry]);

  const handleVideoSurfaceWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    publishRemoteWindowInputContext();
    const scrollPayload = resolveScrollInputEvent(
      event.clientX,
      event.clientY,
      event.deltaX,
      event.deltaY,
    );
    if (!scrollPayload) {
      return;
    }
    emitRemoteWindowInputAfterFocus(scrollPayload);
    event.preventDefault();
    event.stopPropagation();
  }, [emitRemoteWindowInputAfterFocus, publishRemoteWindowInputContext, resolveScrollInputEvent]);

  const handleVideoSurfaceKey = useCallback((
    event: ReactKeyboardEvent<HTMLDivElement>,
    phase: 'down' | 'up',
  ) => {
    if (state.phase !== 'targetLocked' || !state.streamId) {
      return;
    }
    publishRemoteWindowInputContext();
    emitRemoteWindowInputAfterFocus({
      kind: 'key',
      phase,
      key: event.key,
      code: event.code,
      text: event.key.length === 1 ? event.key : undefined,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    });
    event.preventDefault();
    event.stopPropagation();
  }, [emitRemoteWindowInputAfterFocus, publishRemoteWindowInputContext, state]);

  useEffect(() => {
    if (state.phase !== 'targetLocked' || state.mode !== 'fullscreen') {
      return;
    }
    let disposed = false;
    let listenerHandle: { remove: () => Promise<void> | void } | null = null;
    void Promise.resolve(CapacitorApp.addListener('backButton', handleShrink))
      .then((handle) => {
        if (disposed) {
          void handle.remove();
          return;
        }
        listenerHandle = handle;
      })
      .catch((error) => {
        console.error('[RemoteWindowOverlay] backButton listener failed:', error);
      });
    return () => {
      disposed = true;
      if (listenerHandle) {
        void listenerHandle.remove();
      }
    };
  }, [handleShrink, state]);

  const pickerContent = useMemo(() => {
    if (state.phase !== 'targetEnumerating' && state.phase !== 'pickerOpen') {
      return null;
    }
    const appTargets = state.phase === 'pickerOpen'
      ? state.targets.filter((target) => target.videoTarget.kind === 'app-window')
      : [];
    const itermPaneTargets = state.phase === 'pickerOpen'
      ? state.targets.filter((target) => target.videoTarget.kind === 'iterm2-pane')
      : [];
    const renderTargetRow = (target: RemoteWindowStreamTargetManifest) => (
      <button
        key={target.streamTargetId}
        type="button"
        data-testid={`remote-window-target-${target.streamTargetId}`}
        onClick={() => handleSelectTarget(target)}
        style={styles.targetRow}
      >
        <span style={styles.targetKind}>{formatTargetKind(target)}</span>
        <span style={styles.targetMain}>{target.videoTarget.title || target.videoTarget.appBundleId}</span>
        <span style={styles.targetMeta}>{formatTargetSubtitle(target)}</span>
      </button>
    );
    return (
      <div data-testid="remote-window-picker" style={styles.pickerPanel}>
        <div style={styles.panelHeader}>
          <div>
            <div style={styles.panelTitle}>远程窗口</div>
            <div style={styles.panelSubtitle}>
              {state.phase === 'targetEnumerating'
                ? '正在读取窗口列表'
                : `${state.targets.length} 个目标${catalogRefreshing ? ' · 更新中' : ''}`}
            </div>
          </div>
          <div style={styles.panelActions}>
            <button
              type="button"
              aria-label="刷新远程窗口列表"
              onClick={() => handleOpenPicker({ forceRefresh: true })}
              style={styles.headerButton}
            >
              刷新
            </button>
            <button type="button" aria-label="关闭远程窗口选择" onClick={handleClose} style={styles.headerIconButton}>
              x
            </button>
          </div>
        </div>
        {state.phase === 'pickerOpen' && state.errorMessage ? (
          <div data-testid="remote-window-picker-error" style={styles.errorBox}>{state.errorMessage}</div>
        ) : null}
        {state.phase === 'pickerOpen' && state.targets.length === 0 ? renderErrors(state.errors) : null}
        <div style={styles.targetList}>
          {state.phase === 'targetEnumerating' ? (
            <div data-testid="remote-window-picker-loading" style={styles.emptyState}>读取中</div>
          ) : state.targets.length === 0 ? (
            <div data-testid="remote-window-picker-empty" style={styles.emptyState}>没有可选窗口</div>
          ) : (
            <>
              {appTargets.map(renderTargetRow)}
              {itermPaneTargets.length > 0 ? (
                <button
                  type="button"
                  data-testid="remote-window-iterm-pane-group"
                  aria-expanded={itermPaneTargetsExpanded}
                  onClick={() => setItermPaneTargetsExpanded((current) => !current)}
                  style={styles.targetGroupRow}
                >
                  <span style={styles.targetKind}>iTerm2</span>
                  <span style={styles.targetMain}>iTerm2 Panes</span>
                  <span style={styles.targetMeta}>
                    {itermPaneTargetsExpanded ? `${itermPaneTargets.length} 个 pane` : `${itermPaneTargets.length} 个 pane · 已折叠`}
                  </span>
                </button>
              ) : null}
              {itermPaneTargetsExpanded ? itermPaneTargets.map(renderTargetRow) : null}
            </>
          )}
        </div>
      </div>
    );
  }, [catalogRefreshing, handleClose, handleOpenPicker, handleSelectTarget, itermPaneTargetsExpanded, state]);

	  const lockedSurfaceLayout = useMemo(() => {
	    if (state.phase !== 'targetLocked' || !surfaceSize) {
	      return null;
	    }
	    const displaySourceSize = resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize);
	    const viewport = state.mode === 'fullscreen' ? fullscreenViewport : initialFullscreenViewport;
	    const displayMode = state.mode === 'fullscreen'
	      ? fullscreenDisplayMode
	      : initialFullscreenDisplayMode;
	    return resolveZoomedContentRect(surfaceSize, displaySourceSize, viewport, displayMode);
	  }, [fullscreenDisplayMode, fullscreenViewport, receiverFrameSize, state, surfaceSize]);

  const minimapViewport = useMemo(() => {
    if (state.phase !== 'targetLocked' || state.mode !== 'fullscreen' || fullscreenViewport.scale <= 1.01 || !lockedSurfaceLayout) {
      return null;
    }
    return resolveRemoteWindowMinimapViewport(lockedSurfaceLayout.viewport, lockedSurfaceLayout.content);
  }, [fullscreenViewport.scale, lockedSurfaceLayout, state]);

  const videoContentStyle = lockedSurfaceLayout
    ? {
        ...styles.videoContentFrame,
        left: lockedSurfaceLayout.content.left,
        top: lockedSurfaceLayout.content.top,
        width: lockedSurfaceLayout.content.width,
        height: lockedSurfaceLayout.content.height,
    }
    : styles.videoContentFallback;

  const ztermVideoWallpaper = (
    <div data-testid="remote-window-video-wallpaper" style={styles.videoWallpaper} aria-hidden="true">
      <img data-testid="remote-window-video-wallpaper-logo" src={ztermRemoteWindowLogoUrl} alt="" style={styles.videoWallpaperLogo} />
    </div>
  );

  const lockedVideoContent = state.phase === 'targetLocked' ? (() => {
    if (state.streamStarted && receiverMediaStream) {
      return (
        <>
          {!videoHasPlayed ? ztermVideoWallpaper : null}
          <video
            data-testid="remote-window-video"
            ref={videoElementRef}
            autoPlay
            muted
            controls={false}
            disablePictureInPicture
            preload="auto"
            playsInline
            onPlaying={revealReceiverVideo}
            onLoadedMetadata={revealReceiverVideo}
            onLoadedData={revealReceiverVideo}
            onCanPlay={revealReceiverVideo}
            style={{
              ...styles.videoElement,
              opacity: videoHasPlayed ? 1 : 0,
            }}
          />
        </>
      );
    }
    if (state.streamStatus === 'starting') {
      return (
        <div style={styles.videoFrame}>
          {ztermVideoWallpaper}
          <div style={styles.videoStatus}>正在建立视频流</div>
          <div style={styles.videoMeta}>{formatTargetSubtitle(state.target)}</div>
        </div>
      );
    }
    if (state.streamStatus === 'error') {
      return (
        <div data-testid="remote-window-stream-error" style={{ ...styles.videoFrame, ...styles.videoError }}>
          {ztermVideoWallpaper}
          <div style={styles.videoStatus}>视频流启动失败</div>
          <div style={styles.videoMeta}>{state.streamErrorMessage || 'remote window stream failed'}</div>
        </div>
      );
    }
    return (
      <div style={styles.videoFrame}>
        {ztermVideoWallpaper}
        <div style={styles.videoStatus}>等待视频流</div>
        <div style={styles.videoMeta}>{formatTargetSubtitle(state.target)}</div>
      </div>
    );
  })() : null;

	  const lockedDisplaySourceSize = state.phase === 'targetLocked'
	    ? resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize)
	    : null;
	  const floatingVideoHeightPx = lockedDisplaySourceSize && floatingOverlayWidthPx
	    ? Math.round(floatingOverlayWidthPx / Math.max(0.2, Math.min(5, lockedDisplaySourceSize.width / Math.max(1, lockedDisplaySourceSize.height))))
	    : null;
	  const floatingOverlayStyle = state.phase === 'targetLocked' && state.mode === 'floating' && lockedDisplaySourceSize
	    ? {
	        ...styles.floatingOverlay,
	        ...resolveFloatingOverlaySizing(lockedDisplaySourceSize),
	        ...(floatingOverlayWidthPx
	          ? { width: `${floatingOverlayWidthPx}px`, maxWidth: 'calc(100vw - 16px)' }
          : {}),
        bottom: REMOTE_WINDOW_FLOATING_BOTTOM_BASE_PX + Math.max(0, bottomInsetPx),
        transform: `translate(${floatingOffset.x}px, ${floatingOffset.y}px)`,
      }
    : {
        ...styles.floatingOverlay,
        ...(floatingOverlayWidthPx
          ? { width: `${floatingOverlayWidthPx}px`, maxWidth: 'calc(100vw - 16px)' }
          : {}),
        bottom: REMOTE_WINDOW_FLOATING_BOTTOM_BASE_PX + Math.max(0, bottomInsetPx),
        transform: `translate(${floatingOffset.x}px, ${floatingOffset.y}px)`,
      };
  const fullscreenBottomPaddingPx = state.phase === 'targetLocked' && state.mode === 'fullscreen'
    ? Math.max(
        0,
        Math.round(Math.max(0, bottomInsetPx) - Math.min(Math.max(0, bottomInsetPx), Math.max(0, -fullscreenViewport.panY))),
      )
    : Math.max(0, bottomInsetPx);
  const fullscreenOverlayStyle = {
    ...styles.fullscreenOverlay,
    paddingBottom: `${fullscreenBottomPaddingPx}px`,
  };
  const videoSurfaceStyle = state.phase === 'targetLocked' && state.mode === 'floating' && lockedDisplaySourceSize
	    ? {
	        ...styles.videoPlaceholder,
	        flex: '0 0 auto',
	        aspectRatio: `${Math.max(1, Math.round(lockedDisplaySourceSize.width))} / ${Math.max(1, Math.round(lockedDisplaySourceSize.height))}`,
	        ...(floatingVideoHeightPx
	          ? { height: `${floatingVideoHeightPx}px` }
          : { maxHeight: 'min(52vh, 420px)' }),
      }
    : styles.videoPlaceholder;
  const screenshotFeedback = (() => {
    switch (screenshotStatus.phase) {
      case 'capturing':
        return {
          phase: screenshotStatus.phase,
          title: '远程原始截屏中',
          detail: '正在从目标窗口获取 PNG',
          tone: 'progress' as const,
        };
      case 'saved':
        return {
          phase: screenshotStatus.phase,
          title: '原始截图已保存',
          detail: screenshotStatus.fileName,
          tone: 'success' as const,
        };
      case 'failed':
        return {
          phase: screenshotStatus.phase,
          title: '截屏失败',
          detail: screenshotStatus.message,
          tone: 'error' as const,
        };
      case 'idle':
      default:
        return null;
    }
  })();
  const screenshotBusy = screenshotStatus.phase === 'capturing';
  const screenshotButtonStyle = screenshotBusy
    ? { ...styles.headerIconButton, ...styles.headerIconButtonBusy }
    : styles.headerIconButton;
  const screenshotToastToneStyle = screenshotFeedback?.tone === 'success'
    ? styles.screenshotToastSuccess
    : screenshotFeedback?.tone === 'error'
      ? styles.screenshotToastError
      : styles.screenshotToastProgress;

  const lockedContent = state.phase === 'targetLocked' ? (
    <div
      ref={floatingOverlayRef}
      data-testid="remote-window-locked-overlay"
      data-mode={state.mode}
      data-display-mode={state.mode === 'fullscreen' ? fullscreenDisplayMode : initialFullscreenDisplayMode}
      style={state.mode === 'fullscreen'
        ? fullscreenOverlayStyle
        : floatingOverlayStyle}
    >
      <div style={styles.lockedToolbar}>
        <div
          data-testid="remote-window-drag-handle"
          onPointerDown={handleFloatingDragStart}
          onPointerMove={handleFloatingDragMove}
          onPointerUp={handleFloatingDragEnd}
          onPointerCancel={handleFloatingDragEnd}
          style={{
            ...styles.lockedTopBar,
            cursor: state.mode === 'floating' ? 'move' : 'default',
            touchAction: state.mode === 'floating' ? 'none' : 'auto',
            userSelect: 'none',
          }}
        >
          <div style={styles.lockedTitle}>
            <span style={styles.targetKind}>{formatTargetKind(state.target)}</span>
            <span data-testid="remote-window-input-mode" style={styles.inputModeBadge}>
              {isRemoteWindowInputSupported(state.target) ? '可操作' : '只读'}
            </span>
            <span>{state.target.videoTarget.title || state.target.videoTarget.appBundleId}</span>
          </div>
          <div data-testid="remote-window-primary-actions" style={styles.lockedPrimaryActions}>
            {state.mode === 'fullscreen' ? (
              <button type="button" aria-label="缩小远程窗口" onClick={handleShrink} style={styles.headerIconButton}>
                -
              </button>
            ) : (
              <button type="button" aria-label="全屏远程窗口" onClick={handleFullscreen} style={styles.headerIconButton}>
                []
              </button>
            )}
            <button type="button" aria-label="关闭远程窗口" onClick={handleClose} style={styles.headerIconButton}>
              x
            </button>
          </div>
        </div>
        <div data-testid="remote-window-control-strip" data-no-drag="true" style={styles.lockedControlStrip}>
          <select
            data-testid="remote-window-bitrate-select"
            data-no-drag="true"
            aria-label="远程窗口码率"
            value={bitratePreset}
            onChange={(event) => handleBitratePresetChange(event.currentTarget.value as RemoteWindowVideoBitratePreset)}
            style={styles.bitrateSelect}
          >
            {REMOTE_WINDOW_VIDEO_BITRATE_PRESETS.map((preset) => (
              <option key={preset} value={preset}>{formatBitrateOption(preset)}</option>
            ))}
          </select>
          <select
            data-testid="remote-window-touch-scroll-fraction-select"
            data-no-drag="true"
            aria-label="远程窗口滚动幅度"
            value={String(touchScrollFraction)}
            onChange={(event) => handleTouchScrollFractionChange(event.currentTarget.value)}
            style={styles.touchScrollFractionSelect}
          >
            {REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_OPTIONS.map((fraction) => (
              <option key={fraction} value={fraction}>{formatTouchScrollFractionOption(fraction)}</option>
            ))}
          </select>
          <button
            type="button"
            data-testid="remote-window-touch-scroll-direction-toggle"
            data-no-drag="true"
            aria-label={touchScrollInverted ? '恢复远程窗口滚动方向' : '反向远程窗口滚动方向'}
            onClick={handleToggleTouchScrollDirection}
            style={touchScrollInverted ? styles.headerModeButtonActive : styles.headerModeButton}
          >
            {touchScrollInverted ? '反向' : '正向'}
          </button>
          <button
            type="button"
            data-no-drag="true"
            aria-label="截屏远程窗口"
            aria-busy={screenshotBusy ? 'true' : undefined}
            disabled={screenshotBusy}
            onClick={handleRemoteWindowScreenshot}
            style={screenshotButtonStyle}
          >
            #
          </button>
          <button
            type="button"
            data-no-drag="true"
            aria-label="调起远程窗口键盘"
            onClick={handleRequestKeyboard}
            style={styles.headerIconButton}
          >
            KB
          </button>
          {state.mode === 'fullscreen' ? (
            <button
              type="button"
              data-testid="remote-window-fullscreen-display-toggle"
              aria-label={fullscreenDisplayMode === 'fit' ? '切换为充满屏幕' : '切换为完整显示'}
              onClick={handleToggleFullscreenDisplayMode}
              style={styles.headerModeButton}
            >
              {fullscreenDisplayMode === 'fit' ? '填满' : '适配'}
            </button>
          ) : null}
        </div>
      </div>
      <div
        data-testid="remote-window-video-surface"
        ref={videoSurfaceRef}
        tabIndex={0}
        onDoubleClick={handleFullscreen}
        onPointerDown={handleVideoSurfacePointerDown}
        onPointerMove={handleVideoSurfacePointerMove}
        onPointerUp={handleVideoSurfacePointerUp}
        onPointerCancel={handleVideoSurfacePointerCancel}
        onWheel={handleVideoSurfaceWheel}
        onKeyDown={(event) => handleVideoSurfaceKey(event, 'down')}
        onKeyUp={(event) => handleVideoSurfaceKey(event, 'up')}
        onTouchEnd={() => {
          if (state.mode !== 'floating') {
            return;
          }
          const now = Date.now();
          if (now - lastTouchEndAtRef.current < 300) {
            handleFullscreen();
          }
          lastTouchEndAtRef.current = now;
        }}
        style={videoSurfaceStyle}
      >
        <div data-testid="remote-window-video-content" style={videoContentStyle}>
          {lockedVideoContent}
        </div>
        {screenshotFeedback ? (
          <div
            data-testid="remote-window-screenshot-status"
            data-phase={screenshotFeedback.phase}
            role={screenshotFeedback.phase === 'failed' ? 'alert' : 'status'}
            aria-live={screenshotFeedback.phase === 'failed' ? 'assertive' : 'polite'}
            style={{
              ...styles.screenshotToast,
              ...screenshotToastToneStyle,
            }}
          >
            {screenshotFeedback.phase === 'capturing' ? (
              <span
                data-testid="remote-window-screenshot-spinner"
                aria-hidden="true"
                style={styles.screenshotSpinner}
              />
            ) : (
              <span
                data-testid={screenshotFeedback.phase === 'saved'
                  ? 'remote-window-screenshot-saved-icon'
                  : 'remote-window-screenshot-failed-icon'}
                aria-hidden="true"
                style={{
                  ...styles.screenshotResultIcon,
                  ...(screenshotFeedback.phase === 'failed' ? styles.screenshotResultIconError : {}),
                }}
              >
                {screenshotFeedback.phase === 'saved' ? 'OK' : '!'}
              </span>
            )}
            <span style={styles.screenshotToastText}>
              <span style={styles.screenshotToastTitle}>{screenshotFeedback.title}</span>
              <span style={styles.screenshotToastDetail}>{screenshotFeedback.detail}</span>
            </span>
          </div>
        ) : null}
        {minimapViewport ? (
          <div data-testid="remote-window-minimap" style={styles.minimap}>
            <div
              data-testid="remote-window-minimap-viewport"
              style={{
                ...styles.minimapViewport,
                left: `${minimapViewport.leftPct}%`,
                top: `${minimapViewport.topPct}%`,
                width: `${minimapViewport.widthPct}%`,
                height: `${minimapViewport.heightPct}%`,
              }}
            />
          </div>
        ) : null}
      </div>
      {state.mode === 'floating' ? (
        <>
          <div
            data-testid="remote-window-resize-handle"
            data-no-drag="true"
            onPointerDown={(event) => handleFloatingResizeStart(event, 'left-bottom')}
            onPointerMove={handleFloatingResizeMove}
            onPointerUp={handleFloatingResizeEnd}
            onPointerCancel={handleFloatingResizeEnd}
            style={styles.floatingResizeHandleLeft}
          />
          <div
            data-testid="remote-window-resize-handle-right"
            data-no-drag="true"
            onPointerDown={(event) => handleFloatingResizeStart(event, 'right-bottom')}
            onPointerMove={handleFloatingResizeMove}
            onPointerUp={handleFloatingResizeEnd}
            onPointerCancel={handleFloatingResizeEnd}
            style={styles.floatingResizeHandleRight}
          />
        </>
      ) : null}
    </div>
  ) : null;

  return (
    <>
      {state.phase === 'closed' ? (
        <button
          ref={entryButtonRef}
          type="button"
          data-testid="remote-window-entry"
          aria-label="打开远程窗口"
          onPointerDown={handleEntryPointerDown}
          onPointerMove={handleEntryPointerMove}
          onPointerUp={handleEntryPointerUp}
          onPointerCancel={handleEntryPointerCancel}
          onClick={(event) => {
            if (suppressEntryClickRef.current) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            handleOpenPicker();
          }}
          style={{
            ...styles.entryButton,
            bottom: `${Math.max(92, 92 + Math.max(0, bottomInsetPx))}px`,
            transform: `translate(${entryOffset.x}px, ${entryOffset.y}px)`,
          }}
        >
          窗
        </button>
      ) : null}
      {pickerContent}
      {lockedContent}
      <style>{`
        [data-testid="remote-window-control-strip"]::-webkit-scrollbar {
          display: none;
        }
        @keyframes zterm-remote-window-shot-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes zterm-remote-window-shot-pop {
          from { transform: translate(-50%, -6px) scale(0.96); opacity: 0; }
          to { transform: translate(-50%, 0) scale(1); opacity: 1; }
        }
        @keyframes zterm-remote-window-shot-pulse {
          0% { box-shadow: 0 0 0 0 rgba(31,214,122,0.28); }
          70% { box-shadow: 0 0 0 10px rgba(31,214,122,0); }
          100% { box-shadow: 0 0 0 0 rgba(31,214,122,0); }
        }
      `}</style>
    </>
  );
});

const styles: Record<string, CSSProperties> = {
  entryButton: {
    position: 'fixed',
    right: 14,
    zIndex: 44,
    width: 44,
    height: 44,
    borderRadius: 14,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(15, 23, 38, 0.9)',
    color: mobileTheme.colors.accent,
    fontWeight: 900,
    fontSize: 16,
    boxShadow: '0 12px 24px rgba(0,0,0,0.28)',
    backdropFilter: 'blur(10px)',
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    cursor: 'grab',
  },
  pickerPanel: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 'calc(env(safe-area-inset-top, 0px) + 58px)',
    maxHeight: 'min(70vh, 560px)',
    zIndex: 31,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: 16,
    border: '1px solid rgba(151, 164, 186, 0.22)',
    background: 'rgba(13, 19, 31, 0.96)',
    color: '#edf4ff',
    boxShadow: '0 24px 60px rgba(0,0,0,0.42)',
    backdropFilter: 'blur(14px)',
  },
  panelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    padding: '14px 14px 10px',
    borderBottom: '1px solid rgba(151, 164, 186, 0.16)',
  },
  panelTitle: {
    fontSize: 15,
    fontWeight: 900,
    letterSpacing: 0,
  },
  panelSubtitle: {
    marginTop: 3,
    fontSize: 12,
    color: 'rgba(237,244,255,0.62)',
  },
  panelActions: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
  },
  headerButton: {
    minHeight: 32,
    padding: '0 12px',
    borderRadius: 10,
    border: '1px solid rgba(151, 164, 186, 0.18)',
    background: 'rgba(36, 48, 72, 0.84)',
    color: '#edf4ff',
    fontWeight: 850,
  },
  headerIconButton: {
    flex: '0 0 auto',
    width: 32,
    height: 32,
    borderRadius: 10,
    border: '1px solid rgba(151, 164, 186, 0.18)',
    background: 'rgba(36, 48, 72, 0.84)',
    color: '#edf4ff',
    fontWeight: 900,
  },
  headerIconButtonBusy: {
    opacity: 0.78,
    background: 'rgba(31, 214, 122, 0.18)',
    border: '1px solid rgba(31, 214, 122, 0.42)',
  },
  headerModeButton: {
    flex: '0 0 auto',
    minWidth: 46,
    height: 32,
    padding: '0 8px',
    borderRadius: 10,
    border: '1px solid rgba(151, 164, 186, 0.18)',
    background: 'rgba(36, 48, 72, 0.84)',
    color: '#edf4ff',
    fontSize: 12,
    fontWeight: 900,
  },
  headerModeButtonActive: {
    flex: '0 0 auto',
    minWidth: 46,
    height: 32,
    padding: '0 8px',
    borderRadius: 10,
    border: '1px solid rgba(31, 214, 122, 0.42)',
    background: 'rgba(31, 214, 122, 0.18)',
    color: '#edf4ff',
    fontSize: 12,
    fontWeight: 900,
  },
  bitrateSelect: {
    flex: '0 0 auto',
    height: 32,
    maxWidth: 108,
    borderRadius: 10,
    border: '1px solid rgba(151, 164, 186, 0.18)',
    background: 'rgba(36, 48, 72, 0.84)',
    color: '#edf4ff',
    fontSize: 12,
    fontWeight: 850,
    outline: 'none',
  },
  touchScrollFractionSelect: {
    flex: '0 0 auto',
    height: 32,
    maxWidth: 92,
    borderRadius: 10,
    border: '1px solid rgba(151, 164, 186, 0.18)',
    background: 'rgba(36, 48, 72, 0.84)',
    color: '#edf4ff',
    fontSize: 12,
    fontWeight: 850,
    outline: 'none',
  },
  screenshotToast: {
    position: 'absolute',
    left: '50%',
    top: 12,
    zIndex: 5,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: 'max-content',
    maxWidth: 'calc(100% - 24px)',
    minHeight: 38,
    padding: '8px 12px',
    borderRadius: 12,
    color: '#edf4ff',
    background: 'rgba(6, 12, 22, 0.9)',
    border: '1px solid rgba(151, 164, 186, 0.2)',
    boxShadow: '0 14px 36px rgba(0,0,0,0.38)',
    backdropFilter: 'blur(12px)',
    pointerEvents: 'none',
    animation: 'zterm-remote-window-shot-pop 160ms ease-out both',
  },
  screenshotToastProgress: {
    border: '1px solid rgba(31, 214, 122, 0.32)',
  },
  screenshotToastSuccess: {
    border: '1px solid rgba(31, 214, 122, 0.44)',
    animation: 'zterm-remote-window-shot-pop 160ms ease-out both, zterm-remote-window-shot-pulse 1.1s ease-out 1',
  },
  screenshotToastError: {
    border: '1px solid rgba(255, 104, 124, 0.46)',
  },
  screenshotSpinner: {
    flex: '0 0 auto',
    width: 18,
    height: 18,
    borderRadius: 999,
    border: '2px solid rgba(237,244,255,0.22)',
    borderTopColor: mobileTheme.colors.accent,
    animation: 'zterm-remote-window-shot-spin 0.78s linear infinite',
  },
  screenshotResultIcon: {
    flex: '0 0 auto',
    width: 24,
    height: 24,
    borderRadius: 999,
    display: 'grid',
    placeItems: 'center',
    background: 'rgba(31, 214, 122, 0.16)',
    color: mobileTheme.colors.accent,
    fontSize: 10,
    fontWeight: 950,
    lineHeight: 1,
  },
  screenshotResultIconError: {
    background: 'rgba(255, 104, 124, 0.16)',
    color: '#ff7a8d',
  },
  screenshotToastText: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  screenshotToastTitle: {
    fontSize: 12,
    fontWeight: 900,
    lineHeight: 1.15,
    whiteSpace: 'nowrap',
  },
  screenshotToastDetail: {
    maxWidth: 'min(240px, 62vw)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'rgba(237,244,255,0.68)',
    fontSize: 10,
    fontWeight: 750,
    lineHeight: 1.2,
  },
  errorBox: {
    margin: '10px 12px 0',
    padding: '9px 10px',
    borderRadius: 10,
    background: 'rgba(109, 24, 33, 0.82)',
    color: '#ffd7dc',
    fontSize: 12,
    lineHeight: 1.4,
  },
  errorStrip: {
    margin: '10px 12px 0',
    padding: '8px 10px',
    borderRadius: 10,
    background: 'rgba(97, 63, 13, 0.72)',
    color: '#ffe2a8',
    fontSize: 12,
    lineHeight: 1.4,
  },
  targetList: {
    flex: '0 1 auto',
    minHeight: 0,
    maxHeight: 'calc(min(70vh, 560px) - 72px)',
    padding: 10,
    overflowY: 'auto',
    display: 'grid',
    gap: 8,
  },
  targetRow: {
    display: 'grid',
    gridTemplateColumns: '86px minmax(0, 1fr)',
    gap: '4px 10px',
    padding: '10px 11px',
    textAlign: 'left',
    borderRadius: 12,
    border: '1px solid rgba(151, 164, 186, 0.14)',
    background: 'rgba(27, 37, 56, 0.88)',
    color: '#edf4ff',
  },
  targetGroupRow: {
    display: 'grid',
    gridTemplateColumns: '86px minmax(0, 1fr)',
    gap: '4px 10px',
    padding: '10px 11px',
    textAlign: 'left',
    borderRadius: 12,
    border: '1px solid rgba(151, 164, 186, 0.18)',
    background: 'rgba(20, 31, 49, 0.92)',
    color: '#edf4ff',
  },
  targetKind: {
    color: mobileTheme.colors.accent,
    fontSize: 11,
    fontWeight: 900,
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  targetMain: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 13,
    fontWeight: 850,
  },
  targetMeta: {
    gridColumn: '2 / 3',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'rgba(237,244,255,0.62)',
    fontSize: 11,
  },
  emptyState: {
    minHeight: 44,
    display: 'grid',
    placeItems: 'center',
    color: 'rgba(237,244,255,0.62)',
    fontSize: 13,
  },
  floatingOverlay: {
    position: 'absolute',
    right: 12,
    bottom: REMOTE_WINDOW_FLOATING_BOTTOM_BASE_PX,
    zIndex: 32,
    width: 'min(78vw, 360px)',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: 16,
    overflow: 'hidden',
    border: '1px solid rgba(151, 164, 186, 0.22)',
    background: '#050910',
    color: '#edf4ff',
    boxShadow: '0 24px 60px rgba(0,0,0,0.46)',
  },
  floatingResizeHandleLeft: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    width: 38,
    height: 38,
    zIndex: 2,
    cursor: 'nesw-resize',
    touchAction: 'none',
    background: 'radial-gradient(circle at bottom left, rgba(31,214,122,0.36), rgba(31,214,122,0) 68%)',
  },
  floatingResizeHandleRight: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 38,
    height: 38,
    zIndex: 2,
    cursor: 'nwse-resize',
    touchAction: 'none',
    background: 'radial-gradient(circle at bottom right, rgba(31,214,122,0.36), rgba(31,214,122,0) 68%)',
  },
  fullscreenOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 90,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    paddingTop: 'calc(16px + env(safe-area-inset-top, 0px))',
    background: '#02050a',
    color: '#edf4ff',
  },
  lockedToolbar: {
    minHeight: 42,
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(13, 19, 31, 0.94)',
    borderBottom: '1px solid rgba(151, 164, 186, 0.14)',
  },
  lockedTopBar: {
    minHeight: 42,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    padding: '7px 8px',
  },
  lockedPrimaryActions: {
    flex: '0 0 auto',
    display: 'flex',
    gap: 6,
  },
  lockedControlStrip: {
    minWidth: 0,
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    overflowX: 'auto',
    overflowY: 'hidden',
    padding: '0 8px 7px',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
    touchAction: 'pan-x',
  },
  lockedTitle: {
    minWidth: 0,
    flex: '1 1 auto',
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
    fontWeight: 850,
  },
  inputModeBadge: {
    flex: '0 0 auto',
    padding: '2px 6px',
    borderRadius: 8,
    border: '1px solid rgba(151, 164, 186, 0.18)',
    color: 'rgba(237,244,255,0.68)',
    fontSize: 11,
    fontWeight: 850,
  },
  lockedActions: {
    display: 'flex',
    gap: 6,
  },
  videoPlaceholder: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
    overflow: 'hidden',
    background: '#0a101b',
    outline: 'none',
    touchAction: 'none',
  },
  videoContentFrame: {
    position: 'absolute',
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
    background: '#0a101b',
    pointerEvents: 'none',
  },
  videoContentFallback: {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
    background: '#0a101b',
    pointerEvents: 'none',
  },
  videoFrame: {
    position: 'relative',
    width: '100%',
    height: '100%',
    display: 'grid',
    placeItems: 'center',
    alignContent: 'center',
    gap: 8,
    border: '1px solid rgba(151, 164, 186, 0.12)',
    background: '#0a101b',
    overflow: 'hidden',
  },
  videoElement: {
    width: '100%',
    height: '100%',
    display: 'block',
    objectFit: 'contain',
    background: 'transparent',
    pointerEvents: 'none',
    position: 'relative',
    zIndex: 1,
    transition: 'opacity 120ms ease-out',
  },
  videoError: {
    borderColor: 'rgba(248, 113, 113, 0.34)',
    background: '#170d14',
  },
  videoStatus: {
    position: 'relative',
    zIndex: 1,
    fontSize: 14,
    fontWeight: 900,
    color: '#edf4ff',
  },
  videoMeta: {
    position: 'relative',
    zIndex: 1,
    maxWidth: '90%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 11,
    color: 'rgba(237,244,255,0.62)',
  },
  videoWallpaper: {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    background: '#0a101b',
    boxShadow: 'inset 0 0 0 1px rgba(237,244,255,0.04), inset 0 18px 48px rgba(255,255,255,0.035), inset 0 -36px 80px rgba(0,0,0,0.38)',
    pointerEvents: 'none',
    isolation: 'isolate',
  },
  videoWallpaperLogo: {
    width: 'min(42%, 156px)',
    maxHeight: '42%',
    objectFit: 'contain',
    opacity: 0.62,
  },
  minimap: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 86,
    height: 54,
    borderRadius: 6,
    border: '1px solid rgba(237,244,255,0.42)',
    background: 'rgba(4, 8, 14, 0.62)',
    boxShadow: '0 8px 18px rgba(0,0,0,0.32)',
    pointerEvents: 'none',
  },
  minimapViewport: {
    position: 'absolute',
    border: `2px solid ${mobileTheme.colors.accent}`,
    borderRadius: 4,
    background: 'rgba(120, 196, 255, 0.16)',
    boxSizing: 'border-box',
  },
};
