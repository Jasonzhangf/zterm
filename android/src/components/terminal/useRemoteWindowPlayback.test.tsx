// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRemoteWindowPlayback } from './useRemoteWindowPlayback';

afterEach(cleanup);

function stream(id: string): MediaStream {
  return { id, getTracks: () => [] } as unknown as MediaStream;
}

describe('useRemoteWindowPlayback owner', () => {
  it('rejects a late frame reveal from the previous receiver epoch', async () => {
    const video = document.createElement('video') as HTMLVideoElement & {
      requestVideoFrameCallback: (callback: () => void) => number;
    };
    const frameCallbacks: Array<() => void> = [];
    video.requestVideoFrameCallback = vi.fn((callback: () => void) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    video.play = vi.fn(() => new Promise<void>(() => {}));
    const first = stream('first');
    const second = stream('second');
    const videoElementRef = { current: video };
    const overviewVideoElementRef = { current: null };
    const { result, rerender } = renderHook(
      ({ receiverMediaStream }) => useRemoteWindowPlayback({
        receiverMediaStream,
        overviewMediaStream: null,
        streamStatus: 'streaming',
        streamId: receiverMediaStream.id,
        videoElementRef,
        overviewVideoElementRef,
      }),
      { initialProps: { receiverMediaStream: first } },
    );

    await waitFor(() => expect(frameCallbacks.length).toBeGreaterThan(0));
    const staleReveal = frameCallbacks[1];
    rerender({ receiverMediaStream: second });
    await waitFor(() => expect(video.srcObject).toBe(second));
    const currentReveal = frameCallbacks[frameCallbacks.length - 1];
    act(() => staleReveal());
    expect(result.current.videoHasPlayed).toBe(false);
    act(() => currentReveal());
    expect(result.current.videoHasPlayed).toBe(true);
  });

  it('keeps visibility false when playback is explicitly invalidated', () => {
    const videoElementRef = { current: null };
    const overviewVideoElementRef = { current: null };
    const { result } = renderHook(() => useRemoteWindowPlayback({
      receiverMediaStream: null,
      overviewMediaStream: null,
      streamStatus: null,
      streamId: null,
      videoElementRef,
      overviewVideoElementRef,
    }));
    act(() => {
      result.current.updateVisibility(true);
      result.current.invalidatePlayback();
      result.current.updateVisibility(false);
    });
    expect(result.current.videoHasPlayed).toBe(false);
  });
});
