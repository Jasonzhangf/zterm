import { describe, expect, it, vi } from 'vitest';
import { applyRemoteWindowStreamGroupQuality, resolveRemoteWindowStreamGroupBudget } from './remote-window-quality';

const requested = {
  preset: '5mbps' as const,
  bitrateMbps: 5 as const,
  maxBitrateBps: 5_000_000,
  maxFrameRateFps: 12 as const,
};

describe('remote window stream-group quality owner', () => {
  it('reserves overview inside one total budget and protects focus first', () => {
    expect(resolveRemoteWindowStreamGroupBudget({ requested, hasOverview: true })).toEqual({
      totalMaxBitrateBps: 5_000_000,
      focus: { maxBitrateBps: 4_000_000, maxFrameRateFps: 12 },
      overview: { maxBitrateBps: 1_000_000, maxFrameRateFps: 8 },
    });
    expect(resolveRemoteWindowStreamGroupBudget({
      requested: { ...requested, preset: '2mbps', bitrateMbps: 2, maxBitrateBps: 2_000_000, maxFrameRateFps: 5 },
      hasOverview: true,
    })).toMatchObject({
      totalMaxBitrateBps: 2_000_000,
      focus: { maxBitrateBps: 1_600_000, maxFrameRateFps: 5 },
      overview: { maxBitrateBps: 400_000, maxFrameRateFps: 5 },
    });
  });

  it('applies sender and capture cadence without changing encoding structure', async () => {
    const focusSet = vi.fn(async () => undefined);
    const overviewSet = vi.fn(async () => undefined);
    const focusCadence = vi.fn(async () => undefined);
    const overviewCadence = vi.fn(async () => undefined);
    await expect(applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: {
        getParameters: () => ({ encodings: [{ rid: 'f' }] }),
        setParameters: focusSet,
      } as unknown as RTCRtpSender,
      focusCaptureSource: { width: 1, height: 1, frameRate: 30, updateFrameRate: focusCadence, stop: vi.fn() },
      overviewSender: {
        getParameters: () => ({ encodings: [{ rid: 'o' }] }),
        setParameters: overviewSet,
      } as unknown as RTCRtpSender,
      overviewCaptureSource: { width: 1, height: 1, frameRate: 8, updateFrameRate: overviewCadence, stop: vi.fn() },
    })).resolves.toMatchObject({ totalMaxBitrateBps: 5_000_000 });
    expect(focusSet).toHaveBeenCalledWith(expect.objectContaining({
      encodings: [{ rid: 'f', maxBitrate: 4_000_000, maxFramerate: 12 }],
    }));
    expect(overviewSet).toHaveBeenCalledWith(expect.objectContaining({
      encodings: [{ rid: 'o', maxBitrate: 1_000_000, maxFramerate: 8 }],
    }));
    expect(focusCadence).toHaveBeenCalledWith(12);
    expect(overviewCadence).not.toHaveBeenCalled();
  });

  it('applies bitrate-only changes without touching capture cadence', async () => {
    const setParameters = vi.fn(async () => undefined);
    const updateFrameRate = vi.fn(async () => undefined);
    await applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: {
        getParameters: () => ({ encodings: [{ maxBitrate: 3_000_000, maxFramerate: 12 }] }),
        setParameters,
      } as unknown as RTCRtpSender,
      focusCaptureSource: { width: 1, height: 1, frameRate: 12, updateFrameRate, stop: vi.fn() },
    });
    expect(setParameters).toHaveBeenCalledTimes(1);
    expect(updateFrameRate).not.toHaveBeenCalled();
  });

  it('returns a full no-op when sender and capture already match', async () => {
    const setParameters = vi.fn(async () => undefined);
    const updateFrameRate = vi.fn(async () => undefined);
    await applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: {
        getParameters: () => ({ encodings: [{ maxBitrate: 5_000_000, maxFramerate: 12 }] }),
        setParameters,
      } as unknown as RTCRtpSender,
      focusCaptureSource: { width: 1, height: 1, frameRate: 12, updateFrameRate, stop: vi.fn() },
    });
    expect(setParameters).not.toHaveBeenCalled();
    expect(updateFrameRate).not.toHaveBeenCalled();
  });

  it('rejects before mutation when any active lane cannot be controlled', async () => {
    const focusSet = vi.fn(async () => undefined);
    await expect(applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: {
        getParameters: () => ({ encodings: [{ rid: 'f' }] }),
        setParameters: focusSet,
      } as unknown as RTCRtpSender,
      focusCaptureSource: { width: 1, height: 1, frameRate: 30, updateFrameRate: vi.fn(), stop: vi.fn() },
      overviewSender: {
        getParameters: () => ({ encodings: [] }),
        setParameters: vi.fn(),
      } as unknown as RTCRtpSender,
      overviewCaptureSource: { width: 1, height: 1, frameRate: 8, updateFrameRate: vi.fn(), stop: vi.fn() },
    })).rejects.toThrow(/no encodings/);
    expect(focusSet).not.toHaveBeenCalled();
  });

  it('rolls every lane back when a later mutation rejects', async () => {
    const focusSet = vi.fn(async () => undefined);
    const overviewSet = vi.fn(async () => undefined);
    const focusCadence = vi.fn(async () => undefined);
    const overviewCadence = vi.fn()
      .mockRejectedValueOnce(new Error('overview cadence rejected'))
      .mockResolvedValueOnce(undefined);
    await expect(applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: {
        getParameters: () => ({ encodings: [{ rid: 'f', maxBitrate: 9_000_000 }] }),
        setParameters: focusSet,
      } as unknown as RTCRtpSender,
      focusCaptureSource: { width: 1, height: 1, frameRate: 30, updateFrameRate: focusCadence, stop: vi.fn() },
      overviewSender: {
        getParameters: () => ({ encodings: [{ rid: 'o', maxBitrate: 2_000_000 }] }),
        setParameters: overviewSet,
      } as unknown as RTCRtpSender,
      overviewCaptureSource: { width: 1, height: 1, frameRate: 30, updateFrameRate: overviewCadence, stop: vi.fn() },
    })).rejects.toThrow('overview cadence rejected');
    expect(focusSet).toHaveBeenLastCalledWith({ encodings: [{ rid: 'f', maxBitrate: 9_000_000 }] });
    expect(focusCadence).toHaveBeenLastCalledWith(30);
    expect(overviewSet).toHaveBeenLastCalledWith({ encodings: [{ rid: 'o', maxBitrate: 2_000_000 }] });
    expect(overviewCadence).toHaveBeenCalledTimes(1);
    expect(overviewCadence).toHaveBeenCalledWith(8);
  });

  it('requests a fresh native sender transaction before rolling back a partial lane', async () => {
    let transaction = 0;
    const getParameters = vi.fn(() => {
      transaction += 1;
      return {
        transactionId: `transaction-${transaction}`,
        encodings: [{ maxBitrate: 9_000_000, maxFramerate: 30 }],
      } as RTCRtpSendParameters;
    });
    const setParameters = vi.fn(async (nextParameters: RTCRtpSendParameters) => {
      if (nextParameters.transactionId !== `transaction-${transaction}`) {
        throw new Error('Failed to set parameters since getParameters() has never been called on this sender');
      }
    });
    const captureCadence = vi.fn()
      .mockRejectedValueOnce(new Error('capture cadence rejected'));

    await expect(applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: {
        getParameters,
        setParameters,
      } as unknown as RTCRtpSender,
      focusCaptureSource: { width: 1, height: 1, frameRate: 30, updateFrameRate: captureCadence, stop: vi.fn() },
    })).rejects.toThrow('capture cadence rejected');

    const [nextCall, rollbackCall] = setParameters.mock.calls;
    expect(nextCall?.[0]).not.toBe(rollbackCall?.[0]);
    expect(nextCall?.[0].transactionId).toBe('transaction-1');
    expect(rollbackCall?.[0].transactionId).toBe('transaction-2');
    expect(getParameters).toHaveBeenCalledTimes(2);
    expect(rollbackCall?.[0].encodings).toEqual([{ maxBitrate: 9_000_000, maxFramerate: 30 }]);
  });

  it('projects native sender failures without an empty diagnostic message', async () => {
    const invalidStateError = Object.assign(new Error(''), { name: 'InvalidStateError', code: 11 });
    const setParameters = vi.fn(async () => {
      throw invalidStateError;
    });

    await expect(applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: {
        getParameters: () => ({ encodings: [{ maxBitrate: 9_000_000, maxFramerate: 30 }] }),
        setParameters,
      } as unknown as RTCRtpSender,
      focusCaptureSource: { width: 1, height: 1, frameRate: 30, updateFrameRate: vi.fn(), stop: vi.fn() },
    })).rejects.toThrow(/InvalidStateError/);
  });

  it('does not rollback a sender when setParameters failed before committing it', async () => {
    const invalidStateError = Object.assign(new Error(''), { name: 'InvalidStateError', code: 11 });
    const getParameters = vi.fn(() => ({
      encodings: [{ maxBitrate: 9_000_000, maxFramerate: 30 }],
    }) as RTCRtpSendParameters);
    const setParameters = vi.fn(async () => {
      throw invalidStateError;
    });
    const captureCadence = vi.fn(async () => undefined);

    await expect(applyRemoteWindowStreamGroupQuality({
      requested,
      focusSender: {
        getParameters,
        setParameters,
      } as unknown as RTCRtpSender,
      focusCaptureSource: {
        width: 1,
        height: 1,
        frameRate: 30,
        updateFrameRate: captureCadence,
        stop: vi.fn(),
      },
    })).rejects.toThrow(/^InvalidStateError$/);
    expect(getParameters).toHaveBeenCalledTimes(1);
    expect(setParameters).toHaveBeenCalledTimes(1);
    expect(captureCadence).not.toHaveBeenCalled();
  });
});
