/**
 * foreground-resume.ts — Pure foreground resume decision logic.
 *
 * Determines whether a foreground resume should trigger active session refresh.
 * Platform-agnostic: no dependency on Capacitor, DOM, or Android types.
 */

export interface ForegroundResumeState {
  wasHidden: boolean;
  lastResumeAt: number;
}

export function createForegroundResumeState(): ForegroundResumeState {
  return {
    wasHidden: false,
    lastResumeAt: 0,
  };
}

export function markHidden(state: ForegroundResumeState): ForegroundResumeState {
  return { ...state, wasHidden: true };
}

export function markVisible(state: ForegroundResumeState): ForegroundResumeState {
  return { ...state, wasHidden: false };
}

export interface ForegroundResumeDecision {
  shouldResume: boolean;
  skipReason?: 'no-sessions' | 'debounced' | 'no-active-session' | 'not-hidden';
}

/**
 * Pure decision: should we trigger a foreground resume?
 *
 * @param now - current timestamp in ms
 * @param lastResumeAt - last resume timestamp in ms
 * @param debounceMs - minimum interval between resumes (default 800)
 * @param wasHidden - whether the app was hidden before becoming visible
 * @param hasSessions - whether there are any sessions to resume
 * @param hasActiveSession - whether there is an active session
 */
export function shouldResumeForeground(
  now: number,
  lastResumeAt: number,
  debounceMs: number,
  wasHidden: boolean,
  hasSessions: boolean,
  hasActiveSession: boolean,
): ForegroundResumeDecision {
  if (!hasSessions) {
    return { shouldResume: false, skipReason: 'no-sessions' };
  }
  if (now - lastResumeAt < debounceMs) {
    return { shouldResume: false, skipReason: 'debounced' };
  }
  if (!hasActiveSession) {
    return { shouldResume: false, skipReason: 'no-active-session' };
  }
  if (!wasHidden) {
    return { shouldResume: false, skipReason: 'not-hidden' };
  }
  return { shouldResume: true };
}
