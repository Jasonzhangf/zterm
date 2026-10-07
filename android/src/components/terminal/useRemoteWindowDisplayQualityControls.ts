import { useCallback, useEffect, useRef, useState } from 'react';
import {
  resolveRemoteWindowVideoCapBps,
  resolveRemoteWindowVideoTargetKey,
  type RemoteWindowVideoQualitySettings,
} from '../../lib/remote-window-video-quality';
import {
  readRemoteWindowDisplayOrientation,
  readRemoteWindowVideoQualitySettings,
  writeRemoteWindowDisplayOrientation,
  writeRemoteWindowVideoQualitySettings,
} from './remote-window-overlay-storage';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import type { RemoteWindowOrientationPolicy } from './remote-window-overlay-helpers';

const DEFAULT_QUALITY_SETTINGS: RemoteWindowVideoQualitySettings = {
  preference: 'smooth',
  maxBitrateCapMbps: null,
  maxFrameRateFps: 30,
};

export interface RemoteWindowDisplayQualityControls {
  displayOrientation: RemoteWindowOrientationPolicy;
  displayOrientationRef: { readonly current: RemoteWindowOrientationPolicy };
  qualitySettings: RemoteWindowVideoQualitySettings;
  maxBitrateCapBps: number | null;
  setDisplayOrientation: (orientation: RemoteWindowOrientationPolicy) => void;
  commitQualitySettings: (
    settings: RemoteWindowVideoQualitySettings,
  ) => boolean;
}

export interface UseRemoteWindowDisplayQualityControlsOptions {
  target: RemoteWindowStreamTargetManifest | null;
}

export function useRemoteWindowDisplayQualityControls(
  options: UseRemoteWindowDisplayQualityControlsOptions = { target: null },
): RemoteWindowDisplayQualityControls {
  const { target } = options;
  const [displayOrientation, setDisplayOrientationState] = useState<RemoteWindowOrientationPolicy>(
    () => readRemoteWindowDisplayOrientation(),
  );
  const [qualitySettings, setQualitySettings] = useState<RemoteWindowVideoQualitySettings>(
    () => target ? readRemoteWindowVideoQualitySettings(target) : DEFAULT_QUALITY_SETTINGS,
  );
  const targetKey = target ? resolveRemoteWindowVideoTargetKey(target) : null;
  const loadedTargetKeyRef = useRef<string | null>(targetKey);
  const displayOrientationRef = useRef(displayOrientation);

  // Reload the committed settings when the selected remote target changes.
  useEffect(() => {
    if (!targetKey || targetKey === loadedTargetKeyRef.current) {
      return;
    }
    loadedTargetKeyRef.current = targetKey;
    setQualitySettings(readRemoteWindowVideoQualitySettings(target as RemoteWindowStreamTargetManifest));
  }, [target, targetKey]);

  useEffect(() => {
    displayOrientationRef.current = displayOrientation;
  }, [displayOrientation]);

  // The cap is a render-path derivation of the committed Mbps setting, so a
  // commit is never read one render late through a synced ref.
  const maxBitrateCapBps = qualitySettings.maxBitrateCapMbps === null
    ? null
    : resolveRemoteWindowVideoCapBps(qualitySettings.maxBitrateCapMbps);

  const setDisplayOrientation = useCallback((orientation: RemoteWindowOrientationPolicy) => {
    displayOrientationRef.current = orientation;
    setDisplayOrientationState(orientation);
    writeRemoteWindowDisplayOrientation(orientation);
  }, []);

  // Apply persists the desired truth and updates the single committed state in
  // one action. Drafts and Cancel never reach this entry point.
  const commitQualitySettings = useCallback((settings: RemoteWindowVideoQualitySettings) => {
    if (!writeRemoteWindowVideoQualitySettings(target as RemoteWindowStreamTargetManifest, settings)) {
      return false;
    }
    setQualitySettings(settings);
    return true;
  }, [target]);

  return {
    displayOrientation,
    displayOrientationRef,
    qualitySettings,
    maxBitrateCapBps,
    setDisplayOrientation,
    commitQualitySettings,
  };
}
