import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { RemoteWindowIcon } from './remote-window-icons';
import { styles } from './remote-window-overlay-styles';

export interface RemoteWindowLockedToolbarProps {
  activeTitle: string;
  appSwitchContent: ReactNode;
  appSwitchOpen: boolean;
  dragHandleProps: HTMLAttributes<HTMLDivElement>;
  inputMode: 'touch' | 'mouse';
  inputSupported: boolean;
  mode: 'floating' | 'fullscreen';
  moreContent: ReactNode;
  moreOpen: boolean;
  screenshotBusy: boolean;
  screenshotButtonStyle: CSSProperties;
  targetKindLabel: string;
  onClose: () => void;
  onFullscreen: () => void;
  onRequestKeyboard: () => void;
  onScreenshot: () => void;
  onShrink: () => void;
  onToggleAppSwitch: () => void;
  onToggleInputMode: () => void;
  onToggleMore: () => void;
}

export const RemoteWindowLockedToolbar = forwardRef<HTMLDivElement, RemoteWindowLockedToolbarProps>(function RemoteWindowLockedToolbar({
  activeTitle,
  appSwitchContent,
  appSwitchOpen,
  dragHandleProps,
  inputMode,
  inputSupported,
  mode,
  moreContent,
  moreOpen,
  screenshotBusy,
  screenshotButtonStyle,
  targetKindLabel,
  onClose,
  onFullscreen,
  onRequestKeyboard,
  onScreenshot,
  onShrink,
  onToggleAppSwitch,
  onToggleInputMode,
  onToggleMore,
}, ref) {
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="远程窗口控制"
      data-testid="remote-window-locked-toolbar"
      style={styles.lockedToolbar}
    >
      <div {...dragHandleProps} data-testid="remote-window-drag-handle">
        <div style={styles.lockedTitle}>
          <span style={styles.targetKind}>{targetKindLabel}</span>
          <span style={styles.activeAppSwitch}>
            <button
              type="button"
              data-testid="remote-window-active-app-switch-button"
              data-no-drag="true"
              aria-label={`切换远程窗口，当前 ${activeTitle}`}
              aria-haspopup="listbox"
              aria-expanded={appSwitchOpen ? 'true' : 'false'}
              onClick={onToggleAppSwitch}
              style={styles.activeAppSwitchButton}
            >
              <span style={styles.activeAppSwitchTitle}>{activeTitle}</span>
              <RemoteWindowIcon name="chevronDown" />
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
          <button type="button" aria-label="关闭远程窗口" onClick={onClose} style={styles.headerCloseButton}>
            <RemoteWindowIcon name="close" />
          </button>
        </div>
      </div>
      <div data-testid="remote-window-control-strip" data-no-drag="true" style={styles.lockedControlStrip}>
        <button
          type="button"
          data-testid="remote-window-input-mode-toggle"
          data-no-drag="true"
          aria-label={inputMode === 'touch' ? '切换为鼠标模式' : '切换为触控模式'}
          onClick={onToggleInputMode}
          style={inputMode === 'touch' ? styles.headerModeButtonActive : styles.headerModeButton}
        >
          <span>{inputMode === 'touch' ? '触控' : '鼠标'}</span>
          <span data-testid="remote-window-input-mode" style={styles.inputModeStatus}>
            {inputSupported ? '可操作' : '只读'}
          </span>
        </button>
        <button
          type="button"
          data-no-drag="true"
          aria-label="截屏远程窗口"
          aria-busy={screenshotBusy ? 'true' : undefined}
          disabled={screenshotBusy}
          onClick={onScreenshot}
          style={screenshotButtonStyle}
        >
          <RemoteWindowIcon name="screenshot" />
        </button>
        <button
          type="button"
          data-no-drag="true"
          aria-label="调起远程窗口键盘"
          onClick={onRequestKeyboard}
          style={styles.headerIconButton}
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
          style={moreOpen
            ? { ...styles.headerIconButton, ...styles.headerIconButtonBusy }
            : styles.headerIconButton}
        >
          <RemoteWindowIcon name="more" />
        </button>
      </div>
      {moreContent}
    </div>
  );
});
