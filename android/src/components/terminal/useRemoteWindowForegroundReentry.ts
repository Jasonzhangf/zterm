import { useEffect, useRef } from 'react';
import type { RemoteWindowOverlayState } from '../../lib/remote-window-overlay-runtime';

export interface UseRemoteWindowForegroundReentryOptions {
  appForegroundActive: boolean | undefined;
  state: RemoteWindowOverlayState;
  onReopenPicker: () => void;
}

/**
 * Foreground reentry must refresh the catalog and clear stale transport errors.
 *
 * The overlay already owns the picker lifecycle; this hook only re-issues a
 * bounded open when appForegroundActive turns true and the overlay is still
 * parked on a stale `pickerOpen + errorMessage` or `targetEnumerating` state.
 * We do NOT reopen from `closed` on every mount: the entry button click
 * already owns that transition.
 */
export function useRemoteWindowForegroundReentry({
  appForegroundActive,
  state,
  onReopenPicker,
}: UseRemoteWindowForegroundReentryOptions): void {
  const previousAppForegroundActiveRef = useRef(appForegroundActive !== false);
  useEffect(() => {
    const isForeground = appForegroundActive !== false;
    const becameForeground = isForeground && !previousAppForegroundActiveRef.current;
    previousAppForegroundActiveRef.current = isForeground;
    if (!becameForeground || state.phase === 'closed' || state.phase === 'targetLocked') {
      return;
    }
    if (state.phase === 'targetEnumerating' || (state.phase === 'pickerOpen' && Boolean(state.errorMessage))) {
      onReopenPicker();
    }
  }, [appForegroundActive, onReopenPicker, state]);
}
