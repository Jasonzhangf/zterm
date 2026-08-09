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
import { useSharedDraggableDrag, SHARED_DRAG_SUPPRESS_CLICK_MS } from './draggable-bubble-shared';
import { mobileTheme } from '../../lib/mobile-ui';
import type {
  RemoteWindowStreamErrorPayload,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamPurpose,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowVideoBitrateConfig,
  RemoteWindowVideoBitratePreset,
} from '../../lib/types';
import type { RemoteWindowControlMessage } from '../../lib/remote-window-message-runtime';
import {
  applyRemoteWindowInputResultTarget,
  applyRemoteWindowTargetCatalog,
  applyRemoteWindowTargetCatalogSnapshot,
  attachRemoteWindowStreamReceiver,
  beginRemoteWindowStreamHandoff,
  beginRemoteWindowStreamSetup,
  beginRemoteWindowTargetEnumeration,
  closeRemoteWindowOverlay,
  commitRemoteWindowStreamHandoff,
  enterRemoteWindowFullscreen,
  failRemoteWindowStreamCleanup,
  failRemoteWindowStreamHandoff,
  failRemoteWindowStream,
  failRemoteWindowTargetCatalog,
  initialRemoteWindowOverlayState,
  resolveRemoteWindowCompositeWindowLayout,
  selectRemoteWindowTarget,
  shrinkRemoteWindowOverlay,
  upsertRemoteWindowCatalogTarget,
  type RemoteWindowStreamHandoffState,
  type RemoteWindowOverlayState,
} from '../../lib/remote-window-overlay-runtime';
import {
  buildRemoteWindowVideoBitrateConfig,
  getRemoteWindowSourceRect,
  readRemoteWindowVideoBitratePreset,
  resolveAdaptiveRemoteWindowVideoBitratePreset,
  resolveEffectiveRemoteWindowVideoBitratePreset,
  resolveRemoteWindowVideoAdaptiveDecision,
  type RemoteWindowVideoAdaptiveState,
  type RemoteWindowVideoStatsSample,
  type RemoteWindowNetworkQualityInput,
} from '../../lib/remote-window-video-quality';
import {
  buildRemoteWindowClickInputEventRuntime,

  createRemoteWindowTouchPointerState,
  dispatchRemoteWindowTouchInputActionsRuntime,
  isRemoteWindowInputSupportedTarget,
  resolveRemoteWindowTouchPairPointerDownRuntime,
  resolveRemoteWindowTouchPairPointerMoveRuntime,
  resolveRemoteWindowTouchPairPointerUpRuntime,
  resolveRemoteWindowTouchPointerCancelRuntime,
  resolveRemoteWindowTouchPointerDownRuntime,
  resolveRemoteWindowTouchPointerMoveRuntime,
  resolveRemoteWindowTouchPointerUpRuntime,
  resolveRemoteWindowTouchSurfacePointRuntime,
  REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION,
  REMOTE_WINDOW_LONG_PRESS_MS,
  type RemoteWindowTouchInputDebugEvent,
  type RemoteWindowTouchLocalEffect,
  type RemoteWindowTouchPairPointerSample,

  type RemoteWindowTouchPointerSample,
  type RemoteWindowTouchPointerState,
  type RemoteWindowTouchSurfaceGeometry,
} from '../../lib/remote-window-touch-action-runtime';
import { WindowGroupLayout } from './WindowGroupLayout';

interface RemoteWindowOverlayProps {
  activeSessionId?: string | null;
  appForegroundActive?: boolean;
  streamInvalidation?: {
    streamId: string;
    message: string;
    nonce: number;
  } | null;
  requestTargets?: (
    sessionId: string,
    options?: { forceRefresh?: boolean },
  ) => Promise<RemoteWindowStreamTargetsResponsePayload>;
  startStream?: (
    sessionId: string,
    target: RemoteWindowStreamTargetManifest,
    streamId: string,
    options?: { videoBitrate?: RemoteWindowVideoBitrateConfig; purpose?: RemoteWindowStreamPurpose },
  ) => Promise<RemoteWindowStreamStartResult>;
  updateStreamQuality?: (
    sessionId: string,
    payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>,
  ) => void;
  updateFocus?: (
    sessionId: string,
    streamId: string,
    target: RemoteWindowStreamTargetManifest,
  ) => void;
  stopStream?: (sessionId: string, streamId: string) => unknown;
  requestScreenshot?: (
    sessionId: string,
    target: RemoteWindowStreamTargetManifest,
    options?: { persist?: boolean },
  ) => Promise<RemoteWindowScreenshotSaveResult>;
  sendInput?: (
    sessionId: string,
    payload: Omit<RemoteWindowInputEventPayload, 'requestId'>,
  ) => void;
  resizeTargetWindow?: (
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
  onVideoDebug?: (snapshot: RemoteWindowVideoDebugSnapshot) => void;
  onRemoteWindowMessage?: (handler: (msg: RemoteWindowControlMessage) => void) => () => void;
}

interface RemoteWindowStreamStartResult {
  streamId: string;
  purpose?: RemoteWindowStreamPurpose;
  mediaStream?: MediaStream | null;
  overviewMediaStream?: MediaStream | null;
  started?: RemoteWindowStreamStartedPayload;
  collectStats?: () => Promise<RemoteWindowVideoStatsSample | null>;
}

interface RemoteWindowScreenshotSaveResult {
  fileName: string;
  savedPath: string;
  dataUrl?: string;
}

type RemoteWindowScreenshotStatus =
  | { phase: 'idle' }
  | { phase: 'capturing' }
  | { phase: 'saved'; fileName: string; savedPath: string }
  | { phase: 'failed'; message: string };

type RemoteWindowThumbnailStatus =
  | { phase: 'loading'; requestId: string; sessionId: string; targetId: string; updatedAt: number }
  | { phase: 'ready'; dataUrl: string; fileName: string; updatedAt: number }
  | { phase: 'failed'; message: string; updatedAt: number };

interface RemoteWindowThumbnailRequestToken {
  requestId: string;
  sessionId: string;
  targetId: string;
  startedAt: number;
}

export interface RemoteWindowInputContext {
  sessionId: string;
  streamId: string;
  targetId: string;
  targetKind: RemoteWindowStreamTargetManifest['videoTarget']['kind'];
  inputTargetKind: RemoteWindowStreamTargetManifest['inputTarget']['kind'];
  focusPolicy: RemoteWindowStreamTargetManifest['focusPolicy'];
  inputRoute: RemoteWindowStreamTargetManifest['inputRoute'];
}

export interface RemoteWindowVideoDebugSnapshot {
  attached: boolean;
  visible: boolean;
  readyState: number;
  paused: boolean;
  videoWidth: number;
  videoHeight: number;
  playAttempts: number;
  playAccepted: number;
  playRejected: number;
  framesReceived: number;
  lastEvent: string;
  lastError: string;
  updatedAt: number | null;
}

export interface RemoteWindowLiveDiagnostics {
  sampledAt: number;
  currentTime: number;
  paused: boolean;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  framesReceived: number;
  trackState: string;
  trackMuted: boolean;
  epoch: number;
  streamId: string | null;
}

interface FloatingOverlayOffset {
  x: number;
  y: number;
}

interface FloatingEntryPosition {
  x: number | null;
  y: number | null;
}

function readStoredEntryPosition(): FloatingEntryPosition {
  if (typeof window === 'undefined') {
    return { x: null, y: null };
  }
  try {
    const raw = localStorage.getItem(REMOTE_WINDOW_ENTRY_POSITION_STORAGE_KEY);
    if (!raw) {
      return { x: null, y: null };
    }
    const parsed = JSON.parse(raw) as Partial<{ x: number; y: number }>;
    return {
      x: typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : null,
      y: typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : null,
    };
  } catch (error) {
    console.warn('[RemoteWindowOverlay] Failed to read stored entry position:', error);
    return { x: null, y: null };
  }
}

interface RemoteWindowCatalogProjectionSnapshot {
  sessionId: string;
  payload: RemoteWindowStreamTargetsResponsePayload;
  updatedAt: number;
}

interface RemoteWindowViewportDebugSnapshot {
  event: string;
  window: string;
  visualViewport: string;
  surface: string;
  overlay: string;
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
      mode: 'pan';
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startPanX: number;
      startPanY: number;
      moved: boolean;
    };

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

const FLOATING_OVERLAY_VIEWPORT_MARGIN_PX = 8;
const FLOATING_OVERLAY_TOP_SAFE_MARGIN_PX = 48;
const REMOTE_WINDOW_FLOATING_BOTTOM_BASE_PX = 118;
const FLOATING_ENTRY_VIEWPORT_MARGIN_PX = 10;
const FLOATING_ENTRY_TOP_MARGIN_PX = 28;
const REMOTE_WINDOW_ENTRY_POSITION_STORAGE_KEY = 'zterm:remote-window:entry-position-v1';
const FLOATING_OVERLAY_MIN_WIDTH_PX = 168;
const FLOATING_OVERLAY_MAX_WIDTH_PX = 560;
const FLOATING_OVERLAY_TOOLBAR_ESTIMATE_PX = 50;
const REMOTE_WINDOW_FULLSCREEN_MIN_SCALE = 1;
const REMOTE_WINDOW_FULLSCREEN_MAX_SCALE = 4;
const REMOTE_WINDOW_FULLSCREEN_PAN_TAP_THRESHOLD_PX = 8;
const REMOTE_WINDOW_SECOND_FINGER_UPGRADE_PX = 8;

const REMOTE_WINDOW_CATALOG_UI_TIMEOUT_MS = 20_000;
const REMOTE_WINDOW_CATALOG_PROJECTION_CACHE_TTL_MS = 60_000;
const REMOTE_WINDOW_ACTIVE_CATALOG_SYNC_INTERVAL_MS = 5_000;
const REMOTE_WINDOW_THUMBNAIL_REFRESH_INTERVAL_MS = 15_000;
const REMOTE_WINDOW_THUMBNAIL_MAX_REQUESTS_PER_TICK = 1;
const REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_STORAGE_KEY = 'zterm:remote-window:touch-scroll-fraction-v1';
const REMOTE_WINDOW_TOUCH_SCROLL_INVERTED_STORAGE_KEY = 'zterm:remote-window:touch-scroll-inverted-v1';
const REMOTE_WINDOW_INPUT_MODE_STORAGE_KEY = 'zterm:remote-window:input-mode-v1';
const REMOTE_WINDOW_DOUBLE_TAP_MS = 300;
const REMOTE_WINDOW_DOUBLE_TAP_SLOP_PX = 8;

type RemoteWindowInputMode = 'touch' | 'mouse';

const initialFullscreenViewport: FullscreenViewportState = {
  scale: 1,
  panX: 0,
  panY: 0,
};

const initialFullscreenDisplayMode: FullscreenDisplayMode = 'fill';

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
  void displayMode;
  const scale = Math.min(surfaceWidth / sourceWidth, surfaceHeight / sourceHeight);
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
  void displayMode;
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

function resolveAnchoredFullscreenViewportScale(options: {
  surface: SurfaceSize;
  source: { width: number; height: number };
  current: FullscreenViewportState;
  nextScale: number;
  anchorClientX: number;
  anchorClientY: number;
  surfaceLeft: number;
  surfaceTop: number;
  displayMode: FullscreenDisplayMode;
  keyboardPanAllowancePx: number;
}): FullscreenViewportState {
  const currentRect = resolveZoomedContentRect(
    options.surface,
    options.source,
    options.current,
    options.displayMode,
  ).content;
  const anchorX = options.anchorClientX - options.surfaceLeft;
  const anchorY = options.anchorClientY - options.surfaceTop;
  const normalizedAnchorX = currentRect.width > 0
    ? clampNumber((anchorX - currentRect.left) / currentRect.width, 0, 1)
    : 0.5;
  const normalizedAnchorY = currentRect.height > 0
    ? clampNumber((anchorY - currentRect.top) / currentRect.height, 0, 1)
    : 0.5;
  const base = resolveAspectRect(options.surface, options.source, options.displayMode);
  const nextWidth = base.width * options.nextScale;
  const nextHeight = base.height * options.nextScale;
  const nextLeft = anchorX - normalizedAnchorX * nextWidth;
  const nextTop = anchorY - normalizedAnchorY * nextHeight;
  return clampFullscreenViewport(
    {
      scale: options.nextScale,
      panX: nextLeft - (base.left + (base.width - nextWidth) / 2),
      panY: nextTop - (base.top + (base.height - nextHeight) / 2),
    },
    options.surface,
    options.source,
    options.displayMode,
    options.keyboardPanAllowancePx,
  );
}

















function resolveTouchScrollFractionPreset(value: unknown): RemoteWindowTouchScrollFraction {
  const parsed = typeof value === 'number' ? value : Number(value);
  const matched = REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_OPTIONS.find((option) => option === parsed);
  return matched ?? REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION;
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
  focusedWindowSlot?: { width: number; height: number } | null,
): SurfaceSize {
  // 组合模式：主画面显示焦点窗口（裁切放大），显示源尺寸 = 焦点窗口尺寸，
  // 否则坐标/布局会按整个画布比例计算，与 video 实际显示不一致
  if (focusedWindowSlot && focusedWindowSlot.width > 0 && focusedWindowSlot.height > 0) {
    return { width: focusedWindowSlot.width, height: focusedWindowSlot.height };
  }
  if (receiverFrameSize) {
    return receiverFrameSize;
  }
  const sourceRect = getRemoteWindowSourceRect(target);
  return {
    width: sourceRect.width,
    height: sourceRect.height,
  };
}

function parseCssPx(value: string | null | undefined) {
  const match = String(value || '').match(/-?\d+(?:\.\d+)?/u);
  const parsed = match ? Number.parseFloat(match[0]) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveRemoteWindowFullscreenFillReferenceSize(options: {
  overlay: HTMLElement | null;
  toolbar: HTMLElement | null;
  surface: HTMLElement | null;
  fallbackSurfaceSize: SurfaceSize | null;
}): SurfaceSize | null {
  const overlayRect = options.overlay?.getBoundingClientRect();
  if (overlayRect && overlayRect.width > 0 && overlayRect.height > 0) {
    const computed = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(options.overlay as HTMLElement)
      : null;
    const toolbarRect = options.toolbar?.getBoundingClientRect();
    const toolbarHeight = toolbarRect && toolbarRect.height > 0 ? toolbarRect.height : 0;
    const width = overlayRect.width
      - parseCssPx(computed?.paddingLeft)
      - parseCssPx(computed?.paddingRight);
    const height = overlayRect.height
      - parseCssPx(computed?.paddingTop)
      - parseCssPx(computed?.paddingBottom)
      - toolbarHeight;
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }

  const surfaceRect = options.surface?.getBoundingClientRect();
  if (surfaceRect && surfaceRect.width > 0 && surfaceRect.height > 0) {
    return { width: surfaceRect.width, height: surfaceRect.height };
  }

  return options.fallbackSurfaceSize;
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
  if (gesture.mode === 'pan') {
    return {
      mode: 'localPan',
      pointerId: gesture.pointerId,
      startClientX: gesture.startClientX,
      startClientY: gesture.startClientY,
      moved: gesture.moved,
    };
  }
  if (
    gesture.mode === 'actionPending'
    || gesture.mode === 'actionDrag'
    || gesture.mode === 'actionScroll'
    || gesture.mode === 'actionLongPress'
    || gesture.mode === 'twoFingerCandidate'
    || gesture.mode === 'twoFingerScroll'
    || gesture.mode === 'pinch'
  ) {
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

function readRemoteWindowTouchScrollFraction(): RemoteWindowTouchScrollFraction {
  if (typeof window === 'undefined') {
    return REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION;
  }
  return resolveTouchScrollFractionPreset(
    window.localStorage.getItem(REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_STORAGE_KEY),
  );
}

function readRemoteWindowTouchScrollInverted() {
  if (typeof window === 'undefined') {
    return true;
  }
  const raw = window.localStorage.getItem(REMOTE_WINDOW_TOUCH_SCROLL_INVERTED_STORAGE_KEY);
  return raw === null ? true : raw === 'true';
}

function readRemoteWindowInputMode(): RemoteWindowInputMode {
  if (typeof window === 'undefined') {
    return 'touch';
  }
  const raw = window.localStorage.getItem(REMOTE_WINDOW_INPUT_MODE_STORAGE_KEY);
  return raw === 'mouse' ? 'mouse' : 'touch';
}

function writeRemoteWindowInputMode(mode: RemoteWindowInputMode) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(REMOTE_WINDOW_INPUT_MODE_STORAGE_KEY, mode);
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

interface RemoteWindowAppTargetGroup {
  groupId: string;
  appBundleId: string;
  pid: number;
  title: string;
  targets: RemoteWindowStreamTargetManifest[];
}

function remoteWindowTargetArea(target: RemoteWindowStreamTargetManifest) {
  const rect = target.videoTarget.cropRectTopLeftPx || target.videoTarget.windowBoundsTopLeftPx;
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function getRemoteWindowAppGroupId(target: RemoteWindowStreamTargetManifest) {
  if (target.videoTarget.kind !== 'app-window') {
    return null;
  }
  const appBundleId = target.videoTarget.appBundleId || 'unknown-app';
  const pid = target.videoTarget.pid || 0;
  return `${appBundleId}:${pid}`;
}

function buildRemoteWindowAppTargetGroups(
  targets: RemoteWindowStreamTargetManifest[],
): RemoteWindowAppTargetGroup[] {
  const groups = new Map<string, RemoteWindowAppTargetGroup>();
  for (const target of targets) {
    const groupId = getRemoteWindowAppGroupId(target);
    if (!groupId) {
      continue;
    }
    const appBundleId = target.videoTarget.appBundleId || 'unknown-app';
    const pid = target.videoTarget.pid || 0;
    const existing = groups.get(groupId);
    if (existing) {
      existing.targets.push(target);
      continue;
    }
    groups.set(groupId, {
      groupId,
      appBundleId,
      pid,
      title: target.videoTarget.title || appBundleId,
      targets: [target],
    });
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    targets: group.targets.slice().sort((left, right) => remoteWindowTargetArea(right) - remoteWindowTargetArea(left)),
  }));
}

function safeRemoteWindowGroupId(groupId: string) {
  return groupId.replace(/[^a-zA-Z0-9_-]+/g, '-');
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
  streamInvalidation = null,
  requestTargets,
  startStream,
  updateStreamQuality,
  updateFocus,
  stopStream,
  requestScreenshot,
  sendInput,
  resizeTargetWindow,
  onInputDebug,
  bottomInsetPx = 0,
  bottomChromeInsetPx = 0,
  onOpenStateChange,
  onBodySubscriptionSuppressedChange,
  onInputContextChange,
  onRequestKeyboard,
  onVideoDebug,
  onRemoteWindowMessage,
}: RemoteWindowOverlayProps) {
  const [state, setState] = useState<RemoteWindowOverlayState>(initialRemoteWindowOverlayState);
  const [floatingOffset, setFloatingOffsetState] = useState<FloatingOverlayOffset>({ x: 0, y: 0 });
  const [floatingOverlayWidthPx, setFloatingOverlayWidthPxState] = useState<number | null>(null);
  const [surfaceSize, setSurfaceSize] = useState<SurfaceSize | null>(null);
  const [fullscreenViewport, setFullscreenViewportState] = useState<FullscreenViewportState>(initialFullscreenViewport);
  const [fullscreenDisplayMode, setFullscreenDisplayModeState] = useState<FullscreenDisplayMode>(initialFullscreenDisplayMode);
  const [bitratePreset, setBitratePreset] = useState<RemoteWindowVideoBitratePreset>('5mbps');
  const [touchScrollFraction] = useState<RemoteWindowTouchScrollFraction>(() => readRemoteWindowTouchScrollFraction());
  const [touchScrollInverted] = useState(() => readRemoteWindowTouchScrollInverted());
  const [inputMode, setInputMode] = useState<RemoteWindowInputMode>(() => readRemoteWindowInputMode());
  const inputModeRef = useRef(inputMode);
  const [focusedWindowId, setFocusedWindowId] = useState<string | null>(null);
  const compositeOverviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositeThumbCanvasRefs = useRef<Map<string, HTMLCanvasElement | null>>(new Map());
  // 组合推流（background pane）：平铺布局（与 daemon 同算法），供 rAF 绘制与三区 UI 使用
  const compositeLayout = state.phase === 'targetLocked'
    ? resolveRemoteWindowCompositeWindowLayout(state.target)
    : null;
  const focusedWindowSlot = compositeLayout
    ? (compositeLayout.windows.find((w) => w.windowId === focusedWindowId) ?? compositeLayout.windows[0] ?? null)
    : null;
  const focusedWindowSlotRef = useRef(focusedWindowSlot);
  focusedWindowSlotRef.current = focusedWindowSlot;
  const secondPointerPendingRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    downTimeMs: number;
  } | null>(null);
  const lastTapRef = useRef<{
    atMs: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);
  const [networkQuality, setNetworkQuality] = useState<RemoteWindowNetworkQualityInput | null>(() => readRemoteWindowNetworkQuality());
  const [videoHasPlayed, setVideoHasPlayedState] = useState(false);
  const videoHasPlayedRef = useRef(false);
  const [receiverMediaStream, setReceiverMediaStream] = useState<MediaStream | null>(null);
  const [overviewMediaStream, setOverviewMediaStream] = useState<MediaStream | null>(null);
  const [receiverFrameSize, setReceiverFrameSize] = useState<SurfaceSize | null>(null);
  const [itermPaneTargetsExpanded, setItermPaneTargetsExpanded] = useState(false);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [appSwitchOpen, setAppSwitchOpen] = useState(false);
  const [streamStatusOpen, setStreamStatusOpen] = useState(false);
  const [liveDiag, setLiveDiag] = useState<RemoteWindowLiveDiagnostics | null>(null);
  const [videoDebugSnapshot, setVideoDebugSnapshot] = useState<RemoteWindowVideoDebugSnapshot | null>(null);
  const [viewportDebugSnapshot, setViewportDebugSnapshot] = useState<RemoteWindowViewportDebugSnapshot | null>(null);
  const [activeCatalogSyncError, setActiveCatalogSyncError] = useState<string | null>(null);
  const [screenshotStatus, setScreenshotStatus] = useState<RemoteWindowScreenshotStatus>({ phase: 'idle' });
  const [windowThumbnails, setWindowThumbnailsState] = useState<Record<string, RemoteWindowThumbnailStatus>>({});
  const [entryOffset, setEntryOffsetState] = useState<FloatingEntryPosition>(() => readStoredEntryPosition());
  const floatingOffsetRef = useRef(floatingOffset);
  const floatingOverlayWidthPxRef = useRef(floatingOverlayWidthPx);
  const fullscreenViewportRef = useRef(fullscreenViewport);
  const fullscreenDisplayModeRef = useRef<FullscreenDisplayMode>(fullscreenDisplayMode);
  const touchScrollFractionRef = useRef<RemoteWindowTouchScrollFraction>(touchScrollFraction);
  const touchScrollInvertedRef = useRef(touchScrollInverted);
  const windowThumbnailsRef = useRef(windowThumbnails);
  const entryOffsetRef = useRef(entryOffset);
  const suppressEntryClickRef = useRef(false);
  const entryButtonRef = useRef<HTMLButtonElement | null>(null);
  const floatingOverlayRef = useRef<HTMLDivElement | null>(null);
  const lockedToolbarRef = useRef<HTMLDivElement | null>(null);
  const floatingResizeRef = useRef<FloatingOverlayResize | null>(null);
  const videoSurfaceRef = useRef<HTMLDivElement | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const overviewVideoElementRef = useRef<HTMLVideoElement | null>(null);
  const videoFrameCallbackRef = useRef<((now: number) => void) | null>(null);
  const activeStreamIdRef = useRef<string | null>(null);
  const activeCanvasStreamIdRef = useRef<string | null>(null);
  const activeFocusStreamIdRef = useRef<string | null>(null);
  const pendingFocusStreamIdRef = useRef<string | null>(null);
  const streamRequestEpochRef = useRef(0);
  const handoffEpochRef = useRef(0);
  const activeHandoffRef = useRef<RemoteWindowStreamHandoffState | null>(null);
  const handoffVideoVisibilityRef = useRef<boolean | null>(null);
  const receiverPlaybackEpochRef = useRef(0);
  const receiverPlaybackBindingRef = useRef<{ epoch: number; stream: MediaStream } | null>(null);
  const thumbnailInFlightTargetIdsRef = useRef<Map<string, RemoteWindowThumbnailRequestToken>>(new Map());
  const lastDefaultFullscreenFillKeyRef = useRef<string | null>(null);
  const videoPlaybackStatsRef = useRef({
    playAttempts: 0,
    playAccepted: 0,
    playRejected: 0,
    framesReceived: 0,
    lastError: '-',
  });
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
  const surfacePinchStartRef = useRef<{
    pointerId: number;
    startScale: number;
  } | null>(null);
  const catalogWatchdogRef = useRef<number | null>(null);
  const catalogWatchdogEpochRef = useRef<number | null>(null);
  const lastCatalogPayloadRef = useRef<RemoteWindowCatalogProjectionSnapshot | null>(null);
  const lastTouchEndAtRef = useRef(0);
  const lastReportedQuickBarSuppressionRef = useRef<boolean | null>(null);
  const lastReportedBodySuppressionRef = useRef<boolean | null>(null);
  const lastReportedInputContextKeyRef = useRef<string | null>(null);
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
  const currentLockedStreamId = state.phase === 'targetLocked' ? state.streamId || null : null;
  const currentLockedTarget = state.phase === 'targetLocked' ? state.target : null;

  const sendRemoteWindowInputEventsForTarget = useCallback((
    input: {
      sessionId: string | null;
      streamId: string | null;
      target: RemoteWindowStreamTargetManifest;
      events: Array<RemoteWindowInputEventPayload['event']>;
    },
  ) => {
    if (
      !input.sessionId
      || !input.streamId
      || !isRemoteWindowInputSupported(input.target)
    ) {
      return false;
    }
    try {
      const result = dispatchRemoteWindowTouchInputActionsRuntime({
        source: 'overlay',
        sessionId: input.sessionId,
        streamId: input.streamId,
        target: input.target,
        events: input.events,
        sendInput,
        onDebug: onInputDebug,
      });
      return result.failedCount === 0 && result.sentCount === input.events.length;
    } catch (error) {
      console.warn('[RemoteWindowOverlay] remote input send failed:', error);
      onInputDebug?.({
        source: 'overlay',
        sent: false,
        sessionId: input.sessionId,
        streamId: input.streamId,
        targetId: input.target.streamTargetId || null,
        targetTitle: input.target.videoTarget.title || input.target.videoTarget.appBundleId || null,
        event: input.events[0] || { kind: 'focus' },
      });
      return false;
    }
  }, [onInputDebug, sendInput]);

  const dispatchRemoteWindowInputEvents = useCallback((
    events: Array<RemoteWindowInputEventPayload['event']>,
  ) => {
    if (
      state.phase !== 'targetLocked'
      || !state.streamId
      || !activeSessionId
      || !currentLockedTarget
    ) {
      return false;
    }
    return sendRemoteWindowInputEventsForTarget({
      sessionId: activeSessionId,
      streamId: currentLockedStreamId,
      target: currentLockedTarget,
      events,
    });
  }, [activeSessionId, currentLockedStreamId, currentLockedTarget, sendRemoteWindowInputEventsForTarget, state.phase]);

  const handleCloseRemoteApp = useCallback((target: RemoteWindowStreamTargetManifest) => {
    if (!activeSessionId || !currentLockedStreamId || !isRemoteWindowInputSupported(target)) {
      return;
    }
    sendRemoteWindowInputEventsForTarget({
      sessionId: activeSessionId,
      streamId: currentLockedStreamId,
      target,
      events: [{ kind: 'close-window' }],
    });
  }, [activeSessionId, currentLockedStreamId, sendRemoteWindowInputEventsForTarget]);

  const setFloatingOffset = useCallback((next: FloatingOverlayOffset) => {
    floatingOffsetRef.current = next;
    setFloatingOffsetState(next);
  }, []);

  const setFloatingOverlayWidthPx = useCallback((next: number | null) => {
    floatingOverlayWidthPxRef.current = next;
    setFloatingOverlayWidthPxState(next);
  }, []);

  const setEntryOffset = useCallback((next: FloatingEntryPosition) => {
    entryOffsetRef.current = next;
    setEntryOffsetState(next);
    try {
      localStorage.setItem(REMOTE_WINDOW_ENTRY_POSITION_STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      console.warn('[RemoteWindowOverlay] Failed to store entry position:', error);
    }
  }, []);

  // 浮层手柄拖拽：与文件 bubble / 浮钮同一套共享拖拽逻辑（pointer+touch 双套）
  const floatingDragInitialRef = useRef<{ left: number; top: number } | null>(null);
  const floatingDragHandlers = useSharedDraggableDrag({
    getRect: () => {
      if (state.phase !== 'targetLocked' || state.mode !== 'floating') {
        return null;
      }
      const overlay = floatingOverlayRef.current;
      if (!overlay) {
        return null;
      }
      const rect = overlay.getBoundingClientRect();
      const offset = floatingOffsetRef.current;
      floatingDragInitialRef.current = { left: rect.left - offset.x, top: rect.top - offset.y };
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    },
    clampPosition: (x, y, width, height) => {
      const initial = floatingDragInitialRef.current;
      if (!initial) {
        return { x: floatingOffsetRef.current.x, y: floatingOffsetRef.current.y };
      }
      const viewportWidth = Math.round(window.visualViewport?.width || window.innerWidth || 0);
      const viewportHeight = Math.round(window.visualViewport?.height || window.innerHeight || 0);
      const minX = FLOATING_OVERLAY_VIEWPORT_MARGIN_PX;
      const maxX = Math.max(minX, viewportWidth - width - FLOATING_OVERLAY_VIEWPORT_MARGIN_PX);
      const minY = FLOATING_OVERLAY_TOP_SAFE_MARGIN_PX;
      const maxY = Math.max(minY, viewportHeight - height - FLOATING_OVERLAY_VIEWPORT_MARGIN_PX);
      return {
        x: clampFloatingOffset(x, minX, maxX) - initial.left,
        y: clampFloatingOffset(y, minY, maxY) - initial.top,
      };
    },
    onPositionChange: (position) => setFloatingOffset(position),
    onDragActive: () => {},
    onDragFinished: () => {},
  });

  // 浮钮拖拽：同一套共享逻辑
  const entryDragHandlers = useSharedDraggableDrag({
    getRect: () => {
      const button = entryButtonRef.current;
      if (!button) {
        return null;
      }
      const rect = button.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width || 44, height: rect.height || 44 };
    },
    clampPosition: (x, y, width, height) => {
      const viewportWidth = Math.max(
        width + FLOATING_ENTRY_VIEWPORT_MARGIN_PX * 2,
        Math.round(window.visualViewport?.width || window.innerWidth || 0),
      );
      const viewportHeight = Math.max(
        height + FLOATING_ENTRY_VIEWPORT_MARGIN_PX * 2,
        Math.round(window.visualViewport?.height || window.innerHeight || 0),
      );
      return {
        x: clampFloatingOffset(
          x,
          FLOATING_ENTRY_VIEWPORT_MARGIN_PX,
          Math.max(FLOATING_ENTRY_VIEWPORT_MARGIN_PX, viewportWidth - width - FLOATING_ENTRY_VIEWPORT_MARGIN_PX),
        ),
        y: clampFloatingOffset(
          y,
          FLOATING_ENTRY_TOP_MARGIN_PX,
          Math.max(FLOATING_ENTRY_TOP_MARGIN_PX, viewportHeight - height - FLOATING_ENTRY_TOP_MARGIN_PX),
        ),
      };
    },
    onPositionChange: (position) => setEntryOffset(position),
    onDragActive: () => {
      suppressEntryClickRef.current = true;
    },
    onDragFinished: () => {
      suppressEntryClickRef.current = true;
      window.setTimeout(() => {
        suppressEntryClickRef.current = false;
      }, SHARED_DRAG_SUPPRESS_CLICK_MS);
    },
  });


  // 与文件 bubble 一致：viewport 变化时纠正浮钮位置，避免拖动后的固定 left/top 越界
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const rescueEntryPosition = () => {
      const current = entryOffsetRef.current;
      if (current.x === null || current.y === null) {
        return;
      }
      const width = 44;
      const height = 44;
      const viewportWidth = Math.max(
        width + FLOATING_ENTRY_VIEWPORT_MARGIN_PX * 2,
        Math.round(window.visualViewport?.width || window.innerWidth || 0),
      );
      const viewportHeight = Math.max(
        height + FLOATING_ENTRY_VIEWPORT_MARGIN_PX * 2,
        Math.round(window.visualViewport?.height || window.innerHeight || 0),
      );
      const clamped = {
        x: clampFloatingOffset(
          current.x,
          FLOATING_ENTRY_VIEWPORT_MARGIN_PX,
          Math.max(FLOATING_ENTRY_VIEWPORT_MARGIN_PX, viewportWidth - width - FLOATING_ENTRY_VIEWPORT_MARGIN_PX),
        ),
        y: clampFloatingOffset(
          current.y,
          FLOATING_ENTRY_TOP_MARGIN_PX,
          Math.max(FLOATING_ENTRY_TOP_MARGIN_PX, viewportHeight - height - FLOATING_ENTRY_TOP_MARGIN_PX),
        ),
      };
      if (clamped.x !== current.x || clamped.y !== current.y) {
        setEntryOffset(clamped);
      }
    };
    window.addEventListener('resize', rescueEntryPosition);
    window.addEventListener('orientationchange', rescueEntryPosition);
    return () => {
      window.removeEventListener('resize', rescueEntryPosition);
      window.removeEventListener('orientationchange', rescueEntryPosition);
    };
  }, [setEntryOffset]);

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

  const clampFloatingOverlayOffsetToViewport = useCallback(() => {
    const overlay = floatingOverlayRef.current;
    if (!overlay) {
      return;
    }
    const rect = overlay.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft || 0;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportWidth = Math.round(viewport?.width || window.innerWidth || rect.width);
    const viewportHeight = Math.round(viewport?.height || window.innerHeight || rect.height);
    const minLeft = viewportLeft + FLOATING_OVERLAY_VIEWPORT_MARGIN_PX;
    const minTop = viewportTop + FLOATING_OVERLAY_TOP_SAFE_MARGIN_PX;
    const maxLeft = viewportLeft + viewportWidth - FLOATING_OVERLAY_VIEWPORT_MARGIN_PX - rect.width;
    const maxTop = viewportTop + viewportHeight - FLOATING_OVERLAY_VIEWPORT_MARGIN_PX - rect.height;
    const clampedLeft = clampFloatingOffset(rect.left, minLeft, Math.max(minLeft, maxLeft));
    const clampedTop = clampFloatingOffset(rect.top, minTop, Math.max(minTop, maxTop));
    if (Math.abs(clampedLeft - rect.left) < 0.5 && Math.abs(clampedTop - rect.top) < 0.5) {
      return;
    }
    setFloatingOffset({
      x: floatingOffsetRef.current.x + clampedLeft - rect.left,
      y: floatingOffsetRef.current.y + clampedTop - rect.top,
    });
  }, [setFloatingOffset]);

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
        ? resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize, focusedWindowSlotRef.current)
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
    surfacePinchStartRef.current = null;
  }, []);

  const handleDoubleTapZoom = useCallback((clientX: number, clientY: number) => {
    const surface = readVideoSurfaceSize();
    if (!surface) {
      return;
    }
    setFullscreenViewport((current) => {
      if (current.scale > 1.01) {
        return { scale: 1, panX: 0, panY: 0 };
      }
      const scale = Math.min(REMOTE_WINDOW_FULLSCREEN_MAX_SCALE, current.scale * 2);
      const ratio = scale / current.scale;
      return {
        scale,
        panX: clientX - (clientX - current.panX) * ratio,
        panY: clientY - (clientY - current.panY) * ratio,
      };
    });
  }, [readVideoSurfaceSize, setFullscreenViewport]);

  const setFullscreenDisplayMode = useCallback((next: FullscreenDisplayMode) => {
    fullscreenDisplayModeRef.current = next;
    setFullscreenDisplayModeState(next);
  }, []);

  const setWindowThumbnails = useCallback((
    next: Record<string, RemoteWindowThumbnailStatus>
      | ((current: Record<string, RemoteWindowThumbnailStatus>) => Record<string, RemoteWindowThumbnailStatus>),
  ) => {
    setWindowThumbnailsState((current) => {
      const resolved = typeof next === 'function' ? next(current) : next;
      windowThumbnailsRef.current = resolved;
      return resolved;
    });
  }, []);

  const rememberRemoteWindowCatalogPayload = useCallback((
    sessionId: string,
    payload: RemoteWindowStreamTargetsResponsePayload,
  ) => {
    const cachedPayload = cloneRemoteWindowCatalogPayload(payload);
    lastCatalogPayloadRef.current = {
      sessionId,
      payload: cachedPayload,
      updatedAt: Date.now(),
    };
    return cachedPayload;
  }, []);

  const rememberRemoteWindowCatalogTarget = useCallback((
    sessionId: string,
    target: RemoteWindowStreamTargetManifest,
  ) => {
    const current = lastCatalogPayloadRef.current;
    const basePayload = current && current.sessionId === sessionId
      ? current.payload
      : { requestId: `rw-local-target-${Date.now()}`, targets: [] };
    lastCatalogPayloadRef.current = {
      sessionId,
      payload: upsertRemoteWindowCatalogTarget(basePayload, target),
      updatedAt: Date.now(),
    };
  }, []);

  const applyRemoteWindowActiveCatalogPayload = useCallback((
    sessionId: string,
    payload: RemoteWindowStreamTargetsResponsePayload,
  ) => {
    const cachedPayload = rememberRemoteWindowCatalogPayload(sessionId, payload);
    setActiveCatalogSyncError(null);
    setState((current) => applyRemoteWindowTargetCatalogSnapshot(current, cachedPayload));
  }, [rememberRemoteWindowCatalogPayload]);

  useLayoutEffect(() => {
    if (state.phase !== 'targetLocked') {
      setSurfaceSize(null);
      return;
    }
    const surface = videoSurfaceRef.current;
    if (!surface) {
      return;
    }
    const viewport = window.visualViewport;
    const update = (event = 'layout') => {
      const rect = surface.getBoundingClientRect();
      const formatRect = (value: { left: number; top: number; width: number; height: number } | null) => (
        value ? `${Math.round(value.left)},${Math.round(value.top)} ${Math.round(value.width)}x${Math.round(value.height)}` : '-'
      );
      setViewportDebugSnapshot({
        event,
        window: `${window.innerWidth}x${window.innerHeight}`,
        visualViewport: viewport
          ? `${Math.round(viewport.offsetLeft)},${Math.round(viewport.offsetTop)} ${Math.round(viewport.width)}x${Math.round(viewport.height)} scale=${viewport.scale}`
          : '-',
        surface: formatRect(rect),
        overlay: formatRect(floatingOverlayRef.current?.getBoundingClientRect() || null),
        updatedAt: Date.now(),
      });
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const next = { width: rect.width, height: rect.height };
      setSurfaceSize((current) => (
        current && current.width === next.width && current.height === next.height ? current : next
      ));
      const displaySourceSize = resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize, focusedWindowSlotRef.current);
      const displayMode = state.mode === 'fullscreen'
        ? fullscreenDisplayMode
        : initialFullscreenDisplayMode;
      setFullscreenViewportState((current) => {
        const clamped = clampFullscreenViewport(current, next, displaySourceSize, displayMode, bottomInsetPx);
        fullscreenViewportRef.current = clamped;
        return clamped;
      });
    };
    update('layout');
    let repaintFrame = 0;
    const scheduleStableUpdate = (event: string) => {
      window.cancelAnimationFrame(repaintFrame);
      repaintFrame = window.requestAnimationFrame(() => {
        update(event);
        repaintFrame = window.requestAnimationFrame(() => update(`${event}:settled`));
      });
    };
    const ResizeObserverCtor = typeof ResizeObserver === 'undefined' ? null : ResizeObserver;
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(() => scheduleStableUpdate('resize-observer')) : null;
    observer?.observe(surface);
    const handleResize = () => scheduleStableUpdate('resize');
    const handleOrientationChange = () => scheduleStableUpdate('orientationchange');
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleOrientationChange);
    viewport?.addEventListener('resize', handleResize);
    viewport?.addEventListener('scroll', handleResize);
    return () => {
      window.cancelAnimationFrame(repaintFrame);
      observer?.disconnect();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleOrientationChange);
      viewport?.removeEventListener('resize', handleResize);
      viewport?.removeEventListener('scroll', handleResize);
    };
  }, [bottomInsetPx, fullscreenDisplayMode, receiverFrameSize, state]);

  useLayoutEffect(() => {
    if (state.phase !== 'targetLocked' || state.mode !== 'floating') {
      return;
    }
    clampFloatingOverlayOffsetToViewport();
  }, [
    bottomInsetPx,
    clampFloatingOverlayOffsetToViewport,
    floatingOverlayWidthPx,
    receiverFrameSize,
    state,
  ]);

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

    const displaySourceSize = resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize, focusedWindowSlotRef.current);
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
    setAppSwitchOpen(false);
    setActiveCatalogSyncError(null);
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
      // eslint-disable-next-line no-console
      console.log(`[remote-window-picker] open skipped: targetSessionId=${targetSessionId ? 'ok' : 'EMPTY'} requestTargets=${requestTargets ? 'ok' : 'MISSING'}`);
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
        const cachedPayload = rememberRemoteWindowCatalogPayload(targetSessionId, payload);
        setState((current) => applyRemoteWindowTargetCatalog(current, started.requestEpoch, cachedPayload));
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.log(`[remote-window-picker] catalog request failed: ${error instanceof Error ? error.message : String(error)}`);
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
  }, [activeSessionId, clearCatalogWatchdog, rememberRemoteWindowCatalogPayload, requestTargets, state]);

  const handleClose = useCallback(() => {
    clearCatalogWatchdog();
    setItermPaneTargetsExpanded(false);
    setAppSwitchOpen(false);
    setActiveCatalogSyncError(null);
    setCatalogRefreshing(false);
    lastDefaultFullscreenFillKeyRef.current = null;
    floatingResizeRef.current = null;
    surfacePointersRef.current.clear();
    surfaceGestureRef.current = null;
    surfacePinchStartRef.current = null;
    bitratePresetTouchedRef.current = false;
    setScreenshotStatus({ phase: 'idle' });
    lastAutoFullscreenImePanRef.current = null;
    activeHandoffRef.current = null;
    handoffVideoVisibilityRef.current = null;
    streamRequestEpochRef.current += 1;
    thumbnailInFlightTargetIdsRef.current.clear();
    if (activeSessionId && stopStream) {
      const streamIdsToStop = new Set<string>();
      if (state.phase === 'targetLocked' && state.streamId) {
        streamIdsToStop.add(state.streamId);
      }
      if (activeCanvasStreamIdRef.current) {
        streamIdsToStop.add(activeCanvasStreamIdRef.current);
      }
      if (activeFocusStreamIdRef.current) {
        streamIdsToStop.add(activeFocusStreamIdRef.current);
      }
      if (pendingFocusStreamIdRef.current) {
        streamIdsToStop.add(pendingFocusStreamIdRef.current);
      }
      streamIdsToStop.forEach((streamId) => {
        void Promise.resolve(stopStream(activeSessionId, streamId)).catch((error) => {
          console.error('[RemoteWindowOverlay] remote stream stop failed:', error);
        });
      });
    }
    activeStreamIdRef.current = null;
    activeCanvasStreamIdRef.current = null;
    activeFocusStreamIdRef.current = null;
    pendingFocusStreamIdRef.current = null;
    collectStreamStatsRef.current = null;
    adaptiveVideoStateRef.current = null;
    lastAppliedStreamQualityKeyRef.current = null;
    setReceiverMediaStream(null);
    setOverviewMediaStream(null);
    setReceiverFrameSize(null);
    setWindowThumbnails({});
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
    resetFullscreenViewport,
    setFloatingOffset,
    setFloatingOverlayWidthPx,
    setFullscreenDisplayMode,
    state,
    stopStream,
    setWindowThumbnails,
  ]);

  useEffect(() => {
    if (appForegroundActive !== false || state.phase === 'closed') {
      return;
    }
    lastReportedBodySuppressionRef.current = false;
    onBodySubscriptionSuppressedChange?.(false);
    handleClose();
  }, [appForegroundActive, handleClose, onBodySubscriptionSuppressedChange, state.phase]);

  useEffect(() => {
    if (
      !streamInvalidation
      || state.phase !== 'targetLocked'
      || !currentLockedStreamId
      || currentLockedStreamId !== streamInvalidation.streamId
    ) {
      return;
    }
    activeStreamIdRef.current = null;
    if (streamInvalidation.streamId === activeCanvasStreamIdRef.current) {
      activeCanvasStreamIdRef.current = null;
    }
    if (streamInvalidation.streamId === activeFocusStreamIdRef.current) {
      activeFocusStreamIdRef.current = null;
    }
    if (streamInvalidation.streamId === pendingFocusStreamIdRef.current) {
      pendingFocusStreamIdRef.current = null;
    }
    collectStreamStatsRef.current = null;
    adaptiveVideoStateRef.current = null;
    lastAppliedStreamQualityKeyRef.current = null;
    surfacePointersRef.current.clear();
    surfaceGestureRef.current = null;
    surfacePinchStartRef.current = null;
    setReceiverMediaStream(null);
    setOverviewMediaStream(null);
    setReceiverFrameSize(null);
    setState((current) => failRemoteWindowStream(
      current,
      streamInvalidation.streamId,
      new Error(streamInvalidation.message || 'remote window stream is no longer active'),
    ));
  }, [currentLockedStreamId, state.phase, streamInvalidation]);

  const publishRemoteWindowInputContext = useCallback(() => {
    if (!inputContext) {
      return;
    }
    lastReportedInputContextKeyRef.current = inputContextKey;
    onInputContextChange?.(inputContext);
  }, [inputContext, inputContextKey, onInputContextChange]);

  const handleShrink = useCallback(() => {
    lastDefaultFullscreenFillKeyRef.current = null;
    resetFullscreenViewport();
    setState((current) => shrinkRemoteWindowOverlay(current));
  }, [resetFullscreenViewport]);

  const handleFullscreen = useCallback(() => {
    publishRemoteWindowInputContext();
    lastDefaultFullscreenFillKeyRef.current = null;
    resetFullscreenViewport();
    setState((current) => enterRemoteWindowFullscreen(current));
  }, [publishRemoteWindowInputContext, resetFullscreenViewport]);

  const handleRequestKeyboard = useCallback(() => {
    publishRemoteWindowInputContext();
    onRequestKeyboard?.();
  }, [onRequestKeyboard, publishRemoteWindowInputContext]);

  const requestFullscreenFillResize = useCallback(() => {
    if (
      state.phase === 'targetLocked'
      && state.streamId
      && activeSessionId
    ) {
      const fillReferenceSize = resolveRemoteWindowFullscreenFillReferenceSize({
        overlay: floatingOverlayRef.current,
        toolbar: lockedToolbarRef.current,
        surface: videoSurfaceRef.current,
        fallbackSurfaceSize: surfaceSize,
      });
      if (fillReferenceSize && fillReferenceSize.width > 0 && fillReferenceSize.height > 0) {
        const currentWindowWidth = state.target.videoTarget.windowBoundsTopLeftPx.width
          || getRemoteWindowSourceRect(state.target).width;
        const requestedWidth = Math.round(Math.max(120, currentWindowWidth));
        const requestedHeight = Math.round(Math.max(
          120,
          requestedWidth * (fillReferenceSize.height / fillReferenceSize.width),
        ));
        const currentWindowHeight = state.target.videoTarget.windowBoundsTopLeftPx.height
          || getRemoteWindowSourceRect(state.target).height;
        if (
          Math.abs(currentWindowWidth - requestedWidth) <= 1
          && Math.abs(currentWindowHeight - requestedHeight) <= 1
        ) {
          onInputDebug?.({
            source: 'overlay',
            sent: false,
            sessionId: activeSessionId,
            streamId: state.streamId,
            targetId: state.target.streamTargetId,
            targetTitle: state.target.videoTarget.title || state.target.videoTarget.appBundleId || null,
            event: {
              kind: 'window-resize',
              width: requestedWidth,
              height: requestedHeight,
            },
          });
          return true;
        }
        const eventPayload: RemoteWindowInputEventPayload['event'] = {
          kind: 'window-resize',
          width: requestedWidth,
          height: requestedHeight,
        };
        resizeTargetWindow?.(activeSessionId, {
          streamId: state.streamId,
          targetId: state.target.streamTargetId,
          event: eventPayload,
        });
        onInputDebug?.({
          source: 'overlay',
          sent: Boolean(resizeTargetWindow),
          sessionId: activeSessionId,
          streamId: state.streamId,
          targetId: state.target.streamTargetId,
          targetTitle: state.target.videoTarget.title || state.target.videoTarget.appBundleId || null,
          event: eventPayload,
        });
        return true;
      }
    }
    return false;
  }, [
    activeSessionId,
    onInputDebug,
    resizeTargetWindow,
    state,
    surfaceSize,
  ]);

  const handleToggleFullscreenDisplayMode = useCallback(() => {
    requestFullscreenFillResize();
    resetFullscreenViewport();
    setFullscreenDisplayMode(initialFullscreenDisplayMode);
  }, [
    requestFullscreenFillResize,
    resetFullscreenViewport,
    setFullscreenDisplayMode,
  ]);

  useEffect(() => {
    if (
      state.phase !== 'targetLocked'
      || state.mode !== 'fullscreen'
      || !state.streamId
      || !activeSessionId
      || !surfaceSize
      || fullscreenDisplayMode !== 'fill'
    ) {
      return;
    }
    const key = [
      state.streamId,
      state.target.streamTargetId,
      Math.round(surfaceSize.width),
      Math.round(surfaceSize.height),
      Math.round(state.target.videoTarget.windowBoundsTopLeftPx.width || getRemoteWindowSourceRect(state.target).width),
      Math.round(state.target.videoTarget.windowBoundsTopLeftPx.height || getRemoteWindowSourceRect(state.target).height),
    ].join('|');
    if (lastDefaultFullscreenFillKeyRef.current === key) {
      return;
    }
    if (requestFullscreenFillResize()) {
      lastDefaultFullscreenFillKeyRef.current = key;
    }
  }, [
    activeSessionId,
    fullscreenDisplayMode,
    requestFullscreenFillResize,
    state,
    surfaceSize,
  ]);

  const handleToggleInputMode = useCallback(() => {
    setInputMode((current) => {
      const next: RemoteWindowInputMode = current === 'touch' ? 'mouse' : 'touch';
      inputModeRef.current = next;
      writeRemoteWindowInputMode(next);
      return next;
    });
  }, []);

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
      || activeFocusStreamIdRef.current !== state.streamId
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
      || activeFocusStreamIdRef.current !== state.streamId
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
    const displaySourceSize = resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize, focusedWindowSlotRef.current);
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

  const updateReceiverVideoVisibility = useCallback((visible: boolean) => {
    videoHasPlayedRef.current = visible;
    setVideoHasPlayedState(visible);
  }, []);

  const publishVideoDebugSnapshot = useCallback((lastEvent: string, options?: { visible?: boolean; error?: string }) => {
    const video = videoElementRef.current;
    const stats = videoPlaybackStatsRef.current;
    if (options?.error) {
      stats.lastError = options.error;
    }
    const snapshot = {
      attached: Boolean(video && receiverMediaStream && video.srcObject === receiverMediaStream),
      visible: options?.visible ?? videoHasPlayedRef.current,
      readyState: video?.readyState ?? 0,
      paused: video?.paused ?? true,
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      playAttempts: stats.playAttempts,
      playAccepted: stats.playAccepted,
      playRejected: stats.playRejected,
      framesReceived: stats.framesReceived,
      lastEvent,
      lastError: stats.lastError,
      updatedAt: Date.now(),
    };
    setVideoDebugSnapshot(snapshot);
    onVideoDebug?.(snapshot);
  }, [onVideoDebug, receiverMediaStream]);

  const revealReceiverVideo = useCallback((
    video: HTMLVideoElement,
    stream: MediaStream,
    playbackEpoch: number,
    lastEvent = 'playing',
  ) => {
    // P5 探针：reveal 入口 + guard 各项命中
    const probeBinding = receiverPlaybackBindingRef.current;
    // eslint-disable-next-line no-console
    console.log(
      `[remote-window-reveal] lastEvent=${lastEvent} ` +
      `epoch_in=${playbackEpoch} epoch_cur=${receiverPlaybackEpochRef.current} ` +
      `epoch_match=${receiverPlaybackEpochRef.current === playbackEpoch} ` +
      `binding_epoch=${probeBinding?.epoch ?? '-'} binding_match=${probeBinding?.epoch === playbackEpoch} ` +
      `binding_stream_match=${probeBinding?.stream === stream} ` +
      `video_ref_match=${videoElementRef.current === video} ` +
      `srcObject_match=${video.srcObject === stream}`,
    );
    const binding = receiverPlaybackBindingRef.current;
    if (
      receiverPlaybackEpochRef.current !== playbackEpoch
      || binding?.epoch !== playbackEpoch
      || binding.stream !== stream
      || videoElementRef.current !== video
      || video.srcObject !== stream
    ) {
      return;
    }
    updateReceiverVideoVisibility(true);
    publishVideoDebugSnapshot(lastEvent, { visible: true });
  }, [publishVideoDebugSnapshot, updateReceiverVideoVisibility]);

  const scheduleVideoFrameReveal = useCallback((
    video: HTMLVideoElement,
    stream: MediaStream,
    playbackEpoch: number,
  ) => {
    const videoWithFrameCallback = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    if (typeof videoWithFrameCallback.requestVideoFrameCallback !== 'function') {
      return false;
    }
    videoWithFrameCallback.requestVideoFrameCallback(() => {
      revealReceiverVideo(video, stream, playbackEpoch, 'frame');
    });
    return true;
  }, [revealReceiverVideo]);

  const requestVideoPlayback = useCallback((stream: MediaStream, playbackEpoch: number) => {
    const video = videoElementRef.current;
    if (!video) {
      publishVideoDebugSnapshot('play-missing-video');
      return;
    }
    video.autoplay = true;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.controls = false;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    // 帧接收诊断：requestVideoFrameCallback 每帧回调（WebView 支持时）
    const rvfc = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number })
      .requestVideoFrameCallback;
    if (typeof rvfc === 'function' && !videoFrameCallbackRef.current) {
      const onVideoFrame = () => {
        videoPlaybackStatsRef.current.framesReceived += 1;
        const received = videoPlaybackStatsRef.current.framesReceived;
        if (received === 1 || received % 60 === 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[remote-window] client framesReceived=${received} ` +
            `video=${video.videoWidth}x${video.videoHeight} ` +
            `paused=${video.paused} readyState=${video.readyState} ` +
            `seeking=${video.seeking} currentTime=${video.currentTime.toFixed(3)}`,
          );
          publishVideoDebugSnapshot('frame-callback');
        }
        if ((video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number) => void) => number }).requestVideoFrameCallback) {
          (video as HTMLVideoElement & { requestVideoFrameCallback: (cb: (now: number) => void) => number }).requestVideoFrameCallback(onVideoFrame);
        }
      };
      videoFrameCallbackRef.current = onVideoFrame;
      (video as HTMLVideoElement & { requestVideoFrameCallback: (cb: (now: number) => void) => number }).requestVideoFrameCallback(onVideoFrame);
    }
    scheduleVideoFrameReveal(video, stream, playbackEpoch);
    videoPlaybackStatsRef.current.playAttempts += 1;
    // P3 探针：requestVideoPlayback 入口
    // eslint-disable-next-line no-console
    console.log(
      `[remote-window-playback] enter play_attempt=${videoPlaybackStatsRef.current.playAttempts} ` +
      `srcObject_equal=${video.srcObject === stream} ` +
      `paused=${video.paused} readyState=${video.readyState} ` +
      `seeking=${video.seeking} currentTime=${video.currentTime.toFixed(3)} ` +
      `epoch=${playbackEpoch}`,
    );
    publishVideoDebugSnapshot('play-request');
    const playResult = typeof video.play === 'function' ? video.play() : null;
    if (playResult && typeof playResult.then === 'function') {
      playResult
        .then(() => {
          videoPlaybackStatsRef.current.playAccepted += 1;
          revealReceiverVideo(video, stream, playbackEpoch, 'play-resolved');
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error || 'play rejected');
          videoPlaybackStatsRef.current.playRejected += 1;
          publishVideoDebugSnapshot('play-rejected', { error: message });
        });
      return;
    }
    publishVideoDebugSnapshot('play-sync-pending');
  }, [publishVideoDebugSnapshot, revealReceiverVideo, scheduleVideoFrameReveal]);

  const requestBoundVideoPlayback = useCallback(() => {
    const binding = receiverPlaybackBindingRef.current;
    if (!binding) {
      publishVideoDebugSnapshot('play-missing-binding');
      return;
    }
    requestVideoPlayback(binding.stream, binding.epoch);
  }, [publishVideoDebugSnapshot, requestVideoPlayback]);

  const restoreRetainedReceiverPlayback = useCallback((visible: boolean) => {
    const playbackEpoch = receiverPlaybackEpochRef.current;
    receiverPlaybackBindingRef.current = receiverMediaStream
      ? { epoch: playbackEpoch, stream: receiverMediaStream }
      : null;
    updateReceiverVideoVisibility(visible);
    if (!visible && receiverMediaStream) {
      requestVideoPlayback(receiverMediaStream, playbackEpoch);
    }
  }, [receiverMediaStream, requestVideoPlayback, updateReceiverVideoVisibility]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (updateFloatingResizeFromPointer(event.pointerId, event.clientX, event.clientY)) {
        event.preventDefault();
      }
    };
    const handlePointerEnd = (event: PointerEvent) => {
      finishFloatingResize(event.pointerId);
    };
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      floatingResizeRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [
    finishFloatingResize,
    updateFloatingResizeFromPointer,
  ]);

  useEffect(() => {
    const video = videoElementRef.current;
    if (!video) {
      return;
    }
    const playbackEpoch = ++receiverPlaybackEpochRef.current;
    updateReceiverVideoVisibility(false);
    videoPlaybackStatsRef.current = {
      playAttempts: 0,
      playAccepted: 0,
      playRejected: 0,
      framesReceived: 0,
      lastError: '-',
    };
    if (!receiverMediaStream) {
      receiverPlaybackBindingRef.current = null;
      return;
    }
    receiverPlaybackBindingRef.current = { epoch: playbackEpoch, stream: receiverMediaStream };
    // P2 探针：MediaStream track.readyState 序列
    const probeTracks = typeof receiverMediaStream.getTracks === 'function'
      ? receiverMediaStream.getTracks()
      : [];
    // eslint-disable-next-line no-console
    console.log(
      `[remote-window-tracks] epoch=${playbackEpoch} ` +
      `tracks=${probeTracks.length} ` +
      `kinds=${probeTracks.map((t: MediaStreamTrack) => `${t.kind}:${t.readyState}:${t.muted ? 'muted' : 'live'}`).join(',') || 'no-tracks-api'}`,
    );
    // 设计 v2 fix：sibling handoff 时清除旧的 videoFrameCallbackRef，
    // 否则 requestVideoPlayback 内的 rVFC 重挂守卫会跳过，
    // video element 仍持有指向旧 MediaStream 的解码回调。
    // logcat 证据：epoch 2→3 后 rVFC 未重挂，video 卡在 currentTime=0.000/0.543。
    videoFrameCallbackRef.current = null;
    requestVideoPlayback(receiverMediaStream, playbackEpoch);
    const fallbackTimer = window.setInterval(() => {
      if (videoElementRef.current?.srcObject === receiverMediaStream) {
        publishVideoDebugSnapshot('play-poll');
      }
    }, 350);
    const stopTimer = window.setTimeout(() => {
      window.clearInterval(fallbackTimer);
    }, 5000);
    return () => {
      window.clearInterval(fallbackTimer);
      window.clearTimeout(stopTimer);
    };
  }, [publishVideoDebugSnapshot, receiverMediaStream, requestVideoPlayback, updateReceiverVideoVisibility]);

  useEffect(() => {
    const overviewVideo = overviewVideoElementRef.current;
    if (overviewVideo && overviewMediaStream) {
      overviewVideo.autoplay = true;
      overviewVideo.muted = true;
      overviewVideo.defaultMuted = true;
      overviewVideo.playsInline = true;
      overviewVideo.controls = false;
      if (overviewVideo.srcObject !== overviewMediaStream) {
        overviewVideo.srcObject = overviewMediaStream;
      }
    }
  }, [overviewMediaStream]);

  // 每秒采样 live 诊断：状态浮窗 + logcat（区分 WebRTC 收帧停止 vs video 解码冻结）
  const lockedStreamStatus = state.phase === 'targetLocked' ? state.streamStatus : null;
  const lockedStreamId = state.phase === 'targetLocked' ? state.streamId ?? null : null;
  useEffect(() => {
    if (lockedStreamStatus !== 'streaming' || !receiverMediaStream) {
      return;
    }
    const timer = window.setInterval(() => {
      const video = videoElementRef.current;
      const track = typeof receiverMediaStream.getTracks === 'function'
        ? receiverMediaStream.getTracks()[0]
        : undefined;
      const next: RemoteWindowLiveDiagnostics = {
        sampledAt: Date.now(),
        currentTime: video?.currentTime ?? -1,
        paused: video?.paused ?? true,
        readyState: video?.readyState ?? -1,
        videoWidth: video?.videoWidth ?? 0,
        videoHeight: video?.videoHeight ?? 0,
        framesReceived: videoPlaybackStatsRef.current.framesReceived,
        trackState: track?.readyState ?? 'none',
        trackMuted: track?.muted ?? false,
        epoch: receiverPlaybackEpochRef.current,
        streamId: lockedStreamId,
      };
      setLiveDiag(next);
      // eslint-disable-next-line no-console
      console.log(`[remote-window-live] ${JSON.stringify(next)}`);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [lockedStreamId, lockedStreamStatus, receiverMediaStream, state.phase]);

  useEffect(() => {
    if (lastReportedQuickBarSuppressionRef.current === quickBarSuppressed) {
      return;
    }
    lastReportedQuickBarSuppressionRef.current = quickBarSuppressed;
    onOpenStateChange?.(quickBarSuppressed);
  }, [onOpenStateChange, quickBarSuppressed]);

  // 组合推流：rAF 绘制总览横条 + 子窗口缩略图（共享同一 video 源，逐帧 drawImage）
  useEffect(() => {
    if (!compositeLayout || !receiverMediaStream) {
      return;
    }
    let raf = 0;
    const draw = () => {
      raf = window.requestAnimationFrame(draw);
      // 双流：总览预览从低码率 overview video 绘制；单流回退主 video
      const video = overviewVideoElementRef.current && overviewVideoElementRef.current.readyState >= 2
        ? overviewVideoElementRef.current
        : videoElementRef.current;
      if (!video || video.readyState < 2 || video.videoWidth <= 0) {
        return;
      }
      const overview = compositeOverviewCanvasRef.current;
      if (overview) {
        const ctx = overview.getContext('2d');
        if (ctx && overview.width > 0 && overview.height > 0) {
          ctx.drawImage(
            video,
            0,
            0,
            compositeLayout.canvasWidth,
            compositeLayout.canvasHeight,
            0,
            0,
            overview.width,
            overview.height,
          );
        }
      }
      for (const slot of compositeLayout.windows) {
        const thumb = compositeThumbCanvasRefs.current.get(slot.windowId);
        if (thumb && thumb.width > 0 && thumb.height > 0) {
          const ctx = thumb.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, thumb.width, thumb.height);
            // contain：保持窗口比例完整显示（居中，多余空间留黑边），避免拉伸变形/显示不全
            const scale = Math.min(
              thumb.width / Math.max(1, slot.width),
              thumb.height / Math.max(1, slot.height),
            );
            const drawW = slot.width * scale;
            const drawH = slot.height * scale;
            ctx.drawImage(
              video,
              slot.offsetX,
              slot.offsetY,
              slot.width,
              slot.height,
              (thumb.width - drawW) / 2,
              (thumb.height - drawH) / 2,
              drawW,
              drawH,
            );
          }
        }
      }
    };
    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, [compositeLayout, receiverMediaStream]);

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

  useEffect(() => {
    if (!onRemoteWindowMessage) {
      return undefined;
    }
    return onRemoteWindowMessage((msg) => {
      if (msg.type !== 'remote-window-input-result' || msg.payload.accepted !== true) {
        return;
      }
      if (msg.payload.streamId !== activeStreamIdRef.current) {
        return;
      }
      if (msg.payload.capture) {
        setReceiverFrameSize({
          width: msg.payload.capture.frameWidth,
          height: msg.payload.capture.frameHeight,
        });
        resetFullscreenViewport();
      }
      if (msg.payload.target) {
        const targetSessionId = activeSessionId?.trim() || '';
        if (targetSessionId) {
          rememberRemoteWindowCatalogTarget(
            targetSessionId,
            msg.payload.target as RemoteWindowStreamTargetManifest,
          );
        }
        setState((current) => applyRemoteWindowInputResultTarget(
          current,
          msg.payload.streamId,
          msg.payload.targetId,
          msg.payload.target as RemoteWindowStreamTargetManifest,
        ));
      }
    });
  }, [activeSessionId, onRemoteWindowMessage, rememberRemoteWindowCatalogTarget, resetFullscreenViewport]);

  useEffect(() => {
    if (
      state.phase !== 'targetLocked'
      || !state.streamStarted
      || !state.streamId
      || !activeSessionId
      || !requestTargets
      || (
        state.streamId === activeCanvasStreamIdRef.current
        && pendingFocusStreamIdRef.current !== null
      )
    ) {
      return undefined;
    }
    const targetSessionId = activeSessionId.trim();
    let disposed = false;
    let inFlight = false;
    const refreshActiveCatalog = () => {
      if (disposed || inFlight) {
        return;
      }
      inFlight = true;
      void requestTargets(targetSessionId, { forceRefresh: true })
        .then((payload) => {
          if (disposed) {
            return;
          }
          applyRemoteWindowActiveCatalogPayload(targetSessionId, payload);
        })
        .catch((error) => {
          if (disposed) {
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          setActiveCatalogSyncError(message);
          console.warn('[RemoteWindowOverlay] active remote window catalog sync failed:', error);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    refreshActiveCatalog();
    const intervalId = window.setInterval(
      refreshActiveCatalog,
      REMOTE_WINDOW_ACTIVE_CATALOG_SYNC_INTERVAL_MS,
    );
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [
    activeSessionId,
    applyRemoteWindowActiveCatalogPayload,
    requestTargets,
    state.phase,
    state.phase === 'targetLocked' ? state.streamId : null,
    state.phase === 'targetLocked' ? state.streamStarted : false,
  ]);

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
    const streamRequestEpoch = ++streamRequestEpochRef.current;
    receiverPlaybackEpochRef.current += 1;
    const previousStreamId = state.phase === 'targetLocked' && state.streamStarted ? state.streamId || null : null;
    const previousHadStream = Boolean(previousStreamId);
    const previousVideoWasVisible = previousHadStream
      ? handoffVideoVisibilityRef.current ?? videoHasPlayedRef.current
      : videoHasPlayedRef.current;
    setAppSwitchOpen(false);
    setActiveCatalogSyncError(null);
    if (!previousHadStream) {
      lastDefaultFullscreenFillKeyRef.current = null;
      setFloatingOffset({ x: 0, y: 0 });
      setFloatingOverlayWidthPx(null);
      lastAppliedStreamQualityKeyRef.current = null;
      bitratePresetTouchedRef.current = false;
      lastAutoFullscreenImePanRef.current = null;
      setScreenshotStatus({ phase: 'idle' });
      resetFullscreenViewport();
      setFullscreenDisplayMode(initialFullscreenDisplayMode);
      setReceiverMediaStream(null);
      setOverviewMediaStream(null);
    setOverviewMediaStream(null);
      setReceiverFrameSize(null);
    }
    // Every target change starts a new receiver lifecycle. Keep the browser's
    // native video placeholder hidden until this receiver has a real frame.
    updateReceiverVideoVisibility(false);
    const selectedBitratePreset = readRemoteWindowVideoBitratePreset(target);
    if (!previousHadStream) {
      setBitratePreset(selectedBitratePreset);
    }
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
    const requestSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const canvasStreamId = `rw-stream-canvas-${requestSuffix}`;
    const focusStreamId = `rw-stream-focus-${requestSuffix}`;
    pendingFocusStreamIdRef.current = focusStreamId;
    const previousCanvasStreamId = activeCanvasStreamIdRef.current;
    const previousFocusStreamId = activeFocusStreamIdRef.current;
    const canvasBitrate = buildRemoteWindowVideoBitrateConfig('2mbps');
    const startingState = (current: RemoteWindowOverlayState) => beginRemoteWindowStreamSetup(
      selectRemoteWindowTarget(current, target.streamTargetId),
      canvasStreamId,
    );
    const stopStaleStream = (streamIdToStop: string, replacementStreamId: string) => {
      if (!stopStream || streamIdToStop === replacementStreamId) {
        return;
      }
      void Promise.resolve(stopStream(targetSessionId, streamIdToStop)).catch((error) => {
        setState((current) => failRemoteWindowStreamCleanup(
          current,
          streamIdToStop,
          replacementStreamId,
          error,
        ));
      });
    };
    const stopInactiveStartedStream = (streamIdToStop: string) => {
      stopStaleStream(streamIdToStop, activeStreamIdRef.current || '');
    };

    if (!targetSessionId) {
      if (pendingFocusStreamIdRef.current === focusStreamId) {
        pendingFocusStreamIdRef.current = null;
      }
      const error = new Error('当前没有可用的 daemon session');
      if (previousStreamId) {
        const handoff: RemoteWindowStreamHandoffState = {
          epoch: ++handoffEpochRef.current,
          previousStreamId,
          pendingStreamId: focusStreamId,
          acceptedStreamIds: [canvasStreamId, focusStreamId],
          targetId: target.streamTargetId,
          status: 'starting',
        };
        setState((current) => failRemoteWindowStreamHandoff(
          beginRemoteWindowStreamHandoff(current, handoff),
          handoff,
          error,
        ));
        restoreRetainedReceiverPlayback(previousVideoWasVisible);
        handoffVideoVisibilityRef.current = null;
      } else {
        activeStreamIdRef.current = canvasStreamId;
        setState((current) => failRemoteWindowStream(startingState(current), canvasStreamId, error));
      }
      return;
    }

    const handoff = previousStreamId
      ? {
          epoch: ++handoffEpochRef.current,
          previousStreamId,
          pendingStreamId: focusStreamId,
          acceptedStreamIds: [canvasStreamId, focusStreamId],
          targetId: target.streamTargetId,
          status: 'starting' as const,
        }
      : null;
    if (handoff) {
      handoffVideoVisibilityRef.current = previousVideoWasVisible;
      activeHandoffRef.current = handoff;
      setState((current) => beginRemoteWindowStreamHandoff(current, handoff));
    } else {
      activeStreamIdRef.current = canvasStreamId;
      activeCanvasStreamIdRef.current = canvasStreamId;
      activeFocusStreamIdRef.current = null;
      lastAppliedStreamQualityKeyRef.current = [
        targetSessionId,
        canvasStreamId,
        target.streamTargetId,
        'preview',
        canvasBitrate.maxBitrateBps,
        canvasBitrate.maxFrameRateFps ?? '',
      ].join('|');
      setState(startingState);
    }
    // 单流模式：只开 focus 流，不启动 canvas 预览流。
    // Android WebView 同时接收 canvas+focus 双 WebRTC 流时，focus 会被饿死只渲染首帧（真机 logcat：tracks live 但 currentTime 定住），
    // 且 canvas→focus 的 srcObject 切换本身就有黑屏闪一下。单流从根上消除两者。
    void startStream(targetSessionId, target, focusStreamId, {
      videoBitrate,
      purpose: 'focus',
    })
      .then((focusResult) => {
        return { canvasResult: null, focusResult, focusError: null };
      })
      .then((dualResult) => {
        if (!dualResult) {
          return;
        }
        const { focusResult } = dualResult;
        const committedStreamId = focusResult?.streamId ?? '';
        const committedResult = focusResult;
        if (pendingFocusStreamIdRef.current === focusStreamId) {
          pendingFocusStreamIdRef.current = null;
        }
        if (handoff) {
          if (
            activeHandoffRef.current?.epoch !== handoff.epoch
            || activeHandoffRef.current.pendingStreamId !== handoff.pendingStreamId
          ) {
            if (focusResult) {
              stopInactiveStartedStream(focusResult.streamId);
            }
            return;
          }
          activeHandoffRef.current = null;
          handoffVideoVisibilityRef.current = null;
          activeStreamIdRef.current = committedStreamId;
          activeCanvasStreamIdRef.current = null;
          activeFocusStreamIdRef.current = focusResult?.streamId || null;
          lastDefaultFullscreenFillKeyRef.current = null;
          lastAppliedStreamQualityKeyRef.current = [
            targetSessionId,
            committedStreamId,
            target.streamTargetId,
            focusResult ? adaptiveStartBitratePreset : 'preview',
            focusResult ? videoBitrate.maxBitrateBps : canvasBitrate.maxBitrateBps,
            (focusResult ? videoBitrate.maxFrameRateFps : canvasBitrate.maxFrameRateFps) ?? '',
          ].join('|');
          bitratePresetTouchedRef.current = false;
          lastAutoFullscreenImePanRef.current = null;
          setScreenshotStatus({ phase: 'idle' });
          resetFullscreenViewport();
          setFullscreenDisplayMode(initialFullscreenDisplayMode);
          setBitratePreset(selectedBitratePreset);
          setState((current) => commitRemoteWindowStreamHandoff(current, handoff, committedStreamId));
        } else {
          if (
            streamRequestEpochRef.current !== streamRequestEpoch
            || (
              focusResult
              && pendingFocusStreamIdRef.current !== null
              && pendingFocusStreamIdRef.current !== focusResult.streamId
            )
          ) {
            if (focusResult) {
              stopInactiveStartedStream(focusResult.streamId);
            }
            return;
          }
          activeStreamIdRef.current = committedStreamId;
          activeCanvasStreamIdRef.current = null;
          activeFocusStreamIdRef.current = focusResult?.streamId || null;
          lastAppliedStreamQualityKeyRef.current = [
            targetSessionId,
            focusResult.streamId,
            target.streamTargetId,
            adaptiveStartBitratePreset,
            videoBitrate.maxBitrateBps,
            videoBitrate.maxFrameRateFps ?? '',
          ].join('|');
          setState((current) => attachRemoteWindowStreamReceiver(
            beginRemoteWindowStreamSetup(current, focusResult.streamId),
            focusResult.streamId,
          ));
        }
        if (activeStreamIdRef.current === committedStreamId) {
          // 同一批次同步隐藏 video：srcObject 切换瞬间 video 内容会清空，
          // 不等 useEffect 再隐藏（否则有一帧 video 空白露出来 = 黑屏闪一下）
          updateReceiverVideoVisibility(false);
          setReceiverMediaStream(committedResult.mediaStream || null);
          setOverviewMediaStream(committedResult.overviewMediaStream || null);
          setReceiverFrameSize(resolveStartedCaptureFrameSize(committedResult.started));
          collectStreamStatsRef.current = typeof committedResult.collectStats === 'function' ? committedResult.collectStats : null;
        }
        if (handoff) {
          stopStaleStream(handoff.previousStreamId, committedStreamId);
          if (previousCanvasStreamId) {
            stopStaleStream(previousCanvasStreamId, committedStreamId);
          }
          if (previousFocusStreamId) {
            stopStaleStream(previousFocusStreamId, committedStreamId);
          }
        }
      })
      .catch((error) => {
        if (handoff) {
          if (
            activeHandoffRef.current?.epoch === handoff.epoch
            && activeHandoffRef.current.pendingStreamId === handoff.pendingStreamId
          ) {
            activeHandoffRef.current = null;
            activeStreamIdRef.current = handoff.previousStreamId;
            restoreRetainedReceiverPlayback(previousVideoWasVisible);
            handoffVideoVisibilityRef.current = null;
            if (pendingFocusStreamIdRef.current === focusStreamId) {
              pendingFocusStreamIdRef.current = null;
            }
            setState((current) => failRemoteWindowStreamHandoff(current, handoff, error));
          }
          return;
        }
        setReceiverMediaStream(null);
      setOverviewMediaStream(null);
    setOverviewMediaStream(null);
        setReceiverFrameSize(null);
        updateReceiverVideoVisibility(false);
        collectStreamStatsRef.current = null;
        adaptiveVideoStateRef.current = null;
        activeCanvasStreamIdRef.current = null;
        activeFocusStreamIdRef.current = null;
        if (pendingFocusStreamIdRef.current === focusStreamId) {
          pendingFocusStreamIdRef.current = null;
        }
        setState((current) => failRemoteWindowStream(startingState(current), canvasStreamId, error));
      });
  }, [
    activeSessionId,
    networkQuality,
    resetFullscreenViewport,
    setFloatingOffset,
    setFloatingOverlayWidthPx,
    setFullscreenDisplayMode,
    startStream,
    state,
    stopStream,
    restoreRetainedReceiverPlayback,
    updateReceiverVideoVisibility,
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
    void requestScreenshot(targetSessionId, target, { persist: true })
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
    const displaySourceSize = resolveRemoteWindowDisplaySourceSize(
      state.target,
      receiverFrameSize,
      compositeLayout ? focusedWindowSlot : null,
    );
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
      sourceRect: (() => {
        const base = getRemoteWindowSourceRect(state.target);
        if (compositeLayout) {
          if (focusedWindowSlot) {
            if (overviewMediaStream) {
              // 双流：主画面直接显示 focus 流（窗口全分辨率），触点映射到窗口屏幕坐标
              const compositeWindow = (state.target.compositeWindows ?? []).find(
                (item) => item.windowId === focusedWindowSlot.windowId,
              );
              const windowRect = compositeWindow?.windowBoundsTopLeftPx
                || (focusedWindowSlot.windowId === state.target.videoTarget.windowId
                  ? state.target.videoTarget.windowBoundsTopLeftPx
                  : null);
              if (windowRect) {
                return {
                  x: windowRect.x,
                  y: windowRect.y,
                  width: windowRect.width,
                  height: windowRect.height,
                };
              }
            }
            // 焦点窗口：主画面显示该窗口区域，触点映射到画布内该窗口坐标
            return {
              x: base.x + focusedWindowSlot.offsetX,
              y: base.y + focusedWindowSlot.offsetY,
              width: focusedWindowSlot.width,
              height: focusedWindowSlot.height,
            };
          }
          return {
            x: base.x,
            y: base.y,
            width: displaySourceSize.width,
            height: displaySourceSize.height,
          };
        }
        return base;
      })(),
    };
  }, [compositeLayout, focusedWindowSlot, overviewMediaStream, receiverFrameSize, state]);

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

  const emitRemoteWindowActionInput = useCallback((
    eventPayload: RemoteWindowInputEventPayload['event'],
  ) => {
    return dispatchRemoteWindowInputEvents([eventPayload]);
  }, [dispatchRemoteWindowInputEvents]);

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
      return;
    }
    if (effect.kind === 'pinch-start') {
      surfacePinchStartRef.current = {
        pointerId: effect.pointerId,
        startScale: fullscreenViewportRef.current.scale,
      };
      return;
    }
    if (effect.kind === 'pinch-move') {
      // 保护：只有真正双指在场时才应用缩放；单指滑动（残留手势/指针误判）不得改变 scale
      if (surfacePointersRef.current.size < 2) {
        surfacePinchStartRef.current = null;
        return;
      }
      const currentScale = fullscreenViewportRef.current.scale;
      const start = effect.commit || surfacePinchStartRef.current?.pointerId !== effect.pointerId
        ? { pointerId: effect.pointerId, startScale: currentScale }
        : surfacePinchStartRef.current;
      surfacePinchStartRef.current = start;
      const nextScale = clampNumber(
        start.startScale * effect.scaleRatio,
        REMOTE_WINDOW_FULLSCREEN_MIN_SCALE,
        REMOTE_WINDOW_FULLSCREEN_MAX_SCALE,
      );
      const surfaceRect = videoSurfaceRef.current?.getBoundingClientRect();
      if (
        state.phase === 'targetLocked'
        && state.mode === 'fullscreen'
        && surfaceRect
        && surfaceRect.width > 0
        && surfaceRect.height > 0
      ) {
        const displaySourceSize = resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize, focusedWindowSlotRef.current);
        setFullscreenViewport((current) => resolveAnchoredFullscreenViewportScale({
          surface: { width: surfaceRect.width, height: surfaceRect.height },
          source: displaySourceSize,
          current,
          nextScale,
          anchorClientX: effect.anchorClientX,
          anchorClientY: effect.anchorClientY,
          surfaceLeft: surfaceRect.left,
          surfaceTop: surfaceRect.top,
          displayMode: fullscreenDisplayModeRef.current,
          keyboardPanAllowancePx: Math.max(0, bottomInsetPx),
        }));
        return;
      }
      setFullscreenViewport((current) => ({
        ...current,
        scale: nextScale,
      }));
      return;
    }
    if (effect.kind === 'pinch-end') {
      surfacePinchStartRef.current = null;
    }
  }, [bottomInsetPx, receiverFrameSize, setFullscreenViewport, state]);

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

  const handleLongPressTimer = useCallback(() => {
    longPressTimerRef.current = null;
    const gesture = surfaceGestureRef.current;
    if (!gesture || inputModeRef.current !== 'touch') {
      return;
    }
    if (gesture.mode === 'actionPending') {
      // 手指按住不动 ≥500ms：发右键（触控模式长按）
      const geometry = resolveSurfaceInputGeometry();
      if (geometry) {
        const rightClick = buildRemoteWindowClickInputEventRuntime({
          pointerId: gesture.pointerId,
          clientX: gesture.lastClientX,
          clientY: gesture.lastClientY,
          geometry,
          button: 'right',
        });
        if (rightClick) {
          dispatchRemoteWindowInputEvents([rightClick]);
        }
        surfaceGestureRef.current = {
          mode: 'actionLongPress',
          pointerId: gesture.pointerId,
          startClientX: gesture.startClientX,
          startClientY: gesture.startClientY,
          startAtMs: gesture.startAtMs,
        };
      }
    }
  }, [dispatchRemoteWindowInputEvents, resolveSurfaceInputGeometry]);

  const handleVideoSurfacePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (state.phase !== 'targetLocked') {
      return;
    }
    // P4 探针：pointerdown 触发状态
    const probeVideo = videoElementRef.current;
    // eslint-disable-next-line no-console
    console.log(
      `[remote-window-pointerdown] mode=${state.mode} phase=${state.phase} ` +
      `streamId=${state.streamId || '-'} streamStarted=${state.streamStarted} ` +
      `streamStatus=${state.streamStatus} ` +
      `surfaceSize=${JSON.stringify(surfaceSize)} ` +
      `receiverFrameSize=${JSON.stringify(receiverFrameSize)} ` +
      `video=${probeVideo ? `${probeVideo.videoWidth}x${probeVideo.videoHeight} paused=${probeVideo.paused} readyState=${probeVideo.readyState} currentTime=${probeVideo.currentTime.toFixed(3)}` : 'null'}`,
    );
    requestBoundVideoPlayback();
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
    if (pointers.length >= 2 && event.pointerType === 'touch') {
      const currentGesture = surfaceGestureRef.current;
      if (currentGesture && currentGesture.mode === 'localPan') {
        // 第一指平移画布中：第二指按下只记"待定"，独立位移 ≥8px 才升级双指手势，
        // 防止"单指移动被识别为 pinch 缩小"误判（放大态单指 localPan 场景）
        secondPointerPendingRef.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          downTimeMs: event.timeStamp,
        };
        surfacePointersRef.current.set(event.pointerId, {
          clientX: event.clientX,
          clientY: event.clientY,
        });
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const [firstEntry, secondEntry] = pointers.slice(-2) as [
        [number, SurfacePointerPosition],
        [number, SurfacePointerPosition],
      ];
      const firstSample: RemoteWindowTouchPairPointerSample = {
        pointerId: firstEntry[0],
        pointerType: 'touch',
        clientX: firstEntry[1].clientX,
        clientY: firstEntry[1].clientY,
        timeMs: Date.now(),
      };
      const secondSample: RemoteWindowTouchPairPointerSample = {
        pointerId: secondEntry[0],
        pointerType: 'touch',
        clientX: secondEntry[1].clientX,
        clientY: secondEntry[1].clientY,
        timeMs: Date.now(),
      };
      const pairResult = resolveRemoteWindowTouchPairPointerDownRuntime({
        firstPointer: firstSample,
        secondPointer: secondSample,
        timeMs: event.timeStamp,
        pinchEnabled: state.mode === 'fullscreen',
        scrollEnabled: true,
      });
      surfaceLocalPanStartRef.current = null;
      surfaceGestureRef.current = pairResult.nextState;
      if (pairResult.localEffect.kind !== 'none') {
        applyRemoteWindowTouchLocalEffect(pairResult.localEffect);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

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
      zoomedProjection: event.pointerType === 'touch'
        && state.mode === 'fullscreen'
        && fullscreenViewportRef.current.scale > 1.01,
      touchMode: inputModeRef.current === 'touch',
    });
    applyRemoteWindowTouchPointerResult(result);
    // 触控模式：按下启动长按定时器（手指不动 ≥500ms → 右键）
    clearLongPressTimer();
    if (inputModeRef.current === 'touch' && event.pointerType === 'touch') {
      longPressTimerRef.current = window.setTimeout(handleLongPressTimer, REMOTE_WINDOW_LONG_PRESS_MS);
    }
    event.preventDefault();
    event.stopPropagation();
  }, [
    applyRemoteWindowTouchPointerResult,
    publishRemoteWindowInputContext,
    requestBoundVideoPlayback,
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

    // 第二指待定升级：独立位移 ≥8px 才升级为双指手势（localPan 期间第二指轻触不抢手势）
    const pendingSecond = secondPointerPendingRef.current;
    if (pendingSecond && pendingSecond.pointerId === event.pointerId) {
      const pendingDelta = Math.hypot(
        event.clientX - pendingSecond.clientX,
        event.clientY - pendingSecond.clientY,
      );
      if (pendingDelta >= REMOTE_WINDOW_SECOND_FINGER_UPGRADE_PX) {
        const currentGesture = surfaceGestureRef.current;
        if (currentGesture && currentGesture.mode === 'localPan') {
          const first = surfacePointersRef.current.get(currentGesture.pointerId);
          if (first) {
            console.log('[rw-gesture] second-finger upgrade: pendingDelta='
              + pendingDelta.toFixed(1), 'zoomScale=', fullscreenViewportRef.current.scale.toFixed(2));
            const pairResult = resolveRemoteWindowTouchPairPointerDownRuntime({
              firstPointer: {
                pointerId: currentGesture.pointerId,
                pointerType: 'touch',
                clientX: first.clientX,
                clientY: first.clientY,
                timeMs: event.timeStamp,
              },
              secondPointer: {
                pointerId: pendingSecond.pointerId,
                pointerType: 'touch',
                clientX: event.clientX,
                clientY: event.clientY,
                timeMs: event.timeStamp,
              },
              timeMs: event.timeStamp,
              pinchEnabled: state.mode === 'fullscreen',
              scrollEnabled: true,
            });
            surfaceGestureRef.current = pairResult.nextState;
            surfaceLocalPanStartRef.current = null;
            secondPointerPendingRef.current = null;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
        secondPointerPendingRef.current = null;
      }
    }

    const gesture = surfaceGestureRef.current;
    if (!gesture) {
      return;
    }

    const runtimeGesture = toRemoteWindowTouchGestureState(gesture);
    if (runtimeGesture.mode === 'twoFingerCandidate' || runtimeGesture.mode === 'twoFingerScroll' || runtimeGesture.mode === 'pinch') {
      const first = surfacePointersRef.current.get(runtimeGesture.firstPointerId);
      const second = surfacePointersRef.current.get(runtimeGesture.secondPointerId);
      if (!first || !second) {
        return;
      }
      const geometry = resolveSurfaceInputGeometry();
      if (!geometry) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const pairFirst: RemoteWindowTouchPairPointerSample = {
        pointerId: runtimeGesture.firstPointerId,
        pointerType: 'touch',
        clientX: first.clientX,
        clientY: first.clientY,
        timeMs: Date.now(),
      };
      const pairSecond: RemoteWindowTouchPairPointerSample = {
        pointerId: runtimeGesture.secondPointerId,
        pointerType: 'touch',
        clientX: second.clientX,
        clientY: second.clientY,
        timeMs: Date.now(),
      };
      const pairResult = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: runtimeGesture,
        pair: { first: pairFirst, second: pairSecond },
        geometry,
        timeMs: event.timeStamp,
        scrollFraction: touchScrollFractionRef.current,
        invertGestureDirection: touchScrollInvertedRef.current,
        pinchEnabled: state.mode === 'fullscreen',
        scrollEnabled: true,
      });
      if (pairResult.nextState.mode !== runtimeGesture.mode) {
        console.log('[rw-gesture] pair move transition:', runtimeGesture.mode, '->', pairResult.nextState.mode,
          'remoteEvents=', pairResult.remoteEvents.map((e) => e.kind).join(','));
      }
      surfaceGestureRef.current = pairResult.nextState;
      if (pairResult.remoteEvents.length > 0) {
        dispatchRemoteWindowInputEvents(pairResult.remoteEvents);
      }
      if (pairResult.localEffect.kind !== 'none') {
        applyRemoteWindowTouchLocalEffect(pairResult.localEffect);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (runtimeGesture.mode !== 'idle') {
      const geometry = resolveSurfaceInputGeometry();
      if (geometry) {
        const result = resolveRemoteWindowTouchPointerMoveRuntime({
          state: runtimeGesture,
          pointer: pointerSampleFromReactEvent(event),
          geometry,
          touchMode: inputModeRef.current === 'touch',
          scrollFraction: touchScrollFractionRef.current,
          invertGestureDirection: touchScrollInvertedRef.current,
        });
        // 拖动已转移（滚动/拖拽）→ 取消长按
        if (result.nextState.mode !== 'actionPending' && result.nextState.mode !== 'idle') {
          clearLongPressTimer();
        }
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

  }, [
    applyRemoteWindowTouchPointerResult,
    resolveSurfaceInputGeometry,
    setFullscreenViewport,
    state,
  ]);

  const handleVideoSurfacePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    clearLongPressTimer();
    if (secondPointerPendingRef.current?.pointerId === event.pointerId) {
      secondPointerPendingRef.current = null;
    }
    const gesture = surfaceGestureRef.current;
    if (gesture) {
      surfacePointersRef.current.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (!gesture) {
      surfacePointersRef.current.delete(event.pointerId);
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
          invertGestureDirection: false,
          touchMode: inputModeRef.current === 'touch',
        });
        // 触控模式 fullscreen 双击：本地缩放（绕触点），抑制第二次 click 注入
        const isLeftClick = result.remoteEvents.some(
          (remoteEvent) => remoteEvent.kind === 'click' && remoteEvent.button === 'left',
        );
        if (
          isLeftClick
          && state.phase === 'targetLocked'
          && state.mode === 'fullscreen'
          && inputModeRef.current === 'touch'
          && event.pointerType === 'touch'
        ) {
          const now = event.timeStamp;
          const lastTap = lastTapRef.current;
          if (
            lastTap
            && now - lastTap.atMs <= REMOTE_WINDOW_DOUBLE_TAP_MS
            && Math.hypot(event.clientX - lastTap.clientX, event.clientY - lastTap.clientY) <= REMOTE_WINDOW_DOUBLE_TAP_SLOP_PX
          ) {
            lastTapRef.current = null;
            const filtered: typeof result.remoteEvents = [];
            handleDoubleTapZoom(event.clientX, event.clientY);
            applyRemoteWindowTouchPointerResult({ ...result, remoteEvents: filtered });
            if (result.consumed) {
              surfacePointersRef.current.delete(event.pointerId);
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          lastTapRef.current = {
            atMs: now,
            clientX: event.clientX,
            clientY: event.clientY,
          };
        }
        applyRemoteWindowTouchPointerResult(result);
        if (result.consumed) {
          surfacePointersRef.current.delete(event.pointerId);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    }
    if (gesture.mode === 'pan' && gesture.pointerId === event.pointerId) {
      if (!gesture.moved) {
        const geometry = resolveSurfaceInputGeometry();
        const clickPayload = geometry
          ? buildRemoteWindowClickInputEventRuntime({
              pointerId: gesture.pointerId,
              clientX: gesture.startClientX,
              clientY: gesture.startClientY,
              geometry,
            })
          : null;
        if (clickPayload) {
          emitRemoteWindowActionInput(clickPayload);
        }
      }
      surfaceGestureRef.current = null;
      surfacePointersRef.current.delete(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (runtimeGesture.mode === 'twoFingerCandidate' || runtimeGesture.mode === 'twoFingerScroll' || runtimeGesture.mode === 'pinch') {
      const first = surfacePointersRef.current.get(runtimeGesture.firstPointerId);
      const second = surfacePointersRef.current.get(runtimeGesture.secondPointerId);
      if (!first || !second) {
        surfacePointersRef.current.delete(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const geometry = resolveSurfaceInputGeometry();
      if (!geometry) {
        surfacePointersRef.current.delete(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const pairFirst: RemoteWindowTouchPairPointerSample = {
        pointerId: runtimeGesture.firstPointerId,
        pointerType: 'touch',
        clientX: first.clientX,
        clientY: first.clientY,
        timeMs: Date.now(),
      };
      const pairSecond: RemoteWindowTouchPairPointerSample = {
        pointerId: runtimeGesture.secondPointerId,
        pointerType: 'touch',
        clientX: second.clientX,
        clientY: second.clientY,
        timeMs: Date.now(),
      };
      const remainingEntry = Array.from(surfacePointersRef.current.entries()).find(
        (entry) => entry[0] !== event.pointerId,
      ) || null;
      const remainingSample = remainingEntry
        ? {
            pointerId: remainingEntry[0],
            pointerType: 'touch' as const,
            clientX: remainingEntry[1].clientX,
            clientY: remainingEntry[1].clientY,
            timeMs: Date.now(),
          }
        : null;
      const pairResult = resolveRemoteWindowTouchPairPointerUpRuntime({
        state: runtimeGesture,
        pair: { first: pairFirst, second: pairSecond },
        geometry,
        remainingPointer: remainingSample,
        timeMs: event.timeStamp,
        scrollFraction: touchScrollFractionRef.current,
        invertGestureDirection: touchScrollInvertedRef.current,
      });
      if (pairResult.nextState.mode === 'localPan') {
        surfaceLocalPanStartRef.current = {
          pointerId: pairResult.nextState.pointerId,
          startPanX: fullscreenViewportRef.current.panX,
          startPanY: fullscreenViewportRef.current.panY,
        };
      } else if (pairResult.nextState.mode === 'idle') {
        surfaceLocalPanStartRef.current = null;
      }
      surfaceGestureRef.current = toOverlayTouchGesture(
        pairResult.nextState,
        fullscreenViewportRef.current,
        surfaceLocalPanStartRef.current,
      );
      if (pairResult.remoteEvents.length > 0) {
        dispatchRemoteWindowInputEvents(pairResult.remoteEvents);
      }
      if (pairResult.localEffect.kind !== 'none') {
        applyRemoteWindowTouchLocalEffect(pairResult.localEffect);
      }
      surfacePointersRef.current.delete(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    }
  }, [
    applyRemoteWindowTouchPointerResult,
    emitRemoteWindowActionInput,
    resolveSurfaceInputGeometry,
    state,
  ]);

  const handleVideoSurfacePointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = surfaceGestureRef.current;
    surfacePointersRef.current.delete(event.pointerId);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const runtimeGesture = gesture ? toRemoteWindowTouchGestureState(gesture) : createRemoteWindowTouchPointerState();
    if (
      gesture
      && (
        ('pointerId' in gesture && gesture.pointerId === event.pointerId)
        || (runtimeGesture.mode === 'twoFingerCandidate' || runtimeGesture.mode === 'twoFingerScroll' || runtimeGesture.mode === 'pinch')
      )
    ) {
      if (runtimeGesture.mode !== 'idle' && runtimeGesture.mode !== 'twoFingerCandidate' && runtimeGesture.mode !== 'twoFingerScroll' && runtimeGesture.mode !== 'pinch') {
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
      surfacePinchStartRef.current = null;
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
    emitRemoteWindowActionInput(scrollPayload);
    event.preventDefault();
    event.stopPropagation();
  }, [emitRemoteWindowActionInput, publishRemoteWindowInputContext, resolveScrollInputEvent]);

  const handleVideoSurfaceKey = useCallback((
    event: ReactKeyboardEvent<HTMLDivElement>,
    phase: 'down' | 'up',
  ) => {
    if (state.phase !== 'targetLocked' || !state.streamId) {
      return;
    }
    publishRemoteWindowInputContext();
    emitRemoteWindowActionInput({
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
  }, [emitRemoteWindowActionInput, publishRemoteWindowInputContext, state]);

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
    const appGroups = state.phase === 'pickerOpen'
      ? buildRemoteWindowAppTargetGroups(state.targets)
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
        {target.videoTarget.kind === 'app-window' ? (
          <span
            role="button"
            tabIndex={0}
            data-no-drag="true"
            data-testid={`remote-window-close-app-${target.streamTargetId}`}
            aria-label={`关闭 ${target.videoTarget.title || target.videoTarget.appBundleId}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleCloseRemoteApp(target);
            }}
            style={styles.targetClose}
          >
            x
          </span>
        ) : null}
      </button>
    );
    const renderAppTargetGroup = (group: RemoteWindowAppTargetGroup) => {
      if (group.targets.length <= 1) {
        return renderTargetRow(group.targets[0]);
      }
      const groupPrimary = group.targets[0];
      const groupSafeId = safeRemoteWindowGroupId(group.groupId);
      return (
        <button
          type="button"
          key={group.groupId}
          data-testid={`remote-window-app-group-${groupSafeId}`}
          data-primary-target-id={groupPrimary.streamTargetId}
          onClick={() => handleSelectTarget(groupPrimary)}
          style={styles.targetGroupRow}
        >
          <span style={styles.targetKind}>App</span>
          <span style={styles.targetMain}>{group.title || group.appBundleId}</span>
          <span style={styles.targetMeta}>{group.targets.length} 个窗口 · 打开后在视频内切换</span>
        </button>
      );
    };
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
              {appGroups.map(renderAppTargetGroup)}
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
  }, [catalogRefreshing, handleClose, handleCloseRemoteApp, handleOpenPicker, handleSelectTarget, itermPaneTargetsExpanded, state]);

	  const lockedSurfaceLayout = useMemo(() => {
	    if (state.phase !== 'targetLocked' || !surfaceSize) {
	      return null;
	    }
	    const displaySourceSize = resolveRemoteWindowDisplaySourceSize(
	      state.target,
	      receiverFrameSize,
	      compositeLayout ? focusedWindowSlot : null,
	    );
	    const viewport = state.mode === 'fullscreen' ? fullscreenViewport : initialFullscreenViewport;
	    const displayMode = state.mode === 'fullscreen'
	      ? fullscreenDisplayMode
	      : initialFullscreenDisplayMode;
	    return resolveZoomedContentRect(surfaceSize, displaySourceSize, viewport, displayMode);
	  }, [compositeLayout, focusedWindowSlot, fullscreenDisplayMode, fullscreenViewport, receiverFrameSize, state, surfaceSize]);

  const videoContentStyle = lockedSurfaceLayout
    ? {
        ...styles.videoContentFrame,
        left: lockedSurfaceLayout.content.left,
        top: lockedSurfaceLayout.content.top,
        width: lockedSurfaceLayout.content.width,
        height: lockedSurfaceLayout.content.height,
    }
    : styles.videoContentFallback;

  // 组合推流：焦点窗口（主画面裁切放大）。双流（有 overview）时主画面直接显示
  // focus 流（高码率单窗口全分辨率），不做画布 CSS 裁切
  const focusedVideoStyle = compositeLayout && focusedWindowSlot && lockedSurfaceLayout && !overviewMediaStream
    ? (() => {
        const scale = Math.min(
          Math.max(1, lockedSurfaceLayout.content.width) / Math.max(1, focusedWindowSlot.width),
          Math.max(1, lockedSurfaceLayout.content.height) / Math.max(1, focusedWindowSlot.height),
        );
        // 绝对定位：video 元素（画布×scale）相对 content 容器偏移，让焦点窗口区域
        // 精确对齐容器左/上边缘（grid 居中 + margin 会导致焦点窗口区域偏移造成留白）
        return {
          position: 'absolute' as const,
          left: -focusedWindowSlot.offsetX * scale,
          top: -focusedWindowSlot.offsetY * scale,
          width: compositeLayout.canvasWidth * scale,
          height: compositeLayout.canvasHeight * scale,
          maxWidth: 'none',
          maxHeight: 'none',
        };
      })()
    : null;

  const ztermVideoWallpaper = (
    <div
      data-testid="remote-window-video-wallpaper"
      aria-hidden="true"
      style={{
        ...styles.videoWallpaper,
        // 常驻 DOM：video 在流切换（key 重建）瞬间立即被遮罩，避免黑屏间隙；
        // 首帧播放后用 opacity 淡出，元素仍在（触摸穿透已由 pointerEvents:none 保证）。
        opacity: videoHasPlayed ? 0 : 1,
        transition: 'opacity 120ms ease-out',
      }}
    >
      <img data-testid="remote-window-video-wallpaper-logo" src={ztermRemoteWindowLogoUrl} alt="" style={styles.videoWallpaperLogo} />
    </div>
  );

  const lockedVideoContent = state.phase === 'targetLocked' ? (() => {
    if (state.streamStarted && receiverMediaStream) {
      return (
        <>
          {ztermVideoWallpaper}
          <video
            data-testid="remote-window-video"
            ref={videoElementRef}
            autoPlay
            muted
            controls={false}
            disablePictureInPicture
            preload="auto"
            poster={ztermRemoteWindowLogoUrl}
            playsInline
            onLoadedMetadata={() => {
              publishVideoDebugSnapshot('loadedmetadata');
              requestBoundVideoPlayback();
            }}
            onLoadedData={() => {
              publishVideoDebugSnapshot('loadeddata');
              requestBoundVideoPlayback();
            }}
            onCanPlay={() => {
              publishVideoDebugSnapshot('canplay');
              requestBoundVideoPlayback();
            }}
            style={{
              ...styles.videoElement,
              ...focusedVideoStyle,
              opacity: videoHasPlayed ? 1 : 0,
              visibility: videoHasPlayed ? 'visible' : 'hidden',
            }}
          />
          <video
            ref={overviewVideoElementRef}
            data-testid="remote-window-overview-video"
            autoPlay
            muted
            controls={false}
            disablePictureInPicture
            playsInline
            style={{ display: 'none' }}
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
    ? resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize, focusedWindowSlotRef.current)
    : null;
  const lockedAppWindowGroup = useMemo(() => {
    if (state.phase !== 'targetLocked') {
      return null;
    }
    const groupId = getRemoteWindowAppGroupId(state.target);
    if (!groupId) {
      return null;
    }
    const group = buildRemoteWindowAppTargetGroups(state.targets)
      .find((item) => item.groupId === groupId) || null;
    return group && group.targets.length > 1 ? group : null;
  }, [state]);
  const lockedSwitchTargets = useMemo(() => {
    if (state.phase !== 'targetLocked') {
      return [] as RemoteWindowStreamTargetManifest[];
    }
    return state.targets.some((target) => target.streamTargetId === state.target.streamTargetId)
      ? state.targets
      : [state.target, ...state.targets];
  }, [state]);
  const lockedAppSwitchGroups = useMemo(() => (
    buildRemoteWindowAppTargetGroups(lockedSwitchTargets)
  ), [lockedSwitchTargets]);
  const lockedItermSwitchTargets = useMemo(() => (
    lockedSwitchTargets.filter((target) => target.videoTarget.kind === 'iterm2-pane')
  ), [lockedSwitchTargets]);

  useEffect(() => {
    if (
      state.phase !== 'targetLocked'
      || !lockedAppWindowGroup
      || !activeSessionId
      || !requestScreenshot
    ) {
      return;
    }
    const groupTargetIds = new Set(lockedAppWindowGroup.targets.map((target) => target.streamTargetId));
    const siblingTargets = lockedAppWindowGroup.targets
      .filter((target) => target.streamTargetId !== state.target.streamTargetId);

    const refreshThumbnails = () => {
      const now = Date.now();
      const currentSnapshots = windowThumbnailsRef.current;
      if (thumbnailInFlightTargetIdsRef.current.size > 0) {
        return;
      }
      const targetsToLoad = siblingTargets
        .map((target) => {
          const snapshot = currentSnapshots[target.streamTargetId];
          if (!snapshot) {
            return { target, priority: 0 };
          }
          if (snapshot.phase === 'loading') {
            return null;
          }
          if (snapshot.phase === 'failed') {
            return null;
          }
          return now - snapshot.updatedAt >= REMOTE_WINDOW_THUMBNAIL_REFRESH_INTERVAL_MS
            ? { target, priority: 1 }
            : null;
        })
        .filter((entry): entry is { target: RemoteWindowStreamTargetManifest; priority: number } => Boolean(entry))
        .sort((left, right) => left.priority - right.priority)
        .slice(0, REMOTE_WINDOW_THUMBNAIL_MAX_REQUESTS_PER_TICK)
        .map((entry) => entry.target);
      const thumbnailRequests = targetsToLoad.map((target) => ({
        target,
        token: {
          requestId: `rw-thumb-${now}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId: activeSessionId,
          targetId: target.streamTargetId,
          startedAt: now,
        } satisfies RemoteWindowThumbnailRequestToken,
      }));

      setWindowThumbnails((current) => {
        let changed = false;
        const next: Record<string, RemoteWindowThumbnailStatus> = {};
        for (const [targetId, snapshot] of Object.entries(current)) {
          if (groupTargetIds.has(targetId)) {
            next[targetId] = snapshot;
          } else {
            changed = true;
          }
        }
        for (const { target, token } of thumbnailRequests) {
          next[target.streamTargetId] = {
            phase: 'loading',
            requestId: token.requestId,
            sessionId: token.sessionId,
            targetId: token.targetId,
            updatedAt: token.startedAt,
          };
          changed = true;
        }
        return changed ? next : current;
      });

      for (const { target, token } of thumbnailRequests) {
        thumbnailInFlightTargetIdsRef.current.set(target.streamTargetId, token);
        void requestScreenshot(activeSessionId, target, { persist: false })
          .then((result) => {
            const activeToken = thumbnailInFlightTargetIdsRef.current.get(target.streamTargetId);
            if (activeToken?.requestId === token.requestId) {
              thumbnailInFlightTargetIdsRef.current.delete(target.streamTargetId);
            }
            const dataUrl = result.dataUrl || '';
            setWindowThumbnails((current) => {
              const currentSnapshot = current[target.streamTargetId];
              if (
                currentSnapshot?.phase !== 'loading'
                || currentSnapshot.requestId !== token.requestId
                || currentSnapshot.sessionId !== token.sessionId
                || currentSnapshot.targetId !== token.targetId
              ) {
                return current;
              }
              return {
                ...current,
                [target.streamTargetId]: dataUrl
                  ? {
                      phase: 'ready',
                      dataUrl,
                      fileName: result.fileName,
                      updatedAt: Date.now(),
                    }
                  : {
                      phase: 'failed',
                      message: 'remote window thumbnail did not return image data',
                      updatedAt: Date.now(),
                    },
              };
            });
          })
          .catch((error) => {
            const activeToken = thumbnailInFlightTargetIdsRef.current.get(target.streamTargetId);
            if (activeToken?.requestId === token.requestId) {
              thumbnailInFlightTargetIdsRef.current.delete(target.streamTargetId);
            }
            setWindowThumbnails((current) => {
              const currentSnapshot = current[target.streamTargetId];
              if (
                currentSnapshot?.phase !== 'loading'
                || currentSnapshot.requestId !== token.requestId
                || currentSnapshot.sessionId !== token.sessionId
                || currentSnapshot.targetId !== token.targetId
              ) {
                return current;
              }
              return {
                ...current,
                [target.streamTargetId]: {
                  phase: 'failed',
                  message: error instanceof Error ? error.message : String(error),
                  updatedAt: Date.now(),
                },
              };
            });
          });
      }
    };

    refreshThumbnails();
    const intervalId = window.setInterval(refreshThumbnails, REMOTE_WINDOW_THUMBNAIL_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeSessionId, lockedAppWindowGroup, requestScreenshot, setWindowThumbnails, state]);
  useEffect(() => {
    if (state.phase !== 'targetLocked' || lockedAppWindowGroup) {
      return;
    }
    setWindowThumbnails((current) => (Object.keys(current).length === 0 ? current : {}));
  }, [lockedAppWindowGroup, setWindowThumbnails, state.phase]);
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
        flex: '1 1 auto',
        aspectRatio: `${Math.max(1, Math.round(lockedDisplaySourceSize.width))} / ${Math.max(1, Math.round(lockedDisplaySourceSize.height))}`,
        ...(floatingVideoHeightPx
          ? { height: `${floatingVideoHeightPx}px` }
          : { maxHeight: 'min(52vh, 420px)' }),
      }
    : styles.videoPlaceholder;
  const lockedWindowGroupLandscape = typeof window === 'undefined'
    ? false
    : Math.round(window.visualViewport?.width || window.innerWidth || 0) >= Math.round(window.visualViewport?.height || window.innerHeight || 0);
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
  const streamFeedback = state.phase === 'targetLocked'
    ? state.streamCleanupErrorMessage
      ? {
          testId: 'remote-window-stream-cleanup-error',
          title: '旧窗口流清理失败',
          detail: state.streamCleanupErrorMessage,
        }
      : state.streamDegradedMessage
        ? {
            testId: 'remote-window-stream-degraded',
            title: '高质量窗口流失败',
            detail: state.streamDegradedMessage,
          }
      : state.streamHandoffErrorMessage
        ? {
            testId: 'remote-window-stream-handoff-error',
            title: '窗口切换失败',
            detail: state.streamHandoffErrorMessage,
          }
        : state.streamHandoff
          ? {
              testId: 'remote-window-stream-handoff-pending',
              title: '正在切换窗口',
              detail: '当前视频保持连接，新窗口接通后再切换',
            }
          : null
    : null;
  const lockedVideoSurfaceNode = state.phase === 'targetLocked' ? (
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
      {compositeLayout ? (
        <div data-testid="remote-window-composite-strip" data-no-drag="true" style={styles.compositeStrip}>
          <div
            data-testid="remote-window-composite-thumbnails"
            style={styles.compositeThumbRow}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
          >
            {compositeLayout.windows.map((slot) => (
              <button
                key={slot.windowId}
                type="button"
                data-testid={`remote-window-composite-thumb-${slot.windowId}`}
                data-focused={focusedWindowSlot?.windowId === slot.windowId ? 'true' : undefined}
                onClick={() => {
                  // 双流：切子窗口 → daemon 切换高码率 focus 捕获目标（低清占位由 overview 流兜底）
                  setFocusedWindowId(slot.windowId);
                  const focusStreamId = activeFocusStreamIdRef.current || activeStreamIdRef.current;
                  const focusTarget = state.targets.find(
                    (item) => item.videoTarget.windowId === slot.windowId,
                  );
                  if (focusStreamId && focusTarget && updateFocus && activeSessionId) {
                    updateFocus(activeSessionId, focusStreamId, focusTarget);
                  }
                }}
                style={{
                  ...styles.compositeThumbButton,
                  ...(focusedWindowSlot?.windowId === slot.windowId ? styles.compositeThumbButtonFocused : null),
                }}
              >
                <canvas
                  ref={(node) => {
                    compositeThumbCanvasRefs.current.set(slot.windowId, node);
                  }}
                  width={slot.windowId === focusedWindowSlot?.windowId ? 160 : 96}
                  height={slot.windowId === focusedWindowSlot?.windowId ? 120 : 72}
                  style={styles.compositeThumbCanvas}
                />
                <span style={styles.compositeThumbLabel}>
                  {slot.windowId === state.target.videoTarget.windowId ? '主' : '子'}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
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
      {streamFeedback ? (
        <div
          data-testid={streamFeedback.testId}
          role={streamFeedback.testId.endsWith('error') ? 'alert' : 'status'}
          aria-live={streamFeedback.testId.endsWith('error') ? 'assertive' : 'polite'}
          style={styles.streamFeedbackToast}
        >
          <span style={styles.screenshotToastTitle}>{streamFeedback.title}</span>
          <span style={styles.screenshotToastDetail}>{streamFeedback.detail}</span>
        </div>
      ) : null}
    </div>
  ) : null;
  const lockedVideoGroupContent = state.phase === 'targetLocked' && lockedVideoSurfaceNode ? (() => {
    if (!lockedAppWindowGroup) {
      return lockedVideoSurfaceNode;
    }
    const items = lockedAppWindowGroup.targets.map((target) => {
      const active = target.streamTargetId === state.target.streamTargetId;
      const rect = target.videoTarget.cropRectTopLeftPx || target.videoTarget.windowBoundsTopLeftPx;
      const title = target.videoTarget.title || target.videoTarget.windowId || target.streamTargetId;
      return {
        id: target.streamTargetId,
        testId: `remote-window-video-window-option-${target.streamTargetId}`,
        roleLabel: `切换远程窗口 ${title}`,
        onPress: active ? undefined : () => handleSelectTarget(target),
        node: active ? lockedVideoSurfaceNode : (() => {
          const thumbnail = windowThumbnails[target.streamTargetId];
          return (
            <div
              data-remote-window-child-tile="true"
              style={styles.videoWindowGroupTile}
            >
              <button
                type="button"
                data-no-drag="true"
                data-testid={`remote-window-video-window-close-${target.streamTargetId}`}
                aria-label="关闭远程窗口"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handleClose();
                }}
                style={styles.videoWindowGroupCloseButton}
              >
                x
              </button>
              <div style={styles.videoWindowGroupThumb}>
                {thumbnail?.phase === 'ready' ? (
                  <img
                    data-testid={`remote-window-video-window-thumbnail-${target.streamTargetId}`}
                    src={thumbnail.dataUrl}
                    alt=""
                    style={styles.videoWindowGroupThumbImage}
                  />
                ) : (
                  <span
                    data-testid={`remote-window-video-window-thumbnail-status-${target.streamTargetId}`}
                    data-phase={thumbnail?.phase || 'idle'}
                    style={styles.videoWindowGroupThumbTitle}
                  >
                    {thumbnail?.phase === 'loading'
                      ? '截图中'
                      : thumbnail?.phase === 'failed'
                        ? '截图失败'
                        : title}
                  </span>
                )}
              </div>
              <div style={styles.videoWindowGroupTileMeta}>
                <span style={styles.videoWindowGroupTileTitle}>{title}</span>
                <span style={styles.videoWindowGroupTileSize}>{Math.round(rect.width)}x{Math.round(rect.height)}</span>
              </div>
            </div>
          );
        })(),
      };
    });
    const groupStyle = state.mode === 'fullscreen'
      ? styles.videoWindowGroupFullscreen
      : {
          ...styles.videoWindowGroupFloating,
          ...(floatingVideoHeightPx ? { height: `${floatingVideoHeightPx}px` } : {}),
        };
    return (
      <WindowGroupLayout
        items={items}
        landscape={lockedWindowGroupLandscape}
        primaryItemId={state.target.streamTargetId}
        secondaryPlacement={lockedWindowGroupLandscape ? 'after' : 'before'}
        testId="remote-window-video-window-switcher"
        style={groupStyle}
      />
    );
  })() : null;
  const lockedAppSwitchContent = state.phase === 'targetLocked' ? (() => {
    const renderSwitchTargetRow = (target: RemoteWindowStreamTargetManifest) => {
      const active = target.streamTargetId === state.target.streamTargetId;
      return (
        <button
          key={target.streamTargetId}
          type="button"
          data-no-drag="true"
          data-testid={`remote-window-active-app-switch-target-${target.streamTargetId}`}
          aria-current={active ? 'true' : undefined}
          onClick={() => {
            if (!active) {
              handleSelectTarget(target);
              return;
            }
            setAppSwitchOpen(false);
          }}
          style={active ? styles.appSwitchTargetRowActive : styles.appSwitchTargetRow}
        >
          <span style={styles.appSwitchTargetTitle}>
            {target.videoTarget.title || target.videoTarget.appBundleId || target.streamTargetId}
          </span>
          <span style={styles.appSwitchTargetMeta}>{formatTargetSubtitle(target)}</span>
          {target.videoTarget.kind === 'app-window' ? (
            <span
              role="button"
              tabIndex={0}
              data-no-drag="true"
              data-testid={`remote-window-close-app-${target.streamTargetId}`}
              aria-label={`关闭 ${target.videoTarget.title || target.videoTarget.appBundleId}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleCloseRemoteApp(target);
              }}
              style={styles.appSwitchTargetClose}
            >
              x
            </span>
          ) : null}
        </button>
      );
    };
    return (
      <div data-testid="remote-window-active-app-switch-list" data-no-drag="true" style={styles.appSwitchPopover}>
        {activeCatalogSyncError ? (
          <div data-testid="remote-window-active-catalog-sync-error" style={styles.appSwitchError}>
            {activeCatalogSyncError}
          </div>
        ) : null}
        {lockedAppSwitchGroups.map((group) => (
          <div key={group.groupId} data-testid={`remote-window-active-app-switch-group-${safeRemoteWindowGroupId(group.groupId)}`} style={styles.appSwitchGroup}>
            <div style={styles.appSwitchGroupTitle}>
              <span>{group.title || group.appBundleId}</span>
              <span style={styles.appSwitchGroupCount}>{group.targets.length}</span>
            </div>
            {group.targets.map(renderSwitchTargetRow)}
          </div>
        ))}
        {lockedItermSwitchTargets.length > 0 ? (
          <div data-testid="remote-window-active-app-switch-group-iterm2" style={styles.appSwitchGroup}>
            <div style={styles.appSwitchGroupTitle}>
              <span>iTerm2 Panes</span>
              <span style={styles.appSwitchGroupCount}>{lockedItermSwitchTargets.length}</span>
            </div>
            {lockedItermSwitchTargets.map(renderSwitchTargetRow)}
          </div>
        ) : null}
        {lockedSwitchTargets.length === 0 ? (
          <div style={styles.appSwitchEmpty}>没有可切换窗口</div>
        ) : null}
      </div>
    );
  })() : null;

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
      <div ref={lockedToolbarRef} data-testid="remote-window-locked-toolbar" style={styles.lockedToolbar}>
        <div
          data-testid="remote-window-drag-handle"
          onPointerDown={floatingDragHandlers.onPointerDown}
          onPointerMove={floatingDragHandlers.onPointerMove}
          onPointerUp={floatingDragHandlers.onPointerUp}
          onPointerCancel={floatingDragHandlers.onPointerCancel}
          onTouchStart={floatingDragHandlers.onTouchStart}
          onTouchMove={floatingDragHandlers.onTouchMove}
          onTouchEnd={floatingDragHandlers.onTouchEnd}
          onTouchCancel={floatingDragHandlers.onTouchCancel}
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
            <span style={styles.activeAppSwitch}>
              <button
                type="button"
                data-testid="remote-window-active-app-switch-button"
                data-no-drag="true"
                aria-haspopup="listbox"
                aria-expanded={appSwitchOpen ? 'true' : 'false'}
                onClick={() => setAppSwitchOpen((current) => !current)}
                style={styles.activeAppSwitchButton}
              >
                {state.target.videoTarget.title || state.target.videoTarget.appBundleId}
              </button>
              {appSwitchOpen ? lockedAppSwitchContent : null}
            </span>
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
          <button
            type="button"
            data-testid="remote-window-input-mode-toggle"
            data-no-drag="true"
            aria-label={inputMode === 'touch' ? '切换为鼠标模式' : '切换为触控模式'}
            onClick={handleToggleInputMode}
            style={inputMode === 'touch' ? styles.headerModeButtonActive : styles.headerModeButton}
          >
            {inputMode === 'touch' ? '触控' : '鼠标'}
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
          <button
            type="button"
            data-no-drag="true"
            data-testid="remote-window-stream-status-toggle"
            aria-label="远程窗口串流状态"
            aria-expanded={streamStatusOpen ? 'true' : 'false'}
            onClick={() => setStreamStatusOpen((current) => !current)}
            style={streamStatusOpen ? styles.headerModeButtonActive : styles.headerModeButton}
          >
            状态
          </button>
          {state.mode === 'fullscreen' ? (
            <button
              type="button"
              data-testid="remote-window-fullscreen-display-toggle"
              aria-label="按手机全屏尺寸调整远程窗口"
              onClick={handleToggleFullscreenDisplayMode}
              style={styles.headerModeButton}
            >
              填满
            </button>
          ) : null}
        </div>
        {streamStatusOpen ? (
          <div data-testid="remote-window-stream-status-panel" data-no-drag="true" style={styles.streamStatusPanel}>
            <div>app: {appForegroundActive === false ? 'background' : 'foreground'}</div>
            <div>phase: {state.phase} / {state.phase === 'targetLocked' ? state.streamStatus : '-'}</div>
            <div>session: {activeSessionId || '-'}</div>
            <div>stream: {state.phase === 'targetLocked' ? state.streamId || '-' : '-'}</div>
            <div>target: {state.phase === 'targetLocked' ? state.target.streamTargetId : '-'}</div>
            <div>receiver: {receiverMediaStream ? 'attached' : 'missing'} / played:{videoHasPlayed ? 'yes' : 'no'}</div>
            <div>frame: {receiverFrameSize ? `${receiverFrameSize.width}x${receiverFrameSize.height}` : '-'}</div>
            <div>video: {videoDebugSnapshot ? `${videoDebugSnapshot.videoWidth}x${videoDebugSnapshot.videoHeight} ready=${videoDebugSnapshot.readyState} paused=${videoDebugSnapshot.paused ? 'yes' : 'no'} frames=${videoDebugSnapshot.framesReceived}` : '-'}</div>
            <div>live: {liveDiag ? `t=${liveDiag.currentTime.toFixed(3)} paused=${liveDiag.paused ? 'yes' : 'no'} ready=${liveDiag.readyState} track=${liveDiag.trackState}${liveDiag.trackMuted ? '/muted' : ''} frames=${liveDiag.framesReceived} ${liveDiag.videoWidth}x${liveDiag.videoHeight} epoch=${liveDiag.epoch}` : '-'}</div>
            <div>play: {videoDebugSnapshot ? `try=${videoDebugSnapshot.playAttempts} ok=${videoDebugSnapshot.playAccepted} reject=${videoDebugSnapshot.playRejected}` : '-'}</div>
            <div>event: {videoDebugSnapshot?.lastEvent || '-'}</div>
            <div>error: {videoDebugSnapshot?.lastError || (state.phase === 'targetLocked' ? state.streamErrorMessage || '-' : '-')}</div>
            <div>invalid: {streamInvalidation ? `${streamInvalidation.streamId} ${streamInvalidation.message}` : '-'}</div>
            <div>viewport: {viewportDebugSnapshot ? `${viewportDebugSnapshot.event} window=${viewportDebugSnapshot.window} vv=${viewportDebugSnapshot.visualViewport}` : '-'}</div>
            <div>rects: {viewportDebugSnapshot ? `surface=${viewportDebugSnapshot.surface} overlay=${viewportDebugSnapshot.overlay}` : '-'}</div>
          </div>
        ) : null}
      </div>
      {lockedVideoGroupContent}
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
      {state.phase === 'closed' || state.phase === 'targetEnumerating' || state.phase === 'pickerOpen' ? (
        <button
          ref={entryButtonRef}
          type="button"
          data-testid="remote-window-entry"
          aria-label="打开远程窗口"
          onPointerDown={entryDragHandlers.onPointerDown}
          onPointerMove={entryDragHandlers.onPointerMove}
          onPointerUp={entryDragHandlers.onPointerUp}
          onPointerCancel={entryDragHandlers.onPointerCancel}
          onTouchStart={entryDragHandlers.onTouchStart}
          onTouchMove={entryDragHandlers.onTouchMove}
          onTouchEnd={entryDragHandlers.onTouchEnd}
          onTouchCancel={entryDragHandlers.onTouchCancel}
          onClick={() => {
            if (suppressEntryClickRef.current) {
              return;
            }
            // 与文件按键一致的直接开/关语义：closed 打开 picker，picker 打开时再点关闭
            if (state.phase === 'closed') {
              handleOpenPicker();
            } else {
              handleClose();
            }
          }}
          style={{
            ...styles.entryButton,
            right: entryOffset.x === null ? 14 : 'auto',
            bottom: entryOffset.y === null ? `${92 + Math.max(0, bottomInsetPx)}px` : 'auto',
            left: entryOffset.x === null ? 'auto' : `${entryOffset.x}px`,
            top: entryOffset.y === null ? 'auto' : `${entryOffset.y}px`,
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
  compositeStrip: {
    position: 'absolute',
    left: 8,
    right: 8,
    top: 8,
    zIndex: 60,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    pointerEvents: 'auto',
    borderRadius: 10,
    background: 'rgba(10, 14, 20, 0.72)',
    backdropFilter: 'blur(6px)',
    padding: 8,
  },
  compositeOverviewWrap: {
    overflow: 'hidden',
    borderRadius: 6,
  },
  compositeOverview: {
    display: 'block',
    width: '100%',
    height: 72,
    borderRadius: 6,
    background: '#0a0e14',
  },
  compositeThumbRow: {
    display: 'flex',
    flexDirection: 'row',
    gap: 8,
    overflowX: 'auto',
    overflowY: 'hidden',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'thin',
  },
  compositeThumbButton: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    padding: 3,
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 8,
    background: 'rgba(255,255,255,0.05)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  compositeThumbButtonFocused: {
    border: '2px solid #55b6ff',
    padding: 2,
  },
  compositeThumbCanvas: {
    display: 'block',
    width: '100%',
    borderRadius: 4,
    background: '#0a0e14',
  },
  compositeThumbLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.7)',
    lineHeight: '12px',
  },
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
    maxHeight: 'calc(100dvh - 164px - env(safe-area-inset-top, 0px))',
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
    width: '100%',
    height: '100%',
    minHeight: '100%',
    zIndex: 90,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    paddingTop: 'calc(44px + env(safe-area-inset-top, 0px))',
    paddingLeft: 'max(8px, env(safe-area-inset-left, 0px))',
    paddingRight: 'max(8px, env(safe-area-inset-right, 0px))',
    background: '#02050a',
    color: '#edf4ff',
    contain: 'layout paint',
    isolation: 'isolate',
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
  activeAppSwitch: {
    position: 'relative',
    minWidth: 0,
    flex: '1 1 auto',
  },
  activeAppSwitchButton: {
    width: '100%',
    minWidth: 0,
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '3px 2px',
    border: 0,
    background: 'transparent',
    color: '#edf4ff',
    textAlign: 'left',
    fontSize: 12,
    fontWeight: 850,
  },
  appSwitchPopover: {
    position: 'absolute',
    top: 'calc(100% + 8px)',
    left: 0,
    width: 'min(78vw, 340px)',
    maxHeight: 'min(52vh, 420px)',
    overflowY: 'auto',
    display: 'grid',
    gap: 8,
    padding: 8,
    borderRadius: 12,
    border: '1px solid rgba(151, 164, 186, 0.22)',
    background: 'rgba(8, 13, 23, 0.98)',
    boxShadow: '0 18px 46px rgba(0,0,0,0.52)',
    zIndex: 4,
  },
  appSwitchGroup: {
    display: 'grid',
    gap: 5,
  },
  appSwitchGroupTitle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '2px 4px',
    color: 'rgba(237,244,255,0.68)',
    fontSize: 10,
    fontWeight: 900,
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  appSwitchGroupCount: {
    flex: '0 0 auto',
    minWidth: 18,
    padding: '1px 5px',
    borderRadius: 8,
    background: 'rgba(151, 164, 186, 0.14)',
    color: mobileTheme.colors.accent,
    textAlign: 'center',
  },
  appSwitchTargetRow: {
    minWidth: 0,
    display: 'grid',
    gap: 2,
    padding: '8px 9px',
    borderRadius: 9,
    border: '1px solid rgba(151, 164, 186, 0.14)',
    background: 'rgba(22, 32, 50, 0.92)',
    color: '#edf4ff',
    textAlign: 'left',
  },
  appSwitchTargetRowActive: {
    minWidth: 0,
    display: 'grid',
    gap: 2,
    padding: '8px 9px',
    borderRadius: 9,
    border: `1px solid ${mobileTheme.colors.accent}`,
    background: 'rgba(31, 214, 122, 0.12)',
    color: '#edf4ff',
    textAlign: 'left',
  },
  appSwitchTargetTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
    fontWeight: 900,
  },
  appSwitchTargetMeta: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'rgba(237,244,255,0.58)',
    fontSize: 10,
    fontWeight: 750,
  },
  appSwitchTargetClose: {
    justifySelf: 'end',
    marginTop: -18,
    padding: '1px 6px',
    borderRadius: 6,
    color: '#ff9a9a',
    background: 'rgba(255, 92, 92, 0.12)',
    fontSize: 12,
    fontWeight: 900,
    cursor: 'pointer',
  },
  targetClose: {
    position: 'absolute',
    right: 10,
    top: 10,
    padding: '1px 6px',
    borderRadius: 6,
    color: '#ff9a9a',
    background: 'rgba(255, 92, 92, 0.12)',
    fontSize: 12,
    fontWeight: 900,
    cursor: 'pointer',
  },
  streamStatusPanel: {
    display: 'grid',
    gap: 3,
    maxHeight: 220,
    overflowY: 'auto',
    padding: '8px 10px',
    borderTop: '1px solid rgba(151, 164, 186, 0.2)',
    background: 'rgba(5, 9, 15, 0.96)',
    color: 'rgba(237,244,255,0.78)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 10,
    lineHeight: 1.35,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  appSwitchError: {
    padding: '7px 8px',
    borderRadius: 8,
    background: 'rgba(97, 63, 13, 0.72)',
    color: '#ffe2a8',
    fontSize: 11,
    lineHeight: 1.35,
  },
  appSwitchEmpty: {
    padding: 10,
    color: 'rgba(237,244,255,0.58)',
    fontSize: 11,
    textAlign: 'center',
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
    contain: 'paint',
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
    contain: 'paint',
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
    zIndex: 2,
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
  videoWindowGroupFloating: {
    flex: '0 0 auto',
    minWidth: 0,
    minHeight: 0,
    padding: 8,
    background: '#0a101b',
    overflow: 'hidden',
    boxSizing: 'border-box',
  },
  videoWindowGroupFullscreen: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    padding: 8,
    background: '#0a101b',
    overflow: 'hidden',
    boxSizing: 'border-box',
  },
  videoWindowGroupTile: {
    position: 'relative',
    width: '100%',
    height: '100%',
    minHeight: 58,
    display: 'grid',
    gridTemplateRows: 'minmax(34px, 1fr) auto',
    gap: 4,
    padding: 4,
    borderRadius: 8,
    border: '1px solid rgba(151, 164, 186, 0.18)',
    background: 'rgba(20, 31, 49, 0.88)',
    color: '#edf4ff',
    boxSizing: 'border-box',
  },
  videoWindowGroupCloseButton: {
    position: 'absolute',
    top: 6,
    right: 6,
    zIndex: 2,
    width: 24,
    height: 24,
    borderRadius: 8,
    border: '1px solid rgba(151, 164, 186, 0.28)',
    background: 'rgba(5, 9, 16, 0.78)',
    color: '#edf4ff',
    fontSize: 12,
    fontWeight: 950,
    lineHeight: 1,
  },
  videoWindowGroupThumb: {
    minWidth: 0,
    minHeight: 34,
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
    borderRadius: 7,
    background: '#050910',
    boxShadow: 'inset 0 0 0 1px rgba(237,244,255,0.08)',
  },
  videoWindowGroupThumbImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  videoWindowGroupThumbTitle: {
    maxWidth: '86%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'rgba(237,244,255,0.7)',
    fontSize: 10,
    fontWeight: 900,
  },
  videoWindowGroupTileMeta: {
    minWidth: 0,
    display: 'grid',
    gap: 2,
  },
  videoWindowGroupTileTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 10,
    fontWeight: 900,
    lineHeight: 1.1,
  },
  videoWindowGroupTileSize: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'rgba(237,244,255,0.58)',
    fontSize: 9,
    fontWeight: 800,
    lineHeight: 1.1,
  },
  streamFeedbackToast: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    zIndex: 5,
    display: 'grid',
    gap: 2,
    padding: '8px 10px',
    borderRadius: 12,
    border: '1px solid rgba(255, 198, 92, 0.42)',
    background: 'rgba(48, 31, 9, 0.9)',
    color: '#ffe2a8',
    boxShadow: '0 14px 36px rgba(0,0,0,0.36)',
    pointerEvents: 'none',
  },
};
