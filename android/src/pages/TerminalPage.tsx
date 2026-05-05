import { memo as ReactMemo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Keyboard } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { TerminalView } from '../components/TerminalView';
import type { SessionRenderBufferStore } from '../lib/session-render-buffer-store';
import { createSessionViewportModeStore, useSessionViewportModeSnapshot, type SessionViewportModeStore } from '../lib/session-viewport-mode-store';
import { SessionScheduleSheet } from '../components/terminal/SessionScheduleSheet';
import { FileTransferSheet } from '../components/terminal/FileTransferSheet';
import { RemoteScreenshotSheet, type RemoteScreenshotPreviewState } from '../components/terminal/RemoteScreenshotSheet';
import { TerminalHeader } from '../components/terminal/TerminalHeader';
import { TabManagerSheet } from '../components/terminal/TabManagerSheet';
import { TerminalQuickBar } from '../components/terminal/TerminalQuickBar';
import { APP_VERSION, APP_VERSION_CODE } from '../lib/app-version';
import { getBrowserStorage } from '../lib/browser-storage';
import { mobileTheme } from '../lib/mobile-ui';
import { ImeAnchor } from '../plugins/ImeAnchorPlugin';
import { resolveLayoutProfile, type LayoutProfile } from '../../../packages/shared/src/layout/profile';
import {
  STORAGE_KEYS,
  type PersistedOpenTab,
  type QuickAction,
  type RemoteScreenshotCapture,
  type RemoteScreenshotStatusPayload,
  type SavedTabList,
  type Session,
  type SessionDebugOverlayMetrics,
  type SessionScheduleState,
  type ScheduleJobDraft,
  type TerminalLayoutState,
  type TerminalResizeHandler,
  type TerminalSplitPaneId,
  type TerminalShortcutAction,
  type TerminalVisibleRangeChangeHandler,
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
const TERMINAL_QUICK_BAR_TOUCH_SAFE_OFFSET_PX = 14;
const SPLIT_AUTO_CLOSE_DROP_PX = 96;

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

export function resolveKeyboardLiftPx(reportedKeyboardInset: number) {
  const safeReportedInset = Math.max(0, Math.round(reportedKeyboardInset || 0));
  if (safeReportedInset <= 0 || typeof window === 'undefined') {
    return 0;
  }

  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return safeReportedInset;
  }

  const layoutViewportHeight = Math.max(0, Math.round(window.innerHeight || 0));
  const visibleViewportBottom = Math.max(
    0,
    Math.round((visualViewport.height || 0) + (visualViewport.offsetTop || 0)),
  );
  const occludedBottom = Math.max(0, layoutViewportHeight - visibleViewportBottom);

  if (occludedBottom <= 0) {
    return safeReportedInset;
  }

  return Math.min(safeReportedInset, occludedBottom);
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
  if (typeof window === 'undefined') {
    return 0;
  }
  const visualWidth = Math.round(window.visualViewport?.width || 0);
  return Math.max(visualWidth, Math.round(window.innerWidth || 0));
}

function resolvePaneId(
  assignments: Partial<Record<string, TerminalSplitPaneId>>,
  sessionId: string | null | undefined,
): TerminalSplitPaneId {
  if (!sessionId) {
    return 'primary';
  }
  return assignments[sessionId] === 'secondary' ? 'secondary' : 'primary';
}

function findFirstSessionForPane(
  sessions: Session[],
  assignments: Partial<Record<string, TerminalSplitPaneId>>,
  paneId: TerminalSplitPaneId,
  excludeSessionId?: string | null,
) {
  return sessions.find((session) => (
    session.id !== excludeSessionId
    && resolvePaneId(assignments, session.id) === paneId
  )) || null;
}

function normalizeTerminalLayoutState(input: unknown): TerminalLayoutState | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<TerminalLayoutState>;
  const assignmentsInput = candidate.splitPaneAssignments;
  const splitPaneAssignments: Partial<Record<string, TerminalSplitPaneId>> = {};
  if (assignmentsInput && typeof assignmentsInput === 'object') {
    for (const [sessionId, paneId] of Object.entries(assignmentsInput)) {
      if (!sessionId.trim()) {
        continue;
      }
      splitPaneAssignments[sessionId] = paneId === 'secondary' ? 'secondary' : 'primary';
    }
  }

  return {
    splitEnabled: Boolean(candidate.splitEnabled),
    splitSecondarySessionId:
      typeof candidate.splitSecondarySessionId === 'string' && candidate.splitSecondarySessionId.trim()
        ? candidate.splitSecondarySessionId.trim()
        : null,
    splitPaneAssignments,
  };
}

function readPersistedTerminalLayoutState(): TerminalLayoutState | null {
  const storage = getBrowserStorage();
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(STORAGE_KEYS.TERMINAL_LAYOUT);
    return normalizeTerminalLayoutState(raw ? JSON.parse(raw) : null);
  } catch (error) {
    console.error('[TerminalPage] Failed to load terminal layout:', error);
    return null;
  }
}

function persistTerminalLayoutState(layout: TerminalLayoutState) {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify(layout));
  } catch (error) {
    console.error('[TerminalPage] Failed to persist terminal layout:', error);
  }
}

interface TerminalPageProps {
  sessions: Session[];
  activeSession: Session | null;
  getSessionDebugMetrics?: (sessionId: string) => SessionDebugOverlayMetrics | null;
  sessionBufferStore?: SessionRenderBufferStore | null;
  inputResetEpochBySession?: Record<string, number>;
  followResetEpoch?: number;
  onSwitchSession: (id: string) => void;
  onMoveSession: (id: string, toIndex: number) => void;
  onRenameSession: (id: string, name: string) => void;
  onCloseSession: (id: string, source?: string) => void;
  onOpenConnections: () => void;
  onOpenQuickTabPicker: () => void;
  onResize?: TerminalResizeHandler;
  onTerminalInput?: (sessionId: string, data: string) => void;
  onTerminalViewportChange?: TerminalViewportChangeHandler;
  onTerminalVisibleRangeChange?: TerminalVisibleRangeChangeHandler;
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
  hostId: string;
  connectionName: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  title: string;
  customName?: string;
  createdAt: number;
  resolvedPath?: Session['resolvedPath'];
}

function terminalPageSessionUiKey(
  session: Session | null | undefined,
  options?: { includeRuntimeStatus?: boolean },
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
    session.title,
    session.customName || '',
    String(session.createdAt),
    session.resolvedPath || '',
    session.authToken || '',
    session.autoCommand || '',
    options?.includeRuntimeStatus ? session.state : '',
    options?.includeRuntimeStatus ? (session.lastError || '') : '',
  ].join('::');
}

function terminalPageSessionsUiKey(sessions: Session[]) {
  return sessions.map((session) => terminalPageSessionUiKey(session)).join('||');
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
    hostId: session.hostId,
    connectionName: session.connectionName,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    title: session.title,
    customName: session.customName,
    createdAt: session.createdAt,
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
  activeSession,
  sessionBufferStore,
  renderedPaneSessions,
  visiblePaneSessionIds,
  splitVisible,
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
  focusNonce,
  terminalFontSize,
  terminalThemeId,
  terminalWidthMode,
  absoluteLineNumbersVisible,
}: {
  activeSession: Session | null;
  sessionBufferStore?: SessionRenderBufferStore | null;
  renderedPaneSessions: Session[];
  visiblePaneSessionIds: string[];
  splitVisible: boolean;
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
  focusNonce: number;
  terminalFontSize: number;
  terminalThemeId?: string;
  terminalWidthMode: TerminalWidthMode;
  absoluteLineNumbersVisible: boolean;
}) {
  const terminalPaneStyle = useCallback((paneSessionId: string): CSSProperties => {
    if (!splitVisible) {
      const isActivePaneSession = paneSessionId === activeSession?.id;
      return {
        position: 'absolute',
        inset: 0,
        visibility: isActivePaneSession ? 'visible' : 'hidden',
        opacity: isActivePaneSession ? 1 : 0,
        zIndex: isActivePaneSession ? 1 : 0,
      };
    }
    const paneIndex = visiblePaneSessionIds.indexOf(paneSessionId);
    if (paneIndex < 0) {
      return {
        position: 'absolute',
        inset: 0,
        visibility: 'hidden',
        pointerEvents: 'none',
      };
    }
    return {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: paneIndex === 0 ? 0 : '50%',
      width: '50%',
      paddingLeft: paneIndex === 0 ? 0 : '4px',
      paddingRight: paneIndex === 0 ? '4px' : 0,
      boxSizing: 'border-box',
    };
  }, [activeSession?.id, splitVisible, visiblePaneSessionIds]);

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
          margin: '0 4px',
          borderRadius: '14px',
          backgroundColor: mobileTheme.colors.canvas,
          overflow: 'hidden',
          border: `1px solid ${mobileTheme.colors.cardBorder}`,
          position: 'relative',
          overscrollBehaviorY: 'contain',
        }}
      >
        {activeSession ? (
          renderedPaneSessions.map((session) => {
            const sessionIsActive = session.id === activeSession?.id;
            return (
              <div
                key={session.id}
                style={{
                  ...terminalPaneStyle(session.id),
                  pointerEvents: sessionIsActive ? 'auto' : 'none',
                  borderRadius: splitVisible ? '12px' : undefined,
                  outline: splitVisible && sessionIsActive ? '2px solid rgba(83, 139, 255, 0.78)' : undefined,
                  outlineOffset: splitVisible && sessionIsActive ? '-2px' : undefined,
                  overflow: 'hidden',
                }}
              >
                <TerminalView
                  sessionId={session.id}
                  sessionBufferStore={sessionBufferStore}
                  active={sessionIsActive}
                  live={visiblePaneSessionIds.includes(session.id)}
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
              </div>
            );
          })
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
  terminalPageSessionUiKey(prev.activeSession) === terminalPageSessionUiKey(next.activeSession)
  && terminalPageSessionsUiKey(prev.renderedPaneSessions) === terminalPageSessionsUiKey(next.renderedPaneSessions)
  && prev.sessionBufferStore === next.sessionBufferStore
  && prev.splitVisible === next.splitVisible
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
  && prev.visiblePaneSessionIds.join('||') === next.visiblePaneSessionIds.join('||')
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

async function persistRemoteScreenshotCapture(fileName: string, dataBase64: string) {
  const downloadDir = '/storage/emulated/0/Download/zterm';
  try {
    await Filesystem.mkdir({
      path: downloadDir,
      directory: Directory.ExternalStorage,
      recursive: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const alreadyExists = /exist/i.test(message) || /EEXIST/i.test(message);
    if (!alreadyExists) {
      throw new Error(`创建截图保存目录失败: ${message}`);
    }
  }

  const savedPath = `${downloadDir}/${fileName}`;
  await Filesystem.writeFile({
    path: savedPath,
    data: dataBase64,
    directory: Directory.ExternalStorage,
  });
  return savedPath;
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
  inputResetEpochBySession,
  followResetEpoch = 0,
  onSwitchSession,
  onMoveSession,
  onRenameSession,
  onCloseSession,
  onOpenConnections,
  onOpenQuickTabPicker,
  onResize,
  onTerminalInput,
  onTerminalViewportChange,
  onTerminalVisibleRangeChange,
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
  const persistedLayoutRef = useRef<TerminalLayoutState | null>(readPersistedTerminalLayoutState());
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
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [fileTransferOpen, setFileTransferOpen] = useState(false);
  const [remoteScreenshotPreview, setRemoteScreenshotPreview] = useState<RemoteScreenshotPreviewState | null>(null);
  const [splitEnabled, setSplitEnabled] = useState(() => persistedLayoutRef.current?.splitEnabled || false);
  const [splitSecondarySessionId, setSplitSecondarySessionId] = useState<string | null>(
    () => persistedLayoutRef.current?.splitSecondarySessionId || null,
  );
  const [splitPaneAssignments, setSplitPaneAssignments] = useState<Partial<Record<string, TerminalSplitPaneId>>>(
    () => persistedLayoutRef.current?.splitPaneAssignments || {},
  );
  const [viewportWidth, setViewportWidth] = useState(() => resolveWindowWidth());
  const [headerTopInsetPx, setHeaderTopInsetPx] = useState(() => resolveTerminalHeaderTopInsetPx(isAndroid));
  const [scheduleComposerSeed, setScheduleComposerSeed] = useState<ScheduleComposerSeed>({ nonce: 0, text: '' });
  const viewportMetricsFrameRef = useRef<number | null>(null);
  const [savedTabLists, setSavedTabLists] = useState<SavedTabList[]>([]);
  const [debugOverlayVisible, setDebugOverlayVisible] = useState(true);
  const [absoluteLineNumbersVisible, setAbsoluteLineNumbersVisible] = useState(false);
  const sessionViewportModeStoreRef = useRef(createSessionViewportModeStore());
  const [debugOverlayPos, setDebugOverlayPos] = useState({ x: -1, y: -1 }); // -1 means use defaults
  const debugOverlayDragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number; dragging: boolean }>({ startX: 0, startY: 0, startPosX: 0, startPosY: 0, dragging: false });
  const connectionIssueTimerRef = useRef<number | null>(null);
  const activeSessionIdRef = useRef<string | null>(activeSession?.id || null);
  const quickBarEditorFocusedRef = useRef(quickBarEditorFocused);
  const terminalInputHandlerRef = useRef<typeof onTerminalInput>(onTerminalInput);
  const splitOpenWidthRef = useRef(0);
  const splitOpenProfileRef = useRef<LayoutProfile>('phone-single');
  const pendingAndroidImeFocusTimerRef = useRef<number | null>(null);
  const terminalFocusRetryTimeoutsRef = useRef<number[]>([]);
  const remoteScreenshotPreviewUrlRef = useRef<string | null>(null);
  const remoteScreenshotRequestEpochRef = useRef(0);

  useEffect(() => {
    activeSessionIdRef.current = activeSession?.id || null;
  }, [activeSession?.id]);

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

  const splitAvailable = sessions.length > 1 && Boolean(activeSession);
  const activePaneId = resolvePaneId(splitPaneAssignments, activeSession?.id);
  const passivePaneId: TerminalSplitPaneId = activePaneId === 'primary' ? 'secondary' : 'primary';
  const primaryPaneSession = activeSession && activePaneId === 'primary'
    ? activeSession
    : findFirstSessionForPane(sessions, splitPaneAssignments, 'primary', activeSession?.id);
  const secondarySession = activeSession && activePaneId === 'secondary'
    ? activeSession
    : (
      sessions.find((session) => (
        session.id === splitSecondarySessionId
        && session.id !== activeSession?.id
        && resolvePaneId(splitPaneAssignments, session.id) === 'secondary'
      ))
        || findFirstSessionForPane(sessions, splitPaneAssignments, 'secondary', activeSession?.id)
    );
  const splitVisible = splitEnabled
    && Boolean(primaryPaneSession && secondarySession && primaryPaneSession.id !== secondarySession.id);
  const visiblePaneSessionIds = activeSession
    ? splitVisible
      ? [primaryPaneSession!.id, secondarySession!.id]
      : [activeSession.id]
    : [];
  const renderedPaneSessions = splitVisible
    ? visiblePaneSessionIds
        .map((sessionId) => sessions.find((session) => session.id === sessionId) || null)
        .filter((session): session is Session => Boolean(session))
    : (activeSession ? [activeSession] : []);
  const livePaneSessionIds = useMemo(
    () => renderedPaneSessions.map((session) => session.id),
    [renderedPaneSessions],
  );
  const livePaneSessionIdsKey = useMemo(
    () => livePaneSessionIds.join('||'),
    [livePaneSessionIds],
  );
  const headerSessionsUiKey = useMemo(() => terminalPageSessionsUiKey(sessions), [sessions]);
  const activeHeaderSessionUiKey = useMemo(() => terminalPageSessionUiKey(activeSession), [activeSession]);
  const chromeSessions = useMemo(() => sessions.map(toTerminalTabChromeItem), [headerSessionsUiKey]);
  const activeChromeSession = useMemo(() => (
    activeSession ? toTerminalTabChromeItem(activeSession) : null
  ), [activeHeaderSessionUiKey]);
  const activeDraft = sessionDraft;
  const activeScheduleState = scheduleState || null;
  const activeSessionRef = useRef(activeSession);
  const sessionsRef = useRef(sessions);
  const splitPaneAssignmentsRef = useRef(splitPaneAssignments);
  const splitEnabledRef = useRef(splitEnabled);
  const splitVisibleRef = useRef(splitVisible);
  const activePaneIdRef = useRef<TerminalSplitPaneId>(activePaneId);
  const passivePaneIdRef = useRef<TerminalSplitPaneId>(passivePaneId);
  const secondarySessionIdRef = useRef<string | null>(secondarySession?.id || null);
  const previousLivePaneSessionIdsKeyRef = useRef<string>('');

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
    activeSessionRef.current = activeSession;
    sessionsRef.current = sessions;
    splitPaneAssignmentsRef.current = splitPaneAssignments;
    splitEnabledRef.current = splitEnabled;
    splitVisibleRef.current = splitVisible;
    activePaneIdRef.current = activePaneId;
    passivePaneIdRef.current = passivePaneId;
    secondarySessionIdRef.current = secondarySession?.id || null;
  }, [
    activePaneId,
    activeSession,
    passivePaneId,
    secondarySession?.id,
    sessions,
    splitEnabled,
    splitPaneAssignments,
    splitVisible,
  ]);

  useEffect(() => {
    setSplitPaneAssignments((current) => {
      const next: Partial<Record<string, TerminalSplitPaneId>> = {};
      let primaryCount = 0;
      let secondaryCount = 0;

      for (const session of sessions) {
        const existing = current[session.id];
        const paneId = existing
          || (activeSession?.id === session.id
            ? 'primary'
            : secondaryCount === 0
              ? 'secondary'
              : primaryCount <= secondaryCount
                ? 'primary'
                : 'secondary');
        next[session.id] = paneId;
        if (paneId === 'secondary') {
          secondaryCount += 1;
        } else {
          primaryCount += 1;
        }
      }

      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      if (
        currentKeys.length === nextKeys.length
        && nextKeys.every((key) => current[key] === next[key])
      ) {
        return current;
      }
      return next;
    });
  }, [activeSession?.id, sessions]);

  useEffect(() => {
    if (!splitAvailable) {
      setSplitEnabled(false);
      setSplitSecondarySessionId(null);
      return;
    }
    if (splitSecondarySessionId && splitSecondarySessionId !== activeSession?.id) {
      return;
    }
    const nextSecondary = sessions.find((session) => (
      session.id !== activeSession?.id
      && resolvePaneId(splitPaneAssignments, session.id) === 'secondary'
    )) || sessions.find((session) => session.id !== activeSession?.id) || null;
    setSplitSecondarySessionId(nextSecondary?.id || null);
  }, [activeSession?.id, sessions, splitAvailable, splitPaneAssignments, splitSecondarySessionId]);

  useEffect(() => {
    if (!splitEnabled || !splitAvailable || !activeSession) {
      return;
    }
    setSplitPaneAssignments((current) => {
      const activePane = resolvePaneId(current, activeSession.id);
      const oppositePane: TerminalSplitPaneId = activePane === 'primary' ? 'secondary' : 'primary';
      const hasOpposite = sessions.some((session) => (
        session.id !== activeSession.id
        && resolvePaneId(current, session.id) === oppositePane
      ));
      if (hasOpposite) {
        return current;
      }
      const candidate = sessions.find((session) => session.id !== activeSession.id);
      if (!candidate) {
        return current;
      }
      return {
        ...current,
        [candidate.id]: oppositePane,
      };
    });
  }, [activeSession, splitAvailable, splitEnabled, sessions]);

  useEffect(() => {
    const sessionIds = new Set(sessions.map((session) => session.id));
    const persistedAssignments = Object.fromEntries(
      Object.entries(splitPaneAssignments).filter(([sessionId]) => sessionIds.has(sessionId)),
    ) as Partial<Record<string, TerminalSplitPaneId>>;

    persistTerminalLayoutState({
      splitEnabled: splitEnabled && sessions.length > 1 && Boolean(activeSession),
      splitSecondarySessionId:
        splitSecondarySessionId && sessionIds.has(splitSecondarySessionId)
          ? splitSecondarySessionId
          : null,
      splitPaneAssignments: persistedAssignments,
    });
  }, [activeSession, sessions, splitEnabled, splitPaneAssignments, splitSecondarySessionId]);

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

  useEffect(() => {
    if (!splitVisible) {
      return;
    }
    if (splitOpenProfileRef.current === 'phone-single') {
      return;
    }
    const currentProfile = resolveLayoutProfile({ width: viewportWidth }).profile;
    if (
      currentProfile === 'phone-single'
      && viewportWidth + SPLIT_AUTO_CLOSE_DROP_PX < splitOpenWidthRef.current
    ) {
      setSplitEnabled(false);
    }
  }, [splitVisible, viewportWidth]);

  const focusTerminalInput = useCallback(() => {
    setFocusNonce((value) => value + 1);

    const input = querySessionInput(activeSession?.id || null);
    if (!input) {
      return;
    }

    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [activeSession?.id]);

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

  const revokeRemoteScreenshotPreviewUrl = useCallback(() => {
    if (!remoteScreenshotPreviewUrlRef.current) {
      return;
    }
    URL.revokeObjectURL(remoteScreenshotPreviewUrlRef.current);
    remoteScreenshotPreviewUrlRef.current = null;
  }, []);

  const closeRemoteScreenshotPreview = useCallback(() => {
    remoteScreenshotRequestEpochRef.current += 1;
    revokeRemoteScreenshotPreviewUrl();
    setRemoteScreenshotPreview(null);
  }, [revokeRemoteScreenshotPreviewUrl]);

  useEffect(() => () => {
    revokeRemoteScreenshotPreviewUrl();
  }, [revokeRemoteScreenshotPreviewUrl]);

  const handleRequestRemoteScreenshot = useCallback(async () => {
    const targetSessionId = activeSession?.id;
    if (!targetSessionId || !onRequestRemoteScreenshot) {
      alert('当前没有可用的目标 session');
      return;
    }

    const requestEpoch = remoteScreenshotRequestEpochRef.current + 1;
    remoteScreenshotRequestEpochRef.current = requestEpoch;
    revokeRemoteScreenshotPreviewUrl();
    setRemoteScreenshotPreview({
      phase: 'request-sent',
      fileName: `remote-screenshot-${Date.now()}.png`,
      previewDataUrl: null,
      rawDataBase64: null,
    });

    try {
      const capture = await onRequestRemoteScreenshot(targetSessionId, (progress) => {
        if (remoteScreenshotRequestEpochRef.current !== requestEpoch) {
          return;
        }
        setRemoteScreenshotPreview((current) => ({
          phase: progress.phase,
          fileName: progress.fileName || current?.fileName || `remote-screenshot-${Date.now()}.png`,
          previewDataUrl: current?.previewDataUrl || null,
          rawDataBase64: current?.rawDataBase64 || null,
          receivedChunks: Math.max(0, Math.floor(progress.receivedChunks || current?.receivedChunks || 0)),
          totalChunks: Math.max(0, Math.floor(progress.totalChunks || current?.totalChunks || 0)),
          totalBytes: Math.max(0, Math.floor(progress.totalBytes || current?.totalBytes || 0)),
        }));
      });

      if (remoteScreenshotRequestEpochRef.current !== requestEpoch) {
        return;
      }
      setRemoteScreenshotPreview((current) => current ? {
        ...current,
        phase: 'transfer-complete',
        fileName: capture.fileName,
        totalBytes: capture.totalBytes,
      } : current);

      const binary = capture.dataBytes
        ?? Uint8Array.from(atob(capture.dataBase64), (char) => char.charCodeAt(0));
      const blob = new Blob([binary.buffer as ArrayBuffer], { type: capture.mimeType || 'image/png' });
      const previewUrl = URL.createObjectURL(blob);
      if (remoteScreenshotRequestEpochRef.current !== requestEpoch) {
        URL.revokeObjectURL(previewUrl);
        return;
      }
      remoteScreenshotPreviewUrlRef.current = previewUrl;
      setRemoteScreenshotPreview({
        phase: 'preview-ready',
        fileName: capture.fileName,
        previewDataUrl: previewUrl,
        rawDataBase64: capture.dataBase64,
        receivedChunks: undefined,
        totalChunks: undefined,
        totalBytes: capture.totalBytes,
      });
    } catch (error) {
      if (remoteScreenshotRequestEpochRef.current !== requestEpoch) {
        return;
      }
      setRemoteScreenshotPreview((current) => ({
        phase: 'failed',
        fileName: current?.fileName || `remote-screenshot-${Date.now()}.png`,
        previewDataUrl: null,
        rawDataBase64: null,
        receivedChunks: current?.receivedChunks,
        totalChunks: current?.totalChunks,
        totalBytes: current?.totalBytes,
        errorMessage: error instanceof Error ? error.message : '远程截图失败',
      }));
    }
  }, [activeSession?.id, onRequestRemoteScreenshot, revokeRemoteScreenshotPreviewUrl]);

  const handleQuickBarMeasuredHeightChange = useCallback((height: number) => {
    setQuickBarHeight((current) => (current === height ? current : height));
  }, []);

  const handleQuickBarSendSequence = useCallback((sequence: string) => {
    onQuickActionInput?.(sequence, activeSession?.id);
    if (terminalKeyboardRequested || keyboardInset > 0) {
      keepTerminalInputFocused();
    }
  }, [activeSession?.id, keyboardInset, onQuickActionInput, terminalKeyboardRequested]);

  const handleQuickBarSessionDraftChange = useCallback((value: string) => {
    onSessionDraftChange?.(value, activeSession?.id);
  }, [activeSession?.id, onSessionDraftChange]);

  const handleQuickBarSessionDraftSend = useCallback((value: string) => {
    onSessionDraftSend?.(value, activeSession?.id);
    if (terminalKeyboardRequested || keyboardInset > 0) {
      keepTerminalInputFocused();
    }
  }, [activeSession?.id, keyboardInset, onSessionDraftSend, terminalKeyboardRequested]);

  const handleQuickBarOpenScheduleComposer = useCallback((text: string) => {
    const targetSessionId = activeSession?.id;
    if (!targetSessionId) {
      return;
    }
    onRequestScheduleList?.(targetSessionId);
    setScheduleComposerSeed({
      nonce: Date.now(),
      text,
    });
    setScheduleOpen(true);
  }, [activeSession?.id, onRequestScheduleList]);

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
    const currentAssignments = splitPaneAssignmentsRef.current;
    const currentActivePaneId = activePaneIdRef.current;
    const paneScopedSessions = currentSplitVisible
      ? currentSessions.filter((session) => resolvePaneId(currentAssignments, session.id) === currentActivePaneId)
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
  }, [onSwitchSession]);

  const handleSaveRemoteScreenshot = useCallback(async () => {
    if (
      !remoteScreenshotPreview?.previewDataUrl
      || !remoteScreenshotPreview.rawDataBase64
      || remoteScreenshotPreview.phase !== 'preview-ready'
    ) {
      return;
    }

    setRemoteScreenshotPreview((current) => current ? { ...current, phase: 'saving' } : current);
    try {
      const savedPath = await persistRemoteScreenshotCapture(
        remoteScreenshotPreview.fileName,
        remoteScreenshotPreview.rawDataBase64,
      );
      closeRemoteScreenshotPreview();
      alert(`截图已保存到 ${savedPath}`);
    } catch (error) {
      setRemoteScreenshotPreview((current) => current ? { ...current, phase: 'preview-ready' } : current);
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
      const input = querySessionInput(activeSession?.id || null);
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
  }, [activeSession?.id, clearPendingAndroidImeFocus, clearTerminalFocusRetries, focusTerminalInput, isAndroid, keyboardInset, quickBarEditorFocused, scheduleTerminalFocusRetries, terminalKeyboardRequested]);

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
    if (!isAndroid || quickBarEditorFocused || !activeSession?.id) {
      return;
    }
    if (!(terminalKeyboardRequested || keyboardInset > 0)) {
      return;
    }
    requestAndroidImeFocus();
  }, [activeSession?.id, isAndroid, keyboardInset, quickBarEditorFocused, requestAndroidImeFocus, terminalKeyboardRequested]);

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
    const hasIssue = !networkOnline || activeSession?.state === 'reconnecting' || activeSession?.state === 'error';

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
  }, [activeSession?.state, connectionIssueVisible, networkOnline]);


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

    const input = querySessionInput(activeSession?.id || null);
    input?.blur();
  }, [activeSession?.id, clearPendingAndroidImeFocus, clearTerminalFocusRetries, isAndroid]);

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
          emitToActiveSession((event.text || '').replace(/\n/g, '\r'));
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

  const terminalChromeBottomPx = Math.max(0, quickBarHeight + TERMINAL_QUICK_BAR_TOUCH_SAFE_OFFSET_PX);
  const effectiveKeyboardLiftPx = resolveKeyboardLiftPx(keyboardInset);
  const terminalImeActive = terminalKeyboardRequested && !quickBarEditorFocused;
  const terminalImeLiftPx = terminalImeActive ? effectiveKeyboardLiftPx : 0;
  const quickBarShellKeyboardLiftPx = keyboardInset > 0 ? effectiveKeyboardLiftPx : 0;
  const shellHeight = Math.max(0, typeof window !== 'undefined' ? window.innerHeight : 0);
  const currentPersistedTabs = sessions.map(toPersistedOpenTab);

  const saveCurrentTabList = (name: string) => {
    const now = Date.now();
    const nextList: SavedTabList = {
      id: `tab-list-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      tabs: currentPersistedTabs,
      activeSessionId: activeSession?.id || undefined,
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
    activeSessionId: activeSession?.id || undefined,
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

  const cycleSecondaryPane = useCallback(() => {
    const currentActiveSession = activeSessionRef.current;
    const currentSessions = sessionsRef.current;
    const currentAssignments = splitPaneAssignmentsRef.current;
    const currentPassivePaneId = passivePaneIdRef.current;
    const currentSecondarySessionId = secondarySessionIdRef.current;
    if (!currentActiveSession) {
      return;
    }
    const candidates = currentSessions.filter((session) => (
      session.id !== currentActiveSession.id
      && resolvePaneId(currentAssignments, session.id) === currentPassivePaneId
    ));
    if (candidates.length === 0) {
      return;
    }
    const currentIndex = candidates.findIndex((session) => session.id === currentSecondarySessionId);
    const nextSession = candidates[(currentIndex + 1) % candidates.length] || candidates[0];
    setSplitSecondarySessionId(nextSession.id);
  }, []);

  const assignSessionToPane = useCallback((sessionId: string, paneId: TerminalSplitPaneId) => {
    setSplitPaneAssignments((current) => {
      if (current[sessionId] === paneId) {
        return current;
      }
      const next = {
        ...current,
        [sessionId]: paneId,
      };
      const currentActiveSession = activeSessionRef.current;
      const currentSessions = sessionsRef.current;
      const currentSplitEnabled = splitEnabledRef.current;
      if (currentSplitEnabled && currentActiveSession?.id === sessionId) {
        const oppositePane: TerminalSplitPaneId = paneId === 'primary' ? 'secondary' : 'primary';
        const hasOpposite = currentSessions.some((session) => (
          session.id !== sessionId
          && resolvePaneId(next, session.id) === oppositePane
        ));
        if (!hasOpposite) {
          const candidate = currentSessions.find((session) => session.id !== sessionId);
          if (candidate) {
            next[candidate.id] = oppositePane;
          }
        }
      }
      return next;
    });
  }, []);

  const moveSessionToOtherPane = useCallback((sessionId: string) => {
    const currentPane = resolvePaneId(splitPaneAssignmentsRef.current, sessionId);
    assignSessionToPane(sessionId, currentPane === 'primary' ? 'secondary' : 'primary');
  }, [assignSessionToPane]);

  const toggleSplitLayout = useCallback(() => {
    const currentSplitVisible = splitVisibleRef.current;
    const currentActiveSession = activeSessionRef.current;
    const currentSessions = sessionsRef.current;
    const currentAssignments = splitPaneAssignmentsRef.current;
    if (!currentSplitVisible) {
      const currentWidth = resolveWindowWidth();
      splitOpenWidthRef.current = currentWidth;
      splitOpenProfileRef.current = resolveLayoutProfile({ width: currentWidth }).profile;
      if (currentActiveSession) {
        const activePane = resolvePaneId(currentAssignments, currentActiveSession.id);
        const oppositePane: TerminalSplitPaneId = activePane === 'primary' ? 'secondary' : 'primary';
        const hasOpposite = currentSessions.some((session) => (
          session.id !== currentActiveSession.id
          && resolvePaneId(currentAssignments, session.id) === oppositePane
        ));
        if (!hasOpposite) {
          const candidate = currentSessions.find((session) => session.id !== currentActiveSession.id);
          if (candidate) {
            assignSessionToPane(candidate.id, oppositePane);
            setSplitSecondarySessionId(candidate.id);
          }
        }
      }
      setSplitEnabled(true);
      return;
    }

    setSplitEnabled(false);
  }, [assignSessionToPane]);

  const handleTerminalViewportChange = useCallback<TerminalViewportChangeHandler>((sessionId, viewState) => {
    sessionViewportModeStoreRef.current.setMode(sessionId, viewState.mode);
    onTerminalViewportChange?.(sessionId, viewState);
    onTerminalVisibleRangeChange?.(sessionId, {
      startIndex: Math.max(0, Math.floor(viewState.viewportEndIndex - viewState.viewportRows)),
      endIndex: Math.max(0, Math.floor(viewState.viewportEndIndex)),
      viewportRows: Math.max(1, Math.floor(viewState.viewportRows)),
    });
  }, [onTerminalViewportChange, onTerminalVisibleRangeChange]);

  const quickBarNode = useMemo(() => (
    <TerminalQuickBar
      activeSessionId={activeSession?.id}
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
      onToggleSplitLayout={toggleSplitLayout}
      onCycleSplitPane={cycleSecondaryPane}
      onEditorDomFocusChange={handleQuickBarEditorDomFocusChange}
      onOpenFileTransfer={handleQuickBarOpenFileTransfer}
      onToggleDebugOverlay={handleQuickBarToggleDebugOverlay}
      onToggleAbsoluteLineNumbers={handleQuickBarToggleAbsoluteLineNumbers}
      onRequestRemoteScreenshot={handleQuickBarRequestRemoteScreenshot}
      debugOverlayVisible={debugOverlayVisible}
      absoluteLineNumbersVisible={absoluteLineNumbersVisible}
      remoteScreenshotStatus={
        remoteScreenshotPreview?.phase === 'request-sent'
          ? 'capturing'
          : remoteScreenshotPreview?.phase === 'transfer-complete'
            ? 'transferring'
            : remoteScreenshotPreview?.phase === 'preview-ready'
              ? 'preview-ready'
              : remoteScreenshotPreview?.phase === 'saving'
                ? 'saving'
                : remoteScreenshotPreview?.phase === 'failed'
                  ? 'failed'
                : remoteScreenshotPreview?.phase === 'capturing'
                  ? 'capturing'
                : remoteScreenshotPreview?.phase === 'transferring'
                  ? 'transferring'
                  : 'idle'
      }
      shortcutSmartSort={shortcutSmartSort}
      shortcutFrequencyMap={shortcutFrequencyMap}
      onShortcutUse={onShortcutUse}
    />
  ), [
    absoluteLineNumbersVisible,
    activeDraft,
    activeSession?.id,
    cycleSecondaryPane,
    debugOverlayVisible,
    effectiveKeyboardLiftPx,
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
    terminalImeActive,
    toggleSplitLayout,
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
          onBack={onOpenConnections}
          onOpenQuickTabPicker={onOpenQuickTabPicker}
          onOpenTabManager={() => setTabManagerOpen(true)}
          onSwitchSession={onSwitchSession}
          onRenameSession={onRenameSession}
          onCloseSession={onCloseSession}
          splitVisible={splitVisible}
          sessionPaneAssignments={splitPaneAssignments}
          onAssignSessionToPane={assignSessionToPane}
          onMoveSessionToOtherPane={moveSessionToOtherPane}
        />
      </div>
      <TerminalNetworkBanner
        connectionIssueVisible={connectionIssueVisible}
        networkOnline={networkOnline}
        activeSessionState={activeSession?.state}
        activeSessionLastError={activeSession?.lastError}
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
          activeSession={activeSession}
          sessionBufferStore={sessionBufferStore}
          renderedPaneSessions={renderedPaneSessions}
          visiblePaneSessionIds={visiblePaneSessionIds}
          splitVisible={splitVisible}
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
          focusNonce={focusNonce}
          terminalFontSize={terminalFontSize}
          terminalThemeId={terminalThemeId}
          terminalWidthMode={terminalWidthMode}
          absoluteLineNumbersVisible={absoluteLineNumbersVisible}
        />
        <TerminalDebugOverlay
          visible={debugOverlayVisible}
          session={activeSession}
          sessionViewportModeStore={sessionViewportModeStoreRef.current}
          getSessionDebugMetrics={getSessionDebugMetrics}
          debugOverlayPos={debugOverlayPos}
          debugOverlayDragRef={debugOverlayDragRef}
          onClose={() => setDebugOverlayVisible(false)}
          onMove={setDebugOverlayPos}
        />
        <TerminalQuickBarShell bottomPx={terminalImeLiftPx + TERMINAL_QUICK_BAR_TOUCH_SAFE_OFFSET_PX}>
          {quickBarNode}
        </TerminalQuickBarShell>
      </div>
      <TabManagerSheet
        open={tabManagerOpen}
        sessions={chromeSessions}
        activeSessionId={activeSession?.id}
        savedTabLists={savedTabLists}
        onClose={() => setTabManagerOpen(false)}
        onSwitchSession={onSwitchSession}
        onRenameSession={onRenameSession}
        onCloseSession={onCloseSession}
        onMoveSession={onMoveSession}
        onOpenQuickTabPicker={() => {
          setTabManagerOpen(false);
          onOpenQuickTabPicker();
        }}
        onSaveCurrentTabList={saveCurrentTabList}
        onLoadSavedTabList={loadSavedTabList}
        onDeleteSavedTabList={deleteSavedTabList}
        onExportCurrentTabList={exportCurrentTabList}
        onExportSavedTabList={exportSavedTabList}
        onImportSavedTabLists={importSavedTabLists}
      />
      {activeSession ? (
        <SessionScheduleSheet
          open={scheduleOpen}
          sessionName={activeSession.sessionName}
          scheduleState={activeScheduleState || { sessionName: activeSession.sessionName, jobs: [], loading: false }}
          composerSeedText={scheduleComposerSeed.text}
          composerSeedNonce={scheduleComposerSeed.nonce}
          keyboardInset={keyboardInset}
          onClose={() => {
            setScheduleOpen(false);
            setScheduleComposerSeed((current) => (current.text ? { ...current, text: '' } : current));
          }}
          onRefresh={() => onRequestScheduleList?.(activeSession.id)}
          onSave={(job) => onUpsertScheduleJob?.(activeSession.id, job)}
          onDelete={(jobId) => onDeleteScheduleJob?.(activeSession.id, jobId)}
          onToggle={(jobId, enabled) => onToggleScheduleJob?.(activeSession.id, jobId, enabled)}
          onRunNow={(jobId) => onRunScheduleJobNow?.(activeSession.id, jobId)}
        />
      ) : null}
      {activeSession && onSendMessage && onFileTransferMessage ? (
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
    terminalPageSessionsUiKey(prev.sessions) === terminalPageSessionsUiKey(next.sessions)
    && terminalPageSessionUiKey(prev.activeSession, { includeRuntimeStatus: true })
      === terminalPageSessionUiKey(next.activeSession, { includeRuntimeStatus: true })
    && prev.getSessionDebugMetrics === next.getSessionDebugMetrics
    && prev.sessionBufferStore === next.sessionBufferStore
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
    && prev.onTerminalVisibleRangeChange === next.onTerminalVisibleRangeChange
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
