// @vitest-environment jsdom
import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const warnSpy = vi.fn();

beforeEach(() => {
  warnSpy.mockClear();
  vi.spyOn(console, "warn").mockImplementation((...args) => warnSpy(...args));
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it('warns and preserves copySelection when buffer does not cover selected rows on handleCopySelectedText', () => {
    const keepTerminalInputFocused = vi.fn();
    const buffer = makeBuffer(); // startIndex 100, 3 lines covers rows 100-102
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
    // Set start row outside buffer range
    act(() => result.current.handleLongPressCopyRow('s1', 200, 1, 2));
    act(() => result.current.handleCopySelectionStart());
    expect(result.current.copySelection.startRowIndex).toBe(200);

    act(() => result.current.handleCopySelectedText());

    // No clipboard write should occur
    expect(nativeClipboardWriteText).not.toHaveBeenCalled();
    // Warn should be emitted
    expect(warnSpy).toHaveBeenCalled();
    const warnArg = String(warnSpy.mock.calls[0]?.join(' ') ?? '');
    expect(warnArg).toContain('buffer does not cover rows');
    expect(warnArg).toContain('session=s1');
    // copySelection state must be preserved (not cleared)
    expect(result.current.copySelection.active).toBe(true);
    expect(result.current.copySelection.startRowIndex).toBe(200);
    expect(keepTerminalInputFocused).not.toHaveBeenCalled();
  });

  it('warns and preserves copySelection when buffer does not cover selected rows on handleCopySelectionEnd', () => {
    const keepTerminalInputFocused = vi.fn();
    const buffer = makeBuffer(); // startIndex 100, 3 lines covers rows 100-102
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
    // Set start row outside buffer range
    act(() => result.current.handleLongPressCopyRow('s1', 200, 1, 2));
    act(() => result.current.handleCopySelectionStart());
    expect(result.current.copySelection.startRowIndex).toBe(200);

    // Long-press a second row (also outside buffer range) to open menu, then set end
    act(() => result.current.handleLongPressCopyRow('s1', 210, 3, 4));
    act(() => result.current.handleCopySelectionEnd());

    expect(result.current.copySelection.endRowIndex).toBe(210);
    // No clipboard write should occur
    expect(nativeClipboardWriteText).not.toHaveBeenCalled();
    // Warn should be emitted
    expect(warnSpy).toHaveBeenCalled();
    const warnArg = String(warnSpy.mock.calls[0]?.join(' ') ?? '');
    expect(warnArg).toContain('buffer does not cover rows');
    expect(warnArg).toContain('session=s1');
    // copySelection state must be preserved
    expect(result.current.copySelection.active).toBe(true);
    expect(result.current.copySelection.startRowIndex).toBe(200);
    expect(keepTerminalInputFocused).toHaveBeenCalled(); // keepTerminalInputFocused called even on miss
  });

  // --- Lifecycle regression: handleCloseCopyMenu fully exits copy mode ---
  it('handleCloseCopyMenu resets all copy state (active=false, highlight gone)', () => {
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

    // Enter copy mode
    act(() => result.current.handleQuickBarToggleCopyMode());
    expect(result.current.copySelection.active).toBe(true);

    // Long-press to show menu
    act(() => result.current.handleLongPressCopyRow('s1', 100, 10, 20));
    expect(result.current.copySelection.menu).not.toBeNull();

    // Close menu — should fully exit copy mode
    act(() => result.current.handleCloseCopyMenu());

    expect(result.current.copySelection.active).toBe(false);
    expect(result.current.copySelection.menu).toBeNull();
    expect(result.current.copySelection.startRowIndex).toBeNull();
    expect(result.current.copySelection.endRowIndex).toBeNull();
    expect(result.current.copySelection.sessionId).toBeNull();
    expect(keepTerminalInputFocused).toHaveBeenCalled();
  });

  it('handleCloseCopyMenu from mid-selection resets all copy state', () => {
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
    act(() => result.current.handleLongPressCopyRow('s1', 100, 1, 2));
    act(() => result.current.handleCopySelectionStart());
    // startRowIndex set, menu gone
    expect(result.current.copySelection.startRowIndex).toBe(100);
    expect(result.current.copySelection.menu).toBeNull();

    // Close from mid-selection
    act(() => result.current.handleCloseCopyMenu());

    expect(result.current.copySelection.active).toBe(false);
    expect(result.current.copySelection.startRowIndex).toBeNull();
    expect(result.current.copySelection.endRowIndex).toBeNull();
    expect(keepTerminalInputFocused).toHaveBeenCalled();
  });

  // --- Lifecycle: successful copy exits copy mode ---
  it('handleCopySelectionEnd resets copy mode on successful clipboard write', async () => {
    const keepTerminalInputFocused = vi.fn();
    const buffer = makeBuffer();
    nativeClipboardWriteText.mockResolvedValue(undefined);
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
    act(() => result.current.handleLongPressCopyRow('s1', 100, 1, 2));
    act(() => result.current.handleCopySelectionStart());
    act(() => result.current.handleLongPressCopyRow('s1', 102, 3, 4));
    act(() => result.current.handleCopySelectionEnd());

    // clipboard write dispatched
    expect(nativeClipboardWriteText).toHaveBeenCalledWith({ value: 'x\ny\nz' });

    // await async reset
    await waitFor(() => {
      expect(result.current.copySelection.active).toBe(false);
    });
    expect(result.current.copySelection.startRowIndex).toBeNull();
    expect(result.current.copySelection.endRowIndex).toBeNull();
    expect(keepTerminalInputFocused).toHaveBeenCalled();
  });

  it('handleCopySelectedText resets copy mode on successful clipboard write', async () => {
    const keepTerminalInputFocused = vi.fn();
    const buffer = makeBuffer();
    nativeClipboardWriteText.mockResolvedValue(undefined);
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
    act(() => result.current.handleLongPressCopyRow('s1', 100, 1, 2));
    act(() => result.current.handleCopySelectionStart());
    act(() => result.current.handleCopySelectedText());

    expect(nativeClipboardWriteText).toHaveBeenCalledWith({ value: 'x' });

    await waitFor(() => {
      expect(result.current.copySelection.active).toBe(false);
    });
    expect(result.current.copySelection.startRowIndex).toBeNull();
    expect(keepTerminalInputFocused).toHaveBeenCalled();
  });

  // --- Lifecycle: clipboard write failure preserves state ---
  it('handleCopySelectionEnd preserves copy mode when clipboard write fails', async () => {
    const keepTerminalInputFocused = vi.fn();
    const buffer = makeBuffer();
    nativeClipboardWriteText.mockRejectedValue(new Error('clipboard unavailable'));
    const warnSpy = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation((...args) => warnSpy(...args));

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
    act(() => result.current.handleLongPressCopyRow('s1', 100, 1, 2));
    act(() => result.current.handleCopySelectionStart());
    act(() => result.current.handleLongPressCopyRow('s1', 102, 3, 4));
    act(() => result.current.handleCopySelectionEnd());

    expect(nativeClipboardWriteText).toHaveBeenCalled();

    // State preserved after failure
    await waitFor(() => {
      expect(result.current.copySelection.active).toBe(true);
    });
    expect(result.current.copySelection.startRowIndex).toBe(100);
    expect(result.current.copySelection.endRowIndex).toBe(102);
    expect(warnSpy).toHaveBeenCalled();
    expect(keepTerminalInputFocused).toHaveBeenCalled();
  });

  it('handleCopySelectedText preserves copy mode when clipboard write fails', async () => {
    const keepTerminalInputFocused = vi.fn();
    const buffer = makeBuffer();
    nativeClipboardWriteText.mockRejectedValue(new Error('clipboard unavailable'));
    const warnSpy = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation((...args) => warnSpy(...args));

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
    act(() => result.current.handleLongPressCopyRow('s1', 100, 1, 2));
    act(() => result.current.handleCopySelectionStart());
    act(() => result.current.handleCopySelectedText());

    expect(nativeClipboardWriteText).toHaveBeenCalled();

    await waitFor(() => {
      expect(result.current.copySelection.active).toBe(true);
    });
    expect(result.current.copySelection.startRowIndex).toBe(100);
    expect(warnSpy).toHaveBeenCalled();
    expect(keepTerminalInputFocused).toHaveBeenCalled();
  });
});
