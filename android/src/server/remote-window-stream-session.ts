import type { RemoteWindowStreamPurpose, RemoteWindowStreamStatusPayload } from '@zterm/shared/protocol';
import type { RemoteWindowCaptureFrameSource } from './remote-window-capture';

export interface RemoteWindowStreamSessionResources {
  requestId: string;
  streamId: string;
  purpose: RemoteWindowStreamPurpose;
  framesSent: number;
  captureSource: RemoteWindowCaptureFrameSource | null;
  overviewCaptureSource?: RemoteWindowCaptureFrameSource | null;
  videoTrack: MediaStreamTrack | null;
  overviewVideoTrack?: MediaStreamTrack | null;
  peerConnection: RTCPeerConnection | null;
  sendStatus?: (status: RemoteWindowStreamStatusPayload) => void;
}

export interface RemoteWindowStreamSessionReleaseResult {
  /** Resource identities that were not released and must be retried. */
  remainingResources: string[];
  errors: { resource: string; message: string }[];
  hadResources: boolean;
}

function releaseResource(
  resource: string,
  release: () => void,
  result: RemoteWindowStreamSessionReleaseResult,
  onReleased?: () => void,
) {
  try {
    release();
    onReleased?.();
  } catch (error) {
    result.remainingResources.push(resource);
    result.errors.push({
      resource,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Releases the focus/overview capture, track and peer resources for one remote
 * window stream. Each resource field is cleared only when its own release
 * succeeded, so a failed release preserves the real reference for retry.
 */
export function releaseRemoteWindowStreamSessionResources(
  session: RemoteWindowStreamSessionResources,
): RemoteWindowStreamSessionReleaseResult {
  const result: RemoteWindowStreamSessionReleaseResult = {
    remainingResources: [],
    errors: [],
    hadResources: false,
  };
  if (session.captureSource) {
    const captureSource = session.captureSource;
    result.hadResources = true;
    releaseResource('focus-capture', () => captureSource.stop(), result, () => {
      session.captureSource = null;
    });
  }
  if (session.overviewCaptureSource) {
    const overviewCaptureSource = session.overviewCaptureSource;
    result.hadResources = true;
    releaseResource('overview-capture', () => overviewCaptureSource.stop(), result, () => {
      session.overviewCaptureSource = null;
    });
  }
  if (session.videoTrack) {
    const videoTrack = session.videoTrack;
    result.hadResources = true;
    releaseResource('focus-track', () => videoTrack.stop(), result, () => {
      session.videoTrack = null;
    });
  }
  if (session.overviewVideoTrack) {
    const overviewVideoTrack = session.overviewVideoTrack;
    result.hadResources = true;
    releaseResource('overview-track', () => overviewVideoTrack.stop(), result, () => {
      session.overviewVideoTrack = null;
    });
  }
  if (session.peerConnection) {
    const peerConnection = session.peerConnection;
    result.hadResources = true;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    releaseResource('peer', () => peerConnection.close(), result, () => {
      session.peerConnection = null;
    });
  }
  return result;
}
