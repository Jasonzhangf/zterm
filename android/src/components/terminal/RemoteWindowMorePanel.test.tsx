// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteWindowMorePanel } from './RemoteWindowMorePanel';
import type { RemoteWindowVideoQualitySettings } from '../../lib/remote-window-video-quality';

afterEach(cleanup);

const committed: RemoteWindowVideoQualitySettings = {
  preference: 'smooth',
  maxBitrateCapMbps: null,
  maxFrameRateFps: 30,
};

function renderPanel(overrides: Partial<Parameters<typeof RemoteWindowMorePanel>[0]> = {}) {
  const onQualityApply = vi.fn();
  const onDismiss = vi.fn();
  render(<RemoteWindowMorePanel
    fullscreen
    streamStatusText="串流：已连接"
    networkStatusText="网络：4g · RTT 20ms"
    developerDiagnostics={<div data-testid="diagnostics-slot" />}
    onToggleFullscreenDisplayMode={vi.fn()}
    onDismiss={onDismiss}
    qualitySettings={committed}
    onQualityApply={onQualityApply}
    {...overrides}
  />);
  return { onQualityApply, onDismiss };
}

describe('RemoteWindowMorePanel draft transaction', () => {
  it('applies the three draft values as one intent and dismisses once', () => {
    const { onQualityApply, onDismiss } = renderPanel();

    fireEvent.change(screen.getByTestId('remote-window-video-preference-select'), { target: { value: 'quality' } });
    fireEvent.change(screen.getByTestId('remote-window-bitrate-cap-input'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByTestId('remote-window-max-frame-rate-select'), { target: { value: '60' } });
    // Editing a draft must not emit an intent or persist anything.
    expect(onQualityApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('remote-window-quality-apply'));
    expect(onQualityApply).toHaveBeenCalledTimes(1);
    expect(onQualityApply).toHaveBeenCalledWith({
      preference: 'quality',
      maxBitrateCapMbps: 12.5,
      maxFrameRateFps: 60,
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('reverts every draft on Cancel with zero apply intent', () => {
    const { onQualityApply, onDismiss } = renderPanel();
    fireEvent.change(screen.getByTestId('remote-window-video-preference-select'), { target: { value: 'quality' } });
    fireEvent.change(screen.getByTestId('remote-window-bitrate-cap-input'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByTestId('remote-window-max-frame-rate-select'), { target: { value: '60' } });

    fireEvent.click(screen.getByTestId('remote-window-quality-cancel'));
    expect(onQualityApply).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('remote-window-video-preference-select') as HTMLSelectElement).value).toBe('smooth');
    expect((screen.getByTestId('remote-window-bitrate-cap-input') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('remote-window-max-frame-rate-select') as HTMLSelectElement).value).toBe('30');
  });

  it('disables Apply and surfaces a range hint for an out-of-range Mbps cap', () => {
    const { onQualityApply } = renderPanel();
    fireEvent.change(screen.getByTestId('remote-window-bitrate-cap-input'), { target: { value: '26' } });
    expect((screen.getByTestId('remote-window-quality-apply') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('请输入 0.5-25 Mbps')).toBeTruthy();

    fireEvent.click(screen.getByTestId('remote-window-quality-apply'));
    expect(onQualityApply).not.toHaveBeenCalled();
  });

  it('keeps Apply disabled until a draft actually differs from committed settings', () => {
    renderPanel();
    expect((screen.getByTestId('remote-window-quality-apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('resyncs drafts when the committed settings change from outside', () => {
    const { rerender } = render(<RemoteWindowMorePanel
      fullscreen
      streamStatusText="串流：已连接"
      networkStatusText="网络：4g"
      developerDiagnostics={null}
      onToggleFullscreenDisplayMode={vi.fn()}
      qualitySettings={committed}
      onQualityApply={vi.fn()}
    />);
    fireEvent.change(screen.getByTestId('remote-window-bitrate-cap-input'), { target: { value: '8' } });
    rerender(<RemoteWindowMorePanel
      fullscreen
      streamStatusText="串流：已连接"
      networkStatusText="网络：4g"
      developerDiagnostics={null}
      onToggleFullscreenDisplayMode={vi.fn()}
      qualitySettings={{ preference: 'quality', maxBitrateCapMbps: 5, maxFrameRateFps: 15 }}
      onQualityApply={vi.fn()}
    />);
    expect((screen.getByTestId('remote-window-bitrate-cap-input') as HTMLInputElement).value).toBe('5');
    expect((screen.getByTestId('remote-window-video-preference-select') as HTMLSelectElement).value).toBe('quality');
  });

  it('keeps the orientation select out of floating mode and the fullscreen action hidden', () => {
    renderPanel({ fullscreen: false });
    expect(screen.queryByTestId('remote-window-display-orientation-select')).toBeNull();
    expect(screen.queryByTestId('remote-window-fullscreen-display-toggle')).toBeNull();
  });

  it('shows the dangerous remote-close entry only when the handler is wired', () => {
    const onRemoteClose = vi.fn();
    renderPanel({ onRemoteClose });
    expect(screen.getByText('此操作会关闭所选远端窗口')).toBeTruthy();
    fireEvent.click(screen.getByTestId('remote-window-remote-close'));
    expect(onRemoteClose).toHaveBeenCalledTimes(1);
  });

  it('shows browser UA control only for a browser target', () => {
    const onBrowserUserAgentChange = vi.fn();
    const view = render(<RemoteWindowMorePanel
      fullscreen
      streamStatusText="串流：已连接"
      networkStatusText="网络：4g"
      developerDiagnostics={null}
      onToggleFullscreenDisplayMode={vi.fn()}
      qualitySettings={committed}
      onQualityApply={vi.fn()}
      browserMode
      browserUserAgent="desktop"
      browserUserAgentStatus="idle"
      onBrowserUserAgentChange={onBrowserUserAgentChange}
    />);
    fireEvent.change(screen.getByTestId('remote-window-browser-user-agent-select'), { target: { value: 'mobile' } });
    expect(onBrowserUserAgentChange).toHaveBeenCalledWith('mobile');
    view.rerender(<RemoteWindowMorePanel
      fullscreen
      streamStatusText="串流：已连接"
      networkStatusText="网络：4g"
      developerDiagnostics={null}
      onToggleFullscreenDisplayMode={vi.fn()}
      qualitySettings={committed}
      onQualityApply={vi.fn()}
    />);
    expect(screen.queryByTestId('remote-window-browser-user-agent-select')).toBeNull();
  });
});
