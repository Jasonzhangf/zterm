// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowVideoPreference,
} from '../../lib/types';
import { buildRemoteWindowVideoProfile } from '../../lib/remote-window-video-quality';
import {
  REMOTE_WINDOW_QUALITY_REQUEST_TIMEOUT_MS,
  useRemoteWindowQuality,
  type RemoteWindowQualityUpdater,
} from './useRemoteWindowQuality';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function appliedResult(
  payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>,
): RemoteWindowStreamQualityResultPayload {
  return {
    requestId: `quality-${payload.revision}`,
    streamId: payload.streamId,
    streamGroupId: payload.streamGroupId,
    mediaPlan: payload.mediaPlan,
    mediaPlanVersion: payload.mediaPlanVersion,
    revision: payload.revision,
    targetId: payload.targetId,
    status: 'applied',
    requestedVideoProfile: payload.videoProfile,
    appliedVideoProfile: payload.videoProfile,
  };
}

interface RenderQualityHookProps {
  preference: RemoteWindowVideoPreference;
  bitrateMultiplier?: 1 | 2 | 4;
  maxFrameRateFps?: 15 | 30 | 60;
}

function renderQualityHook(options: {
  preference?: RemoteWindowVideoPreference;
  bitrateMultiplier?: 1 | 2 | 4;
  maxFrameRateFps?: 15 | 30 | 60;
  updateStreamQuality: RemoteWindowQualityUpdater;
  collectStats?: () => Promise<null | {
    sampledAtMs: number;
    availableOutgoingBitrateBps: number;
    qualityLimitationReason: string;
  }>;
}) {
  return renderHook<ReturnType<typeof useRemoteWindowQuality>, RenderQualityHookProps>((props: RenderQualityHookProps) => useRemoteWindowQuality({
    activeSessionId: 'session',
    streamId: 'stream',
    targetId: 'target',
    mediaPlan: 'single-focus',
    streamReady: true,
    focusStreamActive: true,
    videoPreference: props.preference,
    bitrateMultiplier: props.bitrateMultiplier,
    maxFrameRateFps: props.maxFrameRateFps,
    updateStreamQuality: options.updateStreamQuality,
    collectStatsRef: { current: options.collectStats ?? null },
  }), {
    initialProps: {
      preference: options.preference ?? 'smooth',
      bitrateMultiplier: options.bitrateMultiplier,
      maxFrameRateFps: options.maxFrameRateFps,
    } satisfies RenderQualityHookProps,
  });
}

describe('useRemoteWindowQuality owner', () => {
  it('keeps requested truth until the matching daemon ACK is applied', async () => {
    let resolveResult!: (result: RemoteWindowStreamQualityResultPayload) => void;
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(() => new Promise((resolve) => {
      resolveResult = resolve;
    }));
    const { result } = renderQualityHook({ updateStreamQuality });

    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(1));
    expect(result.current.qualityApplyState.phase).toBe('requested');
    const payload = updateStreamQuality.mock.calls[0][1];
    expect(payload.mediaPlanVersion).toBe(2);
    await act(async () => resolveResult(appliedResult(payload)));
    expect(result.current.qualityApplyState).toMatchObject({
      phase: 'applied',
      applied: buildRemoteWindowVideoProfile('smooth'),
    });
  });

  it('propagates the selected bitrate multiplier and frame-rate ceiling into the requested profile', async () => {
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(async (_sessionId, payload) => appliedResult(payload));
    renderQualityHook({
      updateStreamQuality,
      bitrateMultiplier: 4,
      maxFrameRateFps: 60,
    });

    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(1));
    expect(updateStreamQuality.mock.calls[0][1].videoProfile).toMatchObject({
      maxBitrateBps: 4_000_000,
      maxFrameRateFps: 60,
    });
  });

  it('is single-flight and sends only the latest queued profile', async () => {
    const resolvers: Array<(result: RemoteWindowStreamQualityResultPayload) => void> = [];
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const { rerender } = renderQualityHook({ updateStreamQuality });
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(1));

    rerender({ preference: 'quality' });
    rerender({ preference: 'quality' });
    expect(updateStreamQuality).toHaveBeenCalledTimes(1);
    await act(async () => resolvers[0](appliedResult(updateStreamQuality.mock.calls[0][1])));
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(2));
    expect(updateStreamQuality.mock.calls[1][1].videoProfile).toEqual(
      buildRemoteWindowVideoProfile('quality', { interactionActive: false }),
    );
  });

  it('leaves requested state on a resolved rejection and can apply the queued latest profile', async () => {
    let firstResolve!: (result: RemoteWindowStreamQualityResultPayload) => void;
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>()
      .mockImplementationOnce(() => new Promise((resolve) => {
        firstResolve = resolve;
      }))
      .mockImplementationOnce(async (_sessionId, payload) => appliedResult(payload));
    const { result, rerender } = renderQualityHook({ updateStreamQuality });
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(1));
    rerender({ preference: 'quality' });
    const firstPayload = updateStreamQuality.mock.calls[0][1];
    await act(async () => firstResolve({
      ...appliedResult(firstPayload),
      status: 'rejected',
      appliedVideoProfile: undefined,
      error: { code: 'remote_window_stream_quality_busy', message: 'quality busy' },
    }));
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.qualityApplyState.phase).toBe('applied'));
    expect(updateStreamQuality.mock.calls[1][1].videoProfile.preference).toBe('quality');
  });

  it('times out, ignores the late result, and applies the latest queued request', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(result: RemoteWindowStreamQualityResultPayload) => void> = [];
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const { result, rerender } = renderQualityHook({ updateStreamQuality });
    await act(async () => Promise.resolve());
    expect(updateStreamQuality).toHaveBeenCalledTimes(1);
    rerender({ preference: 'quality' });

    await act(async () => {
      vi.advanceTimersByTime(REMOTE_WINDOW_QUALITY_REQUEST_TIMEOUT_MS);
      await Promise.resolve();
    });
    expect(updateStreamQuality).toHaveBeenCalledTimes(2);
    const secondPayload = updateStreamQuality.mock.calls[1][1];
    await act(async () => resolvers[0](appliedResult(updateStreamQuality.mock.calls[0][1])));
    expect(result.current.qualityApplyState).toMatchObject({
      phase: 'requested',
      revision: secondPayload.revision,
    });
    await act(async () => resolvers[1](appliedResult(secondPayload)));
    expect(result.current.qualityApplyState).toMatchObject({ phase: 'applied', revision: 2 });
  });

  it('keeps stats observable without adapting the media profile', async () => {
    let sampledAtMs = 0;
    const collectStats = vi.fn(async () => ({
      sampledAtMs: sampledAtMs += 2_000,
      availableOutgoingBitrateBps: 3_000_000,
      qualityLimitationReason: 'bandwidth',
    }));
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(async (_sessionId, payload) => appliedResult(payload));
    const { result } = renderQualityHook({ updateStreamQuality, collectStats });
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(collectStats).toHaveBeenCalled());
    expect(updateStreamQuality).toHaveBeenCalledTimes(1);
    expect(result.current.adaptiveCause).toBe('none');
    expect(result.current.lastStatsSample).toMatchObject({
      availableOutgoingBitrateBps: 3_000_000,
      qualityLimitationReason: 'bandwidth',
    });
  });

  it('cancels an active timeout and ignores its late result after reset', async () => {
    vi.useFakeTimers();
    let resolveResult!: (result: RemoteWindowStreamQualityResultPayload) => void;
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(() => new Promise((resolve) => {
      resolveResult = resolve;
    }));
    const { result } = renderQualityHook({ updateStreamQuality });
    await act(async () => Promise.resolve());
    const payload = updateStreamQuality.mock.calls[0][1];
    act(() => result.current.resetQualityState());
    await act(async () => {
      vi.advanceTimersByTime(REMOTE_WINDOW_QUALITY_REQUEST_TIMEOUT_MS);
      resolveResult(appliedResult(payload));
      await Promise.resolve();
    });
    expect(result.current.qualityApplyState.phase).toBe('idle');
  });
});
