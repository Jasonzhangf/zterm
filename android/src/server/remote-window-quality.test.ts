import { describe, expect, it, vi } from 'vitest';
import type { RemoteWindowVideoProfile } from '@zterm/shared/protocol';
import type { RemoteWindowCaptureFrameSource } from './remote-window-capture';
import { applyRemoteWindowStreamGroupQuality, resolveRemoteWindowStreamGroupBudget } from './remote-window-quality';
import { makeRemoteWindowVideoProfileFixture } from './remote-window-video-profile-test-fixture';

const requested = makeRemoteWindowVideoProfileFixture('smooth');

function makeCapture(
  profile: Pick<RemoteWindowVideoProfile, 'maxFrameRateFps' | 'maxCaptureWidth' | 'maxCaptureHeight'>,
  updateVideoProfile = vi.fn(async () => undefined),
): RemoteWindowCaptureFrameSource {
  return {
    captureEpoch: 0,
    width: 1,
    height: 1,
    frameRate: profile.maxFrameRateFps,
    maxCaptureWidth: profile.maxCaptureWidth,
    maxCaptureHeight: profile.maxCaptureHeight,
    updateVideoProfile,
    stop: vi.fn(),
  };
}

describe('remote window stream-group quality owner', () => {
  it('reserves only the explicit overview budget inside one total profile', () => {
    expect(resolveRemoteWindowStreamGroupBudget({ requested, hasOverview: true })).toEqual({
      totalMaxBitrateBps: 6_000_000,
      focus: {
        maxBitrateBps: 5_750_000,
        maxFrameRateFps: 30,
        maxCaptureWidth: 1440,
        maxCaptureHeight: 900,
        maxFrameAgeMs: 100,
      },
      overview: {
        maxBitrateBps: 250_000,
        maxFrameRateFps: 2,
        maxCaptureWidth: 960,
        maxCaptureHeight: 600,
        maxFrameAgeMs: 100,
      },
    });
  });

  it('applies sender and capture profiles without changing encoding structure', async () => {
    const focusSet = vi.fn(async () => undefined);
    const overviewSet = vi.fn(async () => undefined);
    const focusProfile = vi.fn(async () => undefined);
    const overviewProfile = vi.fn(async () => undefined);
    await expect(applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: {
        getParameters: () => ({ encodings: [{ rid: 'f' }] }),
        setParameters: focusSet,
      } as unknown as RTCRtpSender,
      focusCaptureSource: makeCapture({
        maxFrameRateFps: 60,
        maxCaptureWidth: 1920,
        maxCaptureHeight: 1200,
      }, focusProfile),
      overviewSender: {
        getParameters: () => ({ encodings: [{ rid: 'o' }] }),
        setParameters: overviewSet,
      } as unknown as RTCRtpSender,
      overviewCaptureSource: makeCapture({
        maxFrameRateFps: 8,
        maxCaptureWidth: 1440,
        maxCaptureHeight: 900,
      }, overviewProfile),
    })).resolves.toMatchObject({ totalMaxBitrateBps: 6_000_000 });
    expect(focusSet).toHaveBeenCalledWith(expect.objectContaining({
      encodings: [{ rid: 'f', maxBitrate: 5_750_000, maxFramerate: 30 }],
    }));
    expect(overviewSet).toHaveBeenCalledWith(expect.objectContaining({
      encodings: [{ rid: 'o', maxBitrate: 250_000, maxFramerate: 2 }],
    }));
    expect(focusProfile).toHaveBeenCalledWith({
      maxFrameRateFps: 30,
      maxCaptureWidth: 1440,
      maxCaptureHeight: 900,
    });
    expect(overviewProfile).toHaveBeenCalledWith({
      maxFrameRateFps: 2,
      maxCaptureWidth: 960,
      maxCaptureHeight: 600,
    });
  });

  it('applies bitrate-only changes without touching capture', async () => {
    const setParameters = vi.fn(async () => undefined);
    const updateVideoProfile = vi.fn(async () => undefined);
    await applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: {
        getParameters: () => ({ encodings: [{ maxBitrate: 3_000_000, maxFramerate: 30 }] }),
        setParameters,
      } as unknown as RTCRtpSender,
      focusCaptureSource: makeCapture(requested, updateVideoProfile),
    });
    expect(setParameters).toHaveBeenCalledTimes(1);
    expect(updateVideoProfile).not.toHaveBeenCalled();
  });

  it('returns a full no-op when sender and capture already match', async () => {
    const setParameters = vi.fn(async () => undefined);
    const updateVideoProfile = vi.fn(async () => undefined);
    await applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: {
        getParameters: () => ({ encodings: [{ maxBitrate: 6_000_000, maxFramerate: 30 }] }),
        setParameters,
      } as unknown as RTCRtpSender,
      focusCaptureSource: makeCapture(requested, updateVideoProfile),
    });
    expect(setParameters).not.toHaveBeenCalled();
    expect(updateVideoProfile).not.toHaveBeenCalled();
  });

  it('rejects before mutation when any active lane cannot be controlled', async () => {
    const focusSet = vi.fn(async () => undefined);
    await expect(applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: {
        getParameters: () => ({ encodings: [{ rid: 'f' }] }),
        setParameters: focusSet,
      } as unknown as RTCRtpSender,
      focusCaptureSource: makeCapture(requested),
      overviewSender: {
        getParameters: () => ({ encodings: [] }),
        setParameters: vi.fn(),
      } as unknown as RTCRtpSender,
      overviewCaptureSource: makeCapture(requested),
    })).rejects.toThrow(/no encodings/);
    expect(focusSet).not.toHaveBeenCalled();
  });

  it('rolls every committed lane back when a later capture mutation rejects', async () => {
    const focusSet = vi.fn(async () => undefined);
    const overviewSet = vi.fn(async () => undefined);
    const focusProfile = vi.fn(async () => undefined);
    const overviewProfile = vi.fn().mockRejectedValueOnce(new Error('overview profile rejected'));
    await expect(applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: {
        getParameters: () => ({ encodings: [{ rid: 'f', maxBitrate: 9_000_000, maxFramerate: 60 }] }),
        setParameters: focusSet,
      } as unknown as RTCRtpSender,
      focusCaptureSource: makeCapture({
        maxFrameRateFps: 60,
        maxCaptureWidth: 1920,
        maxCaptureHeight: 1200,
      }, focusProfile),
      overviewSender: {
        getParameters: () => ({ encodings: [{ rid: 'o', maxBitrate: 2_000_000, maxFramerate: 8 }] }),
        setParameters: overviewSet,
      } as unknown as RTCRtpSender,
      overviewCaptureSource: makeCapture({
        maxFrameRateFps: 8,
        maxCaptureWidth: 1280,
        maxCaptureHeight: 800,
      }, overviewProfile),
    })).rejects.toThrow('overview profile rejected');
    expect(focusProfile).toHaveBeenLastCalledWith({
      maxFrameRateFps: 60,
      maxCaptureWidth: 1920,
      maxCaptureHeight: 1200,
    });
    expect(overviewProfile).toHaveBeenCalledTimes(1);
    expect(focusSet).toHaveBeenCalledTimes(2);
    expect(overviewSet).toHaveBeenCalledTimes(2);
  });

  it('requests a fresh sender transaction for rollback after capture failure', async () => {
    let transaction = 0;
    const getParameters = vi.fn(() => {
      transaction += 1;
      return {
        transactionId: `transaction-${transaction}`,
        encodings: [{ maxBitrate: 9_000_000, maxFramerate: 60 }],
      } as RTCRtpSendParameters;
    });
    const setParameters = vi.fn(async (parameters: RTCRtpSendParameters) => {
      if (parameters.transactionId !== `transaction-${transaction}`) {
        throw new Error('stale sender transaction');
      }
    });
    const updateVideoProfile = vi.fn().mockRejectedValueOnce(new Error('capture profile rejected'));

    await expect(applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: { getParameters, setParameters } as unknown as RTCRtpSender,
      focusCaptureSource: makeCapture({
        maxFrameRateFps: 60,
        maxCaptureWidth: 1920,
        maxCaptureHeight: 1200,
      }, updateVideoProfile),
    })).rejects.toThrow('capture profile rejected');

    expect(getParameters).toHaveBeenCalledTimes(2);
    expect(setParameters.mock.calls[0]?.[0].transactionId).toBe('transaction-1');
    expect(setParameters.mock.calls[1]?.[0].transactionId).toBe('transaction-2');
    expect(setParameters.mock.calls[1]?.[0].encodings).toEqual([{
      maxBitrate: 9_000_000,
      maxFramerate: 60,
    }]);
  });

  it('does not rollback a sender whose setParameters failed before commit', async () => {
    const getParameters = vi.fn(() => ({
      encodings: [{ maxBitrate: 9_000_000, maxFramerate: 60 }],
    }) as RTCRtpSendParameters);
    const setParameters = vi.fn(async () => {
      throw Object.assign(new Error(''), { name: 'InvalidStateError' });
    });
    const updateVideoProfile = vi.fn(async () => undefined);

    await expect(applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: { getParameters, setParameters } as unknown as RTCRtpSender,
      focusCaptureSource: makeCapture(requested, updateVideoProfile),
    })).rejects.toThrow(/^InvalidStateError$/);
    expect(getParameters).toHaveBeenCalledTimes(1);
    expect(setParameters).toHaveBeenCalledTimes(1);
    expect(updateVideoProfile).not.toHaveBeenCalled();
  });
});
