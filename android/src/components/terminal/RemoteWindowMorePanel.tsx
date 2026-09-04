import type { ReactNode } from 'react';
import type { RemoteWindowBrowserUserAgent, RemoteWindowVideoPreference } from '../../lib/types';
import {
  REMOTE_WINDOW_VIDEO_BUDGET_MULTIPLIERS,
} from '../../lib/remote-window-video-quality';
import {
  REMOTE_WINDOW_DISPLAY_ORIENTATION_OPTIONS,
  REMOTE_WINDOW_QUALITY_FRAME_RATE_OPTIONS,
  type RemoteWindowDisplayOrientation,
  type RemoteWindowQualityMaxFrameRate,
  type RemoteWindowVideoBudgetMultiplier,
} from '../../lib/remote-window-display-orientation';
import { styles } from './remote-window-overlay-styles';

export interface RemoteWindowMorePanelProps {
  fullscreen: boolean;
  videoPreference: RemoteWindowVideoPreference;
  streamStatusText: string;
  networkStatusText: string;
  developerDiagnostics: ReactNode;
  onToggleFullscreenDisplayMode: () => void;
  onVideoPreferenceChange: (preference: RemoteWindowVideoPreference) => void;
  displayOrientation?: RemoteWindowDisplayOrientation;
  onDisplayOrientationChange?: (orientation: RemoteWindowDisplayOrientation) => void;
  bitrateMultiplier?: RemoteWindowVideoBudgetMultiplier;
  onBitrateMultiplierChange?: (multiplier: RemoteWindowVideoBudgetMultiplier) => void;
  maxFrameRateFps?: RemoteWindowQualityMaxFrameRate;
  onMaxFrameRateChange?: (frameRate: RemoteWindowQualityMaxFrameRate) => void;
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
  displayOrientation = 'portrait',
  onDisplayOrientationChange = () => undefined,
  bitrateMultiplier = 1,
  onBitrateMultiplierChange = () => undefined,
  maxFrameRateFps = 30,
  onMaxFrameRateChange = () => undefined,
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
      <label style={styles.moreField}>
        <span>显示方向</span>
        <select
          aria-label="远程窗口显示方向"
          data-testid="remote-window-display-orientation-select"
          value={displayOrientation}
          onChange={(event) => onDisplayOrientationChange(event.currentTarget.value as RemoteWindowDisplayOrientation)}
          style={styles.bitrateSelect}
        >
          {REMOTE_WINDOW_DISPLAY_ORIENTATION_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option === 'portrait' ? '竖屏' : option === 'landscape' ? '横屏' : '跟随设备'}
            </option>
          ))}
        </select>
      </label>
      <label style={styles.moreField}>
        <span>码率倍数</span>
        <select
          aria-label="远程窗口码率倍数"
          data-testid="remote-window-bitrate-multiplier-select"
          value={bitrateMultiplier}
          onChange={(event) => onBitrateMultiplierChange(Number(event.currentTarget.value) as RemoteWindowVideoBudgetMultiplier)}
          style={styles.bitrateSelect}
        >
          {REMOTE_WINDOW_VIDEO_BUDGET_MULTIPLIERS.map((multiplier) => (
            <option key={multiplier} value={multiplier}>{`${multiplier}x`}</option>
          ))}
        </select>
      </label>
      <label style={styles.moreField}>
        <span>帧率上限</span>
        <select
          aria-label="远程窗口帧率上限"
          data-testid="remote-window-frame-rate-select"
          value={maxFrameRateFps}
          onChange={(event) => onMaxFrameRateChange(Number(event.currentTarget.value) as RemoteWindowQualityMaxFrameRate)}
          style={styles.bitrateSelect}
        >
          {REMOTE_WINDOW_QUALITY_FRAME_RATE_OPTIONS.map((frameRate) => (
            <option key={frameRate} value={frameRate}>{`${frameRate} FPS`}</option>
          ))}
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
