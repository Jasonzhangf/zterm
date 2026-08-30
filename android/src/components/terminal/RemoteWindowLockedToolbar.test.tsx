// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteWindowLockedToolbar } from './RemoteWindowLockedToolbar';
import { styles } from './remote-window-overlay-styles';

afterEach(cleanup);

describe('RemoteWindowLockedToolbar view owner', () => {
  it('keeps 48dp frequent controls stable while More opens above the video', () => {
    const onToggleMore = vi.fn();
    const { rerender } = render(<RemoteWindowLockedToolbar
      activeTitle="A very long remote application window title"
      appSwitchContent={<div data-testid="app-switch-content" />}
      appSwitchOpen={false}
      dragHandleProps={{ style: styles.lockedTopBar }}
      inputMode="touch"
      inputSupported
      mode="floating"
      moreContent={<div data-testid="more-content" />}
      moreOpen={false}
      screenshotBusy={false}
      screenshotButtonStyle={styles.headerIconButton}
      targetKindLabel="App Window"
      onClose={vi.fn()}
      onFullscreen={vi.fn()}
      onRequestKeyboard={vi.fn()}
      onScreenshot={vi.fn()}
      onShrink={vi.fn()}
      onToggleAppSwitch={vi.fn()}
      onToggleInputMode={vi.fn()}
      onToggleMore={onToggleMore}
    />);

    expect(screen.getByRole('toolbar', { name: '远程窗口控制' })).toBeTruthy();
    expect(screen.queryByTestId('remote-window-gesture-guide')).toBeNull();
    expect(screen.getByTestId('more-content')).toBeTruthy();
    expect(screen.getByTestId('remote-window-active-app-switch-button').getAttribute('aria-label')).toContain('切换远程窗口');
    expect(screen.getByTestId('remote-window-input-mode').textContent).toContain('可操作');
    expect(Number.parseFloat(screen.getByRole('button', { name: '关闭远程窗口' }).style.minHeight)).toBe(48);
    expect(Number.parseFloat(screen.getByTestId('remote-window-input-mode-toggle').style.minHeight)).toBe(48);

    fireEvent.click(screen.getByTestId('remote-window-more-toggle'));
    expect(onToggleMore).toHaveBeenCalledTimes(1);

    rerender(<RemoteWindowLockedToolbar
      activeTitle="A very long remote application window title"
      appSwitchContent={null}
      appSwitchOpen={false}
      dragHandleProps={{ style: styles.lockedTopBar }}
      inputMode="touch"
      inputSupported
      mode="floating"
      moreContent={<div data-testid="more-content" />}
      moreOpen
      screenshotBusy={false}
      screenshotButtonStyle={styles.headerIconButton}
      targetKindLabel="App Window"
      onClose={vi.fn()}
      onFullscreen={vi.fn()}
      onRequestKeyboard={vi.fn()}
      onScreenshot={vi.fn()}
      onShrink={vi.fn()}
      onToggleAppSwitch={vi.fn()}
      onToggleInputMode={vi.fn()}
      onToggleMore={onToggleMore}
    />);
    expect(screen.getByTestId('more-content')).toBeTruthy();
    expect(screen.queryByTestId('remote-window-gesture-guide')).toBeNull();
  });
});
