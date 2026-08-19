import type { ReactNode } from 'react';
import type { RemoteWindowVideoBitratePreset } from '../../lib/types';
import { styles } from './remote-window-overlay-styles';

export interface RemoteWindowMorePanelProps {
  fullscreen: boolean;
  bitratePreset: RemoteWindowVideoBitratePreset;
  streamStatusText: string;
  networkStatusText: string;
  developerDiagnostics: ReactNode;
  onToggleFullscreenDisplayMode: () => void;
  onBitratePresetChange: (preset: RemoteWindowVideoBitratePreset) => void;
}

export function RemoteWindowMorePanel({
  fullscreen,
  bitratePreset,
  streamStatusText,
  networkStatusText,
  developerDiagnostics,
  onToggleFullscreenDisplayMode,
  onBitratePresetChange,
}: RemoteWindowMorePanelProps) {
  return (
    <div data-testid="remote-window-stream-status-panel" data-no-drag="true" style={styles.streamStatusPanel}>
      {fullscreen ? (
        <button
          type="button"
          data-testid="remote-window-fullscreen-display-toggle"
          onClick={onToggleFullscreenDisplayMode}
          style={styles.headerButton}
        >
          填满远程窗口
        </button>
      ) : null}
      <label style={styles.moreField}>
        <span>画质上限</span>
        <select
          aria-label="远程窗口画质上限"
          value={bitratePreset}
          onChange={(event) => onBitratePresetChange(event.currentTarget.value as RemoteWindowVideoBitratePreset)}
          style={styles.bitrateSelect}
        >
          <option value="2mbps">省流 2 Mbps</option>
          <option value="5mbps">均衡 5 Mbps</option>
          <option value="10mbps">清晰 10 Mbps</option>
          <option value="20mbps">高清 20 Mbps</option>
          <option value="fullscreen">桌面全屏</option>
        </select>
      </label>
      <div data-testid="remote-window-user-stream-status">{streamStatusText}</div>
      <div data-testid="remote-window-user-network-status">{networkStatusText}</div>
      {developerDiagnostics}
    </div>
  );
}
