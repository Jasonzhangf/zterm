import type { ReactNode } from 'react';
import type { RemoteWindowVideoPreference } from '../../lib/types';
import { styles } from './remote-window-overlay-styles';

export interface RemoteWindowMorePanelProps {
  fullscreen: boolean;
  videoPreference: RemoteWindowVideoPreference;
  streamStatusText: string;
  networkStatusText: string;
  developerDiagnostics: ReactNode;
  onToggleFullscreenDisplayMode: () => void;
  onVideoPreferenceChange: (preference: RemoteWindowVideoPreference) => void;
}

export function RemoteWindowMorePanel({
  fullscreen,
  videoPreference,
  streamStatusText,
  networkStatusText,
  developerDiagnostics,
  onToggleFullscreenDisplayMode,
  onVideoPreferenceChange,
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
      <div data-testid="remote-window-user-stream-status">{streamStatusText}</div>
      <div data-testid="remote-window-user-network-status">{networkStatusText}</div>
      {developerDiagnostics}
    </div>
  );
}
