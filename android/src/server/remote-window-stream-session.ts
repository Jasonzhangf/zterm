import type { RemoteWindowStreamPurpose, RemoteWindowStreamStatusPayload } from '@zterm/shared/protocol';
import type { RemoteWindowCaptureFrameSource } from './remote-window-capture';

export interface RemoteWindowStreamSessionResources {
  requestId: string;
  streamId: string;
  purpose: RemoteWindowStreamPurpose;
  framesSent: number;
  captureSource: RemoteWindowCaptureFrameSource | null;
  overviewCaptureSource?: RemoteWindowCaptureFrameSource | null;
  videoTrack: MediaStreamTrack;
  overviewVideoTrack?: MediaStreamTrack;
  peerConnection: RTCPeerConnection;
  sendStatus?: (status: RemoteWindowStreamStatusPayload) => void;
}

function releaseResource(label: string, release: () => void, errors: string[]) {
  try {
    release();
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function releaseRemoteWindowStreamSessionResources(
  session: RemoteWindowStreamSessionResources,
  reason: string,
) {
  const cleanupErrors: string[] = [];
  if (session.captureSource) {
    releaseResource('focus capture stop', () => session.captureSource!.stop(), cleanupErrors);
  }
  if (session.overviewCaptureSource) {
    releaseResource('overview capture stop', () => session.overviewCaptureSource!.stop(), cleanupErrors);
  }
  releaseResource('focus track stop', () => session.videoTrack.stop(), cleanupErrors);
  if (session.overviewVideoTrack) {
    releaseResource('overview track stop', () => session.overviewVideoTrack!.stop(), cleanupErrors);
  }
  session.peerConnection.onicecandidate = null;
  session.peerConnection.onconnectionstatechange = null;
  releaseResource('peer close', () => session.peerConnection.close(), cleanupErrors);
  const message = cleanupErrors.length > 0
    ? `${reason}; cleanup failed: ${cleanupErrors.join('; ')}`
    : reason;
  session.sendStatus?.({
    requestId: session.requestId,
    streamId: session.streamId,
    purpose: session.purpose,
    phase: 'stopped',
    framesSent: session.framesSent,
    message,
  });
  return { message, cleanupErrors };
}
