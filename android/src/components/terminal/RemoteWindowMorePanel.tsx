import type { ReactNode } from 'react';
import type { RemoteWindowVideoPreference } from '../../lib/types';
import { styles } from './remote-window-overlay-styles';

export interface RemoteWindowMorePanelProps {
  open: boolean;
  fullscreen: boolean;
  videoPreference: RemoteWindowVideoPreference;
  gestureGuide: string;
  streamStatusText: string;
  networkStatusText: string;
  developerDiagnostics: ReactNode;
  onToggleFullscreenDisplayMode: () => void;
  onVideoPreferenceChange: (preference: RemoteWindowVideoPreference) => void;
}

export function RemoteWindowMorePanel({
  open,
  fullscreen,
  videoPreference,
  gestureGuide,
  streamStatusText,
  networkStatusText,
  developerDiagnostics,
  onToggleFullscreenDisplayMode,
  onVideoPreferenceChange,
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
          <span>串流偏好</span>
          <select
            aria-label="远程窗口串流偏好"
            data-testid="remote-window-video-preference-select"
            value={videoPreference}
            onChange={(event) => onVideoPreferenceChange(event.currentTarget.value as RemoteWindowVideoPreference)}
            style={styles.bitrateSelect}
          >
            <option value="smooth">流畅优先</option>
            <option value="quality">清晰优先</option>
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
