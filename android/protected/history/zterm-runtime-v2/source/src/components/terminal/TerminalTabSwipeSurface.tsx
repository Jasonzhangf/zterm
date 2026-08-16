import { memo, useCallback, useRef, type ReactNode } from 'react';
import { TERMINAL_DRAWER_EDGE_SWIPE_START_PX } from '@zterm/shared';
import {
  beginTerminalTabSwipeGesture,
  createTerminalTabSwipeGestureState,
  resolveTerminalTabSwipeDirection,
  updateTerminalTabSwipeGesture,
} from '../../lib/terminal-tab-swipe-gesture';

export const TerminalTabSwipeSurface = memo(function TerminalTabSwipeSurface({
  sessionId,
  active,
  enabled,
  allowedStartEdge = 'both',
  allowedDirections = 'both',
  onSwipeTab,
  children,
}: {
  sessionId: string;
  active: boolean;
  enabled: boolean;
  allowedStartEdge?: 'both' | 'left';
  allowedDirections?: 'both' | 'previous' | 'next';
  onSwipeTab?: ((sessionId: string, direction: 'previous' | 'next') => void) | null;
  children: ReactNode;
}) {
  const gestureRef = useRef(createTerminalTabSwipeGestureState());

  const resetGesture = useCallback(() => {
    gestureRef.current = createTerminalTabSwipeGestureState();
  }, []);

  const swipeEnabled = active && enabled && Boolean(onSwipeTab);
  const isEdgeSwipeStart = (clientX: number) => {
    if (typeof window === 'undefined') {
      return clientX <= TERMINAL_DRAWER_EDGE_SWIPE_START_PX;
    }
    const viewportWidth = window.visualViewport?.width || window.innerWidth || 0;
    if (clientX <= TERMINAL_DRAWER_EDGE_SWIPE_START_PX) {
      return true;
    }
    return (
      allowedStartEdge === 'both' &&
      viewportWidth > 0 &&
      clientX >= viewportWidth - TERMINAL_DRAWER_EDGE_SWIPE_START_PX
    );
  };

  return (
    <div
      data-testid={`terminal-swipe-surface-${sessionId}`}
      data-swipe-enabled={swipeEnabled ? 'true' : 'false'}
      onTouchStart={(event) => {
        if (!swipeEnabled || event.touches.length !== 1) {
          resetGesture();
          return;
        }
        const touch = event.touches[0];
        if (!isEdgeSwipeStart(touch.clientX)) {
          resetGesture();
          return;
        }
        gestureRef.current = beginTerminalTabSwipeGesture(touch.clientX, touch.clientY);
      }}
      onTouchMove={(event) => {
        if (!swipeEnabled || event.touches.length !== 1) {
          return;
        }
        gestureRef.current = updateTerminalTabSwipeGesture(
          gestureRef.current,
          event.touches[0].clientX,
          event.touches[0].clientY,
        );
        if (gestureRef.current.axis === 'horizontal') {
          event.preventDefault();
        }
      }}
      onTouchEnd={() => {
        const direction = swipeEnabled ? resolveTerminalTabSwipeDirection(gestureRef.current) : null;
        resetGesture();
        if (!direction) {
          return;
        }
        if (allowedDirections !== 'both' && direction !== allowedDirections) {
          return;
        }
        onSwipeTab?.(sessionId, direction);
      }}
      onTouchCancel={resetGesture}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 0,
        position: 'relative',
        touchAction: swipeEnabled ? 'pan-y' : 'pan-x pan-y',
      }}
    >
      {children}
    </div>
  );
});
