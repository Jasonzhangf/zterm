/**
 * remote window stream daemon 纯 helper 子模块（daemon.remote_window_stream）。
 * 从 remote-window-stream-daemon.ts 拆出：catalog 克隆 / RTC 归一 / 码率校验 / RGBA->I420。
 */
import type {
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamIceCandidate,
  RemoteWindowStreamRequestPayload,
  RemoteWindowStreamRtcDescription,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowVideoBitrateConfig,
} from '../lib/types';
import type { RemoteWindowCaptureFrame } from './remote-window-capture';

export interface RtcVideoFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export function buildRemoteWindowTargetCatalogCacheKey(payload: RemoteWindowStreamRequestPayload) {
  return [
    payload.includeAppWindows !== false ? 'app' : 'no-app',
    payload.includeIterm2 !== false ? 'iterm2' : 'no-iterm2',
  ].join('|');
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

export function normalizeRemoteWindowVideoBitrateConfig(
  input: RemoteWindowVideoBitrateConfig | undefined,
): RemoteWindowVideoBitrateConfig | null {
  if (!input) {
    return null;
  }
  const defaults = (() => {
    switch (input.preset) {
      case '2mbps':
        return { bitrateMbps: 2 as const, maxFrameRateFps: 30 as const };
      case '5mbps':
        return { bitrateMbps: 5 as const, maxFrameRateFps: 30 as const };
      case '10mbps':
        return { bitrateMbps: 10 as const, maxFrameRateFps: 30 as const };
      case '20mbps':
        return { bitrateMbps: 20 as const, maxFrameRateFps: 30 as const };
      case 'fullscreen':
        return { bitrateMbps: 20 as const, maxFrameRateFps: 60 as const };
      default:
        throw new Error(`remote window video bitrate preset is invalid: ${String(input.preset)}`);
    }
  })();
  const bitrateMbps = defaults.bitrateMbps;
  const maxBitrateBps = bitrateMbps * 1_000_000;
  if (
    input.bitrateMbps !== bitrateMbps
    || !Number.isFinite(input.maxBitrateBps)
    || input.maxBitrateBps <= 0
    || input.maxBitrateBps > maxBitrateBps
  ) {
    throw new Error('remote window video bitrate config does not match its preset');
  }
  const maxFrameRateFps = input.maxFrameRateFps ?? defaults.maxFrameRateFps;
  if (
    !Number.isFinite(maxFrameRateFps)
    || maxFrameRateFps < 5
    || maxFrameRateFps > defaults.maxFrameRateFps
  ) {
    throw new Error('remote window video frame-rate config does not match its preset');
  }
  return {
    preset: input.preset,
    bitrateMbps,
    maxBitrateBps: Math.floor(input.maxBitrateBps),
    maxFrameRateFps,
  };
}

export function formatRemoteWindowVideoBitrateError(error: unknown) {
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
