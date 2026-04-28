import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Keyboard } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { TerminalView } from '../components/TerminalView';
import { SessionScheduleSheet } from '../components/terminal/SessionScheduleSheet';
import { FileTransferSheet } from '../components/terminal/FileTransferSheet';
import { RemoteScreenshotSheet, type RemoteScreenshotPreviewState } from '../components/terminal/RemoteScreenshotSheet';
import { TerminalHeader } from '../components/terminal/TerminalHeader';
import { TabManagerSheet } from '../components/terminal/TabManagerSheet';
import { TerminalQuickBar } from '../components/terminal/TerminalQuickBar';
import { APP_VERSION, APP_VERSION_CODE } from '../lib/app-version';
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
  type SessionDraftMap,
  type SessionScheduleState,
  type ScheduleJobDraft,
  type TerminalLayoutState,
  type TerminalResizeHandler,
  type TerminalSplitPaneId,
  type TerminalShortcutAction,
  type TerminalViewportMode,
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
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEYS.TERMINAL_LAYOUT);
    return normalizeTerminalLayoutState(raw ? JSON.parse(raw) : null);
  } catch (error) {
    console.error('[TerminalPage] Failed to load terminal layout:', error);
    return null;
  }
}

function persistTerminalLayoutState(layout: TerminalLayoutState) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify(layout));
  } catch (error) {
    console.error('[TerminalPage] Failed to persist terminal layout:', error);
  }
}

interface TerminalPageProps {
  sessions: Session[];
  activeSession: Session | null;
  sessionDebugMetrics?: Record<string, SessionDebugOverlayMetrics | undefined>;
  inputResetEpochBySession?: Record<string, number>;
  onSwitchSession: (id: string) => void;
  onMoveSession: (id: string, toIndex: number) => void;
  onRenameSession: (id: string, name: string) => void;
  onCloseSession: (id: string) => void;
  onOpenConnections: () => void;
  onOpenQuickTabPicker: () => void;
  onResize?: TerminalResizeHandler;
  onTerminalInput?: (sessionId: string, data: string) => void;
  onTerminalViewportChange?: TerminalViewportChangeHandler;
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
  sessionDrafts?: SessionDraftMap;
  onSessionDraftChange?: (value: string, sessionId?: string) => void;
  onSessionDraftSend?: (value: string, sessionId?: string) => void;
  onLoadSavedTabList: (tabs: PersistedOpenTab[], activeSessionId?: string) => void;
  scheduleState?: SessionScheduleState | null;
  scheduleStateBySessionId?: Record<string, SessionScheduleState | null | undefined>;
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
  } catch {
    // directory may already exist
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

export function TerminalPage({
  sessions,
  activeSession,
  sessionDebugMetrics,
  inputResetEpochBySession,
  onSwitchSession,
  onMoveSession,
  onRenameSession,
  onCloseSession,
  onOpenConnections,
  onOpenQuickTabPicker,
  onResize,
  onTerminalInput,
  onTerminalViewportChange,
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
  sessionDrafts,
  onSessionDraftChange,
  onSessionDraftSend,
  onLoadSavedTabList,
  scheduleState,
  scheduleStateBySessionId,
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
  const [savedTabLists, setSavedTabLists] = useState<SavedTabList[]>([]);
  const [debugOverlayVisible, setDebugOverlayVisible] = useState(true);
  const [absoluteLineNumbersVisible, setAbsoluteLineNumbersVisible] = useState(true);
  const [debugOverlayPos, setDebugOverlayPos] = useState({ x: -1, y: -1 }); // -1 means use defaults
  const [sessionViewportModes, setSessionViewportModes] = useState<Record<string, TerminalViewportMode>>({});
  const debugOverlayDragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number; dragging: boolean }>({ startX: 0, startY: 0, startPosX: 0, startPosY: 0, dragging: false });
  const connectionIssueTimerRef = useRef<number | null>(null);
  const activeSessionIdRef = useRef<string | null>(activeSession?.id || null);
  const quickBarEditorFocusedRef = useRef(quickBarEditorFocused);
  const terminalInputHandlerRef = useRef<typeof onTerminalInput>(onTerminalInput);
  const splitOpenWidthRef = useRef(0);
  const splitOpenProfileRef = useRef<LayoutProfile>('phone-single');
  const pendingAndroidImeFocusTimerRef = useRef<number | null>(null);
  const remoteScreenshotPreviewUrlRef = useRef<string | null>(null);

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

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SAVED_TAB_LISTS);
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
    if (typeof window === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEYS.SAVED_TAB_LISTS, JSON.stringify(nextLists));
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
  const renderedPaneSessions = visiblePaneSessionIds
    .map((sessionId) => sessions.find((session) => session.id === sessionId) || null)
    .filter((session): session is Session => Boolean(session));
  const activeDraft = activeSession?.id && sessionDrafts ? sessionDrafts[activeSession.id] || '' : sessionDraft;
  const activeScheduleState = activeSession?.id && scheduleStateBySessionId
    ? scheduleStateBySessionId[activeSession.id] || null
    : scheduleState || null;

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

    const syncViewportMetrics = () => {
      setViewportWidth(resolveWindowWidth());
      setHeaderTopInsetPx(resolveTerminalHeaderTopInsetPx(isAndroid));
    };

    syncViewportMetrics();
    window.addEventListener('resize', syncViewportMetrics);
    window.visualViewport?.addEventListener('resize', syncViewportMetrics);
    window.visualViewport?.addEventListener('scroll', syncViewportMetrics);
    return () => {
      window.removeEventListener('resize', syncViewportMetrics);
      window.visualViewport?.removeEventListener('resize', syncViewportMetrics);
      window.visualViewport?.removeEventListener('scroll', syncViewportMetrics);
    };
  }, [isAndroid]);

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

  const focusTerminalInput = () => {
    setFocusNonce((value) => value + 1);

    const input = querySessionInput(activeSession?.id || null);
    if (!input) {
      return;
    }

    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  };

  const clearPendingAndroidImeFocus = useCallback(() => {
    if (pendingAndroidImeFocusTimerRef.current === null) {
      return;
    }
    window.clearTimeout(pendingAndroidImeFocusTimerRef.current);
    pendingAndroidImeFocusTimerRef.current = null;
  }, []);

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

  const keepTerminalInputFocused = () => {
    if (quickBarEditorFocused) {
      return;
    }

    if (isAndroid) {
      restoreAndroidTerminalImeRoute();
      return;
    }

    window.setTimeout(focusTerminalInput, 0);
    window.setTimeout(focusTerminalInput, 32);
    window.setTimeout(focusTerminalInput, 120);
  };

  const revokeRemoteScreenshotPreviewUrl = useCallback(() => {
    if (!remoteScreenshotPreviewUrlRef.current) {
      return;
    }
    URL.revokeObjectURL(remoteScreenshotPreviewUrlRef.current);
    remoteScreenshotPreviewUrlRef.current = null;
  }, []);

  const closeRemoteScreenshotPreview = useCallback(() => {
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

    revokeRemoteScreenshotPreviewUrl();
    setRemoteScreenshotPreview({
      phase: 'request-sent',
      fileName: `remote-screenshot-${Date.now()}.png`,
      previewDataUrl: null,
      rawDataBase64: null,
    });

    try {
      const capture = await onRequestRemoteScreenshot(targetSessionId, (progress) => {
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
      setTerminalKeyboardRequested(false);
      clearPendingAndroidImeFocus();
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

    setTerminalKeyboardRequested(true);
    if (isAndroid) {
      return;
    }

    focusTerminalInput();
    try {
      void Keyboard.show();
    } catch (error) {
      console.warn('[TerminalPage] Keyboard.show() failed:', error);
    }

    window.setTimeout(() => {
      focusTerminalInput();
      void Keyboard.show().catch((error) => {
        logAsyncCleanupFailure('Keyboard.show retry(32ms)', error);
      });
    }, 32);

    window.setTimeout(() => {
      focusTerminalInput();
      void Keyboard.show().catch((error) => {
        logAsyncCleanupFailure('Keyboard.show retry(120ms)', error);
      });
    }, 120);
  }, [activeSession?.id, clearPendingAndroidImeFocus, focusTerminalInput, isAndroid, keyboardInset, quickBarEditorFocused, terminalKeyboardRequested]);

  const handleQuickBarEditorDomFocusChange = useCallback((active: boolean) => {
    quickBarEditorFocusedRef.current = active;
    setQuickBarEditorFocused(active);
    setAndroidEditorActive(active);
    if (active || !isAndroid) {
      return;
    }
    if (terminalKeyboardRequested || keyboardInset > 0) {
      requestAndroidImeFocus();
    }
  }, [isAndroid, keyboardInset, requestAndroidImeFocus, setAndroidEditorActive, terminalKeyboardRequested]);

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
    setTerminalKeyboardRequested(false);
    setQuickBarEditorFocused(false);
    clearPendingAndroidImeFocus();
    if (isAndroid) {
      void ImeAnchor.blur().catch((error) => {
        console.warn('[TerminalPage] ImeAnchor.blur() failed:', error);
      });
      return;
    }

    const input = querySessionInput(activeSession?.id || null);
    input?.blur();
  }, [activeSession?.id, clearPendingAndroidImeFocus, isAndroid]);

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
          setKeyboardInset(height);
          if (!quickBarEditorFocusedRef.current) {
            setTerminalKeyboardRequested(visible);
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

    setTerminalKeyboardRequested(false);
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
  }, [clearPendingAndroidImeFocus]);

  useEffect(() => {
    let disposed = false;

    const showListenerPromise = Keyboard.addListener('keyboardDidShow', (info) => {
      if (!disposed) {
        setKeyboardInset(Math.max(0, Math.round(info.keyboardHeight || 0)));
        if (isAndroid && !quickBarEditorFocusedRef.current) {
          setTerminalKeyboardRequested(true);
        }
      }
    });
    const hideListenerPromise = Keyboard.addListener('keyboardDidHide', () => {
      if (!disposed) {
        setTerminalKeyboardRequested(false);
        setKeyboardInset(0);
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
      setKeyboardInset(nextInset);
    };

    syncKeyboardInset();
    virtualKeyboard.addEventListener('geometrychange', syncKeyboardInset);
    return () => {
      virtualKeyboard.removeEventListener('geometrychange', syncKeyboardInset);
    };
  }, []);

  const terminalChromeBottomPx = Math.max(0, quickBarHeight + TERMINAL_QUICK_BAR_TOUCH_SAFE_OFFSET_PX);
  const effectiveKeyboardLiftPx = resolveKeyboardLiftPx(keyboardInset);
  const terminalImeActive = terminalKeyboardRequested && !quickBarEditorFocused;
  const terminalImeLiftPx = terminalImeActive ? effectiveKeyboardLiftPx : 0;
  const quickBarShellKeyboardLiftPx = keyboardInset > 0 ? effectiveKeyboardLiftPx : 0;
  const activeSessionMetrics = activeSession ? sessionDebugMetrics?.[activeSession.id] : undefined;
  const activeSessionDebugStatus = resolveDebugStatus(activeSession, activeSessionMetrics);
  const activeSessionViewportMode = activeSession ? (sessionViewportModes[activeSession.id] || 'follow') : 'follow';
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
    : activeSession?.state === 'reconnecting'
      ? {
          tone: '#ffb020',
          background: 'rgba(97, 63, 13, 0.92)',
          border: 'rgba(255, 176, 32, 0.42)',
          title: '连接已断开，正在重连',
          detail: activeSession.lastError || '网络或 daemon 连接已中断，正在指数退避重试。',
        }
      : activeSession?.state === 'error'
        ? {
            tone: '#ff6b6b',
            background: 'rgba(109, 24, 33, 0.92)',
            border: 'rgba(255, 107, 107, 0.42)',
            title: '连接失败',
            detail: activeSession.lastError || '当前 tab 已断开，请检查网络或服务器状态。',
          }
        : null;
  const shellHeight = Math.max(0, typeof window !== 'undefined' ? window.innerHeight : 0);
  const currentPersistedTabs = sessions.map(toPersistedOpenTab);

  const handleSwipeTab = (sessionId: string, direction: 'previous' | 'next') => {
    const paneScopedSessions = splitVisible
      ? sessions.filter((session) => resolvePaneId(splitPaneAssignments, session.id) === activePaneId)
      : sessions;
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
  };

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

  const cycleSecondaryPane = () => {
    if (!activeSession) {
      return;
    }
    const candidates = sessions.filter((session) => (
      session.id !== activeSession.id
      && resolvePaneId(splitPaneAssignments, session.id) === passivePaneId
    ));
    if (candidates.length === 0) {
      return;
    }
    const currentIndex = candidates.findIndex((session) => session.id === secondarySession?.id);
    const nextSession = candidates[(currentIndex + 1) % candidates.length] || candidates[0];
    setSplitSecondarySessionId(nextSession.id);
  };

  const assignSessionToPane = (sessionId: string, paneId: TerminalSplitPaneId) => {
    setSplitPaneAssignments((current) => {
      if (current[sessionId] === paneId) {
        return current;
      }
      const next = {
        ...current,
        [sessionId]: paneId,
      };
      if (splitEnabled && activeSession?.id === sessionId) {
        const oppositePane: TerminalSplitPaneId = paneId === 'primary' ? 'secondary' : 'primary';
        const hasOpposite = sessions.some((session) => (
          session.id !== sessionId
          && resolvePaneId(next, session.id) === oppositePane
        ));
        if (!hasOpposite) {
          const candidate = sessions.find((session) => session.id !== sessionId);
          if (candidate) {
            next[candidate.id] = oppositePane;
          }
        }
      }
      return next;
    });
  };

  const moveSessionToOtherPane = (sessionId: string) => {
    const currentPane = resolvePaneId(splitPaneAssignments, sessionId);
    assignSessionToPane(sessionId, currentPane === 'primary' ? 'secondary' : 'primary');
  };

  const toggleSplitLayout = () => {
    if (!splitVisible) {
      const currentWidth = resolveWindowWidth();
      splitOpenWidthRef.current = currentWidth;
      splitOpenProfileRef.current = resolveLayoutProfile({ width: currentWidth }).profile;
      if (activeSession) {
        const activePane = resolvePaneId(splitPaneAssignments, activeSession.id);
        const oppositePane: TerminalSplitPaneId = activePane === 'primary' ? 'secondary' : 'primary';
        const hasOpposite = sessions.some((session) => (
          session.id !== activeSession.id
          && resolvePaneId(splitPaneAssignments, session.id) === oppositePane
        ));
        if (!hasOpposite) {
          const candidate = sessions.find((session) => session.id !== activeSession.id);
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
  };

  const terminalPaneStyle = (paneSessionId: string): CSSProperties => {
    if (!splitVisible) {
      return {
        position: 'absolute',
        inset: 0,
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
  };

  const handleTerminalViewportChange = useCallback<TerminalViewportChangeHandler>((sessionId, viewState) => {
    setSessionViewportModes((current) => (
      current[sessionId] === viewState.mode
        ? current
        : {
            ...current,
            [sessionId]: viewState.mode,
          }
    ));
    onTerminalViewportChange?.(sessionId, viewState);
  }, [onTerminalViewportChange]);

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
          sessions={sessions}
          activeSession={activeSession}
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
      {networkBanner && (
        <div
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
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          data-testid="terminal-stage"
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
                      initialBufferLines={session.buffer.lines}
                      bufferStartIndex={session.buffer.startIndex}
                      bufferEndIndex={session.buffer.endIndex}
                      bufferHeadStartIndex={session.buffer.bufferHeadStartIndex}
                      bufferTailEndIndex={session.buffer.bufferTailEndIndex}
                      daemonHeadRevision={session.daemonHeadRevision || 0}
                      daemonHeadEndIndex={session.daemonHeadEndIndex || session.buffer.bufferTailEndIndex}
                      bufferGapRanges={session.buffer.gapRanges}
                      cursorKeysApp={session.buffer.cursorKeysApp}
                      cursor={session.buffer.cursor}
                      active={sessionIsActive}
                      bufferPullActive={Boolean(sessionDebugMetrics?.[session.id]?.bufferPullActive)}
                      inputResetEpoch={inputResetEpochBySession?.[session.id] || 0}
                      allowDomFocus={isAndroid ? false : sessionIsActive && terminalKeyboardRequested}
                      domInputOffscreen={isAndroid}
                      onActivateInput={isAndroid && sessionIsActive ? () => restoreAndroidTerminalImeRoute() : undefined}
                      onResize={sessionIsActive && (terminalWidthMode === 'adaptive-phone' || !isAndroid) ? onResize : undefined}
                      onWidthModeChange={sessionIsActive ? onTerminalWidthModeChange : undefined}
                      onInput={sessionIsActive ? onTerminalInput : undefined}
                      onViewportChange={sessionIsActive ? handleTerminalViewportChange : undefined}
                      onSwipeTab={sessionIsActive ? handleSwipeTab : undefined}
                      focusNonce={isAndroid ? 0 : sessionIsActive ? focusNonce : 0}
                      fontSize={terminalFontSize}
                      rowHeight={`${Math.max(terminalFontSize + 4, Math.ceil(terminalFontSize * 1.5))}px`}
                      themeId={terminalThemeId}
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
        {activeSession && debugOverlayVisible ? (() => {
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
            border: `1.5px solid ${activeSessionMetrics?.bufferPullActive ? 'rgba(34, 197, 94, 0.6)' : 'rgba(83, 139, 255, 0.6)'}`,
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
                setDebugOverlayPos({ x: clampedX, y: clampedY });
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
                  onClick={() => setDebugOverlayVisible(false)}
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
                <span style={{ color: activeSessionViewportMode === 'reading' ? '#fbbf24' : '#93c5fd' }}>{activeSessionViewportMode}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', fontWeight: 700 }}>
                <span>状态</span>
                <span style={{ color: activeSessionMetrics?.bufferPullActive ? '#86efac' : '#93c5fd' }}>{activeSessionDebugStatus}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
                <span>↑</span>
                <span>{formatDebugRate(activeSessionMetrics?.uplinkBps || 0)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
                <span>↓</span>
                <span>{formatDebugRate(activeSessionMetrics?.downlinkBps || 0)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
                <span>R</span>
                <span>{formatDebugHz(activeSessionMetrics?.renderHz || 0)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
                <span>P</span>
                <span>{formatDebugHz(activeSessionMetrics?.pullHz || 0)}</span>
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
        })() : null}
        <div
          data-testid="terminal-quickbar-shell"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: `${terminalImeLiftPx + TERMINAL_QUICK_BAR_TOUCH_SAFE_OFFSET_PX}px`,
            zIndex: 10,
          }}
        >
          <TerminalQuickBar
            activeSessionId={activeSession?.id}
            quickActions={quickActions}
            shortcutActions={shortcutActions}
            onMeasuredHeightChange={setQuickBarHeight}
            onSendSequence={(sequence) => {
              onQuickActionInput?.(sequence, activeSession?.id);
              if (terminalKeyboardRequested || keyboardInset > 0) {
                keepTerminalInputFocused();
              }
            }}
            onImagePaste={onImagePaste}
            onFileAttach={onFileAttach}
            keyboardVisible={terminalImeActive && effectiveKeyboardLiftPx > 0}
            keyboardInsetPx={quickBarShellKeyboardLiftPx}
            onToggleKeyboard={handleToggleKeyboard}
            onQuickActionsChange={onQuickActionsChange}
            onShortcutActionsChange={onShortcutActionsChange}
            sessionDraft={activeDraft}
            onSessionDraftChange={(value) => onSessionDraftChange?.(value, activeSession?.id)}
            onSessionDraftSend={(value) => {
              onSessionDraftSend?.(value, activeSession?.id);
              if (terminalKeyboardRequested || keyboardInset > 0) {
                keepTerminalInputFocused();
              }
            }}
            onOpenScheduleComposer={(text) => {
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
            }}
            splitAvailable={splitAvailable}
            splitVisible={splitVisible}
            onToggleSplitLayout={toggleSplitLayout}
            onCycleSplitPane={cycleSecondaryPane}
            onEditorDomFocusChange={handleQuickBarEditorDomFocusChange}
            onOpenFileTransfer={() => setFileTransferOpen(true)}
            onToggleDebugOverlay={() => setDebugOverlayVisible((v) => !v)}
            onToggleAbsoluteLineNumbers={() => setAbsoluteLineNumbersVisible((v) => !v)}
            onRequestRemoteScreenshot={() => void handleRequestRemoteScreenshot()}
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
        </div>
      </div>
      <TabManagerSheet
        open={tabManagerOpen}
        sessions={sessions}
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
