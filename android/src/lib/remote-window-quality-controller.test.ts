import { describe, expect, it } from 'vitest';
import {
  acceptRemoteWindowQualityResult,
  beginRemoteWindowQualityRequest,
  createRemoteWindowQualityApplyState,
  rejectRemoteWindowQualityRequest,
} from './remote-window-quality-controller';

const config = {
  preset: '5mbps' as const,
  bitrateMbps: 5 as const,
  maxBitrateBps: 5_000_000,
  maxFrameRateFps: 12 as const,
};

describe('remote window acknowledged quality state', () => {
  it('changes applied truth only after the matching applied result', () => {
    const pending = beginRemoteWindowQualityRequest({
      state: createRemoteWindowQualityApplyState(),
      qualityKey: 'stream|5mbps',
      requested: config,
    });
    expect(pending.state.phase).toBe('requested');
    const applied = acceptRemoteWindowQualityResult(pending.state, {
      requestId: 'quality-1',
      streamId: 'stream',
      streamGroupId: 'stream',
      revision: pending.revision,
      targetId: 'target',
      status: 'applied',
      requestedVideoBitrate: config,
      appliedVideoBitrate: config,
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
      revision: 1,
      targetId: 'target',
      status: 'applied',
      requestedVideoBitrate: config,
      appliedVideoBitrate: config,
    });
    expect(stale).toBe(second.state);
    expect(rejectRemoteWindowQualityRequest({
      state: second.state,
      revision: 2,
      message: 'sender rejected',
    })).toMatchObject({ phase: 'rejected', revision: 2, message: 'sender rejected' });
  });
});
