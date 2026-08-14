import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import ztermRemoteWindowLogoUrl from '../../../../assets/logo_engraved.png';
import { useSharedDraggableDrag, SHARED_DRAG_SUPPRESS_CLICK_MS } from './draggable-bubble-shared';
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
  acceptRemoteWindowFocusReady,
  beginRemoteWindowDualStreamSwitch,
  commitRemoteWindowFocusProjection,
  failRemoteWindowDualStreamSwitch,
  markRemoteWindowFocusUpdating,
  resetRemoteWindowDualStreamSwitch,
  showRemoteWindowOverviewCrop,
  type RemoteWindowDualStreamState,
} from '../../lib/remote-window-dual-stream-runtime';
import {
  applyRemoteWindowInputResultTarget,
  applyRemoteWindowTargetCatalog,
  applyRemoteWindowTargetCatalogSnapshot,
  attachSameAppCompositeWindows,
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
  resolveRemoteWindowTouchPairPointerDownRuntime,
  resolveRemoteWindowTouchPairPointerMoveRuntime,
  resolveRemoteWindowTouchPairPointerUpRuntime,
  resolveRemoteWindowTouchPointerCancelRuntime,
  resolveRemoteWindowTouchPointerDownRuntime,
  resolveRemoteWindowTouchPointerMoveRuntime,
  resolveRemoteWindowTouchPointerUpRuntime,
  resolveRemoteWindowTouchSurfacePointRuntime,
  REMOTE_WINDOW_LONG_PRESS_MS,
  type RemoteWindowTouchInputDebugEvent,
  type RemoteWindowTouchLocalEffect,
  type RemoteWindowTouchPairPointerSample,
  type RemoteWindowTouchPointerState,
  type RemoteWindowTouchSurfaceGeometry,
} from '../../lib/remote-window-touch-action-runtime';
import { WindowGroupLayout } from './WindowGroupLayout';
import {
  FLOATING_ENTRY_TOP_MARGIN_PX,
  FLOATING_ENTRY_VIEWPORT_MARGIN_PX,
  FLOATING_OVERLAY_MAX_WIDTH_PX,
  FLOATING_OVERLAY_MIN_WIDTH_PX,
  FLOATING_OVERLAY_TOOLBAR_ESTIMATE_PX,
  FLOATING_OVERLAY_TOP_SAFE_MARGIN_PX,
  FLOATING_OVERLAY_VIEWPORT_MARGIN_PX,
  REMOTE_WINDOW_ACTIVE_CATALOG_SYNC_INTERVAL_MS,
  REMOTE_WINDOW_CATALOG_PROJECTION_CACHE_TTL_MS,
  REMOTE_WINDOW_CATALOG_UI_TIMEOUT_MS,
  REMOTE_WINDOW_DOUBLE_TAP_MS,
  REMOTE_WINDOW_DOUBLE_TAP_SLOP_PX,
  REMOTE_WINDOW_DUAL_STREAM_SWITCH_TIMEOUT_MS,
  REMOTE_WINDOW_FLOATING_BOTTOM_BASE_PX,
  REMOTE_WINDOW_FULLSCREEN_MAX_SCALE,
  REMOTE_WINDOW_FULLSCREEN_MIN_SCALE,
  REMOTE_WINDOW_FULLSCREEN_PAN_TAP_THRESHOLD_PX,
  REMOTE_WINDOW_SECOND_FINGER_UPGRADE_PX,
  REMOTE_WINDOW_THUMBNAIL_MAX_REQUESTS_PER_TICK,
  REMOTE_WINDOW_THUMBNAIL_REFRESH_INTERVAL_MS,
  type FloatingResizeAnchor,
  type RemoteWindowInputMode,
} from './remote-window-overlay-constants';
import {
  readRemoteWindowInputMode,
  readRemoteWindowTouchScrollFraction,
  readRemoteWindowTouchScrollInverted,
  readStoredEntryPosition,
  writeRemoteWindowInputMode,
  writeStoredEntryPosition,
  type FloatingEntryPosition,
  type RemoteWindowTouchScrollFraction,
} from './remote-window-overlay-storage';

import {
  SurfaceSize,
  FullscreenViewportState,
  FullscreenDisplayMode,
  SurfacePointerPosition,
  SurfacePointerGesture,
  FloatingOverlayResize,
  FloatingOverlayOffset,
  initialFullscreenViewport,
  initialFullscreenDisplayMode,
  cloneRemoteWindowCatalogPayload,
  clampFloatingOffset,
  clampNumber,
  clampFullscreenViewport,
  resolveZoomedContentRect,
  resolveAnchoredFullscreenViewportScale,
  resolveFloatingOverlaySizing,
  resolveStartedCaptureFrameSize,
  resolveRemoteWindowDisplaySourceSize,
  resolveRemoteWindowFullscreenFillReferenceSize,
  formatTargetKind,
  isRemoteWindowInputSupported,
  readRemoteWindowNetworkQuality,
  pointerSampleFromReactEvent,
  toOverlayTouchGesture,
  toRemoteWindowTouchGestureState,
  getRemoteWindowNetworkConnection,
  formatTargetSubtitle,
  RemoteWindowAppTargetGroup,
  getRemoteWindowAppGroupId,
  buildRemoteWindowAppTargetGroups,
  safeRemoteWindowGroupId,
} from './remote-window-overlay-helpers';
import { styles } from './remote-window-overlay-styles';
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
    revision?: number,
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
  const [dualStreamSwitch, setDualStreamSwitch] = useState<RemoteWindowDualStreamState>({
    phase: 'focus-committed',
    revision: 0,
    activeTargetId: null,
    pendingTargetId: null,
    focusStreamId: null,
    overviewCropTargetId: null,
    error: null,
  });
  const compositeOverviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositeThumbCanvasRefs = useRef<Map<string, HTMLCanvasElement | null>>(new Map());
  // 未收到当前 revision 的 focus-result 时显式结束 crop 状态，避免无限期隐藏主视频。
  useEffect(() => {
    if (dualStreamSwitch.phase !== 'overview-crop-visible') {
      return;
    }
    const timer = window.setTimeout(() => {
      setDualStreamSwitch((current) => {
        if (current.phase !== 'overview-crop-visible') {
          return current;
        }
        return resetRemoteWindowDualStreamSwitch(current);
      });
    }, REMOTE_WINDOW_DUAL_STREAM_SWITCH_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [dualStreamSwitch.phase]);
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
    const scrollCount = events.filter((e) => e.kind === 'scroll').length;
    if (scrollCount > 0) {
      // eslint-disable-next-line no-console
      const video = videoElementRef.current;
      console.log(`[remote-window-scroll] sent=${scrollCount} ` +
        `viewport=${JSON.stringify(fullscreenViewportRef.current)} ` +
        `receiverStream=${receiverMediaStream ? 'ok' : 'NULL'} ` +
        `overviewStream=${overviewMediaStream ? 'ok' : 'NULL'} ` +
        `videoHasPlayed=${videoHasPlayedRef.current} ` +
        `videoReady=${video?.readyState ?? 'NULL'} ` +
        `currentTime=${video?.currentTime?.toFixed(2) ?? 'NULL'} ` +
        `surfaceRect=${videoSurfaceRef.current ? JSON.stringify(videoSurfaceRef.current.getBoundingClientRect()) : 'NULL'}`);
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
    writeStoredEntryPosition(next);
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
        : 'fit';
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
        : 'fit';
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
    // Keep the revision across close: the daemon stream may outlive the
    // overlay (e.g. background-close where stopStream is not authoritative),
    // and its focusRevision is not reset. Resetting to 0 would make the next
    // switch's revision<=daemon focusRevision and be rejected as stale.
    setDualStreamSwitch((current) => ({
      ...resetRemoteWindowDualStreamSwitch(current),
      activeTargetId: null,
      pendingTargetId: null,
      focusStreamId: null,
      overviewCropTargetId: null,
      error: null,
    }));
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
    // 缩回浮窗时强制退出进行中的双流切流（overview-crop-visible 等），
    // 防止浮窗残留「video 隐藏 + canvas 无内容」的黑屏状态。
    setDualStreamSwitch((current) => resetRemoteWindowDualStreamSwitch(current));
    setState((current) => shrinkRemoteWindowOverlay(current));
  }, [resetFullscreenViewport, setDualStreamSwitch]);

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
      const crop = compositeOverviewCanvasRef.current;
      if (crop && focusedWindowSlot && dualStreamSwitch.phase === 'overview-crop-visible') {
        const ctx = crop.getContext('2d');
        if (ctx && crop.width > 0 && crop.height > 0) {
          ctx.clearRect(0, 0, crop.width, crop.height);
          ctx.drawImage(
            video,
            focusedWindowSlot.offsetX,
            focusedWindowSlot.offsetY,
            focusedWindowSlot.width,
            focusedWindowSlot.height,
            0,
            0,
            crop.width,
            crop.height,
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
  }, [compositeLayout, dualStreamSwitch.phase, focusedWindowSlot, receiverMediaStream]);

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
      if (msg.type === 'remote-window-error') {
        // Daemon focus-update rejection (stale / invalid / unsupported) must
        // explicitly end the in-flight switch instead of waiting for the 3s
        // timeout; otherwise the overlay hangs in focus-updating.
        if (msg.payload?.streamId && msg.payload.streamId !== activeStreamIdRef.current) {
          return;
        }
        setDualStreamSwitch((current) => {
          if (current.phase === 'idle' || current.phase === 'focus-committed') {
            return current;
          }
          return failRemoteWindowDualStreamSwitch(
            current,
            msg.payload?.message || 'Remote window focus update rejected',
          );
        });
        return;
      }
      if (msg.type === 'remote-window-stream-focus-result') {
        if (msg.payload.streamId !== activeStreamIdRef.current) {
          return;
        }
        setDualStreamSwitch((current) => {
          const matchesCurrentSwitch = msg.payload.revision === current.revision
            && msg.payload.targetId === current.pendingTargetId
            && msg.payload.streamId === current.focusStreamId;
          if (!matchesCurrentSwitch) {
            return current;
          }
          if (msg.payload.phase === 'accepted') {
            return markRemoteWindowFocusUpdating(current);
          }
          if (msg.payload.phase === 'error') {
            return failRemoteWindowDualStreamSwitch(
              current,
              msg.payload.message || 'Remote window focus update failed',
            );
          }
          if (msg.payload.phase === 'ready') {
            return commitRemoteWindowFocusProjection(
              acceptRemoteWindowFocusReady(current, msg.payload),
            );
          }
          return current;
        });
        return;
      }
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
    const catalogTargets = 'targets' in state ? state.targets : [];
    const effectiveTarget = updateFocus
      ? attachSameAppCompositeWindows(target, catalogTargets)
      : target;
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
      setState((current) => {
        const selected = selectRemoteWindowTarget(current, target.streamTargetId);
        return selected.phase === 'targetLocked' ? { ...selected, target: effectiveTarget } : selected;
      });
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
    const selectEffectiveTarget = (current: RemoteWindowOverlayState): RemoteWindowOverlayState => {
      const selected = selectRemoteWindowTarget(current, target.streamTargetId);
      if (selected.phase !== 'targetLocked') {
        return selected;
      }
      return { ...selected, target: effectiveTarget };
    };
    const startingState = (current: RemoteWindowOverlayState) => beginRemoteWindowStreamSetup(
      selectEffectiveTarget(current),
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
    // 单连接双 transceiver：receiver/runtime 在 target.compositeWindows 非空时
    // 自动在同一 peerConnection 加第二个 video transceiver（stream id='overview'），
    // daemon 看到 composite target 会同步开 overview capture。overviewMediaStream 用于
    // 缩略图 drawImage + 切换瞬间主画面低清占位（同连接双流不进 canvas 预览流饿死 focus 路径）。
    void startStream(targetSessionId, effectiveTarget, focusStreamId, {
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
          // eslint-disable-next-line no-console
          console.log(`[remote-window-stream-start] committed=${committedStreamId} ` +
            `focusTracks=${committedResult.mediaStream?.getTracks?.().length ?? 0} ` +
            `overviewTracks=${committedResult.overviewMediaStream?.getTracks?.().length ?? 0} ` +
            `compositeWindows=${target.compositeWindows?.length ?? 0}`);
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
      : 'fit';
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
      const surfaceRect = videoSurfaceRef.current?.getBoundingClientRect();
      if (state.phase === 'targetLocked' && surfaceRect && surfaceRect.width > 0 && surfaceRect.height > 0) {
        const displaySourceSize = resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize, focusedWindowSlotRef.current);
        setFullscreenViewport((current) => clampFullscreenViewport(
          {
            scale: current.scale,
            panX: start.startPanX + effect.deltaX,
            panY: start.startPanY + effect.deltaY,
          },
          { width: surfaceRect.width, height: surfaceRect.height },
          displaySourceSize,
          fullscreenDisplayModeRef.current,
          Math.max(0, bottomInsetPx),
        ));
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
        // eslint-disable-next-line no-console
        console.log(`[remote-window-pinch] ABORT size<2 pointerId=${effect.pointerId}`);
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
      // eslint-disable-next-line no-console
      console.log(`[remote-window-pinch] commit=${effect.commit} ratio=${effect.scaleRatio.toFixed(3)} ` +
        `start=${start.startScale.toFixed(2)} -> ${nextScale.toFixed(2)} ` +
        `receiverStream=${receiverMediaStream ? 'ok' : 'NULL'} ` +
        `overviewStream=${overviewMediaStream ? 'ok' : 'NULL'} ` +
        `videoHasPlayed=${videoHasPlayedRef.current} ` +
        `videoReady=${videoElementRef.current?.readyState ?? 'NULL'} ` +
        `currentTime=${videoElementRef.current?.currentTime?.toFixed(2) ?? 'NULL'}`);
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
      const surfaceRect = videoSurfaceRef.current?.getBoundingClientRect();
      if (surfaceRect && surfaceRect.width > 0 && surfaceRect.height > 0) {
        const displaySourceSize = resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize, focusedWindowSlotRef.current);
        setFullscreenViewport((current) => clampFullscreenViewport(
          {
            scale: current.scale,
            panX: gesture.startPanX + deltaX,
            panY: gesture.startPanY + deltaY,
          },
          { width: surfaceRect.width, height: surfaceRect.height },
          displaySourceSize,
          fullscreenDisplayModeRef.current,
          Math.max(0, bottomInsetPx),
        ));
      } else {
        setFullscreenViewport({
          scale: fullscreenViewportRef.current.scale,
          panX: gesture.startPanX + deltaX,
          panY: gesture.startPanY + deltaY,
        });
      }
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
          <span
            data-testid={`remote-window-target-${groupPrimary.streamTargetId}`}
            style={styles.targetMeta}
          >
            {group.targets.length} 个窗口 · 打开后在视频内切换 · {formatTargetSubtitle(groupPrimary)}
          </span>
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
	      : 'fit';
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
  const overviewCropVisible = Boolean(
    overviewMediaStream
    && compositeLayout
    && focusedWindowSlot
    && dualStreamSwitch.phase === 'overview-crop-visible',
  );

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
          {overviewCropVisible ? (
            <canvas
              ref={compositeOverviewCanvasRef}
              data-testid="remote-window-overview-crop"
              width={1920}
              height={1080}
              style={{
                ...styles.videoElement,
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                zIndex: 2,
                opacity: 1,
              }}
            />
          ) : null}
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
              // 始终保持 video element 可见：避免任何同步抖动 / receiver/epoch 重置期间
              // videoHasPlayed 被设回 false 导致整画面变黑屏（缩放后 scroll 黑屏）。
              // opacity 由 videoHasPlayed 决定（首帧未到时 0），但 visibility 始终 visible，
              // 让浏览器持续解码新帧不让 video element 被回收，避免下一帧显示空帧。
              opacity: videoHasPlayed || dualStreamSwitch.phase === 'overview-crop-visible' ? 1 : 0,
              visibility: 'visible',
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
            {compositeLayout.windows.slice(1).map((slot) => (
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
                  const switchState = showRemoteWindowOverviewCrop(
                    beginRemoteWindowDualStreamSwitch(dualStreamSwitch, focusTarget?.streamTargetId || slot.windowId),
                    focusTarget?.streamTargetId || slot.windowId,
                    slot.windowId,
                  );
                  setDualStreamSwitch({
                    ...switchState,
                    focusStreamId: focusStreamId,
                  });
                  // eslint-disable-next-line no-console
                  console.log(`[remote-window-thumb-click] slot=${slot.windowId} ` +
                    `focusStreamId=${focusStreamId ?? 'NULL'} ` +
                    `focusTarget=${focusTarget ? 'ok' : 'NULL'} ` +
                    `updateFocus=${typeof updateFocus}`);
                  if (focusStreamId && focusTarget && updateFocus && activeSessionId) {
                    const focusStart = Date.now();
                    updateFocus(activeSessionId, focusStreamId, focusTarget, switchState.revision);
                    setTimeout(() => {
                      // eslint-disable-next-line no-console
                      console.log(`[remote-window-thumb-click] updateFocus dispatched (${Date.now() - focusStart}ms)`);
                    }, 0);
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
      const title = target.videoTarget.title || target.videoTarget.windowId || target.streamTargetId;
      return {
        id: target.streamTargetId,
        testId: `remote-window-video-window-option-${target.streamTargetId}`,
        roleLabel: `切换远程窗口 ${title}`,
        onPress: active ? undefined : () => {
          const focusStreamId = activeFocusStreamIdRef.current || activeStreamIdRef.current;
          const focusTarget = target;
          // eslint-disable-next-line no-console
          console.log(`[remote-window-group-click] target=${target.streamTargetId} ` +
            `window=${target.videoTarget.windowId} focusStream=${focusStreamId || '-'} ` +
            `catalogTargets=${state.targets.length}`);
          setFocusedWindowId(target.videoTarget.windowId);
          const switchState = showRemoteWindowOverviewCrop(
            beginRemoteWindowDualStreamSwitch(dualStreamSwitch, target.streamTargetId),
            target.streamTargetId,
            target.videoTarget.windowId,
          );
          setDualStreamSwitch({ ...switchState, focusStreamId });
          if (focusStreamId && focusTarget && updateFocus && activeSessionId) {
            updateFocus(activeSessionId, focusStreamId, focusTarget, switchState.revision);
          } else {
            setDualStreamSwitch((current) => failRemoteWindowDualStreamSwitch(
              current,
              !focusStreamId
                ? 'Remote window focus switch requires an active focus stream'
                : 'Remote window focus switch target is missing from the catalog',
            ));
          }
        },
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
        landscape={false}
        primaryItemId={state.target.streamTargetId}
        secondaryPlacement="before"
        secondaryWrap="nowrap"
        secondaryItemFlex="0 0 min(30%, 160px)"
        secondaryOverflowX="auto"
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
      data-dual-stream-phase={dualStreamSwitch.phase}
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
