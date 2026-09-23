import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  budgetMultiplier: RemoteWindowVideoBudgetMultiplier | undefined;
  maxFrameRateFps: RemoteWindowQualityMaxFrameRate;
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
  useEffect(() => {
    displayOrientationRef.current = displayOrientation;
  }, [displayOrientation]);
  // Single truth: the derived budget multiplier follows the selection state on
  // the render path, so a change can never be read one render late.
  const budgetMultiplier = useMemo(() => (
    bitrateMultiplierSelection === REMOTE_WINDOW_BITRATE_MULTIPLIER_AUTO
      ? undefined
      : bitrateMultiplierSelection
  ), [bitrateMultiplierSelection]);

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
  return {
    displayOrientation,
    displayOrientationRef,
    bitrateMultiplierSelection,
    budgetMultiplier,
    maxFrameRateFps,
    setDisplayOrientation,
    setBitrateMultiplierSelection,
    setMaxFrameRateFps,
  };
}
