// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteWindowQuickBar } from './TerminalQuickBar';

describe('RemoteWindowQuickBar', () => {
  afterEach(() => cleanup());
  it('only exposes remote-window input actions and sends them immediately', () => {
    const onSendSequence = vi.fn();
    const onSendRemoteKeyboardInput = vi.fn();
    const onSessionDraftSend = vi.fn();
    const onToggleKeyboard = vi.fn();
    render(
      <RemoteWindowQuickBar
        onSendSequence={onSendSequence}
        onSendRemoteKeyboardInput={onSendRemoteKeyboardInput}
        onSessionDraftSend={onSessionDraftSend}
        onToggleKeyboard={onToggleKeyboard}
      />,
    );

    expect(screen.getByTestId('remote-window-quickbar')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /分屏|复制模式|文件|调试|行号/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '粘贴' }));
    expect(onSendRemoteKeyboardInput).toHaveBeenCalledWith({ key: 'v', code: 'KeyV', metaKey: true });
    fireEvent.click(screen.getByRole('button', { name: '↑' }));
    expect(onSendSequence).toHaveBeenCalledWith('\u001b[A');
    fireEvent.click(screen.getByRole('button', { name: '显示键盘' }));
    expect(onToggleKeyboard).toHaveBeenCalledTimes(1);
  });

  it('keeps draft and collapsed state local to the remote bar', () => {
    const onSessionDraftSend = vi.fn();
    render(<RemoteWindowQuickBar onSessionDraftSend={onSessionDraftSend} />);
    fireEvent.change(screen.getByRole('textbox', { name: '发送到串流窗口' }), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '发送文本' }));
    expect(onSessionDraftSend).toHaveBeenCalledWith('hello');
    fireEvent.click(screen.getByRole('button', { name: '收起串流快捷栏' }));
    expect(screen.getByTestId('remote-window-quickbar-collapsed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开串流快捷栏' }));
    expect(screen.getByRole('textbox', { name: '发送到串流窗口' })).toHaveProperty('value', '');
  });
});
