import { useCallback, useEffect, useRef, useState } from 'react';
import {
  REMOTE_WINDOW_BITRATE_MULTIPLIER_AUTO,
  type RemoteWindowQualityMaxFrameRate,
  type RemoteWindowVideoBudgetMultiplier,
} from '../../lib/remote-window-video-quality';
import {
  readRemoteWindowBitrateMultiplierSelection,
  readRemoteWindowDisplayOrientation,
  readRemoteWindowMaxFrameRate,
  writeRemoteWindowBitrateMultiplierSelection,
  writeRemoteWindowDisplayOrientation,
  writeRemoteWindowMaxFrameRate,
  type RemoteWindowBitrateMultiplierSelection,
} from './remote-window-overlay-storage';
import type { RemoteWindowOrientationPolicy } from './remote-window-overlay-helpers';

export interface RemoteWindowDisplayQualityControls {
  displayOrientation: RemoteWindowOrientationPolicy;
  displayOrientationRef: { readonly current: RemoteWindowOrientationPolicy };
  bitrateMultiplierSelection: RemoteWindowBitrateMultiplierSelection;
  bitrateMultiplierRef: { readonly current: RemoteWindowBitrateMultiplierSelection };
  maxFrameRateFps: RemoteWindowQualityMaxFrameRate;
  resolveBudgetMultiplier: () => RemoteWindowVideoBudgetMultiplier | undefined;
  setDisplayOrientation: (orientation: RemoteWindowOrientationPolicy) => void;
  setBitrateMultiplierSelection: (selection: RemoteWindowBitrateMultiplierSelection) => void;
  setMaxFrameRateFps: (frameRate: RemoteWindowQualityMaxFrameRate) => void;
}

export function useRemoteWindowDisplayQualityControls(): RemoteWindowDisplayQualityControls {
  const [displayOrientation, setDisplayOrientationState] = useState<RemoteWindowOrientationPolicy>(
    () => readRemoteWindowDisplayOrientation(),
  );
  const [bitrateMultiplierSelection, setBitrateMultiplierSelectionState] = useState<RemoteWindowBitrateMultiplierSelection>(
    () => readRemoteWindowBitrateMultiplierSelection(),
  );
  const [maxFrameRateFps, setMaxFrameRateFpsState] = useState<RemoteWindowQualityMaxFrameRate>(
    () => readRemoteWindowMaxFrameRate(),
  );
  const displayOrientationRef = useRef(displayOrientation);
  const bitrateMultiplierRef = useRef(bitrateMultiplierSelection);
  useEffect(() => {
    displayOrientationRef.current = displayOrientation;
    bitrateMultiplierRef.current = bitrateMultiplierSelection;
  }, [bitrateMultiplierSelection, displayOrientation]);

  const setDisplayOrientation = useCallback((orientation: RemoteWindowOrientationPolicy) => {
    displayOrientationRef.current = orientation;
    setDisplayOrientationState(orientation);
    writeRemoteWindowDisplayOrientation(orientation);
  }, []);
  const setBitrateMultiplierSelection = useCallback((selection: RemoteWindowBitrateMultiplierSelection) => {
    setBitrateMultiplierSelectionState(selection);
    writeRemoteWindowBitrateMultiplierSelection(selection);
  }, []);
  const setMaxFrameRateFps = useCallback((frameRate: RemoteWindowQualityMaxFrameRate) => {
    setMaxFrameRateFpsState(frameRate);
    writeRemoteWindowMaxFrameRate(frameRate);
  }, []);
  const resolveBudgetMultiplier = useCallback(() => (
    bitrateMultiplierRef.current === REMOTE_WINDOW_BITRATE_MULTIPLIER_AUTO
      ? undefined
      : bitrateMultiplierRef.current
  ), []);

  return {
    displayOrientation,
    displayOrientationRef,
    bitrateMultiplierSelection,
    bitrateMultiplierRef,
    maxFrameRateFps,
    resolveBudgetMultiplier,
    setDisplayOrientation,
    setBitrateMultiplierSelection,
    setMaxFrameRateFps,
  };
}
