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
});
