import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { mobileTheme } from '../../lib/mobile-ui';
import type {
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
} from '../../lib/types';
import {
  applyRemoteWindowTargetCatalog,
  beginRemoteWindowTargetEnumeration,
  closeRemoteWindowOverlay,
  enterRemoteWindowFullscreen,
  failRemoteWindowTargetCatalog,
  initialRemoteWindowOverlayState,
  selectRemoteWindowTarget,
  shrinkRemoteWindowOverlay,
  type RemoteWindowOverlayState,
} from '../../lib/remote-window-overlay-runtime';

interface RemoteWindowOverlayProps {
  activeSessionId?: string | null;
  requestTargets?: (sessionId: string) => Promise<RemoteWindowStreamTargetsResponsePayload>;
  bottomInsetPx?: number;
  onOpenStateChange?: (open: boolean) => void;
}

interface FloatingOverlayOffset {
  x: number;
  y: number;
}

interface FloatingOverlayDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startOffset: FloatingOverlayOffset;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const FLOATING_OVERLAY_VIEWPORT_MARGIN_PX = 8;

function clampFloatingOffset(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatTargetKind(target: RemoteWindowStreamTargetManifest) {
  return target.videoTarget.kind === 'iterm2-pane' ? 'iTerm2 Pane' : 'App Window';
}

function formatInputRoute(target: RemoteWindowStreamTargetManifest) {
  switch (target.inputRoute) {
    case 'tmux-input':
      return 'tmux';
    case 'iterm2-api':
      return 'iTerm2 API';
    case 'os-event':
      return 'OS event';
  }
}

function formatTargetSubtitle(target: RemoteWindowStreamTargetManifest) {
  const tmux = target.inputTarget.tmuxSession
    ? `tmux ${target.inputTarget.tmuxSession}${target.inputTarget.tmuxPaneId ? ` ${target.inputTarget.tmuxPaneId}` : ''}`
    : '';
  const geometry = target.videoTarget.cropRectTopLeftPx || target.videoTarget.windowBoundsTopLeftPx;
  const route = formatInputRoute(target);
  return [tmux, `${geometry.width}x${geometry.height}`, route].filter(Boolean).join(' · ');
}

function renderErrors(errors: RemoteWindowStreamErrorPayload[]) {
  if (errors.length === 0) {
    return null;
  }
  return (
    <div data-testid="remote-window-partial-errors" style={styles.errorStrip}>
      {errors.map((error) => (
        <div key={`${error.requestId}:${error.code}:${error.message}`}>
          {error.code}: {error.message}
        </div>
      ))}
    </div>
  );
}

export const RemoteWindowOverlay = memo(function RemoteWindowOverlay({
  activeSessionId,
  requestTargets,
  bottomInsetPx = 0,
  onOpenStateChange,
}: RemoteWindowOverlayProps) {
  const [state, setState] = useState<RemoteWindowOverlayState>(initialRemoteWindowOverlayState);
  const [floatingOffset, setFloatingOffsetState] = useState<FloatingOverlayOffset>({ x: 0, y: 0 });
  const floatingOffsetRef = useRef(floatingOffset);
  const floatingOverlayRef = useRef<HTMLDivElement | null>(null);
  const floatingDragRef = useRef<FloatingOverlayDrag | null>(null);
  const lastTouchEndAtRef = useRef(0);
  const lastReportedOpenRef = useRef<boolean | null>(null);
  const overlayOpen = state.phase !== 'closed';

  const setFloatingOffset = useCallback((next: FloatingOverlayOffset) => {
    floatingOffsetRef.current = next;
    setFloatingOffsetState(next);
  }, []);

  const handleOpenPicker = useCallback(() => {
    const started = beginRemoteWindowTargetEnumeration(state);
    setState(started.state);
    const targetSessionId = activeSessionId?.trim() || '';
    if (!targetSessionId || !requestTargets) {
      setState((current) => (
        failRemoteWindowTargetCatalog(current, started.requestEpoch, new Error('当前没有可用的 daemon session'))
      ));
      return;
    }

    void requestTargets(targetSessionId)
      .then((payload) => {
        setState((current) => applyRemoteWindowTargetCatalog(current, started.requestEpoch, payload));
      })
      .catch((error) => {
        setState((current) => failRemoteWindowTargetCatalog(current, started.requestEpoch, error));
      });
  }, [activeSessionId, requestTargets, state]);

  const handleClose = useCallback(() => {
    floatingDragRef.current = null;
    setFloatingOffset({ x: 0, y: 0 });
    setState((current) => closeRemoteWindowOverlay(current));
  }, [setFloatingOffset]);

  const handleShrink = useCallback(() => {
    setState((current) => shrinkRemoteWindowOverlay(current));
  }, []);

  const handleFullscreen = useCallback(() => {
    setState((current) => enterRemoteWindowFullscreen(current));
  }, []);

  const handleFloatingDragStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      state.phase !== 'targetLocked'
      || state.mode !== 'floating'
      || (event.pointerType === 'mouse' && event.button !== 0)
      || (event.target instanceof Element && event.target.closest('button'))
    ) {
      return;
    }
    const overlay = floatingOverlayRef.current;
    if (!overlay) {
      return;
    }
    const rect = overlay.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width || window.innerWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const startOffset = floatingOffsetRef.current;
    floatingDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffset,
      minX: startOffset.x + FLOATING_OVERLAY_VIEWPORT_MARGIN_PX - rect.left,
      maxX: startOffset.x + viewportWidth - FLOATING_OVERLAY_VIEWPORT_MARGIN_PX - rect.right,
      minY: startOffset.y + FLOATING_OVERLAY_VIEWPORT_MARGIN_PX - rect.top,
      maxY: startOffset.y + viewportHeight - FLOATING_OVERLAY_VIEWPORT_MARGIN_PX - rect.bottom,
    };
    event.preventDefault();
    event.stopPropagation();
  }, [state]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = floatingDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      setFloatingOffset({
        x: clampFloatingOffset(
          drag.startOffset.x + event.clientX - drag.startClientX,
          drag.minX,
          drag.maxX,
        ),
        y: clampFloatingOffset(
          drag.startOffset.y + event.clientY - drag.startClientY,
          drag.minY,
          drag.maxY,
        ),
      });
    };
    const handlePointerEnd = (event: PointerEvent) => {
      if (floatingDragRef.current?.pointerId === event.pointerId) {
        floatingDragRef.current = null;
      }
    };
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      floatingDragRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [setFloatingOffset]);

  useEffect(() => {
    if (lastReportedOpenRef.current === overlayOpen) {
      return;
    }
    lastReportedOpenRef.current = overlayOpen;
    onOpenStateChange?.(overlayOpen);
  }, [onOpenStateChange, overlayOpen]);

  useEffect(() => () => {
    lastReportedOpenRef.current = false;
    onOpenStateChange?.(false);
  }, [onOpenStateChange]);

  useEffect(() => {
    if (state.phase !== 'targetLocked' || state.mode !== 'fullscreen') {
      return;
    }
    let disposed = false;
    let listenerHandle: { remove: () => Promise<void> | void } | null = null;
    void Promise.resolve(CapacitorApp.addListener('backButton', handleShrink))
      .then((handle) => {
        if (disposed) {
          void handle.remove();
          return;
        }
        listenerHandle = handle;
      })
      .catch((error) => {
        console.error('[RemoteWindowOverlay] backButton listener failed:', error);
      });
    return () => {
      disposed = true;
      if (listenerHandle) {
        void listenerHandle.remove();
      }
    };
  }, [handleShrink, state]);

  const pickerContent = useMemo(() => {
    if (state.phase !== 'targetEnumerating' && state.phase !== 'pickerOpen') {
      return null;
    }
    return (
      <div data-testid="remote-window-picker" style={styles.pickerPanel}>
        <div style={styles.panelHeader}>
          <div>
            <div style={styles.panelTitle}>远程窗口</div>
            <div style={styles.panelSubtitle}>
              {state.phase === 'targetEnumerating' ? '正在读取窗口列表' : `${state.targets.length} 个目标`}
            </div>
          </div>
          <div style={styles.panelActions}>
            <button type="button" aria-label="刷新远程窗口列表" onClick={handleOpenPicker} style={styles.headerButton}>
              刷新
            </button>
            <button type="button" aria-label="关闭远程窗口选择" onClick={handleClose} style={styles.headerIconButton}>
              x
            </button>
          </div>
        </div>
        {state.phase === 'pickerOpen' && state.errorMessage ? (
          <div data-testid="remote-window-picker-error" style={styles.errorBox}>{state.errorMessage}</div>
        ) : null}
        {state.phase === 'pickerOpen' ? renderErrors(state.errors) : null}
        <div style={styles.targetList}>
          {state.phase === 'targetEnumerating' ? (
            <div data-testid="remote-window-picker-loading" style={styles.emptyState}>读取中</div>
          ) : state.targets.length === 0 ? (
            <div data-testid="remote-window-picker-empty" style={styles.emptyState}>没有可选窗口</div>
          ) : (
            state.targets.map((target) => (
              <button
                key={target.streamTargetId}
                type="button"
                data-testid={`remote-window-target-${target.streamTargetId}`}
                onClick={() => {
                  setFloatingOffset({ x: 0, y: 0 });
                  setState((current) => selectRemoteWindowTarget(current, target.streamTargetId));
                }}
                style={styles.targetRow}
              >
                <span style={styles.targetKind}>{formatTargetKind(target)}</span>
                <span style={styles.targetMain}>{target.videoTarget.title || target.videoTarget.appBundleId}</span>
                <span style={styles.targetMeta}>{formatTargetSubtitle(target)}</span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }, [handleClose, handleOpenPicker, state]);

  const lockedContent = state.phase === 'targetLocked' ? (
    <div
      ref={floatingOverlayRef}
      data-testid="remote-window-locked-overlay"
      data-mode={state.mode}
      style={state.mode === 'fullscreen'
        ? styles.fullscreenOverlay
        : {
            ...styles.floatingOverlay,
            transform: `translate(${floatingOffset.x}px, ${floatingOffset.y}px)`,
          }}
    >
      <div
        data-testid="remote-window-drag-handle"
        onPointerDown={handleFloatingDragStart}
        style={{
          ...styles.lockedToolbar,
          cursor: state.mode === 'floating' ? 'move' : 'default',
          touchAction: state.mode === 'floating' ? 'none' : 'auto',
          userSelect: 'none',
        }}
      >
        <div style={styles.lockedTitle}>
          <span style={styles.targetKind}>{formatTargetKind(state.target)}</span>
          <span>{state.target.videoTarget.title || state.target.videoTarget.appBundleId}</span>
        </div>
        <div style={styles.lockedActions}>
          {state.mode === 'fullscreen' ? (
            <button type="button" aria-label="缩小远程窗口" onClick={handleShrink} style={styles.headerIconButton}>
              -
            </button>
          ) : null}
          <button type="button" aria-label="关闭远程窗口" onClick={handleClose} style={styles.headerIconButton}>
            x
          </button>
        </div>
      </div>
      <div
        data-testid="remote-window-video-surface"
        onDoubleClick={handleFullscreen}
        onTouchEnd={() => {
          const now = Date.now();
          if (now - lastTouchEndAtRef.current < 300) {
            handleFullscreen();
          }
          lastTouchEndAtRef.current = now;
        }}
        style={styles.videoPlaceholder}
      >
        <div style={styles.videoFrame}>
          <div style={styles.videoStatus}>等待视频流</div>
          <div style={styles.videoMeta}>{formatTargetSubtitle(state.target)}</div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      {state.phase === 'closed' ? (
        <button
          type="button"
          data-testid="remote-window-entry"
          aria-label="打开远程窗口"
          onClick={handleOpenPicker}
          style={{
            ...styles.entryButton,
            bottom: `${Math.max(92, 92 + Math.max(0, bottomInsetPx))}px`,
          }}
        >
          窗
        </button>
      ) : null}
      {pickerContent}
      {lockedContent}
    </>
  );
});

const styles: Record<string, CSSProperties> = {
  entryButton: {
    position: 'absolute',
    right: 14,
    zIndex: 22,
    width: 44,
    height: 44,
    borderRadius: 14,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(15, 23, 38, 0.9)',
    color: mobileTheme.colors.accent,
    fontWeight: 900,
    fontSize: 16,
    boxShadow: '0 12px 24px rgba(0,0,0,0.28)',
    backdropFilter: 'blur(10px)',
  },
  pickerPanel: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 'calc(env(safe-area-inset-top, 0px) + 58px)',
    maxHeight: 'min(70vh, 560px)',
    zIndex: 31,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: 16,
    border: '1px solid rgba(151, 164, 186, 0.22)',
    background: 'rgba(13, 19, 31, 0.96)',
    color: '#edf4ff',
    boxShadow: '0 24px 60px rgba(0,0,0,0.42)',
    backdropFilter: 'blur(14px)',
  },
  panelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    padding: '14px 14px 10px',
    borderBottom: '1px solid rgba(151, 164, 186, 0.16)',
  },
  panelTitle: {
    fontSize: 15,
    fontWeight: 900,
    letterSpacing: 0,
  },
  panelSubtitle: {
    marginTop: 3,
    fontSize: 12,
    color: 'rgba(237,244,255,0.62)',
  },
  panelActions: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
  },
  headerButton: {
    minHeight: 32,
    padding: '0 12px',
    borderRadius: 10,
    border: '1px solid rgba(151, 164, 186, 0.18)',
    background: 'rgba(36, 48, 72, 0.84)',
    color: '#edf4ff',
    fontWeight: 850,
  },
  headerIconButton: {
    width: 32,
    height: 32,
    borderRadius: 10,
    border: '1px solid rgba(151, 164, 186, 0.18)',
    background: 'rgba(36, 48, 72, 0.84)',
    color: '#edf4ff',
    fontWeight: 900,
  },
  errorBox: {
    margin: '10px 12px 0',
    padding: '9px 10px',
    borderRadius: 10,
    background: 'rgba(109, 24, 33, 0.82)',
    color: '#ffd7dc',
    fontSize: 12,
    lineHeight: 1.4,
  },
  errorStrip: {
    margin: '10px 12px 0',
    padding: '8px 10px',
    borderRadius: 10,
    background: 'rgba(97, 63, 13, 0.72)',
    color: '#ffe2a8',
    fontSize: 12,
    lineHeight: 1.4,
  },
  targetList: {
    padding: 10,
    overflowY: 'auto',
    display: 'grid',
    gap: 8,
  },
  targetRow: {
    display: 'grid',
    gridTemplateColumns: '86px minmax(0, 1fr)',
    gap: '4px 10px',
    padding: '10px 11px',
    textAlign: 'left',
    borderRadius: 12,
    border: '1px solid rgba(151, 164, 186, 0.14)',
    background: 'rgba(27, 37, 56, 0.88)',
    color: '#edf4ff',
  },
  targetKind: {
    color: mobileTheme.colors.accent,
    fontSize: 11,
    fontWeight: 900,
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  targetMain: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 13,
    fontWeight: 850,
  },
  targetMeta: {
    gridColumn: '2 / 3',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'rgba(237,244,255,0.62)',
    fontSize: 11,
  },
  emptyState: {
    minHeight: 84,
    display: 'grid',
    placeItems: 'center',
    color: 'rgba(237,244,255,0.62)',
    fontSize: 13,
  },
  floatingOverlay: {
    position: 'absolute',
    right: 12,
    bottom: 118,
    zIndex: 32,
    width: 'min(78vw, 360px)',
    aspectRatio: '16 / 10',
    borderRadius: 16,
    overflow: 'hidden',
    border: '1px solid rgba(151, 164, 186, 0.22)',
    background: '#050910',
    color: '#edf4ff',
    boxShadow: '0 24px 60px rgba(0,0,0,0.46)',
  },
  fullscreenOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 90,
    display: 'flex',
    flexDirection: 'column',
    background: '#02050a',
    color: '#edf4ff',
  },
  lockedToolbar: {
    minHeight: 42,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    padding: '7px 8px',
    background: 'rgba(13, 19, 31, 0.94)',
    borderBottom: '1px solid rgba(151, 164, 186, 0.14)',
  },
  lockedTitle: {
    minWidth: 0,
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
    fontWeight: 850,
  },
  lockedActions: {
    display: 'flex',
    gap: 6,
  },
  videoPlaceholder: {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    placeItems: 'center',
    padding: 10,
  },
  videoFrame: {
    width: '100%',
    height: '100%',
    display: 'grid',
    placeItems: 'center',
    alignContent: 'center',
    gap: 8,
    border: '1px solid rgba(151, 164, 186, 0.12)',
    background: 'rgba(10, 16, 26, 0.82)',
  },
  videoStatus: {
    fontSize: 14,
    fontWeight: 900,
    color: '#edf4ff',
  },
  videoMeta: {
    maxWidth: '90%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 11,
    color: 'rgba(237,244,255,0.62)',
  },
};
