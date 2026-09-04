import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type {
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowVideoPreference,
  RemoteWindowVideoProfile,
  RemoteWindowStreamTargetManifest,
} from '../../lib/types';
import {
  acceptRemoteWindowQualityResult,
  beginRemoteWindowQualityRequest,
  createRemoteWindowQualityApplyState,
  hasRemoteWindowQualityKey,
  rejectRemoteWindowQualityRequest,
  type RemoteWindowQualityApplyState,
} from '../../lib/remote-window-quality-controller';
import {
  resolveInitialRemoteWindowVideoProfile,
  resolveRemoteWindowVideoAdaptiveDecision,
  type RemoteWindowNetworkQualityInput,
  type RemoteWindowVideoAdaptiveState,
  type RemoteWindowVideoPressureCause,
  type RemoteWindowVideoStatsSample,
} from '../../lib/remote-window-video-quality';
import type { RemoteWindowQualityControls } from '../../lib/remote-window-display-orientation';
import {
  getRemoteWindowNetworkConnection,
  readRemoteWindowNetworkQuality,
} from './remote-window-overlay-helpers';

export const REMOTE_WINDOW_QUALITY_REQUEST_TIMEOUT_MS = 8_000;

export type RemoteWindowQualityUpdater = (
  sessionId: string,
  payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>,
) => Promise<RemoteWindowStreamQualityResultPayload>;

export interface UseRemoteWindowQualityOptions {
  activeSessionId: string | null | undefined;
  streamId: string | null;
  targetId: string | null;
  mediaPlan: RemoteWindowStreamQualityRequestPayload['mediaPlan'] | null;
  streamReady: boolean;
  focusStreamActive: boolean;
  videoPreference: RemoteWindowVideoPreference;
  qualityControls?: RemoteWindowQualityControls;
  target?: RemoteWindowStreamTargetManifest | null;
  interactionActive: boolean;
  updateStreamQuality?: RemoteWindowQualityUpdater;
  collectStatsRef: RefObject<(() => Promise<RemoteWindowVideoStatsSample | null>) | null>;
}

interface RemoteWindowQueuedQuality {
  sessionId: string;
  streamId: string;
  targetId: string;
  qualityKey: string;
  videoProfile: RemoteWindowVideoProfile;
}

interface RemoteWindowActiveQualityRequest {
  generation: number;
  revision: number;
  timeoutId: number;
}

function buildQualityKey(options: {
  sessionId: string;
  streamId: string;
  targetId: string;
  videoProfile: RemoteWindowVideoProfile;
}) {
  return `${options.sessionId}|${options.streamId}|${options.targetId}|${JSON.stringify(options.videoProfile)}`;
}

export function useRemoteWindowQuality({
  activeSessionId,
  streamId,
  targetId,
  mediaPlan,
  streamReady,
  focusStreamActive,
  videoPreference,
  qualityControls = { bitrateMultiplier: 1, maxFrameRateFps: 30 },
  target,
  interactionActive,
  updateStreamQuality,
  collectStatsRef,
}: UseRemoteWindowQualityOptions) {
  const [networkQuality, setNetworkQuality] = useState<RemoteWindowNetworkQualityInput | null>(
    () => readRemoteWindowNetworkQuality(),
  );
  const [qualityApplyState, setQualityApplyState] = useState<RemoteWindowQualityApplyState>(
    () => createRemoteWindowQualityApplyState(),
  );
  const [adaptiveCause, setAdaptiveCause] = useState<RemoteWindowVideoPressureCause>('none');
  const [lastStatsSample, setLastStatsSample] = useState<RemoteWindowVideoStatsSample | null>(null);
  const qualityApplyStateRef = useRef(qualityApplyState);
  const adaptiveStateRef = useRef<RemoteWindowVideoAdaptiveState | null>(null);
  const queuedLatestQualityRef = useRef<RemoteWindowQueuedQuality | null>(null);
  const cooldownSamplesRemainingRef = useRef(0);
  const requestQualityRef = useRef<((options: RemoteWindowQueuedQuality) => void) | null>(null);
  const requestGenerationRef = useRef(0);
  const activeRequestRef = useRef<RemoteWindowActiveQualityRequest | null>(null);
  qualityApplyStateRef.current = qualityApplyState;

  const desiredProfile = useMemo(() => {
    const qualityTier = videoPreference === 'smooth' ? 'smooth-720' : videoPreference === 'quality' ? 'quality-1080' : 'ultra-2160';
    const profile = resolveInitialRemoteWindowVideoProfile(
      videoPreference,
      networkQuality,
      interactionActive,
      target
        ? { target, qualityTier, budgetMultiplier: qualityControls.bitrateMultiplier }
        : { qualityTier, budgetMultiplier: qualityControls.bitrateMultiplier },
    );
    return {
      ...profile,
      maxFrameRateFps: qualityControls.maxFrameRateFps,
    };
  }, [interactionActive, networkQuality, qualityControls, target, videoPreference]);

  useEffect(() => {
    const connection = getRemoteWindowNetworkConnection();
    if (!connection || typeof connection.addEventListener !== 'function') {
      return;
    }
    const handleNetworkChange = () => setNetworkQuality(readRemoteWindowNetworkQuality());
    connection.addEventListener('change', handleNetworkChange);
    return () => connection.removeEventListener('change', handleNetworkChange);
  }, []);

  const requestAcknowledgedQuality = useCallback((options: RemoteWindowQueuedQuality) => {
    if (!updateStreamQuality || !mediaPlan) {
      return;
    }
    const current = qualityApplyStateRef.current;
    if (current.phase === 'requested') {
      if (current.qualityKey !== options.qualityKey) {
        queuedLatestQualityRef.current = options;
      }
      return;
    }
    if (hasRemoteWindowQualityKey(current, options.qualityKey)) {
      return;
    }
    const pending = beginRemoteWindowQualityRequest({
      state: current,
      qualityKey: options.qualityKey,
      requested: options.videoProfile,
    });
    qualityApplyStateRef.current = pending.state;
    setQualityApplyState(pending.state);

    let settled = false;
    const generation = requestGenerationRef.current;
    const continueWithQueuedLatest = () => {
      const queued = queuedLatestQualityRef.current;
      queuedLatestQualityRef.current = null;
      if (queued) {
        queueMicrotask(() => requestQualityRef.current?.(queued));
      }
    };
    const timeoutId = window.setTimeout(() => {
      if (
        settled
        || requestGenerationRef.current !== generation
        || activeRequestRef.current?.revision !== pending.revision
      ) {
        return;
      }
      settled = true;
      activeRequestRef.current = null;
      const next = rejectRemoteWindowQualityRequest({
        state: qualityApplyStateRef.current,
        revision: pending.revision,
        message: `remote window quality request timed out after ${REMOTE_WINDOW_QUALITY_REQUEST_TIMEOUT_MS}ms`,
      });
      qualityApplyStateRef.current = next;
      setQualityApplyState(next);
      continueWithQueuedLatest();
    }, REMOTE_WINDOW_QUALITY_REQUEST_TIMEOUT_MS);
    activeRequestRef.current = {
      generation,
      revision: pending.revision,
      timeoutId,
    };

    void updateStreamQuality(options.sessionId, {
      streamId: options.streamId,
      streamGroupId: options.streamId,
      mediaPlan,
      mediaPlanVersion: 2,
      revision: pending.revision,
      targetId: options.targetId,
      videoProfile: options.videoProfile,
    }).then((result) => {
      if (settled || requestGenerationRef.current !== generation) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      activeRequestRef.current = null;
      const next = acceptRemoteWindowQualityResult(qualityApplyStateRef.current, result);
      qualityApplyStateRef.current = next;
      setQualityApplyState(next);
      if (next.phase === 'applied') {
        cooldownSamplesRemainingRef.current = 2;
      }
      const queued = queuedLatestQualityRef.current;
      if (queued && next.phase === 'applied' && next.qualityKey === queued.qualityKey) {
        queuedLatestQualityRef.current = null;
        return;
      }
      continueWithQueuedLatest();
    }).catch((error) => {
      if (settled || requestGenerationRef.current !== generation) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      activeRequestRef.current = null;
      const next = rejectRemoteWindowQualityRequest({
        state: qualityApplyStateRef.current,
        revision: pending.revision,
        message: error instanceof Error ? error.message : String(error),
      });
      qualityApplyStateRef.current = next;
      setQualityApplyState(next);
      continueWithQueuedLatest();
    });
  }, [mediaPlan, updateStreamQuality]);
  requestQualityRef.current = requestAcknowledgedQuality;

  const resetQualityState = useCallback(() => {
    requestGenerationRef.current += 1;
    if (activeRequestRef.current) {
      window.clearTimeout(activeRequestRef.current.timeoutId);
      activeRequestRef.current = null;
    }
    adaptiveStateRef.current = null;
    queuedLatestQualityRef.current = null;
    cooldownSamplesRemainingRef.current = 0;
    setAdaptiveCause('none');
    const next = createRemoteWindowQualityApplyState();
    qualityApplyStateRef.current = next;
    setQualityApplyState(next);
  }, []);

  useEffect(() => () => {
    requestGenerationRef.current += 1;
    if (activeRequestRef.current) {
      window.clearTimeout(activeRequestRef.current.timeoutId);
      activeRequestRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!streamReady || !focusStreamActive || !activeSessionId || !streamId || !targetId) {
      return;
    }
    requestAcknowledgedQuality({
      sessionId: activeSessionId,
      streamId,
      targetId,
      qualityKey: buildQualityKey({ sessionId: activeSessionId, streamId, targetId, videoProfile: desiredProfile }),
      videoProfile: desiredProfile,
    });
  }, [activeSessionId, desiredProfile, focusStreamActive, requestAcknowledgedQuality, streamId, streamReady, targetId]);

  useEffect(() => {
    if (!streamReady || !focusStreamActive || !activeSessionId || !streamId || !targetId) {
      return;
    }
    let stopped = false;
    const tick = async () => {
      const collectStats = collectStatsRef.current;
      if (!collectStats) {
        return;
      }
      try {
        const sample = await collectStats();
        if (stopped || !sample) {
          return;
        }
        setLastStatsSample(sample);
        if (cooldownSamplesRemainingRef.current > 0) {
          cooldownSamplesRemainingRef.current -= 1;
          return;
        }
        const decision = resolveRemoteWindowVideoAdaptiveDecision({
          preference: videoPreference,
          target,
          interactionActive,
          previous: adaptiveStateRef.current,
          sample,
        });
        adaptiveStateRef.current = decision.state;
        setAdaptiveCause(decision.cause);
        requestAcknowledgedQuality({
          sessionId: activeSessionId,
          streamId,
          targetId,
          qualityKey: buildQualityKey({
            sessionId: activeSessionId,
            streamId,
            targetId,
            videoProfile: decision.profile,
          }),
          videoProfile: decision.profile,
        });
      } catch (error) {
        console.warn('[useRemoteWindowQuality] remote window stats quality update failed:', error);
      }
    };
    const timer = window.setInterval(() => void tick(), 2000);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeSessionId, collectStatsRef, focusStreamActive, interactionActive, requestAcknowledgedQuality, streamId, streamReady, target, targetId, videoPreference]);

  return {
    activeProfile: qualityApplyState.phase === 'applied' ? qualityApplyState.applied : desiredProfile,
    adaptiveCause,
    networkQuality,
    qualityApplyState,
    lastStatsSample,
    resetQualityState,
  };
}
