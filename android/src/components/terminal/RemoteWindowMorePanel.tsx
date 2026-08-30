import type { ReactNode } from 'react';
import type { RemoteWindowVideoBitratePreset } from '../../lib/types';
import { styles } from './remote-window-overlay-styles';

export interface RemoteWindowMorePanelProps {
  open: boolean;
  fullscreen: boolean;
  bitratePreset: RemoteWindowVideoBitratePreset;
  gestureGuide: string;
  streamStatusText: string;
  networkStatusText: string;
  developerDiagnostics: ReactNode;
  onToggleFullscreenDisplayMode: () => void;
  onBitratePresetChange: (preset: RemoteWindowVideoBitratePreset) => void;
}

export function RemoteWindowMorePanel({
  open,
  fullscreen,
  bitratePreset,
  gestureGuide,
  streamStatusText,
  networkStatusText,
  developerDiagnostics,
  onToggleFullscreenDisplayMode,
  onBitratePresetChange,
}: RemoteWindowMorePanelProps) {
  return (
    <div
      className="t-panel-slide"
      data-testid="remote-window-stream-status-panel"
      data-no-drag="true"
      data-open={open ? 'true' : 'false'}
      aria-hidden={open ? undefined : true}
      inert={!open}
      style={styles.streamStatusPanel}
    >
      {fullscreen ? (
        <section style={styles.moreSection}>
          <h3 style={styles.moreSectionTitle}>显示</h3>
          <button
            type="button"
            data-testid="remote-window-fullscreen-display-toggle"
            onClick={onToggleFullscreenDisplayMode}
            style={styles.moreActionButton}
          >
            填满远程窗口
          </button>
        </section>
      ) : null}
      <section style={styles.moreSection}>
        <h3 style={styles.moreSectionTitle}>画质</h3>
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
      </section>
      <section style={styles.moreSection}>
        <h3 style={styles.moreSectionTitle}>状态</h3>
        <div style={styles.moreStatusList}>
          <div data-testid="remote-window-user-stream-status" style={styles.moreStatusRow}>{streamStatusText}</div>
          <div data-testid="remote-window-user-network-status" style={styles.moreStatusRow}>{networkStatusText}</div>
        </div>
        {developerDiagnostics}
      </section>
      <section style={styles.moreSection}>
        <h3 style={styles.moreSectionTitle}>手势</h3>
        <div data-testid="remote-window-gesture-guide" style={styles.moreGestureGuide}>{gestureGuide}</div>
      </section>
    </div>
  );
}
