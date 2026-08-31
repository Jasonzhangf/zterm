import type {
  RemoteWindowStreamGroupBudget,
  RemoteWindowVideoProfile,
} from '@zterm/shared/protocol';
import type { RemoteWindowCaptureFrameSource } from './remote-window-capture';
import { formatRemoteWindowVideoProfileError } from './remote-window-stream-daemon-helpers';

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

interface RemoteWindowQualityLane {
  sender: RTCRtpSender | null;
  captureSource: RemoteWindowCaptureFrameSource | null;
  budget: RemoteWindowStreamGroupBudget['focus'];
}

interface PreparedRemoteWindowQualityLane extends RemoteWindowQualityLane {
  currentParameters: RTCRtpSendParameters;
  previousEncodingParameters: Array<Pick<RTCRtpEncodingParameters, 'maxBitrate' | 'maxFramerate'>>;
  previousCaptureProfile: {
    maxFrameRateFps: number;
    maxCaptureWidth: number;
    maxCaptureHeight: number;
  };
  senderParametersChanged: boolean;
  captureProfileChanged: boolean;
  senderParametersApplied: boolean;
  captureProfileApplied: boolean;
}

function prepareLane(lane: RemoteWindowQualityLane): PreparedRemoteWindowQualityLane {
  if (!lane.sender || typeof lane.sender.getParameters !== 'function' || typeof lane.sender.setParameters !== 'function') {
    throw new Error('remote window quality sender is unavailable');
  }
  if (
    !lane.captureSource?.updateVideoProfile
    || !Number.isFinite(lane.captureSource.maxCaptureWidth)
    || !Number.isFinite(lane.captureSource.maxCaptureHeight)
  ) {
    throw new Error('remote window capture profile control is unavailable');
  }
  const currentParameters = lane.sender.getParameters();
  const encodings = Array.isArray(currentParameters.encodings) ? currentParameters.encodings : [];
  if (encodings.length === 0) {
    throw new Error('remote window quality sender has no encodings to update');
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
    currentParameters,
    previousEncodingParameters,
    previousCaptureProfile: {
      maxFrameRateFps: lane.captureSource.frameRate,
      maxCaptureWidth: lane.captureSource.maxCaptureWidth!,
      maxCaptureHeight: lane.captureSource.maxCaptureHeight!,
    },
    senderParametersChanged,
    captureProfileChanged: lane.captureSource.frameRate !== lane.budget.maxFrameRateFps
      || lane.captureSource.maxCaptureWidth !== lane.budget.maxCaptureWidth
      || lane.captureSource.maxCaptureHeight !== lane.budget.maxCaptureHeight,
    senderParametersApplied: false,
    captureProfileApplied: false,
  };
}

export async function applyRemoteWindowStreamGroupQuality(options: {
  requested: RemoteWindowVideoProfile;
  focusSender: RTCRtpSender | null;
  focusCaptureSource: RemoteWindowCaptureFrameSource | null;
  overviewSender?: RTCRtpSender | null;
  overviewCaptureSource?: RemoteWindowCaptureFrameSource | null;
}): Promise<RemoteWindowStreamGroupBudget> {
  const hasOverview = Boolean(options.overviewSender || options.overviewCaptureSource);
  const budget = resolveRemoteWindowStreamGroupBudget({
    requested: options.requested,
    hasOverview,
  });
  const lanes = [prepareLane({
    sender: options.focusSender,
    captureSource: options.focusCaptureSource,
    budget: budget.focus,
  })];
  if (budget.overview) {
    lanes.push(prepareLane({
      sender: options.overviewSender ?? null,
      captureSource: options.overviewCaptureSource ?? null,
      budget: budget.overview,
    }));
  }
  const applied: PreparedRemoteWindowQualityLane[] = [];
  try {
    for (const lane of lanes) {
      // Register before the first mutation so a failure between sender and
      // capture updates restores this partially-applied lane too.
      applied.push(lane);
      if (lane.senderParametersChanged) {
        await lane.sender!.setParameters(lane.currentParameters);
        lane.senderParametersApplied = true;
      }
      if (lane.captureProfileChanged) {
        await lane.captureSource!.updateVideoProfile!({
          maxFrameRateFps: lane.budget.maxFrameRateFps,
          maxCaptureWidth: lane.budget.maxCaptureWidth,
          maxCaptureHeight: lane.budget.maxCaptureHeight,
        });
        lane.captureProfileApplied = true;
      }
    }
    return budget;
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const lane of applied.reverse()) {
      try {
        if (lane.captureProfileApplied) {
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
