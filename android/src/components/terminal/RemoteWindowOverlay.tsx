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
import { mobileTheme } from '../../lib/mobile-ui';
import type {
  RemoteWindowStreamErrorPayload,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
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

interface RemoteWindowOverlayProps {
  activeSessionId?: string | null;
  requestTargets?: (sessionId: string) => Promise<RemoteWindowStreamTargetsResponsePayload>;
  startStream?: (
    sessionId: string,
    target: RemoteWindowStreamTargetManifest,
    streamId: string,
  ) => Promise<RemoteWindowStreamStartResult>;
  stopStream?: (sessionId: string, streamId: string) => unknown;
  sendInput?: (
    sessionId: string,
    payload: Omit<RemoteWindowInputEventPayload, 'requestId'>,
  ) => void;
  bottomInsetPx?: number;
  onOpenStateChange?: (open: boolean) => void;
  onBodySubscriptionSuppressedChange?: (suppressed: boolean) => void;
  onInputContextChange?: (context: RemoteWindowInputContext | null) => void;
}

interface RemoteWindowStreamStartResult {
  streamId: string;
  mediaStream?: MediaStream | null;
  started?: RemoteWindowStreamStartedPayload;
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

interface FloatingOverlayOffset {
  x: number;
  y: number;
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

interface SurfacePointerPosition {
  clientX: number;
  clientY: number;
}

interface RemoteWindowSurfacePoint {
  x: number;
  y: number;
  normalizedX: number;
  normalizedY: number;
}

type SurfacePointerGesture =
  | {
      mode: 'input';
      pointerId: number;
    }
  | {
      mode: 'touchPending';
      pointerId: number;
      startClientX: number;
      startClientY: number;
      lastClientX: number;
      lastClientY: number;
    }
  | {
      mode: 'scroll';
      pointerId: number;
      lastClientX: number;
      lastClientY: number;
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

interface FloatingEntryDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  baseLeft: number;
  baseTop: number;
  width: number;
  height: number;
  active: boolean;
}

const FLOATING_OVERLAY_VIEWPORT_MARGIN_PX = 8;
const REMOTE_WINDOW_FLOATING_BOTTOM_BASE_PX = 118;
const FLOATING_ENTRY_VIEWPORT_MARGIN_PX = 10;
const FLOATING_ENTRY_TOP_MARGIN_PX = 28;
const FLOATING_ENTRY_DRAG_THRESHOLD_PX = 7;
const REMOTE_WINDOW_FULLSCREEN_MIN_SCALE = 1;
const REMOTE_WINDOW_FULLSCREEN_MAX_SCALE = 4;
const REMOTE_WINDOW_FULLSCREEN_PAN_TAP_THRESHOLD_PX = 8;
const REMOTE_WINDOW_TOUCH_SCROLL_THRESHOLD_PX = 8;
const REMOTE_WINDOW_CATALOG_UI_TIMEOUT_MS = 8_000;

const initialFullscreenViewport: FullscreenViewportState = {
  scale: 1,
  panX: 0,
  panY: 0,
};

function clampFloatingOffset(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getRemoteWindowSourceRect(target: RemoteWindowStreamTargetManifest) {
  return target.videoTarget.cropRectTopLeftPx || target.videoTarget.windowBoundsTopLeftPx;
}

function resolveAspectFitRect(surface: SurfaceSize, source: { width: number; height: number }): SurfaceRect {
  const surfaceWidth = Math.max(1, surface.width);
  const surfaceHeight = Math.max(1, surface.height);
  const sourceWidth = Math.max(1, source.width);
  const sourceHeight = Math.max(1, source.height);
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

function clampFullscreenViewport(
  viewport: FullscreenViewportState,
  surface: SurfaceSize | null,
  source: { width: number; height: number } | null,
): FullscreenViewportState {
  const scale = clampNumber(
    Number.isFinite(viewport.scale) ? viewport.scale : 1,
    REMOTE_WINDOW_FULLSCREEN_MIN_SCALE,
    REMOTE_WINDOW_FULLSCREEN_MAX_SCALE,
  );
  if (!surface || !source || scale <= 1) {
    return { scale, panX: 0, panY: 0 };
  }
  const fit = resolveAspectFitRect(surface, source);
  const maxPanX = Math.max(0, (fit.width * scale - fit.width) / 2);
  const maxPanY = Math.max(0, (fit.height * scale - fit.height) / 2);
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
): { fit: SurfaceRect; content: SurfaceRect } {
  const fit = resolveAspectFitRect(surface, source);
  const scale = Math.max(1, viewport.scale);
  const width = fit.width * scale;
  const height = fit.height * scale;
  return {
    fit,
    content: {
      left: fit.left + (fit.width - width) / 2 + viewport.panX,
      top: fit.top + (fit.height - height) / 2 + viewport.panY,
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

function formatTargetSubtitle(target: RemoteWindowStreamTargetManifest) {
  const tmux = target.inputTarget.tmuxSession
    ? `tmux ${target.inputTarget.tmuxSession}${target.inputTarget.tmuxPaneId ? ` ${target.inputTarget.tmuxPaneId}` : ''}`
    : '';
  const geometry = target.videoTarget.cropRectTopLeftPx || target.videoTarget.windowBoundsTopLeftPx;
  const route = formatInputRoute(target);
  return [tmux, `${geometry.width}x${geometry.height}`, route].filter(Boolean).join(' · ');
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
  requestTargets,
  startStream,
  stopStream,
  sendInput,
  bottomInsetPx = 0,
  onOpenStateChange,
  onBodySubscriptionSuppressedChange,
  onInputContextChange,
}: RemoteWindowOverlayProps) {
  const [state, setState] = useState<RemoteWindowOverlayState>(initialRemoteWindowOverlayState);
  const [floatingOffset, setFloatingOffsetState] = useState<FloatingOverlayOffset>({ x: 0, y: 0 });
  const [entryOffset, setEntryOffsetState] = useState<FloatingOverlayOffset>({ x: 0, y: 0 });
  const [surfaceSize, setSurfaceSize] = useState<SurfaceSize | null>(null);
  const [fullscreenViewport, setFullscreenViewportState] = useState<FullscreenViewportState>(initialFullscreenViewport);
  const [receiverMediaStream, setReceiverMediaStream] = useState<MediaStream | null>(null);
  const floatingOffsetRef = useRef(floatingOffset);
  const entryOffsetRef = useRef(entryOffset);
  const fullscreenViewportRef = useRef(fullscreenViewport);
  const floatingOverlayRef = useRef<HTMLDivElement | null>(null);
  const entryButtonRef = useRef<HTMLButtonElement | null>(null);
  const floatingDragRef = useRef<FloatingOverlayDrag | null>(null);
  const entryDragRef = useRef<FloatingEntryDrag | null>(null);
  const videoSurfaceRef = useRef<HTMLDivElement | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const activeStreamIdRef = useRef<string | null>(null);
  const surfacePointersRef = useRef<Map<number, SurfacePointerPosition>>(new Map());
  const surfaceGestureRef = useRef<SurfacePointerGesture | null>(null);
  const catalogWatchdogRef = useRef<number | null>(null);
  const catalogWatchdogEpochRef = useRef<number | null>(null);
  const lastTouchEndAtRef = useRef(0);
  const lastReportedQuickBarSuppressionRef = useRef<boolean | null>(null);
  const lastReportedBodySuppressionRef = useRef<boolean | null>(null);
  const lastReportedInputContextKeyRef = useRef<string | null>(null);
  const suppressEntryClickRef = useRef(false);
  const quickBarSuppressed = state.phase === 'targetEnumerating'
    || state.phase === 'pickerOpen';
  const bodySubscriptionSuppressed = state.phase === 'targetEnumerating'
    || state.phase === 'pickerOpen'
    || (state.phase === 'targetLocked' && state.mode === 'fullscreen');
  const inputContext = state.phase === 'targetLocked'
    && state.streamId
    && state.streamStatus !== 'error'
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

  const setFloatingOffset = useCallback((next: FloatingOverlayOffset) => {
    floatingOffsetRef.current = next;
    setFloatingOffsetState(next);
  }, []);

  const setEntryOffset = useCallback((next: FloatingOverlayOffset) => {
    entryOffsetRef.current = next;
    setEntryOffsetState(next);
  }, []);

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
      const sourceRect = state.phase === 'targetLocked' ? getRemoteWindowSourceRect(state.target) : null;
      const clamped = clampFullscreenViewport(raw, measuredSurfaceSize, sourceRect);
      fullscreenViewportRef.current = clamped;
      return clamped;
    });
  }, [readVideoSurfaceSize, state]);

  const resetFullscreenViewport = useCallback(() => {
    fullscreenViewportRef.current = initialFullscreenViewport;
    setFullscreenViewportState(initialFullscreenViewport);
    surfacePointersRef.current.clear();
    surfaceGestureRef.current = null;
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
      const sourceRect = getRemoteWindowSourceRect(state.target);
      setFullscreenViewportState((current) => {
        const clamped = clampFullscreenViewport(current, next, sourceRect);
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
  }, [state]);

  const handleOpenPicker = useCallback(() => {
    clearCatalogWatchdog();
    const started = beginRemoteWindowTargetEnumeration(state);
    setState(started.state);
    const targetSessionId = activeSessionId?.trim() || '';
    if (!targetSessionId || !requestTargets) {
      setState((current) => (
        failRemoteWindowTargetCatalog(current, started.requestEpoch, new Error('当前没有可用的 daemon session'))
      ));
      return;
    }

    catalogWatchdogEpochRef.current = started.requestEpoch;
    catalogWatchdogRef.current = window.setTimeout(() => {
      catalogWatchdogRef.current = null;
      catalogWatchdogEpochRef.current = null;
      setState((current) => (
        failRemoteWindowTargetCatalog(
          current,
          started.requestEpoch,
          new Error('远程窗口列表读取超时，请检查 daemon 窗口枚举能力'),
        )
      ));
    }, REMOTE_WINDOW_CATALOG_UI_TIMEOUT_MS);

    void requestTargets(targetSessionId)
      .then((payload) => {
        clearCatalogWatchdog(started.requestEpoch);
        setState((current) => applyRemoteWindowTargetCatalog(current, started.requestEpoch, payload));
      })
      .catch((error) => {
        clearCatalogWatchdog(started.requestEpoch);
        setState((current) => failRemoteWindowTargetCatalog(current, started.requestEpoch, error));
      });
  }, [activeSessionId, clearCatalogWatchdog, requestTargets, state]);

  const handleClose = useCallback(() => {
    clearCatalogWatchdog();
    floatingDragRef.current = null;
    surfacePointersRef.current.clear();
    surfaceGestureRef.current = null;
    if (state.phase === 'targetLocked' && state.streamId && activeSessionId && stopStream) {
      void Promise.resolve(stopStream(activeSessionId, state.streamId)).catch((error) => {
        console.error('[RemoteWindowOverlay] remote stream stop failed:', error);
      });
    }
    activeStreamIdRef.current = null;
    setReceiverMediaStream(null);
    setFloatingOffset({ x: 0, y: 0 });
    resetFullscreenViewport();
    setState((current) => closeRemoteWindowOverlay(current));
  }, [activeSessionId, clearCatalogWatchdog, resetFullscreenViewport, setFloatingOffset, state, stopStream]);

  const handleShrink = useCallback(() => {
    resetFullscreenViewport();
    setState((current) => shrinkRemoteWindowOverlay(current));
  }, [resetFullscreenViewport]);

  const handleFullscreen = useCallback(() => {
    resetFullscreenViewport();
    setState((current) => enterRemoteWindowFullscreen(current));
  }, [resetFullscreenViewport]);

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

  const handleFloatingDragStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      state.phase !== 'targetLocked'
      || state.mode !== 'floating'
      || (event.pointerType === 'mouse' && event.button !== 0)
      || (event.target instanceof Element && event.target.closest('button'))
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

  const handleEntryPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (state.phase !== 'closed') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const currentOffset = entryOffsetRef.current;
    entryDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      baseLeft: rect.left - currentOffset.x,
      baseTop: rect.top - currentOffset.y,
      width: rect.width || 44,
      height: rect.height || 44,
      active: false,
    };
  }, [state]);

  const handleEntryPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = entryDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (!drag.active && Math.hypot(deltaX, deltaY) >= FLOATING_ENTRY_DRAG_THRESHOLD_PX) {
      drag.active = true;
      suppressEntryClickRef.current = true;
    }
    if (!drag.active) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setEntryOffset(clampEntryOffset(
      drag,
      drag.baseLeft + deltaX,
      drag.baseTop + deltaY,
    ));
  }, [clampEntryOffset, setEntryOffset]);

  const handleEntryPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = entryDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      if (drag.active) {
        suppressEntryClickRef.current = true;
        window.setTimeout(() => {
          suppressEntryClickRef.current = false;
        }, 180);
      }
      entryDragRef.current = null;
    }
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch (error) {
      console.warn('[RemoteWindowOverlay] remote window entry pointer release failed:', error);
    }
  }, []);

  const handleEntryPointerCancel = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (entryDragRef.current?.pointerId === event.pointerId) {
      entryDragRef.current = null;
    }
    suppressEntryClickRef.current = false;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch (error) {
      console.warn('[RemoteWindowOverlay] remote window entry pointer cancel failed:', error);
    }
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (updateFloatingDragFromPointer(event.pointerId, event.clientX, event.clientY)) {
        event.preventDefault();
      }
    };
    const handlePointerEnd = (event: PointerEvent) => {
      finishFloatingDrag(event.pointerId);
    };
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      floatingDragRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [finishFloatingDrag, updateFloatingDragFromPointer]);

  useEffect(() => {
    const video = videoElementRef.current;
    if (!video) {
      return;
    }
    video.srcObject = receiverMediaStream;
  }, [receiverMediaStream, state]);

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
    resetFullscreenViewport();
    setReceiverMediaStream(null);

    if (!startStream) {
      setState((current) => selectRemoteWindowTarget(current, target.streamTargetId));
      return;
    }

    const targetSessionId = activeSessionId?.trim() || '';
    const streamId = `rw-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeStreamIdRef.current = streamId;
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
    void startStream(targetSessionId, target, streamId)
      .then((result) => {
        setState((current) => {
          return attachRemoteWindowStreamReceiver(startingState(current), result.streamId);
        });
        if (activeStreamIdRef.current === result.streamId) {
          setReceiverMediaStream(result.mediaStream || null);
        }
      })
      .catch((error) => {
        if (activeStreamIdRef.current === streamId) {
          setReceiverMediaStream(null);
        }
        setState((current) => failRemoteWindowStream(startingState(current), streamId, error));
      });
  }, [activeSessionId, resetFullscreenViewport, setFloatingOffset, startStream]);

  const emitRemoteWindowInput = useCallback((eventPayload: RemoteWindowInputEventPayload['event']) => {
    if (
      state.phase !== 'targetLocked'
      || !state.streamId
      || !activeSessionId
      || !sendInput
    ) {
      return false;
    }
    try {
      sendInput(activeSessionId, {
        streamId: state.streamId,
        targetId: state.target.streamTargetId,
        event: eventPayload,
      });
      return true;
    } catch (error) {
      console.warn('[RemoteWindowOverlay] remote input send failed:', error);
      return false;
    }
  }, [activeSessionId, sendInput, state]);

  const resolveSurfaceInputPoint = useCallback((
    clientX: number,
    clientY: number,
  ): RemoteWindowSurfacePoint | null => {
    if (state.phase !== 'targetLocked') {
      return null;
    }
    const surface = videoSurfaceRef.current;
    const surfaceRect = surface?.getBoundingClientRect();
    if (!surfaceRect || surfaceRect.width <= 0 || surfaceRect.height <= 0) {
      return null;
    }
    const sourceRect = getRemoteWindowSourceRect(state.target);
    const viewport = state.mode === 'fullscreen'
      ? fullscreenViewportRef.current
      : initialFullscreenViewport;
    const { content } = resolveZoomedContentRect(
      { width: surfaceRect.width, height: surfaceRect.height },
      sourceRect,
      viewport,
    );
    const normalizedX = clampNumber(
      (clientX - surfaceRect.left - content.left) / Math.max(1, content.width),
      0,
      1,
    );
    const normalizedY = clampNumber(
      (clientY - surfaceRect.top - content.top) / Math.max(1, content.height),
      0,
      1,
    );
    return {
      x: sourceRect.x + normalizedX * sourceRect.width,
      y: sourceRect.y + normalizedY * sourceRect.height,
      normalizedX,
      normalizedY,
    };
  }, [state]);

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
    const point = resolveSurfaceInputPoint(clientX, clientY);
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
  }, [resolveSurfaceInputPoint]);

  const emitPointerInput = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    phase: 'move' | 'down' | 'up',
  ) => {
    const pointerPayload = resolvePointerInputEvent(event, phase);
    if (pointerPayload) {
      emitRemoteWindowInput(pointerPayload);
    }
  }, [emitRemoteWindowInput, resolvePointerInputEvent]);

  const handleVideoSurfacePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (state.phase !== 'targetLocked') {
      return;
    }
    if (event.pointerType === 'mouse' && event.button > 2) {
      return;
    }
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
        mode: 'pinch',
        pointerIds: [first[0], second[0]],
        startDistance: Math.max(1, resolvePointerDistance(first[1], second[1])),
        startMidX: midpoint.clientX,
        startMidY: midpoint.clientY,
        startScale: fullscreenViewportRef.current.scale,
        startPanX: fullscreenViewportRef.current.panX,
        startPanY: fullscreenViewportRef.current.panY,
      };
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (state.mode === 'fullscreen' && fullscreenViewportRef.current.scale > 1.01) {
      surfaceGestureRef.current = {
        mode: 'pan',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPanX: fullscreenViewportRef.current.panX,
        startPanY: fullscreenViewportRef.current.panY,
        moved: false,
      };
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.pointerType === 'touch') {
      surfaceGestureRef.current = {
        mode: 'touchPending',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
      };
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    surfaceGestureRef.current = {
      mode: 'input',
      pointerId: event.pointerId,
    };
    emitPointerInput(event, 'down');
    event.preventDefault();
    event.stopPropagation();
  }, [emitPointerInput, state]);

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

    if (gesture.mode === 'pinch') {
      const first = surfacePointersRef.current.get(gesture.pointerIds[0]);
      const second = surfacePointersRef.current.get(gesture.pointerIds[1]);
      if (!first || !second) {
        return;
      }
      const midpoint = resolvePointerMidpoint(first, second);
      const distance = Math.max(1, resolvePointerDistance(first, second));
      setFullscreenViewport({
        scale: gesture.startScale * (distance / gesture.startDistance),
        panX: gesture.startPanX + midpoint.clientX - gesture.startMidX,
        panY: gesture.startPanY + midpoint.clientY - gesture.startMidY,
      });
      event.preventDefault();
      event.stopPropagation();
      return;
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

    if (gesture.mode === 'touchPending' && gesture.pointerId === event.pointerId) {
      const totalDeltaX = event.clientX - gesture.startClientX;
      const totalDeltaY = event.clientY - gesture.startClientY;
      if (Math.hypot(totalDeltaX, totalDeltaY) < REMOTE_WINDOW_TOUCH_SCROLL_THRESHOLD_PX) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const scrollPayload = resolveScrollInputEvent(
        event.clientX,
        event.clientY,
        gesture.lastClientX - event.clientX,
        gesture.lastClientY - event.clientY,
      );
      surfaceGestureRef.current = {
        mode: 'scroll',
        pointerId: event.pointerId,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
      };
      if (scrollPayload) {
        emitRemoteWindowInput(scrollPayload);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (gesture.mode === 'scroll' && gesture.pointerId === event.pointerId) {
      const scrollPayload = resolveScrollInputEvent(
        event.clientX,
        event.clientY,
        gesture.lastClientX - event.clientX,
        gesture.lastClientY - event.clientY,
      );
      surfaceGestureRef.current = {
        ...gesture,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
      };
      if (scrollPayload) {
        emitRemoteWindowInput(scrollPayload);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (gesture.mode === 'input' && gesture.pointerId === event.pointerId) {
      emitPointerInput(event, 'move');
      event.preventDefault();
      event.stopPropagation();
    }
  }, [emitPointerInput, emitRemoteWindowInput, resolveScrollInputEvent, setFullscreenViewport, state]);

  const handleVideoSurfacePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = surfaceGestureRef.current;
    surfacePointersRef.current.delete(event.pointerId);
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (!gesture) {
      return;
    }
    if (gesture.mode === 'input' && gesture.pointerId === event.pointerId) {
      emitPointerInput(event, 'up');
      surfaceGestureRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (gesture.mode === 'pan' && gesture.pointerId === event.pointerId) {
      if (!gesture.moved) {
        emitPointerInput(event, 'down');
        emitPointerInput(event, 'up');
      }
      surfaceGestureRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (gesture.mode === 'touchPending' && gesture.pointerId === event.pointerId) {
      emitPointerInput(event, 'down');
      emitPointerInput(event, 'up');
      surfaceGestureRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (gesture.mode === 'scroll' && gesture.pointerId === event.pointerId) {
      surfaceGestureRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (gesture.mode === 'pinch' && gesture.pointerIds.includes(event.pointerId)) {
      const remaining = Array.from(surfacePointersRef.current.entries())[0] || null;
      if (remaining && state.phase === 'targetLocked' && state.mode === 'fullscreen' && fullscreenViewportRef.current.scale > 1.01) {
        surfaceGestureRef.current = {
          mode: 'pan',
          pointerId: remaining[0],
          startClientX: remaining[1].clientX,
          startClientY: remaining[1].clientY,
          startPanX: fullscreenViewportRef.current.panX,
          startPanY: fullscreenViewportRef.current.panY,
          moved: false,
        };
      } else {
        surfaceGestureRef.current = null;
      }
      event.preventDefault();
      event.stopPropagation();
    }
  }, [emitPointerInput, state]);

  const handleVideoSurfacePointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = surfaceGestureRef.current;
    surfacePointersRef.current.delete(event.pointerId);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (
      gesture
      && (
        (gesture.mode !== 'pinch' && gesture.pointerId === event.pointerId)
        || (gesture.mode === 'pinch' && gesture.pointerIds.includes(event.pointerId))
      )
    ) {
      surfaceGestureRef.current = null;
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  const handleVideoSurfaceWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const scrollPayload = resolveScrollInputEvent(
      event.clientX,
      event.clientY,
      event.deltaX,
      event.deltaY,
    );
    if (!scrollPayload) {
      return;
    }
    emitRemoteWindowInput(scrollPayload);
    event.preventDefault();
    event.stopPropagation();
  }, [emitRemoteWindowInput, resolveScrollInputEvent]);

  const handleVideoSurfaceKey = useCallback((
    event: ReactKeyboardEvent<HTMLDivElement>,
    phase: 'down' | 'up',
  ) => {
    if (state.phase !== 'targetLocked' || !state.streamId) {
      return;
    }
    emitRemoteWindowInput({
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
  }, [emitRemoteWindowInput, state]);

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
    return (
      <div data-testid="remote-window-picker" style={styles.pickerPanel}>
        <div style={styles.panelHeader}>
          <div>
            <div style={styles.panelTitle}>远程窗口</div>
            <div style={styles.panelSubtitle}>
              {state.phase === 'targetEnumerating' ? '正在读取窗口列表' : `${state.targets.length} 个目标`}
            </div>
          </div>
          <div style={styles.panelActions}>
            <button type="button" aria-label="刷新远程窗口列表" onClick={handleOpenPicker} style={styles.headerButton}>
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
            state.targets.map((target) => (
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
            ))
          )}
        </div>
      </div>
    );
  }, [handleClose, handleOpenPicker, handleSelectTarget, state]);

  const lockedSurfaceLayout = useMemo(() => {
    if (state.phase !== 'targetLocked' || !surfaceSize) {
      return null;
    }
    const sourceRect = getRemoteWindowSourceRect(state.target);
    const viewport = state.mode === 'fullscreen' ? fullscreenViewport : initialFullscreenViewport;
    return resolveZoomedContentRect(surfaceSize, sourceRect, viewport);
  }, [fullscreenViewport, state, surfaceSize]);

  const minimapViewport = useMemo(() => {
    if (state.phase !== 'targetLocked' || state.mode !== 'fullscreen' || fullscreenViewport.scale <= 1.01 || !lockedSurfaceLayout) {
      return null;
    }
    return resolveRemoteWindowMinimapViewport(lockedSurfaceLayout.fit, lockedSurfaceLayout.content);
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

  const lockedVideoContent = state.phase === 'targetLocked' ? (() => {
    if (state.streamStarted && receiverMediaStream) {
      return (
        <video
          data-testid="remote-window-video"
          ref={videoElementRef}
          autoPlay
          muted
          playsInline
          style={styles.videoElement}
        />
      );
    }
    if (state.streamStatus === 'starting') {
      return (
        <div style={styles.videoFrame}>
          <div style={styles.videoStatus}>正在建立视频流</div>
          <div style={styles.videoMeta}>{formatTargetSubtitle(state.target)}</div>
        </div>
      );
    }
    if (state.streamStatus === 'error') {
      return (
        <div data-testid="remote-window-stream-error" style={{ ...styles.videoFrame, ...styles.videoError }}>
          <div style={styles.videoStatus}>视频流启动失败</div>
          <div style={styles.videoMeta}>{state.streamErrorMessage || 'remote window stream failed'}</div>
        </div>
      );
    }
    return (
      <div style={styles.videoFrame}>
        <div style={styles.videoStatus}>等待视频流</div>
        <div style={styles.videoMeta}>{formatTargetSubtitle(state.target)}</div>
      </div>
    );
  })() : null;

  const lockedSourceRect = state.phase === 'targetLocked'
    ? getRemoteWindowSourceRect(state.target)
    : null;
  const floatingOverlayStyle = state.phase === 'targetLocked' && state.mode === 'floating' && lockedSourceRect
    ? {
        ...styles.floatingOverlay,
        ...resolveFloatingOverlaySizing(lockedSourceRect),
        bottom: REMOTE_WINDOW_FLOATING_BOTTOM_BASE_PX + Math.max(0, bottomInsetPx),
        transform: `translate(${floatingOffset.x}px, ${floatingOffset.y}px)`,
      }
    : {
        ...styles.floatingOverlay,
        bottom: REMOTE_WINDOW_FLOATING_BOTTOM_BASE_PX + Math.max(0, bottomInsetPx),
        transform: `translate(${floatingOffset.x}px, ${floatingOffset.y}px)`,
      };
  const videoSurfaceStyle = state.phase === 'targetLocked' && state.mode === 'floating' && lockedSourceRect
    ? {
        ...styles.videoPlaceholder,
        flex: '0 0 auto',
        aspectRatio: `${Math.max(1, Math.round(lockedSourceRect.width))} / ${Math.max(1, Math.round(lockedSourceRect.height))}`,
        maxHeight: 'min(52vh, 420px)',
      }
    : styles.videoPlaceholder;

  const lockedContent = state.phase === 'targetLocked' ? (
    <div
      ref={floatingOverlayRef}
      data-testid="remote-window-locked-overlay"
      data-mode={state.mode}
      style={state.mode === 'fullscreen'
        ? styles.fullscreenOverlay
        : floatingOverlayStyle}
    >
      <div
        data-testid="remote-window-drag-handle"
        onPointerDown={handleFloatingDragStart}
        onPointerMove={handleFloatingDragMove}
        onPointerUp={handleFloatingDragEnd}
        onPointerCancel={handleFloatingDragEnd}
        style={{
          ...styles.lockedToolbar,
          cursor: state.mode === 'floating' ? 'move' : 'default',
          touchAction: state.mode === 'floating' ? 'none' : 'auto',
          userSelect: 'none',
        }}
      >
        <div style={styles.lockedTitle}>
          <span style={styles.targetKind}>{formatTargetKind(state.target)}</span>
          <span>{state.target.videoTarget.title || state.target.videoTarget.appBundleId}</span>
        </div>
        <div style={styles.lockedActions}>
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
    </>
  );
});

const styles: Record<string, CSSProperties> = {
  entryButton: {
    position: 'absolute',
    right: 14,
    zIndex: 22,
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
    width: 32,
    height: 32,
    borderRadius: 10,
    border: '1px solid rgba(151, 164, 186, 0.18)',
    background: 'rgba(36, 48, 72, 0.84)',
    color: '#edf4ff',
    fontWeight: 900,
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
    minHeight: 84,
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
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    padding: '7px 8px',
    background: 'rgba(13, 19, 31, 0.94)',
    borderBottom: '1px solid rgba(151, 164, 186, 0.14)',
  },
  lockedTitle: {
    minWidth: 0,
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
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
    background: '#000',
    outline: 'none',
    touchAction: 'none',
  },
  videoContentFrame: {
    position: 'absolute',
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
    background: '#000',
    pointerEvents: 'none',
  },
  videoContentFallback: {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
    background: '#000',
    pointerEvents: 'none',
  },
  videoFrame: {
    width: '100%',
    height: '100%',
    display: 'grid',
    placeItems: 'center',
    alignContent: 'center',
    gap: 8,
    border: '1px solid rgba(151, 164, 186, 0.12)',
    background: 'rgba(10, 16, 26, 0.82)',
  },
  videoElement: {
    width: '100%',
    height: '100%',
    display: 'block',
    objectFit: 'fill',
    background: '#000',
    pointerEvents: 'none',
  },
  videoError: {
    borderColor: 'rgba(248, 113, 113, 0.34)',
    background: 'rgba(64, 15, 22, 0.72)',
  },
  videoStatus: {
    fontSize: 14,
    fontWeight: 900,
    color: '#edf4ff',
  },
  videoMeta: {
    maxWidth: '90%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 11,
    color: 'rgba(237,244,255,0.62)',
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
