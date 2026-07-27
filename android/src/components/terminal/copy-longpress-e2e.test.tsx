// @vitest-environment jsdom
/**
 * copy mode long-press 端到端测试
 * 模拟: touchstart → 420ms timer → onLongPressRow → copySelection.menu → TerminalPageCopyMenu render
 * 覆盖断点:
 *  1. touchstart handler fires (copyModeActive=true guard)
 *  2. 420ms timer fires
 *  3. onLongPressRow called with correct coords
 *  4. setCopySelection(menu={x,y,rowIndex}) executes
 *  5. TerminalPageCopyMenu renders with correct position
 */
import { act, fireEvent, render, screen, renderHook } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TerminalView } from '../TerminalView';
import { TerminalPageCopyMenu } from '../../pages/TerminalPageCopyMenu';
import { useTerminalPageCopyRuntime } from '../../pages/useTerminalPageCopyRuntime';

class ResizeObserverMock {
  static instances = new Set<ResizeObserverMock>();
  private callback: any;
  constructor(cb: any) { this.callback = cb; ResizeObserverMock.instances.add(this); }
  observe() {}
  unobserve() {}
  disconnect() { ResizeObserverMock.instances.delete(this); }
  trigger() { this.callback([], this); }
  static triggerAll() { for (const i of Array.from(ResizeObserverMock.instances)) i.trigger(); }
  static reset() { ResizeObserverMock.instances.clear(); }
}

beforeAll(() => {
  (globalThis as any).ResizeObserver = ResizeObserverMock as any;
  (Element.prototype as any).scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  ResizeObserverMock.reset();
});

const makeBuffer = () => ({
  startIndex: 0,
  lines: [
    [{ char: 65, fg: 256, bg: 256, flags: 0, width: 1 }],
    [{ char: 66, fg: 256, bg: 256, flags: 0, width: 1 }],
    [{ char: 67, fg: 256, bg: 256, flags: 0, width: 1 }],
  ],
});

describe('copy mode long-press e2e', () => {
  // ---断点1: copyModeActive guard---
  it('copyModeActive=false: onTouchStart does NOT start timer', () => {
    vi.useFakeTimers();
    const onLongPressRow = vi.fn();
    const { container } = render(
      <TerminalView
        sessionId="s1"
        active
        copyModeActive={false}
        renderBufferSnapshot={{
          lines: [[{ char: 65, fg: 256, bg: 256, flags: 0, width: 1 }]],
          gapRanges: [], startIndex: 0, endIndex: 1,
          bufferHeadStartIndex: 0, bufferTailEndIndex: 1,
          daemonHeadRevision: 1, daemonHeadEndIndex: 1,
          cols: 80, rows: 24, cursorKeysApp: false, cursor: null, revision: 1,
        }}
        onLongPressRow={onLongPressRow}
        live
        splitVisible={false}
        onInput={vi.fn()}
        fontSize={14}
      />,
    );

    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    expect(row).toBeTruthy();

    // Fire touchstart
    act(() => {
      fireEvent.touchStart(row, {
        touches: [{ clientX: 100, clientY: 200 }],
        changedTouches: [{ clientX: 100, clientY: 200 }],
      });
    });

    // Advance time — timer should NOT have started
    act(() => { vi.advanceTimersByTime(500); });

    expect(onLongPressRow).not.toHaveBeenCalled();
  });

  // ---断点2: copyModeActive=true, touchstart fires timer---
  it('copyModeActive=true: touchstart starts 420ms timer', () => {
    vi.useFakeTimers();
    const onLongPressRow = vi.fn();
    const { container } = render(
      <TerminalView
        sessionId="s1"
        active
        copyModeActive={true}
        renderBufferSnapshot={{
          lines: [[{ char: 65, fg: 256, bg: 256, flags: 0, width: 1 }]],
          gapRanges: [], startIndex: 0, endIndex: 1,
          bufferHeadStartIndex: 0, bufferTailEndIndex: 1,
          daemonHeadRevision: 1, daemonHeadEndIndex: 1,
          cols: 80, rows: 24, cursorKeysApp: false, cursor: null, revision: 1,
        }}
        onLongPressRow={onLongPressRow}
        live
        splitVisible={false}
        onInput={vi.fn()}
        fontSize={14}
      />,
    );

    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;

    act(() => {
      fireEvent.touchStart(row, {
        touches: [{ clientX: 100, clientY: 200 }],
        changedTouches: [{ clientX: 100, clientY: 200 }],
      });
    });

    // Advance to 419ms — should NOT fire
    act(() => { vi.advanceTimersByTime(419); });
    expect(onLongPressRow).not.toHaveBeenCalled();

    // Advance to 420ms — must fire
    act(() => { vi.advanceTimersByTime(1); });
    expect(onLongPressRow).toHaveBeenCalledTimes(1);
    expect(onLongPressRow).toHaveBeenCalledWith('s1', 0, 100, 200);
  });

  // ---断点3: touchmove cancels timer---
  it('touchmove after touchstart ( >10px ) cancels timer', () => {
    vi.useFakeTimers();
    const onLongPressRow = vi.fn();
    const { container } = render(
      <TerminalView
        sessionId="s1"
        active
        copyModeActive={true}
        renderBufferSnapshot={{
          lines: [[{ char: 65, fg: 256, bg: 256, flags: 0, width: 1 }]],
          gapRanges: [], startIndex: 0, endIndex: 1,
          bufferHeadStartIndex: 0, bufferTailEndIndex: 1,
          daemonHeadRevision: 1, daemonHeadEndIndex: 1,
          cols: 80, rows: 24, cursorKeysApp: false, cursor: null, revision: 1,
        }}
        onLongPressRow={onLongPressRow}
        live
        splitVisible={false}
        onInput={vi.fn()}
        fontSize={14}
      />,
    );

    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;

    act(() => {
      fireEvent.touchStart(row, {
        touches: [{ clientX: 100, clientY: 200 }],
        changedTouches: [{ clientX: 100, clientY: 200 }],
      });
    });

    // Move 20px — should cancel
    act(() => {
      fireEvent.touchMove(row, {
        touches: [{ clientX: 130, clientY: 200 }],
        changedTouches: [{ clientX: 130, clientY: 200 }],
      });
    });

    act(() => { vi.advanceTimersByTime(500); });
    expect(onLongPressRow).not.toHaveBeenCalled();
  });

  // ---断点4: handleLongPressCopyRow sets copySelection.menu---
  it('handleLongPressCopyRow sets copySelection.menu with correct position', () => {
    const keepTerminalInputFocused = vi.fn();
    const { result } = renderHook(() =>
      useTerminalPageCopyRuntime({
        uiSessionId: 's1',
        activeSessionId: 's1',
        splitVisible: false,
        findPaneForSession: () => null,
        onSwitchSession: vi.fn(),
        setActivePane: vi.fn(),
        keepTerminalInputFocused,
        sessionBufferStore: { getSnapshot: () => ({ buffer: makeBuffer() }) } as any,
      }),
    );

    // Enter copy mode
    act(() => { result.current.handleQuickBarToggleCopyMode(); });
    expect(result.current.copySelection.active).toBe(true);
    expect(result.current.copySelection.menu).toBeNull();

    // Simulate long-press at rowIndex=0, clientX=100, clientY=300
    act(() => { result.current.handleLongPressCopyRow('s1', 0, 100, 300); });

    expect(result.current.copySelection.menu).not.toBeNull();
    expect(result.current.copySelection.menu).toEqual({ x: 100, y: 300, rowIndex: 0 });
  });

  // ---断点5: copySelection.menu truth drives TerminalPageCopyMenu render---
  it('TerminalPageCopyMenu renders when menu is non-null', () => {
    const menu = { x: 100, y: 300, rowIndex: 0 };
    render(
      <TerminalPageCopyMenu
        menu={menu}
        viewportWidth={390}
        headerTopInsetPx={24}
        startRowIndex={null}
        onSetStart={vi.fn()}
        onSetEnd={vi.fn()}
        onCopy={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const menuEl = screen.getByTestId('terminal-copy-menu');
    expect(menuEl).toBeTruthy();
    // Check zIndex
    expect(menuEl.style.zIndex).toBe('30');
    // Check not display:none
    expect(menuEl.style.display).not.toBe('none');
  });

  // ---断点6: guard — handleLongPressCopyRow skips when active=false---
  it('handleLongPressCopyRow returns early when copySelection.active=false', () => {
    const keepTerminalInputFocused = vi.fn();
    const { result } = renderHook(() =>
      useTerminalPageCopyRuntime({
        uiSessionId: 's1',
        activeSessionId: 's1',
        splitVisible: false,
        findPaneForSession: () => null,
        onSwitchSession: vi.fn(),
        setActivePane: vi.fn(),
        keepTerminalInputFocused,
        sessionBufferStore: { getSnapshot: () => ({ buffer: makeBuffer() }) } as any,
      }),
    );

    // Copy mode NOT active
    expect(result.current.copySelection.active).toBe(false);

    act(() => { result.current.handleLongPressCopyRow('s1', 0, 100, 300); });

    expect(result.current.copySelection.menu).toBeNull();
  });

  // ---断点7: complete flow with renderHook (fake timers + copy runtime)---
  it('complete flow: touchstart → 420ms → copySelection.menu → menu visible', () => {
    vi.useFakeTimers();
    const keepTerminalInputFocused = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTerminalPageCopyRuntime({
        uiSessionId: 's1',
        activeSessionId: 's1',
        splitVisible: false,
        findPaneForSession: () => null,
        onSwitchSession: vi.fn(),
        setActivePane: vi.fn(),
        keepTerminalInputFocused,
        sessionBufferStore: { getSnapshot: () => ({ buffer: makeBuffer() }) } as any,
      }),
    );

    const renderBufferSnapshot = {
      lines: [[{ char: 65, fg: 256, bg: 256, flags: 0, width: 1 }]],
      gapRanges: [], startIndex: 0, endIndex: 1,
      bufferHeadStartIndex: 0, bufferTailEndIndex: 1,
      daemonHeadRevision: 1, daemonHeadEndIndex: 1,
      cols: 80, rows: 24, cursorKeysApp: false, cursor: null, revision: 1,
    };

    const { container, rerender } = render(
      <TerminalView
        sessionId="s1"
        active
        copyModeActive={result.current.copySelection.active}
        renderBufferSnapshot={renderBufferSnapshot}
        onLongPressRow={result.current.handleLongPressCopyRow}
        live
        splitVisible={false}
        onInput={vi.fn()}
        fontSize={14}
      />,
    );

    // Enter copy mode
    act(() => { result.current.handleQuickBarToggleCopyMode(); });
    rerender(
      <TerminalView
        sessionId="s1"
        active
        copyModeActive={result.current.copySelection.active}
        renderBufferSnapshot={renderBufferSnapshot}
        onLongPressRow={result.current.handleLongPressCopyRow}
        live
        splitVisible={false}
        onInput={vi.fn()}
        fontSize={14}
      />,
    );

    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    expect(row).toBeTruthy();

    // Touch start
    act(() => {
      fireEvent.touchStart(row, {
        touches: [{ clientX: 100, clientY: 300 }],
        changedTouches: [{ clientX: 100, clientY: 300 }],
      });
    });

    // 420ms pass
    act(() => { vi.advanceTimersByTime(420); });

    // Menu should be set
    expect(result.current.copySelection.menu).not.toBeNull();

    // Render menu
    const { container: menuContainer } = render(
      <TerminalPageCopyMenu
        menu={result.current.copySelection.menu!}
        viewportWidth={390}
        headerTopInsetPx={24}
        startRowIndex={null}
        onSetStart={vi.fn()}
        onSetEnd={vi.fn()}
        onCopy={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(menuContainer.querySelector('[data-testid="terminal-copy-menu"]')).toBeTruthy();

    unmount();
    vi.useRealTimers();
  });
});
