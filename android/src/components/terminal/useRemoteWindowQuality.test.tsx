// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteWindowStreamQualityResultPayload } from '../../lib/types';
import { useRemoteWindowQuality, type RemoteWindowQualityUpdater } from './useRemoteWindowQuality';

afterEach(cleanup);

describe('useRemoteWindowQuality owner', () => {
  it('keeps requested truth until the matching daemon ACK is applied', async () => {
    let resolveResult!: (result: RemoteWindowStreamQualityResultPayload) => void;
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(() => new Promise<RemoteWindowStreamQualityResultPayload>((resolve) => {
      resolveResult = resolve;
    }));
    const { result } = renderHook(() => useRemoteWindowQuality({
      activeSessionId: 'session',
      streamId: 'stream',
      targetId: 'target',
      streamReady: true,
      focusStreamActive: true,
      mode: 'floating',
      fullscreenScale: 1,
      bitratePreset: '5mbps',
      updateStreamQuality,
      collectStatsRef: { current: null },
    }));

    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(1));
    expect(result.current.qualityApplyState.phase).toBe('requested');
    const payload = updateStreamQuality.mock.calls[0][1];
    await act(async () => resolveResult({
      requestId: 'quality-1',
      streamId: 'stream',
      streamGroupId: 'stream',
      revision: payload.revision,
      targetId: 'target',
      status: 'applied',
      requestedVideoBitrate: payload.videoBitrate,
      appliedVideoBitrate: payload.videoBitrate,
    }));
    expect(result.current.qualityApplyState.phase).toBe('applied');
  });

  it('projects transport rejection and resets both ACK and adaptive state', async () => {
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>().mockRejectedValue(new Error('sender rejected'));
    const { result } = renderHook(() => useRemoteWindowQuality({
      activeSessionId: 'session',
      streamId: 'stream',
      targetId: 'target',
      streamReady: true,
      focusStreamActive: true,
      mode: 'fullscreen',
      fullscreenScale: 1,
      bitratePreset: '10mbps',
      updateStreamQuality,
      collectStatsRef: { current: null },
    }));

    await waitFor(() => expect(result.current.qualityApplyState.phase).toBe('rejected'));
    expect(result.current.qualityApplyState).toMatchObject({ message: 'sender rejected' });
    act(() => result.current.resetQualityState());
    expect(result.current.qualityApplyState.phase).toBe('idle');
  });
});
