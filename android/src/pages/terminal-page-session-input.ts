/**
 * Pure DOM utility: query the TerminalQuickBar input textarea for a given session.
 * No React, no page state, no side effects.
 */

export function querySessionInput(sessionId: string | null | undefined): HTMLTextAreaElement | null {
  if (!sessionId || typeof document === "undefined") {
    return null;
  }
  return document.querySelector(
    `textarea[data-wterm-input="true"][data-terminal-input-session-id="${sessionId}"]`,
  ) as HTMLTextAreaElement | null;
}
