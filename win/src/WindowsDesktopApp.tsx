import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  MacTerminalView,
  PaneStage,
  PaneTabs,
  resolveActiveTab,
  resolvePaneProfile,
  type PaneSlotDefinition,
  type PaneTabDescriptor,
  type WorkspacePane,
} from '@zterm/shared';
import {
  createWindowsSessionControl,
  normalizeWindowsNewSessionName,
  projectWindowsTerminalBuffer,
  type WindowsTerminalSession,
  type WindowsTerminalTarget,
} from './windows-terminal-session';
import { createWindowsTerminalRegistry } from './windows-terminal-registry';
import { WindowsFileBrowserPanel } from './WindowsFileBrowserPanel';
import {
  activateWindowsWorkspacePane,
  activateWindowsWorkspaceTab,
  changeWindowsWorkspaceTabSession,
  closeWindowsWorkspaceTarget,
  closeWindowsWorkspaceTab,
  createWindowsWorkspaceState,
  listWindowsWorkspaceRuntimeTabs,
  moveWindowsWorkspaceTab,
  openWindowsWorkspaceTab,
  openWindowsWorkspaceTabInPane,
  resizeWindowsWorkspacePanes,
  splitWindowsWorkspace,
  splitWindowsWorkspaceEmpty,
  type WindowsWorkspaceState,
  type WindowsWorkspaceTab,
} from './windows-workspace';

const STORAGE_KEY = 'zterm:windows:target.v1';
const DEFAULT_TARGET: WindowsTerminalTarget = { bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 'zterm' };

interface WindowsPaneContextMenuState {
  paneId: string;
  tabId: string;
  left: number;
  top: number;
}

function hasWindowsWorkspaceTab(
  workspace: WindowsWorkspaceState,
  replacement: { paneId: string; tabId: string } | null,
) {
  return Boolean(replacement && workspace.panes.some((pane) => (
    pane.id === replacement.paneId && pane.tabs.some((tab) => tab.id === replacement.tabId)
  )));
}

function readTarget() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '') as Partial<WindowsTerminalTarget>;
    if (!parsed.bridgeHost || !parsed.sessionName || !Number.isFinite(parsed.bridgePort)) return DEFAULT_TARGET;
    return { ...DEFAULT_TARGET, ...parsed };
  } catch {
    return DEFAULT_TARGET;
  }
}

function WindowsTerminalPane({
  pane,
  paneIndex,
  active,
  splitVisible,
  session,
  onSelectTab,
  onCloseTab,
  onActivatePane,
  onEmptyPaneClick,
  onContextMenuTab,
}: {
  pane: WorkspacePane<WindowsWorkspaceTab>;
  paneIndex: number;
  active: boolean;
  splitVisible: boolean;
  session: WindowsTerminalSession | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onActivatePane: () => void;
  onEmptyPaneClick: () => void;
  onContextMenuTab: (tabId: string, anchor: { left: number; top: number }) => void;
}) {
  const profile = resolvePaneProfile({ platform: 'desktop', splitVisible });
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? (() => () => undefined),
    session?.getSnapshot ?? (() => null),
    session?.getSnapshot ?? (() => null),
  );
  const tabs: PaneTabDescriptor[] = pane.tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    badge: tab.target ? 'ws' : undefined,
    isActive: tab.id === pane.activeTabId,
  }));

  return (
    <div className="windows-pane" data-pane-id={pane.id}>
      <PaneTabs
        platform="desktop"
        profile={profile}
        paneId={pane.id}
        paneIndex={paneIndex}
        isActivePane={active}
        tabs={tabs}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onActivatePane={onActivatePane}
        onContextMenuTab={onContextMenuTab}
      />
      <div className="terminal-stage">
        {snapshot?.error ? <div className="error-banner">{snapshot.error}</div> : null}
        {snapshot && session ? (
          <MacTerminalView
            sessionId={snapshot.sessionId}
            projection={projectWindowsTerminalBuffer(snapshot.buffer)}
            active={active && snapshot.status === 'connected'}
            allowDomFocus
            onInput={session.sendInput}
            onViewportChange={(value) => session.requestVisibleRange(value as { startIndex?: number; endIndex?: number })}
          />
        ) : (
          <button className="terminal-empty" type="button" data-testid={`windows-empty-pane-select-${pane.id}`} onClick={onEmptyPaneClick}>
            Choose a session
          </button>
        )}
      </div>
    </div>
  );
}

export function WindowsWorkspaceStage({
  workspace,
  registry,
  onChange,
  onEmptyPaneSelect,
  onTabContextMenu,
}: {
  workspace: WindowsWorkspaceState;
  registry: ReturnType<typeof createWindowsTerminalRegistry>;
  onChange: (next: WindowsWorkspaceState) => void;
  onEmptyPaneSelect: (paneId: string) => void;
  onTabContextMenu: (paneId: string, tabId: string, anchor: { left: number; top: number }) => void;
}) {
  const slots: PaneSlotDefinition[] = workspace.panes.map((pane, paneIndex) => {
    const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0]!;
    return {
      id: pane.id,
      title: `Pane ${paneIndex + 1}`,
      size: pane.size,
      isActive: pane.id === workspace.activePaneId,
      tabIds: pane.tabs.map((tab) => tab.id),
      activeTabId: pane.activeTabId,
      render: () => (
        <WindowsTerminalPane
          pane={pane}
          paneIndex={paneIndex}
          active={pane.id === workspace.activePaneId}
          splitVisible={workspace.panes.length > 1}
          session={registry.get(activeTab.id)}
          onSelectTab={(tabId) => onChange(activateWindowsWorkspaceTab(workspace, pane.id, tabId))}
          onCloseTab={(tabId) => onChange(closeWindowsWorkspaceTab(workspace, pane.id, tabId))}
          onActivatePane={() => onChange(activateWindowsWorkspacePane(workspace, pane.id))}
          onEmptyPaneClick={() => onEmptyPaneSelect(pane.id)}
          onContextMenuTab={(tabId, anchor) => onTabContextMenu(pane.id, tabId, anchor)}
        />
      ),
    };
  });
  return (
    <PaneStage
      platform="desktop"
      splitVisible={workspace.panes.length > 1}
      slots={slots}
      onActivatePane={(paneId) => onChange(activateWindowsWorkspacePane(workspace, paneId))}
      onPaneRatioChange={({ sourcePaneId, targetPaneId, ratio }) =>
        onChange(resizeWindowsWorkspacePanes(workspace, sourcePaneId, targetPaneId, ratio))}
    />
  );
}

export function WindowsDesktopApp() {
  const registry = useMemo(() => createWindowsTerminalRegistry(), []);
  const sessionControl = useMemo(() => createWindowsSessionControl(), []);
  const controlSnapshot = useSyncExternalStore(sessionControl.subscribe, sessionControl.getSnapshot, sessionControl.getSnapshot);
  const [workspace, setWorkspace] = useState(createWindowsWorkspaceState);
  const [registryRevision, setRegistryRevision] = useState(0);
  const [target, setTarget] = useState<WindowsTerminalTarget>(readTarget);
  const [newSessionName, setNewSessionName] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<WindowsPaneContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [pendingSessionReplacement, setPendingSessionReplacement] = useState<{ paneId: string; tabId: string } | null>(null);
  const closeSettingsPanel = () => {
    setPendingSessionReplacement(null);
    setSettingsOpen(false);
  };
  const toggleSettingsPanel = () => {
    setSettingsOpen((open) => {
      if (open) {
        setPendingSessionReplacement(null);
      }
      return !open;
    });
  };

  useEffect(() => {
    const tabs = listWindowsWorkspaceRuntimeTabs(workspace);
    tabs.forEach((tab) => registry.ensure(tab));
    registry.retain(new Set(tabs.map((tab) => tab.id)));
    setRegistryRevision((revision) => revision + 1);
  }, [registry, workspace]);
  useEffect(() => () => registry.dispose(), [registry]);
  void registryRevision;

  useEffect(() => {
    if (!contextMenu) return;
    const dismissOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && contextMenuRef.current?.contains(target)) {
        return;
      }
      setContextMenu(null);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };
    window.addEventListener('pointerdown', dismissOnPointerDown, true);
    window.addEventListener('keydown', dismissOnEscape);
    return () => {
      window.removeEventListener('pointerdown', dismissOnPointerDown, true);
      window.removeEventListener('keydown', dismissOnEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const stillExists = workspace.panes.some((pane) => (
      pane.id === contextMenu.paneId && pane.tabs.some((tab) => tab.id === contextMenu.tabId)
    ));
    if (!stillExists) {
      setContextMenu(null);
    }
  }, [contextMenu, workspace.panes]);

  useEffect(() => {
    if (!pendingSessionReplacement) return;
    if (!hasWindowsWorkspaceTab(workspace, pendingSessionReplacement)) {
      setPendingSessionReplacement(null);
    }
  }, [pendingSessionReplacement, workspace]);

  const activeTab = resolveActiveTab(workspace);
  const controlTarget = { bridgeHost: target.bridgeHost, bridgePort: target.bridgePort, authToken: target.authToken };
  const validTarget = Boolean(target.bridgeHost.trim() && target.sessionName.trim() && target.bridgePort > 0);
  const targetForSession = (sessionName: string): WindowsTerminalTarget => ({ ...target, sessionName });
  const openTarget = (split: boolean) => {
    if (!validTarget) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(target));
    setWorkspace((current) => {
      if (!split && hasWindowsWorkspaceTab(current, pendingSessionReplacement)) {
        return changeWindowsWorkspaceTabSession(
          current,
          pendingSessionReplacement!.paneId,
          pendingSessionReplacement!.tabId,
          target,
        );
      }
      return split ? splitWindowsWorkspace(current, target) : openWindowsWorkspaceTab(current, target);
    });
    setPendingSessionReplacement(null);
    setSettingsOpen(false);
  };
  const openSessionInActivePane = (sessionName: string) => {
    const nextTarget = targetForSession(sessionName);
    setTarget(nextTarget);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextTarget));
    setWorkspace((current) => {
      if (hasWindowsWorkspaceTab(current, pendingSessionReplacement)) {
        return changeWindowsWorkspaceTabSession(
          current,
          pendingSessionReplacement!.paneId,
          pendingSessionReplacement!.tabId,
          nextTarget,
        );
      }
      return openWindowsWorkspaceTabInPane(current, current.activePaneId, nextTarget);
    });
    setPendingSessionReplacement(null);
    setSettingsOpen(false);
  };
  const handleEmptyPaneSelect = (paneId: string) => {
    setPendingSessionReplacement(null);
    setWorkspace((current) => activateWindowsWorkspacePane(current, paneId));
    setSettingsOpen(true);
  };
  const handleChangeContextSession = () => {
    const current = contextMenu;
    if (!current) return;
    setPendingSessionReplacement({ paneId: current.paneId, tabId: current.tabId });
    setWorkspace((workspace) => activateWindowsWorkspacePane(workspace, current.paneId));
    setContextMenu(null);
    setSettingsOpen(true);
  };
  const handleMoveContextTab = (targetPaneId: string) => {
    const current = contextMenu;
    if (!current) return;
    setWorkspace((workspace) => moveWindowsWorkspaceTab(workspace, current.paneId, current.tabId, targetPaneId));
    setContextMenu(null);
  };
  const refreshSessions = () => void sessionControl.refresh(controlTarget);
  const createSession = () => {
    const sessionName = normalizeWindowsNewSessionName(newSessionName);
    if (!sessionName) return;
    void sessionControl.create(controlTarget, sessionName).then(() => {
      setTarget((current) => ({ ...current, sessionName }));
      setNewSessionName('');
    });
  };
  const closeSession = (sessionName: string) => {
    void sessionControl.close(controlTarget, sessionName).then(() => {
      setWorkspace((current) => closeWindowsWorkspaceTarget(current, { ...target, sessionName }));
    });
  };

  return (
    <main className="windows-shell" data-platform={window.ztermWindows?.platform || 'browser'}>
      <header className="titlebar">
        <div className="brand">ZTerm</div>
        <div className="connection-state">
          <span className="state-dot" />
          {activeTab?.target?.sessionName ?? 'No session'}
        </div>
        <div className="titlebar-actions">
          <button className="title-command" onClick={() => setFileBrowserOpen((open) => !open)}>Files</button>
          <button className="icon-button" title="连接设置" aria-label="连接设置" onClick={toggleSettingsPanel}>⚙</button>
        </div>
      </header>
      <WindowsWorkspaceStage
        workspace={workspace}
        registry={registry}
        onChange={setWorkspace}
        onEmptyPaneSelect={handleEmptyPaneSelect}
        onTabContextMenu={(paneId, tabId, anchor) => setContextMenu({ paneId, tabId, left: anchor.left, top: anchor.top })}
      />
      {contextMenu ? (
        <div ref={contextMenuRef} className="windows-pane-context-menu" data-testid="windows-pane-context-menu" role="menu" style={{ left: contextMenu.left, top: contextMenu.top }}>
          <button type="button" role="menuitem" onClick={handleChangeContextSession}>
            Change session
          </button>
          {workspace.panes
            .filter((pane) => pane.id !== contextMenu.paneId)
            .map((pane) => (
              <button key={pane.id} type="button" role="menuitem" onClick={() => handleMoveContextTab(pane.id)}>
                Move to P{workspace.panes.findIndex((candidate) => candidate.id === pane.id) + 1}
              </button>
            ))}
        </div>
      ) : null}
      <WindowsFileBrowserPanel open={fileBrowserOpen} onClose={() => setFileBrowserOpen(false)} />
      {settingsOpen ? (
        <aside className="connection-panel" aria-label="连接设置">
          <div className="panel-title">连接</div>
          <label>主机<input value={target.bridgeHost} onChange={(event) => setTarget({ ...target, bridgeHost: event.target.value })} /></label>
          <label>端口<input type="number" value={target.bridgePort} onChange={(event) => setTarget({ ...target, bridgePort: Number(event.target.value) })} /></label>
          <label>Session<input value={target.sessionName} onChange={(event) => setTarget({ ...target, sessionName: event.target.value })} /></label>
          <label>Token<input type="password" value={target.authToken || ''} onChange={(event) => setTarget({ ...target, authToken: event.target.value || undefined })} /></label>
          <div className="session-control" aria-label="Session 管理">
            <div className="session-control-header"><span>Sessions</span><button className="secondary small" disabled={controlSnapshot.status === 'loading'} onClick={refreshSessions}>刷新</button></div>
            {controlSnapshot.error ? <div className="control-error">{controlSnapshot.error}</div> : null}
            <div className="session-create-row">
              <input aria-label="新建 Session" placeholder="new-session" value={newSessionName} onChange={(event) => setNewSessionName(event.target.value)} />
              <button className="secondary small" disabled={!normalizeWindowsNewSessionName(newSessionName) || controlSnapshot.status === 'loading'} onClick={createSession}>新建</button>
            </div>
            <div className="session-list" aria-label="Session 列表">
              {controlSnapshot.sessions.length === 0 ? <div className="session-empty">{controlSnapshot.status === 'loading' ? '加载中' : '未加载'}</div> : null}
              {controlSnapshot.sessions.map((sessionName) => (
                <div className="session-row" key={sessionName}>
                  <button className="session-name" onClick={() => openSessionInActivePane(sessionName)}>{sessionName}</button>
                  <button className="session-close" aria-label={`关闭 ${sessionName}`} onClick={() => closeSession(sessionName)}>×</button>
                </div>
              ))}
            </div>
          </div>
          <div className="panel-actions">
            <button className="secondary" type="button" onClick={() => setWorkspace((current) => splitWindowsWorkspaceEmpty(current))}>空分屏</button>
            <button className="secondary" disabled={!validTarget} onClick={() => openTarget(true)}>分屏连接</button>
            <button className="secondary" type="button" onClick={closeSettingsPanel}>取消</button>
            <button className="primary" disabled={!validTarget} onClick={() => openTarget(false)}>连接</button>
          </div>
        </aside>
      ) : null}
    </main>
  );
}
