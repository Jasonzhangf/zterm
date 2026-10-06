// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowVideoPreference,
} from '../../lib/types';
import { buildRemoteWindowVideoProfile } from '../../lib/remote-window-video-quality';
import {
  useRemoteWindowQuality,
  type RemoteWindowQualityUpdater,
} from './useRemoteWindowQuality';
import type { RemoteWindowVideoStatsSample } from '../../lib/remote-window-video-quality';

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
  maxBitrateCapBps?: number | null;
  maxFrameRateFps?: 15 | 30 | 60;
  streamId?: string;
}

function renderQualityHook(options: {
  preference?: RemoteWindowVideoPreference;
  maxBitrateCapBps?: number | null;
  maxFrameRateFps?: 15 | 30 | 60;
  streamId?: string;
  updateStreamQuality: RemoteWindowQualityUpdater;
  collectStats?: () => Promise<RemoteWindowVideoStatsSample | null>;
}) {
  // The stats ref must stay identity-stable across renders; otherwise the
  // sampling effect tears down and re-arms on every state update.
  const collectStatsRef = {
    current: options.collectStats ?? null,
  };
  return renderHook<ReturnType<typeof useRemoteWindowQuality>, RenderQualityHookProps>((props: RenderQualityHookProps) => useRemoteWindowQuality({
    activeSessionId: 'session',
    streamId: props.streamId ?? 'stream',
    targetId: 'target',
    mediaPlan: 'single-focus',
    streamReady: true,
    qualityStreamActive: true,
    videoPreference: props.preference,
    maxBitrateCapBps: props.maxBitrateCapBps,
    maxFrameRateFps: props.maxFrameRateFps,
    updateStreamQuality: options.updateStreamQuality,
    collectStatsRef,
  }), {
    initialProps: {
      preference: options.preference ?? 'smooth',
      maxBitrateCapBps: options.maxBitrateCapBps,
      maxFrameRateFps: options.maxFrameRateFps,
      streamId: options.streamId ?? 'stream',
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

  it('propagates the explicit Mbps cap and frame-rate ceiling into the requested profile', async () => {
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(async (_sessionId, payload) => appliedResult(payload));
    renderQualityHook({
      updateStreamQuality,
      preference: 'quality',
      maxBitrateCapBps: 5_000_000,
      maxFrameRateFps: 60,
    });

    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(1));
    expect(updateStreamQuality.mock.calls[0][1].videoProfile).toMatchObject({
      maxBitrateBps: 5_000_000,
      maxFrameRateFps: 60,
    });
  });

  it('reports an unconfirmed profile as unknown instead of the desired draft', async () => {
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(
      () => new Promise(() => {}),
    );
    const { result } = renderQualityHook({
      updateStreamQuality,
      preference: 'quality',
      maxBitrateCapBps: 12_000_000,
    });
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(1));
    expect(updateStreamQuality.mock.calls[0][1].videoProfile.maxBitrateBps).toBe(8_000_000);
    expect(result.current.qualityApplyState.phase).toBe('requested');
    // Nothing is applied yet, so there is no honest applied value to show.
    expect(result.current.activeProfile).toBeNull();
    expect(result.current.lastAck).toBeNull();
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

  it('keeps the last acknowledged profile visible when a later request is rejected', async () => {
    let rejectSecond!: (result: RemoteWindowStreamQualityResultPayload) => void;
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>()
      .mockImplementationOnce(async (_sessionId, payload) => appliedResult(payload))
      .mockImplementationOnce(() => new Promise((resolve) => {
        rejectSecond = resolve;
      }));
    const { result, rerender } = renderQualityHook({ updateStreamQuality });
    await waitFor(() => expect(result.current.qualityApplyState.phase).toBe('applied'));
    const acknowledged = result.current.lastAck?.profile;
    expect(acknowledged).toBeTruthy();
    rerender({ preference: 'quality' });
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(2));
    await act(async () => rejectSecond({
      ...appliedResult(updateStreamQuality.mock.calls[1][1]),
      status: 'rejected',
      appliedVideoProfile: undefined,
      error: { code: 'remote_window_stream_quality_failed', message: 'sender rejected' },
    }));
    await waitFor(() => expect(result.current.qualityApplyState.phase).toBe('rejected'));
    expect(result.current.failureMessage).toBe('sender rejected');
    // The rejected draft must not erase the profile the daemon already applied.
    expect(result.current.lastAck?.profile).toEqual(acknowledged);
  });

  it('projects the typed unsupported code without inventing an applied value', async () => {
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(
      async (_sessionId, payload) => ({
        ...appliedResult(payload),
        status: 'rejected',
        appliedVideoProfile: undefined,
        error: { code: 'remote_window_stream_quality_unsupported', message: 'sender has no encodings' },
      }),
    );
    const { result } = renderQualityHook({ updateStreamQuality });
    await waitFor(() => expect(result.current.qualityApplyState.phase).toBe('rejected'));
    expect(result.current.qualityStatus).toBe('unsupported');
    expect(result.current.failureCode).toBe('remote_window_stream_quality_unsupported');
    expect(result.current.activeProfile).toBeNull();
  });

  it('keeps one request in flight until the transport settles, then applies the queued latest', async () => {
    const resolvers: Array<(result: RemoteWindowStreamQualityResultPayload) => void> = [];
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const { result, rerender } = renderQualityHook({ updateStreamQuality });
    await act(async () => Promise.resolve());
    expect(updateStreamQuality).toHaveBeenCalledTimes(1);
    rerender({ preference: 'quality' });
    // The transport owner is the single timeout; this owner never starts a
    // second request while the first promise is still pending.
    expect(updateStreamQuality).toHaveBeenCalledTimes(1);
    await act(async () => resolvers[0](appliedResult(updateStreamQuality.mock.calls[0][1])));
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(2));
    const secondPayload = updateStreamQuality.mock.calls[1][1];
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
      receivedPacketLossRatio: 0.08,
    }));
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(async (_sessionId, payload) => appliedResult(payload));
    const { result } = renderQualityHook({ updateStreamQuality, collectStats });
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(collectStats).toHaveBeenCalled());
    expect(updateStreamQuality).toHaveBeenCalledTimes(1);
    expect(result.current.adaptiveCause).toBe('none');
    expect(result.current.lastStatsSample).toMatchObject({
      availableOutgoingBitrateBps: 3_000_000,
      receivedPacketLossRatio: 0.08,
    });
  });

  it('discards a late result after reset without settling it', async () => {
    let resolveResult!: (result: RemoteWindowStreamQualityResultPayload) => void;
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(() => new Promise((resolve) => {
      resolveResult = resolve;
    }));
    const { result } = renderQualityHook({ updateStreamQuality });
    await act(async () => Promise.resolve());
    const payload = updateStreamQuality.mock.calls[0][1];
    act(() => result.current.resetQualityState());
    await act(async () => {
      resolveResult(appliedResult(payload));
      await Promise.resolve();
    });
    expect(result.current.qualityApplyState.phase).toBe('idle');
  });

  it('settles a matching ACK after StrictMode replays effect setup', async () => {
    let resolveResult!: (result: RemoteWindowStreamQualityResultPayload) => void;
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(() => new Promise((resolve) => {
      resolveResult = resolve;
    }));
    const statsRef = { current: null };

    function Harness() {
      const quality = useRemoteWindowQuality({
        activeSessionId: 'session',
        streamId: 'stream',
        targetId: 'target',
        mediaPlan: 'single-focus',
        streamReady: true,
        qualityStreamActive: true,
        videoPreference: 'smooth',
        maxFrameRateFps: 30,
        updateStreamQuality,
        collectStatsRef: statsRef,
      });
      return React.createElement('output', null, quality.qualityStatus);
    }

    const view = render(React.createElement(StrictMode, null, React.createElement(Harness)));
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(1));
    expect(updateStreamQuality).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toBe('requested');

    await act(async () => resolveResult(appliedResult(updateStreamQuality.mock.calls[0][1])));
    expect(updateStreamQuality).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toBe('applied');
    view.unmount();
  });

  it('discards a late ACK from a real StrictMode mount teardown', async () => {
    let staleResolve!: (result: RemoteWindowStreamQualityResultPayload) => void;
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(() => new Promise((resolve) => {
      staleResolve = resolve;
    }));
    const statsRef = { current: null };
    const states: Array<string> = [];

    function Harness() {
      const quality = useRemoteWindowQuality({
        activeSessionId: 'session',
        streamId: 'stream',
        targetId: 'target',
        mediaPlan: 'single-focus',
        streamReady: true,
        qualityStreamActive: true,
        videoPreference: 'smooth',
        maxFrameRateFps: 30,
        updateStreamQuality,
        collectStatsRef: statsRef,
      });
      states.push(quality.qualityStatus);
      return React.createElement('output', null, quality.qualityStatus);
    }

    const view = render(React.createElement(StrictMode, null, React.createElement(Harness)));
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(1));
    const payload = updateStreamQuality.mock.calls[0][1];
    view.unmount();
    await act(async () => {
      staleResolve(appliedResult(payload));
      await Promise.resolve();
    });
    expect(states.at(-1)).toBe('requested');
  });

  it('keeps a remount of the same stream independent from the previous mount ACK', async () => {
    const requests: Array<{
      payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>;
      resolve: (result: RemoteWindowStreamQualityResultPayload) => void;
    }> = [];
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>((_sessionId, payload) => new Promise((resolve) => {
      requests.push({ payload, resolve });
    }));
    const statsRef = { current: null };

    function Harness() {
      const quality = useRemoteWindowQuality({
        activeSessionId: 'session',
        streamId: 'stream',
        targetId: 'target',
        mediaPlan: 'single-focus',
        streamReady: true,
        qualityStreamActive: true,
        videoPreference: 'smooth',
        maxFrameRateFps: 30,
        updateStreamQuality,
        collectStatsRef: statsRef,
      });
      return React.createElement('output', null, quality.qualityStatus);
    }

    const first = render(React.createElement(StrictMode, null, React.createElement(Harness)));
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(1));
    const firstPayload = requests[0].payload;
    first.unmount();

    const second = render(React.createElement(StrictMode, null, React.createElement(Harness)));
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(2));
    expect(second.container.textContent).toBe('requested');

    await act(async () => {
      requests[0].resolve(appliedResult(firstPayload));
      requests[1].resolve(appliedResult(requests[1].payload));
    });
    expect(second.container.textContent).toBe('applied');
    second.unmount();
  });
});

describe('useRemoteWindowQuality adaptive wiring', () => {
  // Sample timestamps share the receiver's Date.now() domain. The base sits far
  // above the fake wall clock so the policy's minimum-adjustment-interval guard
  // never blocks a downgrade in these tests.
  const CLOCK_BASE = 1_000_000_000_000_000;

  function credible(
    sampledAtMs: number,
    overrides: Partial<RemoteWindowVideoStatsSample> = {},
  ): RemoteWindowVideoStatsSample {
    return {
      sampledAtMs,
      mediaEpoch: 0,
      trackId: 'track-1',
      receivedBitrateBps: 20_000_000,
      rttMs: 20,
      framesDropped: 0,
      freezeCount: 0,
      receivedPacketLossRatio: 0,
      ...overrides,
    };
  }

  function pressure(sampledAtMs: number): RemoteWindowVideoStatsSample {
    return credible(sampledAtMs, { receivedPacketLossRatio: 0.08 });
  }

  type StatsStep = RemoteWindowVideoStatsSample | null | { rejected: unknown };

  function renderAdaptive(options: {
    preference?: RemoteWindowVideoPreference;
    updateStreamQuality: RemoteWindowQualityUpdater;
  }) {
    const queue: StatsStep[] = [];
    const collectStats = vi.fn(async (): Promise<RemoteWindowVideoStatsSample | null> => {
      const step = queue.shift();
      if (step === undefined) {
        return null;
      }
      if (step !== null && typeof step === 'object' && 'rejected' in step) {
        throw (step as { rejected: unknown }).rejected;
      }
      return step as RemoteWindowVideoStatsSample | null;
    });
    const rendered = renderQualityHook({ ...options, collectStats });
    let clock = CLOCK_BASE;
    return {
      ...rendered,
      collectStats,
      enqueue: (...steps: StatsStep[]) => {
        queue.push(...steps);
      },
      at: (deltaMs = 2_000) => {
        clock += deltaMs;
        return clock;
      },
    };
  }

  const flush = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  const tick = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
  };

  // Manual mount request applied (call 1) then two pressure samples drive a
  // level-1 adaptive downgrade (call 2).
  async function reachAdaptiveDispatch(
    harness: ReturnType<typeof renderAdaptive>,
  ): Promise<void> {
    harness.enqueue(credible(harness.at()), credible(harness.at()));
    await tick();
    await tick();
    harness.enqueue(pressure(harness.at()), pressure(harness.at()));
    await tick();
    await tick();
  }

  it('does not restore across a null stats gap and restarts the window after it', async () => {
    vi.useFakeTimers();
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(
      async (_sessionId, payload) => appliedResult(payload),
    );
    const h = renderAdaptive({ preference: 'quality', updateStreamQuality });
    await flush();
    expect(updateStreamQuality).toHaveBeenCalledTimes(1);

    await reachAdaptiveDispatch(h);
    expect(updateStreamQuality).toHaveBeenCalledTimes(2);
    expect(updateStreamQuality.mock.calls[1][1].videoProfile.maxBitrateBps).toBe(6_000_000);
    await flush();
    expect(h.result.current.qualityApplyState.phase).toBe('applied');

    // Burn the two fresh slots armed by the applied downgrade.
    h.enqueue(credible(h.at()), credible(h.at()));
    await tick();
    await tick();

    const stableAt = h.at();
    h.enqueue(credible(stableAt));
    await tick();

    // An unknown read clears the observation window.
    h.enqueue(null);
    await tick();

    // Six seconds after the pre-gap sample would restore only if the window
    // had survived the unknown gap.
    h.enqueue(credible(stableAt + 6_000));
    await tick();
    expect(updateStreamQuality).toHaveBeenCalledTimes(2);

    // The window restarted from the post-gap sample: 12s later it restores.
    h.enqueue(credible(stableAt + 6_000 + 12_000));
    await tick();
    expect(updateStreamQuality).toHaveBeenCalledTimes(3);
  });

  it('does not restore across a rejected stats read', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(
        async (_sessionId, payload) => appliedResult(payload),
      );
      const h = renderAdaptive({ preference: 'quality', updateStreamQuality });
      await flush();

      await reachAdaptiveDispatch(h);
      expect(updateStreamQuality).toHaveBeenCalledTimes(2);
      await flush();

      h.enqueue(credible(h.at()), credible(h.at()));
      await tick();
      await tick();

      const stableAt = h.at();
      h.enqueue(credible(stableAt));
      await tick();

      h.enqueue({ rejected: new Error('stats read failed') });
      await tick();

      h.enqueue(credible(stableAt + 6_000));
      await tick();
      expect(updateStreamQuality).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalled();

      h.enqueue(credible(stableAt + 6_000 + 12_000));
      await tick();
      expect(updateStreamQuality).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('lets an unknown tick skip without consuming a fresh sample slot', async () => {
    vi.useFakeTimers();
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(
      async (_sessionId, payload) => appliedResult(payload),
    );
    const h = renderAdaptive({ preference: 'quality', updateStreamQuality });
    await flush();
    expect(updateStreamQuality).toHaveBeenCalledTimes(1);

    // The manual applied request armed skip=2. A null read must not decrement
    // it, so three pressure samples can still only reach a baseline decision.
    h.enqueue(null);
    await tick();
    h.enqueue(pressure(h.at()), pressure(h.at()), pressure(h.at()));
    await tick();
    await tick();
    await tick();
    expect(updateStreamQuality).toHaveBeenCalledTimes(1);
  });

  it('discards an adaptive candidate on a NACK and keeps the last applied ACK', async () => {
    vi.useFakeTimers();
    let rejectAuto!: (result: RemoteWindowStreamQualityResultPayload) => void;
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>()
      .mockImplementationOnce(async (_sessionId, payload) => appliedResult(payload))
      .mockImplementationOnce(() => new Promise((resolve) => {
        rejectAuto = resolve;
      }));
    const h = renderAdaptive({ preference: 'quality', updateStreamQuality });
    await flush();
    const acknowledged = h.result.current.lastAck?.profile;
    expect(acknowledged?.maxBitrateBps).toBe(8_000_000);

    await reachAdaptiveDispatch(h);
    expect(updateStreamQuality).toHaveBeenCalledTimes(2);
    const autoPayload = updateStreamQuality.mock.calls[1][1];
    expect(autoPayload.videoProfile.maxBitrateBps).toBe(6_000_000);

    await act(async () => rejectAuto({
      ...appliedResult(autoPayload),
      status: 'rejected',
      appliedVideoProfile: undefined,
      error: { code: 'remote_window_stream_quality_failed', message: 'nack' },
    }));
    expect(h.result.current.qualityApplyState.phase).toBe('rejected');
    expect(h.result.current.lastAck?.profile).toEqual(acknowledged);
    expect(updateStreamQuality).toHaveBeenCalledTimes(2);
  });

  it('discards an adaptive candidate on a thrown request and keeps the last applied ACK', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let throwAuto!: (error: Error) => void;
      const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>()
        .mockImplementationOnce(async (_sessionId, payload) => appliedResult(payload))
        .mockImplementationOnce(() => new Promise((_resolve, reject) => {
          throwAuto = reject;
        }));
      const h = renderAdaptive({ preference: 'quality', updateStreamQuality });
      await flush();
      const acknowledged = h.result.current.lastAck?.profile;
      expect(acknowledged?.maxBitrateBps).toBe(8_000_000);

      await reachAdaptiveDispatch(h);
      expect(updateStreamQuality).toHaveBeenCalledTimes(2);

      await act(async () => throwAuto(new Error('transport timeout')));
      expect(h.result.current.lastAck?.profile).toEqual(acknowledged);
      expect(h.result.current.failureMessage).toBe('transport timeout');
      expect(updateStreamQuality).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('sends only the latest manual intent when an adaptive candidate is in flight', async () => {
    vi.useFakeTimers();
    let resolveAuto!: (result: RemoteWindowStreamQualityResultPayload) => void;
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>()
      .mockImplementationOnce(async (_sessionId, payload) => appliedResult(payload))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveAuto = resolve;
      }))
      .mockImplementation(async (_sessionId, payload) => appliedResult(payload));
    const h = renderAdaptive({ preference: 'quality', updateStreamQuality });
    await flush();

    await reachAdaptiveDispatch(h);
    expect(updateStreamQuality).toHaveBeenCalledTimes(2);
    const autoPayload = updateStreamQuality.mock.calls[1][1];

    // Two manual intents queue behind the in-flight adaptive candidate; the
    // second overwrites the first (latest wins).
    h.rerender({ preference: 'quality', maxBitrateCapBps: 6_000_000, maxFrameRateFps: 30, streamId: 'stream' });
    h.rerender({ preference: 'quality', maxBitrateCapBps: 5_000_000, maxFrameRateFps: 30, streamId: 'stream' });
    expect(updateStreamQuality).toHaveBeenCalledTimes(2);

    // A new pressure sample must not let the adaptive path overwrite the
    // queued manual intent.
    h.enqueue(pressure(h.at()));
    await tick();
    expect(updateStreamQuality).toHaveBeenCalledTimes(2);

    // Settling the adaptive candidate releases the queued latest manual intent.
    await act(async () => resolveAuto(appliedResult(autoPayload)));
    await flush();
    expect(updateStreamQuality).toHaveBeenCalledTimes(3);
    const manualPayload = updateStreamQuality.mock.calls[2][1];
    expect(manualPayload.videoProfile.maxBitrateBps).toBe(5_000_000);
    // The superseded 6 Mbps manual intent was never sent; only the in-flight
    // adaptive candidate (call 2) ever carried 6 Mbps.
    expect(updateStreamQuality.mock.calls.slice(2).some(([, payload]) => payload.videoProfile.maxBitrateBps === 6_000_000)).toBe(false);
  });

  it('defers decisions for two fresh samples after a matching applied request', async () => {
    vi.useFakeTimers();
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(
      async (_sessionId, payload) => appliedResult(payload),
    );
    const h = renderAdaptive({ preference: 'quality', updateStreamQuality });
    await flush();

    await reachAdaptiveDispatch(h);
    expect(updateStreamQuality).toHaveBeenCalledTimes(2);
    await flush();

    // Two fresh pressure samples are consumed by skip=2 without a decision.
    h.enqueue(pressure(h.at()), pressure(h.at()));
    await tick();
    await tick();
    expect(updateStreamQuality).toHaveBeenCalledTimes(2);

    // The third resumes observation (baseline), the fourth downgrades again.
    h.enqueue(pressure(h.at()));
    await tick();
    expect(updateStreamQuality).toHaveBeenCalledTimes(2);
    h.enqueue(pressure(h.at()));
    await tick();
    expect(updateStreamQuality).toHaveBeenCalledTimes(3);
  });

  it('drops a stale stats read after a stream identity change', async () => {
    vi.useFakeTimers();
    const pending: Array<(value: RemoteWindowVideoStatsSample | null) => void> = [];
    const collectStats = vi.fn(() => new Promise<RemoteWindowVideoStatsSample | null>((resolve) => {
      pending.push(resolve);
    }));
    const updateStreamQuality = vi.fn<Parameters<RemoteWindowQualityUpdater>, ReturnType<RemoteWindowQualityUpdater>>(
      async (_sessionId, payload) => appliedResult(payload),
    );
    const { result, rerender } = renderQualityHook({ preference: 'quality', updateStreamQuality, collectStats });
    await flush();
    expect(pending).toHaveLength(1);

    rerender({ preference: 'quality', maxBitrateCapBps: null, maxFrameRateFps: 30, streamId: 'stream-2' });
    await flush();
    expect(pending).toHaveLength(2);

    // The first read belongs to the torn-down identity; resolving it must not
    // overwrite the current stream's observation.
    await act(async () => {
      pending[0](credible(999));
      await Promise.resolve();
    });
    expect(result.current.lastStatsSample).toBeNull();

    await act(async () => {
      pending[1](null);
      await Promise.resolve();
    });
  });
});
