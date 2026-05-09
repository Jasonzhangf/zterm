import { memo as ReactMemo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Keyboard } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { TerminalView } from '../components/TerminalView';
import type { SessionRenderBufferStore } from '../lib/session-render-buffer-store';
import type { SessionHeadStore } from '../lib/session-head-store';
import { createSessionViewportModeStore, useSessionViewportModeSnapshot, type SessionViewportModeStore } from '../lib/session-viewport-mode-store';
import { SessionScheduleSheet } from '../components/terminal/SessionScheduleSheet';
import { FileTransferSheet } from '../components/terminal/FileTransferSheet';
import { RemoteScreenshotSheet } from '../components/terminal/RemoteScreenshotSheet';
import { TerminalHeader } from '../components/terminal/TerminalHeader';
import { TabManagerSheet } from '../components/terminal/TabManagerSheet';
import { TerminalQuickBar } from '../components/terminal/TerminalQuickBar';
import { APP_VERSION, APP_VERSION_CODE } from '../lib/app-version';
import { getBrowserStorage } from '../lib/browser-storage';
import { mobileTheme } from '../lib/mobile-ui';
import { ImeAnchor } from '../plugins/ImeAnchorPlugin';
import { registerClientDebugSnapshotSource } from '../lib/client-debug-snapshot';
import { useTerminalWorkspace } from '../hooks/useTerminalWorkspace';
import { normalizeTerminalCommittedText } from '../lib/terminal-input-normalization';
import { resolveTerminalLayoutProfile } from '../lib/terminal-layout-profile';
import { resolveTerminalOrientation } from '../lib/terminal-viewport-metrics';
import { resolveTerminalViewportMetrics } from '../lib/terminal-viewport-metrics';
import {
  createRemoteScreenshotPreviewRuntime,
  persistRemoteScreenshotCaptureRuntime,
  resolveRemoteScreenshotQuickBarStatus,
  type RemoteScreenshotPreviewState,
} from '../lib/remote-screenshot-preview-runtime';
import {
  STORAGE_KEYS,
  type AndroidWorkspacePane,
  type PersistedOpenTab,
  type QuickAction,
  type RemoteScreenshotCapture,
  type RemoteScreenshotStatusPayload,
  type SavedTabList,
  type Session,
  type SessionDebugOverlayMetrics,
  type SessionScheduleState,
  type ScheduleJobDraft,
  type TerminalResizeHandler,
  type TerminalShortcutAction,
  type TerminalViewportChangeHandler,
  type TerminalWidthMode,
} from '../lib/types';

type VirtualKeyboardApi = {
  overlaysContent: boolean;
  boundingRect: DOMRectReadOnly;
  addEventListener: (type: 'geometrychange', listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: 'geometrychange', listener: EventListenerOrEventListenerObject) => void;
};

const NETWORK_BANNER_GRACE_MS = 3000;
const TERMINAL_QUICK_BAR_RENDER_LIFT_PX = 64;

function logAsyncCleanupFailure(scope: string, error: unknown) {
  console.warn(`[TerminalPage] ${scope} failed:`, error);
}

const TerminalQuickBarShell = ReactMemo(function TerminalQuickBarShell({
  bottomPx,
  children,
}: {
  bottomPx: number;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="terminal-quickbar-shell"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: `${bottomPx}px`,
        zIndex: 10,
      }}
    >
      {children}
    </div>
  );
});

const TerminalNetworkBanner = ReactMemo(function TerminalNetworkBanner({
  connectionIssueVisible,
  networkOnline,
  activeSessionState,
  activeSessionLastError,
}: {
  connectionIssueVisible: boolean;
  networkOnline: boolean;
  activeSessionState: Session['state'] | null | undefined;
  activeSessionLastError?: string;
}) {
  const networkBanner = !connectionIssueVisible
    ? null
    : !networkOnline
      ? {
          tone: '#ff6b6b',
          background: 'rgba(109, 24, 33, 0.92)',
          border: 'rgba(255, 107, 107, 0.42)',
          title: '网络已断开',
          detail: '当前网络不可用，终端不会继续刷新。',
        }
      : activeSessionState === 'reconnecting'
        ? {
            tone: '#ffb020',
            background: 'rgba(97, 63, 13, 0.92)',
            border: 'rgba(255, 176, 32, 0.42)',
            title: '连接已断开，正在重连',
            detail: activeSessionLastError || '网络或 daemon 连接已中断，正在指数退避重试。',
          }
        : activeSessionState === 'error'
          ? {
              tone: '#ff6b6b',
              background: 'rgba(109, 24, 33, 0.92)',
              border: 'rgba(255, 107, 107, 0.42)',
              title: '连接失败',
              detail: activeSessionLastError || '当前 tab 已断开，请检查网络或服务器状态。',
            }
          : null;

  if (!networkBanner) {
    return null;
  }

  return (
    <div
      data-testid="terminal-network-banner"
      style={{
        margin: '0 10px 8px',
        padding: '9px 12px',
        borderRadius: '12px',
        border: `1px solid ${networkBanner.border}`,
        background: networkBanner.background,
        color: '#fff',
        boxShadow: '0 10px 24px rgba(0,0,0,0.18)',
      }}
    >
      <div style={{ fontSize: '13px', fontWeight: 800, color: networkBanner.tone }}>
        {networkBanner.title}
      </div>
      <div style={{ marginTop: '3px', fontSize: '12px', lineHeight: 1.35, color: 'rgba(255,255,255,0.9)' }}>
        {networkBanner.detail}
      </div>
    </div>
  );
});

export function resolveKeyboardLiftPx(
  reportedKeyboardInset: number,
  layoutViewportHeightOverride?: number,
) {
  const safeReportedInset = Math.max(0, Math.round(reportedKeyboardInset || 0));
  if (safeReportedInset <= 0 || typeof window === 'undefined') {
    return 0;
  }

  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return safeReportedInset;
  }

  const visualViewportHeight = Math.max(0, Math.round(visualViewport.height || 0));
  const visualViewportOffsetTop = Math.max(0, Math.round(visualViewport.offsetTop || 0));
  const visualViewportBottom = Math.max(0, visualViewportHeight + visualViewportOffsetTop);
  const layoutViewportHeight = Math.max(
    0,
    Math.round(layoutViewportHeightOverride ?? resolveLayoutViewportHeight()),
  );
  const occludedBottom = Math.max(0, layoutViewportHeight - visualViewportBottom);

  if (occludedBottom <= 0) {
    return safeReportedInset;
  }

  return Math.min(safeReportedInset, occludedBottom);
}

export function resolveLayoutViewportHeight() {
  return resolveTerminalViewportMetrics().layoutHeight;
}

export function resolveTerminalHeaderTopInsetPx(isAndroid: boolean) {
  if (typeof window === 'undefined') {
    return isAndroid ? 16 : 0;
  }

  if (!isAndroid) {
    return Math.max(0, Math.round(window.visualViewport?.offsetTop || 0));
  }

  return 16;
}

function resolveWindowWidth() {
  return resolveTerminalViewportMetrics().layoutWidth;
}

interface TerminalPageProps {
  sessions: Session[];
  activeSession: Session | null;
  getSessionDebugMetrics?: (sessionId: string) => SessionDebugOverlayMetrics | null;
  sessionBufferStore?: SessionRenderBufferStore | null;
  sessionHeadStore?: SessionHeadStore | null;
  inputResetEpochBySession?: Record<string, number>;
  followResetEpoch?: number;
  onSwitchSession: (id: string) => void;
  onMoveSession: (id: string, toIndex: number) => void;
  onRenameSession: (id: string, name: string) => void;
  onCloseSession: (id: string, source?: string) => void;
  onOpenConnections: () => void;
  onOpenQuickTabPicker: (paneId?: string) => void;
  pendingPaneAttachIntent?: { sessionIds: string[]; paneId: string; nonce: number } | null;
  onPaneAttachIntentApplied?: (intent: { sessionIds: string[]; paneId: string; nonce: number }) => void;
  onResize?: TerminalResizeHandler;
  onTerminalInput?: (sessionId: string, data: string) => void;
  onTerminalViewportChange?: TerminalViewportChangeHandler;
  onLiveSessionIdsChange?: (ids: string[]) => void;
  onImagePaste?: (sessionId: string, file: File) => Promise<void> | void;
  onFileAttach?: (sessionId: string, file: File) => Promise<void> | void;
  onOpenSettings?: () => void;
  onRequestRemoteScreenshot?: (
    sessionId: string,
    onProgress?: (progress: RemoteScreenshotStatusPayload) => void,
  ) => Promise<RemoteScreenshotCapture>;
  quickActions: QuickAction[];
  shortcutActions: TerminalShortcutAction[];
  onQuickActionInput?: (sequence: string, sessionId?: string) => void;
  onQuickActionsChange?: (actions: QuickAction[]) => void;
  onShortcutActionsChange?: (actions: TerminalShortcutAction[]) => void;
  sessionDraft: string;
  onSessionDraftChange?: (value: string, sessionId?: string) => void;
  onSessionDraftSend?: (value: string, sessionId?: string) => void;
  onLoadSavedTabList: (tabs: PersistedOpenTab[], activeSessionId?: string) => void;
  scheduleState?: SessionScheduleState | null;
  onRequestScheduleList?: (sessionId: string) => void;
  onUpsertScheduleJob?: (sessionId: string, job: ScheduleJobDraft) => void;
  onDeleteScheduleJob?: (sessionId: string, jobId: string) => void;
  onToggleScheduleJob?: (sessionId: string, jobId: string, enabled: boolean) => void;
  onRunScheduleJobNow?: (sessionId: string, jobId: string) => void;
  terminalThemeId?: string;
  terminalWidthMode?: TerminalWidthMode;
  onTerminalWidthModeChange?: (sessionId: string, mode: TerminalWidthMode, cols?: number | null) => void;
  onSendMessage?: (sessionId: string, msg: any) => void;
  onFileTransferMessage?: (handler: (msg: any) => void) => () => void;
  shortcutSmartSort?: boolean;
  shortcutFrequencyMap?: Record<string, number>;
  onShortcutUse?: (shortcutId: string) => void;
}

interface ScheduleComposerSeed {
  nonce: number;
  text: string;
}

interface TerminalTabChromeItem {
  id: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  customName?: string;
  resolvedPath?: Session['resolvedPath'];
}

function terminalPageRenderedSessionUiKey(
  session: Session | null | undefined,
) {
  if (!session) {
    return '';
  }
  return [
    session.id,
    session.hostId,
    session.connectionName,
    session.bridgeHost,
    String(session.bridgePort),
    session.sessionName,
    session.customName || '',
    session.resolvedPath || '',
  ].join('::');
}

function terminalPageRenderedSessionsUiKey(sessions: Session[]) {
  return sessions.map((session) => terminalPageRenderedSessionUiKey(session)).join('||');
}

function terminalPageHeaderSessionUiKey(session: Session | null | undefined) {
  if (!session) {
    return '';
  }
  return [
    session.id,
    session.bridgeHost,
    String(session.bridgePort),
    session.sessionName,
    session.customName || '',
    session.resolvedPath || '',
  ].join('::');
}

function terminalPageHeaderSessionsUiKey(sessions: Session[]) {
  return sessions.map((session) => terminalPageHeaderSessionUiKey(session)).join('||');
}

function terminalPageActiveRuntimeStatusKey(session: Session | null | undefined) {
  if (!session) {
    return '';
  }
  return [
    session.id,
    session.state,
    session.lastError || '',
  ].join('::');
}

function resolveSessionInputEpoch(
  inputResetEpochBySession: Record<string, number> | undefined,
  sessionId: string | null | undefined,
) {
  if (!sessionId) {
    return -1;
  }
  return inputResetEpochBySession?.[sessionId] || 0;
}

function resolveRenderedSessionsInputEpochKey(
  inputResetEpochBySession: Record<string, number> | undefined,
  sessions: Session[],
) {
  return sessions
    .map((session) => `${session.id}:${resolveSessionInputEpoch(inputResetEpochBySession, session.id)}`)
    .join('||');
}

function toTerminalTabChromeItem(session: Session): TerminalTabChromeItem {
  return {
    id: session.id,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    customName: session.customName,
    resolvedPath: session.resolvedPath,
  };
}

const TerminalDebugOverlay = ReactMemo(function TerminalDebugOverlay({
  visible,
  session,
  sessionViewportModeStore,
  getSessionDebugMetrics,
  debugOverlayPos,
  debugOverlayDragRef,
  onClose,
  onMove,
}: {
  visible: boolean;
  session: Session | null;
  sessionViewportModeStore: SessionViewportModeStore;
  getSessionDebugMetrics?: (sessionId: string) => SessionDebugOverlayMetrics | null;
  debugOverlayPos: { x: number; y: number };
  debugOverlayDragRef: React.MutableRefObject<{
    startX: number;
    startY: number;
    startPosX: number;
    startPosY: number;
    dragging: boolean;
  }>;
  onClose: () => void;
  onMove: (next: { x: number; y: number }) => void;
}) {
  const [tick, setTick] = useState(0);
  const viewportModeSnapshot = useSessionViewportModeSnapshot(sessionViewportModeStore, session?.id || null);

  useEffect(() => {
    if (!visible || !session) {
      return;
    }
    const timer = window.setInterval(() => {
      setTick((value) => value + 1);
    }, 500);
    return () => window.clearInterval(timer);
  }, [session, visible]);

  void tick;

  if (!visible || !session) {
    return null;
  }

  const metrics = getSessionDebugMetrics ? (getSessionDebugMetrics(session.id) || undefined) : undefined;
  const status = resolveDebugStatus(session, metrics);
  const viewportMode = viewportModeSnapshot.mode;
  const overlayStyle: React.CSSProperties = {
    position: 'absolute',
    top: debugOverlayPos.y >= 0 ? `${debugOverlayPos.y}px` : '10px',
    left: debugOverlayPos.x >= 0 ? `${debugOverlayPos.x}px` : undefined,
    right: debugOverlayPos.x >= 0 ? undefined : '10px',
    zIndex: 12,
    minWidth: '88px',
    maxWidth: '96px',
    padding: '5px 6px',
    borderRadius: '10px',
    border: `1.5px solid ${metrics?.bufferPullActive ? 'rgba(34, 197, 94, 0.6)' : 'rgba(83, 139, 255, 0.6)'}`,
    background: 'rgba(10, 16, 26, 0.35)',
    boxShadow: '0 8px 18px rgba(0, 0, 0, 0.10)',
    color: 'rgba(231, 238, 252, 0.78)',
    fontSize: '8px',
    lineHeight: 1.25,
    backdropFilter: 'blur(8px)',
    pointerEvents: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  };

  return (
    <div
      style={overlayStyle}
      onTouchStart={(e) => {
        const touch = e.touches[0];
        debugOverlayDragRef.current = {
          startX: touch.clientX,
          startY: touch.clientY,
          startPosX: debugOverlayPos.x >= 0 ? debugOverlayPos.x : (window.innerWidth - 10 - 96),
          startPosY: debugOverlayPos.y >= 0 ? debugOverlayPos.y : 10,
          dragging: false,
        };
      }}
      onTouchMove={(e) => {
        const touch = e.touches[0];
        const dx = touch.clientX - debugOverlayDragRef.current.startX;
        const dy = touch.clientY - debugOverlayDragRef.current.startY;
        if (!debugOverlayDragRef.current.dragging && Math.abs(dx) + Math.abs(dy) < 8) return;
        debugOverlayDragRef.current.dragging = true;
        e.preventDefault();
        const newX = debugOverlayDragRef.current.startPosX + dx;
        const newY = debugOverlayDragRef.current.startPosY + dy;
        const clampedX = Math.max(0, Math.min(newX, window.innerWidth - 96));
        const clampedY = Math.max(0, Math.min(newY, window.innerHeight - 80));
        onMove({ x: clampedX, y: clampedY });
      }}
      onTouchEnd={() => {
        debugOverlayDragRef.current.dragging = false;
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px', fontWeight: 700 }}>
        <span>状态</span>
        <button
          type="button"
          aria-label="关闭调试浮窗"
          onClick={onClose}
          style={{
            width: '12px',
            height: '12px',
            padding: 0,
            border: 'none',
            borderRadius: '999px',
            background: 'rgba(255,255,255,0.12)',
            color: '#e7eefc',
            fontSize: '9px',
            lineHeight: '12px',
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', fontWeight: 700 }}>
        <span>渲染</span>
        <span style={{ color: viewportMode === 'reading' ? '#fbbf24' : '#93c5fd' }}>{viewportMode}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', fontWeight: 700 }}>
        <span>状态</span>
        <span style={{ color: metrics?.bufferPullActive ? '#86efac' : '#93c5fd' }}>{status}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', fontWeight: 700 }}>
        <span>A</span>
        <span
          data-testid="terminal-debug-active-flag"
          style={{ color: metrics?.active ? '#86efac' : '#fca5a5' }}
        >
          {metrics?.active ? '1' : '0'}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>↑</span>
        <span>{formatDebugRate(metrics?.uplinkBps || 0)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>↓</span>
        <span>{formatDebugRate(metrics?.downlinkBps || 0)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>R</span>
        <span>{formatDebugHz(metrics?.renderHz || 0)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>P</span>
        <span>{formatDebugHz(metrics?.pullHz || 0)}</span>
      </div>
      <div
        style={{
          marginTop: '2px',
          paddingTop: '2px',
          borderTop: '1px solid rgba(255,255,255,0.10)',
          color: 'rgba(231, 238, 252, 0.65)',
          fontSize: '7px',
          lineHeight: 1.2,
          wordBreak: 'break-all',
        }}
      >
        V {APP_VERSION} / {APP_VERSION_CODE}
      </div>
    </div>
  );
});

const TerminalStageShell = ReactMemo(function TerminalStageShell({
  interactiveSession,
  sessionBufferStore,
  sessionHeadStore,
  renderedPaneSessions,
  visiblePaneEntries,
  splitVisible,
  activePaneId,
  terminalChromeBottomPx,
  terminalImeLiftPx,
  inputResetEpochBySession,
  followResetEpoch,
  terminalKeyboardRequested,
  isAndroid,
  onResize,
  onTerminalInput,
  onTerminalWidthModeChange,
  handleTerminalViewportChange,
  handleSwipeTab,
  handleActiveTerminalActivateInput,
  onActivatePane,
  focusNonce,
  terminalFontSize,
  terminalThemeId,
  terminalWidthMode,
  absoluteLineNumbersVisible,
}: {
  interactiveSession: Session | null;
  sessionBufferStore?: SessionRenderBufferStore | null;
  sessionHeadStore?: SessionHeadStore | null;
  renderedPaneSessions: Session[];
  visiblePaneEntries: { pane: AndroidWorkspacePane; paneIndex: number; session: Session }[];
  splitVisible: boolean;
  activePaneId: string;
  terminalChromeBottomPx: number;
  terminalImeLiftPx: number;
  inputResetEpochBySession?: Record<string, number>;
  followResetEpoch?: number;
  terminalKeyboardRequested: boolean;
  isAndroid: boolean;
  onResize?: TerminalResizeHandler;
  onTerminalInput?: (sessionId: string, data: string) => void;
  onTerminalWidthModeChange?: (sessionId: string, mode: TerminalWidthMode, cols?: number | null) => void;
  handleTerminalViewportChange: TerminalViewportChangeHandler;
  handleSwipeTab: (sessionId: string, direction: 'previous' | 'next') => void;
  handleActiveTerminalActivateInput: () => void;
  onActivatePane?: (paneId: string) => void;
  focusNonce: number;
  terminalFontSize: number;
  terminalThemeId?: string;
  terminalWidthMode: TerminalWidthMode;
  absoluteLineNumbersVisible: boolean;
}) {
  const landscape = typeof window !== 'undefined' ? resolveTerminalOrientation() === 'landscape' : false;
  const layoutProfile = useMemo(() => resolveTerminalLayoutProfile({ splitVisible, landscape }), [landscape, splitVisible]);

  const renderTerminal = useCallback((session: Session, sessionIsActive: boolean, renderInstanceKey?: string) => (
    <TerminalView
      key={renderInstanceKey || session.id}
      sessionId={session.id}
      sessionBufferStore={sessionBufferStore}
      sessionHeadStore={sessionHeadStore}
      active={sessionIsActive}
      live
      inputResetEpoch={inputResetEpochBySession?.[session.id] || 0}
      followResetEpoch={sessionIsActive ? followResetEpoch : 0}
      allowDomFocus={isAndroid ? false : sessionIsActive && terminalKeyboardRequested}
      domInputOffscreen={isAndroid}
      onActivateInput={isAndroid && sessionIsActive ? handleActiveTerminalActivateInput : undefined}
      onResize={sessionIsActive && (terminalWidthMode === 'adaptive-phone' || !isAndroid) ? onResize : undefined}
      onWidthModeChange={sessionIsActive ? onTerminalWidthModeChange : undefined}
      onInput={sessionIsActive ? onTerminalInput : undefined}
      onViewportChange={handleTerminalViewportChange}
      onSwipeTab={sessionIsActive ? handleSwipeTab : undefined}
      focusNonce={isAndroid ? 0 : sessionIsActive ? focusNonce : 0}
      fontSize={terminalFontSize}
      rowHeight={`${Math.max(terminalFontSize + 4, Math.ceil(terminalFontSize * 1.5))}px`}
      themeId={terminalThemeId || 'default'}
      widthMode={terminalWidthMode}
      showAbsoluteLineNumbers={absoluteLineNumbersVisible}
    />
  ), [
    absoluteLineNumbersVisible,
    focusNonce,
    followResetEpoch,
    handleActiveTerminalActivateInput,
    handleSwipeTab,
    handleTerminalViewportChange,
    inputResetEpochBySession,
    isAndroid,
    onResize,
    onTerminalInput,
    onTerminalWidthModeChange,
    sessionBufferStore,
    terminalFontSize,
    terminalKeyboardRequested,
    terminalThemeId,
    terminalWidthMode,
    layoutProfile.stage.containerRadius,
    layoutProfile.stage.outerMargin,
    layoutProfile.stage.paneGap,
    layoutProfile.stage.paneRadius,
    layoutProfile.stage.rowBottomPadding,
  ]);

  return (
    <div
      data-testid="terminal-stage-shell"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: `${terminalChromeBottomPx + terminalImeLiftPx}px`,
        display: 'flex',
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          margin: layoutProfile.stage.outerMargin,
          borderRadius: layoutProfile.stage.containerRadius,
          backgroundColor: splitVisible ? 'transparent' : mobileTheme.colors.canvas,
          overflow: 'hidden',
          border: splitVisible ? 'none' : `1px solid ${mobileTheme.colors.cardBorder}`,
          position: 'relative',
          overscrollBehaviorY: 'contain',
        }}
      >
        {interactiveSession ? (
          splitVisible ? (
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: 'flex',
                gap: layoutProfile.stage.paneGap,
                padding: layoutProfile.stage.rowBottomPadding,
              }}
            >
              {visiblePaneEntries.map(({ pane, session }) => {
                const paneIsActive = pane.id === activePaneId;
                const sessionIsActive = session.id === interactiveSession?.id;
                return (
                  <div
                    key={pane.id}
                    data-testid="terminal-pane-shell"
                    data-pane-id={pane.id}
                    onPointerDown={() => onActivatePane?.(pane.id)}
                    style={{
                      flex: `${Math.max(0.01, pane.size ?? 1)} 1 0%`,
                      minWidth: 0,
                      minHeight: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      borderRadius: layoutProfile.stage.paneRadius,
                      backgroundColor: mobileTheme.colors.canvas,
                      overflow: 'hidden',
                      border: `1px solid ${mobileTheme.colors.cardBorder}`,
                      outline: paneIsActive ? '2px solid rgba(83, 139, 255, 0.78)' : undefined,
                      outlineOffset: paneIsActive ? '-2px' : undefined,
                      boxSizing: 'border-box',
                      cursor: !paneIsActive ? 'pointer' : undefined,
                    }}
                  >
                    <div
                      style={{
                        flex: 1,
                        minHeight: 0,
                        position: 'relative',
                        overflow: 'hidden',
                      }}
                    >
                      {renderTerminal(session, sessionIsActive, `${pane.id}:${session.id}`)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            renderedPaneSessions.map((session) => {
              const sessionIsActive = session.id === interactiveSession?.id;
              return (
              <div
                key={session.id}
                style={{
                  position: 'absolute',
                  inset: 0,
                  visibility: sessionIsActive ? 'visible' : 'hidden',
                  opacity: sessionIsActive ? 1 : 0,
                  zIndex: sessionIsActive ? 1 : 0,
                  pointerEvents: sessionIsActive ? 'auto' : 'none',
                  overflow: 'hidden',
                }}
              >
                {renderTerminal(session, sessionIsActive, session.id)}
              </div>
              );
            })
          )
        ) : (
          <div
            style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: mobileTheme.colors.textSecondary,
              gap: '10px',
            }}
          >
            <div style={{ fontSize: '18px', fontWeight: 700 }}>No terminal attached</div>
            <div style={{ fontSize: '14px' }}>Go back to Connections and open a host card.</div>
          </div>
        )}
      </div>
    </div>
  );
}, (prev, next) => (
  terminalPageRenderedSessionUiKey(prev.interactiveSession) === terminalPageRenderedSessionUiKey(next.interactiveSession)
  && terminalPageRenderedSessionsUiKey(prev.renderedPaneSessions) === terminalPageRenderedSessionsUiKey(next.renderedPaneSessions)
  && prev.sessionBufferStore === next.sessionBufferStore
  && prev.splitVisible === next.splitVisible
  && prev.activePaneId === next.activePaneId
  && prev.terminalChromeBottomPx === next.terminalChromeBottomPx
  && prev.terminalImeLiftPx === next.terminalImeLiftPx
  && resolveRenderedSessionsInputEpochKey(prev.inputResetEpochBySession, prev.renderedPaneSessions)
    === resolveRenderedSessionsInputEpochKey(next.inputResetEpochBySession, next.renderedPaneSessions)
  && prev.followResetEpoch === next.followResetEpoch
  && prev.terminalKeyboardRequested === next.terminalKeyboardRequested
  && prev.isAndroid === next.isAndroid
  && prev.onResize === next.onResize
  && prev.onTerminalInput === next.onTerminalInput
  && prev.onTerminalWidthModeChange === next.onTerminalWidthModeChange
  && prev.handleTerminalViewportChange === next.handleTerminalViewportChange
  && prev.handleSwipeTab === next.handleSwipeTab
  && prev.handleActiveTerminalActivateInput === next.handleActiveTerminalActivateInput
  && prev.focusNonce === next.focusNonce
  && prev.terminalFontSize === next.terminalFontSize
  && prev.terminalThemeId === next.terminalThemeId
  && prev.terminalWidthMode === next.terminalWidthMode
  && prev.absoluteLineNumbersVisible === next.absoluteLineNumbersVisible
  && prev.visiblePaneEntries.map((entry) => `${entry.pane.id}:${entry.session.id}`).join('||')
    === next.visiblePaneEntries.map((entry) => `${entry.pane.id}:${entry.session.id}`).join('||')
  && prev.onActivatePane === next.onActivatePane
));


function toPersistedOpenTab(session: Session): PersistedOpenTab {
  return {
    sessionId: session.id,
    hostId: session.hostId,
    connectionName: session.connectionName,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    authToken: session.authToken,
    autoCommand: session.autoCommand,
    customName: session.customName,
    createdAt: session.createdAt,
  };
}

function normalizePersistedOpenTab(input: unknown): PersistedOpenTab | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<PersistedOpenTab>;
  const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId.trim() : '';
  const bridgeHost = typeof candidate.bridgeHost === 'string' ? candidate.bridgeHost.trim() : '';
  const sessionName = typeof candidate.sessionName === 'string' ? candidate.sessionName.trim() : '';

  if (!sessionId || !bridgeHost || !sessionName) {
    return null;
  }

  return {
    sessionId,
    hostId: typeof candidate.hostId === 'string' ? candidate.hostId : '',
    connectionName: typeof candidate.connectionName === 'string' && candidate.connectionName.trim()
      ? candidate.connectionName.trim()
      : sessionName,
    bridgeHost,
    bridgePort:
      typeof candidate.bridgePort === 'number' && Number.isFinite(candidate.bridgePort)
        ? candidate.bridgePort
        : 3333,
    sessionName,
    authToken: typeof candidate.authToken === 'string' ? candidate.authToken : undefined,
    autoCommand: typeof candidate.autoCommand === 'string' ? candidate.autoCommand : undefined,
    customName: typeof candidate.customName === 'string' && candidate.customName.trim()
      ? candidate.customName.trim()
      : undefined,
    createdAt:
      typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
        ? candidate.createdAt
        : Date.now(),
  };
}

function formatDebugRate(bytesPerSecond: number) {
  const safeValue = Math.max(0, Number.isFinite(bytesPerSecond) ? bytesPerSecond : 0);
  if (safeValue >= 1024 * 1024) {
    return `${(safeValue / (1024 * 1024)).toFixed(2)} MB/s`;
  }
  if (safeValue >= 1024) {
    return `${(safeValue / 1024).toFixed(1)} KB/s`;
  }
  return `${Math.round(safeValue)} B/s`;
}

function formatDebugHz(value: number) {
  const safeValue = Math.max(0, Number.isFinite(value) ? value : 0);
  return `${safeValue.toFixed(1)} Hz`;
}

function resolveDebugStatus(
  session: Session | null,
  metrics?: SessionDebugOverlayMetrics,
): SessionDebugOverlayMetrics['status'] {
  if (metrics?.status) {
    return metrics.status;
  }
  if (!session) {
    return 'waiting';
  }
  switch (session.state) {
    case 'error':
      return 'error';
    case 'closed':
      return 'closed';
    case 'reconnecting':
      return 'reconnecting';
    case 'connecting':
      return 'connecting';
    default:
      return 'waiting';
  }
}

function normalizeSavedTabList(input: unknown): SavedTabList | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<SavedTabList>;
  const now = Date.now();
  const id = typeof candidate.id === 'string' && candidate.id.trim()
    ? candidate.id.trim()
    : `imported-tab-list-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  const tabs = Array.isArray(candidate.tabs)
    ? candidate.tabs.map(normalizePersistedOpenTab).filter((item): item is PersistedOpenTab => item !== null)
    : [];

  if (!name || tabs.length === 0) {
    return null;
  }

  return {
    id,
    name,
    tabs,
    activeSessionId: typeof candidate.activeSessionId === 'string' ? candidate.activeSessionId : undefined,
    createdAt:
      typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
        ? candidate.createdAt
        : now,
    updatedAt:
      typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : now,
  };
}

function TerminalPageComponent({
  sessions,
  activeSession,
  getSessionDebugMetrics,
  sessionBufferStore = null,
  sessionHeadStore = null,
  inputResetEpochBySession,
  followResetEpoch = 0,
  onSwitchSession,
  onMoveSession,
  onRenameSession,
  onCloseSession,
  onOpenConnections,
  onOpenQuickTabPicker,
  pendingPaneAttachIntent = null,
  onPaneAttachIntentApplied,
  onResize,
  onTerminalInput,
  onTerminalViewportChange,
  onLiveSessionIdsChange,
  onImagePaste,
  onFileAttach,
  onOpenSettings: _onOpenSettings,
  onRequestRemoteScreenshot,
  quickActions,
  shortcutActions,
  onQuickActionInput,
  onQuickActionsChange,
  onShortcutActionsChange,
  sessionDraft,
  onSessionDraftChange,
  onSessionDraftSend,
  onLoadSavedTabList,
  scheduleState,
  onRequestScheduleList,
  onUpsertScheduleJob,
  onDeleteScheduleJob,
  onToggleScheduleJob,
  onRunScheduleJobNow,
  terminalThemeId,
  terminalWidthMode = 'mirror-fixed',
  onTerminalWidthModeChange,
  onSendMessage,
  onFileTransferMessage,
  shortcutSmartSort,
  shortcutFrequencyMap,
  onShortcutUse,
}: TerminalPageProps) {
  const isAndroid = Capacitor.getPlatform() === 'android';
  const [focusNonce, setFocusNonce] = useState(0);
  const terminalFontSize = 10;
  const [terminalKeyboardRequested, setTerminalKeyboardRequested] = useState(false);
  const [networkOnline, setNetworkOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [connectionIssueVisible, setConnectionIssueVisible] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [quickBarHeight, setQuickBarHeight] = useState(TERMINAL_QUICK_BAR_RENDER_LIFT_PX);
  const [quickBarEditorFocused, setQuickBarEditorFocused] = useState(false);
  const [tabManagerOpen, setTabManagerOpen] = useState(false);
  const [tabManagerScopePaneId, setTabManagerScopePaneId] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [fileTransferOpen, setFileTransferOpen] = useState(false);
  const [remoteScreenshotPreview, setRemoteScreenshotPreview] = useState<RemoteScreenshotPreviewState | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => resolveWindowWidth());
  const [headerTopInsetPx, setHeaderTopInsetPx] = useState(() => resolveTerminalHeaderTopInsetPx(isAndroid));
  const [scheduleComposerSeed, setScheduleComposerSeed] = useState<ScheduleComposerSeed>({ nonce: 0, text: '' });
  const viewportMetricsFrameRef = useRef<number | null>(null);
  const [savedTabLists, setSavedTabLists] = useState<SavedTabList[]>([]);
  const [debugOverlayVisible, setDebugOverlayVisible] = useState(false);
  const [absoluteLineNumbersVisible, setAbsoluteLineNumbersVisible] = useState(false);
  const sessionViewportModeStoreRef = useRef(createSessionViewportModeStore());
  const [debugOverlayPos, setDebugOverlayPos] = useState({ x: -1, y: -1 }); // -1 means use defaults
  const debugOverlayDragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number; dragging: boolean }>({ startX: 0, startY: 0, startPosX: 0, startPosY: 0, dragging: false });
  const connectionIssueTimerRef = useRef<number | null>(null);
  const activeSessionIdRef = useRef<string | null>(activeSession?.id || null);
  const quickBarEditorFocusedRef = useRef(quickBarEditorFocused);
  const terminalInputHandlerRef = useRef<typeof onTerminalInput>(onTerminalInput);
  const appliedPaneAttachIntentNonceRef = useRef<number | null>(null);
  const pendingAndroidImeFocusTimerRef = useRef<number | null>(null);
  const terminalFocusRetryTimeoutsRef = useRef<number[]>([]);
  const remoteScreenshotPreviewRuntimeRef = useRef(createRemoteScreenshotPreviewRuntime());
  const stableLayoutViewportHeightRef = useRef(resolveLayoutViewportHeight());


  const sendFileTransferMessage = useCallback((msg: any) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || !onSendMessage) {
      return;
    }
    onSendMessage(sessionId, msg);
  }, [onSendMessage]);

  useEffect(() => {
    terminalInputHandlerRef.current = onTerminalInput;
  }, [onTerminalInput]);

  useEffect(() => {
    quickBarEditorFocusedRef.current = quickBarEditorFocused;
  }, [quickBarEditorFocused]);

  const rawShellHeight = resolveLayoutViewportHeight();
  const keyboardViewportFreezeActive = isAndroid && (terminalKeyboardRequested || keyboardInset > 0);
  const shellHeight = keyboardViewportFreezeActive
    ? Math.max(rawShellHeight, stableLayoutViewportHeightRef.current)
    : rawShellHeight;

  useEffect(() => {
    if (!isAndroid) {
      stableLayoutViewportHeightRef.current = rawShellHeight;
      return;
    }
    if (keyboardViewportFreezeActive) {
      return;
    }
    if (rawShellHeight > 0) {
      stableLayoutViewportHeightRef.current = rawShellHeight;
    }
  }, [isAndroid, keyboardViewportFreezeActive, rawShellHeight]);

  const updateTerminalKeyboardRequested = useCallback((next: boolean) => {
    setTerminalKeyboardRequested((current) => (current === next ? current : next));
  }, []);

  const updateKeyboardInset = useCallback((next: number) => {
    const safeNext = Math.max(0, Math.round(next || 0));
    setKeyboardInset((current) => (current === safeNext ? current : safeNext));
  }, []);

  const updateViewportMetrics = useCallback(() => {
    const nextWidth = resolveWindowWidth();
    const nextTopInset = resolveTerminalHeaderTopInsetPx(isAndroid);
    setViewportWidth((current) => (current === nextWidth ? current : nextWidth));
    setHeaderTopInsetPx((current) => (current === nextTopInset ? current : nextTopInset));
  }, [isAndroid]);

  const scheduleViewportMetricsSync = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (viewportMetricsFrameRef.current !== null) {
      return;
    }
    viewportMetricsFrameRef.current = window.requestAnimationFrame(() => {
      viewportMetricsFrameRef.current = null;
      updateViewportMetrics();
    });
  }, [updateViewportMetrics]);

  useEffect(() => {
    const storage = getBrowserStorage();
    if (!storage) {
      return;
    }

    try {
      const raw = storage.getItem(STORAGE_KEYS.SAVED_TAB_LISTS);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      setSavedTabLists(parsed.map(normalizeSavedTabList).filter((item): item is SavedTabList => item !== null));
    } catch (error) {
      console.error('[TerminalPage] Failed to load saved tab lists:', error);
    }
  }, []);

  const persistSavedTabLists = (nextLists: SavedTabList[]) => {
    setSavedTabLists(nextLists);
    const storage = getBrowserStorage();
    if (!storage) {
      return;
    }
    try {
      storage.setItem(STORAGE_KEYS.SAVED_TAB_LISTS, JSON.stringify(nextLists));
    } catch (error) {
      console.error('[TerminalPage] Failed to persist saved tab lists:', error);
    }
  };

  const querySessionInput = (sessionId: string | null | undefined) => {
    if (!sessionId || typeof document === 'undefined') {
      return null;
    }
    return document.querySelector(
      `textarea[data-wterm-input="true"][data-terminal-input-session-id="${sessionId}"]`,
    ) as HTMLTextAreaElement | null;
  };

  const {
    workspace,
    splitAvailable,
    splitVisible,
    activePaneSessionId,
    currentMaxSplitCount,
    findPaneForSession,
    getPaneSessionIds,
    setSplitCount,
    assignSessionToPane,
    attachSessionsToPane,
    setActivePane,
  } = useTerminalWorkspace({
    sessions,
    activeSessionId: activeSession?.id || null,
    viewportWidth,
    viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 800,
    maxSplitCount: 4,
  });
  const workspacePanes = splitVisible ? workspace.panes : workspace.panes.slice(0, 1);
  const paneGroups = workspacePanes.map((pane) => ({
    paneId: pane.id,
    size: pane.size,
    sessions: pane.tabs
      .map((tab) => sessions.find((session) => session.id === tab.sessionId) || null)
      .filter((session): session is Session => Boolean(session))
      .map(toTerminalTabChromeItem),
    activeSessionId: pane.tabs.find((tab) => tab.id === pane.activeTabId)?.sessionId || null,
    isActivePane: pane.id === workspace.activePaneId,
  }));
  const visiblePaneEntries = splitVisible
    ? workspacePanes
        .map((pane, paneIndex) => {
          const sessionId = pane.tabs.find((tab) => tab.id === pane.activeTabId)?.sessionId || null;
          if (!sessionId) {
            return null;
          }
          const session = sessions.find((candidate) => candidate.id === sessionId) || null;
          if (!session) {
            return null;
          }
          return { pane, paneIndex, session };
        })
        .filter((entry): entry is { pane: AndroidWorkspacePane; paneIndex: number; session: Session } => Boolean(entry))
    : [];
  const interactiveSessionId = splitVisible
    ? (paneGroups.find((group) => group.paneId === workspace.activePaneId)?.activeSessionId || activePaneSessionId)
    : (activeSession?.id || activePaneSessionId);
  const interactiveSession = interactiveSessionId
    ? sessions.find((session) => session.id === interactiveSessionId) || activeSession || null
    : activeSession || null;
  const uiSession = interactiveSession || activeSession || null;
  const uiSessionId = uiSession?.id || null;
  const renderedPaneSessions = splitVisible
    ? visiblePaneEntries.map((entry) => entry.session)
    : (interactiveSession ? [interactiveSession] : []);
  const livePaneSessionIds = useMemo(
    () => renderedPaneSessions.map((session) => session.id),
    [renderedPaneSessions],
  );
  const livePaneSessionIdsKey = useMemo(
    () => livePaneSessionIds.join('||'),
    [livePaneSessionIds],
  );
  const headerSessionsUiKey = useMemo(() => terminalPageHeaderSessionsUiKey(sessions), [sessions]);
  const activeHeaderSessionUiKey = useMemo(() => terminalPageHeaderSessionUiKey(activeSession), [activeSession]);
  const chromeSessions = useMemo(() => sessions.map(toTerminalTabChromeItem), [headerSessionsUiKey]);
  const activeChromeSession = useMemo(() => (
    interactiveSession ? toTerminalTabChromeItem(interactiveSession) : null
  ), [activeHeaderSessionUiKey, interactiveSession]);
  const activeDraft = sessionDraft;
  const activeScheduleState = scheduleState || null;
  const activeSessionRef = useRef(activeSession);
  const sessionsRef = useRef(sessions);
  const splitVisibleRef = useRef(splitVisible);
  const activePaneIdRef = useRef<string>(workspace.activePaneId);
  const previousLivePaneSessionIdsKeyRef = useRef<string>('');
  activeSessionRef.current = activeSession;
  sessionsRef.current = sessions;
  splitVisibleRef.current = splitVisible;
  activePaneIdRef.current = workspace.activePaneId;

  useEffect(() => {
    activeSessionIdRef.current = uiSessionId;
  }, [uiSessionId]);

  useEffect(() => {
    if (!pendingPaneAttachIntent) {
      return;
    }
    if (appliedPaneAttachIntentNonceRef.current === pendingPaneAttachIntent.nonce) {
      return;
    }
    const normalizedSessionIds = [...new Set(pendingPaneAttachIntent.sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean))];
    const normalizedPaneId = pendingPaneAttachIntent.paneId.trim();
    if (normalizedSessionIds.length === 0 || !normalizedPaneId) {
      console.error('[TerminalPage] Refused pane-attach intent without explicit sessionIds/paneId.', pendingPaneAttachIntent);
      appliedPaneAttachIntentNonceRef.current = pendingPaneAttachIntent.nonce;
      onPaneAttachIntentApplied?.(pendingPaneAttachIntent);
      return;
    }
    const knownSessionIds = new Set(sessions.map((session) => session.id));
    const allSessionsPresent = normalizedSessionIds.every((sessionId) => knownSessionIds.has(sessionId));
    const paneExists = workspace.panes.some((pane) => pane.id === normalizedPaneId);
    if (!paneExists) {
      console.error('[TerminalPage] Refused pane-attach intent because target pane does not exist.', {
        paneId: normalizedPaneId,
        workspacePaneIds: workspace.panes.map((pane) => pane.id),
        sessionIds: normalizedSessionIds,
      });
      appliedPaneAttachIntentNonceRef.current = pendingPaneAttachIntent.nonce;
      onPaneAttachIntentApplied?.(pendingPaneAttachIntent);
      return;
    }
    if (!allSessionsPresent) {
      return;
    }
    appliedPaneAttachIntentNonceRef.current = pendingPaneAttachIntent.nonce;
    attachSessionsToPane(normalizedSessionIds, normalizedPaneId);
    onPaneAttachIntentApplied?.(pendingPaneAttachIntent);
  }, [attachSessionsToPane, onPaneAttachIntentApplied, pendingPaneAttachIntent, sessions, workspace.panes]);

  useLayoutEffect(() => {
    if (!onLiveSessionIdsChange) {
      previousLivePaneSessionIdsKeyRef.current = livePaneSessionIdsKey;
      return;
    }
    if (previousLivePaneSessionIdsKeyRef.current === livePaneSessionIdsKey) {
      return;
    }
    previousLivePaneSessionIdsKeyRef.current = livePaneSessionIdsKey;
    onLiveSessionIdsChange(livePaneSessionIds);
  }, [livePaneSessionIds, livePaneSessionIdsKey, onLiveSessionIdsChange]);

  useEffect(() => {
    return () => {
      previousLivePaneSessionIdsKeyRef.current = '';
      onLiveSessionIdsChange?.([]);
    };
  }, [onLiveSessionIdsChange]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const visualViewport = window.visualViewport;

    updateViewportMetrics();
    window.addEventListener('resize', scheduleViewportMetricsSync);
    visualViewport?.addEventListener('resize', scheduleViewportMetricsSync);
    if (!isAndroid) {
      visualViewport?.addEventListener('scroll', scheduleViewportMetricsSync);
    }
    return () => {
      window.removeEventListener('resize', scheduleViewportMetricsSync);
      visualViewport?.removeEventListener('resize', scheduleViewportMetricsSync);
      if (!isAndroid) {
        visualViewport?.removeEventListener('scroll', scheduleViewportMetricsSync);
      }
      if (viewportMetricsFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportMetricsFrameRef.current);
        viewportMetricsFrameRef.current = null;
      }
    };
  }, [isAndroid, scheduleViewportMetricsSync, updateViewportMetrics]);

  const focusTerminalInput = useCallback(() => {
    setFocusNonce((value) => value + 1);

    const input = querySessionInput(uiSessionId);
    if (!input) {
      return;
    }

    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [uiSessionId]);

  const clearPendingAndroidImeFocus = useCallback(() => {
    if (pendingAndroidImeFocusTimerRef.current === null) {
      return;
    }
    window.clearTimeout(pendingAndroidImeFocusTimerRef.current);
    pendingAndroidImeFocusTimerRef.current = null;
  }, []);

  const clearTerminalFocusRetries = useCallback(() => {
    if (terminalFocusRetryTimeoutsRef.current.length === 0) {
      return;
    }
    terminalFocusRetryTimeoutsRef.current.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    terminalFocusRetryTimeoutsRef.current = [];
  }, []);

  const scheduleTerminalFocusRetries = useCallback((options?: {
    delaysMs?: number[];
    includeKeyboardShow?: boolean;
  }) => {
    const delaysMs = options?.delaysMs || [0, 32, 120];
    const includeKeyboardShow = Boolean(options?.includeKeyboardShow);
    clearTerminalFocusRetries();
    terminalFocusRetryTimeoutsRef.current = delaysMs.map((delayMs) => window.setTimeout(() => {
      focusTerminalInput();
      if (includeKeyboardShow) {
        void Keyboard.show().catch((error) => {
          logAsyncCleanupFailure(`Keyboard.show retry(${delayMs}ms)`, error);
        });
      }
    }, delayMs));
  }, [clearTerminalFocusRetries, focusTerminalInput]);

  const setAndroidEditorActive = useCallback((active: boolean) => {
    if (!isAndroid) {
      return;
    }
    void ImeAnchor.setEditorActive({ active }).catch((error) => {
      console.warn(`[TerminalPage] ImeAnchor.setEditorActive(${active ? 'true' : 'false'}) failed:`, error);
    });
  }, [isAndroid]);

  const requestAndroidImeFocus = useCallback(() => {
    if (!isAndroid || quickBarEditorFocusedRef.current) {
      return;
    }
    clearPendingAndroidImeFocus();
    pendingAndroidImeFocusTimerRef.current = window.setTimeout(() => {
      pendingAndroidImeFocusTimerRef.current = null;
      if (quickBarEditorFocusedRef.current) {
        return;
      }
      setAndroidEditorActive(false);
      void ImeAnchor.show().catch((error) => {
        console.warn('[TerminalPage] ImeAnchor.show() failed:', error);
      });
    }, 0);
  }, [clearPendingAndroidImeFocus, isAndroid, setAndroidEditorActive]);

  const restoreAndroidTerminalImeRoute = useCallback(() => {
    if (!isAndroid || quickBarEditorFocusedRef.current) {
      return;
    }
    if (!(terminalKeyboardRequested || keyboardInset > 0)) {
      return;
    }
    requestAndroidImeFocus();
  }, [isAndroid, keyboardInset, requestAndroidImeFocus, terminalKeyboardRequested]);

  const keepTerminalInputFocused = useCallback(() => {
    if (quickBarEditorFocused) {
      clearTerminalFocusRetries();
      return;
    }

    if (isAndroid) {
      restoreAndroidTerminalImeRoute();
      return;
    }

    scheduleTerminalFocusRetries();
  }, [clearTerminalFocusRetries, isAndroid, quickBarEditorFocused, restoreAndroidTerminalImeRoute, scheduleTerminalFocusRetries]);

  const closeRemoteScreenshotPreview = useCallback(() => {
    setRemoteScreenshotPreview(remoteScreenshotPreviewRuntimeRef.current.closePreview());
  }, []);

  useEffect(() => () => {
    remoteScreenshotPreviewRuntimeRef.current.dispose();
  }, []);

  const handleRequestRemoteScreenshot = useCallback(async () => {
    const targetSessionId = uiSessionId;
    if (!targetSessionId || !onRequestRemoteScreenshot) {
      alert('当前没有可用的目标 session');
      return;
    }

    const started = remoteScreenshotPreviewRuntimeRef.current.beginRequest();
    const requestEpoch = started.requestEpoch;
    setRemoteScreenshotPreview(started.state);

    try {
      const capture = await onRequestRemoteScreenshot(targetSessionId, (progress) => {
        setRemoteScreenshotPreview((current) => (
          remoteScreenshotPreviewRuntimeRef.current.applyProgress(current, requestEpoch, progress)
        ));
      });

      if (!remoteScreenshotPreviewRuntimeRef.current.isRequestCurrent(requestEpoch)) {
        return;
      }
      setRemoteScreenshotPreview((current) => (
        remoteScreenshotPreviewRuntimeRef.current.markTransferComplete(current, requestEpoch, capture)
      ));
      setRemoteScreenshotPreview((current) => (
        remoteScreenshotPreviewRuntimeRef.current.completeCapture(current, requestEpoch, capture)
      ));
    } catch (error) {
      if (!remoteScreenshotPreviewRuntimeRef.current.isRequestCurrent(requestEpoch)) {
        return;
      }
      setRemoteScreenshotPreview((current) => (
        remoteScreenshotPreviewRuntimeRef.current.failCapture(current, requestEpoch, error)
      ));
    }
  }, [onRequestRemoteScreenshot, uiSessionId]);

  const handleQuickBarMeasuredHeightChange = useCallback((height: number) => {
    setQuickBarHeight((current) => (current === height ? current : height));
  }, []);

  const handleQuickBarSendSequence = useCallback((sequence: string) => {
    onQuickActionInput?.(sequence, uiSessionId || undefined);
    if (terminalKeyboardRequested || keyboardInset > 0) {
      keepTerminalInputFocused();
    }
  }, [keyboardInset, keepTerminalInputFocused, onQuickActionInput, terminalKeyboardRequested, uiSessionId]);

  const handleQuickBarSessionDraftChange = useCallback((value: string) => {
    onSessionDraftChange?.(value, uiSessionId || undefined);
  }, [onSessionDraftChange, uiSessionId]);

  const handleQuickBarSessionDraftSend = useCallback((value: string) => {
    onSessionDraftSend?.(value, uiSessionId || undefined);
    if (terminalKeyboardRequested || keyboardInset > 0) {
      keepTerminalInputFocused();
    }
  }, [keyboardInset, keepTerminalInputFocused, onSessionDraftSend, terminalKeyboardRequested, uiSessionId]);

  const handleQuickBarOpenScheduleComposer = useCallback((text: string) => {
    const targetSessionId = uiSessionId;
    if (!targetSessionId) {
      return;
    }
    onRequestScheduleList?.(targetSessionId);
    setScheduleComposerSeed({
      nonce: Date.now(),
      text,
    });
    setScheduleOpen(true);
  }, [onRequestScheduleList, uiSessionId]);

  const handleQuickBarOpenFileTransfer = useCallback(() => {
    setFileTransferOpen(true);
  }, []);

  const handleQuickBarToggleDebugOverlay = useCallback(() => {
    setDebugOverlayVisible((v) => !v);
  }, []);

  const handleQuickBarToggleAbsoluteLineNumbers = useCallback(() => {
    setAbsoluteLineNumbersVisible((v) => !v);
  }, []);

  const handleQuickBarRequestRemoteScreenshot = useCallback(() => {
    void handleRequestRemoteScreenshot();
  }, [handleRequestRemoteScreenshot]);

  const handleActiveTerminalActivateInput = useCallback(() => {
    restoreAndroidTerminalImeRoute();
  }, [restoreAndroidTerminalImeRoute]);

  const handleSwipeTab = useCallback((sessionId: string, direction: 'previous' | 'next') => {
    const currentSplitVisible = splitVisibleRef.current;
    const currentSessions = sessionsRef.current;
    const currentActivePaneId = activePaneIdRef.current;
    const paneScopedSessions = currentSplitVisible
      ? getPaneSessionIds(currentActivePaneId)
          .map((paneSessionId) => currentSessions.find((session) => session.id === paneSessionId) || null)
          .filter((session): session is Session => Boolean(session))
      : currentSessions;
    const currentIndex = paneScopedSessions.findIndex((session) => session.id === sessionId);
    if (currentIndex < 0) {
      return;
    }
    const targetIndex = direction === 'previous' ? currentIndex - 1 : currentIndex + 1;
    const targetSession = paneScopedSessions[targetIndex] || null;
    if (!targetSession || targetSession.id === sessionId) {
      return;
    }
    onSwitchSession(targetSession.id);
  }, [getPaneSessionIds, onSwitchSession]);

  const handleSaveRemoteScreenshot = useCallback(async () => {
    if (
      !remoteScreenshotPreview?.previewDataUrl
      || !remoteScreenshotPreview.rawDataBase64
      || remoteScreenshotPreview.phase !== 'preview-ready'
    ) {
      return;
    }

    setRemoteScreenshotPreview((current) => remoteScreenshotPreviewRuntimeRef.current.beginSave(current));
    try {
      const savedPath = await persistRemoteScreenshotCaptureRuntime({
        fileName: remoteScreenshotPreview.fileName,
        dataBase64: remoteScreenshotPreview.rawDataBase64,
        directory: Directory.ExternalStorage,
        mkdir: Filesystem.mkdir,
        writeFile: Filesystem.writeFile,
      });
      closeRemoteScreenshotPreview();
      alert(`截图已保存到 ${savedPath}`);
    } catch (error) {
      setRemoteScreenshotPreview((current) => remoteScreenshotPreviewRuntimeRef.current.restorePreviewReady(current));
      alert(error instanceof Error ? error.message : '保存远程截图失败');
    }
  }, [closeRemoteScreenshotPreview, remoteScreenshotPreview]);

  const handleToggleKeyboard = useCallback(async () => {
    if (quickBarEditorFocused && typeof document !== 'undefined') {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      setQuickBarEditorFocused(false);
    }

    if (terminalKeyboardRequested || keyboardInset > 0) {
      updateTerminalKeyboardRequested(false);
      clearPendingAndroidImeFocus();
      clearTerminalFocusRetries();
      if (isAndroid) {
        try {
          await ImeAnchor.hide();
        } catch (error) {
          console.warn('[TerminalPage] ImeAnchor.hide() failed:', error);
        }
      } else {
        try {
          await Keyboard.hide();
        } catch (error) {
          console.warn('[TerminalPage] Keyboard.hide() failed:', error);
        }
      }
      const input = querySessionInput(uiSessionId);
      input?.blur();
      return;
    }

    updateTerminalKeyboardRequested(true);
    if (isAndroid) {
      return;
    }

    focusTerminalInput();
    try {
      void Keyboard.show();
    } catch (error) {
      console.warn('[TerminalPage] Keyboard.show() failed:', error);
    }

    scheduleTerminalFocusRetries({ delaysMs: [32, 120], includeKeyboardShow: true });
  }, [clearPendingAndroidImeFocus, clearTerminalFocusRetries, focusTerminalInput, isAndroid, keyboardInset, quickBarEditorFocused, scheduleTerminalFocusRetries, terminalKeyboardRequested, uiSessionId]);

  const handleQuickBarEditorDomFocusChange = useCallback((active: boolean) => {
    quickBarEditorFocusedRef.current = active;
    setQuickBarEditorFocused(active);
    setAndroidEditorActive(active);
    if (active) {
      clearTerminalFocusRetries();
    }
    if (active || !isAndroid) {
      return;
    }
    if (terminalKeyboardRequested || keyboardInset > 0) {
      requestAndroidImeFocus();
    }
  }, [clearTerminalFocusRetries, isAndroid, keyboardInset, requestAndroidImeFocus, setAndroidEditorActive, terminalKeyboardRequested]);

  useEffect(() => {
    if (!isAndroid || quickBarEditorFocused || !uiSessionId) {
      return;
    }
    if (!(terminalKeyboardRequested || keyboardInset > 0)) {
      return;
    }
    requestAndroidImeFocus();
  }, [isAndroid, keyboardInset, quickBarEditorFocused, requestAndroidImeFocus, terminalKeyboardRequested, uiSessionId]);

  useEffect(() => {
    const syncOnlineState = () => {
      setNetworkOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
    };

    syncOnlineState();
    window.addEventListener('online', syncOnlineState);
    window.addEventListener('offline', syncOnlineState);

    return () => {
      window.removeEventListener('online', syncOnlineState);
      window.removeEventListener('offline', syncOnlineState);
    };
  }, []);

  useEffect(() => {
    const hasIssue = !networkOnline || uiSession?.state === 'reconnecting' || uiSession?.state === 'error';

    if (!hasIssue) {
      if (connectionIssueTimerRef.current !== null) {
        window.clearTimeout(connectionIssueTimerRef.current);
        connectionIssueTimerRef.current = null;
      }
      setConnectionIssueVisible(false);
      return;
    }

    if (connectionIssueVisible || connectionIssueTimerRef.current !== null) {
      return;
    }

    connectionIssueTimerRef.current = window.setTimeout(() => {
      connectionIssueTimerRef.current = null;
      setConnectionIssueVisible(true);
    }, NETWORK_BANNER_GRACE_MS);

    return () => {
      if (connectionIssueTimerRef.current !== null) {
        window.clearTimeout(connectionIssueTimerRef.current);
        connectionIssueTimerRef.current = null;
      }
    };
  }, [connectionIssueVisible, networkOnline, uiSession?.state]);


  useEffect(() => {
    updateTerminalKeyboardRequested(false);
    setQuickBarEditorFocused(false);
    clearPendingAndroidImeFocus();
    clearTerminalFocusRetries();
    if (isAndroid) {
      void ImeAnchor.blur().catch((error) => {
        console.warn('[TerminalPage] ImeAnchor.blur() failed:', error);
      });
      return;
    }

    const input = querySessionInput(uiSessionId);
    input?.blur();
  }, [clearPendingAndroidImeFocus, clearTerminalFocusRetries, isAndroid, uiSessionId]);

  useEffect(() => {
    if (!isAndroid) {
      return;
    }

    let disposed = false;
    let inputListener: { remove: () => Promise<void> } | null = null;
    let backspaceListener: { remove: () => Promise<void> } | null = null;
    let keyboardStateListener: { remove: () => Promise<void> } | null = null;

    const emitToActiveSession = (data: string) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId || !data || quickBarEditorFocusedRef.current) {
        return;
      }
      terminalInputHandlerRef.current?.(sessionId, data);
    };

    const attachListeners = async () => {
      try {
        inputListener = await ImeAnchor.addListener('input', (event) => {
          emitToActiveSession(normalizeTerminalCommittedText(event.text || '').replace(/\n/g, '\r'));
        });
        if (disposed) {
          void inputListener.remove().catch((error) => {
            logAsyncCleanupFailure('ImeAnchor input listener remove after dispose', error);
          });
          inputListener = null;
          return;
        }
        backspaceListener = await ImeAnchor.addListener('backspace', (event) => {
          const count = Math.max(1, Math.round(event.count || 1));
          emitToActiveSession('\x7f'.repeat(count));
        });
        if (disposed) {
          void backspaceListener.remove().catch((error) => {
            logAsyncCleanupFailure('ImeAnchor backspace listener remove after dispose', error);
          });
          backspaceListener = null;
          return;
        }
        keyboardStateListener = await ImeAnchor.addListener('keyboardState', (event) => {
          const visible = Boolean(event.visible);
          const height = Math.max(0, Math.round(event.height || 0));
          updateKeyboardInset(height);
          if (!quickBarEditorFocusedRef.current) {
            updateTerminalKeyboardRequested(visible);
          }
        });
        if (disposed) {
          void keyboardStateListener.remove().catch((error) => {
            logAsyncCleanupFailure('ImeAnchor keyboardState listener remove after dispose', error);
          });
          keyboardStateListener = null;
        }
      } catch (error) {
        console.warn('[TerminalPage] Failed to attach ImeAnchor listeners:', error);
      }
    };

    void attachListeners();

    return () => {
      disposed = true;
      if (inputListener) {
        void inputListener.remove().catch((error) => {
          logAsyncCleanupFailure('ImeAnchor input listener remove', error);
        });
      }
      if (backspaceListener) {
        void backspaceListener.remove().catch((error) => {
          logAsyncCleanupFailure('ImeAnchor backspace listener remove', error);
        });
      }
      if (keyboardStateListener) {
        void keyboardStateListener.remove().catch((error) => {
          logAsyncCleanupFailure('ImeAnchor keyboardState listener remove', error);
        });
      }
    };
  }, [isAndroid]);

  useEffect(() => {
    if (!isAndroid || !quickBarEditorFocused) {
      return;
    }

    updateTerminalKeyboardRequested(false);
    clearPendingAndroidImeFocus();
    void ImeAnchor.blur().catch((error) => {
      console.warn('[TerminalPage] ImeAnchor.blur() failed:', error);
    });
  }, [
    clearPendingAndroidImeFocus,
    isAndroid,
    quickBarEditorFocused,
  ]);

  useEffect(() => () => {
    clearPendingAndroidImeFocus();
    clearTerminalFocusRetries();
  }, [clearPendingAndroidImeFocus, clearTerminalFocusRetries]);

  useEffect(() => {
    let disposed = false;

    const showListenerPromise = Keyboard.addListener('keyboardDidShow', (info) => {
      if (!disposed) {
        updateKeyboardInset(info.keyboardHeight || 0);
        if (isAndroid && !quickBarEditorFocusedRef.current) {
          updateTerminalKeyboardRequested(true);
        }
      }
    });
    const hideListenerPromise = Keyboard.addListener('keyboardDidHide', () => {
      if (!disposed) {
        updateTerminalKeyboardRequested(false);
        updateKeyboardInset(0);
      }
    });

    return () => {
      disposed = true;
      void showListenerPromise
        .then((listener) => listener.remove())
        .catch((error) => {
          logAsyncCleanupFailure('keyboardDidShow listener remove', error);
        });
      void hideListenerPromise
        .then((listener) => listener.remove())
        .catch((error) => {
          logAsyncCleanupFailure('keyboardDidHide listener remove', error);
        });
    };
  }, [isAndroid]);

  useEffect(() => {
    if (typeof navigator === 'undefined') {
      return;
    }

    const virtualKeyboard = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardApi }).virtualKeyboard;
    if (!virtualKeyboard) {
      return;
    }

    virtualKeyboard.overlaysContent = true;
    const syncKeyboardInset = () => {
      const nextInset = Math.max(0, Math.round(virtualKeyboard.boundingRect?.height || 0));
      updateKeyboardInset(nextInset);
    };

    syncKeyboardInset();
    virtualKeyboard.addEventListener('geometrychange', syncKeyboardInset);
    return () => {
      virtualKeyboard.removeEventListener('geometrychange', syncKeyboardInset);
    };
  }, [updateKeyboardInset]);

  const landscape = typeof window !== 'undefined' ? resolveTerminalOrientation() === 'landscape' : false;
  const layoutProfile = useMemo(() => resolveTerminalLayoutProfile({
    splitVisible,
    topInsetPx: headerTopInsetPx,
    landscape,
  }), [headerTopInsetPx, landscape, splitVisible]);
  const terminalChromeBottomPx = Math.max(0, quickBarHeight + layoutProfile.quickBar.touchSafeOffsetPx);
  const effectiveKeyboardLiftPx = resolveKeyboardLiftPx(keyboardInset, shellHeight);
  const terminalImeActive = terminalKeyboardRequested && !quickBarEditorFocused;
  const terminalImeLiftPx = terminalImeActive ? effectiveKeyboardLiftPx : 0;
  const quickBarShellKeyboardLiftPx = keyboardInset > 0 ? effectiveKeyboardLiftPx : 0;
  useEffect(() => registerClientDebugSnapshotSource('terminal-page', () => ({
    activeSessionId: uiSessionId,
    activeSessionState: uiSession?.state || null,
    sessionCount: sessions.length,
    splitVisible,
    layoutProfile,
    headerTopInsetPx,
    quickBarHeight,
    terminalChromeBottomPx,
    shellHeight,
    layoutViewportHeight: shellHeight,
    keyboardInset,
    effectiveKeyboardLiftPx,
    terminalKeyboardRequested,
    quickBarEditorFocused,
    terminalImeActive,
    terminalImeLiftPx,
    quickBarShellKeyboardLiftPx,
    networkOnline,
    connectionIssueVisible,
    isAndroid,
    widthMode: terminalWidthMode,
  })), [
    uiSessionId,
    uiSession?.state,
    connectionIssueVisible,
    effectiveKeyboardLiftPx,
    headerTopInsetPx,
    isAndroid,
    keyboardInset,
    layoutProfile,
    networkOnline,
    quickBarEditorFocused,
    quickBarHeight,
    quickBarShellKeyboardLiftPx,
    sessions.length,
    shellHeight,
    splitVisible,
    terminalChromeBottomPx,
    terminalImeActive,
    terminalImeLiftPx,
    terminalKeyboardRequested,
    terminalWidthMode,
  ]);
  const currentPersistedTabs = sessions.map(toPersistedOpenTab);

  const saveCurrentTabList = (name: string) => {
    const now = Date.now();
    const nextList: SavedTabList = {
      id: `tab-list-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      tabs: currentPersistedTabs,
      activeSessionId: uiSessionId || undefined,
      createdAt: now,
      updatedAt: now,
    };
    const deduped = [
      nextList,
      ...savedTabLists.filter((item) => item.name !== name),
    ];
    persistSavedTabLists(deduped);
  };

  const exportCurrentTabList = () => JSON.stringify({
    name: `current-${new Date().toISOString()}`,
    tabs: currentPersistedTabs,
    activeSessionId: uiSessionId || undefined,
    exportedAt: new Date().toISOString(),
  }, null, 2);

  const exportSavedTabList = (listId: string) => {
    const target = savedTabLists.find((item) => item.id === listId);
    return JSON.stringify(target || null, null, 2);
  };

  const deleteSavedTabList = (listId: string) => {
    persistSavedTabLists(savedTabLists.filter((item) => item.id !== listId));
  };

  const loadSavedTabList = (listId: string) => {
    const target = savedTabLists.find((item) => item.id === listId);
    if (!target) {
      return;
    }
    onLoadSavedTabList(target.tabs, target.activeSessionId);
  };

  const importSavedTabLists = (raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      const incoming = Array.isArray(parsed)
        ? parsed.map(normalizeSavedTabList).filter((item): item is SavedTabList => item !== null)
        : [normalizeSavedTabList(parsed)].filter((item): item is SavedTabList => item !== null);
      if (incoming.length === 0) {
        return { ok: false, message: '没有解析到有效的 tab 列表。' };
      }
      const merged = [...incoming];
      for (const existing of savedTabLists) {
        if (!merged.some((item) => item.id === existing.id || item.name === existing.name)) {
          merged.push(existing);
        }
      }
      persistSavedTabLists(merged);
      return { ok: true, message: `已导入 ${incoming.length} 个 tab 列表。` };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '导入失败',
      };
    }
  };

  const handleSetSplitCount = useCallback((count: number) => {
    setSplitCount(count);
  }, [setSplitCount]);

  const toggleSplitLayout = useCallback(() => {
    setSplitCount(splitVisible ? 1 : 2);
  }, [setSplitCount, splitVisible]);

  const cycleSecondaryPane = useCallback(() => {
    if (!splitVisible || workspace.panes.length < 2) {
      return;
    }
    const activePaneId = workspace.activePaneId;
    const passivePane = workspace.panes.find((pane) => pane.id !== activePaneId) || null;
    if (!passivePane || passivePane.tabs.length <= 1) {
      return;
    }
    const currentIndex = passivePane.tabs.findIndex((tab) => tab.id === passivePane.activeTabId);
    const nextIndex = (currentIndex + 1) % passivePane.tabs.length;
    const nextTab = passivePane.tabs[nextIndex];
    if (!nextTab) {
      return;
    }
    onSwitchSession(nextTab.sessionId);
  }, [onSwitchSession, splitVisible, workspace.activePaneId, workspace.panes]);

  const moveSessionToOtherPane = useCallback((sessionId: string) => {
    const pane = findPaneForSession(sessionId);
    if (!pane || workspace.panes.length < 2) {
      return;
    }
    const targetPane = workspace.panes.find((candidate) => candidate.id !== pane.id);
    if (!targetPane) {
      return;
    }
    assignSessionToPane(sessionId, targetPane.id);
  }, [assignSessionToPane, findPaneForSession, workspace.panes]);

  const activatePaneAndSession = useCallback((paneId: string) => {
    const normalizedPaneId = paneId.trim();
    if (!normalizedPaneId) {
      return;
    }
    const targetPane = workspace.panes.find((pane) => pane.id === normalizedPaneId) || null;
    if (!targetPane) {
      console.error('[TerminalPage] Refused to activate missing pane.', {
        paneId: normalizedPaneId,
        workspacePaneIds: workspace.panes.map((pane) => pane.id),
      });
      return;
    }
    const targetSessionId = targetPane.tabs.find((tab) => tab.id === targetPane.activeTabId)?.sessionId || null;
    setActivePane(normalizedPaneId);
    if (targetSessionId && targetSessionId !== activeSessionRef.current?.id) {
      onSwitchSession(targetSessionId);
    }
  }, [onSwitchSession, setActivePane, workspace.panes]);

  const handleOpenQuickTabPickerForPane = useCallback((paneId?: string) => {
    if (paneId) {
      activatePaneAndSession(paneId);
    }
    onOpenQuickTabPicker(paneId);
  }, [activatePaneAndSession, onOpenQuickTabPicker]);

  const handleOpenTabManager = useCallback((paneId?: string) => {
    setTabManagerScopePaneId(paneId || null);
    if (paneId) {
      activatePaneAndSession(paneId);
    }
    setTabManagerOpen(true);
  }, [activatePaneAndSession]);

  const handleTerminalViewportChange = useCallback<TerminalViewportChangeHandler>((sessionId, viewState) => {
    sessionViewportModeStoreRef.current.setMode(sessionId, viewState.mode);
    onTerminalViewportChange?.(sessionId, viewState);
  }, [onTerminalViewportChange]);

  const quickBarNode = useMemo(() => (
    <TerminalQuickBar
      activeSessionId={uiSessionId}
      quickActions={quickActions}
      shortcutActions={shortcutActions}
      onMeasuredHeightChange={handleQuickBarMeasuredHeightChange}
      onSendSequence={handleQuickBarSendSequence}
      onImagePaste={onImagePaste}
      onFileAttach={onFileAttach}
      keyboardVisible={terminalImeActive && effectiveKeyboardLiftPx > 0}
      keyboardInsetPx={quickBarShellKeyboardLiftPx}
      onToggleKeyboard={handleToggleKeyboard}
      onQuickActionsChange={onQuickActionsChange}
      onShortcutActionsChange={onShortcutActionsChange}
      sessionDraft={activeDraft}
      onSessionDraftChange={handleQuickBarSessionDraftChange}
      onSessionDraftSend={handleQuickBarSessionDraftSend}
      onOpenScheduleComposer={handleQuickBarOpenScheduleComposer}
      splitAvailable={splitAvailable}
      splitVisible={splitVisible}
      shellMode={layoutProfile.quickBar.shellMode}
      currentSplitCount={workspacePanes.length}
      splitCountOptions={
        splitAvailable
          ? Array.from({ length: currentMaxSplitCount }, (_, index) => index + 1)
          : []
      }
      onSetSplitCount={handleSetSplitCount}
      onToggleSplitLayout={toggleSplitLayout}
      onCycleSplitPane={cycleSecondaryPane}
      onEditorDomFocusChange={handleQuickBarEditorDomFocusChange}
      onOpenFileTransfer={handleQuickBarOpenFileTransfer}
      onToggleDebugOverlay={handleQuickBarToggleDebugOverlay}
      onToggleAbsoluteLineNumbers={handleQuickBarToggleAbsoluteLineNumbers}
      onRequestRemoteScreenshot={handleQuickBarRequestRemoteScreenshot}
      debugOverlayVisible={debugOverlayVisible}
      absoluteLineNumbersVisible={absoluteLineNumbersVisible}
      remoteScreenshotStatus={resolveRemoteScreenshotQuickBarStatus(remoteScreenshotPreview)}
      shortcutSmartSort={shortcutSmartSort}
      shortcutFrequencyMap={shortcutFrequencyMap}
      onShortcutUse={onShortcutUse}
    />
  ), [
    absoluteLineNumbersVisible,
    activeDraft,
    uiSessionId,
    debugOverlayVisible,
    effectiveKeyboardLiftPx,
    handleSetSplitCount,
    handleQuickBarMeasuredHeightChange,
    handleQuickBarOpenFileTransfer,
    handleQuickBarOpenScheduleComposer,
    handleQuickBarRequestRemoteScreenshot,
    handleQuickBarSendSequence,
    handleQuickBarSessionDraftChange,
    handleQuickBarSessionDraftSend,
    handleQuickBarToggleAbsoluteLineNumbers,
    handleQuickBarToggleDebugOverlay,
    handleToggleKeyboard,
    handleQuickBarEditorDomFocusChange,
    keyboardInset,
    onFileAttach,
    onImagePaste,
    onQuickActionsChange,
    onShortcutActionsChange,
    onShortcutUse,
    quickActions,
    quickBarShellKeyboardLiftPx,
    remoteScreenshotPreview?.phase,
    shortcutActions,
    shortcutFrequencyMap,
    shortcutSmartSort,
    splitAvailable,
    splitVisible,
    currentMaxSplitCount,
    cycleSecondaryPane,
    terminalImeActive,
    toggleSplitLayout,
    workspacePanes.length,
    layoutProfile.stage.containerRadius,
    layoutProfile.stage.outerMargin,
    layoutProfile.stage.paneGap,
    layoutProfile.stage.paneRadius,
    layoutProfile.stage.rowBottomPadding,
  ]);

  return (
    <div
      style={{
        height: shellHeight ? `${shellHeight}px` : '100dvh',
        maxHeight: shellHeight ? `${shellHeight}px` : '100dvh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: mobileTheme.colors.shell,
      }}
    >
      <div>
        <TerminalHeader
          sessions={chromeSessions}
          activeSession={activeChromeSession}
          topInsetPx={headerTopInsetPx}
          showBackButton
          onBack={onOpenConnections}
          onOpenQuickTabPicker={handleOpenQuickTabPickerForPane}
          onOpenTabManager={handleOpenTabManager}
          onSwitchSession={onSwitchSession}
          onRenameSession={onRenameSession}
          onCloseSession={onCloseSession}
          splitVisible={splitVisible}
          paneGroups={paneGroups}
          onAssignSessionToPane={assignSessionToPane}
          onMoveSessionToOtherPane={moveSessionToOtherPane}
          onActivatePane={activatePaneAndSession}
        />
      </div>
      <TerminalNetworkBanner
        connectionIssueVisible={connectionIssueVisible}
        networkOnline={networkOnline}
        activeSessionState={uiSession?.state}
        activeSessionLastError={uiSession?.lastError}
      />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <TerminalStageShell
          interactiveSession={interactiveSession}
          sessionBufferStore={sessionBufferStore}
          sessionHeadStore={sessionHeadStore}
          renderedPaneSessions={renderedPaneSessions}
          visiblePaneEntries={visiblePaneEntries}
          splitVisible={splitVisible}
          activePaneId={workspace.activePaneId}
          terminalChromeBottomPx={terminalChromeBottomPx}
          terminalImeLiftPx={terminalImeLiftPx}
          inputResetEpochBySession={inputResetEpochBySession}
          followResetEpoch={followResetEpoch}
          terminalKeyboardRequested={terminalKeyboardRequested}
          isAndroid={isAndroid}
          onResize={onResize}
          onTerminalInput={onTerminalInput}
          onTerminalWidthModeChange={onTerminalWidthModeChange}
          handleTerminalViewportChange={handleTerminalViewportChange}
          handleSwipeTab={handleSwipeTab}
          handleActiveTerminalActivateInput={handleActiveTerminalActivateInput}
          onActivatePane={activatePaneAndSession}
          focusNonce={focusNonce}
          terminalFontSize={terminalFontSize}
          terminalThemeId={terminalThemeId}
          terminalWidthMode={terminalWidthMode}
          absoluteLineNumbersVisible={absoluteLineNumbersVisible}
        />
        <TerminalDebugOverlay
          visible={debugOverlayVisible}
          session={interactiveSession}
          sessionViewportModeStore={sessionViewportModeStoreRef.current}
          getSessionDebugMetrics={getSessionDebugMetrics}
          debugOverlayPos={debugOverlayPos}
          debugOverlayDragRef={debugOverlayDragRef}
          onClose={() => setDebugOverlayVisible(false)}
          onMove={setDebugOverlayPos}
        />
        <TerminalQuickBarShell bottomPx={terminalImeLiftPx + layoutProfile.quickBar.touchSafeOffsetPx}>
          {quickBarNode}
        </TerminalQuickBarShell>
      </div>
      <TabManagerSheet
        open={tabManagerOpen}
        sessions={
          tabManagerScopePaneId
            ? chromeSessions.filter((session) => {
                const pane = findPaneForSession(session.id);
                return pane?.id === tabManagerScopePaneId;
              })
            : chromeSessions
        }
        activeSessionId={interactiveSession?.id}
        savedTabLists={savedTabLists}
        onClose={() => {
          setTabManagerOpen(false);
          setTabManagerScopePaneId(null);
        }}
        onSwitchSession={onSwitchSession}
        onRenameSession={onRenameSession}
        onCloseSession={onCloseSession}
        onMoveSession={onMoveSession}
        onOpenQuickTabPicker={() => {
          setTabManagerOpen(false);
          const targetPaneId = tabManagerScopePaneId || undefined;
          setTabManagerScopePaneId(null);
          handleOpenQuickTabPickerForPane(targetPaneId);
        }}
        onSaveCurrentTabList={saveCurrentTabList}
        onLoadSavedTabList={loadSavedTabList}
        onDeleteSavedTabList={deleteSavedTabList}
        onExportCurrentTabList={exportCurrentTabList}
        onExportSavedTabList={exportSavedTabList}
        onImportSavedTabLists={importSavedTabLists}
      />
      {interactiveSession ? (
        <SessionScheduleSheet
          open={scheduleOpen}
          sessionName={interactiveSession.sessionName}
          scheduleState={activeScheduleState || { sessionName: interactiveSession.sessionName, jobs: [], loading: false }}
          composerSeedText={scheduleComposerSeed.text}
          composerSeedNonce={scheduleComposerSeed.nonce}
          keyboardInset={keyboardInset}
          onClose={() => {
            setScheduleOpen(false);
            setScheduleComposerSeed((current) => (current.text ? { ...current, text: '' } : current));
          }}
          onRefresh={() => onRequestScheduleList?.(interactiveSession.id)}
          onSave={(job) => onUpsertScheduleJob?.(interactiveSession.id, job)}
          onDelete={(jobId) => onDeleteScheduleJob?.(interactiveSession.id, jobId)}
          onToggle={(jobId, enabled) => onToggleScheduleJob?.(interactiveSession.id, jobId, enabled)}
          onRunNow={(jobId) => onRunScheduleJobNow?.(interactiveSession.id, jobId)}
        />
      ) : null}
      {interactiveSession && onSendMessage && onFileTransferMessage ? (
        <FileTransferSheet
          open={fileTransferOpen}
          remoteCwd=""
          onClose={() => setFileTransferOpen(false)}
          sendJson={sendFileTransferMessage}
          onFileTransferMessage={onFileTransferMessage}
        />
      ) : null}
      <RemoteScreenshotSheet
        state={remoteScreenshotPreview}
        onSave={() => {
          void handleSaveRemoteScreenshot();
        }}
        onDiscard={closeRemoteScreenshotPreview}
      />
    </div>
  );
}

function terminalPagePropsEqual(
  prev: Readonly<TerminalPageProps>,
  next: Readonly<TerminalPageProps>,
) {
  return (
    terminalPageHeaderSessionsUiKey(prev.sessions) === terminalPageHeaderSessionsUiKey(next.sessions)
    && terminalPageActiveRuntimeStatusKey(prev.activeSession)
      === terminalPageActiveRuntimeStatusKey(next.activeSession)
    && prev.getSessionDebugMetrics === next.getSessionDebugMetrics
    && prev.sessionBufferStore === next.sessionBufferStore
    && prev.sessionHeadStore === next.sessionHeadStore
    && resolveSessionInputEpoch(prev.inputResetEpochBySession, prev.activeSession?.id)
      === resolveSessionInputEpoch(next.inputResetEpochBySession, next.activeSession?.id)
    && prev.followResetEpoch === next.followResetEpoch
    && prev.onSwitchSession === next.onSwitchSession
    && prev.onMoveSession === next.onMoveSession
    && prev.onRenameSession === next.onRenameSession
    && prev.onCloseSession === next.onCloseSession
    && prev.onOpenConnections === next.onOpenConnections
    && prev.onOpenQuickTabPicker === next.onOpenQuickTabPicker
    && prev.onResize === next.onResize
    && prev.onTerminalInput === next.onTerminalInput
    && prev.onTerminalViewportChange === next.onTerminalViewportChange
    && prev.onLiveSessionIdsChange === next.onLiveSessionIdsChange
    && prev.onImagePaste === next.onImagePaste
    && prev.onFileAttach === next.onFileAttach
    && prev.onOpenSettings === next.onOpenSettings
    && prev.onRequestRemoteScreenshot === next.onRequestRemoteScreenshot
    && prev.quickActions === next.quickActions
    && prev.shortcutActions === next.shortcutActions
    && prev.onQuickActionInput === next.onQuickActionInput
    && prev.onQuickActionsChange === next.onQuickActionsChange
    && prev.onShortcutActionsChange === next.onShortcutActionsChange
    && prev.sessionDraft === next.sessionDraft
    && prev.onSessionDraftChange === next.onSessionDraftChange
    && prev.onSessionDraftSend === next.onSessionDraftSend
    && prev.onLoadSavedTabList === next.onLoadSavedTabList
    && prev.scheduleState === next.scheduleState
    && prev.onRequestScheduleList === next.onRequestScheduleList
    && prev.onUpsertScheduleJob === next.onUpsertScheduleJob
    && prev.onDeleteScheduleJob === next.onDeleteScheduleJob
    && prev.onToggleScheduleJob === next.onToggleScheduleJob
    && prev.onRunScheduleJobNow === next.onRunScheduleJobNow
    && prev.terminalThemeId === next.terminalThemeId
    && prev.terminalWidthMode === next.terminalWidthMode
    && prev.onTerminalWidthModeChange === next.onTerminalWidthModeChange
    && prev.onSendMessage === next.onSendMessage
    && prev.onFileTransferMessage === next.onFileTransferMessage
    && prev.shortcutSmartSort === next.shortcutSmartSort
    && prev.shortcutFrequencyMap === next.shortcutFrequencyMap
    && prev.onShortcutUse === next.onShortcutUse
  );
}

export const TerminalPage = ReactMemo(TerminalPageComponent, terminalPagePropsEqual);
