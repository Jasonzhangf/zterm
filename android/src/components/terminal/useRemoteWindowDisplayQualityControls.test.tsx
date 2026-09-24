// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useRemoteWindowDisplayQualityControls } from './useRemoteWindowDisplayQualityControls';
import { REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY } from './remote-window-overlay-storage';

describe('useRemoteWindowDisplayQualityControls', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('reports the derived budget multiplier in the same commit as the selection change', () => {
    const { result } = renderHook(() => useRemoteWindowDisplayQualityControls());
    expect(result.current.budgetMultiplier).toBeUndefined();

    act(() => {
      result.current.setBitrateMultiplierSelection(4);
    });
    // Same commit: a ref synced after render would still report the stale value.
    expect(result.current.bitrateMultiplierSelection).toBe(4);
    expect(result.current.budgetMultiplier).toBe(4);

    act(() => {
      result.current.setBitrateMultiplierSelection('auto');
    });
    expect(result.current.budgetMultiplier).toBeUndefined();
  });

  it('persists every selection change and keeps the derived value authoritative', () => {
    const { result } = renderHook(() => useRemoteWindowDisplayQualityControls());
    act(() => {
      result.current.setBitrateMultiplierSelection(2);
    });
    expect(window.localStorage.getItem(REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY)).toBe('2');
    expect(result.current.budgetMultiplier).toBe(2);
  });
});
