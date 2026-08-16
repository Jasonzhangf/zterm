import { TAB_SWIPE_LOCK_THRESHOLD_PX, TAB_SWIPE_TRIGGER_THRESHOLD_PX } from '@zterm/shared';

export type TerminalTabSwipeGestureAxis = 'horizontal' | 'vertical' | null;

export interface TerminalTabSwipeGestureState {
  active: boolean;
  axis: TerminalTabSwipeGestureAxis;
  startX: number;
  startY: number;
  deltaX: number;
  deltaY: number;
}

export function createTerminalTabSwipeGestureState(): TerminalTabSwipeGestureState {
  return {
    active: false,
    axis: null,
    startX: 0,
    startY: 0,
    deltaX: 0,
    deltaY: 0,
  };
}

export function beginTerminalTabSwipeGesture(startX: number, startY: number): TerminalTabSwipeGestureState {
  return {
    active: true,
    axis: null,
    startX,
    startY,
    deltaX: 0,
    deltaY: 0,
  };
}

export function updateTerminalTabSwipeGesture(
  gesture: TerminalTabSwipeGestureState,
  clientX: number,
  clientY: number,
): TerminalTabSwipeGestureState {
  if (!gesture.active) {
    return gesture;
  }
  const deltaX = clientX - gesture.startX;
  const deltaY = clientY - gesture.startY;
  let axis = gesture.axis;
  if (!axis) {
    if (Math.abs(deltaX) < TAB_SWIPE_LOCK_THRESHOLD_PX && Math.abs(deltaY) < TAB_SWIPE_LOCK_THRESHOLD_PX) {
      return {
        ...gesture,
        deltaX,
        deltaY,
      };
    }
    axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
  }
  return {
    ...gesture,
    axis,
    deltaX,
    deltaY,
  };
}

export function resolveTerminalTabSwipeDirection(
  gesture: TerminalTabSwipeGestureState,
): 'previous' | 'next' | null {
  if (gesture.axis !== 'horizontal' || Math.abs(gesture.deltaX) < TAB_SWIPE_TRIGGER_THRESHOLD_PX) {
    return null;
  }
  return gesture.deltaX < 0 ? 'next' : 'previous';
}
