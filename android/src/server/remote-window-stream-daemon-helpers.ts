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
  RemoteWindowVideoProfile,
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
