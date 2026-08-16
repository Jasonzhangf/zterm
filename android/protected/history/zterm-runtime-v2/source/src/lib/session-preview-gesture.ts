export const SESSION_PREVIEW_RIGHT_EDGE_PX = 64;
export const SESSION_PREVIEW_SWIPE_THRESHOLD_PX = 48;
const SESSION_PREVIEW_AXIS_LOCK_PX = 8;

export interface SessionPreviewGestureState {
  armed: boolean;
  axis: 'horizontal' | 'vertical' | null;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

export function createSessionPreviewGestureState(): SessionPreviewGestureState {
  return { armed: false, axis: null, startX: 0, startY: 0, currentX: 0, currentY: 0 };
}

export function beginSessionPreviewGesture(
  startX: number,
  startY: number,
  viewportWidth: number,
): SessionPreviewGestureState {
  const armed = viewportWidth > 0 && startX >= viewportWidth - SESSION_PREVIEW_RIGHT_EDGE_PX;
  return { armed, axis: null, startX, startY, currentX: startX, currentY: startY };
}

export function updateSessionPreviewGesture(
  state: SessionPreviewGestureState,
  currentX: number,
  currentY: number,
): SessionPreviewGestureState {
  if (!state.armed) return state;
  const deltaX = currentX - state.startX;
  const deltaY = currentY - state.startY;
  let axis = state.axis;
  if (!axis && (Math.abs(deltaX) >= SESSION_PREVIEW_AXIS_LOCK_PX || Math.abs(deltaY) >= SESSION_PREVIEW_AXIS_LOCK_PX)) {
    axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
  }
  return { ...state, axis, currentX, currentY };
}

export function resolveSessionPreviewGesture(state: SessionPreviewGestureState): 'open-preview' | null {
  if (!state.armed || state.axis !== 'horizontal') return null;
  return state.currentX - state.startX <= -SESSION_PREVIEW_SWIPE_THRESHOLD_PX
    ? 'open-preview'
    : null;
}
