// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTerminalPageCopyRuntime } from './useTerminalPageCopyRuntime';

const { nativeClipboardWriteText } = vi.hoisted(() => ({
  nativeClipboardWriteText: vi.fn(async () => undefined),
}));

vi.mock('../plugins/DeviceClipboardPlugin', () => ({
  isNativeClipboardSupported: () => true,
  DeviceClipboardPlugin: {
    writeText: nativeClipboardWriteText,
  },
}));

afterEach(() => {
  nativeClipboardWriteText.mockClear();
});

const makeBuffer = () => ({
  startIndex: 100,
  lines: [
    [{ char: 120, width: 1 }],
    [{ char: 121, width: 1 }],
    [{ char: 122, width: 1 }],
  ],
});

describe('useTerminalPageCopyRuntime', () => {
  it('toggles copy mode and records start/end rows', async () => {
    const keepTerminalInputFocused = vi.fn();
    const buffer = makeBuffer();
    const { result } = renderHook(() =>
      useTerminalPageCopyRuntime({
        uiSessionId: 's1',
        activeSessionId: 's1',
        splitVisible: false,
        findPaneForSession: () => null,
        onSwitchSession: vi.fn(),
        setActivePane: vi.fn(),
        keepTerminalInputFocused,
        sessionBufferStore: { getSnapshot: () => ({ buffer }) } as any,
        sessions: [{ id: 's1', buffer: null } as any],
      }),
    );

    act(() => result.current.handleQuickBarToggleCopyMode());
    expect(result.current.copySelection.active).toBe(true);

    act(() => result.current.handleLongPressCopyRow('s1', 100, 1, 2));
    act(() => result.current.handleCopySelectionStart());
    expect(result.current.copySelection.startRowIndex).toBe(100);

    act(() => result.current.handleLongPressCopyRow('s1', 102, 3, 4));
    act(() => result.current.handleCopySelectionEnd());

    expect(result.current.copySelection.endRowIndex).toBe(102);
    expect(nativeClipboardWriteText).toHaveBeenCalledWith({ value: 'x\ny\nz' });
    expect(keepTerminalInputFocused).toHaveBeenCalled();
  });

  it('resets selection when active session changes away from owned session', () => {
    const { result, rerender } = renderHook(
      ({ uiSessionId }) =>
        useTerminalPageCopyRuntime({
          uiSessionId,
          activeSessionId: 's1',
          splitVisible: false,
          findPaneForSession: () => null,
          onSwitchSession: vi.fn(),
          setActivePane: vi.fn(),
          keepTerminalInputFocused: vi.fn(),
          sessionBufferStore: { getSnapshot: () => ({ buffer: makeBuffer() }) } as any,
          sessions: [{ id: 's1', buffer: null } as any],
        }),
      { initialProps: { uiSessionId: 's1' as string | null } },
    );

    act(() => result.current.handleQuickBarToggleCopyMode());
    act(() => result.current.handleLongPressCopyRow('s1', 100, 1, 2));
    act(() => result.current.handleCopySelectionStart());
    expect(result.current.copySelection.startRowIndex).toBe(100);

    rerender({ uiSessionId: 's2' });
    expect(result.current.copySelection.active).toBe(false);
    expect(result.current.copySelection.startRowIndex).toBeNull();
  });
});
