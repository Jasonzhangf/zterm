import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type {
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowVideoBitrateConfig,
  RemoteWindowVideoBitratePreset,
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
  buildRemoteWindowVideoBitrateConfig,
  resolveAdaptiveRemoteWindowVideoBitratePreset,
  resolveEffectiveRemoteWindowVideoBitratePreset,
  resolveRemoteWindowVideoAdaptiveDecision,
  type RemoteWindowNetworkQualityInput,
  type RemoteWindowVideoAdaptiveState,
  type RemoteWindowVideoStatsSample,
} from '../../lib/remote-window-video-quality';
import {
  getRemoteWindowNetworkConnection,
  readRemoteWindowNetworkQuality,
} from './remote-window-overlay-helpers';

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
  mode: 'floating' | 'fullscreen' | null;
  fullscreenScale: number;
  bitratePreset: RemoteWindowVideoBitratePreset;
  updateStreamQuality?: RemoteWindowQualityUpdater;
  collectStatsRef: RefObject<(() => Promise<RemoteWindowVideoStatsSample | null>) | null>;
}

export function useRemoteWindowQuality({
  activeSessionId,
  streamId,
  targetId,
  mediaPlan,
  streamReady,
  focusStreamActive,
  mode,
  fullscreenScale,
  bitratePreset,
  updateStreamQuality,
  collectStatsRef,
}: UseRemoteWindowQualityOptions) {
  const [networkQuality, setNetworkQuality] = useState<RemoteWindowNetworkQualityInput | null>(
    () => readRemoteWindowNetworkQuality(),
  );
  const [qualityApplyState, setQualityApplyState] = useState<RemoteWindowQualityApplyState>(
    () => createRemoteWindowQualityApplyState(),
  );
  const qualityApplyStateRef = useRef(qualityApplyState);
  const adaptiveStateRef = useRef<RemoteWindowVideoAdaptiveState | null>(null);
  qualityApplyStateRef.current = qualityApplyState;

  const effectiveBitratePreset = mode
    ? resolveEffectiveRemoteWindowVideoBitratePreset(bitratePreset, { mode, fullscreenScale })
    : null;
  const adaptiveBitratePreset = effectiveBitratePreset
    ? resolveAdaptiveRemoteWindowVideoBitratePreset(effectiveBitratePreset, networkQuality)
    : null;

  useEffect(() => {
    const connection = getRemoteWindowNetworkConnection();
    if (!connection || typeof connection.addEventListener !== 'function') {
      return;
    }
    const handleNetworkChange = () => setNetworkQuality(readRemoteWindowNetworkQuality());
    connection.addEventListener('change', handleNetworkChange);
    return () => connection.removeEventListener('change', handleNetworkChange);
  }, []);

  const requestAcknowledgedQuality = useCallback((options: {
    sessionId: string;
    streamId: string;
    targetId: string;
    qualityKey: string;
    videoBitrate: RemoteWindowVideoBitrateConfig;
  }) => {
    if (!updateStreamQuality || !mediaPlan || hasRemoteWindowQualityKey(qualityApplyStateRef.current, options.qualityKey)) {
      return;
    }
    const pending = beginRemoteWindowQualityRequest({
      state: qualityApplyStateRef.current,
      qualityKey: options.qualityKey,
      requested: options.videoBitrate,
    });
    qualityApplyStateRef.current = pending.state;
    setQualityApplyState(pending.state);
    void updateStreamQuality(options.sessionId, {
      streamId: options.streamId,
      streamGroupId: options.streamId,
      mediaPlan,
      mediaPlanVersion: 1,
      revision: pending.revision,
      targetId: options.targetId,
      videoBitrate: options.videoBitrate,
    }).then((result) => {
      const next = acceptRemoteWindowQualityResult(qualityApplyStateRef.current, result);
      qualityApplyStateRef.current = next;
      setQualityApplyState(next);
    }).catch((error) => {
      const next = rejectRemoteWindowQualityRequest({
        state: qualityApplyStateRef.current,
        revision: pending.revision,
        message: error instanceof Error ? error.message : String(error),
      });
      qualityApplyStateRef.current = next;
      setQualityApplyState(next);
    });
  }, [mediaPlan, updateStreamQuality]);

  const resetQualityState = useCallback(() => {
    adaptiveStateRef.current = null;
    const next = createRemoteWindowQualityApplyState();
    qualityApplyStateRef.current = next;
    setQualityApplyState(next);
  }, []);

  useEffect(() => {
    if (!streamReady || !focusStreamActive || !activeSessionId || !streamId || !targetId || !adaptiveBitratePreset) {
      return;
    }
    const videoBitrate = buildRemoteWindowVideoBitrateConfig(adaptiveBitratePreset);
    requestAcknowledgedQuality({
      sessionId: activeSessionId,
      streamId,
      targetId,
      qualityKey: [
        activeSessionId,
        streamId,
        targetId,
        adaptiveBitratePreset,
        videoBitrate.maxBitrateBps,
        videoBitrate.maxFrameRateFps ?? '',
      ].join('|'),
      videoBitrate,
    });
  }, [activeSessionId, adaptiveBitratePreset, focusStreamActive, requestAcknowledgedQuality, streamId, streamReady, targetId]);

  useEffect(() => {
    if (!streamReady || !focusStreamActive || !activeSessionId || !streamId || !targetId || !adaptiveBitratePreset) {
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
        const decision = resolveRemoteWindowVideoAdaptiveDecision({
          baseline: buildRemoteWindowVideoBitrateConfig(adaptiveBitratePreset),
          previous: adaptiveStateRef.current,
          sample,
        });
        adaptiveStateRef.current = decision.state;
        requestAcknowledgedQuality({
          sessionId: activeSessionId,
          streamId,
          targetId,
          qualityKey: [
            activeSessionId,
            streamId,
            targetId,
            decision.config.preset,
            decision.config.maxBitrateBps,
            decision.config.maxFrameRateFps ?? '',
          ].join('|'),
          videoBitrate: decision.config,
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
  }, [activeSessionId, adaptiveBitratePreset, collectStatsRef, focusStreamActive, requestAcknowledgedQuality, streamId, streamReady, targetId]);

  return {
    adaptiveBitratePreset,
    networkQuality,
    qualityApplyState,
    resetQualityState,
  };
}
