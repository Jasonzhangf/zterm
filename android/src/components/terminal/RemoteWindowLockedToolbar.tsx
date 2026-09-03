import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { RemoteWindowIcon } from './remote-window-icons';
import { styles } from './remote-window-overlay-styles';
import type { RemoteWindowVideoStatsSample } from '../../lib/remote-window-video-quality';

export interface RemoteWindowStreamDebugInfo {
  frameSize: { width: number; height: number } | null;
  videoSize: { width: number; height: number } | null;
  fps: number | null;
  uplinkBps: number | null;
  downlinkBps: number | null;
  sample: RemoteWindowVideoStatsSample | null;
}

export interface RemoteWindowLockedToolbarProps {
  activeTitle: string;
  appSwitchContent: ReactNode;
  appSwitchOpen: boolean;
  dragHandleProps: HTMLAttributes<HTMLDivElement>;
  gestureGuide: string;
  inputMode: 'touch' | 'mouse';
  inputSupported: boolean;
  mode: 'floating' | 'fullscreen';
  moreContent: ReactNode;
  moreOpen: boolean;
  screenshotBusy: boolean;
  screenshotButtonStyle: CSSProperties;
  targetKindLabel: string;
  onClose: () => void;
  onRemoteClose: () => void;
  onFullscreen: () => void;
  onRequestKeyboard: () => void;
  onScreenshot: () => void;
  onShrink: () => void;
  onToggleAppSwitch: () => void;
  onToggleInputMode: () => void;
  onToggleMore: () => void;
  streamDebugInfo?: RemoteWindowStreamDebugInfo | null;
}

export const RemoteWindowLockedToolbar = forwardRef<HTMLDivElement, RemoteWindowLockedToolbarProps>(function RemoteWindowLockedToolbar({
  activeTitle,
  appSwitchContent,
  appSwitchOpen,
  dragHandleProps,
  gestureGuide,
  inputMode,
  inputSupported,
  mode,
  moreContent,
  moreOpen,
  screenshotBusy,
  screenshotButtonStyle,
  targetKindLabel,
  onClose,
  onRemoteClose,
  onFullscreen,
  onRequestKeyboard,
  onScreenshot,
  onShrink,
  onToggleAppSwitch,
  onToggleInputMode,
  onToggleMore,
  streamDebugInfo,
}, ref) {
  const formatRate = (bps: number | null) => bps == null || !Number.isFinite(bps)
    ? '-'
    : `${(bps / 1_000_000).toFixed(1)} Mbps`;
  const debug = mode === 'fullscreen' && streamDebugInfo ? streamDebugInfo : null;
  return (
    <div ref={ref} data-testid="remote-window-locked-toolbar" style={styles.lockedToolbar}>
      <div {...dragHandleProps} data-testid="remote-window-drag-handle" style={styles.lockedTopBar}>
        <div style={styles.lockedTitle}>
            <span style={styles.targetKind}>{targetKindLabel}</span>
          <span data-testid="remote-window-input-mode" style={styles.inputModeBadge}>
            {inputSupported ? '可操作' : '只读'}
          </span>
          <span style={styles.activeAppSwitch}>
            <button
              type="button"
              data-testid="remote-window-active-app-switch-button"
              data-no-drag="true"
              aria-haspopup="listbox"
              aria-expanded={appSwitchOpen ? 'true' : 'false'}
              onClick={onToggleAppSwitch}
              style={styles.activeAppSwitchButton}
            >
              {activeTitle}
            </button>
            {appSwitchOpen ? appSwitchContent : null}
          </span>
        </div>
        <div data-testid="remote-window-primary-actions" style={styles.lockedPrimaryActions}>
          {mode === 'fullscreen' ? (
            <button type="button" aria-label="缩小远程窗口" onClick={onShrink} style={styles.headerIconButton}>
              <RemoteWindowIcon name="minimize" />
            </button>
          ) : (
            <button type="button" aria-label="全屏远程窗口" onClick={onFullscreen} style={styles.headerIconButton}>
              <RemoteWindowIcon name="fullscreen" />
            </button>
          )}
          <button type="button" data-testid="remote-window-remote-close" aria-label="远程关闭当前窗口" title="远程关闭当前窗口" onClick={onRemoteClose} style={styles.headerIconButtonDanger}>
            <RemoteWindowIcon name="close-window" />
          </button>
          <button type="button" aria-label="关闭远程窗口" title="关闭" onClick={onClose} style={styles.headerIconButton}>
            <RemoteWindowIcon name="close" />
          </button>
        </div>
      </div>
      {debug ? (
        <div data-testid="remote-window-fullscreen-stream-debug" style={styles.fullscreenStreamDebug}>
          <span>画面 {debug.videoSize?.width || debug.frameSize?.width || 0}×{debug.videoSize?.height || debug.frameSize?.height || 0}</span>
          <span>帧率 {debug.fps == null ? '-' : `${debug.fps.toFixed(1)} FPS`}</span>
          <span>上行 {formatRate(debug.uplinkBps)}</span>
          <span>下行 {formatRate(debug.downlinkBps)}</span>
          <span>RTT {debug.sample?.rttMs == null ? '-' : `${Math.round(debug.sample.rttMs)} ms`}</span>
        </div>
      ) : null}
      <div data-testid="remote-window-control-strip" data-no-drag="true" style={styles.lockedControlStrip}>
          <button
          type="button"
          data-testid="remote-window-input-mode-toggle"
          data-no-drag="true"
          aria-label={inputMode === 'touch' ? '切换为鼠标模式' : '切换为触控模式'}
          onClick={onToggleInputMode}
          style={inputMode === 'touch' ? styles.headerModeButtonActive : styles.headerModeButton}
            title={inputMode === 'touch' ? '切换为鼠标模式' : '切换为触控模式'}
          >
          {inputMode === 'touch' ? '触控' : '鼠标'}
        </button>
          <button
          type="button"
          data-no-drag="true"
          aria-label="截屏远程窗口"
          aria-busy={screenshotBusy ? 'true' : undefined}
          disabled={screenshotBusy}
          onClick={onScreenshot}
          style={screenshotButtonStyle}
            title="截取当前窗口"
          >
          <RemoteWindowIcon name="screenshot" />
        </button>
          <button
          type="button"
          data-no-drag="true"
          aria-label="调起远程窗口键盘"
          onClick={onRequestKeyboard}
          style={styles.headerIconButton}
            title="打开键盘"
          >
          <RemoteWindowIcon name="keyboard" />
        </button>
          <button
          type="button"
          data-no-drag="true"
          data-testid="remote-window-more-toggle"
          aria-label="更多远程窗口控制"
          aria-expanded={moreOpen ? 'true' : 'false'}
          onClick={onToggleMore}
          style={moreOpen ? styles.headerIconButtonBusy : styles.headerIconButton}
            title="更多串流设置"
          >
          <RemoteWindowIcon name="more" />
        </button>
      </div>
      <div data-testid="remote-window-gesture-guide" style={styles.gestureGuide}>{gestureGuide}</div>
      {moreOpen ? moreContent : null}
    </div>
  );
});
