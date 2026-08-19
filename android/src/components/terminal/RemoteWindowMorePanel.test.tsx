// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteWindowMorePanel } from './RemoteWindowMorePanel';

afterEach(cleanup);

describe('RemoteWindowMorePanel view owner', () => {
  it('keeps low-frequency fullscreen and bitrate intents in More', () => {
    const onToggleFullscreenDisplayMode = vi.fn();
    const onBitratePresetChange = vi.fn();
    render(<RemoteWindowMorePanel
      fullscreen
      bitratePreset="5mbps"
      streamStatusText="串流：已连接 · 画质：5 Mbps"
      networkStatusText="网络：4g · RTT 20ms"
      developerDiagnostics={<div data-testid="diagnostics-slot" />}
      onToggleFullscreenDisplayMode={onToggleFullscreenDisplayMode}
      onBitratePresetChange={onBitratePresetChange}
    />);

    fireEvent.click(screen.getByTestId('remote-window-fullscreen-display-toggle'));
    fireEvent.change(screen.getByLabelText('远程窗口画质上限'), { target: { value: '10mbps' } });
    expect(onToggleFullscreenDisplayMode).toHaveBeenCalledTimes(1);
    expect(onBitratePresetChange).toHaveBeenCalledWith('10mbps');
    expect(screen.getByTestId('remote-window-user-stream-status').textContent).toContain('已连接');
    expect(screen.getByTestId('diagnostics-slot')).toBeTruthy();
  });

  it('does not show the fullscreen display action in floating mode', () => {
    render(<RemoteWindowMorePanel
      fullscreen={false}
      bitratePreset="2mbps"
      streamStatusText="串流：starting"
      networkStatusText="网络：未知"
      developerDiagnostics={null}
      onToggleFullscreenDisplayMode={vi.fn()}
      onBitratePresetChange={vi.fn()}
    />);
    expect(screen.queryByTestId('remote-window-fullscreen-display-toggle')).toBeNull();
  });
});
