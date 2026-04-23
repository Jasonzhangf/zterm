import { useEffect, useRef, useState } from 'react';
import { Keyboard } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';
import { TerminalView } from '../components/TerminalView';
import { SessionScheduleSheet } from '../components/terminal/SessionScheduleSheet';
import { TerminalHeader } from '../components/terminal/TerminalHeader';
import { TabManagerSheet } from '../components/terminal/TabManagerSheet';
import { TerminalQuickBar } from '../components/terminal/TerminalQuickBar';
import { mobileTheme } from '../lib/mobile-ui';
import { ImeAnchor } from '../plugins/ImeAnchorPlugin';
import {
  STORAGE_KEYS,
  type PersistedOpenTab,
  type QuickAction,
  type SavedTabList,
  type Session,
  type SessionScheduleState,
  type ScheduleJobDraft,
  type TerminalResizeHandler,
  type TerminalShortcutAction,
  type TerminalViewportChangeHandler,
} from '../lib/types';

type VirtualKeyboardApi = {
  overlaysContent: boolean;
  boundingRect: DOMRectReadOnly;
  addEventListener: (type: 'geometrychange', listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: 'geometrychange', listener: EventListenerOrEventListenerObject) => void;
};

const NETWORK_BANNER_GRACE_MS = 3000;
const TERMINAL_QUICK_BAR_RENDER_LIFT_PX = 64;

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
    return 0;
  }

  return Math.min(safeReportedInset, occludedBottom);
}

interface TerminalPageProps {
  sessions: Session[];
  activeSession: Session | null;
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
  quickActions: QuickAction[];
  shortcutActions: TerminalShortcutAction[];
  onQuickActionInput?: (sequence: string) => void;
  onQuickActionsChange?: (actions: QuickAction[]) => void;
  onShortcutActionsChange?: (actions: TerminalShortcutAction[]) => void;
  sessionDraft: string;
  onSessionDraftChange?: (value: string) => void;
  onSessionDraftSend?: (value: string) => void;
  onLoadSavedTabList: (tabs: PersistedOpenTab[], activeSessionId?: string) => void;
  scheduleState?: SessionScheduleState | null;
  onRequestScheduleList?: (sessionId: string) => void;
  onUpsertScheduleJob?: (sessionId: string, job: ScheduleJobDraft) => void;
  onDeleteScheduleJob?: (sessionId: string, jobId: string) => void;
  onToggleScheduleJob?: (sessionId: string, jobId: string, enabled: boolean) => void;
  onRunScheduleJobNow?: (sessionId: string, jobId: string) => void;
  terminalThemeId?: string;
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
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleComposerSeed, setScheduleComposerSeed] = useState<ScheduleComposerSeed>({ nonce: 0, text: '' });
  const [savedTabLists, setSavedTabLists] = useState<SavedTabList[]>([]);
  const connectionIssueTimerRef = useRef<number | null>(null);
  const activeSessionIdRef = useRef<string | null>(activeSession?.id || null);
  const terminalInputHandlerRef = useRef<typeof onTerminalInput>(onTerminalInput);

  useEffect(() => {
    activeSessionIdRef.current = activeSession?.id || null;
  }, [activeSession?.id]);

  useEffect(() => {
    terminalInputHandlerRef.current = onTerminalInput;
  }, [onTerminalInput]);

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

  const focusTerminalInput = () => {
    setFocusNonce((value) => value + 1);

    const input = querySessionInput(activeSession?.id);
    if (!input) {
      return;
    }

    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  };

  const keepTerminalInputFocused = () => {
    if (quickBarEditorFocused) {
      return;
    }

    if (isAndroid) {
      window.setTimeout(() => {
        void ImeAnchor.show().catch((error) => {
          console.warn('[TerminalPage] ImeAnchor.show() failed:', error);
        });
      }, 0);
      window.setTimeout(() => {
        void ImeAnchor.show().catch(() => undefined);
      }, 32);
      window.setTimeout(() => {
        void ImeAnchor.show().catch(() => undefined);
      }, 120);
      return;
    }

    window.setTimeout(focusTerminalInput, 0);
    window.setTimeout(focusTerminalInput, 32);
    window.setTimeout(focusTerminalInput, 120);
  };

  const handleToggleKeyboard = async () => {
    if (quickBarEditorFocused && typeof document !== 'undefined') {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      setQuickBarEditorFocused(false);
    }

    if (terminalKeyboardRequested || keyboardInset > 0) {
      setTerminalKeyboardRequested(false);
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
      const input = querySessionInput(activeSession?.id);
      input?.blur();
      return;
    }

    setTerminalKeyboardRequested(true);
    if (isAndroid) {
      void ImeAnchor.show().catch((error) => {
        console.warn('[TerminalPage] ImeAnchor.show() failed:', error);
      });
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
      void Keyboard.show().catch(() => undefined);
    }, 32);

    window.setTimeout(() => {
      focusTerminalInput();
      void Keyboard.show().catch(() => undefined);
    }, 120);
  };

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
    if (isAndroid) {
      void ImeAnchor.blur().catch((error) => {
        console.warn('[TerminalPage] ImeAnchor.blur() failed:', error);
      });
      return;
    }

    const input = querySessionInput(activeSession?.id);
    input?.blur();
  }, [activeSession?.id, isAndroid]);

  useEffect(() => {
    if (!isAndroid) {
      return;
    }

    let disposed = false;
    let inputListener: { remove: () => Promise<void> } | null = null;
    let backspaceListener: { remove: () => Promise<void> } | null = null;

    const emitToActiveSession = (data: string) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId || !data || quickBarEditorFocused) {
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
          void inputListener.remove().catch(() => undefined);
          inputListener = null;
          return;
        }
        backspaceListener = await ImeAnchor.addListener('backspace', (event) => {
          const count = Math.max(1, Math.round(event.count || 1));
          emitToActiveSession('\x7f'.repeat(count));
        });
        if (disposed) {
          void backspaceListener.remove().catch(() => undefined);
          backspaceListener = null;
        }
      } catch (error) {
        console.warn('[TerminalPage] Failed to attach ImeAnchor listeners:', error);
      }
    };

    void attachListeners();

    return () => {
      disposed = true;
      if (inputListener) {
        void inputListener.remove().catch(() => undefined);
      }
      if (backspaceListener) {
        void backspaceListener.remove().catch(() => undefined);
      }
    };
  }, [isAndroid, quickBarEditorFocused]);

  useEffect(() => {
    if (!isAndroid || !quickBarEditorFocused) {
      return;
    }

    setTerminalKeyboardRequested(false);
    void ImeAnchor.blur().catch((error) => {
      console.warn('[TerminalPage] ImeAnchor.blur() failed:', error);
    });
  }, [isAndroid, quickBarEditorFocused]);

  useEffect(() => {
    let disposed = false;

    const showListenerPromise = Keyboard.addListener('keyboardDidShow', (info) => {
      if (!disposed) {
        setKeyboardInset(Math.max(0, Math.round(info.keyboardHeight || 0)));
        if (isAndroid && !quickBarEditorFocused) {
          setTerminalKeyboardRequested(true);
          keepTerminalInputFocused();
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
      void showListenerPromise.then((listener) => listener.remove());
      void hideListenerPromise.then((listener) => listener.remove());
    };
  }, [isAndroid, quickBarEditorFocused]);

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

  const terminalChromeBottomPx = Math.max(0, quickBarHeight);
  const effectiveKeyboardLiftPx = resolveKeyboardLiftPx(keyboardInset);
  const terminalImeActive = terminalKeyboardRequested && !quickBarEditorFocused;
  const terminalImeLiftPx = terminalImeActive ? effectiveKeyboardLiftPx : 0;
  const terminalViewportLayoutNonce = [
    activeSession?.id || 'none',
    Math.round(terminalChromeBottomPx),
    Math.round(terminalImeLiftPx),
    terminalKeyboardRequested ? 1 : 0,
  ].join(':');
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
    const currentIndex = sessions.findIndex((session) => session.id === sessionId);
    if (currentIndex < 0) {
      return;
    }
    const targetIndex = direction === 'previous' ? currentIndex - 1 : currentIndex + 1;
    const targetSession = sessions[targetIndex] || null;
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
          onBack={onOpenConnections}
          onOpenQuickTabPicker={onOpenQuickTabPicker}
          onOpenTabManager={() => setTabManagerOpen(true)}
          onSwitchSession={onSwitchSession}
          onRenameSession={onRenameSession}
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
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: `${terminalChromeBottomPx}px`,
            display: 'flex',
            transform: terminalImeLiftPx > 0 ? `translateY(-${terminalImeLiftPx}px)` : undefined,
            transition: 'transform 180ms ease',
            willChange: terminalImeLiftPx > 0 ? 'transform' : undefined,
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
              sessions.map((session) => {
                const sessionActive = session.id === activeSession.id;
                return (
                  <div
                    key={session.id}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      opacity: sessionActive ? 1 : 0,
                      pointerEvents: sessionActive ? 'auto' : 'none',
                      visibility: sessionActive ? 'visible' : 'hidden',
                    }}
                  >
                    <TerminalView
                      sessionId={session.id}
                      initialBufferLines={session.buffer.lines}
                      bufferStartIndex={session.buffer.startIndex}
                      bufferEndIndex={session.buffer.endIndex}
                      bufferViewportEndIndex={session.buffer.viewportEndIndex}
                      bufferGapRanges={session.buffer.gapRanges}
                      cursorKeysApp={session.buffer.cursorKeysApp}
                      active={sessionActive}
                      allowDomFocus={isAndroid ? false : sessionActive && terminalKeyboardRequested}
                      domInputOffscreen={isAndroid}
                      onResize={onResize}
                      onInput={onTerminalInput}
                      onViewportChange={onTerminalViewportChange}
                      onSwipeTab={handleSwipeTab}
                      focusNonce={isAndroid ? 0 : sessionActive ? focusNonce : 0}
                      followResetToken={session.followResetToken || 0}
                      viewportLayoutNonce={sessionActive ? terminalViewportLayoutNonce : 0}
                      fontSize={terminalFontSize}
                      rowHeight={`${Math.max(terminalFontSize + 4, Math.ceil(terminalFontSize * 1.5))}px`}
                      themeId={terminalThemeId}
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
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 10,
          }}
        >
          <TerminalQuickBar
            activeSessionId={activeSession?.id}
            quickActions={quickActions}
            shortcutActions={shortcutActions}
            onMeasuredHeightChange={setQuickBarHeight}
            onSendSequence={(sequence) => {
              onQuickActionInput?.(sequence);
              if (terminalKeyboardRequested || keyboardInset > 0) {
                keepTerminalInputFocused();
              }
            }}
            onImagePaste={onImagePaste}
            keyboardVisible={terminalImeActive && effectiveKeyboardLiftPx > 0}
            keyboardInsetPx={terminalImeActive ? effectiveKeyboardLiftPx : 0}
            onToggleKeyboard={handleToggleKeyboard}
            onQuickActionsChange={onQuickActionsChange}
            onShortcutActionsChange={onShortcutActionsChange}
            sessionDraft={sessionDraft}
            onSessionDraftChange={onSessionDraftChange}
            onSessionDraftSend={(value) => {
              onSessionDraftSend?.(value);
              if (terminalKeyboardRequested || keyboardInset > 0) {
                keepTerminalInputFocused();
              }
            }}
            onOpenScheduleComposer={(text) => {
              if (!activeSession?.id) {
                return;
              }
              onRequestScheduleList?.(activeSession.id);
              setScheduleComposerSeed({
                nonce: Date.now(),
                text,
              });
              setScheduleOpen(true);
            }}
            onEditorDomFocusChange={setQuickBarEditorFocused}
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
          scheduleState={scheduleState || { sessionName: activeSession.sessionName, jobs: [], loading: false }}
          composerSeedText={scheduleComposerSeed.text}
          composerSeedNonce={scheduleComposerSeed.nonce}
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
    </div>
  );
}
