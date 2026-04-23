// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalQuickBar } from './TerminalQuickBar';

vi.mock('../../plugins/DeviceClipboardPlugin', () => ({
  DeviceClipboardPlugin: {
    readText: vi.fn().mockResolvedValue({ value: '' }),
  },
  isNativeClipboardSupported: () => false,
}));

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

describe('TerminalQuickBar', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = () => {};
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = () => {};
    }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderQuickBar(props?: Partial<React.ComponentProps<typeof TerminalQuickBar>>) {
    return render(
      <TerminalQuickBar
        activeSessionId="session-1"
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onSendSequence={vi.fn()}
        onSessionDraftChange={vi.fn()}
        onSessionDraftSend={vi.fn()}
        onQuickActionsChange={vi.fn()}
        onShortcutActionsChange={vi.fn()}
        onOpenScheduleComposer={vi.fn()}
        onMeasuredHeightChange={vi.fn()}
        {...props}
      />,
    );
  }

  it('closes floating quick input when clicking outside', async () => {
    renderQuickBar();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));
    expect(screen.getByText('快捷输入')).not.toBeNull();

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(screen.queryByText('快捷输入')).toBeNull();
    });
  });

  it('opens schedule composer from current draft text', async () => {
    const onSessionDraftChange = vi.fn();
    const onOpenScheduleComposer = vi.fn();

    renderQuickBar({
      sessionDraft: 'echo schedule me',
      onSessionDraftChange,
      onOpenScheduleComposer,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));
    fireEvent.click(screen.getByRole('button', { name: '定时' }));

    await waitFor(() => {
      expect(onOpenScheduleComposer).toHaveBeenCalledWith('echo schedule me');
    });
  });

  it('persists floating bubble position after drag', async () => {
    renderQuickBar();

    const bubble = screen.getByRole('button', { name: 'Toggle floating quick menu' });
    fireEvent.pointerDown(bubble, { pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 10 });
    fireEvent.pointerMove(bubble, { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 54 });
    fireEvent.pointerUp(bubble, { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 54 });

    await waitFor(() => {
      const raw = localStorage.getItem('zterm:floating-bubble-position');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw || '{}');
      expect(typeof parsed.x).toBe('number');
      expect(typeof parsed.y).toBe('number');
    });
  });

  it('rescues stored floating bubble position back into viewport on mount', async () => {
    localStorage.setItem(
      'zterm:floating-bubble-position',
      JSON.stringify({ x: 9999, y: 9999 }),
    );

    renderQuickBar();

    await waitFor(() => {
      const raw = localStorage.getItem('zterm:floating-bubble-position');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw || '{}');
      expect(parsed.x).toBeLessThan(window.innerWidth);
      expect(parsed.y).toBeLessThan(window.innerHeight);
    });
  });

  it('re-clamps floating bubble position after viewport resize', async () => {
    localStorage.setItem(
      'zterm:floating-bubble-position',
      JSON.stringify({ x: 500, y: 500 }),
    );
    renderQuickBar();

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 220,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 180,
    });

    fireEvent(window, new Event('resize'));

    await waitFor(() => {
      const raw = localStorage.getItem('zterm:floating-bubble-position');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw || '{}');
      expect(parsed.x).toBeLessThan(window.innerWidth);
      expect(parsed.y).toBeLessThan(window.innerHeight);
    });
  });

  it('hides shell quick rows while floating menu is open', async () => {
    renderQuickBar();

    expect(screen.getByRole('button', { name: '图' })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '图' })).toBeNull();
    });
  });

  it('restores shell quick rows after floating menu closes', async () => {
    renderQuickBar();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '图' })).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: '关闭快捷输入' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '图' })).not.toBeNull();
    });
  });

  it('lifts floating bubble above keyboard inset', async () => {
    renderQuickBar({
      keyboardVisible: true,
      keyboardInsetPx: 240,
    });

    const bubble = screen.getByRole('button', { name: 'Toggle floating quick menu' });
    const style = bubble.getAttribute('style') || '';
    expect(style).toContain('bottom: calc(312px');
  });

  it('reports DOM editor focus transitions for quick input textarea', async () => {
    const onEditorDomFocusChange = vi.fn();
    renderQuickBar({
      onEditorDomFocusChange,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));

    const textarea = screen.getByPlaceholderText('预输入内容，按 session 持久化');
    fireEvent.focus(textarea);
    fireEvent.blur(textarea);

    await waitFor(() => {
      expect(onEditorDomFocusChange).toHaveBeenCalledWith(true);
      expect(onEditorDomFocusChange).toHaveBeenLastCalledWith(false);
    });
  });

  it('sends floating quick action immediately with trailing enter', async () => {
    const onSendSequence = vi.fn();
    renderQuickBar({
      quickActions: [
        {
          id: 'qa-1',
          label: 'ls',
          sequence: 'ls -la',
          order: 0,
        },
      ],
      onSendSequence,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));
    const actionLabel = screen.getByText('ls');
    const actionButton = actionLabel.closest('button');
    expect(actionButton).not.toBeNull();
    fireEvent.click(actionButton as HTMLButtonElement);

    await waitFor(() => {
      expect(onSendSequence).toHaveBeenCalledWith('ls -la\r');
    });
  });

  it('uses combo preview as default shortcut label when saving ctrl combination', async () => {
    const onShortcutActionsChange = vi.fn();

    renderQuickBar({
      onShortcutActionsChange,
    });

    fireEvent.click(screen.getAllByRole('button', { name: '+' })[0]);
    expect(screen.getByText('快捷按键设置')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
    fireEvent.change(screen.getByPlaceholderText('输入字母/数字/符号'), {
      target: { value: 'c' },
    });
    fireEvent.click(screen.getByRole('button', { name: '加入' }));
    fireEvent.click(screen.getByRole('button', { name: '添加快捷按键' }));

    await waitFor(() => {
      expect(onShortcutActionsChange).toHaveBeenCalled();
      const calls = onShortcutActionsChange.mock.calls;
      const latest = calls[calls.length - 1]?.[0];
      expect(Array.isArray(latest)).toBe(true);
      expect(latest[latest.length - 1]?.label).toBe('Ctrl + C');
    });
  });

  it('starts repeat mode on long press and stops on next short tap', async () => {
    vi.useFakeTimers();
    const onSendSequence = vi.fn();

    renderQuickBar({
      onSendSequence,
    });

    const enterButton = screen.getByRole('button', { name: 'Enter' });

    fireEvent.pointerDown(enterButton, { pointerId: 1, pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(720);
    });

    expect(onSendSequence.mock.calls.length).toBeGreaterThan(2);
    expect(enterButton.getAttribute('aria-pressed')).toBe('true');

    const callCountBeforeStop = onSendSequence.mock.calls.length;
    fireEvent.click(enterButton);

    act(() => {
      vi.advanceTimersByTime(240);
    });

    expect(enterButton.getAttribute('aria-pressed')).toBe('false');
    expect(onSendSequence).toHaveBeenCalledTimes(callCountBeforeStop);
    vi.useRealTimers();
  });
});
