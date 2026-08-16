// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createSessionViewportModeStore } from '../lib/session-viewport-mode-store';
import { useTerminalPageShellActionsRuntime } from './useTerminalPageShellActionsRuntime';

describe('useTerminalPageShellActionsRuntime', () => {
  it('keeps tab manager scope and re-routes quick picker through the scoped pane', () => {
    const activatePaneAndSession = vi.fn();
    const onOpenQuickTabPicker = vi.fn();
    const onOpenTabManagerOpenStateChange = vi.fn();

    const { result } = renderHook(() => useTerminalPageShellActionsRuntime({
      activatePaneAndSession,
      onOpenQuickTabPicker,
      onOpenTabManagerOpenStateChange,
      sessionViewportModeStore: createSessionViewportModeStore(),
    }));

    act(() => {
      result.current.handleOpenTabManager('pane-2');
    });

    expect(result.current.tabManagerScopePaneId).toBe('pane-2');
    expect(result.current.tabManagerOpen).toBe(true);
    expect(activatePaneAndSession).toHaveBeenCalledWith('pane-2');
    expect(onOpenTabManagerOpenStateChange).toHaveBeenCalledWith(true);

    act(() => {
      result.current.handleOpenQuickTabPickerFromTabManager();
    });

    expect(result.current.tabManagerScopePaneId).toBeNull();
    expect(result.current.tabManagerOpen).toBe(false);
    expect(onOpenQuickTabPicker).toHaveBeenCalledWith('pane-2');
    expect(onOpenTabManagerOpenStateChange).toHaveBeenLastCalledWith(false);
  });

  it('updates viewport mode store before forwarding viewport change to the outer owner', () => {
    const sessionViewportModeStore = createSessionViewportModeStore();
    const onTerminalViewportChange = vi.fn();

    const { result } = renderHook(() => useTerminalPageShellActionsRuntime({
      activatePaneAndSession: vi.fn(),
      onOpenQuickTabPicker: vi.fn(),
      onTerminalViewportChange,
      sessionViewportModeStore,
    }));

    act(() => {
      result.current.handleTerminalViewportChange('session-1', {
        mode: 'reading',
        viewportEndIndex: 120,
        viewportRows: 24,
      });
    });

    expect(sessionViewportModeStore.getSnapshot('session-1').mode).toBe('reading');
    expect(onTerminalViewportChange).toHaveBeenCalledWith('session-1', {
      mode: 'reading',
      viewportEndIndex: 120,
      viewportRows: 24,
    });
  });
});
