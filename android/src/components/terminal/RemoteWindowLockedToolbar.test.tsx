// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RemoteWindowLockedToolbar } from './RemoteWindowLockedToolbar';

function renderToolbar(mode: 'floating' | 'fullscreen') {
  return render(
    <RemoteWindowLockedToolbar
      activeTitle="TextEdit"
      appSwitchContent={null}
      appSwitchOpen={false}
      dragHandleProps={{}}
      gestureGuide={mode === 'floating' ? '触控：拖动滚动，双指滚动或缩放' : ''}
      inputMode="touch"
      inputSupported
      mode={mode}
      moreContent={null}
      moreOpen={false}
      screenshotBusy={false}
      screenshotButtonStyle={{}}
      streamStatusText="串流：已连接 · 2.5 Mbps / 45 FPS"
      targetKindLabel="App"
      onClose={vi.fn()}
      onRemoteClose={vi.fn()}
      onFullscreen={vi.fn()}
      onRequestKeyboard={vi.fn()}
      onScreenshot={vi.fn()}
      onShrink={vi.fn()}
      onToggleAppSwitch={vi.fn()}
      onToggleInputMode={vi.fn()}
      onToggleMore={vi.fn()}
    />,
  );
}

describe('RemoteWindowLockedToolbar', () => {
  it('keeps primary action touch targets and puts status in the control strip', () => {
    renderToolbar('floating');

    const primaryButtons = screen.getByTestId('remote-window-primary-actions').querySelectorAll('button');
    const stripButtons = screen.getByTestId('remote-window-control-strip').querySelectorAll('button');
    const switchButton = screen.getByTestId('remote-window-active-app-switch-button');
    for (const button of [...primaryButtons, ...stripButtons, switchButton]) {
      expect(Number.parseFloat(button.style.width || button.style.minWidth)).toBeGreaterThanOrEqual(48);
      expect(Number.parseFloat(button.style.height || button.style.minHeight)).toBeGreaterThanOrEqual(48);
    }

    expect(screen.getByTestId('remote-window-input-mode').textContent).toContain('可操作');
    expect(screen.getByTestId('remote-window-input-mode').style.minHeight).toBe('0px');
  });

  it('shows compact stream status only in fullscreen', () => {
    const first = renderToolbar('floating');
    expect(first.queryByTestId('remote-window-toolbar-status')).toBeNull();
    first.unmount();

    renderToolbar('fullscreen');
    expect(screen.getByTestId('remote-window-toolbar-status').textContent).toContain('串流：已连接');
  });

  it('marks the gesture guide as fullscreen so it can be hidden responsively', () => {
    renderToolbar('fullscreen');
    expect(screen.getByTestId('remote-window-gesture-guide').getAttribute('data-mode')).toBe('fullscreen');
  });

  it('uses a distinct visual style for the local close action', () => {
    renderToolbar('floating');
    const close = screen.getByRole('button', { name: '关闭远程窗口' });
    expect(close.style.borderColor).toContain('var(--zterm-panel-accent)');
  });
});
