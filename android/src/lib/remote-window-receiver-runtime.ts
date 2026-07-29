import type {
  RemoteWindowStreamIceCandidatePayload,
  RemoteWindowStreamPurpose,
  RemoteWindowStreamRtcDescription,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamTargetManifest,
} from './types';
import type { RemoteWindowVideoStatsSample } from './remote-window-video-quality';

export interface RemoteWindowReceiverStartResult {
  streamId: string;
  purpose?: RemoteWindowStreamPurpose;
  mediaStream: MediaStream;
  started: RemoteWindowStreamStartedPayload;
  collectStats?: () => Promise<RemoteWindowVideoStatsSample | null>;
}

export const REMOTE_WINDOW_RECEIVER_TRACK_TIMEOUT_MS = 25_000;

interface ActiveRemoteWindowReceiverStream {
  streamId: string;
  purpose?: RemoteWindowStreamPurpose;
  peerConnection: RTCPeerConnection;
  mediaStream: MediaStream;
  cleanupDone: boolean;
  trackAttached: boolean;
  trackTimeoutId: ReturnType<typeof setTimeout> | null;
  resolveTrack: ((mediaStream: MediaStream) => void) | null;
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
}) {
  const activeStreams = new Map<string, ActiveRemoteWindowReceiverStream>();
  const trackTimeoutMs = Math.max(1, Math.floor(input?.trackTimeoutMs ?? REMOTE_WINDOW_RECEIVER_TRACK_TIMEOUT_MS));
  const setTimeoutFn = input?.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn = input?.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
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
    if (entry.trackTimeoutId !== null) {
      clearTimeoutFn(entry.trackTimeoutId);
      entry.trackTimeoutId = null;
    }
    const pendingReject = entry.rejectTrack;
    entry.resolveTrack = null;
    entry.rejectTrack = null;
    if (!entry.trackAttached && pendingReject) {
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
    entry.peerConnection.close();
    return true;
  };

  const waitForFirstTrack = (entry: ActiveRemoteWindowReceiverStream) => new Promise<MediaStream>((resolve, reject) => {
    if (entry.trackAttached) {
      resolve(entry.mediaStream);
      return;
    }
    entry.resolveTrack = resolve;
    entry.rejectTrack = reject;
  });

  const armTrackTimeout = (entry: ActiveRemoteWindowReceiverStream) => {
    if (!isCurrent(entry) || entry.trackAttached || entry.trackTimeoutId !== null) {
      return false;
    }
    entry.trackTimeoutId = setTimeoutFn(() => {
      if (!isCurrent(entry)) {
        return;
      }
      entry.trackTimeoutId = null;
      entry.rejectTrack?.(new Error('Remote window receiver did not receive a video track'));
    }, trackTimeoutMs);
    return true;
  };

  const attachTrack = (
    entry: ActiveRemoteWindowReceiverStream,
    event: RTCTrackEvent,
  ) => {
    if (!isCurrent(entry) || event.track?.kind !== 'video') {
      return;
    }
    const eventStream = Array.isArray(event.streams) ? event.streams[0] : undefined;
    if (eventStream) {
      entry.mediaStream = eventStream;
    } else if (typeof entry.mediaStream.addTrack === 'function') {
      const existingTracks = new Set(entry.mediaStream.getTracks());
      if (!existingTracks.has(event.track)) {
        entry.mediaStream.addTrack(event.track);
      }
    }
    entry.trackAttached = true;
    if (entry.trackTimeoutId !== null) {
      clearTimeoutFn(entry.trackTimeoutId);
      entry.trackTimeoutId = null;
    }
    const resolveTrack = entry.resolveTrack;
    entry.resolveTrack = null;
    entry.rejectTrack = null;
    resolveTrack?.(entry.mediaStream);
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
      sendIceCandidate: (candidate: RemoteWindowStreamIceCandidatePayload['candidate']) => void;
      startRemote: (offer: RemoteWindowStreamRtcDescription) => Promise<RemoteWindowStreamStartedPayload>;
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
      const entry: ActiveRemoteWindowReceiverStream = {
        streamId,
        purpose: options.purpose,
        peerConnection,
        mediaStream,
        cleanupDone: false,
        trackAttached: false,
        trackTimeoutId: null,
        resolveTrack: null,
        rejectTrack: null,
        statsBaseline: null,
      };
      activeStreams.set(streamId, entry);

      try {
        peerConnection.addTransceiver('video', { direction: 'recvonly' });
        peerConnection.onicecandidate = (event) => {
          if (!isCurrent(entry) || !event.candidate) {
            return;
          }
          options.sendIceCandidate(normalizeLocalCandidate(event.candidate));
        };
        peerConnection.ontrack = (event) => attachTrack(entry, event);
        const trackPromise = waitForFirstTrack(entry);
        trackPromise.catch(() => undefined);
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        assertCurrent(entry);
        const localOffer = normalizeRtcDescription(peerConnection.localDescription || offer, 'offer');
        const started = await options.startRemote(localOffer);
        assertCurrent(entry);
        if (started.streamId !== streamId) {
          throw new Error(`Remote window stream id mismatch: expected ${streamId}, got ${started.streamId}`);
        }
        if (started.targetId !== options.target.streamTargetId) {
          throw new Error(`Remote window target mismatch: expected ${options.target.streamTargetId}, got ${started.targetId}`);
        }
        const answer = normalizeRtcDescription(started.answer, 'answer');
        await peerConnection.setRemoteDescription(answer);
        assertCurrent(entry);
        armTrackTimeout(entry);
        const attachedMediaStream = await trackPromise;
        assertCurrent(entry);
        return {
          streamId,
          ...(options.purpose ? { purpose: options.purpose } : {}),
          mediaStream: attachedMediaStream,
          started,
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
      await entry.peerConnection.addIceCandidate({
        candidate: payload.candidate.candidate,
        sdpMid: payload.candidate.sdpMid ?? null,
        sdpMLineIndex: payload.candidate.sdpMLineIndex ?? null,
        usernameFragment: payload.candidate.usernameFragment ?? null,
      });
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
