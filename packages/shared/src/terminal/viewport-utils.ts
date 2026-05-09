/**
 * viewport-utils.ts — Pure functions for viewport and scroll buffer calculations.
 */

/**
 * Calculate the number of request lines for terminal buffer sync.
 * Requests 2.5x visible rows to provide smooth scrolling and gap coverage.
 */
export function resolveTerminalRequestWindowLines(visibleRows: number): number {
  const safeRows = Math.max(1, Math.floor(visibleRows));
  // Request 2.5x visible rows for smooth scrolling and to reduce gaps
  return Math.max(safeRows, Math.floor(safeRows * 2.5));
}
