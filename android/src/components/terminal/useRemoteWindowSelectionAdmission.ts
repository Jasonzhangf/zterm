import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { RemoteWindowStreamTargetManifest, RemoteWindowStreamTargetsResponsePayload } from '../../lib/types';
import { resolveFreshRemoteWindowTarget, type RemoteWindowOverlayState } from '../../lib/remote-window-overlay-runtime';

interface RemoteWindowSelectionAdmissionOptions {
  activeSessionId: string | null | undefined;
  state: RemoteWindowOverlayState;
  setState: Dispatch<SetStateAction<RemoteWindowOverlayState>>;
  requestFreshTargets: (sessionId: string) => Promise<RemoteWindowStreamTargetsResponsePayload>;
  streamEnabled: boolean;
  streamRequestEpochRef: MutableRefObject<number>;
  onAdmitted: (
    target: RemoteWindowStreamTargetManifest,
    catalogTargets: RemoteWindowStreamTargetManifest[],
    streamRequestEpoch: number,
  ) => void;
}

export function useRemoteWindowSelectionAdmission({
  activeSessionId,
  state,
  setState,
  requestFreshTargets,
  streamEnabled,
  streamRequestEpochRef,
  onAdmitted,
}: RemoteWindowSelectionAdmissionOptions) {
  return useCallback((selectedTarget: RemoteWindowStreamTargetManifest) => {
    const streamRequestEpoch = ++streamRequestEpochRef.current;
    const catalogTargets = 'targets' in state ? state.targets : [];
    const targetSessionId = activeSessionId?.trim() || '';
    if (!streamEnabled || !targetSessionId) {
      onAdmitted(selectedTarget, catalogTargets, streamRequestEpoch);
      return;
    }

    void requestFreshTargets(targetSessionId).then((payload) => {
      if (streamRequestEpochRef.current !== streamRequestEpoch) {
        return;
      }
      const freshTarget = resolveFreshRemoteWindowTarget(selectedTarget, payload.targets);
      if (freshTarget) {
        onAdmitted(freshTarget, payload.targets, streamRequestEpoch);
        return;
      }
      const appIdentity = [
        selectedTarget.videoTarget.appBundleId?.trim(),
        selectedTarget.videoTarget.pid ? `pid ${selectedTarget.videoTarget.pid}` : null,
      ].filter(Boolean).join(', ');
      setState((current) => current.phase === 'pickerOpen'
        ? {
            ...current,
            targets: payload.targets,
            errors: payload.errors ?? [],
            errorMessage: `远程窗口已变化，刷新后未找到唯一匹配窗口${appIdentity ? `（${appIdentity}）` : ''}，请重新选择`,
          }
        : current);
    }).catch((error: unknown) => {
      if (streamRequestEpochRef.current !== streamRequestEpoch) {
        return;
      }
      setState((current) => current.phase === 'pickerOpen'
        ? { ...current, errorMessage: `远程窗口刷新失败：${error instanceof Error ? error.message : String(error)}` }
        : current);
    });
  }, [activeSessionId, onAdmitted, requestFreshTargets, setState, state, streamEnabled, streamRequestEpochRef]);
}
