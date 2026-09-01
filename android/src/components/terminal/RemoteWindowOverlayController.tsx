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
import { useSharedDraggableDrag, SHARED_DRAG_SUPPRESS_CLICK_MS } from './draggable-bubble-shared';
import type {
  RemoteWindowCanvasLayoutV1,
  RemoteWindowStreamCapabilityTelemetry,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamStartedOfferV2Payload,
  RemoteWindowStreamPurpose,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowVideoPreference,
  RemoteWindowVideoProfile,
} from '../../lib/types';
import type { RemoteWindowControlMessage } from '../../lib/remote-window-message-runtime';
import type { RemoteWindowReceiverStartupTelemetry } from '../../lib/remote-window-receiver-runtime';
import {
  acceptRemoteWindowFocusReady,
  commitRemoteWindowFocusProjection,
  failRemoteWindowDualStreamSwitch,
  markRemoteWindowFocusUpdating,
  resetRemoteWindowDualStreamSwitch,
  type RemoteWindowDualStreamState,
} from '../../lib/remote-window-dual-stream-runtime';
import {
  applyRemoteWindowInputResultTarget,
  attachSameAppCompositeWindows,
  attachRemoteWindowStreamReceiver,
  beginRemoteWindowStreamHandoff,
  beginRemoteWindowStreamSetup,
  closeRemoteWindowOverlay,
  commitRemoteWindowStreamHandoff,
  enterRemoteWindowFullscreen,
  failRemoteWindowStreamCleanup,
  failRemoteWindowStreamHandoff,
  failRemoteWindowStream,
  initialRemoteWindowOverlayState,
  selectRemoteWindowTarget,
  shrinkRemoteWindowOverlay,
  type RemoteWindowStreamHandoffState,
  type RemoteWindowOverlayState,
} from '../../lib/remote-window-overlay-runtime';
import {
  getRemoteWindowSourceRect,
  readRemoteWindowVideoPreference,
  resolveInitialRemoteWindowVideoProfile,
  writeRemoteWindowVideoPreference,
  type RemoteWindowVideoStatsSample,
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
  REMOTE_WINDOW_DOUBLE_TAP_MS,
  REMOTE_WINDOW_DOUBLE_TAP_SLOP_PX,
  REMOTE_WINDOW_DUAL_STREAM_SWITCH_TIMEOUT_MS,
  REMOTE_WINDOW_FLOATING_BOTTOM_BASE_PX,
  REMOTE_WINDOW_FULLSCREEN_MAX_SCALE,
  REMOTE_WINDOW_FULLSCREEN_MIN_SCALE,
  REMOTE_WINDOW_FULLSCREEN_PAN_TAP_THRESHOLD_PX,
  REMOTE_WINDOW_SECOND_FINGER_UPGRADE_PX,
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
  SurfacePointerPosition,
  SurfacePointerGesture,
  FloatingOverlayResize,
  FloatingOverlayOffset,
  initialFullscreenViewport,
  initialFullscreenDisplayMode,
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
  pointerSampleFromReactEvent,
  toOverlayTouchGesture,
  toRemoteWindowTouchGestureState,
  getRemoteWindowAppGroupId,
  buildRemoteWindowAppTargetGroups,
} from './remote-window-overlay-helpers';
import { styles } from './remote-window-overlay-styles';
import { RemoteWindowDeveloperDiagnostics } from './RemoteWindowDeveloperDiagnostics';
import { RemoteWindowLockedToolbar } from './RemoteWindowLockedToolbar';
import { RemoteWindowTargetPicker } from './RemoteWindowTargetPicker';
import { RemoteWindowAppSwitch } from './RemoteWindowAppSwitch';
import { RemoteWindowMorePanel } from './RemoteWindowMorePanel';
import { useRemoteWindowQuality } from './useRemoteWindowQuality';
import {
  useRemoteWindowPlayback,
  type RemoteWindowVideoDebugSnapshot,
} from './useRemoteWindowPlayback';
import { useRemoteWindowCompositeCanvas } from './useRemoteWindowCompositeCanvas';
import { RemoteWindowVideoContent } from './RemoteWindowVideoContent';
import { useRemoteWindowCatalog } from './useRemoteWindowCatalog';
import {
  useRemoteWindowViewport,
} from './useRemoteWindowViewport';
import { useRemoteWindowFocusSwitch } from './useRemoteWindowFocusSwitch';
export type { RemoteWindowViewportDebugSnapshot } from './useRemoteWindowViewport';
export type {
  RemoteWindowLiveDiagnostics,
  RemoteWindowVideoDebugSnapshot,
} from './useRemoteWindowPlayback';
import { useRemoteWindowScreenshot } from './useRemoteWindowScreenshot';
import type { RemoteWindowScreenshotSaveResult } from './useRemoteWindowScreenshot';
export interface RemoteWindowOverlayProps {
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
    options: { videoProfile: RemoteWindowVideoProfile; purpose?: RemoteWindowStreamPurpose },
  ) => Promise<RemoteWindowStreamStartResult>;
  updateStreamQuality?: (
    sessionId: string,
    payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>,
  ) => Promise<RemoteWindowStreamQualityResultPayload>;
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
  started?: RemoteWindowStreamStartedPayload | RemoteWindowStreamStartedOfferV2Payload;
  startupTelemetry?: RemoteWindowReceiverStartupTelemetry;
  collectStats?: () => Promise<RemoteWindowVideoStatsSample | null>;
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

export const RemoteWindowOverlayController = memo(function RemoteWindowOverlayController({
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
  const [videoPreference, setVideoPreference] = useState<RemoteWindowVideoPreference>('smooth');
  const [qualityInteractionActive, setQualityInteractionActive] = useState(false);
  const qualityInteractionTimerRef = useRef<number | null>(null);
  const markQualityInteractionActive = useCallback(() => {
    setQualityInteractionActive(true);
    if (qualityInteractionTimerRef.current !== null) {
      window.clearTimeout(qualityInteractionTimerRef.current);
    }
    qualityInteractionTimerRef.current = window.setTimeout(() => {
      qualityInteractionTimerRef.current = null;
      setQualityInteractionActive(false);
    }, 600);
  }, []);
  useEffect(() => () => {
    if (qualityInteractionTimerRef.current !== null) {
      window.clearTimeout(qualityInteractionTimerRef.current);
    }
  }, []);
  const [touchScrollFraction] = useState<RemoteWindowTouchScrollFraction>(() => readRemoteWindowTouchScrollFraction());
  const [touchScrollInverted] = useState(() => readRemoteWindowTouchScrollInverted());
  const [inputMode, setInputMode] = useState<RemoteWindowInputMode>(() => readRemoteWindowInputMode());
  const inputModeRef = useRef(inputMode);
  const [focusedWindowId, setFocusedWindowId] = useState<string | null>(null);
  const [canvasLayout, setCanvasLayout] = useState<RemoteWindowCanvasLayoutV1 | null>(null);
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
  const focusDisplayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositeThumbCanvasRefs = useRef<Map<string, HTMLCanvasElement | null>>(new Map());
  const clearCompositeThumbCanvases = useCallback(() => {
    compositeThumbCanvasRefs.current.clear();
  }, []);
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
  // Daemon layout is the only canvas truth. This projection only renames
  // published rectangle fields for the existing canvas drawing surface.
  const compositeLayout = state.phase === 'targetLocked' && canvasLayout
    ? {
        windows: canvasLayout.windows.map((window) => ({
          windowId: window.windowId,
          offsetX: window.canvasRectPx.x,
          offsetY: window.canvasRectPx.y,
          width: window.canvasRectPx.width,
          height: window.canvasRectPx.height,
        })),
        canvasWidth: canvasLayout.canvasSize.width,
        canvasHeight: canvasLayout.canvasSize.height,
      }
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
  const [receiverMediaStream, setReceiverMediaStream] = useState<MediaStream | null>(null);
  const [overviewMediaStream, setOverviewMediaStream] = useState<MediaStream | null>(null);
  const [receiverFrameSize, setReceiverFrameSize] = useState<SurfaceSize | null>(null);
  const [receiverStartupTelemetry, setReceiverStartupTelemetry] = useState<RemoteWindowReceiverStartupTelemetry | null>(null);
  const [streamCapability, setStreamCapability] = useState<RemoteWindowStreamCapabilityTelemetry | null>(null);
  const [itermPaneTargetsExpanded, setItermPaneTargetsExpanded] = useState(false);
  const [appSwitchOpen, setAppSwitchOpen] = useState(false);
  const [streamStatusOpen, setStreamStatusOpen] = useState(false);
  const screenshotController = useRemoteWindowScreenshot({
    activeSessionId,
    requestScreenshot,
  });
  const screenshotStatus: RemoteWindowScreenshotStatus = screenshotController.status;
  const [entryOffset, setEntryOffsetState] = useState<FloatingEntryPosition>(() => readStoredEntryPosition());
  const floatingOffsetRef = useRef(floatingOffset);
  const floatingOverlayWidthPxRef = useRef(floatingOverlayWidthPx);
  const touchScrollFractionRef = useRef<RemoteWindowTouchScrollFraction>(touchScrollFraction);
  const touchScrollInvertedRef = useRef(touchScrollInverted);
  const entryOffsetRef = useRef(entryOffset);
  const suppressEntryClickRef = useRef(false);
  const entryButtonRef = useRef<HTMLButtonElement | null>(null);
  const floatingOverlayRef = useRef<HTMLDivElement | null>(null);
  const lockedToolbarRef = useRef<HTMLDivElement | null>(null);
  const floatingResizeRef = useRef<FloatingOverlayResize | null>(null);
  const videoSurfaceRef = useRef<HTMLDivElement | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const overviewVideoElementRef = useRef<HTMLVideoElement | null>(null);
  const activeStreamIdRef = useRef<string | null>(null);
  const activeCanvasStreamIdRef = useRef<string | null>(null);
  const activeFocusStreamIdRef = useRef<string | null>(null);
  const pendingFocusStreamIdRef = useRef<string | null>(null);
  const streamRequestEpochRef = useRef(0);
  const handoffEpochRef = useRef(0);
  const activeHandoffRef = useRef<RemoteWindowStreamHandoffState | null>(null);
  const handoffVideoVisibilityRef = useRef<boolean | null>(null);
  const lastDefaultFullscreenFillKeyRef = useRef<string | null>(null);
  const collectStreamStatsRef = useRef<(() => Promise<RemoteWindowVideoStatsSample | null>) | null>(null);
  const qualityStreamId = state.phase === 'targetLocked' ? state.streamId ?? null : null;
  const qualityTargetId = state.phase === 'targetLocked' ? state.target.streamTargetId : null;
  const {
    invalidatePlayback,
    liveDiagnostics: liveDiag,
    publishDebugSnapshot: publishVideoDebugSnapshot,
    requestBoundPlayback: requestBoundVideoPlayback,
    restoreRetainedPlayback: restoreRetainedReceiverPlayback,
    updateVisibility: updateReceiverVideoVisibility,
    videoDebugSnapshot,
    videoHasPlayed,
    videoHasPlayedRef,
  } = useRemoteWindowPlayback({
    receiverMediaStream,
    overviewMediaStream,
    streamStatus: state.phase === 'targetLocked' ? state.streamStatus : null,
    streamId: state.phase === 'targetLocked' ? state.streamId ?? null : null,
    videoElementRef,
    overviewVideoElementRef,
    onVideoDebug,
  });
  const {
    activeCatalogSyncError,
    catalogRefreshing,
    openPicker: handleOpenPicker,
    rememberTarget: rememberRemoteWindowCatalogTarget,
    resetCatalog,
  } = useRemoteWindowCatalog({
    activeSessionId,
    state,
    setState,
    requestTargets,
    activeStreamReady: state.phase === 'targetLocked' && Boolean(state.streamStarted && state.streamId),
    suspendActiveRefresh: state.phase === 'targetLocked'
      && state.streamId === activeCanvasStreamIdRef.current
      && pendingFocusStreamIdRef.current !== null,
    onOpenPicker: () => {
      setItermPaneTargetsExpanded(false);
      setAppSwitchOpen(false);
      setReceiverFrameSize(null);
      setReceiverStartupTelemetry(null);
      setStreamCapability(null);
    },
  });
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
  const lastTouchEndAtRef = useRef(0);
  const lastReportedQuickBarSuppressionRef = useRef<boolean | null>(null);
  const lastReportedBodySuppressionRef = useRef<boolean | null>(null);
  const lastReportedInputContextKeyRef = useRef<string | null>(null);
  const resetSurfaceGestures = useCallback(() => {
    surfacePointersRef.current.clear();
    surfaceGestureRef.current = null;
    surfacePinchStartRef.current = null;
  }, []);
  const {
    commitFullscreenViewport,
    fullscreenDisplayMode,
    fullscreenDisplayModeRef,
    fullscreenViewport,
    fullscreenViewportRef,
    handleDoubleTapZoom,
    resetFullscreenViewport,
    setFullscreenDisplayMode,
    setFullscreenViewport,
    surfaceSize,
    viewportDebugSnapshot,
  } = useRemoteWindowViewport({
    state,
    receiverFrameSize,
    focusedWindowSlotRef,
    videoSurfaceRef,
    floatingOverlayRef,
    bottomInsetPx,
    bottomChromeInsetPx,
    onResetGestures: resetSurfaceGestures,
  });
  const {
    activeProfile,
    adaptiveCause,
    networkQuality,
    qualityApplyState,
    resetQualityState: resetQualityApplyState,
  } = useRemoteWindowQuality({
    activeSessionId,
    streamId: qualityStreamId,
    targetId: qualityTargetId,
    mediaPlan: streamCapability?.mediaPlan ?? null,
    streamReady: state.phase === 'targetLocked' && Boolean(state.streamStarted),
    focusStreamActive: Boolean(qualityStreamId && activeFocusStreamIdRef.current === qualityStreamId),
    videoPreference,
    interactionActive: qualityInteractionActive,
    updateStreamQuality,
    collectStatsRef: collectStreamStatsRef,
  });
  const switchRemoteWindowFocus = useRemoteWindowFocusSwitch({
    activeSessionId,
    activeStreamIdRef,
    activeFocusStreamIdRef,
    dualStreamState: dualStreamSwitch,
    setDualStreamState: setDualStreamSwitch,
    setFocusedWindowId,
    updateFocus,
  });
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
        layoutGeneration: canvasLayout?.layoutGeneration,
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
  }, [canvasLayout?.layoutGeneration, onInputDebug, sendInput]);

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
    if (events.length > 0) {
      markQualityInteractionActive();
    }
    return sendRemoteWindowInputEventsForTarget({
      sessionId: activeSessionId,
      streamId: currentLockedStreamId,
      target: currentLockedTarget,
      events,
    });
  }, [activeSessionId, currentLockedStreamId, currentLockedTarget, markQualityInteractionActive, sendRemoteWindowInputEventsForTarget, state.phase]);

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

  const handleClose = useCallback(() => {
    resetCatalog();
    setItermPaneTargetsExpanded(false);
    setAppSwitchOpen(false);
    lastDefaultFullscreenFillKeyRef.current = null;
    floatingResizeRef.current = null;
    surfacePointersRef.current.clear();
    surfaceGestureRef.current = null;
    surfacePinchStartRef.current = null;
    screenshotController.reset();
    activeHandoffRef.current = null;
    handoffVideoVisibilityRef.current = null;
    streamRequestEpochRef.current += 1;
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
    resetQualityApplyState();
    setReceiverMediaStream(null);
    setOverviewMediaStream(null);
    setReceiverFrameSize(null);
    setReceiverStartupTelemetry(null);
    setStreamCapability(null);
    setCanvasLayout(null);
    clearCompositeThumbCanvases();
    collectStreamStatsRef.current = null;
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
    resetCatalog,
    resetFullscreenViewport,
    setFloatingOffset,
    setFloatingOverlayWidthPx,
    setFullscreenDisplayMode,
    state,
    stopStream,
    clearCompositeThumbCanvases,
    resetQualityApplyState,
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
    resetQualityApplyState();
    surfacePointersRef.current.clear();
    surfaceGestureRef.current = null;
    surfacePinchStartRef.current = null;
    setReceiverMediaStream(null);
    setOverviewMediaStream(null);
    setReceiverFrameSize(null);
    setReceiverStartupTelemetry(null);
    setStreamCapability(null);
    setCanvasLayout(null);
    setState((current) => failRemoteWindowStream(
      current,
      streamInvalidation.streamId,
      new Error(streamInvalidation.message || 'remote window stream is no longer active'),
    ));
  }, [currentLockedStreamId, resetQualityApplyState, state.phase, streamInvalidation]);

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

  const handleCanvasProjectionError = useCallback((message: string) => {
    const streamId = activeStreamIdRef.current;
    if (!streamId) {
      return;
    }
    activeStreamIdRef.current = null;
    activeCanvasStreamIdRef.current = null;
    activeFocusStreamIdRef.current = null;
    pendingFocusStreamIdRef.current = null;
    collectStreamStatsRef.current = null;
    resetQualityApplyState();
    setReceiverMediaStream(null);
    setOverviewMediaStream(null);
    setReceiverFrameSize(null);
    setReceiverStartupTelemetry(null);
    setStreamCapability(null);
    setCanvasLayout(null);
    updateReceiverVideoVisibility(false);
    setState((current) => failRemoteWindowStream(current, streamId, new Error(message)));
    const targetSessionId = activeSessionId?.trim() || '';
    if (!targetSessionId || !stopStream) {
      return;
    }
    void Promise.resolve(stopStream(targetSessionId, streamId)).catch((error) => {
      const cleanupMessage = error instanceof Error ? error.message : String(error);
      setState((current) => failRemoteWindowStream(
        current,
        streamId,
        new Error(`${message}; stream cleanup failed: ${cleanupMessage}`),
      ));
    });
  }, [
    activeSessionId,
    resetQualityApplyState,
    stopStream,
    updateReceiverVideoVisibility,
  ]);

  useEffect(() => {
    if (lastReportedQuickBarSuppressionRef.current === quickBarSuppressed) {
      return;
    }
    lastReportedQuickBarSuppressionRef.current = quickBarSuppressed;
    onOpenStateChange?.(quickBarSuppressed);
  }, [onOpenStateChange, quickBarSuppressed]);

  useRemoteWindowCompositeCanvas({
    layout: compositeLayout,
    focusedWindow: focusedWindowSlot,
    overviewCropVisible: dualStreamSwitch.phase === 'overview-crop-visible',
    receiverMediaStream,
    overviewMediaStream,
    videoElementRef,
    overviewVideoElementRef,
    overviewCanvasRef: compositeOverviewCanvasRef,
    focusDisplayCanvasRef,
    thumbnailCanvasRefs: compositeThumbCanvasRefs,
    onProjectionError: handleCanvasProjectionError,
  });

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
      if (msg.type === 'remote-window-stream-status') {
        if (msg.payload.streamId !== activeStreamIdRef.current) {
          return;
        }
        if (msg.payload.phase === 'stopped') {
          const stoppedStreamId = activeStreamIdRef.current;
          if (!stoppedStreamId) {
            return;
          }
          activeStreamIdRef.current = null;
          if (stoppedStreamId === activeCanvasStreamIdRef.current) {
            activeCanvasStreamIdRef.current = null;
          }
          if (stoppedStreamId === activeFocusStreamIdRef.current) {
            activeFocusStreamIdRef.current = null;
          }
          if (stoppedStreamId === pendingFocusStreamIdRef.current) {
            pendingFocusStreamIdRef.current = null;
          }
          collectStreamStatsRef.current = null;
          resetQualityApplyState();
          surfacePointersRef.current.clear();
          surfaceGestureRef.current = null;
          surfacePinchStartRef.current = null;
          setReceiverMediaStream(null);
          setOverviewMediaStream(null);
          setReceiverFrameSize(null);
          setReceiverStartupTelemetry(null);
          setStreamCapability(null);
          setCanvasLayout(null);
          setState((current) => failRemoteWindowStream(
            current,
            stoppedStreamId,
            new Error(msg.payload.message || 'remote window stream stopped'),
          ));
          return;
        }
        if (msg.payload.stage === 'capability-verified' && msg.payload.capability) {
          setStreamCapability(msg.payload.capability);
        }
        if (msg.payload.canvasLayout) {
          setCanvasLayout((current) => (
            !current || msg.payload.canvasLayout!.layoutGeneration > current.layoutGeneration
              ? msg.payload.canvasLayout!
              : current
          ));
        }
        return;
      }
      if (msg.type !== 'remote-window-input-ack' || msg.control.accepted !== true) {
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

  useEffect(() => () => {
    lastReportedQuickBarSuppressionRef.current = false;
    lastReportedBodySuppressionRef.current = false;
    lastReportedInputContextKeyRef.current = null;
    onOpenStateChange?.(false);
    onBodySubscriptionSuppressedChange?.(false);
    onInputContextChange?.(null);
  }, [onBodySubscriptionSuppressedChange, onInputContextChange, onOpenStateChange]);

  const handleSelectTarget = useCallback((target: RemoteWindowStreamTargetManifest) => {
    const catalogTargets = 'targets' in state ? state.targets : [];
    const effectiveTarget = updateFocus
      ? attachSameAppCompositeWindows(target, catalogTargets)
      : target;
    const streamRequestEpoch = ++streamRequestEpochRef.current;
    invalidatePlayback();
    const previousStreamId = state.phase === 'targetLocked' && state.streamStarted ? state.streamId || null : null;
    const previousHadStream = Boolean(previousStreamId);
    const previousVideoWasVisible = previousHadStream
      ? handoffVideoVisibilityRef.current ?? videoHasPlayedRef.current
      : videoHasPlayedRef.current;
    setAppSwitchOpen(false);
    resetCatalog();
    if (!previousHadStream) {
      lastDefaultFullscreenFillKeyRef.current = null;
      setFloatingOffset({ x: 0, y: 0 });
      setFloatingOverlayWidthPx(null);
      resetQualityApplyState();
      screenshotController.reset();
      resetFullscreenViewport();
      setFullscreenDisplayMode(initialFullscreenDisplayMode);
      setReceiverMediaStream(null);
      setOverviewMediaStream(null);
      setReceiverFrameSize(null);
      setReceiverStartupTelemetry(null);
      setStreamCapability(null);
    }
    // Every target change starts a new receiver lifecycle. Keep the browser's
    // native video placeholder hidden until this receiver has a real frame.
    updateReceiverVideoVisibility(false);
    const selectedVideoPreference = readRemoteWindowVideoPreference(target);
    if (!previousHadStream) {
      setVideoPreference(selectedVideoPreference);
    }
    const videoProfile = resolveInitialRemoteWindowVideoProfile(selectedVideoPreference, networkQuality);

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
      resetQualityApplyState();
      setState(startingState);
    }
    // 单连接双 transceiver：receiver/runtime 在 target.compositeWindows 非空时
    // 自动在同一 peerConnection 加第二个 video transceiver（stream id='overview'），
    // daemon 看到 composite target 会同步开 overview capture。overviewMediaStream 用于
    // 缩略图 drawImage + 切换瞬间主画面低清占位（同连接双流不进 canvas 预览流饿死 focus 路径）。
    void startStream(targetSessionId, effectiveTarget, focusStreamId, {
      videoProfile,
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
        const committedResult = focusResult;
        const committedStreamId = focusResult?.streamId ?? '';
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
          resetQualityApplyState();
          screenshotController.reset();
          resetFullscreenViewport();
          setFullscreenDisplayMode(initialFullscreenDisplayMode);
          setVideoPreference(selectedVideoPreference);
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
          resetQualityApplyState();
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
          setReceiverStartupTelemetry(committedResult.startupTelemetry ?? null);
          setCanvasLayout(committedResult.started?.canvasLayout ?? null);
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
        setReceiverFrameSize(null);
        setReceiverStartupTelemetry(null);
        setStreamCapability(null);
        updateReceiverVideoVisibility(false);
        collectStreamStatsRef.current = null;
        resetQualityApplyState();
        activeCanvasStreamIdRef.current = null;
        activeFocusStreamIdRef.current = null;
        if (pendingFocusStreamIdRef.current === focusStreamId) {
          pendingFocusStreamIdRef.current = null;
        }
        setState((current) => failRemoteWindowStream(startingState(current), canvasStreamId, error));
      });
  }, [
    activeSessionId,
    invalidatePlayback,
    networkQuality,
    resetCatalog,
    resetQualityApplyState,
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
    void screenshotController.capture(state.target);
  }, [screenshotController, state]);

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
    if (effect.kind !== 'none') {
      markQualityInteractionActive();
    }
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
      commitFullscreenViewport();
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
      commitFullscreenViewport();
    }
  }, [
    bottomInsetPx,
    commitFullscreenViewport,
    markQualityInteractionActive,
    receiverFrameSize,
    setFullscreenViewport,
    state,
  ]);

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
    if (runtimeGesture.mode === 'twoFingerCandidate' || runtimeGesture.mode === 'twoFingerScroll' || runtimeGesture.mode === 'twoFingerPan' || runtimeGesture.mode === 'pinch') {
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
        scrollEnabled: fullscreenViewportRef.current.scale <= REMOTE_WINDOW_FULLSCREEN_MIN_SCALE,
        panEnabled: state.mode === 'fullscreen'
          && fullscreenViewportRef.current.scale > REMOTE_WINDOW_FULLSCREEN_MIN_SCALE,
      });
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
      commitFullscreenViewport();
      surfaceGestureRef.current = null;
      surfacePointersRef.current.delete(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (runtimeGesture.mode === 'twoFingerCandidate' || runtimeGesture.mode === 'twoFingerScroll' || runtimeGesture.mode === 'twoFingerPan' || runtimeGesture.mode === 'pinch') {
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
        remainingPointerMode: 'remote-action',
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
    commitFullscreenViewport,
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
        || (runtimeGesture.mode === 'twoFingerCandidate' || runtimeGesture.mode === 'twoFingerScroll' || runtimeGesture.mode === 'twoFingerPan' || runtimeGesture.mode === 'pinch')
      )
    ) {
      if (runtimeGesture.mode !== 'idle' && runtimeGesture.mode !== 'twoFingerCandidate' && runtimeGesture.mode !== 'twoFingerScroll' && runtimeGesture.mode !== 'twoFingerPan' && runtimeGesture.mode !== 'pinch') {
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

  const pickerContent = state.phase === 'targetEnumerating' || state.phase === 'pickerOpen' ? (
    <RemoteWindowTargetPicker
      phase={state.phase}
      targets={state.phase === 'pickerOpen' ? state.targets : []}
      errors={state.phase === 'pickerOpen' ? state.errors : []}
      errorMessage={state.phase === 'pickerOpen' ? state.errorMessage ?? null : null}
      catalogRefreshing={catalogRefreshing}
      itermPaneTargetsExpanded={itermPaneTargetsExpanded}
      onToggleItermPaneTargets={() => setItermPaneTargetsExpanded((current) => !current)}
      onSelectTarget={handleSelectTarget}
      onRefresh={() => handleOpenPicker({ forceRefresh: true })}
      onClose={handleClose}
    />
  ) : null;

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

  const lockedVideoContent = state.phase === 'targetLocked' ? (
    <RemoteWindowVideoContent
      streamStarted={state.streamStarted}
      streamStatus={state.streamStatus}
      streamErrorMessage={state.streamErrorMessage}
      target={state.target}
      receiverAttached={Boolean(receiverMediaStream)}
      overviewCropVisible={overviewCropVisible}
      videoHasPlayed={videoHasPlayed}
      focusedVideoStyle={focusedVideoStyle}
      overviewCanvasRef={compositeOverviewCanvasRef}
      videoElementRef={videoElementRef}
      overviewVideoElementRef={overviewVideoElementRef}
      focusDisplayCanvasRef={focusDisplayCanvasRef}
      onVideoLifecycle={(event) => {
        publishVideoDebugSnapshot(event);
        requestBoundVideoPlayback();
      }}
    />
  ) : null;

  const lockedDisplaySourceSize = state.phase === 'targetLocked'
    ? resolveRemoteWindowDisplaySourceSize(state.target, receiverFrameSize, focusedWindowSlotRef.current)
    : null;
  const lockedSwitchTargets = useMemo(() => {
    if (state.phase !== 'targetLocked') {
      return [] as RemoteWindowStreamTargetManifest[];
    }
    return state.targets.some((target) => target.streamTargetId === state.target.streamTargetId)
      ? state.targets
      : [state.target, ...state.targets];
  }, [state]);

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
                  const focusTarget = state.targets.find(
                    (item) => item.videoTarget.windowId === slot.windowId,
                  ) ?? null;
                  switchRemoteWindowFocus({
                    target: focusTarget,
                    targetId: focusTarget?.streamTargetId || slot.windowId,
                    windowId: slot.windowId,
                  });
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
          switchRemoteWindowFocus({
            target,
            targetId: target.streamTargetId,
            windowId: target.videoTarget.windowId,
          });
        },
        node: active ? lockedVideoSurfaceNode : (() => {
          return (
            <div
              data-remote-window-child-tile="true"
              style={styles.videoWindowGroupTile}
            >
              <div style={styles.videoWindowGroupThumb}>
                <canvas
                  ref={(node) => {
                    compositeThumbCanvasRefs.current.set(target.streamTargetId, node);
                  }}
                  data-testid={`remote-window-video-window-thumbnail-${target.streamTargetId}`}
                  width={160}
                  height={120}
                  style={styles.videoWindowGroupThumbImage}
                />
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
  const lockedAppSwitchContent = state.phase === 'targetLocked' ? (
    <RemoteWindowAppSwitch
      targets={lockedSwitchTargets}
      activeTargetId={state.target.streamTargetId}
      catalogSyncError={activeCatalogSyncError}
      onSelectTarget={handleSelectTarget}
      onDismiss={() => setAppSwitchOpen(false)}
    />
  ) : null;

  const lockedMoreContent = state.phase === 'targetLocked' ? (
    <RemoteWindowMorePanel
      fullscreen={state.mode === 'fullscreen'}
      videoPreference={videoPreference}
      streamStatusText={`串流：${state.streamStatus === 'streaming' ? '已连接' : state.streamStatus} · ${activeProfile.maxBitrateBps / 1_000_000} Mbps / ${activeProfile.maxFrameRateFps} FPS${qualityApplyState.phase === 'requested' ? ' · 正在应用' : qualityApplyState.phase === 'rejected' ? ` · 失败：${qualityApplyState.message}` : ''}`}
      networkStatusText={`压力：${adaptiveCause === 'none' ? '无' : adaptiveCause} · 网络：${networkQuality?.effectiveType || '未知'}${networkQuality?.rttMs ? ` · RTT ${networkQuality.rttMs}ms` : ''}`}
      onToggleFullscreenDisplayMode={handleToggleFullscreenDisplayMode}
      onVideoPreferenceChange={(preference) => {
        setVideoPreference(preference);
        writeRemoteWindowVideoPreference(state.target, preference);
        resetQualityApplyState();
      }}
      developerDiagnostics={<RemoteWindowDeveloperDiagnostics
        activeSessionId={activeSessionId}
        appForegroundActive={appForegroundActive !== false}
        canvasLayout={canvasLayout}
        liveDiagnostics={liveDiag}
        receiverAttached={Boolean(receiverMediaStream)}
        receiverFrameSize={receiverFrameSize}
        state={state}
        videoDebugSnapshot={videoDebugSnapshot}
        videoHasPlayed={videoHasPlayed}
        viewportDebugSnapshot={viewportDebugSnapshot}
        startupTelemetry={receiverStartupTelemetry}
        streamCapability={streamCapability}
      />}
    />
  ) : null;

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
      <RemoteWindowLockedToolbar
          ref={lockedToolbarRef}
          activeTitle={state.target.videoTarget.title || state.target.videoTarget.appBundleId}
          appSwitchContent={lockedAppSwitchContent}
          appSwitchOpen={appSwitchOpen}
          dragHandleProps={{
            onPointerDown: floatingDragHandlers.onPointerDown,
            onPointerMove: floatingDragHandlers.onPointerMove,
            onPointerUp: floatingDragHandlers.onPointerUp,
            onPointerCancel: floatingDragHandlers.onPointerCancel,
            onTouchStart: floatingDragHandlers.onTouchStart,
            onTouchMove: floatingDragHandlers.onTouchMove,
            onTouchEnd: floatingDragHandlers.onTouchEnd,
            onTouchCancel: floatingDragHandlers.onTouchCancel,
            style: {
              ...styles.lockedTopBar,
              cursor: state.mode === 'floating' ? 'move' : 'default',
              touchAction: state.mode === 'floating' ? 'none' : 'auto',
              userSelect: 'none',
            },
          }}
          gestureGuide={inputMode === 'touch' ? '触控：拖动滚动，双指滚动或缩放' : '鼠标：移动指针，按住拖拽'}
          inputMode={inputMode}
          inputSupported={isRemoteWindowInputSupported(state.target)}
          mode={state.mode}
          moreContent={lockedMoreContent}
          moreOpen={streamStatusOpen}
          screenshotBusy={screenshotBusy}
          screenshotButtonStyle={screenshotButtonStyle}
          targetKindLabel={formatTargetKind(state.target)}
          onClose={handleClose}
          onFullscreen={handleFullscreen}
          onRequestKeyboard={handleRequestKeyboard}
          onScreenshot={handleRemoteWindowScreenshot}
          onShrink={handleShrink}
          onToggleAppSwitch={() => setAppSwitchOpen((current) => !current)}
          onToggleInputMode={handleToggleInputMode}
          onToggleMore={() => setStreamStatusOpen((current) => !current)}
        />
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
