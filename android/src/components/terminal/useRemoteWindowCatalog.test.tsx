// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import { initialRemoteWindowOverlayState } from '../../lib/remote-window-overlay-runtime';
import { useRemoteWindowCatalog } from './useRemoteWindowCatalog';

afterEach(cleanup);

const target: RemoteWindowStreamTargetManifest = {
  streamTargetId: 'target',
  videoTarget: {
    kind: 'app-window',
    appBundleId: 'com.example.app',
    pid: 42,
    windowId: 'window',
    title: 'Example',
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

describe('useRemoteWindowCatalog owner', () => {
  it('projects a fresh catalog and reuses its cache without another request', async () => {
    const requestTargets = vi.fn().mockResolvedValue({ requestId: 'catalog-1', targets: [target] });
    const onOpenPicker = vi.fn();
    const { result } = renderHook(() => {
      const [state, setState] = useState(initialRemoteWindowOverlayState);
      const catalog = useRemoteWindowCatalog({
        activeSessionId: 'session',
        state,
        setState,
        requestTargets,
        activeStreamReady: false,
        suspendActiveRefresh: false,
        onOpenPicker,
      });
      return { state, ...catalog };
    });

    act(() => result.current.openPicker());
    await waitFor(() => expect(result.current.state.phase).toBe('pickerOpen'));
    expect(result.current.state).toMatchObject({ targets: [target] });
    expect(requestTargets).toHaveBeenCalledTimes(1);
    act(() => result.current.openPicker());
    await waitFor(() => expect(result.current.state.phase).toBe('pickerOpen'));
    expect(requestTargets).toHaveBeenCalledTimes(1);
    expect(onOpenPicker).toHaveBeenCalledTimes(2);
  });

  it('fails explicitly when no daemon session can own enumeration', async () => {
    const { result } = renderHook(() => {
      const [state, setState] = useState(initialRemoteWindowOverlayState);
      return {
        state,
        ...useRemoteWindowCatalog({
          activeSessionId: null,
          state,
          setState,
          activeStreamReady: false,
          suspendActiveRefresh: false,
          onOpenPicker: vi.fn(),
        }),
      };
    });
    act(() => result.current.openPicker());
    await waitFor(() => expect(result.current.state.phase).toBe('pickerOpen'));
    expect(result.current.state).toMatchObject({ errorMessage: '当前没有可用的 daemon session' });
  });
});
