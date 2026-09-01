import type { ReactNode } from 'react';
import type { RemoteWindowBrowserUserAgent, RemoteWindowVideoPreference } from '../../lib/types';
import { styles } from './remote-window-overlay-styles';

export interface RemoteWindowMorePanelProps {
  fullscreen: boolean;
  videoPreference: RemoteWindowVideoPreference;
  streamStatusText: string;
  networkStatusText: string;
  developerDiagnostics: ReactNode;
  onToggleFullscreenDisplayMode: () => void;
  onVideoPreferenceChange: (preference: RemoteWindowVideoPreference) => void;
  browserMode?: boolean;
  browserUserAgent?: RemoteWindowBrowserUserAgent;
  browserUserAgentStatus?: 'idle' | 'pending' | 'applied' | 'rejected';
  browserUserAgentError?: string | null;
  onBrowserUserAgentChange?: (userAgent: RemoteWindowBrowserUserAgent) => void;
}

export function RemoteWindowMorePanel({
  fullscreen,
  videoPreference,
  streamStatusText,
  networkStatusText,
  developerDiagnostics,
  onToggleFullscreenDisplayMode,
  onVideoPreferenceChange,
  browserMode = false,
  browserUserAgent = 'desktop',
  browserUserAgentStatus = 'idle',
  browserUserAgentError = null,
  onBrowserUserAgentChange,
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
      {browserMode && onBrowserUserAgentChange ? (
        <label style={styles.moreField}>
          <span>浏览器排版</span>
          <select
            aria-label="浏览器移动 UA"
            data-testid="remote-window-browser-user-agent-select"
            value={browserUserAgent}
            disabled={browserUserAgentStatus === 'pending'}
            onChange={(event) => onBrowserUserAgentChange(event.currentTarget.value as RemoteWindowBrowserUserAgent)}
            style={styles.bitrateSelect}
          >
            <option value="desktop">桌面版</option>
            <option value="mobile">移动版</option>
          </select>
          <span data-testid="remote-window-browser-user-agent-status">
            {browserUserAgentStatus === 'pending' ? '正在切换…' : browserUserAgentStatus === 'rejected' ? `失败：${browserUserAgentError || 'CDP 未接受'}` : browserUserAgentStatus === 'applied' ? '已应用' : ''}
          </span>
        </label>
      ) : null}
      <div data-testid="remote-window-user-stream-status">{streamStatusText}</div>
      <div data-testid="remote-window-user-network-status">{networkStatusText}</div>
      {developerDiagnostics}
    </div>
  );
}
