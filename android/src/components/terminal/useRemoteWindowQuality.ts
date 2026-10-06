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
  applyRemoteWindowMaxFrameRate,
  clearRemoteWindowVideoObservationWindow,
  createRemoteWindowVideoAdaptiveState,
  resolveRemoteWindowVideoAdaptiveDecision,
  resolveInitialRemoteWindowVideoProfile,
  type RemoteWindowQualityMaxFrameRate,
  type RemoteWindowNetworkQualityInput,
  type RemoteWindowVideoAdaptiveState,
  type RemoteWindowVideoPressureCause,
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
  // The stream id sent to the daemon is the one that owns quality. Readiness
  // of that exact stream is enough; comparing it to a secondary focus ref made
  // the first/active stream unable to accept quality changes.
  qualityStreamActive: boolean;
  videoPreference: RemoteWindowVideoPreference;
  maxBitrateCapBps?: number | null;
  maxFrameRateFps?: RemoteWindowQualityMaxFrameRate;
  target?: RemoteWindowStreamTargetManifest | null;
  updateStreamQuality?: RemoteWindowQualityUpdater;
  collectStatsRef: RefObject<(() => Promise<RemoteWindowVideoStatsSample | null>) | null>;
}

interface RemoteWindowQueuedQuality {
  sessionId: string;
  streamId: string;
  targetId: string;
  qualityKey: string;
  videoProfile: RemoteWindowVideoProfile;
  /**
   * Client-local request origin. `manual` follows the user's desired profile
   * and latest-wins queue; `adaptive` is produced by the pure policy and never
   * queues or overwrites a pending manual intent. Never sent on the wire.
   */
  origin: 'manual' | 'adaptive';
  /**
   * Adaptive requests only: the candidate state returned by the same pure
   * policy call. It is carried inside this request closure and committed only
   * when the matching applied ACK settles; reject/throw/timeout/stale
   * generation discard it and keep the last applied level.
   */
  adaptiveState?: RemoteWindowVideoAdaptiveState | null;
}

interface RemoteWindowActiveQualityRequest {
  generation: number;
  revision: number;
}

function buildQualityKey(options: {
  sessionId: string;
  streamId: string;
  targetId: string;
  videoProfile: RemoteWindowVideoProfile;
}) {
  return `${options.sessionId}|${options.streamId}|${options.targetId}|${JSON.stringify(options.videoProfile)}`;
}

// The receiver binds lane/mediaEpoch/trackId to the stream identity. A sample
// without a confirmable media identity, or one whose identity changed, cannot
// establish credible health; it is treated as unknown instead of inventing a
// second epoch source.
function resolveRemoteWindowStatsIdentity(sample: RemoteWindowVideoStatsSample): string | null {
  const mediaEpoch = typeof sample.mediaEpoch === 'number' && Number.isFinite(sample.mediaEpoch)
    ? sample.mediaEpoch
    : null;
  const trackId = typeof sample.trackId === 'string' && sample.trackId.length > 0 ? sample.trackId : null;
  if (mediaEpoch === null || trackId === null) {
    return null;
  }
  return `${mediaEpoch}|${trackId}`;
}

export function useRemoteWindowQuality({
  activeSessionId,
  streamId,
  targetId,
  mediaPlan,
  streamReady,
  qualityStreamActive,
  videoPreference,
  maxBitrateCapBps,
  maxFrameRateFps = 30,
  target,
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
  const queuedLatestQualityRef = useRef<RemoteWindowQueuedQuality | null>(null);
  const requestQualityRef = useRef<((options: RemoteWindowQueuedQuality) => void) | null>(null);
  const requestGenerationRef = useRef(0);
  const activeRequestRef = useRef<RemoteWindowActiveQualityRequest | null>(null);
  const mountedRef = useRef(false);
  // Applied adaptive level/pressureCause plus the current observation window.
  // This is client-local adaptive state, distinct from the quality
  // transaction state above; candidate tiers are never written here.
  const adaptiveStateRef = useRef<RemoteWindowVideoAdaptiveState | null>(null);
  // Fresh valid samples to observe (without deciding) after a matching applied
  // request. Unknown ticks do not consume these slots.
  const adaptiveSkipSamplesRef = useRef(0);
  const adaptiveIdentityRef = useRef<string | null>(null);
  qualityApplyStateRef.current = qualityApplyState;

  const desiredProfile = useMemo(() => {
    const profile = resolveInitialRemoteWindowVideoProfile(
      videoPreference,
      null,
      false,
      {
        ...(target ? { target } : {}),
        ...(typeof maxBitrateCapBps === 'number' ? { maxBitrateCapBps } : {}),
      },
    );
    return {
      ...applyRemoteWindowMaxFrameRate(profile, maxFrameRateFps),
    };
  }, [maxBitrateCapBps, maxFrameRateFps, target, videoPreference]);
  const desiredProfileRef = useRef(desiredProfile);
  const maxFrameRateFpsRef = useRef(maxFrameRateFps);
  desiredProfileRef.current = desiredProfile;
  maxFrameRateFpsRef.current = maxFrameRateFps;

  useEffect(() => {
    const connection = getRemoteWindowNetworkConnection();
    if (!connection || typeof connection.addEventListener !== 'function') {
      return;
    }
    const handleNetworkChange = () => setNetworkQuality(readRemoteWindowNetworkQuality());
    connection.addEventListener('change', handleNetworkChange);
    return () => connection.removeEventListener('change', handleNetworkChange);
  }, []);

  // Unknown/indecisive or non-applied outcomes must drop the in-progress
  // observation window (consecutive pressure / stable-since / last sample)
  // while retaining the applied level and its cause. A healthy window can
  // therefore never accumulate across a gap.
  const clearAdaptiveObservation = useCallback(() => {
    const previous = adaptiveStateRef.current;
    if (previous) {
      const cleared = clearRemoteWindowVideoObservationWindow(previous);
      adaptiveStateRef.current = cleared;
      setAdaptiveCause(cleared.pressureCause);
    }
  }, []);

  // The single adaptive commit point. It runs only from the request closure
  // after a matching applied ACK. Manual/adaptive both arm skip=2; a manual
  // applied baseline clears the adaptive state, while an adaptive applied
  // adopts the candidate tier carried by that exact closure.
  const commitAppliedAdaptiveQuality = useCallback((options: RemoteWindowQueuedQuality) => {
    adaptiveSkipSamplesRef.current = 2;
    if (options.origin === 'manual') {
      const baseline = createRemoteWindowVideoAdaptiveState();
      adaptiveStateRef.current = baseline;
      setAdaptiveCause(baseline.pressureCause);
      return;
    }
    const candidate = options.adaptiveState;
    if (!candidate) {
      return;
    }
    const committed: RemoteWindowVideoAdaptiveState = {
      pressureCause: candidate.pressureCause,
      level: candidate.level,
      consecutivePressureSamples: 0,
      stableSinceMs: null,
      lastAdjustmentAtMs: Date.now(),
      lastSample: null,
    };
    adaptiveStateRef.current = committed;
    setAdaptiveCause(committed.pressureCause);
  }, []);

  // A tick that cannot establish a usable observation (missing/rejected read,
  // absent media identity) is finalized by the pure policy's unknown branch
  // exactly once: the returned observation window is committed, the applied
  // level/cause are retained, no quality request is dispatched, and the fresh
  // sample slots are left untouched. This runs before any manual-in-flight
  // early return so an in-flight request cannot mask a broken observation.
  const observeUnknownAdaptiveSample = useCallback((generation: number) => {
    if (requestGenerationRef.current !== generation) {
      return;
    }
    const decision = resolveRemoteWindowVideoAdaptiveDecision({
      preference: videoPreference,
      target: target ?? undefined,
      previous: adaptiveStateRef.current,
      sample: null,
      userMaxBitrateBps: desiredProfileRef.current.maxBitrateBps,
      lastAcknowledgedMaxBitrateBps: qualityApplyStateRef.current.acknowledged?.profile.maxBitrateBps ?? null,
    });
    adaptiveStateRef.current = decision.state;
    setAdaptiveCause(decision.cause);
  }, [target, videoPreference]);

  // One serial media tick. The policy runs over the applied adaptive state and
  // the same real sample the receiver just produced; only a matching applied
  // ACK later commits a candidate tier. Auto never queues and never overwrites
  // a pending manual intent, and manual in-flight/skip>0 suppress the dispatch.
  const runAdaptiveQualityTick = useCallback((generation: number, sample: RemoteWindowVideoStatsSample) => {
    if (requestGenerationRef.current !== generation) {
      return;
    }
    // Skip>0 (armed on every matching applied) observes the fresh sample
    // without consulting the policy or dispatching; unknown ticks have already
    // exited before this point.
    if (adaptiveSkipSamplesRef.current > 0) {
      adaptiveSkipSamplesRef.current -= 1;
      return;
    }
    const decision = resolveRemoteWindowVideoAdaptiveDecision({
      preference: videoPreference,
      target: target ?? undefined,
      previous: adaptiveStateRef.current,
      sample,
      userMaxBitrateBps: desiredProfileRef.current.maxBitrateBps,
      lastAcknowledgedMaxBitrateBps: qualityApplyStateRef.current.acknowledged?.profile.maxBitrateBps ?? null,
    });
    setAdaptiveCause(decision.cause);
    // hold/baseline/unknown never change the applied level; commit only those
    // observation fields. A downgrade/restore candidate is deliberately NOT
    // committed here: it rides the request closure and becomes applied state
    // only after the matching ACK.
    if (decision.unknown || decision.reason === 'hold' || decision.reason === 'baseline') {
      adaptiveStateRef.current = decision.state;
      return;
    }
    if (
      qualityApplyStateRef.current.phase === 'requested'
      || queuedLatestQualityRef.current !== null
    ) {
      return;
    }
    // An explicit unsupported rejection stops automatic dispatch for this
    // stream; manual requests and a new stream keep their existing owner path.
    if (qualityApplyStateRef.current.phase === 'rejected' && qualityApplyStateRef.current.unsupported) {
      return;
    }
    if (qualityApplyStateRef.current.acknowledged === null) {
      return;
    }
    const autoProfile = {
      ...applyRemoteWindowMaxFrameRate(decision.profile, maxFrameRateFpsRef.current),
    };
    requestQualityRef.current?.({
      sessionId: activeSessionId ?? '',
      streamId: streamId ?? '',
      targetId: targetId ?? '',
      qualityKey: buildQualityKey({
        sessionId: activeSessionId ?? '',
        streamId: streamId ?? '',
        targetId: targetId ?? '',
        videoProfile: autoProfile,
      }),
      videoProfile: autoProfile,
      origin: 'adaptive',
      adaptiveState: decision.state,
    });
  }, [activeSessionId, streamId, target, targetId, videoPreference]);

  const requestAcknowledgedQuality = useCallback((options: RemoteWindowQueuedQuality) => {
    if (!updateStreamQuality || !mediaPlan) {
      return;
    }
    const current = qualityApplyStateRef.current;
    if (current.phase === 'requested') {
      // Only the latest manual intent queues. An adaptive candidate never
      // queues and never overwrites a pending manual request.
      if (options.origin === 'adaptive') {
        return;
      }
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
    // The transport owner (10s) is the single request timeout; this owner must
    // not race it with a second decision that could settle the same request
    // while the transport promise is still live.
    activeRequestRef.current = {
      generation,
      revision: pending.revision,
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
      if (settled || !mountedRef.current || requestGenerationRef.current !== generation) {
        return;
      }
      settled = true;
      activeRequestRef.current = null;
      const next = acceptRemoteWindowQualityResult(qualityApplyStateRef.current, result);
      qualityApplyStateRef.current = next;
      setQualityApplyState(next);
      if (next.phase === 'applied') {
        commitAppliedAdaptiveQuality(options);
      } else if (next.phase === 'rejected') {
        clearAdaptiveObservation();
      }
      const queued = queuedLatestQualityRef.current;
      if (queued && next.phase === 'applied' && next.qualityKey === queued.qualityKey) {
        queuedLatestQualityRef.current = null;
        return;
      }
      continueWithQueuedLatest();
    }).catch((error) => {
      if (settled || !mountedRef.current || requestGenerationRef.current !== generation) {
        return;
      }
      settled = true;
      activeRequestRef.current = null;
      const next = rejectRemoteWindowQualityRequest({
        state: qualityApplyStateRef.current,
        revision: pending.revision,
        code: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
      qualityApplyStateRef.current = next;
      setQualityApplyState(next);
      clearAdaptiveObservation();
      continueWithQueuedLatest();
    });
  }, [clearAdaptiveObservation, commitAppliedAdaptiveQuality, mediaPlan, updateStreamQuality]);
  requestQualityRef.current = requestAcknowledgedQuality;

  // The acknowledged record is bound to the stream/group identity that applied
  // it. Changing streams tears down the previous record instead of carrying a
  // foreign ACK forward as if it were this stream's last applied profile.
  const streamIdentity = `${activeSessionId || ''}|${streamId || ''}|${targetId || ''}`;
  const previousStreamIdentityRef = useRef(streamIdentity);
  useEffect(() => {
    if (previousStreamIdentityRef.current === streamIdentity) {
      return;
    }
    previousStreamIdentityRef.current = streamIdentity;
    requestGenerationRef.current += 1;
    if (activeRequestRef.current) {
      activeRequestRef.current = null;
    }
    queuedLatestQualityRef.current = null;
    setAdaptiveCause('none');
    adaptiveStateRef.current = null;
    adaptiveSkipSamplesRef.current = 0;
    adaptiveIdentityRef.current = null;
    const next = createRemoteWindowQualityApplyState();
    qualityApplyStateRef.current = next;
    setQualityApplyState(next);
  }, [streamIdentity]);

  const resetQualityState = useCallback(() => {
    requestGenerationRef.current += 1;
    if (activeRequestRef.current) {
      activeRequestRef.current = null;
    }
    queuedLatestQualityRef.current = null;
    setAdaptiveCause('none');
    adaptiveStateRef.current = null;
    adaptiveSkipSamplesRef.current = 0;
    adaptiveIdentityRef.current = null;
    const next = createRemoteWindowQualityApplyState();
    qualityApplyStateRef.current = next;
    setQualityApplyState(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRequestRef.current = null;
      adaptiveStateRef.current = null;
      adaptiveSkipSamplesRef.current = 0;
      adaptiveIdentityRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!streamReady || !qualityStreamActive || !activeSessionId || !streamId || !targetId) {
      return;
    }
    requestAcknowledgedQuality({
      sessionId: activeSessionId,
      streamId,
      targetId,
      qualityKey: buildQualityKey({ sessionId: activeSessionId, streamId, targetId, videoProfile: desiredProfile }),
      videoProfile: desiredProfile,
      origin: 'manual',
    });
  }, [activeSessionId, desiredProfile, qualityStreamActive, requestAcknowledgedQuality, streamId, streamReady, targetId]);

  useEffect(() => {
    if (!streamReady || !qualityStreamActive || !activeSessionId || !streamId || !targetId) {
      return;
    }
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      // The stats effect is generation-guarded through `stopped`: a teardown,
      // identity change or reset flips it and every later callback is dropped.
      const generation = requestGenerationRef.current;
      // A read slower than the tick interval is dropped instead of queued: at
      // most one unsettled observation exists per effect generation.
      if (inFlight || stopped) {
        return;
      }
      const collectStats = collectStatsRef.current;
      if (!collectStats) {
        observeUnknownAdaptiveSample(generation);
        return;
      }
      inFlight = true;
      try {
        const sample = await collectStats();
        if (stopped || requestGenerationRef.current !== generation) {
          return;
        }
        if (!sample) {
          observeUnknownAdaptiveSample(generation);
          return;
        }
        setLastStatsSample(sample);
        const identity = resolveRemoteWindowStatsIdentity(sample);
        if (identity === null) {
          // An unconfirmable identity clears the observation window through the
          // policy unknown branch and never dispatches.
          observeUnknownAdaptiveSample(generation);
          return;
        }
        if (adaptiveIdentityRef.current !== null && adaptiveIdentityRef.current !== identity) {
          // A lane/track identity change admitted by the receiver. Hold this
          // tick as unknown so no sample crosses identities, then advance the
          // observed identity so the next tick can rebuild a baseline. The old
          // identity is never left latched, otherwise adaptive downgrade and
          // restore would stop for the rest of the stream.
          adaptiveIdentityRef.current = identity;
          observeUnknownAdaptiveSample(generation);
          return;
        }
        adaptiveIdentityRef.current = identity;
        runAdaptiveQualityTick(generation, sample);
      } catch (error) {
        if (stopped || requestGenerationRef.current !== generation) {
          return;
        }
        // A rejected read keeps its original diagnostic and is fed into the
        // same policy unknown branch; it is never synthesized into a healthy
        // sample and never dispatches a quality request.
        console.warn('[useRemoteWindowQuality] remote window stats quality update failed:', error);
        observeUnknownAdaptiveSample(generation);
      } finally {
        // Release only this tick's admission; a later generation owns its own.
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void tick(), 2000);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeSessionId, collectStatsRef, observeUnknownAdaptiveSample, qualityStreamActive, runAdaptiveQualityTick, streamId, streamReady, targetId]);

  return {
    activeProfile: qualityApplyState.acknowledged?.profile ?? null,
    adaptiveCause,
    qualityStatus: qualityApplyState.phase === 'applied'
      ? 'applied' as const
      : qualityApplyState.phase === 'requested'
        ? 'requested' as const
        : qualityApplyState.phase === 'rejected'
          ? qualityApplyState.unsupported ? 'unsupported' as const : 'rejected' as const
          : 'idle' as const,
    lastAck: qualityApplyState.acknowledged,
    failureMessage: qualityApplyState.phase === 'rejected' ? qualityApplyState.message : null,
    failureCode: qualityApplyState.phase === 'rejected' ? qualityApplyState.code : null,
    networkQuality,
    qualityApplyState,
    lastStatsSample,
    resetQualityState,
  };
}
