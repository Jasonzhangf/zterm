import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { mobileTheme } from '../../lib/mobile-ui';
import type { Session } from '../../lib/types';
import { TerminalView } from '../TerminalView';

interface TerminalCanvasProps {
  sessions: Session[];
  activeSession: Session | null;
  onTitleChange?: (title: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onInput?: (data: string) => void;
  onBufferLinesChange?: (sessionId: string, lines: string[]) => void;
  focusNonce?: number;
  allowDomFocus?: boolean;
  domInputOffscreen?: boolean;
  resumeNonce?: number;
  fontSize: number;
  heightPx?: number;
  onFontSizeChange: (value: number | ((current: number) => number)) => void;
  onSwipeSession?: (direction: 'prev' | 'next') => void;
  forceScrollToBottomNonce?: number;
}

const MIN_FONT_SIZE = 5;
const MAX_FONT_SIZE = 16;
const PINCH_STEP_DIVISOR = 28;
const SWIPE_COMPLETE_DURATION_MS = 220;
const SWIPE_RESTORE_DURATION_MS = 180;

type SwipeDirection = 'prev' | 'next';

interface SwipeState {
  sourceSessionId: string;
  targetSessionId: string;
  direction: SwipeDirection;
  offsetX: number;
  animating: boolean;
  shouldSwitch: boolean;
}

interface SessionTerminalPaneProps {
  session: Session;
  isActive: boolean;
  shouldRender: boolean;
  transform: string;
  transition: string;
  allowDomFocus: boolean;
  domInputOffscreen: boolean;
  onTitleChange?: (title: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onInput?: (data: string) => void;
  onHorizontalSwipeStart?: () => void;
  onHorizontalSwipeMove?: (deltaX: number) => void;
  onHorizontalSwipeEnd?: (deltaX: number) => void;
  onBufferLinesChange?: (sessionId: string, lines: string[]) => void;
  focusNonce?: number;
  forceScrollToBottomNonce?: number;
  fontSize: number;
  resumeNonce: number;
  rowHeight: string;
  swipeAnimating: boolean;
}

const SessionTerminalPane = memo(function SessionTerminalPane({
  session,
  isActive,
  shouldRender,
  transform,
  transition,
  allowDomFocus,
  domInputOffscreen,
  onTitleChange,
  onResize,
  onInput,
  onHorizontalSwipeStart,
  onHorizontalSwipeMove,
  onHorizontalSwipeEnd,
  onBufferLinesChange,
  focusNonce = 0,
  forceScrollToBottomNonce = 0,
  fontSize,
  resumeNonce,
  rowHeight,
  swipeAnimating,
}: SessionTerminalPaneProps) {
  return (
    <div
      data-session-id={session.id}
      data-active-terminal={isActive ? 'true' : 'false'}
      style={{
        position: 'absolute',
        inset: 0,
        display: shouldRender ? 'block' : 'none',
        pointerEvents: shouldRender && isActive && !swipeAnimating ? 'auto' : 'none',
        transform,
        transition,
        willChange: shouldRender ? 'transform' : undefined,
      }}
    >
      <TerminalView
        sessionId={session.id}
        initialOutputHistory={session.outputHistory}
        initialBufferLines={session.buffer.lines}
        bufferStartIndex={session.buffer.lineStartIndex}
        bufferUpdateKind={session.buffer.updateKind}
        bufferRevision={session.buffer.revision}
        snapshot={session.buffer.remoteSnapshot}
        active={isActive}
        allowDomFocus={allowDomFocus}
        domInputOffscreen={domInputOffscreen}
        onTitleChange={onTitleChange}
        onResize={onResize}
        onInput={onInput}
        onHorizontalSwipeStart={onHorizontalSwipeStart}
        onHorizontalSwipeMove={onHorizontalSwipeMove}
        onHorizontalSwipeEnd={onHorizontalSwipeEnd ? (deltaX) => onHorizontalSwipeEnd(deltaX) : undefined}
        onBufferLinesChange={onBufferLinesChange}
        focusNonce={focusNonce}
        forceScrollToBottomNonce={forceScrollToBottomNonce}
        fontSize={fontSize}
        resumeNonce={resumeNonce}
        rowHeight={rowHeight}
      />
    </div>
  );
}, (prev, next) => (
  prev.session === next.session
  && prev.isActive === next.isActive
  && prev.shouldRender === next.shouldRender
  && prev.transform === next.transform
  && prev.transition === next.transition
  && prev.allowDomFocus === next.allowDomFocus
  && prev.domInputOffscreen === next.domInputOffscreen
  && prev.focusNonce === next.focusNonce
  && prev.forceScrollToBottomNonce === next.forceScrollToBottomNonce
  && prev.fontSize === next.fontSize
  && prev.resumeNonce === next.resumeNonce
  && prev.rowHeight === next.rowHeight
  && prev.swipeAnimating === next.swipeAnimating
));

function clampFontSize(value: number) {
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(value)));
}

function getTouchDistance(touchA: { clientX: number; clientY: number }, touchB: { clientX: number; clientY: number }) {
  return Math.hypot(touchA.clientX - touchB.clientX, touchA.clientY - touchB.clientY);
}

function getRowHeight(fontSize: number) {
  return `${Math.max(fontSize + 4, Math.ceil(fontSize * 1.5))}px`;
}

export function TerminalCanvas({
  sessions,
  activeSession,
  onTitleChange,
  onResize,
  onInput,
  onBufferLinesChange,
  focusNonce,
  allowDomFocus = true,
  domInputOffscreen = false,
  resumeNonce = 0,
  fontSize,
  heightPx,
  onFontSizeChange,
  onSwipeSession,
  forceScrollToBottomNonce = 0,
}: TerminalCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pinchStartDistance = useRef<number | null>(null);
  const pinchStartFontSize = useRef(fontSize);
  const indicatorTimeout = useRef<number | null>(null);
  const swipeAnimationTimer = useRef<number | null>(null);
  const [showScaleIndicator, setShowScaleIndicator] = useState(false);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [swipeState, setSwipeState] = useState<SwipeState | null>(null);

  const clearSwipeAnimationTimer = () => {
    if (swipeAnimationTimer.current) {
      window.clearTimeout(swipeAnimationTimer.current);
      swipeAnimationTimer.current = null;
    }
  };

  useEffect(() => {
    pinchStartFontSize.current = fontSize;
  }, [fontSize]);

  useEffect(() => () => {
    clearSwipeAnimationTimer();
    if (indicatorTimeout.current) {
      window.clearTimeout(indicatorTimeout.current);
    }
  }, []);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }

    const syncCanvasWidth = () => {
      setCanvasWidth(Math.max(1, Math.round(host.getBoundingClientRect().width || host.clientWidth || 0)));
    };

    syncCanvasWidth();
    const observer = new ResizeObserver(syncCanvasWidth);
    observer.observe(host);
    window.addEventListener('resize', syncCanvasWidth);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncCanvasWidth);
    };
  }, []);

  useEffect(() => {
    if (!activeSession || sessions.length < 2) {
      clearSwipeAnimationTimer();
      setSwipeState(null);
    }
  }, [activeSession, sessions.length]);

  const showIndicator = () => {
    setShowScaleIndicator(true);
    if (indicatorTimeout.current) {
      window.clearTimeout(indicatorTimeout.current);
    }
    indicatorTimeout.current = window.setTimeout(() => setShowScaleIndicator(false), 900);
  };

  const activeIndex = useMemo(() => {
    if (!activeSession) {
      return -1;
    }
    return sessions.findIndex((session) => session.id === activeSession.id);
  }, [activeSession, sessions]);

  const adjacentSessions = useMemo(() => {
    if (!activeSession || sessions.length < 2 || activeIndex < 0) {
      return {
        prev: null as Session | null,
        next: null as Session | null,
      };
    }

    return {
      prev: sessions[(activeIndex - 1 + sessions.length) % sessions.length] || null,
      next: sessions[(activeIndex + 1) % sessions.length] || null,
    };
  }, [activeIndex, activeSession, sessions]);

  const resolveSwipeTarget = (direction: SwipeDirection) => {
    return direction === 'next' ? adjacentSessions.next : adjacentSessions.prev;
  };

  const resetSwipeState = () => {
    clearSwipeAnimationTimer();
    setSwipeState(null);
  };

  const handleHorizontalSwipeStart = () => {
    if (!activeSession || sessions.length < 2 || swipeState?.animating) {
      return;
    }
    clearSwipeAnimationTimer();
  };

  const handleHorizontalSwipeMove = (deltaX: number) => {
    if (!activeSession || sessions.length < 2 || swipeState?.animating) {
      return;
    }

    const direction: SwipeDirection = deltaX < 0 ? 'next' : 'prev';
    const targetSession = resolveSwipeTarget(direction);
    if (!targetSession) {
      return;
    }

    const clampedOffset = Math.max(-canvasWidth, Math.min(canvasWidth, deltaX));
    setSwipeState({
      sourceSessionId: activeSession.id,
      targetSessionId: targetSession.id,
      direction,
      offsetX: clampedOffset,
      animating: false,
      shouldSwitch: false,
    });
  };

  const handleHorizontalSwipeEnd = (deltaX: number) => {
    if (!activeSession || sessions.length < 2) {
      resetSwipeState();
      return;
    }

    const currentSwipe = swipeState;
    if (!currentSwipe) {
      return;
    }

    const threshold = Math.max(56, canvasWidth / 2);
    const shouldSwitch = Math.abs(deltaX) >= threshold;
    const finalOffset = shouldSwitch
      ? currentSwipe.direction === 'next'
        ? -canvasWidth
        : canvasWidth
      : 0;
    const duration = shouldSwitch ? SWIPE_COMPLETE_DURATION_MS : SWIPE_RESTORE_DURATION_MS;

    clearSwipeAnimationTimer();
    setSwipeState({
      ...currentSwipe,
      offsetX: finalOffset,
      animating: true,
      shouldSwitch,
    });

    swipeAnimationTimer.current = window.setTimeout(() => {
      swipeAnimationTimer.current = null;
      if (shouldSwitch) {
        onSwipeSession?.(currentSwipe.direction);
        window.requestAnimationFrame(() => {
          setSwipeState(null);
        });
        return;
      }
      setSwipeState(null);
    }, duration);
  };

  const swipeActiveSessionId = swipeState?.sourceSessionId ?? activeSession?.id ?? null;
  const swipeTargetSessionId = swipeState?.targetSessionId ?? null;
  const isSwipePreviewVisible = Boolean(swipeState && swipeActiveSessionId && swipeTargetSessionId);
  const transitionDurationMs = swipeState?.animating
    ? swipeState.shouldSwitch
      ? SWIPE_COMPLETE_DURATION_MS
      : SWIPE_RESTORE_DURATION_MS
    : 0;
  const resolvedRowHeight = getRowHeight(fontSize);
  const renderedSessions = useMemo(() => {
    if (!activeSession) {
      return [] as Session[];
    }

    if (!isSwipePreviewVisible) {
      return [activeSession];
    }

    return sessions.filter((session) => session.id === swipeActiveSessionId || session.id === swipeTargetSessionId);
  }, [activeSession, isSwipePreviewVisible, sessions, swipeActiveSessionId, swipeTargetSessionId]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: heightPx ? '0 0 auto' : 1,
        height: heightPx ? `${heightPx}px` : undefined,
        margin: '0 4px',
        borderRadius: '14px',
        backgroundColor: mobileTheme.colors.canvas,
        overflow: 'hidden',
        border: `1px solid ${mobileTheme.colors.cardBorder}`,
        position: 'relative',
        touchAction: 'pan-y pinch-zoom',
        overscrollBehaviorY: 'contain',
        willChange: isSwipePreviewVisible ? 'transform' : undefined,
      }}
      onTouchStart={(event) => {
        if (event.touches.length === 2) {
          pinchStartDistance.current = getTouchDistance(event.touches[0], event.touches[1]);
          pinchStartFontSize.current = fontSize;
        }
      }}
      onTouchMove={(event) => {
        if (event.touches.length !== 2 || pinchStartDistance.current === null) {
          return;
        }

        event.preventDefault();
        const distance = getTouchDistance(event.touches[0], event.touches[1]);
        const delta = (distance - pinchStartDistance.current) / PINCH_STEP_DIVISOR;
        const nextFontSize = clampFontSize(pinchStartFontSize.current + delta);
        onFontSizeChange((current) => (current === nextFontSize ? current : nextFontSize));
        showIndicator();
      }}
      onTouchEnd={(event) => {
        if (event.touches.length < 2) {
          pinchStartDistance.current = null;
          pinchStartFontSize.current = fontSize;
        }
      }}
    >
      {showScaleIndicator && (
        <div
          style={{
            position: 'absolute',
            top: '10px',
            right: '10px',
            zIndex: 2,
            padding: '6px 10px',
            borderRadius: '999px',
            backgroundColor: 'rgba(0,0,0,0.66)',
            color: '#fff',
            fontSize: '12px',
            fontWeight: 700,
          }}
        >
          {fontSize}px
        </div>
      )}
      {activeSession ? (
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
          }}
        >
          {renderedSessions.map((session) => {
            const isActive = session.id === activeSession.id;
            const isSwipeSource = session.id === swipeActiveSessionId;
            const isSwipeTarget = session.id === swipeTargetSessionId;
            const shouldRender = isSwipePreviewVisible
              ? isSwipeSource || isSwipeTarget
              : isActive;
            const transform = isSwipePreviewVisible
              ? isSwipeSource
                ? `translate3d(${swipeState?.offsetX || 0}px, 0, 0)`
                : isSwipeTarget
                  ? `translate3d(${
                      swipeState?.direction === 'next'
                        ? canvasWidth + (swipeState?.offsetX || 0)
                        : -canvasWidth + (swipeState?.offsetX || 0)
                    }px, 0, 0)`
                  : 'translate3d(0, 0, 0)'
              : 'translate3d(0, 0, 0)';
            return (
              <SessionTerminalPane
                key={session.id}
                session={session}
                isActive={isActive}
                shouldRender={shouldRender}
                transform={transform}
                transition={swipeState?.animating
                  ? `transform ${transitionDurationMs}ms cubic-bezier(0.22, 0.9, 0.24, 1)`
                  : 'none'}
                allowDomFocus={allowDomFocus}
                domInputOffscreen={domInputOffscreen}
                onTitleChange={isActive ? onTitleChange : undefined}
                onResize={isActive ? onResize : undefined}
                onInput={isActive ? onInput : undefined}
                onHorizontalSwipeStart={isActive ? handleHorizontalSwipeStart : undefined}
                onHorizontalSwipeMove={isActive ? handleHorizontalSwipeMove : undefined}
                onHorizontalSwipeEnd={isActive ? handleHorizontalSwipeEnd : undefined}
                onBufferLinesChange={onBufferLinesChange}
                focusNonce={isActive ? focusNonce : 0}
                forceScrollToBottomNonce={isActive ? forceScrollToBottomNonce : 0}
                fontSize={fontSize}
                resumeNonce={resumeNonce}
                rowHeight={resolvedRowHeight}
                swipeAnimating={Boolean(swipeState?.animating)}
              />
            );
          })}
        </div>
      ) : (
        <div
          style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: mobileTheme.colors.textSecondary,
            gap: '10px',
          }}
        >
          <div style={{ fontSize: '18px', fontWeight: 700 }}>No terminal attached</div>
          <div style={{ fontSize: '14px' }}>Go back to Connections and open a host card.</div>
        </div>
      )}
    </div>
  );
}
