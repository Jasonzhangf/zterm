/**
 * Storage owner (client.app_shell) for the mirror-fixed horizontal pan offset.
 *
 * 层级：UI shell（useMirrorFixedZoomPan）持有 offset 真源并经由本模块持久化；
 * renderer 只读视觉应用（grid translateX）。禁止其他组件直写 localStorage。
 *
 * Gate doc: docs/audits/2026-08-13-terminal-render-layer-decoupling.md §8.3
 */

export const MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY =
  'zterm:terminal:mirror-fixed-horizontal-offsets';

/**
 * Clamp an offset to [0, max], rounded. Non-finite input resolves to 0.
 */
export function clampHorizontalOffset(offsetPx: number, maxOffsetPx: number): number {
  if (!Number.isFinite(offsetPx)) {
    return 0;
  }
  return Math.max(0, Math.min(maxOffsetPx, Math.round(offsetPx)));
}

/**
 * Read the persisted horizontal offset for a session (0 when missing/invalid).
 */
export function readStoredHorizontalOffset(sessionId: string | null): number {
  if (!sessionId || typeof localStorage === 'undefined') {
    return 0;
  }
  try {
    const parsed = JSON.parse(
      localStorage.getItem(MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY) || '{}',
    );
    const value =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Number((parsed as Record<string, unknown>)[sessionId])
        : 0;
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  } catch {
    return 0;
  }
}

/**
 * Persist the horizontal offset for a session (merged per-session map).
 * Writes without a session id are ignored.
 */
export function writeStoredHorizontalOffset(
  sessionId: string | null,
  offsetPx: number,
): void {
  if (!sessionId || typeof localStorage === 'undefined') {
    return;
  }
  const clamped = clampHorizontalOffset(offsetPx, Number.MAX_SAFE_INTEGER);
  try {
    const parsed = JSON.parse(
      localStorage.getItem(MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY) || '{}',
    );
    const next =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : {};
    next[sessionId] = clamped;
    localStorage.setItem(MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY, JSON.stringify(next));
  } catch {
    localStorage.setItem(
      MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY,
      JSON.stringify({ [sessionId]: clamped }),
    );
  }
}
