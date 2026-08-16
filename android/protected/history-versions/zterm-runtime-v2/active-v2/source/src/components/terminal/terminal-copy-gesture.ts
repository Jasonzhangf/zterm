export const COPY_LONG_PRESS_DELAY_MS = 420;
export const COPY_LONG_PRESS_MOVE_THRESHOLD_PX = 10;

export function hasCopyLongPressMovedTooFar(
  start: { x: number; y: number } | null,
  nextX: number,
  nextY: number,
) {
  if (!start) {
    return false;
  }

  return (
    Math.abs(nextX - start.x) > COPY_LONG_PRESS_MOVE_THRESHOLD_PX ||
    Math.abs(nextY - start.y) > COPY_LONG_PRESS_MOVE_THRESHOLD_PX
  );
}
