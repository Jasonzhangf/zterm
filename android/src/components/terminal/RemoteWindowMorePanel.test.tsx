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
      fullscreen
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
    expect(screen.getByTestId('remote-window-user-stream-status').textContent).toContain('已连接');
    expect(screen.getByTestId('diagnostics-slot')).toBeTruthy();
  });

  it('emits orientation and quality control intents', () => {
    const onDisplayOrientationChange = vi.fn();
    const onBitrateMultiplierChange = vi.fn();
    const onMaxFrameRateChange = vi.fn();
    render(<RemoteWindowMorePanel
      fullscreen
      videoPreference="smooth"
      streamStatusText="串流：已连接"
      networkStatusText="网络：4g"
      developerDiagnostics={null}
      onToggleFullscreenDisplayMode={vi.fn()}
      onVideoPreferenceChange={vi.fn()}
      displayOrientation="follow-device"
      onDisplayOrientationChange={onDisplayOrientationChange}
      bitrateMultiplierSelection="auto"
      onBitrateMultiplierChange={onBitrateMultiplierChange}
      maxFrameRateFps={30}
      onMaxFrameRateChange={onMaxFrameRateChange}
    />);

    fireEvent.change(screen.getByTestId('remote-window-display-orientation-select'), { target: { value: 'landscape' } });
    fireEvent.change(screen.getByTestId('remote-window-bitrate-multiplier-select'), { target: { value: '4' } });
    fireEvent.change(screen.getByTestId('remote-window-max-frame-rate-select'), { target: { value: '60' } });

    expect(onDisplayOrientationChange).toHaveBeenCalledWith('landscape');
    expect(onBitrateMultiplierChange).toHaveBeenCalledWith(4);
    expect(onMaxFrameRateChange).toHaveBeenCalledWith(60);
  });

  it('keeps the orientation select out of floating mode and offers the auto bitrate baseline', () => {
    render(<RemoteWindowMorePanel
      fullscreen={false}
      videoPreference="smooth"
      streamStatusText="串流：已连接"
      networkStatusText="网络：4g"
      developerDiagnostics={null}
      onToggleFullscreenDisplayMode={vi.fn()}
      onVideoPreferenceChange={vi.fn()}
      onDisplayOrientationChange={vi.fn()}
      bitrateMultiplierSelection="auto"
      onBitrateMultiplierChange={vi.fn()}
    />);

    expect(screen.queryByTestId('remote-window-display-orientation-select')).toBeNull();
    expect((screen.getByTestId('remote-window-bitrate-multiplier-select') as HTMLSelectElement).value).toBe('auto');
  });

  it('does not show the fullscreen display action in floating mode', () => {
    render(<RemoteWindowMorePanel
      fullscreen={false}
      videoPreference="smooth"
      streamStatusText="串流：starting"
      networkStatusText="网络：未知"
      developerDiagnostics={null}
      onToggleFullscreenDisplayMode={vi.fn()}
      onVideoPreferenceChange={vi.fn()}
    />);
    expect(screen.queryByTestId('remote-window-fullscreen-display-toggle')).toBeNull();
  });

  it('shows browser UA control only for a browser target', () => {
    const onBrowserUserAgentChange = vi.fn();
    const view = render(<RemoteWindowMorePanel
      fullscreen
      videoPreference="smooth"
      streamStatusText="串流：已连接"
      networkStatusText="网络：4g"
      developerDiagnostics={null}
      onToggleFullscreenDisplayMode={vi.fn()}
      onVideoPreferenceChange={vi.fn()}
      browserMode
      browserUserAgent="desktop"
      browserUserAgentStatus="idle"
      onBrowserUserAgentChange={onBrowserUserAgentChange}
    />);
    fireEvent.change(screen.getByTestId('remote-window-browser-user-agent-select'), { target: { value: 'mobile' } });
    expect(onBrowserUserAgentChange).toHaveBeenCalledWith('mobile');
    view.rerender(<RemoteWindowMorePanel
      fullscreen
      videoPreference="smooth"
      streamStatusText="串流：已连接"
      networkStatusText="网络：4g"
      developerDiagnostics={null}
      onToggleFullscreenDisplayMode={vi.fn()}
      onVideoPreferenceChange={vi.fn()}
    />);
    expect(screen.queryByTestId('remote-window-browser-user-agent-select')).toBeNull();
  });
});
