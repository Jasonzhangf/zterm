import type {
  RemoteWindowStreamGroupBudget,
  RemoteWindowVideoBitrateConfig,
} from '@zterm/shared/protocol';
import type { RemoteWindowCaptureFrameSource } from './remote-window-capture';
import { formatRemoteWindowVideoBitrateError } from './remote-window-stream-daemon-helpers';

const OVERVIEW_MAX_BITRATE_BPS = 1_500_000;
const OVERVIEW_MIN_BITRATE_BPS = 250_000;
const OVERVIEW_MAX_FRAME_RATE_FPS = 8;

export function resolveRemoteWindowStreamGroupBudget(options: {
  requested: RemoteWindowVideoBitrateConfig;
  hasOverview: boolean;
}): RemoteWindowStreamGroupBudget {
  const totalMaxBitrateBps = options.requested.maxBitrateBps;
  const requestedFrameRate = options.requested.maxFrameRateFps ?? 30;
  if (!options.hasOverview) {
    return {
      totalMaxBitrateBps,
      focus: {
        maxBitrateBps: totalMaxBitrateBps,
        maxFrameRateFps: requestedFrameRate,
      },
    };
  }
  const proportionalOverview = Math.floor(totalMaxBitrateBps * 0.2);
  const overviewMaxBitrateBps = Math.min(
    OVERVIEW_MAX_BITRATE_BPS,
    Math.max(OVERVIEW_MIN_BITRATE_BPS, proportionalOverview),
  );
  return {
    totalMaxBitrateBps,
    focus: {
      maxBitrateBps: totalMaxBitrateBps - overviewMaxBitrateBps,
      maxFrameRateFps: requestedFrameRate,
    },
    overview: {
      maxBitrateBps: overviewMaxBitrateBps,
      maxFrameRateFps: Math.min(requestedFrameRate, OVERVIEW_MAX_FRAME_RATE_FPS),
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
  previousFrameRate: number;
  senderParametersChanged: boolean;
  captureFrameRateChanged: boolean;
  senderParametersApplied: boolean;
  captureFrameRateApplied: boolean;
}

function prepareLane(lane: RemoteWindowQualityLane): PreparedRemoteWindowQualityLane {
  if (!lane.sender || typeof lane.sender.getParameters !== 'function' || typeof lane.sender.setParameters !== 'function') {
    throw new Error('remote window quality sender is unavailable');
  }
  if (!lane.captureSource?.updateFrameRate) {
    throw new Error('remote window capture cadence control is unavailable');
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
    previousFrameRate: lane.captureSource.frameRate,
    senderParametersChanged,
    captureFrameRateChanged: lane.captureSource.frameRate !== lane.budget.maxFrameRateFps,
    senderParametersApplied: false,
    captureFrameRateApplied: false,
  };
}

export async function applyRemoteWindowStreamGroupQuality(options: {
  requested: RemoteWindowVideoBitrateConfig;
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
      if (lane.captureFrameRateChanged) {
        await lane.captureSource!.updateFrameRate!(lane.budget.maxFrameRateFps);
        lane.captureFrameRateApplied = true;
      }
    }
    return budget;
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const lane of applied.reverse()) {
      try {
        if (lane.captureFrameRateApplied) {
          await lane.captureSource!.updateFrameRate!(lane.previousFrameRate);
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
        rollbackErrors.push(formatRemoteWindowVideoBitrateError(rollbackError));
      }
    }
    const message = formatRemoteWindowVideoBitrateError(error);
    throw new Error(rollbackErrors.length > 0
      ? `${message}; quality rollback failed: ${rollbackErrors.join('; ')}`
      : message);
  }
}
