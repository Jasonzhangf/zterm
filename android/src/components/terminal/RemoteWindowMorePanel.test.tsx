// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteWindowMorePanel } from './RemoteWindowMorePanel';

afterEach(cleanup);

describe('RemoteWindowMorePanel view owner', () => {
  it('keeps low-frequency fullscreen and video preference intents in More', () => {
    const onToggleFullscreenDisplayMode = vi.fn();
    const onVideoPreferenceChange = vi.fn();
    render(<RemoteWindowMorePanel
      open
      fullscreen
      gestureGuide="触控说明"
      videoPreference="smooth"
      streamStatusText="串流：已连接 · 流畅优先"
      networkStatusText="网络：4g · RTT 20ms"
      developerDiagnostics={<div data-testid="diagnostics-slot" />}
      onToggleFullscreenDisplayMode={onToggleFullscreenDisplayMode}
      onVideoPreferenceChange={onVideoPreferenceChange}
    />);

    fireEvent.click(screen.getByTestId('remote-window-fullscreen-display-toggle'));
    fireEvent.change(screen.getByLabelText('远程窗口串流偏好'), { target: { value: 'quality' } });
    expect(onToggleFullscreenDisplayMode).toHaveBeenCalledTimes(1);
    expect(onVideoPreferenceChange).toHaveBeenCalledWith('quality');
    expect(screen.getByRole('heading', { name: '显示' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '画质' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '状态' })).toBeTruthy();
    const panel = screen.getByTestId('remote-window-stream-status-panel');
    expect(panel.style.position).toBe('absolute');
    expect(panel.getAttribute('data-open')).toBe('true');
    expect(panel.classList.contains('t-panel-slide')).toBe(true);
    expect(screen.getByTestId('remote-window-gesture-guide').textContent).toBe('触控说明');
    expect(Number.parseFloat(screen.getByLabelText('远程窗口串流偏好').style.minHeight)).toBe(48);
    expect(screen.getByTestId('remote-window-user-stream-status').textContent).toContain('已连接');
    expect(screen.getByTestId('diagnostics-slot')).toBeTruthy();
  });

  it('does not show the fullscreen display action in floating mode', () => {
    render(<RemoteWindowMorePanel
      open={false}
      fullscreen={false}
      gestureGuide="鼠标说明"
      videoPreference="smooth"
      streamStatusText="串流：starting"
      networkStatusText="网络：未知"
      developerDiagnostics={null}
      onToggleFullscreenDisplayMode={vi.fn()}
      onVideoPreferenceChange={vi.fn()}
    />);
    expect(screen.queryByTestId('remote-window-fullscreen-display-toggle')).toBeNull();
    expect(screen.queryByRole('heading', { name: '显示' })).toBeNull();
    expect(screen.getByTestId('remote-window-stream-status-panel').getAttribute('data-open')).toBe('false');
  });
});
