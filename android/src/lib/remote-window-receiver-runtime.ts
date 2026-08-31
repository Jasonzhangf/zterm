import type {
  RemoteWindowStreamIceCandidatePayload,
  RemoteWindowStreamPurpose,
  RemoteWindowStreamRtcDescription,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamStartedOfferV2Payload,
  RemoteWindowStreamAnswerV2Payload,
  RemoteWindowStreamTargetManifest,
} from './types';
import { getRemoteWindowMediaPlanContract, getRemoteWindowMediaPlanV2Contract } from '@zterm/shared/protocol';
import type { RemoteWindowVideoStatsSample } from './remote-window-video-quality';

export interface RemoteWindowReceiverStartResult {
  streamId: string;
  purpose?: RemoteWindowStreamPurpose;
  mediaStream: MediaStream;
  overviewMediaStream?: MediaStream;
  started: RemoteWindowStreamStartedPayload | RemoteWindowStreamStartedOfferV2Payload;
  startupTelemetry?: RemoteWindowReceiverStartupTelemetry;
  collectStats?: () => Promise<RemoteWindowVideoStatsSample | null>;
}

export interface RemoteWindowReceiverStartupTelemetry {
  captureStartedAt: number;
  answerAppliedAt: number;
  focusTrackAttachedAt: number;
  overviewTrackAttachedAt?: number;
}

export const REMOTE_WINDOW_RECEIVER_TRACK_TIMEOUT_MS = 25_000;

interface ActiveRemoteWindowReceiverStream {
  streamId: string;
  purpose?: RemoteWindowStreamPurpose;
  peerConnection: RTCPeerConnection;
  mediaStream: MediaStream;
  overviewMediaStream: MediaStream | null;
  cleanupDone: boolean;
  needsOverview: boolean;
  trackAttached: boolean;
  overviewTrackAttached: boolean;
  requiredLaneRoles: readonly ('focus' | 'overview')[];
  remoteDescriptionApplied: boolean;
  pendingIceCandidates: RTCIceCandidateInit[];
  remoteStartDispatched: boolean;
  remoteRequestId: string | null;
  pendingLocalIceCandidates: RemoteWindowStreamIceCandidatePayload['candidate'][];
  captureStartedAt: number | null;
  answerAppliedAt: number | null;
  focusTrackAttachedAt: number | null;
  overviewTrackAttachedAt: number | null;
  trackTimeoutIds: Map<'focus' | 'overview', ReturnType<typeof setTimeout>>;
  trackWaitStartedAt: number | null;
  resolveTrack: ((result: { mediaStream: MediaStream; overviewMediaStream: MediaStream | null }) => void) | null;
  rejectTrack: ((error: Error) => void) | null;
  statsBaseline: {
    framesDropped: number;
    freezeCount: number;
    jitterBufferDelay: number;
    jitterBufferEmittedCount: number;
  } | null;
}

function normalizeLocalCandidate(candidate: RTCIceCandidate): RemoteWindowStreamIceCandidatePayload['candidate'] {
  const candidateLike = typeof candidate.toJSON === 'function'
    ? candidate.toJSON()
    : candidate;
  return {
    candidate: String(candidateLike.candidate || ''),
    sdpMid: candidateLike.sdpMid ?? null,
    sdpMLineIndex: candidateLike.sdpMLineIndex ?? null,
    usernameFragment: candidateLike.usernameFragment ?? null,
  };
}

function normalizeRtcDescription(
  description: RTCSessionDescriptionInit | RTCSessionDescription | null,
  expectedType: RemoteWindowStreamRtcDescription['type'],
): RemoteWindowStreamRtcDescription {
  if (!description || description.type !== expectedType || typeof description.sdp !== 'string') {
    throw new Error(`Remote window receiver expected ${expectedType} description`);
  }
  return {
    type: expectedType,
    sdp: description.sdp,
  };
}

function resolvePeerConnectionFactory(
  factory?: (configuration: RTCConfiguration) => RTCPeerConnection,
) {
  if (factory) {
    return factory;
  }
  if (typeof globalThis.RTCPeerConnection !== 'function') {
    throw new Error('Remote window receiver requires RTCPeerConnection');
  }
  return (configuration: RTCConfiguration) => new globalThis.RTCPeerConnection(configuration);
}

function resolveMediaStreamFactory(factory?: () => MediaStream) {
  if (factory) {
    return factory;
  }
  if (typeof globalThis.MediaStream !== 'function') {
    throw new Error('Remote window receiver requires MediaStream');
  }
  return () => new globalThis.MediaStream();
}

export function createRemoteWindowReceiverRuntime(input?: {
  peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
  mediaStreamFactory?: () => MediaStream;
  trackTimeoutMs?: number;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
  nowMs?: () => number;
}) {
  const activeStreams = new Map<string, ActiveRemoteWindowReceiverStream>();
  const trackTimeoutMs = Math.max(1, Math.floor(input?.trackTimeoutMs ?? REMOTE_WINDOW_RECEIVER_TRACK_TIMEOUT_MS));
  const setTimeoutFn = input?.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn = input?.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
  const nowMs = input?.nowMs ?? Date.now;
  const createPeerConnection = () => resolvePeerConnectionFactory(input?.peerConnectionFactory);
  const createMediaStream = () => resolveMediaStreamFactory(input?.mediaStreamFactory);

  const isCurrent = (entry: ActiveRemoteWindowReceiverStream) => (
    activeStreams.get(entry.streamId) === entry && !entry.cleanupDone
  );

  const cleanupEntry = (entry: ActiveRemoteWindowReceiverStream, reason: string) => {
    if (entry.cleanupDone) {
      return false;
    }
    entry.cleanupDone = true;
    activeStreams.delete(entry.streamId);
    for (const timeoutId of entry.trackTimeoutIds.values()) {
      clearTimeoutFn(timeoutId);
    }
    entry.trackTimeoutIds.clear();
    const pendingReject = entry.rejectTrack;
    entry.resolveTrack = null;
    entry.rejectTrack = null;
    if (pendingReject) {
      pendingReject(new Error(reason));
    }
    entry.peerConnection.onicecandidate = null;
    entry.peerConnection.ontrack = null;
    entry.peerConnection.onconnectionstatechange = null;
    for (const track of entry.mediaStream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Track cleanup must not mask the stream cleanup path.
      }
    }
    if (entry.overviewMediaStream) {
      for (const track of entry.overviewMediaStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Overview track cleanup must not mask the stream cleanup path.
        }
      }
    }
    entry.peerConnection.close();
    return true;
  };

  const waitForRequiredTracks = (entry: ActiveRemoteWindowReceiverStream, needsOverview: boolean) => new Promise<{ mediaStream: MediaStream; overviewMediaStream: MediaStream | null }>((resolve, reject) => {
    const tryResolve = () => {
      if (entry.trackAttached && (!needsOverview || entry.overviewTrackAttached)) {
        entry.resolveTrack = null;
        entry.rejectTrack = null;
        resolve({
          mediaStream: entry.mediaStream,
          overviewMediaStream: needsOverview ? entry.overviewMediaStream : null,
        });
      }
    };
    if (entry.trackAttached && (!needsOverview || entry.overviewTrackAttached)) {
      tryResolve();
      return;
    }
    entry.resolveTrack = tryResolve;
    entry.rejectTrack = reject;
  });

  const armTrackTimeouts = (entry: ActiveRemoteWindowReceiverStream) => {
    entry.trackWaitStartedAt ??= nowMs();
    for (const role of entry.requiredLaneRoles) {
      const attached = role === 'focus' ? entry.trackAttached : entry.overviewTrackAttached;
      if (!isCurrent(entry) || attached || entry.trackTimeoutIds.has(role)) {
        continue;
      }
      const timeoutId = setTimeoutFn(() => {
        if (!isCurrent(entry) || (role === 'focus' ? entry.trackAttached : entry.overviewTrackAttached)) {
          return;
        }
        entry.trackTimeoutIds.delete(role);
        const error = new Error(`Remote window receiver timed out waiting for required lane: ${role}`) as Error & {
          failureStage: 'track-attach';
          lane: 'focus' | 'overview';
          elapsedMs: number;
        };
        error.name = 'remote_window_receiver_lane_timeout';
        error.failureStage = 'track-attach';
        error.lane = role;
        error.elapsedMs = Math.max(0, nowMs() - (entry.trackWaitStartedAt ?? nowMs()));
        entry.rejectTrack?.(error);
      }, trackTimeoutMs);
      entry.trackTimeoutIds.set(role, timeoutId);
    }
    return entry.trackTimeoutIds.size > 0;
  };

  const attachTrack = (
    entry: ActiveRemoteWindowReceiverStream,
    event: RTCTrackEvent,
  ) => {
    if (!isCurrent(entry) || event.track?.kind !== 'video') {
      return;
    }
    const eventStream = Array.isArray(event.streams) ? event.streams[0] : undefined;
    const isOverview = Boolean(eventStream && eventStream.id === 'overview');
    if (isOverview) {
      if (eventStream) {
        entry.overviewMediaStream = eventStream;
      } else if (entry.overviewMediaStream && typeof entry.overviewMediaStream.addTrack === 'function') {
        entry.overviewMediaStream.addTrack(event.track);
      }
      entry.overviewTrackAttached = true;
      entry.overviewTrackAttachedAt ??= Date.now();
    } else {
      if (eventStream) {
        entry.mediaStream = eventStream;
      } else if (typeof entry.mediaStream.addTrack === 'function') {
        const existingTracks = new Set(entry.mediaStream.getTracks());
        if (!existingTracks.has(event.track)) {
          entry.mediaStream.addTrack(event.track);
        }
      }
      entry.trackAttached = true;
      entry.focusTrackAttachedAt ??= Date.now();
    }
    const attachedRole = isOverview ? 'overview' : 'focus';
    const timeoutId = entry.trackTimeoutIds.get(attachedRole);
    if (timeoutId !== undefined) {
      clearTimeoutFn(timeoutId);
      entry.trackTimeoutIds.delete(attachedRole);
    }
    if (entry.trackAttached && (!entry.needsOverview || entry.overviewTrackAttached)) {
      const resolveTrack = entry.resolveTrack;
      entry.resolveTrack = null;
      entry.rejectTrack = null;
      resolveTrack?.({
        mediaStream: entry.mediaStream,
        overviewMediaStream: entry.needsOverview ? entry.overviewMediaStream : null,
      });
    }
  };

  const assertCurrent = (entry: ActiveRemoteWindowReceiverStream) => {
    if (!isCurrent(entry)) {
      throw new Error('Remote window stream was closed before receiver setup completed');
    }
  };

  const runtime = {
    async startStream(options: {
      streamId: string;
      purpose?: RemoteWindowStreamPurpose;
      target: RemoteWindowStreamTargetManifest;
      iceServers?: RTCIceServer[];
      sendIceCandidate: (candidate: RemoteWindowStreamIceCandidatePayload['candidate'], requestId?: string) => void;
      startRemote: (offer: RemoteWindowStreamRtcDescription) => Promise<RemoteWindowStreamStartedPayload | RemoteWindowStreamStartedOfferV2Payload>;
      protocolVersion?: 1 | 2;
      sendAnswer?: (answer: RemoteWindowStreamAnswerV2Payload) => void | Promise<void>;
    }): Promise<RemoteWindowReceiverStartResult> {
      const streamId = options.streamId.trim();
      if (!streamId) {
        throw new Error('Remote window receiver requires streamId');
      }
      if (activeStreams.has(streamId)) {
        throw new Error(`Remote window stream already exists: ${streamId}`);
      }
      const peerConnection = createPeerConnection()({ iceServers: options.iceServers ?? [] });
      const mediaStream = createMediaStream()();
      const mediaPlan = (options.target.compositeWindows ?? []).length > 0
        ? 'overview-plus-focus' as const
        : 'single-focus' as const;
      const mediaPlanContract = options.protocolVersion === 2
        ? getRemoteWindowMediaPlanV2Contract(mediaPlan)
        : getRemoteWindowMediaPlanContract(mediaPlan);
      const needsOverview = mediaPlanContract.lanes.some((lane) => lane.role === 'overview');
      const entry: ActiveRemoteWindowReceiverStream = {
        streamId,
        purpose: options.purpose,
        peerConnection,
        mediaStream,
        overviewMediaStream: null,
        cleanupDone: false,
        needsOverview,
        trackAttached: false,
        overviewTrackAttached: false,
        requiredLaneRoles: mediaPlanContract.lanes.map((lane) => lane.role),
        remoteDescriptionApplied: false,
        pendingIceCandidates: [],
        remoteStartDispatched: false,
        remoteRequestId: null,
        pendingLocalIceCandidates: [],
        captureStartedAt: null,
        answerAppliedAt: null,
        focusTrackAttachedAt: null,
        overviewTrackAttachedAt: null,
        trackTimeoutIds: new Map(),
        trackWaitStartedAt: null,
        resolveTrack: null,
        rejectTrack: null,
        statsBaseline: null,
      };
      activeStreams.set(streamId, entry);

      try {
        // 双流：组合 target 协商两个 video transceiver（focus + overview）
        for (const lane of mediaPlanContract.lanes) {
          peerConnection.addTransceiver('video', { direction: 'recvonly' });
          if (!lane.requiredForStart) {
            throw new Error(`Remote window media lane is not start-gated: ${lane.role}`);
          }
        }
        peerConnection.onicecandidate = (event) => {
          if (!isCurrent(entry) || !event.candidate) {
            return;
          }
          const candidate = normalizeLocalCandidate(event.candidate);
          if (!entry.remoteStartDispatched || !entry.remoteRequestId) {
            entry.pendingLocalIceCandidates.push(candidate);
            return;
          }
          options.sendIceCandidate(candidate, entry.remoteRequestId);
        };
        peerConnection.ontrack = (event) => attachTrack(entry, event);
        const trackPromise = waitForRequiredTracks(entry, needsOverview);
        trackPromise.catch(() => undefined);
        let startedPromise: Promise<RemoteWindowStreamStartedPayload | RemoteWindowStreamStartedOfferV2Payload>;
        if (options.protocolVersion === 2) {
          startedPromise = options.startRemote(undefined as unknown as RemoteWindowStreamRtcDescription);
        } else {
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          assertCurrent(entry);
          const localOffer = normalizeRtcDescription(peerConnection.localDescription || offer, 'offer');
          startedPromise = options.startRemote(localOffer);
        }
        entry.remoteStartDispatched = true;
        const started = await startedPromise;
        assertCurrent(entry);
        entry.remoteRequestId = started.requestId;
        entry.captureStartedAt = Date.now();
        if (started.streamId !== streamId) {
          throw new Error(`Remote window stream id mismatch: expected ${streamId}, got ${started.streamId}`);
        }
        if (started.targetId !== options.target.streamTargetId) {
          throw new Error(`Remote window target mismatch: expected ${options.target.streamTargetId}, got ${started.targetId}`);
        }
        for (const candidate of entry.pendingLocalIceCandidates.splice(0)) {
          options.sendIceCandidate(candidate, started.requestId);
        }
        if (started.mediaPlan !== mediaPlan) {
          throw new Error(`Remote window media plan mismatch: expected ${mediaPlan}, got ${started.mediaPlan}`);
        }
        if (started.mediaPlanVersion !== mediaPlanContract.version) {
          throw new Error(`Remote window media plan version mismatch: expected ${mediaPlanContract.version}, got ${String(started.mediaPlanVersion)}`);
        }
        if (options.protocolVersion === 2) {
          const offer = normalizeRtcDescription((started as unknown as RemoteWindowStreamStartedOfferV2Payload).offer, 'offer');
          await peerConnection.setRemoteDescription(offer);
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          const normalizedAnswer = normalizeRtcDescription(peerConnection.localDescription || answer, 'answer');
          if (!options.sendAnswer) {
            throw new Error('Remote window v2 receiver requires an answer sender');
          }
          await options.sendAnswer({
            requestId: started.requestId,
            streamId: started.streamId,
            mediaPlanVersion: 2,
            answer: normalizedAnswer,
          });
        } else {
          const answer = normalizeRtcDescription((started as RemoteWindowStreamStartedPayload).answer, 'answer');
          await peerConnection.setRemoteDescription(answer);
        }
        entry.answerAppliedAt = Date.now();
        entry.remoteDescriptionApplied = true;
        for (const candidate of entry.pendingIceCandidates.splice(0)) {
          await peerConnection.addIceCandidate(candidate);
        }
        assertCurrent(entry);
        armTrackTimeouts(entry);
        const attachedTracks = await trackPromise;
        assertCurrent(entry);
        if (
          entry.captureStartedAt === null
          || entry.answerAppliedAt === null
          || entry.focusTrackAttachedAt === null
          || (needsOverview && entry.overviewTrackAttachedAt === null)
        ) {
          throw new Error('Remote window receiver startup telemetry is incomplete');
        }
        return {
          streamId,
          ...(options.purpose ? { purpose: options.purpose } : {}),
          mediaStream: attachedTracks.mediaStream,
          ...(needsOverview && attachedTracks.overviewMediaStream
            ? { overviewMediaStream: attachedTracks.overviewMediaStream }
            : {}),
          started,
          startupTelemetry: {
            captureStartedAt: entry.captureStartedAt,
            answerAppliedAt: entry.answerAppliedAt,
            focusTrackAttachedAt: entry.focusTrackAttachedAt,
            ...(entry.overviewTrackAttachedAt !== null
              ? { overviewTrackAttachedAt: entry.overviewTrackAttachedAt }
              : {}),
          },
          collectStats: () => runtime.getStatsSample(streamId),
        };
      } catch (error) {
        cleanupEntry(entry, error instanceof Error ? error.message : String(error));
        throw error instanceof Error ? error : new Error(String(error));
      }
    },

    async addIceCandidate(payload: RemoteWindowStreamIceCandidatePayload) {
      const entry = activeStreams.get(payload.streamId);
      if (!entry || entry.cleanupDone) {
        return false;
      }
      const candidate = {
        candidate: payload.candidate.candidate,
        sdpMid: payload.candidate.sdpMid ?? null,
        sdpMLineIndex: payload.candidate.sdpMLineIndex ?? null,
        usernameFragment: payload.candidate.usernameFragment ?? null,
      };
      if (!entry.remoteDescriptionApplied) {
        entry.pendingIceCandidates.push(candidate);
        return true;
      }
      await entry.peerConnection.addIceCandidate(candidate);
      return true;
    },

    stopStream(streamId: string) {
      const entry = activeStreams.get(streamId.trim());
      if (!entry) {
        return false;
      }
      return cleanupEntry(entry, 'Remote window stream stopped');
    },

    async getStatsSample(streamId: string): Promise<RemoteWindowVideoStatsSample | null> {
      const entry = activeStreams.get(streamId.trim());
      if (!entry || entry.cleanupDone || typeof entry.peerConnection.getStats !== 'function') {
        return null;
      }
      const report = await entry.peerConnection.getStats();
      const sample: RemoteWindowVideoStatsSample = { sampledAtMs: Date.now() };
      report.forEach((item: RTCStats & Record<string, unknown>) => {
        if (item.type === 'inbound-rtp' && item.kind === 'video') {
          if (typeof item.framesPerSecond === 'number') sample.framesPerSecond = item.framesPerSecond;
          const framesDropped = typeof item.framesDropped === 'number' ? item.framesDropped : 0;
          const freezeCount = typeof item.freezeCount === 'number' ? item.freezeCount : 0;
          const jitterBufferDelay = typeof item.jitterBufferDelay === 'number' ? item.jitterBufferDelay : 0;
          const jitterBufferEmittedCount = typeof item.jitterBufferEmittedCount === 'number'
            ? item.jitterBufferEmittedCount
            : 0;
          const previous = entry.statsBaseline;
          sample.framesDropped = Math.max(0, framesDropped - (previous?.framesDropped ?? 0));
          sample.freezeCount = Math.max(0, freezeCount - (previous?.freezeCount ?? 0));
          const jitterDelayDelta = Math.max(0, jitterBufferDelay - (previous?.jitterBufferDelay ?? 0));
          const jitterEmittedDelta = Math.max(0, jitterBufferEmittedCount - (previous?.jitterBufferEmittedCount ?? 0));
          if (jitterEmittedDelta > 0) {
            sample.jitterBufferDelayMs = (jitterDelayDelta / jitterEmittedDelta) * 1000;
          }
          if (typeof item.qualityLimitationReason === 'string') {
            sample.qualityLimitationReason = item.qualityLimitationReason;
          }
          entry.statsBaseline = {
            framesDropped,
            freezeCount,
            jitterBufferDelay,
            jitterBufferEmittedCount,
          };
        }
        if (item.type === 'candidate-pair' && (item.state === 'succeeded' || item.nominated === true)) {
          if (typeof item.currentRoundTripTime === 'number') sample.rttMs = item.currentRoundTripTime * 1000;
          if (typeof item.availableIncomingBitrate === 'number') {
            sample.availableIncomingBitrateBps = item.availableIncomingBitrate;
          }
          if (typeof item.availableOutgoingBitrate === 'number') {
            sample.availableOutgoingBitrateBps = item.availableOutgoingBitrate;
          }
        }
        if (item.type === 'remote-inbound-rtp' && item.kind === 'video') {
          if (typeof item.roundTripTime === 'number') sample.rttMs = item.roundTripTime * 1000;
        }
        if (item.type === 'remote-outbound-rtp' && item.kind === 'video' && typeof item.qualityLimitationReason === 'string') {
          sample.qualityLimitationReason = item.qualityLimitationReason;
        }
      });
      return sample;
    },

    handleStatus(payload: { streamId: string; phase: 'starting' | 'streaming' | 'stopped' }) {
      if (payload.phase !== 'stopped') {
        return activeStreams.has(payload.streamId);
      }
      return runtime.stopStream(payload.streamId);
    },

    dispose(reason = 'Remote window receiver disposed') {
      for (const entry of Array.from(activeStreams.values())) {
        cleanupEntry(entry, reason);
      }
    },

    getActiveStreamIds() {
      return Array.from(activeStreams.keys());
    },
  };

  return runtime;
}

export type RemoteWindowReceiverRuntime = ReturnType<typeof createRemoteWindowReceiverRuntime>;
