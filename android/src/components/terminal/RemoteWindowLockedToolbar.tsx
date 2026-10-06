import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RemoteWindowIcon } from './remote-window-icons';
import { styles } from './remote-window-overlay-styles';
import type { RemoteWindowVideoStatsSample } from '../../lib/remote-window-video-quality';
import { AmbientButton } from '../ambient';

interface RemoteWindowMoreAnchor {
  top: number;
  left: number;
  width: number;
}

export interface RemoteWindowStreamDebugInfo {
  frameSize: { width: number; height: number } | null;
  videoSize: { width: number; height: number } | null;
  fps: number | null;
  uplinkBps: number | null;
  downlinkBps: number | null;
  // Null until a quality ACK confirms the applied profile; never the draft cap.
  targetBps: number | null;
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
  streamStatusText: string;
  targetKindLabel: string;
  onClose: () => void;
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
  streamStatusText,
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const setRootRef = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    if (typeof ref === 'function') {
      ref(node);
    } else if (ref) {
      ref.current = node;
    }
  }, [ref]);
  const [moreAnchor, setMoreAnchor] = useState<RemoteWindowMoreAnchor | null>(null);
  const measureMoreAnchor = useCallback(() => {
    const node = rootRef.current;
    if (!node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    const next = {
      top: Math.round(rect.bottom),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
    };
    setMoreAnchor((current) => (
      current && current.top === next.top && current.left === next.left && current.width === next.width
        ? current
        : next
    ));
  }, []);
  // The floating overlay is bottom-anchored and clips with overflow:hidden, so
  // the settings sheet is portalled to the body and anchored to the toolbar.
  // Re-measure on every render (drag updates the overlay transform) and on
  // viewport scroll/resize.
  useLayoutEffect(() => {
    if (!moreOpen) {
      setMoreAnchor((current) => (current === null ? current : null));
      return;
    }
    measureMoreAnchor();
  });
  useEffect(() => {
    if (!moreOpen) {
      return;
    }
    window.addEventListener('resize', measureMoreAnchor);
    window.addEventListener('scroll', measureMoreAnchor, true);
    return () => {
      window.removeEventListener('resize', measureMoreAnchor);
      window.removeEventListener('scroll', measureMoreAnchor, true);
    };
  }, [moreOpen, measureMoreAnchor]);
  return (
    <div ref={setRootRef} data-testid="remote-window-locked-toolbar" style={styles.lockedToolbar}>
      <div {...dragHandleProps} data-testid="remote-window-drag-handle" style={styles.lockedTopBar}>
        <div style={styles.lockedTitle}>
            <span style={styles.targetKind}>{targetKindLabel}</span>
          <span style={styles.activeAppSwitch}>
            <AmbientButton
              type="button"
              data-testid="remote-window-active-app-switch-button"
              data-no-drag="true"
              aria-haspopup="listbox"
              aria-expanded={appSwitchOpen ? 'true' : 'false'}
              onClick={onToggleAppSwitch}
              style={styles.activeAppSwitchButton}
            >
              {activeTitle}
            </AmbientButton>
            {appSwitchOpen ? appSwitchContent : null}
          </span>
        </div>
        <div data-testid="remote-window-primary-actions" style={styles.lockedPrimaryActions}>
          {mode === 'fullscreen' ? (
            <AmbientButton type="button" aria-label="缩小远程窗口" onClick={onShrink} style={styles.headerIconButton}>
              <RemoteWindowIcon name="minimize" />
            </AmbientButton>
          ) : (
            <AmbientButton type="button" aria-label="全屏远程窗口" onClick={onFullscreen} style={styles.headerIconButton}>
              <RemoteWindowIcon name="fullscreen" />
            </AmbientButton>
          )}
          {/* The local exit lives in the persistent top bar so the control strip
              stays one compact row on narrow viewports and the exit is always
              reachable without scrolling the strip. */}
          <AmbientButton
            type="button"
            data-no-drag="true"
            data-testid="remote-window-exit-stream"
            aria-label="退出串流"
            onClick={onClose}
            style={styles.exitStreamButton}
            title="退出串流"
          >
            退出串流
          </AmbientButton>
        </div>
      </div>
      <div data-testid="remote-window-control-strip" data-no-drag="true" style={styles.lockedControlStrip}>
        <div data-testid="remote-window-input-group" style={styles.lockedControlGroup}>
          <span
            data-testid="remote-window-input-mode"
            aria-label={inputSupported ? '输入状态：可操作' : '输入状态：只读'}
            style={styles.inputModeBadge}
          >
            {inputSupported ? '可操作' : '只读'}
          </span>
          <AmbientButton
            type="button"
            data-testid="remote-window-input-mode-toggle"
            data-no-drag="true"
            aria-label={inputMode === 'touch' ? '切换为鼠标模式' : '切换为触控模式'}
            onClick={onToggleInputMode}
            style={inputMode === 'touch' ? styles.headerModeButtonActive : styles.headerModeButton}
            title={inputMode === 'touch' ? '切换为鼠标模式' : '切换为触控模式'}
          >
            {inputMode === 'touch' ? '触控' : '鼠标'}
          </AmbientButton>
        </div>
        <div data-testid="remote-window-tool-group" style={styles.lockedControlGroup}>
          <AmbientButton
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
          </AmbientButton>
          <AmbientButton
            type="button"
            data-no-drag="true"
            aria-label="调起远程窗口键盘"
            onClick={onRequestKeyboard}
            style={styles.headerIconButton}
            title="打开键盘"
          >
            <RemoteWindowIcon name="keyboard" />
          </AmbientButton>
          <AmbientButton
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
          </AmbientButton>
        </div>
      </div>
      <div data-testid="remote-window-toolbar-status" role="status" style={styles.compactStatusLine}>
        {mode === 'fullscreen' ? <span>{streamStatusText}</span> : null}
        <span data-testid="remote-window-gesture-guide" data-mode={mode} style={styles.gestureGuideInline}>{gestureGuide}</span>
      </div>
      {moreOpen && moreAnchor && typeof document !== 'undefined'
        ? createPortal(
            <div
              data-testid="remote-window-more-portal"
              data-no-drag="true"
              style={{
                ...styles.morePanelPortal,
                top: moreAnchor.top,
                left: moreAnchor.left,
                width: moreAnchor.width,
                ['--zterm-remote-window-more-max-height' as string]: `calc(100dvh - ${moreAnchor.top + 8}px)`,
              } as CSSProperties}
            >
              {moreContent}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});
