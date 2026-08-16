
/**
 * Encode SGR (1006) mouse wheel events to be sent into a terminal that has
 * mouse reporting enabled (most TUI apps like OpenCode / Codex enable it).
 *
 * The escape sequences follow the xterm SGR mouse protocol:
 *   ESC [ < Cb ; Cx ; Cy M
 * where Cb is the encoded button + direction, and Cx/Cy are 1-based columns/rows.
 *
 * For scroll wheels we use:
 *   wheel up   -> button code 64
 *   wheel down -> button code 65
 *
 * Most TUIs consume these to scroll their internal viewport / history buffer,
 * which sidesteps the tmux alternate-screen history limit entirely.
 */
export const TERMINAL_WHEEL_UP_BUTTON_CODE = 64;
export const TERMINAL_WHEEL_DOWN_BUTTON_CODE = 65;

export function encodeTerminalSgrMouseWheel(
  direction: "up" | "down",
  column: number,
  row: number,
): string {
  const safeCol = Math.max(1, Math.floor(column) || 1);
  const safeRow = Math.max(1, Math.floor(row) || 1);
  const button =
    direction === "up" ? TERMINAL_WHEEL_UP_BUTTON_CODE : TERMINAL_WHEEL_DOWN_BUTTON_CODE;
  // Cap values at 9999 to avoid pathological encodings on mis-sized viewports.
  const cx = Math.min(9999, safeCol);
  const cy = Math.min(9999, safeRow);
  return `\u001b[<${button};${cx};${cy}M`;
}


/**
 * SGR mouse click events for syncing clicks from preview to remote terminal.
 * Button codes: 0=left, 1=middle, 2=right, 3=release
 */
export const TERMINAL_MOUSE_LEFT_BUTTON = 0;
export const TERMINAL_MOUSE_MIDDLE_BUTTON = 1;
export const TERMINAL_MOUSE_RIGHT_BUTTON = 2;
export const TERMINAL_MOUSE_RELEASE_BUTTON = 3;

export function encodeTerminalSgrMouseClick(
  button: number,
  column: number,
  row: number,
): string {
  const safeCol = Math.max(1, Math.floor(column) || 1);
  const safeRow = Math.max(1, Math.floor(row) || 1);
  // Cap values at 9999
  const cx = Math.min(9999, safeCol);
  const cy = Math.min(9999, safeRow);
  // Button press: Cb = button (0=left, 1=middle, 2=right)
  // Mouse release: Cb = 3
  return `\u001b[<${button};${cx};${cy}M`;
}
