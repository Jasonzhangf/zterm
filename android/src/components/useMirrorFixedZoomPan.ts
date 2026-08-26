import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type TouchEvent } from 'react';
import { TERMINAL_DRAWER_EDGE_SWIPE_START_PX } from '@zterm/shared';
import {
  clampHorizontalOffset,
  readStoredHorizontalOffset,
  writeStoredHorizontalOffset,
} from '../lib/terminal-mirror-fixed-pan-storage';
import {
  decideTwoFingerWheel,
  DEFAULT_TWO_FINGER_WHEEL_CONFIG,
  type WheelDirection,
} from '../lib/two-finger-wheel-decision';
import {
  setTwoFingerWheelDebugSnapshot,
  type TwoFingerWheelDebugSnapshot,
} from '../lib/two-finger-wheel-debug-store';

export interface MirrorFixedWheelStep {
  direction: WheelDirection;
  steps: number;
  clientX: number;
  clientY: number;
}

export interface MirrorFixedZoomPanOptions {
  widthMode: string;
  copyModeActive: boolean;
  hostRef?: RefObject<HTMLDivElement | null>;
  previewProjection?: boolean;
  reserveRightEdgeSwipe?: boolean;
  rightEdgeReservePx?: number;
  drawerEdgeSwipeStartPx?: number;
  sessionId?: string | null;
  minScale?: number;
  maxHorizontalOffsetPx?: number;
  onVerticalScrollIntent?: () => void;
  onWheelStep?: (step: MirrorFixedWheelStep) => void;
}

export interface MirrorFixedZoomPan {
  scaleLayerRef: (node: HTMLDivElement | null) => void;
  visualScale: number;
  horizontalOffsetPx: number;
  onTouchStart: (event: TouchEvent<HTMLDivElement>) => void;
  onTouchMove: (event: TouchEvent<HTMLDivElement>) => void;
  onTouchEnd: (event: TouchEvent<HTMLDivElement>) => void;
}

const MAX_SCALE = 1;
const MIN_SCALE = 0.4;

interface WheelDebugState {
  startCalls: number;
  moveCalls: number;
  endCalls: number;
  abortedCount: number;
  sentCount: number;
  lastReason: string;
  lastEventAt: number;
}

interface TwoFingerWheelState {
  active: boolean;
  pointerIds: [number, number] | null;
  lastClientY: number;
  lastSpanPx: number;
  initialSpanPx: number;
  accumulatedDeltaPx: number;
  accumulatedPinchDeltaPx: number;
  lastSentDirection: WheelDirection | null;
  lastSentTickAt: number;
  lockedDirection: WheelDirection | null;
  debug: WheelDebugState;
}

interface PanGestureState {
  active: boolean;
  axis: 'horizontal' | 'vertical' | null;
  startX: number;
  startY: number;
  startOffsetPx: number;
}

function createInitialWheelState(debug: WheelDebugState): TwoFingerWheelState {
  return {
    active: false,
    pointerIds: null,
    lastClientY: 0,
    lastSpanPx: 0,
    initialSpanPx: 0,
    accumulatedDeltaPx: 0,
    accumulatedPinchDeltaPx: 0,
    lastSentDirection: null,
    lastSentTickAt: 0,
    lockedDirection: null,
    debug,
  };
}

export function useMirrorFixedZoomPan(
  options: MirrorFixedZoomPanOptions,
): MirrorFixedZoomPan {
  const scaleRef = useRef(1);
  const minScaleRef = useRef(options.minScale ?? MIN_SCALE);
  const maxHorizontalOffsetPx = Math.max(0, options.maxHorizontalOffsetPx ?? 0);
  const maxOffsetRef = useRef(maxHorizontalOffsetPx);
  maxOffsetRef.current = maxHorizontalOffsetPx;
  const offsetRef = useRef(0);
  const [horizontalOffsetPx, setHorizontalOffsetPx] = useState(0);
  const [visualScale, setVisualScale] = useState(1);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const pinchRef = useRef<{ startSpan: number; startScale: number } | null>(null);
  const savedScrollTopRef = useRef(0);
  const restoreScrollTopRef = useRef(false);
  const restoreScrollTopTimerRef = useRef<number | null>(null);
  const panRef = useRef<PanGestureState>({
    active: false,
    axis: null,
    startX: 0,
    startY: 0,
    startOffsetPx: 0,
  });
  const restoredSessionRef = useRef<string | null>(null);
  const wheelDebugRef = useRef<WheelDebugState>({
    startCalls: 0,
    moveCalls: 0,
    endCalls: 0,
    abortedCount: 0,
    sentCount: 0,
    lastReason: 'init',
    lastEventAt: 0,
  });
  const wheelRef = useRef<TwoFingerWheelState>(
    createInitialWheelState(wheelDebugRef.current),
  );
  const drawerEdgeSwipeStartPx =
    options.drawerEdgeSwipeStartPx ?? TERMINAL_DRAWER_EDGE_SWIPE_START_PX;

  const publishWheelDebug = useCallback((state: TwoFingerWheelState) => {
    const snap: TwoFingerWheelDebugSnapshot = {
      active: state.active,
      lockedDirection: state.lockedDirection,
      initialSpanPx: Math.round(state.initialSpanPx),
      accumulatedDeltaPx: Math.round(state.accumulatedDeltaPx),
      lastSentDirection: state.lastSentDirection,
      lastSentAt: state.lastSentTickAt || null,
      startCalls: state.debug.startCalls,
      moveCalls: state.debug.moveCalls,
      endCalls: state.debug.endCalls,
      abortedCount: state.debug.abortedCount,
      sentCount: state.debug.sentCount,
      lastReason: state.debug.lastReason,
      lastEventAt: state.debug.lastEventAt,
    };
    setTwoFingerWheelDebugSnapshot(snap);
  }, []);

  const applyScale = useCallback((next: number) => {
    const minScale = minScaleRef.current;
    const previousScale = scaleRef.current;
    const clamped = Math.min(MAX_SCALE, Math.max(minScale, next));
    scaleRef.current = clamped;
    setVisualScale(clamped);
    const host = options.hostRef?.current;
    if (!host) {
      return;
    }
    if (clamped < 1 && previousScale >= 1) {
      // Save the native anchor before the declarative zoom commit changes the
      // host's scroll range. The actual clamp runs after that commit.
      savedScrollTopRef.current = host.scrollTop;
      const maxScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
      savedScrollTopRef.current = Math.min(maxScrollTop, Math.max(0, savedScrollTopRef.current));
    } else if (clamped >= 1 && previousScale < 1) {
      restoreScrollTopRef.current = true;
    }
  }, [options.hostRef]);

  const computeNextPinchScale = useCallback((ratio: number) => {
    const current = scaleRef.current;
    const minScale = minScaleRef.current;
    const rawNext = pinchRef.current
      ? pinchRef.current.startScale * ratio
      : current;
    const clamped = Math.min(MAX_SCALE, Math.max(minScale, rawNext));
    if (clamped >= 1 && current < 1) {
      return Math.min(1, current + 0.08);
    }
    return clamped;
  }, []);

  const scaleLayerRef = useCallback((node: HTMLDivElement | null) => {
    layerRef.current = node;
  }, []);

  useLayoutEffect(() => {
    const host = options.hostRef?.current;
    if (!host) {
      return;
    }

    host.style.touchAction = 'pan-y';
    const maxScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
    if (visualScale < 1) {
      host.scrollTop = Math.min(maxScrollTop, Math.max(0, host.scrollTop));
      return;
    }
    if (!restoreScrollTopRef.current) {
      return;
    }

    restoreScrollTopRef.current = false;
    host.scrollTop = Math.min(maxScrollTop, Math.max(0, savedScrollTopRef.current));
    const restoreScrollTop = () => {
      restoreScrollTopTimerRef.current = null;
      const currentHost = options.hostRef?.current;
      if (!currentHost || scaleRef.current < 1) {
        return;
      }
      const currentMaxScrollTop = Math.max(0, currentHost.scrollHeight - currentHost.clientHeight);
      currentHost.scrollTop = Math.min(currentMaxScrollTop, Math.max(0, savedScrollTopRef.current));
    };
    if (restoreScrollTopTimerRef.current !== null) {
      window.clearTimeout(restoreScrollTopTimerRef.current);
    }
    restoreScrollTopTimerRef.current = window.setTimeout(restoreScrollTop, 0);
  }, [options.hostRef, visualScale]);

  useEffect(() => {
    minScaleRef.current = options.minScale ?? MIN_SCALE;
    const current = scaleRef.current;
    const clamped = Math.min(MAX_SCALE, Math.max(minScaleRef.current, current));
    if (clamped !== current) {
      applyScale(clamped);
    }
  }, [applyScale, options.minScale]);

  useEffect(() => {
    if (options.widthMode !== 'mirror-fixed') {
      restoredSessionRef.current = null;
      offsetRef.current = 0;
      setHorizontalOffsetPx(0);
      return;
    }
    const sessionId = options.sessionId;
    if (!sessionId || maxOffsetRef.current <= 0) {
      return;
    }
    const current = clampHorizontalOffset(offsetRef.current, maxOffsetRef.current);
    if (current !== offsetRef.current) {
      offsetRef.current = current;
      setHorizontalOffsetPx(current);
      if (sessionId) {
        writeStoredHorizontalOffset(sessionId, current);
      }
    }
    if (restoredSessionRef.current !== sessionId) {
      restoredSessionRef.current = sessionId;
      const restored = clampHorizontalOffset(
        readStoredHorizontalOffset(sessionId),
        maxOffsetRef.current,
      );
      offsetRef.current = restored;
      setHorizontalOffsetPx(restored);
    }
  }, [maxHorizontalOffsetPx, options.sessionId, options.widthMode]);

  useEffect(() => () => {
    if (restoreScrollTopTimerRef.current !== null) {
      window.clearTimeout(restoreScrollTopTimerRef.current);
      restoreScrollTopTimerRef.current = null;
    }
  }, []);

  const startTwoFingerWheel = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const wheel = wheelRef.current;
      wheel.debug.startCalls += 1;
      wheel.debug.lastEventAt = Date.now();
      if (options.previewProjection) {
        wheel.debug.lastReason = 'skip-preview-projection';
        return;
      }
      if (options.copyModeActive) {
        wheel.debug.lastReason = 'skip-copy-mode';
        return;
      }
      const [t0, t1] = [event.touches[0], event.touches[1]];
      const spanPx = Math.hypot(
        t1.clientX - t0.clientX,
        t1.clientY - t0.clientY,
      );
      if (spanPx < DEFAULT_TWO_FINGER_WHEEL_CONFIG.minInitialSpanPx) {
        wheel.debug.lastReason = 'skip-min-span';
        return;
      }
      wheel.debug.lastReason = 'started';
      pinchRef.current = {
        startSpan: spanPx,
        startScale: scaleRef.current,
      };
      const midY = (t0.clientY + t1.clientY) / 2;
      wheelRef.current = {
        active: true,
        pointerIds: [t0.identifier, t1.identifier],
        lastClientY: midY,
        lastSpanPx: spanPx,
        initialSpanPx: spanPx,
        accumulatedDeltaPx: 0,
        accumulatedPinchDeltaPx: 0,
        lastSentDirection: null,
        lastSentTickAt: 0,
        lockedDirection: null,
        debug: {
          ...wheel.debug,
          startCalls: wheel.debug.startCalls,
        },
      };
      publishWheelDebug(wheelRef.current);
      event.preventDefault();
    },
    [options.copyModeActive, options.previewProjection, publishWheelDebug],
  );

  const moveTwoFingerWheel = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const wheel = wheelRef.current;
      wheel.debug.moveCalls += 1;
      wheel.debug.lastEventAt = Date.now();
      if (!wheel.active) {
        wheel.debug.lastReason = 'skip-inactive';
        if (options.previewProjection) {
          publishWheelDebug(wheel);
          return;
        }
        if (options.copyModeActive) {
          publishWheelDebug(wheel);
          return;
        }
        if (
          event.touches.length === 2 &&
          pinchRef.current &&
          options.widthMode === 'mirror-fixed'
        ) {
          const [t0, t1] = [event.touches[0], event.touches[1]];
          const spanPx = Math.hypot(
            t1.clientX - t0.clientX,
            t1.clientY - t0.clientY,
          );
          if (spanPx > 0 && pinchRef.current.startSpan > 0) {
            const ratio = spanPx / pinchRef.current.startSpan;
            applyScale(computeNextPinchScale(ratio));
            event.preventDefault();
            event.stopPropagation();
          }
        }
        publishWheelDebug(wheel);
        return;
      }
      if (event.touches.length !== 2) {
        wheel.debug.lastReason = 'skip-not-two-fingers';
        publishWheelDebug(wheel);
        return;
      }
      const [t0, t1] = [event.touches[0], event.touches[1]];
      const midY = (t0.clientY + t1.clientY) / 2;
      const spanPx = Math.hypot(
        t1.clientX - t0.clientX,
        t1.clientY - t0.clientY,
      );
      const midYDelta = midY - wheel.lastClientY;
      wheel.lastClientY = midY;
      wheel.lastSpanPx = spanPx;

      const decision = decideTwoFingerWheel(
        {
          active: wheel.active,
          initialSpanPx: wheel.initialSpanPx,
          accumulatedDeltaPx: wheel.accumulatedDeltaPx,
          lockedDirection: wheel.lockedDirection,
        },
        { midYDeltaPx: midYDelta, liveSpanPx: spanPx },
        DEFAULT_TWO_FINGER_WHEEL_CONFIG,
      );

      wheel.active = decision.next.active;
      wheel.initialSpanPx = decision.next.initialSpanPx;
      wheel.accumulatedDeltaPx = decision.next.accumulatedDeltaPx;
      wheel.lockedDirection = decision.next.lockedDirection;
      wheel.accumulatedPinchDeltaPx += Math.abs(
        spanPx - wheel.lastSpanPx,
      );

      if (decision.aborted) {
        wheel.debug.abortedCount += 1;
        wheel.debug.lastReason = 'aborted-pinch';
        if (options.widthMode === 'mirror-fixed' && pinchRef.current) {
          const ratio =
            pinchRef.current.startSpan > 0
              ? spanPx / pinchRef.current.startSpan
              : 1;
          applyScale(computeNextPinchScale(ratio));
        }
        event.preventDefault();
        event.stopPropagation();
        publishWheelDebug(wheel);
        return;
      }
      if (decision.direction === null || decision.steps < 1) {
        wheel.debug.lastReason = 'no-step';
        publishWheelDebug(wheel);
        return;
      }
      wheel.lastSentDirection = decision.direction;
      wheel.lastSentTickAt = Date.now();
      wheel.debug.sentCount += decision.steps;
      wheel.debug.lastReason = `sent-${decision.direction}-x${decision.steps}`;
      options.onWheelStep?.({
        direction: decision.direction,
        steps: decision.steps,
        clientX: (t0.clientX + t1.clientX) / 2,
        clientY: midY,
      });
      event.preventDefault();
      event.stopPropagation();
      publishWheelDebug(wheel);
    },
    [applyScale, computeNextPinchScale, options.onWheelStep, options.widthMode, publishWheelDebug],
  );

  const endTwoFingerWheel = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const wheel = wheelRef.current;
      wheel.debug.endCalls += 1;
      wheel.debug.lastEventAt = Date.now();
      if (event.touches.length === 2) {
        publishWheelDebug(wheel);
        return;
      }
      if (!wheel.active) {
        wheel.debug.lastReason = 'end-inactive';
        pinchRef.current = null;
        if (scaleRef.current < 1) {
          offsetRef.current = 0;
          setHorizontalOffsetPx(0);
        }
        publishWheelDebug(wheel);
      } else {
        wheel.debug.lastReason = 'ended';
        pinchRef.current = null;
        if (scaleRef.current < 1) {
          offsetRef.current = 0;
          setHorizontalOffsetPx(0);
        }
        publishWheelDebug(wheel);
      }
      wheelRef.current = createInitialWheelState({
        ...wheel.debug,
        endCalls: wheel.debug.endCalls,
      });
    },
    [publishWheelDebug],
  );

  const onTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const touches = event.touches;
      panRef.current.active = false;
      if (touches.length === 2) {
        startTwoFingerWheel(event);
        return;
      }
      if (
        touches.length !== 1 ||
        options.widthMode !== 'mirror-fixed' ||
        options.copyModeActive
      ) {
        return;
      }
      const startX = touches[0].clientX;
      const viewportWidth = window.visualViewport?.width || window.innerWidth || 0;
      const startOffsetPx = offsetRef.current;
      const reservedRightEdge =
        Boolean(options.reserveRightEdgeSwipe) &&
        viewportWidth > 0 &&
        startX >= viewportWidth - (options.rightEdgeReservePx ?? 24);
      const reservedLeftEdge =
        startX <= drawerEdgeSwipeStartPx && startOffsetPx === 0;
      const active = !reservedRightEdge && !reservedLeftEdge;
      panRef.current = {
        active,
        axis: null,
        startX,
        startY: touches[0].clientY,
        startOffsetPx,
      };
      if (active && (startOffsetPx > 0 || startX > drawerEdgeSwipeStartPx)) {
        event.stopPropagation();
      }
    },
    [
      drawerEdgeSwipeStartPx,
      options.copyModeActive,
      options.reserveRightEdgeSwipe,
      options.rightEdgeReservePx,
      options.widthMode,
      startTwoFingerWheel,
    ],
  );

  const onTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const touches = event.touches;
      if (touches.length === 2) {
        moveTwoFingerWheel(event);
        return;
      }
      if (touches.length !== 1 || options.widthMode !== 'mirror-fixed') {
        return;
      }
      const pan = panRef.current;
      if (!pan.active) {
        return;
      }
      const deltaX = touches[0].clientX - pan.startX;
      const deltaY = touches[0].clientY - pan.startY;
      if (!pan.axis) {
        if (
          Math.abs(deltaX) < 8 &&
          Math.abs(deltaY) < 8
        ) {
          return;
        }
        pan.axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
      }
      if (pan.axis !== 'horizontal') {
        options.onVerticalScrollIntent?.();
        return;
      }
      const nextOffset = Math.max(0, pan.startOffsetPx - deltaX);
      if (nextOffset !== offsetRef.current) {
        offsetRef.current = nextOffset;
        setHorizontalOffsetPx(nextOffset);
      }
      if (
        pan.startOffsetPx > 0 ||
        pan.startX > drawerEdgeSwipeStartPx ||
        nextOffset !== pan.startOffsetPx
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [
      drawerEdgeSwipeStartPx,
      moveTwoFingerWheel,
      options.onVerticalScrollIntent,
      options.hostRef,
      options.widthMode,
    ],
  );

  const onTouchEnd = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      endTwoFingerWheel(event);
      const consumedHorizontal = panRef.current.axis === 'horizontal';
      if (
        consumedHorizontal &&
        options.widthMode === 'mirror-fixed' &&
        options.sessionId
      ) {
        writeStoredHorizontalOffset(options.sessionId, offsetRef.current);
        event.stopPropagation();
      }
      pinchRef.current = null;
      panRef.current.active = false;
    },
    [endTwoFingerWheel, options.sessionId, options.widthMode],
  );

  return {
    scaleLayerRef,
    visualScale,
    horizontalOffsetPx,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  };
}
