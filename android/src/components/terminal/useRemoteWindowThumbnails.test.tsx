// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import { useRemoteWindowThumbnails } from './useRemoteWindowThumbnails';

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

const active = target('active');
const sibling = target('sibling');
const group = {
  groupId: 'app:com.example.app',
  appBundleId: 'com.example.app',
  pid: 42,
  title: 'Example',
  targets: [active, sibling],
};

describe('useRemoteWindowThumbnails owner', () => {
  it('publishes a ready sibling snapshot only for the matching request identity', async () => {
    const requestScreenshot = vi.fn(async () => ({
      fileName: 'sibling.png',
      savedPath: '/tmp/sibling.png',
      dataUrl: 'data:image/png;base64,ok',
    }));
    const { result } = renderHook(() => useRemoteWindowThumbnails({
      activeSessionId: 'session-1',
      activeTargetId: active.streamTargetId,
      lockedAppWindowGroup: group,
      requestScreenshot,
    }));

    await waitFor(() => expect(result.current.windowThumbnails[sibling.streamTargetId]?.phase).toBe('ready'));
    expect(requestScreenshot).toHaveBeenCalledWith('session-1', sibling, { persist: false });
  });

  it('clears snapshots and ignores a completion after reset', async () => {
    let resolveRequest: ((value: { fileName: string; savedPath: string; dataUrl: string }) => void) | null = null;
    const requestScreenshot = vi.fn(() => new Promise<{ fileName: string; savedPath: string; dataUrl: string }>((resolve) => {
      resolveRequest = resolve;
    }));
    const { result } = renderHook(() => useRemoteWindowThumbnails({
      activeSessionId: 'session-1',
      activeTargetId: active.streamTargetId,
      lockedAppWindowGroup: group,
      requestScreenshot,
    }));

    await waitFor(() => expect(result.current.windowThumbnails[sibling.streamTargetId]?.phase).toBe('loading'));
    act(() => result.current.resetWindowThumbnails());
    await act(async () => resolveRequest?.({
      fileName: 'late.png',
      savedPath: '/tmp/late.png',
      dataUrl: 'data:image/png;base64,late',
    }));
    expect(result.current.windowThumbnails).toEqual({});
  });
});
