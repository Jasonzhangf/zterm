/**
 * viewport-utils.ts — Pure functions for viewport and scroll buffer calculations.
 */

/**
 * Calculate the number of request lines for terminal buffer sync.
 * Requests 3x visible rows (TERMINAL_CACHE_SCREENS=3) to provide smooth scrolling and gap coverage.
 */
export function resolveTerminalRequestWindowLines(visibleRows: number): number {
  const safeRows = Math.max(1, Math.floor(visibleRows));
  // Request 3x visible rows to fill cache screens (matches Android TERMINAL_CACHE_SCREENS=3)
  return safeRows * 3;
}
