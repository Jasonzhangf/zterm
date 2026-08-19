// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import type { RemoteWindowDualStreamState } from '../../lib/remote-window-dual-stream-runtime';
import { useRemoteWindowFocusSwitch } from './useRemoteWindowFocusSwitch';

afterEach(cleanup);

const target = {
  streamTargetId: 'target',
  videoTarget: { windowId: 'window' },
} as RemoteWindowStreamTargetManifest;

const initialState: RemoteWindowDualStreamState = {
  phase: 'focus-committed',
  revision: 0,
  activeTargetId: null,
  pendingTargetId: null,
  focusStreamId: null,
  overviewCropTargetId: null,
  error: null,
};

describe('useRemoteWindowFocusSwitch owner', () => {
  it('starts one revisioned focus transaction and dispatches the typed intent', () => {
    const updateFocus = vi.fn();
    const activeStreamIdRef = { current: 'stream' };
    const activeFocusStreamIdRef = { current: 'focus-stream' };
    const { result } = renderHook(() => {
      const [dualStreamState, setDualStreamState] = useState(initialState);
      const [focusedWindowId, setFocusedWindowId] = useState<string | null>(null);
      const switchFocus = useRemoteWindowFocusSwitch({
        activeSessionId: 'session',
        activeStreamIdRef,
        activeFocusStreamIdRef,
        dualStreamState,
        setDualStreamState,
        setFocusedWindowId,
        updateFocus,
      });
      return { dualStreamState, focusedWindowId, switchFocus };
    });
    act(() => result.current.switchFocus({ target, targetId: 'target', windowId: 'window' }));
    expect(result.current.focusedWindowId).toBe('window');
    expect(result.current.dualStreamState).toMatchObject({
      phase: 'overview-crop-visible',
      revision: 1,
      pendingTargetId: 'target',
      focusStreamId: 'focus-stream',
    });
    expect(updateFocus).toHaveBeenCalledWith('session', 'focus-stream', target, 1);
  });

  it('fails explicitly when the catalog target is missing', () => {
    const activeStreamIdRef = { current: 'stream' };
    const activeFocusStreamIdRef = { current: null };
    const { result } = renderHook(() => {
      const [dualStreamState, setDualStreamState] = useState(initialState);
      const [, setFocusedWindowId] = useState<string | null>(null);
      const switchFocus = useRemoteWindowFocusSwitch({
        activeSessionId: 'session',
        activeStreamIdRef,
        activeFocusStreamIdRef,
        dualStreamState,
        setDualStreamState,
        setFocusedWindowId,
        updateFocus: vi.fn(),
      });
      return { dualStreamState, switchFocus };
    });
    act(() => result.current.switchFocus({ target: null, targetId: 'missing', windowId: 'missing-window' }));
    expect(result.current.dualStreamState).toMatchObject({
      phase: 'error',
      error: {
        code: 'focus-update-error',
        message: 'Remote window focus switch target is missing from the catalog',
      },
    });
  });
});
