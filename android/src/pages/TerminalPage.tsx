import { memo as ReactMemo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Keyboard } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import type { SessionRenderBufferStore } from '../lib/session-render-buffer-store';
import { createSessionViewportModeStore, useSessionViewportModeSnapshot, type SessionViewportModeStore } from '../lib/session-viewport-mode-store';
import { SessionScheduleSheet } from '../components/terminal/SessionScheduleSheet';
import { FileTransferSheet } from '../components/terminal/FileTransferSheet';
import { RemoteScreenshotSheet } from '../components/terminal/RemoteScreenshotSheet';
import { TerminalHeader } from '../components/terminal/TerminalHeader';
import { TerminalSessionDrawer, type TerminalSessionDrawerItem } from '../components/terminal/TerminalSessionDrawer';
import { TabManagerSheet } from '../components/terminal/TabManagerSheet';
import { TerminalQuickBar } from '../components/terminal/TerminalQuickBar';
import {
  resolveTerminalCtrlChord,
  resolveTerminalKeyboardInput,
} from '@zterm/shared/terminal/renderer';
import { TerminalPageCopyMenu } from './TerminalPageCopyMenu';
import type { CopySelectionState } from './terminal-copy-selection';
import { useTerminalPageCopyRuntime } from './useTerminalPageCopyRuntime';
import { APP_VERSION, APP_VERSION_CODE } from '../lib/app-version';
import { getBrowserStorage } from '../lib/browser-storage';
import { mobileTheme } from '../lib/mobile-ui';
import { resolveSessionRemoteMissing } from '../lib/terminal-drawer-remote-missing';
import { ImeAnchor } from '../plugins/ImeAnchorPlugin';
import { registerClientDebugSnapshotSource } from '../lib/client-debug-snapshot';
import { runtimeDebug } from '../lib/runtime-debug';
import { DebugInput, isDebugInputSupported } from '../plugins/DebugInputPlugin';
import { useTerminalWorkspace } from '../hooks/useTerminalWorkspace';
import { normalizeTerminalCommittedText } from '../lib/terminal-input-normalization';
import {
  resolveTerminalLayoutProfile,
  resolveTerminalSessionGroupLayoutAxis,
  type TerminalSessionGroupLayoutMode,
} from '../lib/terminal-layout-profile';
import { resolveTerminalOrientation } from '../lib/terminal-viewport-metrics';
import { resolveTerminalViewportMetrics } from '../lib/terminal-viewport-metrics';
import {
  resolveTerminalSessionGroupSlotReplacement,
  resolveTerminalSessionGroupViewportProjection,
  type TerminalSessionGroupSlotIds,
  type TerminalSessionGroupSlotName,
} from '../lib/session-group-viewport';
import { TerminalStageShell } from './TerminalPageStageShell';
export {
  resolveTerminalSessionGroupSlotReplacement,
  resolveTerminalSessionGroupViewportSlots,
  resolveTerminalSessionGroupViewportProjection,
} from '../lib/session-group-viewport';
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
  type SessionGroupHistory,
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
const TERMINAL_QUICK_BAR_RENDER_LIFT_PX = 30;

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

  const resolvedLayoutViewportHeight = Math.max(
    0,
    Math.round(layoutViewportHeightOverride ?? resolveLayoutViewportHeight()),
  );
  // IME truth: some Android WebView cases keep innerHeight as full layout height
  // while visual viewport shrinks; others shrink both metrics.
  // Without explicit override, keep the larger one to avoid under-estimating
  // occluded bottom and over-lifting terminal chrome.
  const layoutViewportHeight = layoutViewportHeightOverride == null
    ? Math.max(resolvedLayoutViewportHeight, Math.max(0, Math.round(window.innerHeight || 0)))
    : resolvedLayoutViewportHeight;

  const layoutViewportWidth = Math.max(
    0,
    Math.round(
      Math.max(window.innerWidth || 0, window.document?.documentElement?.clientWidth || 0),
    ),
  );
  const keyboardLiftCapRatio = layoutViewportWidth > layoutViewportHeight ? 0.5 : 0.6;
  const keyboardLiftCapPx = Math.max(0, Math.round(layoutViewportHeight * keyboardLiftCapRatio));
  const safeCappedInset = keyboardLiftCapPx > 0
    ? Math.min(safeReportedInset, keyboardLiftCapPx)
    : safeReportedInset;

  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return safeCappedInset;
  }

  const visualViewportHeight = Math.max(0, Math.round(visualViewport.height || 0));
  const visualViewportOffsetTop = Math.max(0, Math.round(visualViewport.offsetTop || 0));
  const visualViewportBottom = Math.max(0, visualViewportHeight + visualViewportOffsetTop);
  const occludedBottom = Math.max(0, layoutViewportHeight - visualViewportBottom);

  if (occludedBottom <= 0) {
    return safeCappedInset;
  }

  return Math.min(safeCappedInset, occludedBottom);
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
  sessionGroups?: SessionGroupHistory[];
  activeSession: Session | null;
  getSessionDebugMetrics?: (sessionId: string) => SessionDebugOverlayMetrics | null;
  sessionBufferStore?: SessionRenderBufferStore | null;
  inputResetEpochBySession?: Record<string, number>;
  followResetEpoch?: number;
  onSwitchSession: (id: string) => void;
  onMoveSession: (id: string, toIndex: number) => void;
  onRenameSession: (id: string, name: string) => void;
  onCloseSession: (id: string, source?: string) => void;
  onForceRelaySession?: (id: string) => void;
  onUseAutoSession?: (id: string) => void;
  onOpenConnections: () => void;
  onOpenQuickTabPicker: (paneId?: string) => void;
  sessionPickerDebugMode?: string | null;
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
  getScheduleState?: (sessionId: string) => SessionScheduleState;
  onRequestScheduleList?: (sessionId: string) => void;
  onUpsertScheduleJob?: (sessionId: string, job: ScheduleJobDraft) => void;
  onDeleteScheduleJob?: (sessionId: string, jobId: string) => void;
  onToggleScheduleJob?: (sessionId: string, jobId: string, enabled: boolean) => void;
  onRunScheduleJobNow?: (sessionId: string, jobId: string) => void;
  terminalThemeId?: string;
  terminalWidthMode?: TerminalWidthMode;
  terminalSessionGroupLayoutMode?: TerminalSessionGroupLayoutMode;
  onTerminalWidthModeChange?: (sessionId: string, mode: TerminalWidthMode, cols?: number | null) => void;
  onSendMessage?: (sessionId: string, msg: any) => void;
  onFileTransferMessage?: (handler: (msg: any) => void) => () => void;
  shortcutSmartSort?: boolean;
  shortcutFrequencyMap?: Record<string, number>;
  onShortcutUse?: (shortcutId: string) => void;
}

interface ScheduleComposerTarget {
  sessionId: string;
  sessionName: string;
  nonce: number;
  seedText: string;
}

interface TerminalTabChromeItem {
  id: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  customName?: string;
  resolvedPath?: Session['resolvedPath'];
}

function normalizeDrawerStatus(state: Session['state'] | undefined): TerminalSessionDrawerItem['status'] {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'connecting':
    case 'reconnecting':
      return 'connecting';
    case 'disconnected':
      return 'disconnected';
    case 'closed':
      return 'closed';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
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

function resolveTerminalSessionGroupSlotIds(options: {
  slots: TerminalSessionGroupSlotIds;
  sessions: Session[];
  centerSessionId: string | null;
}): TerminalSessionGroupSlotIds {
  const sessionIds = new Set(options.sessions.map((session) => session.id));
  const center = (
    options.slots.center && sessionIds.has(options.slots.center)
      ? options.slots.center
      : options.centerSessionId && sessionIds.has(options.centerSessionId)
        ? options.centerSessionId
        : null
  );
  const top = (
    options.slots.top && sessionIds.has(options.slots.top) && options.slots.top !== center
      ? options.slots.top
      : null
  );
  const bottom = (
    options.slots.bottom &&
      sessionIds.has(options.slots.bottom) &&
      options.slots.bottom !== center &&
      options.slots.bottom !== top
      ? options.slots.bottom
      : null
  );

  return { top, center, bottom };
}

const TerminalDebugOverlay = ReactMemo(function TerminalDebugOverlay({
  visible,
  session,
  visiblePaneSessions,
  sessionViewportModeStore,
  getSessionDebugMetrics,
  debugOverlayPos,
  debugOverlayDragRef,
  onClose,
  onMove,
  keyboardInset,
  shellHeight,
  visualViewportHeight,
  terminalKeyboardRequested,
  containerHeightPx,
  viewportRows,
  copyModeActive,
  copyStartRowIndex,
  effectiveKeyboardLiftPx,
  quickBarHeight,
  terminalChromeBottomPx,
  copySelection,
  sessionDrawerDebug,
}: {
  visible: boolean;
  session: Session | null;
  visiblePaneSessions?: Session[];
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
  keyboardInset?: number;
  shellHeight?: number;
  visualViewportHeight?: number;
  terminalKeyboardRequested?: boolean;
  containerHeightPx?: number;
  viewportRows?: number;
  copyModeActive?: boolean;
  copyStartRowIndex?: number | null;
  effectiveKeyboardLiftPx?: number;
  quickBarHeight?: number;
  terminalChromeBottomPx?: number;
  copySelection?: CopySelectionState | undefined;
  sessionDrawerDebug?: {
    open: boolean;
    lastEvent: string;
    eventSeq: number;
    callbackSeq: number;
    pageCallbackSeq: number;
    pickerMode: string | null;
  };
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
  const paneSessions = (visiblePaneSessions && visiblePaneSessions.length > 0)
    ? visiblePaneSessions
    : [session];
  const paneMetrics = paneSessions.map((paneSession, index) => ({
    session: paneSession,
    index,
    metrics: getSessionDebugMetrics ? (getSessionDebugMetrics(paneSession.id) || undefined) : undefined,
  }));
  const overlayStyle: React.CSSProperties = {
    position: 'absolute',
    top: debugOverlayPos.y >= 0 ? `${debugOverlayPos.y}px` : '10px',
    left: debugOverlayPos.x >= 0 ? `${debugOverlayPos.x}px` : undefined,
    right: debugOverlayPos.x >= 0 ? undefined : '10px',
    zIndex: 12,
    minWidth: paneMetrics.length > 1 ? '156px' : '88px',
    maxWidth: paneMetrics.length > 1 ? '176px' : '96px',
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
      {paneMetrics.length > 1 ? (
        <div
          data-testid="terminal-debug-pane-metrics"
          style={{
            marginTop: '3px',
            paddingTop: '3px',
            borderTop: '1px solid rgba(255,255,255,0.10)',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          {paneMetrics.map(({ session: paneSession, index, metrics: paneMetric }) => (
            <div
              key={paneSession.id}
              data-testid={`terminal-debug-pane-metric-${paneSession.id}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '14px 1fr 1fr 1fr',
                columnGap: '3px',
                color: paneMetric?.transportBackpressured ? '#fca5a5' : 'rgba(231, 238, 252, 0.78)',
              }}
            >
              <span>{index + 1}</span>
              <span>{formatDebugHz(paneMetric?.renderHz || 0)}</span>
              <span>{formatDebugHz(paneMetric?.pullHz || 0)}</span>
              <span>{formatDebugRate(paneMetric?.downlinkBps || 0)}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>BUF</span>
        <span style={{ color: metrics?.transportBackpressured ? '#fca5a5' : '#93c5fd' }}>
          {formatDebugBytes(metrics?.transportBufferedBytes || 0)}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>LC</span>
        <span>{metrics?.lastRenderCommitAt ? Math.max(0, Math.round((Date.now() - metrics.lastRenderCommitAt) / 1000)) : '-'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', marginTop: '2px' }}>
        <span>KB</span>
        <span style={{ color: (keyboardInset ?? 0) > 0 ? '#86efac' : '#fca5a5' }}>{keyboardInset ?? 0}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>IM</span>
        <span style={{ color: terminalKeyboardRequested ? '#86efac' : '#fca5a5' }}>{terminalKeyboardRequested ? 'Y' : 'N'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>SH</span>
        <span>{shellHeight ?? '?'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>VV</span>
        <span>{visualViewportHeight ?? '?'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', marginTop: '2px' }}>
        <span>LIFT</span>
        <span style={{ color: (effectiveKeyboardLiftPx ?? 0) > 0 ? '#fbbf24' : '#93c5fd' }}>{effectiveKeyboardLiftPx ?? 0}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>QB</span>
        <span>{quickBarHeight ?? '?'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>TB</span>
        <span>{terminalChromeBottomPx ?? '?'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>CH</span>
        <span>{containerHeightPx ?? '?'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>VR</span>
        <span>{viewportRows ?? '?'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>CM</span>
        <span style={{ color: copyModeActive ? '#86efac' : '#fca5a5' }}>{copyModeActive ? 'ON' : 'OFF'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>CS</span>
        <span>{copyStartRowIndex ?? '-'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>CE</span>
        <span>{copySelection?.endRowIndex ?? '-'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
        <span>MU</span>
        <span style={{ color: copySelection?.menu ? '#86efac' : '#fca5a5' }}>
          {copySelection?.menu
            ? `x=${copySelection.menu.x} y=${copySelection.menu.y} r=${copySelection.menu.rowIndex}`
            : 'null'}
        </span>
      </div>
      {sessionDrawerDebug ? (
        <div
          data-testid="terminal-debug-session-drawer"
          style={{
            marginTop: '2px',
            paddingTop: '2px',
            borderTop: '1px solid rgba(255,255,255,0.10)',
            display: 'flex',
            flexDirection: 'column',
            gap: '1px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
            <span>DR</span>
            <span style={{ color: sessionDrawerDebug.open ? '#86efac' : '#fca5a5' }}>
              {sessionDrawerDebug.open ? 'OPEN' : 'CLOSED'}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
            <span>EV</span>
            <span>{sessionDrawerDebug.eventSeq}:{sessionDrawerDebug.lastEvent}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
            <span>CB</span>
            <span>{sessionDrawerDebug.callbackSeq}/{sessionDrawerDebug.pageCallbackSeq}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
            <span>PM</span>
            <span style={{ color: sessionDrawerDebug.pickerMode ? '#86efac' : '#fca5a5' }}>
              {sessionDrawerDebug.pickerMode || '-'}
            </span>
          </div>
        </div>
      ) : null}
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

function formatDebugBytes(bytes: number) {
  const safeValue = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (safeValue >= 1024 * 1024) {
    return `${(safeValue / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (safeValue >= 1024) {
    return `${(safeValue / 1024).toFixed(1)} KB`;
  }
  return `${Math.round(safeValue)} B`;
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
    case 'disconnected':
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
  sessionGroups = [],
  activeSession,
  getSessionDebugMetrics,
  sessionBufferStore = null,
  inputResetEpochBySession,
  followResetEpoch = 0,
  onSwitchSession,
  onMoveSession,
  onRenameSession,
  onCloseSession,
  onForceRelaySession,
  onUseAutoSession,
  onOpenConnections,
  onOpenQuickTabPicker,
  sessionPickerDebugMode = null,
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
  getScheduleState,
  onRequestScheduleList,
  onUpsertScheduleJob,
  onDeleteScheduleJob,
  onToggleScheduleJob,
  onRunScheduleJobNow,
  terminalThemeId,
  terminalWidthMode = 'mirror-fixed',
  terminalSessionGroupLayoutMode = 'auto',
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
  const [terminalKeyboardRequested, setTerminalKeyboardRequested] = useState(isAndroid);
  const [networkOnline, setNetworkOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [connectionIssueVisible, setConnectionIssueVisible] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [quickBarHeight, setQuickBarHeight] = useState(TERMINAL_QUICK_BAR_RENDER_LIFT_PX);
  const [quickBarCollapsed, setQuickBarCollapsed] = useState(false);
  const [quickBarEditorFocused, setQuickBarEditorFocused] = useState(false);
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);
  const [sessionDrawerDebug, setSessionDrawerDebug] = useState({
    lastEvent: '-',
    eventSeq: 0,
    callbackSeq: 0,
    pageCallbackSeq: 0,
  });
  const [tabManagerOpen, setTabManagerOpen] = useState(false);
  const [tabManagerScopePaneId, setTabManagerScopePaneId] = useState<string | null>(null);
  const [scheduleComposerTarget, setScheduleComposerTarget] = useState<ScheduleComposerTarget | null>(null);
  const [fileTransferOpen, setFileTransferOpen] = useState(false);
  const [remoteScreenshotPreview, setRemoteScreenshotPreview] = useState<RemoteScreenshotPreviewState | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => resolveWindowWidth());
  const [headerTopInsetPx, setHeaderTopInsetPx] = useState(() => resolveTerminalHeaderTopInsetPx(isAndroid));
  const viewportMetricsFrameRef = useRef<number | null>(null);
  const [savedTabLists, setSavedTabLists] = useState<SavedTabList[]>([]);
  const [debugOverlayVisible, setDebugOverlayVisible] = useState(false);
  const [absoluteLineNumbersVisible, setAbsoluteLineNumbersVisible] = useState(false);
  const [sessionGroupSlotIds, setSessionGroupSlotIds] = useState<TerminalSessionGroupSlotIds>(() => ({
    top: null,
    center: activeSession?.id || null,
    bottom: null,
  }));
  const [sessionGroupFocusSlot, setSessionGroupFocusSlot] = useState<TerminalSessionGroupSlotName>('center');
  const landscape = typeof window !== 'undefined' ? resolveTerminalOrientation() === 'landscape' : false;
  const portraitSessionDrawerEnabled = !landscape;
  const sessionViewportModeStoreRef = useRef(createSessionViewportModeStore());
  const [debugOverlayPos, setDebugOverlayPos] = useState({ x: -1, y: -1 }); // -1 means use defaults
  const debugOverlayDragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number; dragging: boolean }>({ startX: 0, startY: 0, startPosX: 0, startPosY: 0, dragging: false });
  const connectionIssueTimerRef = useRef<number | null>(null);
  const activeSessionIdRef = useRef<string | null>(activeSession?.id || null);
  const quickBarEditorFocusedRef = useRef(quickBarEditorFocused);
  const terminalInputHandlerRef = useRef<typeof onTerminalInput>(onTerminalInput);
  const appliedPaneAttachIntentNonceRef = useRef<number | null>(null);
  const pendingAndroidImeFocusTimerRef = useRef<number | null>(null);
  const androidImeFocusRouteKeyRef = useRef<string | null>(null);
  const terminalFocusRetryTimeoutsRef = useRef<number[]>([]);
  const remoteScreenshotPreviewRuntimeRef = useRef(createRemoteScreenshotPreviewRuntime());
  const stableLayoutViewportHeightRef = useRef(resolveLayoutViewportHeight());


  const captureStableLayoutViewportHeight = useCallback(() => {
    if (!isAndroid) {
      return;
    }
    const layoutHeight = resolveLayoutViewportHeight();
    if (layoutHeight > 0) {
      // Keyboard popup race on some devices can report a post-shrink layout
      // height at the time keyboardState(visible=true) arrives. Never let that
      // transient value pull the stable anchor downward during IME-active flow.
      stableLayoutViewportHeightRef.current = Math.max(
        stableLayoutViewportHeightRef.current,
        layoutHeight,
      );
    }
  }, [isAndroid]);

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
  const sessionGroupLayoutAxis = resolveTerminalSessionGroupLayoutAxis({
    viewportWidth,
    viewportHeight: shellHeight,
    landscape,
    mode: terminalSessionGroupLayoutMode,
  });

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
    switchTabInPane,
  } = useTerminalWorkspace({
    sessions,
    activeSessionId: activeSession?.id || null,
    viewportWidth,
    viewportHeight: shellHeight,
    maxSplitCount: 4,
  });
  const availableSplitCount = splitAvailable
    ? Math.max(1, Math.min(currentMaxSplitCount, sessions.length))
    : 1;
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

  const keepTerminalInputFocusedRef = useRef<() => void>(() => {});
  const copyRuntime = useTerminalPageCopyRuntime({
    uiSessionId: uiSession?.id || null,
    activeSessionId: activeSession?.id || null,
    splitVisible,
    findPaneForSession,
    onSwitchSession: (sessionId) => onSwitchSession?.(sessionId),
    setActivePane: (paneId) => setActivePane(paneId),
    keepTerminalInputFocused: keepTerminalInputFocusedRef.current,
    sessionBufferStore,
    sessions,
  });
  const {
    copySelection,
    handleLongPressCopyRow,
    handleCopySelectionStart,
    handleCopySelectionEnd,
    handleCopySelectedText,
    handleCloseCopyMenu,
    handleQuickBarToggleCopyMode,
  } = copyRuntime;
  const uiSessionId = uiSession?.id || null;
  const effectiveSessionGroupSlotIds = useMemo(() => resolveTerminalSessionGroupSlotIds({
    slots: sessionGroupSlotIds,
    sessions,
    centerSessionId: uiSessionId,
  }), [sessionGroupSlotIds, sessions, uiSessionId]);
  const sessionGroupViewportProjection = useMemo(() => resolveTerminalSessionGroupViewportProjection(
    effectiveSessionGroupSlotIds,
    sessionGroupFocusSlot,
  ), [effectiveSessionGroupSlotIds, sessionGroupFocusSlot]);
  const resolveSessionGroupSlot = useCallback((sessionId: string): TerminalSessionGroupSlotName | null => {
    if (effectiveSessionGroupSlotIds.top === sessionId) {
      return 'top';
    }
    if (effectiveSessionGroupSlotIds.center === sessionId) {
      return 'center';
    }
    if (effectiveSessionGroupSlotIds.bottom === sessionId) {
      return 'bottom';
    }
    return null;
  }, [effectiveSessionGroupSlotIds]);
  const sessionGroupViewportSlotSessions = useMemo(() => ({
    slots: {
      top: sessionGroupViewportProjection.slots.top
        ? sessions.find((session) => session.id === sessionGroupViewportProjection.slots.top) || null
        : null,
      center: sessionGroupViewportProjection.slots.center
        ? sessions.find((session) => session.id === sessionGroupViewportProjection.slots.center) || null
        : null,
      bottom: sessionGroupViewportProjection.slots.bottom
        ? sessions.find((session) => session.id === sessionGroupViewportProjection.slots.bottom) || null
        : null,
    },
    visible: sessionGroupViewportProjection.visible,
  }), [sessionGroupViewportProjection, sessions]);
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
  const drawerSessions = useMemo(() => {
    const activeSessionIds = new Set(renderedPaneSessions.map((session) => session.id));
    const hostLabelByKey = new Map<string, string>();
    for (const session of sessions) {
      const hostKey = `${session.bridgeHost}:${session.bridgePort}`;
      if (hostLabelByKey.has(hostKey)) continue;
      hostLabelByKey.set(hostKey, session.customName || hostKey);
    }

    // 已打开的 session（按 pane 顺序）
    const opened: TerminalSessionDrawerItem[] = workspacePanes.flatMap((pane, paneIndex) =>
      pane.tabs
        .map((tab) => sessions.find((candidate) => candidate.id === tab.sessionId) || null)
        .filter((session): session is Session => Boolean(session))
        .map((session) => ({
          id: session.id,
          title: session.customName || session.sessionName,
          subtitle: `${session.bridgeHost}:${session.bridgePort} · ${session.sessionName}`,
          status: normalizeDrawerStatus(session.state),
          remoteMissing: resolveSessionRemoteMissing(session, sessionGroups),
          paneLabel: `P${paneIndex + 1}`,
          sessionGroupSlot: resolveSessionGroupSlot(session.id),
          active: activeSessionIds.has(session.id),
          hostKey: `${session.bridgeHost}:${session.bridgePort}`,
          hostLabel: hostLabelByKey.get(`${session.bridgeHost}:${session.bridgePort}`) || `${session.bridgeHost}:${session.bridgePort}`,
        })),
    );

    // 未打开的 session（按名字排序），排除已打开的
    const openedIds = new Set(opened.map((s) => s.id));
    const unopened: TerminalSessionDrawerItem[] = sessions
      .filter((s) => !openedIds.has(s.id))
      .sort((a, b) => (a.customName || a.sessionName).localeCompare(b.customName || b.sessionName))
      .map((session) => {
        const hostKey = `${session.bridgeHost}:${session.bridgePort}`;
        return {
          id: session.id,
          title: session.customName || session.sessionName,
          subtitle: `${session.bridgeHost}:${session.bridgePort} · ${session.sessionName}`,
          status: normalizeDrawerStatus(session.state),
          remoteMissing: resolveSessionRemoteMissing(session, sessionGroups),
          paneLabel: undefined,
          sessionGroupSlot: resolveSessionGroupSlot(session.id),
          active: false,
          hostKey,
          hostLabel: hostLabelByKey.get(hostKey) || hostKey,
        };
      });

    return [...opened, ...unopened];
  }, [renderedPaneSessions, resolveSessionGroupSlot, sessionGroups, sessions, workspacePanes]);
  const activeDraft = sessionDraft;
  const activeScheduleState = scheduleState || null;
  const scheduleOpen = scheduleComposerTarget !== null;
  const frozenScheduleState = scheduleComposerTarget
    ? getScheduleState?.(scheduleComposerTarget.sessionId)
      || (activeScheduleState?.sessionName === scheduleComposerTarget.sessionName ? activeScheduleState : null)
    : null;
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
    activeSessionIdRef.current = interactiveSession?.id || null;
  }, [interactiveSession?.id]);

  useEffect(() => {
    if (!portraitSessionDrawerEnabled && sessionDrawerOpen) {
      setSessionDrawerOpen(false);
    }
  }, [portraitSessionDrawerEnabled, sessionDrawerOpen]);

  useEffect(() => {
    setSessionDrawerOpen(false);
  }, [interactiveSession?.id]);

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

  useLayoutEffect(() => {
    if (!splitVisible || !onTerminalViewportChange) {
      return;
    }
    renderedPaneSessions.forEach((session) => {
      if (session.id === interactiveSession?.id) {
        return;
      }
      onTerminalViewportChange(session.id, {
        mode: 'follow',
        viewportEndIndex: session.buffer?.endIndex ?? 0,
        viewportRows: session.buffer?.rows ?? 24,
      });
    });
  }, [interactiveSession?.id, livePaneSessionIdsKey, onTerminalViewportChange, renderedPaneSessions, splitVisible]);

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

  const requestAndroidImeFocus = useCallback((options?: { force?: boolean }) => {
    if (!isAndroid || quickBarEditorFocusedRef.current) {
      return;
    }
    captureStableLayoutViewportHeight();
    const routeKey = uiSessionId || '__no-session__';
    if (!options?.force && androidImeFocusRouteKeyRef.current === routeKey) {
      return;
    }
    androidImeFocusRouteKeyRef.current = routeKey;
    clearPendingAndroidImeFocus();
    pendingAndroidImeFocusTimerRef.current = window.setTimeout(() => {
      pendingAndroidImeFocusTimerRef.current = null;
      if (quickBarEditorFocusedRef.current) {
        return;
      }
      void ImeAnchor.show().catch((error) => {
        console.warn('[TerminalPage] ImeAnchor.show() failed:', error);
      });
    }, 0);
  }, [captureStableLayoutViewportHeight, clearPendingAndroidImeFocus, isAndroid, uiSessionId]);

  const restoreAndroidTerminalImeRoute = useCallback(() => {
    if (!isAndroid || quickBarEditorFocusedRef.current) {
      return;
    }
    if (!(terminalKeyboardRequested || keyboardInset > 0)) {
      return;
    }
    requestAndroidImeFocus({ force: true });
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

  useEffect(() => {
    keepTerminalInputFocusedRef.current = keepTerminalInputFocused;
  }, [keepTerminalInputFocused]);

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
    runtimeDebug('terminal.quickbar.measure', {
      measuredHeight: height,
      keyboardInset,
      timestamp: Date.now(),
    });
    setQuickBarHeight((current) => (height > 0 ? height : current));
  }, [keyboardInset]);

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
    const targetSession = sessions.find((session) => session.id === targetSessionId);
    if (!targetSession) {
      return;
    }
    onRequestScheduleList?.(targetSessionId);
    setScheduleComposerTarget({
      sessionId: targetSession.id,
      sessionName: targetSession.sessionName,
      nonce: Date.now(),
      seedText: text,
    });
  }, [onRequestScheduleList, sessions, uiSessionId]);

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
    if (portraitSessionDrawerEnabled && direction === 'previous') {
      setSessionDrawerDebug((current) => ({
        ...current,
        lastEvent: 'page:drawer-open',
        eventSeq: current.eventSeq + 1,
      }));
      setSessionDrawerOpen(true);
      return;
    }
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
    const targetPane = currentSplitVisible ? findPaneForSession(targetSession.id) : null;
    if (currentSplitVisible && targetPane) {
      switchTabInPane(targetPane.id, `tab-${targetSession.id}`);
    }
    onSwitchSession(targetSession.id);
  }, [findPaneForSession, getPaneSessionIds, onSwitchSession, portraitSessionDrawerEnabled, switchTabInPane]);

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
      quickBarEditorFocusedRef.current = false;
      setQuickBarEditorFocused(false);
      if (isAndroid) {
        setAndroidEditorActive(false);
      }
    }

    if (terminalKeyboardRequested || keyboardInset > 0) {
      updateTerminalKeyboardRequested(false);
      clearPendingAndroidImeFocus();
      clearTerminalFocusRetries();
      androidImeFocusRouteKeyRef.current = null;
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
      requestAndroidImeFocus({ force: true });
      return;
    }

    focusTerminalInput();
    try {
      void Keyboard.show();
    } catch (error) {
      console.warn('[TerminalPage] Keyboard.show() failed:', error);
    }

    scheduleTerminalFocusRetries({ delaysMs: [32, 120], includeKeyboardShow: true });
  }, [clearPendingAndroidImeFocus, clearTerminalFocusRetries, focusTerminalInput, isAndroid, keyboardInset, quickBarEditorFocused, requestAndroidImeFocus, scheduleTerminalFocusRetries, setAndroidEditorActive, terminalKeyboardRequested, uiSessionId]);

  const handleQuickBarEditorDomFocusChange = useCallback((active: boolean) => {
    quickBarEditorFocusedRef.current = active;
    setQuickBarEditorFocused(active);
    setAndroidEditorActive(active);

    if (active) {
      clearTerminalFocusRetries();
      androidImeFocusRouteKeyRef.current = null;
    }
    if (active || !isAndroid) {
      return;
    }
    if (terminalKeyboardRequested || keyboardInset > 0) {
      requestAndroidImeFocus({ force: true });
    }
  }, [clearTerminalFocusRetries, isAndroid, keyboardInset, requestAndroidImeFocus, terminalKeyboardRequested]);

  useEffect(() => {
    if (!isAndroid || quickBarEditorFocused || !uiSessionId) {
      return;
    }
    if (!(terminalKeyboardRequested || keyboardInset > 0)) {
      return;
    }
    requestAndroidImeFocus({ force: true });
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
    updateTerminalKeyboardRequested(isAndroid);
    setQuickBarEditorFocused(false);
    if (isAndroid) {
      return;
    }
    clearPendingAndroidImeFocus();
    clearTerminalFocusRetries();

    const input = querySessionInput(uiSessionId);
    input?.blur();
  }, [clearPendingAndroidImeFocus, clearTerminalFocusRetries, isAndroid, uiSessionId, updateTerminalKeyboardRequested]);

  useEffect(() => {
    if (!isAndroid) {
      return;
    }

    let disposed = false;
    let inputListener: { remove: () => Promise<void> } | null = null;
    let backspaceListener: { remove: () => Promise<void> } | null = null;
    let keyListener: { remove: () => Promise<void> } | null = null;
    let keyboardStateListener: { remove: () => Promise<void> } | null = null;
    let debugInputListener: { remove: () => Promise<void> } | null = null;

    const emitToActiveSession = (data: string, source: 'ime-input' | 'ime-backspace' | 'ime-key' | 'debug-input') => {
      const sessionId = activeSessionIdRef.current;
      const quickBarEditorFocused = quickBarEditorFocusedRef.current;
      runtimeDebug(`terminal.${source}.received`, {
        sessionId,
        size: data.length,
        splitVisible: splitVisibleRef.current,
        activePaneId: activePaneIdRef.current,
        quickBarEditorFocused,
      });
      if (!sessionId) {
        runtimeDebug(`terminal.${source}.drop`, {
          why: 'missing-active-session',
          size: data.length,
          splitVisible: splitVisibleRef.current,
          activePaneId: activePaneIdRef.current,
        });
        return;
      }
      if (!data) {
        runtimeDebug(`terminal.${source}.drop`, {
          why: 'empty-input',
          sessionId,
          splitVisible: splitVisibleRef.current,
          activePaneId: activePaneIdRef.current,
        });
        return;
      }
      if (quickBarEditorFocused) {
        runtimeDebug(`terminal.${source}.drop`, {
          why: 'quick-editor-focused',
          sessionId,
          size: data.length,
          splitVisible: splitVisibleRef.current,
          activePaneId: activePaneIdRef.current,
        });
        return;
      }
      runtimeDebug(`terminal.${source}.emit`, {
        sessionId,
        size: data.length,
        splitVisible: splitVisibleRef.current,
        activePaneId: activePaneIdRef.current,
      });
      terminalInputHandlerRef.current?.(sessionId, data);
    };

    const attachListeners = async () => {
      try {
        inputListener = await ImeAnchor.addListener('input', (event) => {
          emitToActiveSession(
            normalizeTerminalCommittedText(event.text || '').replace(/\n/g, '\r'),
            'ime-input',
          );
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
          emitToActiveSession('\x7f'.repeat(count), 'ime-backspace');
        });
        if (disposed) {
          void backspaceListener.remove().catch((error) => {
            logAsyncCleanupFailure('ImeAnchor backspace listener remove after dispose', error);
          });
          backspaceListener = null;
          return;
        }
        keyListener = await ImeAnchor.addListener('key', (event) => {
          if (disposed) return;
          const sessionId = activeSessionIdRef.current;
          if (!sessionId || quickBarEditorFocusedRef.current) {
            return;
          }
          const keyboardEvent = new KeyboardEvent('keydown', {
            key: event.key || '',
            code: event.code || '',
            ctrlKey: Boolean(event.ctrlKey),
            altKey: Boolean(event.altKey),
            metaKey: Boolean(event.metaKey),
            shiftKey: Boolean(event.shiftKey),
            bubbles: true,
            cancelable: true,
          });
          if (keyboardEvent.metaKey) {
            return;
          }
          const ctrlChord = resolveTerminalCtrlChord(keyboardEvent);
          if (ctrlChord) {
            emitToActiveSession(ctrlChord, 'ime-key');
            return;
          }
          const cursorKeysApp = Boolean(
            sessionBufferStore?.getSnapshot(sessionId).buffer.cursorKeysApp,
          );
          const keyboardInput = resolveTerminalKeyboardInput(
            keyboardEvent,
            cursorKeysApp,
          );
          if (keyboardInput) {
            emitToActiveSession(keyboardInput, 'ime-key');
          }
        });
        if (disposed) {
          void keyListener.remove().catch((error) => {
            logAsyncCleanupFailure('ImeAnchor key listener remove after dispose', error);
          });
          keyListener = null;
          return;
        }
        keyboardStateListener = await ImeAnchor.addListener('keyboardState', (event) => {
          const visible = Boolean(event.visible);
          const height = Math.max(0, Math.round(event.height || 0));
          // Keep stable layout height anchored before IME show, and refresh once
          // after hide so future popup anchor remains accurate per-device.
          if (visible && isAndroid) {
            captureStableLayoutViewportHeight();
          }
          updateKeyboardInset(height);
          if (!quickBarEditorFocusedRef.current) {
            updateTerminalKeyboardRequested(visible);
          }
          if (!visible && isAndroid) {
            window.setTimeout(() => {
              captureStableLayoutViewportHeight();
            }, 0);
          }
        });
        if (disposed) {
          void keyboardStateListener.remove().catch((error) => {
            logAsyncCleanupFailure('ImeAnchor keyboardState listener remove after dispose', error);
          });
          keyboardStateListener = null;
          return;
        }
        if (isDebugInputSupported()) {
          debugInputListener = await DebugInput.addListener('debug-input', (event) => {
            const payload = `${event.text || ''}${event.newline || ''}`;
            emitToActiveSession(payload, 'debug-input');
          });
          if (disposed) {
            void debugInputListener.remove().catch((error) => {
              logAsyncCleanupFailure('DebugInput listener remove after dispose', error);
            });
            debugInputListener = null;
          }
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
      if (keyListener) {
        void keyListener.remove().catch((error) => {
          logAsyncCleanupFailure('ImeAnchor key listener remove', error);
        });
      }
      if (keyboardStateListener) {
        void keyboardStateListener.remove().catch((error) => {
          logAsyncCleanupFailure('ImeAnchor keyboardState listener remove', error);
        });
      }
      if (debugInputListener) {
        void debugInputListener.remove().catch((error) => {
          logAsyncCleanupFailure('DebugInput listener remove', error);
        });
      }
    };
  }, [captureStableLayoutViewportHeight, isAndroid]);

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
    let hideTimer: number | null = null;

    const cancelPendingHide = () => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    const showListenerPromise = Keyboard.addListener('keyboardDidShow', (info) => {
      if (!disposed) {
        cancelPendingHide();
        updateKeyboardInset(info.keyboardHeight || 0);
        if (isAndroid && !quickBarEditorFocusedRef.current) {
          updateTerminalKeyboardRequested(true);
        }
      }
    });
    const hideListenerPromise = Keyboard.addListener('keyboardDidHide', () => {
      if (!disposed) {
        if (isAndroid) {
          // Debounce hide on Android to survive fold/unfold display-change
          // transitions that fire keyboardDidHide then keyboardDidShow in rapid succession.
          cancelPendingHide();
          hideTimer = window.setTimeout(() => {
            hideTimer = null;
            if (!disposed) {
              updateTerminalKeyboardRequested(false);
              updateKeyboardInset(0);
            }
          }, 400);
        } else {
          updateTerminalKeyboardRequested(false);
          updateKeyboardInset(0);
        }
      }
    });

    return () => {
      disposed = true;
      cancelPendingHide();
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

  useEffect(() => {
    if (!landscape && quickBarCollapsed) {
      setQuickBarCollapsed(false);
    }
  }, [landscape, quickBarCollapsed]);
  const layoutProfile = useMemo(() => resolveTerminalLayoutProfile({
    splitVisible,
    topInsetPx: headerTopInsetPx,
    landscape,
  }), [headerTopInsetPx, landscape, splitVisible]);
  const terminalChromeBottomPx = Math.max(0, quickBarHeight + layoutProfile.quickBar.touchSafeOffsetPx);
  const effectiveKeyboardLiftPx = resolveKeyboardLiftPx(keyboardInset, shellHeight);
  const terminalImeActive = terminalKeyboardRequested && !quickBarEditorFocused;
  const terminalImeLiftPx = keyboardInset > 0 ? effectiveKeyboardLiftPx : 0;
  const quickBarShellKeyboardLiftPx = keyboardInset > 0 ? effectiveKeyboardLiftPx : 0;
  // Use a ref to hold the live snapshot lambda so the registration useEffect
  // never needs to re-run. The producer reads ref.current, which is kept fresh
  // every render. This decouples the snapshot source from all reactive deps,
  // stopping the 27-item useEffect dep chain that fires on every keyboard/tick change.
  const terminalPageSnapshotProducerRef = useRef<() => Record<string, unknown>>(() => ({}));
  terminalPageSnapshotProducerRef.current = () => ({
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
  });
  useEffect(() => registerClientDebugSnapshotSource(
    'terminal-page',
    () => terminalPageSnapshotProducerRef.current(),
  ), []);
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
    runtimeDebug('terminal.tab.restore', {
      listId,
      tabCount: target.tabs.length,
      activeSessionId: target.activeSessionId,
    });
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
    switchTabInPane(passivePane.id, nextTab.id);
  }, [splitVisible, switchTabInPane, workspace.activePaneId, workspace.panes]);

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
    runtimeDebug('terminal.pane.activate', {
      paneId: normalizedPaneId,
      sessionId: targetSessionId,
      workspacePaneIds: workspace.panes.map((pane) => pane.id),
    });
    if (targetSessionId && targetSessionId !== activeSessionRef.current?.id) {
      onSwitchSession(targetSessionId);
    }
  }, [onSwitchSession, setActivePane, workspace.panes]);

  const handleSwitchSessionFromChrome = useCallback((sessionId: string) => {
    if (splitVisibleRef.current) {
      const targetPane = findPaneForSession(sessionId);
      if (!targetPane) {
        console.error('[TerminalPage] Refused to switch split tab without a pane owner.', {
          sessionId,
          workspacePaneIds: workspace.panes.map((pane) => pane.id),
        });
        return;
      }
      switchTabInPane(targetPane.id, `tab-${sessionId}`);
    }
    onSwitchSession(sessionId);
  }, [findPaneForSession, onSwitchSession, switchTabInPane, workspace.panes]);

  const handleSelectSessionFromDrawer = useCallback((sessionId: string) => {
    handleSwitchSessionFromChrome(sessionId);
    setSessionGroupSlotIds((current) => resolveTerminalSessionGroupSlotReplacement(
      current,
      sessionId,
      sessionGroupFocusSlot,
    ));
    setSessionDrawerOpen(false);
  }, [handleSwitchSessionFromChrome, sessionGroupFocusSlot]);

  const handleAssignSessionGroupSlot = useCallback((sessionId: string, slot: TerminalSessionGroupSlotName) => {
    setSessionGroupSlotIds((current) => {
      const next: TerminalSessionGroupSlotIds = {
        top: current.top === sessionId ? null : current.top,
        center: current.center === sessionId ? null : current.center,
        bottom: current.bottom === sessionId ? null : current.bottom,
      };
      next[slot] = sessionId;
      return next;
    });
    if (slot === 'center') {
      setSessionGroupFocusSlot('center');
      handleSwitchSessionFromChrome(sessionId);
    }
  }, [handleSwitchSessionFromChrome]);

  const handleActivateSessionGroupSlot = useCallback((sessionId: string, sourceSlot?: TerminalSessionGroupSlotName) => {
    void sourceSlot;
    const fixedSlot = resolveSessionGroupSlot(sessionId);
    if (fixedSlot) {
      setSessionGroupFocusSlot(fixedSlot);
    }
    handleSwitchSessionFromChrome(sessionId);
  }, [handleSwitchSessionFromChrome, resolveSessionGroupSlot]);

  const handleCloseSessionFromDrawer = useCallback((sessionId: string) => {
    onCloseSession(sessionId, 'session-drawer-close-button');
  }, [onCloseSession]);

  const handleOpenQuickTabPickerForPane = useCallback((paneId?: string) => {
    if (paneId) {
      activatePaneAndSession(paneId);
    }
    setSessionDrawerDebug((current) => ({
      ...current,
      lastEvent: 'page:open-picker',
      eventSeq: current.eventSeq + 1,
      pageCallbackSeq: current.pageCallbackSeq + 1,
    }));
    onOpenQuickTabPicker(paneId);
  }, [activatePaneAndSession, onOpenQuickTabPicker]);

  const handleOpenQuickTabPickerFromDrawer = useCallback(() => {
    setSessionDrawerDebug((current) => ({
      ...current,
      lastEvent: 'page:drawer-callback',
      eventSeq: current.eventSeq + 1,
      callbackSeq: current.callbackSeq + 1,
    }));
    setSessionDrawerOpen(false);
    handleOpenQuickTabPickerForPane(splitVisible ? workspace.activePaneId : undefined);
  }, [handleOpenQuickTabPickerForPane, splitVisible, workspace.activePaneId]);

  const handleSessionDrawerDebugAddEvent = useCallback((eventName: string) => {
    setSessionDrawerDebug((current) => ({
      ...current,
      lastEvent: eventName,
      eventSeq: current.eventSeq + 1,
    }));
  }, []);

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
      collapseAvailable={landscape}
      collapsed={quickBarCollapsed}
      onCollapsedChange={setQuickBarCollapsed}
      currentSplitCount={workspacePanes.length}
      splitCountOptions={
        splitAvailable
          ? Array.from({ length: availableSplitCount }, (_, index) => index + 1)
          : []
      }
      onSetSplitCount={handleSetSplitCount}
      onToggleSplitLayout={toggleSplitLayout}
      onCycleSplitPane={cycleSecondaryPane}
      onEditorDomFocusChange={handleQuickBarEditorDomFocusChange}
      onOpenFileTransfer={handleQuickBarOpenFileTransfer}
      onToggleDebugOverlay={handleQuickBarToggleDebugOverlay}
      copyModeActive={copySelection.active}
      onToggleCopyMode={handleQuickBarToggleCopyMode}
      copyDebugLabel={`COPY:SYSTEM KB:${keyboardInset} IME:${terminalKeyboardRequested ? 'Y' : 'N'}`}
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
    landscape,
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
    quickBarCollapsed,
    currentMaxSplitCount,
    cycleSecondaryPane,
    terminalImeActive,
    keyboardInset,
    terminalKeyboardRequested,
    toggleSplitLayout,
    workspacePanes.length,
    layoutProfile.stage.containerRadius,
    layoutProfile.stage.outerMargin,
    layoutProfile.stage.paneGap,
    layoutProfile.stage.paneRadius,
    layoutProfile.stage.rowBottomPadding,
    copySelection.active,
    handleQuickBarToggleCopyMode,
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
      {!portraitSessionDrawerEnabled ? (
        <div>
          <TerminalHeader
            sessions={chromeSessions}
            activeSession={activeChromeSession}
            topInsetPx={headerTopInsetPx}
            showBackButton
            onBack={onOpenConnections}
            onOpenQuickTabPicker={handleOpenQuickTabPickerForPane}
            onOpenTabManager={handleOpenTabManager}
            onSwitchSession={handleSwitchSessionFromChrome}
            onRenameSession={onRenameSession}
            onCloseSession={onCloseSession}
            onForceRelaySession={onForceRelaySession}
            onUseAutoSession={onUseAutoSession}
            splitVisible={splitVisible}
            paneGroups={paneGroups}
            onAssignSessionToPane={assignSessionToPane}
            onMoveSessionToOtherPane={moveSessionToOtherPane}
            onActivatePane={activatePaneAndSession}
          />
        </div>
      ) : null}
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
        {portraitSessionDrawerEnabled ? (
          <>
            <button
              type="button"
              aria-label="返回连接列表"
              data-testid="terminal-portrait-back-button"
              onClick={onOpenConnections}
              style={{
                position: 'absolute',
                top: `${Math.max(8, headerTopInsetPx + 8)}px`,
                left: '10px',
                zIndex: 15,
                width: '34px',
                height: '34px',
                borderRadius: '12px',
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(10, 16, 26, 0.64)',
                color: '#dce8ff',
                fontSize: '18px',
                lineHeight: 1,
                boxShadow: '0 8px 18px rgba(0,0,0,0.18)',
                backdropFilter: 'blur(8px)',
              }}
            >
              ←
            </button>
            <TerminalSessionDrawer
              open={sessionDrawerOpen}
              topInsetPx={headerTopInsetPx}
              bottomInsetPx={keyboardInset}
              sessions={drawerSessions}
              onClose={() => setSessionDrawerOpen(false)}
              onSelectSession={handleSelectSessionFromDrawer}
              onCloseSession={handleCloseSessionFromDrawer}
              onAssignSessionGroupSlot={handleAssignSessionGroupSlot}
              onOpenQuickTabPicker={handleOpenQuickTabPickerFromDrawer}
              onDebugAddEvent={handleSessionDrawerDebugAddEvent}
            />
          </>
        ) : null}
    <TerminalStageShell
      interactiveSession={interactiveSession}
      sessionBufferStore={sessionBufferStore}
      renderedPaneSessions={renderedPaneSessions}
      sessionGroupViewport={sessionGroupViewportSlotSessions}
      sessionGroupLayoutAxis={sessionGroupLayoutAxis}
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
          onActivateSession={handleActivateSessionGroupSlot}
          focusNonce={focusNonce}
          terminalFontSize={terminalFontSize}
          terminalThemeId={terminalThemeId}
          terminalWidthMode={terminalWidthMode}
          allowSessionDrawerSwipe={portraitSessionDrawerEnabled}
          absoluteLineNumbersVisible={absoluteLineNumbersVisible}
          copySelection={copySelection}
          onLongPressRow={handleLongPressCopyRow}
        />
        {copySelection.menu ? (
          <TerminalPageCopyMenu
            menu={copySelection.menu}
            viewportWidth={viewportWidth}
            headerTopInsetPx={headerTopInsetPx}
            startRowIndex={copySelection.startRowIndex}
            onSetStart={handleCopySelectionStart}
            onSetEnd={handleCopySelectionEnd}
            onCopy={handleCopySelectedText}
            onClose={handleCloseCopyMenu}
          />
        ) : null}
    <TerminalDebugOverlay
      visible={debugOverlayVisible}
      session={interactiveSession}
      visiblePaneSessions={renderedPaneSessions}
      sessionViewportModeStore={sessionViewportModeStoreRef.current}
      copySelection={copySelection}
      getSessionDebugMetrics={getSessionDebugMetrics}
      debugOverlayPos={debugOverlayPos}
      debugOverlayDragRef={debugOverlayDragRef}
          onClose={() => setDebugOverlayVisible(false)}
          onMove={setDebugOverlayPos}
          keyboardInset={keyboardInset}
          shellHeight={shellHeight}
          visualViewportHeight={typeof window !== 'undefined' ? Math.round(window.visualViewport?.height || 0) : 0}
          terminalKeyboardRequested={terminalKeyboardRequested}
          containerHeightPx={undefined}
          viewportRows={undefined}
          effectiveKeyboardLiftPx={effectiveKeyboardLiftPx}
          quickBarHeight={quickBarHeight}
          terminalChromeBottomPx={terminalChromeBottomPx}
          sessionDrawerDebug={{
            open: sessionDrawerOpen,
            lastEvent: sessionDrawerDebug.lastEvent,
            eventSeq: sessionDrawerDebug.eventSeq,
            callbackSeq: sessionDrawerDebug.callbackSeq,
            pageCallbackSeq: sessionDrawerDebug.pageCallbackSeq,
            pickerMode: sessionPickerDebugMode,
          }}
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
        onSwitchSession={handleSwitchSessionFromChrome}
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
      {scheduleComposerTarget ? (
        <SessionScheduleSheet
          open={scheduleOpen}
          sessionName={scheduleComposerTarget.sessionName}
          scheduleState={frozenScheduleState || { sessionName: scheduleComposerTarget.sessionName, jobs: [], loading: false }}
          composerSeedText={scheduleComposerTarget.seedText}
          composerSeedNonce={scheduleComposerTarget.nonce}
          keyboardInset={keyboardInset}
          onClose={() => {
            setScheduleComposerTarget(null);
          }}
          onRefresh={() => onRequestScheduleList?.(scheduleComposerTarget.sessionId)}
          onSave={(job) => onUpsertScheduleJob?.(scheduleComposerTarget.sessionId, job)}
          onDelete={(jobId) => onDeleteScheduleJob?.(scheduleComposerTarget.sessionId, jobId)}
          onToggle={(jobId, enabled) => onToggleScheduleJob?.(scheduleComposerTarget.sessionId, jobId, enabled)}
          onRunNow={(jobId) => onRunScheduleJobNow?.(scheduleComposerTarget.sessionId, jobId)}
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
    && prev.getScheduleState === next.getScheduleState
    && prev.onRequestScheduleList === next.onRequestScheduleList
    && prev.onUpsertScheduleJob === next.onUpsertScheduleJob
    && prev.onDeleteScheduleJob === next.onDeleteScheduleJob
    && prev.onToggleScheduleJob === next.onToggleScheduleJob
    && prev.onRunScheduleJobNow === next.onRunScheduleJobNow
    && prev.terminalThemeId === next.terminalThemeId
    && prev.terminalWidthMode === next.terminalWidthMode
    && prev.terminalSessionGroupLayoutMode === next.terminalSessionGroupLayoutMode
    && prev.onTerminalWidthModeChange === next.onTerminalWidthModeChange
    && prev.onSendMessage === next.onSendMessage
    && prev.onFileTransferMessage === next.onFileTransferMessage
    && prev.shortcutSmartSort === next.shortcutSmartSort
    && prev.shortcutFrequencyMap === next.shortcutFrequencyMap
    && prev.onShortcutUse === next.onShortcutUse
  );
}

export const TerminalPage = ReactMemo(TerminalPageComponent, terminalPagePropsEqual);
