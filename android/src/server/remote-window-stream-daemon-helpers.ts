/**
 * remote window stream daemon 纯 helper 子模块（daemon.remote_window_stream）。
 * 从 remote-window-stream-daemon.ts 拆出：catalog 克隆 / RTC 归一 / 码率校验 / RGBA->I420。
 */
import type {
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamIceCandidate,
  RemoteWindowStreamLatencyTelemetry,
  RemoteWindowStreamRtcDescription,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowVideoProfile,
} from '../lib/types';
import type { RemoteWindowCaptureFrame } from './remote-window-capture';

export interface RtcVideoFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export function cloneRemoteWindowTargetCatalogResponse(
  response: RemoteWindowStreamTargetsResponsePayload,
  requestId: string,
): RemoteWindowStreamTargetsResponsePayload {
  return {
    requestId,
    targets: response.targets.slice(),
    ...(response.errors
      ? {
          errors: response.errors.map((error) => ({
            ...error,
            requestId,
          })),
        }
      : {}),
  };
}

export function cloneRemoteWindowTargetCatalogResult(
  result: RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload,
  requestId: string,
) {
  if ('targets' in result) {
    return cloneRemoteWindowTargetCatalogResponse(result, requestId);
  }
  return {
    ...result,
    requestId,
  };
}

export function normalizeRtcDescription(
  description: RTCSessionDescriptionInit | RTCSessionDescription | null,
  expectedType: RemoteWindowStreamRtcDescription['type'],
): RemoteWindowStreamRtcDescription {
  if (!description || description.type !== expectedType || typeof description.sdp !== 'string') {
    throw new Error(`remote window daemon expected ${expectedType} description`);
  }
  return {
    type: expectedType,
    sdp: description.sdp,
  };
}

export function normalizeIceCandidate(candidate: RTCIceCandidate): RemoteWindowStreamIceCandidate {
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

export function normalizeRemoteWindowVideoProfile(
  input: RemoteWindowVideoProfile | undefined,
): RemoteWindowVideoProfile | null {
  if (!input) {
    return null;
  }
  if (input.preference !== 'smooth' && input.preference !== 'quality') {
    throw new Error(`remote window video preference is invalid: ${String(input.preference)}`);
  }
  const fields: Array<[string, number, number, number]> = [
    ['maxBitrateBps', input.maxBitrateBps, 500_000, 25_000_000],
    ['maxFrameRateFps', input.maxFrameRateFps, 1, 60],
    ['maxCaptureWidth', input.maxCaptureWidth, 320, 3840],
    ['maxCaptureHeight', input.maxCaptureHeight, 240, 2400],
    ['maxFrameAgeMs', input.maxFrameAgeMs, 40, 1_000],
    ['overviewMaxBitrateBps', input.overviewMaxBitrateBps, 0, 2_000_000],
    ['overviewMaxFrameRateFps', input.overviewMaxFrameRateFps, 0, 8],
  ];
  for (const [name, value, minimum, maximum] of fields) {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`remote window video profile ${name} is out of range`);
    }
  }
  if (input.overviewMaxBitrateBps >= input.maxBitrateBps) {
    throw new Error('remote window overview bitrate must remain below the total bitrate');
  }
  if (input.overviewMaxFrameRateFps > input.maxFrameRateFps) {
    throw new Error('remote window overview frame rate must not exceed focus frame rate');
  }
  return {
    preference: input.preference,
    maxBitrateBps: Math.floor(input.maxBitrateBps),
    maxFrameRateFps: Math.floor(input.maxFrameRateFps),
    maxCaptureWidth: Math.floor(input.maxCaptureWidth),
    maxCaptureHeight: Math.floor(input.maxCaptureHeight),
    maxFrameAgeMs: Math.floor(input.maxFrameAgeMs),
    interactionActive: input.interactionActive === true,
    overviewMaxBitrateBps: Math.floor(input.overviewMaxBitrateBps),
    overviewMaxFrameRateFps: Math.floor(input.overviewMaxFrameRateFps),
  };
}

export function formatRemoteWindowVideoProfileError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name || 'remote window video bitrate could not be applied';
  }
  const message = String(error || '').trim();
  return message || 'remote window video bitrate could not be applied';
}

export function convertRgbaToI420Frame(
  frame: RemoteWindowCaptureFrame,
  convert: (rgba: RtcVideoFrame, i420: RtcVideoFrame) => void,
): RtcVideoFrame {
  const width = Math.max(1, Math.floor(frame.width));
  const height = Math.max(1, Math.floor(frame.height));
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const i420 = {
    width,
    height,
    data: new Uint8Array(width * height + chromaWidth * chromaHeight * 2),
  };
  convert({
    width,
    height,
    data: frame.rgba,
  }, i420);
  return i420;
}

/**
 * Bounded rolling accumulator behind `RemoteWindowStreamLatencyTelemetry`.
 *
 * It only observes the daemon's own pipeline: capture timestamps, the
 * capture-to-encoder handoff, sender `getStats()` totals and the input
 * injection duration. It never feeds control state.
 */
export interface RemoteWindowLatencyAccumulator {
  /** A capture frame arrived from the capture source. */
  recordCaptureArrival(arrivedAtMs: number): void;
  recordCapture(capturedAtMs: number, handedOffAtMs: number): void;
  /**
   * Size of the frame the daemon actually captured for the focus lane. The
   * requested `maxCaptureWidth` is an intention; only the capture source knows
   * the size it produced, so this is the witness of a zoom-aware capture raise.
   */
  recordCaptureSize(width: number, height: number): void;
  recordInputInjection(durationMs: number): void;
  applySenderStats(report: RTCStatsReport | null | undefined, sampledAtMs: number): void;
  snapshot(sampleWindowMs: number): RemoteWindowStreamLatencyTelemetry | null;
}

const REMOTE_WINDOW_LATENCY_SAMPLE_CAPACITY = 240;

function pushBounded(samples: number[], value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return;
  }
  samples.push(value);
  if (samples.length > REMOTE_WINDOW_LATENCY_SAMPLE_CAPACITY) {
    samples.splice(0, samples.length - REMOTE_WINDOW_LATENCY_SAMPLE_CAPACITY);
  }
}

function nearestRankPercentile(samples: number[], percentile: number): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1));
  return sorted[index];
}

function readStatsNumber(entry: Record<string, unknown>, key: string): number | null {
  const value = entry[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function createRemoteWindowLatencyAccumulator(): RemoteWindowLatencyAccumulator {
  const captureToEncodeSamples: number[] = [];
  // Capture arrivals and encoder handoffs are counted separately: the drop
  // policy between them is exactly what a frozen remote window looks like, and
  // one shared counter could not tell a slow capture source from a policy that
  // throws away what the source delivered.
  const captureArrivalTimestamps: number[] = [];
  const dispatchTimestamps: number[] = [];
  const inputInjectionSamples: number[] = [];
  let previousOutbound: {
    sampledAtMs: number;
    framesEncoded: number;
    totalEncodeTimeMs: number;
    totalPacketSendDelayMs: number;
    packetsSent: number;
    bytesSent: number;
  } | null = null;
  let encodeMsPerFrame: number | null = null;
  let packetSendDelayMs: number | null = null;
  let encodedFps: number | null = null;
  let sentBitrateBps: number | null = null;
  let codecMimeType: string | null = null;
  let networkRttMs: number | null = null;
  let networkJitterMs: number | null = null;
  let packetLossRatio: number | null = null;
  let captureWidth: number | null = null;
  let captureHeight: number | null = null;

  return {
    recordCaptureArrival(arrivedAtMs) {
      pushBounded(captureArrivalTimestamps, arrivedAtMs);
    },

    recordCaptureSize(width, height) {
      if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
        captureWidth = Math.floor(width);
        captureHeight = Math.floor(height);
      }
    },

    recordCapture(capturedAtMs, handedOffAtMs) {
      pushBounded(captureToEncodeSamples, handedOffAtMs - capturedAtMs);
      pushBounded(dispatchTimestamps, handedOffAtMs);
    },

    recordInputInjection(durationMs) {
      pushBounded(inputInjectionSamples, durationMs);
    },

    applySenderStats(report, sampledAtMs) {
      if (!report || typeof report.forEach !== 'function') {
        return;
      }
      let outbound: Record<string, unknown> | null = null;
      let remoteInbound: Record<string, unknown> | null = null;
      const codecMimeById = new Map<string, string>();
      report.forEach((entry: unknown) => {
        if (!entry || typeof entry !== 'object') {
          return;
        }
        const record = entry as Record<string, unknown>;
        if (record.type === 'codec' && typeof record.id === 'string' && typeof record.mimeType === 'string') {
          codecMimeById.set(record.id, record.mimeType);
          return;
        }
        const kind = record.kind ?? record.mediaType;
        if (kind !== 'video') {
          return;
        }
        if (record.type === 'outbound-rtp') {
          outbound = record;
        } else if (record.type === 'remote-inbound-rtp') {
          remoteInbound = record;
        }
      });
      if (outbound) {
        const outboundRecord = outbound as Record<string, unknown>;
        const current = {
          sampledAtMs,
          framesEncoded: readStatsNumber(outboundRecord, 'framesEncoded') ?? 0,
          totalEncodeTimeMs: (readStatsNumber(outboundRecord, 'totalEncodeTime') ?? 0) * 1000,
          totalPacketSendDelayMs: (readStatsNumber(outboundRecord, 'totalPacketSendDelay') ?? 0) * 1000,
          packetsSent: readStatsNumber(outboundRecord, 'packetsSent') ?? 0,
          bytesSent: readStatsNumber(outboundRecord, 'bytesSent') ?? 0,
        };
        const codecId = outboundRecord.codecId;
        if (typeof codecId === 'string') {
          codecMimeType = codecMimeById.get(codecId) ?? codecMimeType;
        }
        if (previousOutbound) {
          const elapsedMs = current.sampledAtMs - previousOutbound.sampledAtMs;
          const encodedDelta = current.framesEncoded - previousOutbound.framesEncoded;
          const encodeDeltaMs = current.totalEncodeTimeMs - previousOutbound.totalEncodeTimeMs;
          const sendDelayDeltaMs = current.totalPacketSendDelayMs - previousOutbound.totalPacketSendDelayMs;
          const sentDelta = current.packetsSent - previousOutbound.packetsSent;
          const bytesDelta = current.bytesSent - previousOutbound.bytesSent;
          if (elapsedMs > 0 && encodedDelta > 0) {
            encodeMsPerFrame = encodeDeltaMs / encodedDelta;
            encodedFps = (encodedDelta * 1000) / elapsedMs;
          }
          if (sentDelta > 0) {
            packetSendDelayMs = sendDelayDeltaMs / sentDelta;
          }
          if (elapsedMs > 0 && bytesDelta > 0) {
            sentBitrateBps = (bytesDelta * 8 * 1000) / elapsedMs;
          }
        }
        previousOutbound = current;
      }
      if (remoteInbound) {
        const inboundRecord = remoteInbound as Record<string, unknown>;
        const roundTripTime = readStatsNumber(inboundRecord, 'roundTripTime');
        const jitter = readStatsNumber(inboundRecord, 'jitter');
        const packetsLost = readStatsNumber(inboundRecord, 'packetsLost');
        networkRttMs = roundTripTime === null ? null : roundTripTime * 1000;
        networkJitterMs = jitter === null ? null : jitter * 1000;
        const packetsSent = previousOutbound?.packetsSent ?? 0;
        packetLossRatio = packetsLost !== null && packetsSent > 0
          ? Math.min(1, Math.max(0, packetsLost / packetsSent))
          : null;
      }
    },

    snapshot(sampleWindowMs) {
      if (
        captureArrivalTimestamps.length === 0
        && captureToEncodeSamples.length === 0
        && inputInjectionSamples.length === 0
        && encodeMsPerFrame === null
        && networkRttMs === null
      ) {
        return null;
      }
      const windowStartMs = captureArrivalTimestamps.length > 0
        ? Math.max(captureArrivalTimestamps[0], Date.now() - sampleWindowMs)
        : null;
      const rateInWindow = (timestamps: number[]) => {
        if (windowStartMs === null) {
          return null;
        }
        const inWindow = timestamps.filter((timestamp) => timestamp >= windowStartMs).length;
        return inWindow > 0 ? (inWindow * 1000) / Math.max(1, Date.now() - windowStartMs) : null;
      };
      return {
        sampleWindowMs,
        captureToEncodeMs: captureToEncodeSamples.length > 0
          ? captureToEncodeSamples[captureToEncodeSamples.length - 1]
          : null,
        captureToEncodeP50Ms: nearestRankPercentile(captureToEncodeSamples, 0.5),
        captureToEncodeP95Ms: nearestRankPercentile(captureToEncodeSamples, 0.95),
        encodeMsPerFrame,
        packetSendDelayMs,
        capturedFps: rateInWindow(captureArrivalTimestamps),
        dispatchedFps: rateInWindow(dispatchTimestamps),
        encodedFps,
        sentBitrateBps,
        codecMimeType,
        networkRttMs,
        networkJitterMs,
        packetLossRatio,
        inputInjectP50Ms: nearestRankPercentile(inputInjectionSamples, 0.5),
        inputInjectP95Ms: nearestRankPercentile(inputInjectionSamples, 0.95),
        inputInjectSamples: inputInjectionSamples.length,
        captureWidth,
        captureHeight,
      };
    },
  };
}
