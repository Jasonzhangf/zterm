// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import type { RemoteWindowScreenshotSaveResult } from './useRemoteWindowThumbnails';
import { useRemoteWindowScreenshot } from './useRemoteWindowScreenshot';

afterEach(cleanup);

function target(id: string): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: id,
    videoTarget: {
      kind: 'app-window',
      appBundleId: 'com.example.app',
      pid: 42,
      windowId: id,
      title: id,
      windowBoundsTopLeftPx: { x: 0, y: 0, width: 800, height: 600 },
    },
    inputTarget: { kind: 'app-window' },
    streamMode: 'interactive',
    focusPolicy: 'bring-to-focus',
    inputRoute: 'os-event',
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: '2026-08-19T00:00:00.000Z',
    },
  };
}

describe('useRemoteWindowScreenshot owner', () => {
  it('stays idle before any capture and exposes a null feedback', () => {
    const requestScreenshot = vi.fn();
    const { result } = renderHook(() =>
      useRemoteWindowScreenshot({ activeSessionId: 'session', requestScreenshot }),
    );
    expect(result.current.status).toEqual({ phase: 'idle' });
    expect(result.current.busy).toBe(false);
    expect(result.current.feedback).toBeNull();
  });

  it('drives capturing → saved when requestScreenshot resolves', async () => {
    const saveResult: RemoteWindowScreenshotSaveResult = {
      fileName: 'shot.png',
      savedPath: '/tmp/shot.png',
    };
    const requestScreenshot = vi.fn<
      Parameters<NonNullable<Parameters<typeof useRemoteWindowScreenshot>[0]['requestScreenshot']>>,
      ReturnType<NonNullable<Parameters<typeof useRemoteWindowScreenshot>[0]['requestScreenshot']>>
    >().mockResolvedValue(saveResult);

    const { result } = renderHook(() =>
      useRemoteWindowScreenshot({ activeSessionId: 'session', requestScreenshot }),
    );

    await act(async () => {
      await result.current.capture(target('app'));
    });

    expect(requestScreenshot).toHaveBeenCalledTimes(1);
    expect(requestScreenshot.mock.calls[0][0]).toBe('session');
    expect(requestScreenshot.mock.calls[0][2]).toEqual({ persist: true });
    expect(result.current.status).toEqual({
      phase: 'saved',
      fileName: 'shot.png',
      savedPath: '/tmp/shot.png',
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.feedback).toMatchObject({ phase: 'saved', tone: 'success' });
  });

  it('publishes capturing feedback while requestScreenshot is in flight', async () => {
    let resolveSave!: (value: RemoteWindowScreenshotSaveResult) => void;
    const requestScreenshot = vi.fn().mockImplementation(
      () => new Promise<RemoteWindowScreenshotSaveResult>((resolve) => {
        resolveSave = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useRemoteWindowScreenshot({ activeSessionId: 'session', requestScreenshot }),
    );

    let capturePromise!: Promise<void>;
    act(() => {
      capturePromise = result.current.capture(target('app'));
    });

    await waitFor(() => expect(result.current.status.phase).toBe('capturing'));
    expect(result.current.busy).toBe(true);
    expect(result.current.feedback).toMatchObject({ phase: 'capturing', tone: 'progress' });

    await act(async () => {
      resolveSave({ fileName: 'shot.png', savedPath: '/tmp/shot.png' });
      await capturePromise;
    });
    expect(result.current.status.phase).toBe('saved');
  });

  it('projects rejection into a failed phase without throwing', async () => {
    const requestScreenshot = vi.fn().mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() =>
      useRemoteWindowScreenshot({ activeSessionId: 'session', requestScreenshot }),
    );

    await act(async () => {
      await result.current.capture(target('app'));
    });

    expect(result.current.status).toEqual({ phase: 'failed', message: 'boom' });
    expect(result.current.feedback).toMatchObject({ phase: 'failed', tone: 'error' });
    expect(result.current.busy).toBe(false);
  });

  it('refuses to send when no active session or no request channel is available', async () => {
    const requestScreenshot = vi.fn();
    const { result } = renderHook(() =>
      useRemoteWindowScreenshot({ activeSessionId: null, requestScreenshot }),
    );

    await act(async () => {
      await result.current.capture(target('app'));
    });

    expect(requestScreenshot).not.toHaveBeenCalled();
    expect(result.current.status).toEqual({
      phase: 'failed',
      message: '当前没有可用的截图通道',
    });
  });

  it('reset() clears any terminal status back to idle', async () => {
    const requestScreenshot = vi.fn().mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() =>
      useRemoteWindowScreenshot({ activeSessionId: 'session', requestScreenshot }),
    );

    await act(async () => {
      await result.current.capture(target('app'));
    });
    expect(result.current.status.phase).toBe('failed');

    act(() => result.current.reset());
    expect(result.current.status).toEqual({ phase: 'idle' });
    expect(result.current.feedback).toBeNull();
  });
});
