import { useEffect, useState, type ReactNode } from 'react';
import type { RemoteWindowBrowserUserAgent, RemoteWindowVideoPreference } from '../../lib/types';
import {
  REMOTE_WINDOW_QUALITY_FRAME_RATE_OPTIONS,
  REMOTE_WINDOW_VIDEO_CAP_MIN_MBPS,
  REMOTE_WINDOW_VIDEO_CAP_MAX_MBPS,
  type RemoteWindowQualityMaxFrameRate,
  type RemoteWindowVideoQualitySettings,
} from '../../lib/remote-window-video-quality';
import { styles } from './remote-window-overlay-styles';
import { RemoteWindowIcon } from './remote-window-icons';
import { AmbientButton, AmbientInput, AmbientSelect } from '../ambient';
import type { RemoteWindowOrientationPolicy } from './remote-window-overlay-helpers';

export interface RemoteWindowMorePanelProps {
  fullscreen: boolean;
  streamStatusText: string;
  networkStatusText: string;
  developerDiagnostics: ReactNode;
  onDismiss?: () => void;
  onRemoteClose?: () => void;
  onToggleFullscreenDisplayMode: () => void;
  displayOrientation?: RemoteWindowOrientationPolicy;
  onDisplayOrientationChange?: (orientation: RemoteWindowOrientationPolicy) => void;
  qualitySettings: RemoteWindowVideoQualitySettings;
  onQualityApply: (settings: RemoteWindowVideoQualitySettings) => void;
  browserMode?: boolean;
  browserUserAgent?: RemoteWindowBrowserUserAgent;
  browserUserAgentStatus?: 'idle' | 'pending' | 'applied' | 'rejected';
  browserUserAgentError?: string | null;
  onBrowserUserAgentChange?: (userAgent: RemoteWindowBrowserUserAgent) => void;
}

export function RemoteWindowMorePanel({
  fullscreen,
  streamStatusText,
  networkStatusText,
  developerDiagnostics,
  onDismiss = () => {},
  onRemoteClose,
  onToggleFullscreenDisplayMode,
  displayOrientation = 'follow-device',
  onDisplayOrientationChange,
  qualitySettings,
  onQualityApply,
  browserMode = false,
  browserUserAgent = 'desktop',
  browserUserAgentStatus = 'idle',
  browserUserAgentError = null,
  onBrowserUserAgentChange,
}: RemoteWindowMorePanelProps) {
  const [draftPreference, setDraftPreference] = useState<RemoteWindowVideoPreference>(qualitySettings.preference);
  const [draftMaxBitrateCapMbps, setDraftMaxBitrateCapMbps] = useState<string | null>(
    qualitySettings.maxBitrateCapMbps === null ? null : String(qualitySettings.maxBitrateCapMbps),
  );
  const [draftMaxFrameRateFps, setDraftMaxFrameRateFps] = useState<RemoteWindowQualityMaxFrameRate>(
    qualitySettings.maxFrameRateFps,
  );

  useEffect(() => {
    setDraftPreference(qualitySettings.preference);
    setDraftMaxBitrateCapMbps(qualitySettings.maxBitrateCapMbps === null ? null : String(qualitySettings.maxBitrateCapMbps));
    setDraftMaxFrameRateFps(qualitySettings.maxFrameRateFps);
  }, [qualitySettings]);

  // An empty field means "default budget", not an out-of-range 0.
  const draftCapMbps = draftMaxBitrateCapMbps === null || draftMaxBitrateCapMbps.trim() === ''
    ? null
    : Number(draftMaxBitrateCapMbps);
  const capInRange = draftCapMbps === null
    || (Number.isFinite(draftCapMbps)
      && draftCapMbps >= REMOTE_WINDOW_VIDEO_CAP_MIN_MBPS
      && draftCapMbps <= REMOTE_WINDOW_VIDEO_CAP_MAX_MBPS);
  const dirty = draftPreference !== qualitySettings.preference
    || draftCapMbps !== qualitySettings.maxBitrateCapMbps
    || draftMaxFrameRateFps !== qualitySettings.maxFrameRateFps;

  const handleApply = () => {
    if (!capInRange || !dirty) {
      return;
    }
    onQualityApply({
      preference: draftPreference,
      maxBitrateCapMbps: draftCapMbps,
      maxFrameRateFps: draftMaxFrameRateFps,
    });
    onDismiss();
  };

  const handleCancel = () => {
    setDraftPreference(qualitySettings.preference);
    setDraftMaxBitrateCapMbps(qualitySettings.maxBitrateCapMbps === null ? null : String(qualitySettings.maxBitrateCapMbps));
    setDraftMaxFrameRateFps(qualitySettings.maxFrameRateFps);
    onDismiss();
  };

  return (
    <div data-testid="remote-window-stream-status-panel" data-no-drag="true" style={styles.streamStatusPanel}>
      <div style={styles.morePanelHeader}>
        <span>串流设置</span>
        <AmbientButton
          type="button"
          data-testid="remote-window-more-close"
          aria-label="关闭串流设置"
          title="关闭串流设置"
          onClick={onDismiss}
          style={styles.morePanelCloseButton}
        >
          收起
        </AmbientButton>
      </div>
      {onRemoteClose ? (
        <div style={styles.moreDangerRow}>
          <div style={styles.moreDangerCopy}>
            <span>关闭远端窗口</span>
            <span style={styles.moreDangerHint}>此操作会关闭所选远端窗口</span>
          </div>
          <AmbientButton
            type="button"
            data-testid="remote-window-remote-close"
            aria-label="远程关闭当前窗口"
            title="远程关闭当前窗口"
            onClick={onRemoteClose}
            style={styles.headerIconButtonDanger}
          >
            <RemoteWindowIcon name="close-window" />
          </AmbientButton>
        </div>
      ) : null}
      {fullscreen ? (
        <AmbientButton
          type="button"
          data-testid="remote-window-fullscreen-display-toggle"
          onClick={onToggleFullscreenDisplayMode}
          style={styles.headerButton}
        >
          重新匹配远端比例
        </AmbientButton>
      ) : null}
      <label style={styles.moreField}>
        <span>串流偏好</span>
        <AmbientSelect
          aria-label="远程窗口串流偏好"
          data-testid="remote-window-video-preference-select"
          value={draftPreference}
          onChange={(event) => {
            setDraftPreference(event.currentTarget.value as RemoteWindowVideoPreference);
          }}
          style={styles.bitrateSelect}
        >
          <option value="smooth">流畅优先</option>
          <option value="quality">清晰优先</option>
        </AmbientSelect>
      </label>
      {fullscreen ? (
        <label style={styles.moreField}>
          <span>显示方向</span>
          <AmbientSelect
            aria-label="远程窗口显示方向"
            data-testid="remote-window-display-orientation-select"
            value={displayOrientation}
            onChange={(event) => {
              onDisplayOrientationChange?.(event.currentTarget.value as RemoteWindowOrientationPolicy);
              onDismiss();
            }}
            style={styles.bitrateSelect}
          >
            <option value="portrait">竖屏</option>
            <option value="landscape">横屏</option>
            <option value="follow-device">跟随设备</option>
          </AmbientSelect>
        </label>
      ) : null}
      <label style={styles.moreField}>
        <span>总码率上限</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <AmbientInput
            aria-label="远程窗口总码率上限 Mbps"
            data-testid="remote-window-bitrate-cap-input"
            type="number"
            min={REMOTE_WINDOW_VIDEO_CAP_MIN_MBPS}
            max={REMOTE_WINDOW_VIDEO_CAP_MAX_MBPS}
            step={0.5}
            value={draftMaxBitrateCapMbps ?? ''}
            placeholder="默认"
            onChange={(event) => setDraftMaxBitrateCapMbps(event.currentTarget.value)}
            style={{ width: 96 }}
          />
          <span>Mbps</span>
        </span>
      </label>
      <label style={styles.moreField}>
        <span>帧率上限</span>
        <AmbientSelect
          aria-label="远程窗口帧率上限"
          data-testid="remote-window-max-frame-rate-select"
          value={draftMaxFrameRateFps}
          onChange={(event) => {
            setDraftMaxFrameRateFps(Number(event.currentTarget.value) as RemoteWindowQualityMaxFrameRate);
          }}
          style={styles.bitrateSelect}
        >
          {REMOTE_WINDOW_QUALITY_FRAME_RATE_OPTIONS.map((frameRate) => (
            <option key={frameRate} value={frameRate}>{`${frameRate} FPS`}</option>
          ))}
        </AmbientSelect>
      </label>
      {!capInRange ? (
        <div style={styles.moreDangerHint}>请输入 0.5-25 Mbps</div>
      ) : null}
      <div style={styles.moreField}>
        <AmbientButton
          type="button"
          data-testid="remote-window-quality-apply"
          disabled={!dirty || !capInRange}
          onClick={handleApply}
          style={styles.headerButton}
        >
          应用
        </AmbientButton>
        <AmbientButton
          type="button"
          data-testid="remote-window-quality-cancel"
          onClick={handleCancel}
          style={styles.headerButton}
        >
          取消
        </AmbientButton>
      </div>
      {browserMode && onBrowserUserAgentChange ? (
        <label style={styles.moreField}>
          <span>浏览器排版</span>
          <AmbientSelect
            aria-label="浏览器移动 UA"
            data-testid="remote-window-browser-user-agent-select"
            value={browserUserAgent}
            disabled={browserUserAgentStatus === 'pending'}
            onChange={(event) => {
              onBrowserUserAgentChange(event.currentTarget.value as RemoteWindowBrowserUserAgent);
              onDismiss();
            }}
            style={styles.bitrateSelect}
          >
            <option value="desktop">桌面版</option>
            <option value="mobile">移动版</option>
          </AmbientSelect>
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
