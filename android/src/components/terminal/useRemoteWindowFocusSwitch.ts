import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import {
  beginRemoteWindowDualStreamSwitch,
  failRemoteWindowDualStreamSwitch,
  showRemoteWindowOverviewCrop,
  type RemoteWindowDualStreamState,
} from '../../lib/remote-window-dual-stream-runtime';

export interface UseRemoteWindowFocusSwitchOptions {
  activeSessionId: string | null | undefined;
  activeStreamIdRef: RefObject<string | null>;
  activeFocusStreamIdRef: RefObject<string | null>;
  dualStreamState: RemoteWindowDualStreamState;
  setDualStreamState: Dispatch<SetStateAction<RemoteWindowDualStreamState>>;
  setFocusedWindowId: Dispatch<SetStateAction<string | null>>;
  updateFocus?: (
    sessionId: string,
    streamId: string,
    target: RemoteWindowStreamTargetManifest,
    revision?: number,
  ) => void;
}

export function useRemoteWindowFocusSwitch({
  activeSessionId,
  activeStreamIdRef,
  activeFocusStreamIdRef,
  dualStreamState,
  setDualStreamState,
  setFocusedWindowId,
  updateFocus,
}: UseRemoteWindowFocusSwitchOptions) {
  return useCallback((options: {
    target: RemoteWindowStreamTargetManifest | null;
    targetId: string;
    windowId: string;
  }) => {
    const focusStreamId = activeFocusStreamIdRef.current || activeStreamIdRef.current;
    setFocusedWindowId(options.windowId);
    const switchState = showRemoteWindowOverviewCrop(
      beginRemoteWindowDualStreamSwitch(dualStreamState, options.targetId),
      options.targetId,
      options.windowId,
    );
    setDualStreamState({ ...switchState, focusStreamId });
    if (focusStreamId && options.target && updateFocus && activeSessionId) {
      updateFocus(activeSessionId, focusStreamId, options.target, switchState.revision);
      return;
    }
    setDualStreamState((current) => failRemoteWindowDualStreamSwitch(
      current,
      !focusStreamId
        ? 'Remote window focus switch requires an active focus stream'
        : !options.target
          ? 'Remote window focus switch target is missing from the catalog'
          : !updateFocus
            ? 'Remote window focus switch transport is unavailable'
            : 'Remote window focus switch requires an active session',
    ));
  }, [
    activeFocusStreamIdRef,
    activeSessionId,
    activeStreamIdRef,
    dualStreamState,
    setDualStreamState,
    setFocusedWindowId,
    updateFocus,
  ]);
}
