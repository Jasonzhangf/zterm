import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { RemoteWindowOverlayState } from '../../lib/remote-window-overlay-runtime';
import { REMOTE_WINDOW_FULLSCREEN_MAX_SCALE } from './remote-window-overlay-constants';
import {
  clampFullscreenViewport,
  initialFullscreenDisplayMode,
  initialFullscreenViewport,
  resolveRemoteWindowDisplaySourceSize,
  type FullscreenDisplayMode,
  type FullscreenViewportState,
  type SurfaceSize,
} from './remote-window-overlay-helpers';
import type { RemoteWindowCompositeCanvasSlot } from './useRemoteWindowCompositeCanvas';

export interface RemoteWindowViewportDebugSnapshot {
  event: string;
  window: string;
  visualViewport: string;
  surface: string;
  overlay: string;
  updatedAt: number;
}

export interface UseRemoteWindowViewportOptions {
  state: RemoteWindowOverlayState;
  receiverFrameSize: SurfaceSize | null;
  focusedWindowSlotRef: RefObject<RemoteWindowCompositeCanvasSlot | null>;
  videoSurfaceRef: RefObject<HTMLDivElement | null>;
  floatingOverlayRef: RefObject<HTMLDivElement | null>;
  bottomInsetPx: number;
  bottomChromeInsetPx: number;
  onResetGestures: () => void;
}

export function useRemoteWindowViewport({
  state,
  receiverFrameSize,
  focusedWindowSlotRef,
  videoSurfaceRef,
  floatingOverlayRef,
  bottomInsetPx,
  bottomChromeInsetPx,
  onResetGestures,
}: UseRemoteWindowViewportOptions) {
  const [surfaceSize, setSurfaceSize] = useState<SurfaceSize | null>(null);
  const [fullscreenViewport, setFullscreenViewportState] = useState<FullscreenViewportState>(initialFullscreenViewport);
  const [fullscreenDisplayMode, setFullscreenDisplayModeState] = useState<FullscreenDisplayMode>(initialFullscreenDisplayMode);
  const [viewportDebugSnapshot, setViewportDebugSnapshot] = useState<RemoteWindowViewportDebugSnapshot | null>(null);
  const fullscreenViewportRef = useRef(fullscreenViewport);
  const fullscreenDisplayModeRef = useRef<FullscreenDisplayMode>(fullscreenDisplayMode);
  const lastAutoImePanRef = useRef<{ key: string; panY: number } | null>(null);
  const pendingViewportRef = useRef<FullscreenViewportState | null>(null);
  const pendingViewportFrameRef = useRef<number | null>(null);

  const readSurfaceSize = useCallback((): SurfaceSize | null => {
    const rect = videoSurfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return surfaceSize;
    }
    return { width: rect.width, height: rect.height };
  }, [surfaceSize, videoSurfaceRef]);

  const setFullscreenViewport = useCallback((
    next: FullscreenViewportState | ((current: FullscreenViewportState) => FullscreenViewportState),
  ) => {
    const measuredSurfaceSize = readSurfaceSize();
    if (measuredSurfaceSize) {
      setSurfaceSize((current) => (
        current
        && current.width === measuredSurfaceSize.width
        && current.height === measuredSurfaceSize.height
          ? current
          : measuredSurfaceSize
      ));
    }
    const raw = typeof next === 'function' ? next(fullscreenViewportRef.current) : next;
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
    pendingViewportRef.current = clamped;
    if (pendingViewportFrameRef.current === null) {
      pendingViewportFrameRef.current = window.requestAnimationFrame(() => {
        pendingViewportFrameRef.current = null;
        const pending = pendingViewportRef.current;
        pendingViewportRef.current = null;
        if (pending) {
          setFullscreenViewportState(pending);
        }
      });
    }
  }, [bottomInsetPx, focusedWindowSlotRef, readSurfaceSize, receiverFrameSize, state]);

  const commitFullscreenViewport = useCallback(() => {
    if (pendingViewportFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingViewportFrameRef.current);
      pendingViewportFrameRef.current = null;
    }
    const pending = pendingViewportRef.current;
    pendingViewportRef.current = null;
    if (pending) {
      setFullscreenViewportState(pending);
    }
  }, []);

  const resetFullscreenViewport = useCallback(() => {
    if (pendingViewportFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingViewportFrameRef.current);
      pendingViewportFrameRef.current = null;
    }
    pendingViewportRef.current = null;
    fullscreenViewportRef.current = initialFullscreenViewport;
    setFullscreenViewportState(initialFullscreenViewport);
    lastAutoImePanRef.current = null;
    onResetGestures();
  }, [onResetGestures]);

  const handleDoubleTapZoom = useCallback((clientX: number, clientY: number) => {
    if (!readSurfaceSize()) {
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
    commitFullscreenViewport();
  }, [commitFullscreenViewport, readSurfaceSize, setFullscreenViewport]);

  const setFullscreenDisplayMode = useCallback((next: FullscreenDisplayMode) => {
    fullscreenDisplayModeRef.current = next;
    setFullscreenDisplayModeState(next);
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
      const displaySourceSize = resolveRemoteWindowDisplaySourceSize(
        state.target,
        receiverFrameSize,
        focusedWindowSlotRef.current,
      );
      const displayMode = state.mode === 'fullscreen' ? fullscreenDisplayMode : 'fit';
      const clamped = clampFullscreenViewport(
        fullscreenViewportRef.current,
        next,
        displaySourceSize,
        displayMode,
        bottomInsetPx,
      );
      fullscreenViewportRef.current = clamped;
      setFullscreenViewportState(clamped);
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
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => scheduleStableUpdate('resize-observer'));
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
  }, [bottomInsetPx, floatingOverlayRef, focusedWindowSlotRef, fullscreenDisplayMode, receiverFrameSize, state, videoSurfaceRef]);

  useEffect(() => () => {
    if (pendingViewportFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingViewportFrameRef.current);
    }
    pendingViewportFrameRef.current = null;
    pendingViewportRef.current = null;
  }, []);

  useEffect(() => {
    if (state.phase !== 'targetLocked' || state.mode !== 'fullscreen' || !surfaceSize) {
      lastAutoImePanRef.current = null;
      return;
    }
    const safeBottomInsetPx = Math.max(0, Math.round(bottomInsetPx));
    const safeChromeInsetPx = Math.max(0, Math.min(safeBottomInsetPx, Math.round(bottomChromeInsetPx)));
    const keyboardLiftPx = safeBottomInsetPx - safeChromeInsetPx;
    if (safeBottomInsetPx <= 0 || safeChromeInsetPx <= 0 || keyboardLiftPx <= 0) {
      lastAutoImePanRef.current = null;
      return;
    }
    const displaySourceSize = resolveRemoteWindowDisplaySourceSize(
      state.target,
      receiverFrameSize,
      focusedWindowSlotRef.current,
    );
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
    const current = fullscreenViewportRef.current;
    const lastAutoPan = lastAutoImePanRef.current;
    const manualPanActive = lastAutoPan
      ? Math.abs(current.panY - lastAutoPan.panY) > 1
      : Math.abs(current.panY) > 1;
    if (manualPanActive) {
      return;
    }
    const clamped = clampFullscreenViewport(
      { ...current, panY: requestedPanY },
      surfaceSize,
      displaySourceSize,
      fullscreenDisplayMode,
      safeBottomInsetPx,
    );
    lastAutoImePanRef.current = { key: autoKey, panY: clamped.panY };
    fullscreenViewportRef.current = clamped;
    setFullscreenViewportState(clamped);
  }, [bottomChromeInsetPx, bottomInsetPx, focusedWindowSlotRef, fullscreenDisplayMode, receiverFrameSize, state, surfaceSize]);

  return {
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
  };
}
