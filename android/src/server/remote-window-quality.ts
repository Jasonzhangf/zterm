import type {
  RemoteWindowStreamGroupBudget,
  RemoteWindowVideoProfile,
} from '@zterm/shared/protocol';
import type { RemoteWindowCaptureFrameSource } from './remote-window-capture';
import { formatRemoteWindowVideoProfileError } from './remote-window-stream-daemon-helpers';

export const REMOTE_WINDOW_STREAM_QUALITY_UNSUPPORTED_CODE =
  'remote_window_stream_quality_unsupported';

/**
 * Raised only by the prepared capability checks below: a sender without the
 * getter/setter pair, a capture source without profile control or dimensions,
 * or a negotiated sender that exposes no encodings. Ordinary apply and
 * rollback failures keep `remote_window_stream_quality_failed`.
 */
export class RemoteWindowQualityUnsupportedError extends Error {}

export function resolveRemoteWindowStreamGroupBudget(options: {
  requested: RemoteWindowVideoProfile;
  hasOverview: boolean;
}): RemoteWindowStreamGroupBudget {
  const totalMaxBitrateBps = options.requested.maxBitrateBps;
  const requestedFrameRate = options.requested.maxFrameRateFps;
  const focusBudget = {
    maxBitrateBps: totalMaxBitrateBps,
    maxFrameRateFps: requestedFrameRate,
    maxCaptureWidth: options.requested.maxCaptureWidth,
    maxCaptureHeight: options.requested.maxCaptureHeight,
    maxFrameAgeMs: options.requested.maxFrameAgeMs,
  };
  if (!options.hasOverview) {
    return {
      totalMaxBitrateBps,
      focus: focusBudget,
    };
  }
  const overviewMaxBitrateBps = options.requested.overviewMaxBitrateBps;
  return {
    totalMaxBitrateBps,
    focus: {
      ...focusBudget,
      maxBitrateBps: totalMaxBitrateBps - overviewMaxBitrateBps,
    },
    overview: {
      maxBitrateBps: overviewMaxBitrateBps,
      maxFrameRateFps: options.requested.overviewMaxFrameRateFps,
      maxCaptureWidth: Math.min(960, options.requested.maxCaptureWidth),
      maxCaptureHeight: Math.min(600, options.requested.maxCaptureHeight),
      maxFrameAgeMs: options.requested.maxFrameAgeMs,
    },
  };
}

type RemoteWindowQualityLaneName = 'focus' | 'overview';

interface RemoteWindowQualityLane {
  sender: RTCRtpSender | null;
  captureSource: RemoteWindowCaptureFrameSource | null;
  budget: RemoteWindowStreamGroupBudget['focus'];
}

interface PreparedRemoteWindowQualityLane extends RemoteWindowQualityLane {
  laneName: RemoteWindowQualityLaneName;
  currentParameters: RTCRtpSendParameters;
  previousEncodingParameters: Array<Pick<RTCRtpEncodingParameters, 'maxBitrate' | 'maxFramerate'>>;
  previousCaptureProfile: {
    maxFrameRateFps: number;
    maxCaptureWidth: number;
    maxCaptureHeight: number;
  } | null;
  senderParametersChanged: boolean;
  captureProfileChanged: boolean;
  senderParametersApplied: boolean;
  captureProfileApplied: boolean;
}

function prepareLane(
  lane: RemoteWindowQualityLane,
  laneName: RemoteWindowQualityLaneName,
  options: { requireCaptureSource: boolean },
): PreparedRemoteWindowQualityLane {
  if (!lane.sender || typeof lane.sender.getParameters !== 'function' || typeof lane.sender.setParameters !== 'function') {
    throw new RemoteWindowQualityUnsupportedError(`remote window quality sender is unavailable (${laneName} lane)`);
  }
  const captureSource = lane.captureSource;
  if (
    options.requireCaptureSource
    && (
      !captureSource?.updateVideoProfile
      || !Number.isFinite(captureSource.maxCaptureWidth)
      || !Number.isFinite(captureSource.maxCaptureHeight)
    )
  ) {
    // The lane owns the diagnostic: an unassigned or non-conforming capture
    // source must name itself, otherwise the whole group apply is reported as a
    // generic "profile control unavailable" failure.
    throw new RemoteWindowQualityUnsupportedError(`remote window capture profile control is unavailable (${laneName} lane)`);
  }
  // A lane whose capture source is not assigned yet still receives its sender
  // budget, but it has no capture profile to set: the overview lane starts its
  // capture after the focus lane, so its source can legitimately be missing
  // when the first quality request arrives. Its capture profile follows on the
  // next request once the source exists.
  const canSetCaptureProfile = Boolean(captureSource?.updateVideoProfile);
  const currentParameters = lane.sender.getParameters();
  const encodings = Array.isArray(currentParameters.encodings) ? currentParameters.encodings : [];
  if (encodings.length === 0) {
    throw new RemoteWindowQualityUnsupportedError('remote window quality sender has no encodings to update');
  }
  const previousEncodingParameters = encodings.map((encoding) => ({
    maxBitrate: encoding.maxBitrate,
    maxFramerate: encoding.maxFramerate,
  }));
  const senderParametersChanged = encodings.some(
    (encoding) => encoding.maxBitrate !== lane.budget.maxBitrateBps
      || encoding.maxFramerate !== lane.budget.maxFrameRateFps,
  );
  for (const encoding of encodings) {
    // @roamhq/wrtc validates setParameters() by transaction id. Mutate the
    // exact object returned by getParameters(); cloned parameters are a new
    // transaction and make both apply and rollback fail.
    encoding.maxBitrate = lane.budget.maxBitrateBps;
    encoding.maxFramerate = lane.budget.maxFrameRateFps;
  }
  return {
    ...lane,
    laneName,
    currentParameters,
    previousEncodingParameters,
    previousCaptureProfile: canSetCaptureProfile && captureSource
      ? {
        maxFrameRateFps: captureSource.frameRate,
        maxCaptureWidth: captureSource.maxCaptureWidth!,
        maxCaptureHeight: captureSource.maxCaptureHeight!,
      }
      : null,
    senderParametersChanged,
    captureProfileChanged: canSetCaptureProfile && captureSource
      ? (
        captureSource.frameRate !== lane.budget.maxFrameRateFps
        || captureSource.maxCaptureWidth !== lane.budget.maxCaptureWidth
        || captureSource.maxCaptureHeight !== lane.budget.maxCaptureHeight
      )
      : false,
    senderParametersApplied: false,
    captureProfileApplied: false,
  };
}

export interface RemoteWindowStreamGroupQualityApplied {
  budget: RemoteWindowStreamGroupBudget;
  /**
   * Lanes whose negotiated sender encodings could not be updated. Their capture
   * profile still applied; their encoder keeps the previous bitrate.
   */
  senderParametersDegraded: Array<{
    lane: RemoteWindowQualityLaneName;
    reason: string;
  }>;
}

export async function applyRemoteWindowStreamGroupQuality(options: {
  requested: RemoteWindowVideoProfile;
  focusSender: RTCRtpSender | null;
  focusCaptureSource: RemoteWindowCaptureFrameSource | null;
  overviewSender?: RTCRtpSender | null;
  overviewCaptureSource?: RemoteWindowCaptureFrameSource | null;
}): Promise<RemoteWindowStreamGroupQualityApplied> {
  // The overview lane reserves its budget share as soon as the lane exists,
  // even while its own capture source is still starting: the group budget must
  // not oscillate with capture readiness. Only its capture profile waits.
  const hasOverview = Boolean(options.overviewSender || options.overviewCaptureSource);
  const budget = resolveRemoteWindowStreamGroupBudget({
    requested: options.requested,
    hasOverview,
  });
  const lanes = [prepareLane({
    sender: options.focusSender,
    captureSource: options.focusCaptureSource,
    budget: budget.focus,
  }, 'focus', { requireCaptureSource: true })];
  if (budget.overview) {
    lanes.push(prepareLane({
      sender: options.overviewSender ?? null,
      captureSource: options.overviewCaptureSource ?? null,
      budget: budget.overview,
    }, 'overview', { requireCaptureSource: false }));
  }
  const applied: PreparedRemoteWindowQualityLane[] = [];
  const senderParametersDegraded: RemoteWindowStreamGroupQualityApplied['senderParametersDegraded'] = [];
  try {
    for (const lane of lanes) {
      // Register before the first mutation so a failure between sender and
      // capture updates restores this partially-applied lane too.
      applied.push(lane);
      if (lane.senderParametersChanged) {
        try {
          await lane.sender!.setParameters(lane.currentParameters);
          lane.senderParametersApplied = true;
        } catch (error) {
          // The capture profile is the resolution lever the user sees. A
          // runtime that rejects every negotiated encoding update must not take
          // it down: keep the previous encoder bitrate for this lane, report the
          // degradation, and still apply the capture profile.
          senderParametersDegraded.push({
            lane: lane.laneName,
            reason: formatRemoteWindowVideoProfileError(error),
          });
        }
      }
      if (lane.captureProfileChanged) {
        try {
          await lane.captureSource!.updateVideoProfile!({
            maxFrameRateFps: lane.budget.maxFrameRateFps,
            maxCaptureWidth: lane.budget.maxCaptureWidth,
            maxCaptureHeight: lane.budget.maxCaptureHeight,
          });
        } catch (error) {
          throw new Error(`${lane.laneName} lane capture profile: ${formatRemoteWindowVideoProfileError(error)}`);
        }
        lane.captureProfileApplied = true;
      }
    }
    return { budget, senderParametersDegraded };
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const lane of applied.reverse()) {
      try {
        if (lane.captureProfileApplied && lane.previousCaptureProfile) {
          await lane.captureSource!.updateVideoProfile!(lane.previousCaptureProfile);
        }
        if (lane.senderParametersApplied) {
          // @roamhq/wrtc consumes a transaction on successful setParameters().
          // A rollback must request the sender's next transaction instead of
          // reusing the object that already applied the degraded values.
          const rollbackParameters = lane.sender!.getParameters();
          rollbackParameters.encodings?.forEach((encoding, index) => {
            const previous = lane.previousEncodingParameters[index];
            encoding.maxBitrate = previous?.maxBitrate;
            encoding.maxFramerate = previous?.maxFramerate;
          });
          await lane.sender!.setParameters(rollbackParameters);
        }
      } catch (rollbackError) {
        rollbackErrors.push(formatRemoteWindowVideoProfileError(rollbackError));
      }
    }
    const message = formatRemoteWindowVideoProfileError(error);
    throw new Error(rollbackErrors.length > 0
      ? `${message}; quality rollback failed: ${rollbackErrors.join('; ')}`
      : message);
  }
}
