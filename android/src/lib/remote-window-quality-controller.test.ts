import { describe, expect, it } from 'vitest';
import {
  acceptRemoteWindowQualityResult,
  beginRemoteWindowQualityRequest,
  createRemoteWindowQualityApplyState,
  rejectRemoteWindowQualityRequest,
} from './remote-window-quality-controller';
import { buildRemoteWindowVideoProfile } from './remote-window-video-quality';

const config = buildRemoteWindowVideoProfile('smooth');

describe('remote window acknowledged quality state', () => {
  it('changes applied truth only after the matching applied result', () => {
    const pending = beginRemoteWindowQualityRequest({
      state: createRemoteWindowQualityApplyState(),
      qualityKey: 'stream|smooth',
      requested: config,
    });
    expect(pending.state.phase).toBe('requested');
    const applied = acceptRemoteWindowQualityResult(pending.state, {
      requestId: 'quality-1',
      streamId: 'stream',
      streamGroupId: 'stream',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: pending.revision,
      targetId: 'target',
      status: 'applied',
      requestedVideoProfile: config,
      appliedVideoProfile: config,
    });
    expect(applied).toMatchObject({ phase: 'applied', revision: 1, applied: config });
  });

  it('ignores stale results and keeps rejection visible', () => {
    const first = beginRemoteWindowQualityRequest({
      state: createRemoteWindowQualityApplyState(),
      qualityKey: 'first',
      requested: config,
    });
    const second = beginRemoteWindowQualityRequest({
      state: first.state,
      qualityKey: 'second',
      requested: config,
    });
    const stale = acceptRemoteWindowQualityResult(second.state, {
      requestId: 'quality-stale',
      streamId: 'stream',
      streamGroupId: 'stream',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 1,
      targetId: 'target',
      status: 'applied',
      requestedVideoProfile: config,
      appliedVideoProfile: config,
    });
    expect(stale).toBe(second.state);
    expect(rejectRemoteWindowQualityRequest({
      state: second.state,
      revision: 2,
      message: 'sender rejected',
    })).toMatchObject({ phase: 'rejected', revision: 2, message: 'sender rejected' });
  });

  it('forms acknowledged state when a lane bitrate is unknown (unbounded, 0)', () => {
    // A rejected sender update with no previous maxBitrate must still yield a
    // usable acknowledged profile: capture fields applied, bitrate reported as
    // 0 (unbounded) instead of the requested cap.
    const pending = beginRemoteWindowQualityRequest({
      state: createRemoteWindowQualityApplyState(),
      qualityKey: 'stream|smooth',
      requested: config,
    });
    const accepted = acceptRemoteWindowQualityResult(pending.state, {
      requestId: 'quality-unknown',
      streamId: 'stream',
      streamGroupId: 'stream',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: pending.revision,
      targetId: 'target',
      status: 'degraded-unknown-bitrate',
      requestedVideoProfile: config,
      appliedVideoProfile: { ...config, maxBitrateBps: 0 },
      appliedGroupBudget: {
        totalMaxBitrateBps: 0,
        focus: {
          maxBitrateBps: 0,
          maxFrameRateFps: config.maxFrameRateFps,
          maxCaptureWidth: config.maxCaptureWidth,
          maxCaptureHeight: config.maxCaptureHeight,
          maxFrameAgeMs: config.maxFrameAgeMs,
        },
      },
      senderParametersDegraded: [{ lane: 'focus', reason: 'InvalidStateError' }],
    });
    expect(accepted).toMatchObject({
      phase: 'applied',
      applied: { maxBitrateBps: 0 },
      acknowledged: { profile: { maxBitrateBps: 0 } },
    });
    expect(accepted.phase === 'applied' && accepted.acknowledged.senderParametersDegraded)
      .toEqual([{ lane: 'focus', reason: 'InvalidStateError' }]);
  });
});
