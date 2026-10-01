import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  MacTerminalView,
  PaneStage,
  PaneTabs,
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
import { WindowsConnectionStateIndicator, WindowsStatusBar } from './WindowsStatusBar';
import { createWindowsProfileStore, validateWindowsProfile, type WindowsConnectionProfile } from './windows-profile-store';

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

export function WindowsSidebar({
  store,
  controlSnapshot,
  activeProfileId,
  newSessionName,
  filter,
  onActiveProfileChange,
  onNewSessionNameChange,
  onFilterChange,
  onRefresh,
  onCreateSession,
  onOpenSession,
  onCloseSession,
}: {
  store: ReturnType<typeof createWindowsProfileStore>;
  controlSnapshot: { status: 'idle' | 'loading' | 'error'; error: string; sessions: string[] };
  activeProfileId: string | null;
  newSessionName: string;
  filter: string;
  onActiveProfileChange: (profileId: string) => void;
  onNewSessionNameChange: (value: string) => void;
  onFilterChange: (value: string) => void;
  onRefresh: () => void;
  onCreateSession: () => void;
  onOpenSession: (sessionName: string) => void;
  onCloseSession: (sessionName: string) => void;
}) {
  const visibleSessions = controlSnapshot.sessions.filter((sessionName) =>
    sessionName.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <aside className="windows-sidebar" aria-label="连接与 Session" data-testid="windows-sidebar">
      <div className="sidebar-section">
        <div className="sidebar-title">Hosts</div>
        {store.getSnapshot().profiles.map((profile) => (
          <label key={profile.id} className={`profile-row${profile.id === activeProfileId ? ' active' : ''}`}>
            <input
              type="radio"
              name="windows-profile"
              checked={profile.id === activeProfileId}
              onChange={() => onActiveProfileChange(profile.id)}
            />
            <span>{profile.name}</span>
            <span>{profile.bridgeHost}:{profile.bridgePort}</span>
          </label>
        ))}
      </div>
      <div className="sidebar-section">
        <div className="sidebar-title">
          <span>Sessions</span>
          <button className="secondary small" disabled={controlSnapshot.status === 'loading'} onClick={onRefresh}>刷新</button>
        </div>
        {controlSnapshot.error ? <div className="control-error">{controlSnapshot.error}</div> : null}
        <input aria-label="搜索 Session" placeholder="filter sessions" value={filter} onChange={(event) => onFilterChange(event.target.value)} />
        <div className="session-create-row">
          <input aria-label="新建 Session" placeholder="new-session" value={newSessionName} onChange={(event) => onNewSessionNameChange(event.target.value)} />
          <button className="secondary small" disabled={!normalizeWindowsNewSessionName(newSessionName) || controlSnapshot.status === 'loading'} onClick={onCreateSession}>新建</button>
        </div>
        <div className="session-list" aria-label="Session 列表">
          {visibleSessions.length === 0 ? <div className="session-empty">{controlSnapshot.status === 'loading' ? '加载中' : '未加载'}</div> : null}
          {visibleSessions.map((sessionName) => (
            <div className="session-row" key={sessionName}>
              <button className="session-name" onClick={() => onOpenSession(sessionName)}>{sessionName}</button>
              <button className="session-close" aria-label={`关闭 ${sessionName}`} onClick={() => onCloseSession(sessionName)}>×</button>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
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
  onNewPaneTab,
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
  onNewPaneTab: () => void;
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
        plusButton={{ onQuickNew: onNewPaneTab, onOpenTabManager: onNewPaneTab }}
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
  onSplitCurrentTab,
  onSplitNewSession,
  onNewPaneTab,
}: {
  workspace: WindowsWorkspaceState;
  registry: ReturnType<typeof createWindowsTerminalRegistry>;
  onChange: (next: WindowsWorkspaceState) => void;
  onEmptyPaneSelect: (paneId: string) => void;
  onTabContextMenu: (paneId: string, tabId: string, anchor: { left: number; top: number }) => void;
  onSplitCurrentTab: (paneId: string, tabId: string) => void;
  onSplitNewSession: () => void;
  onNewPaneTab: (paneId: string) => void;
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
          onNewPaneTab={() => onNewPaneTab(pane.id)}
        />
      ),
    };
  });
  return (
    <section className="windows-workspace" data-testid="windows-workspace">
      <div className="windows-pane-toolbar">
        <span className="workspace-toolbar-label">Panes</span>
        <div className="workspace-toolbar-actions">
          <button type="button" className="secondary small" data-testid="windows-split-current-tab" title="Split current session into a new pane" aria-label="Split current session into a new pane" disabled={!workspace.panes.some((pane) => pane.id === workspace.activePaneId && pane.tabs.some((tab) => tab.id === pane.activeTabId && tab.target))} onClick={() => { const pane = workspace.panes.find((candidate) => candidate.id === workspace.activePaneId)!; const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId && candidate.target); if (tab) onSplitCurrentTab(pane.id, tab.id); }}>分屏当前 Session</button>
          <button type="button" className="secondary small" data-testid="windows-split-new-session" title="Open a new empty pane and choose a session" aria-label="Open a new empty pane and choose a session" onClick={onSplitNewSession}>新建分屏</button>
        </div>
      </div>
      <PaneStage
        platform="desktop"
        splitVisible={workspace.panes.length > 1}
        slots={slots}
        onActivatePane={(paneId) => onChange(activateWindowsWorkspacePane(workspace, paneId))}
        onPaneRatioChange={({ sourcePaneId, targetPaneId, ratio }) =>
          onChange(resizeWindowsWorkspacePanes(workspace, sourcePaneId, targetPaneId, ratio))}
      />
    </section>
  );
}

export function WindowsDesktopApp() {
  const registry = useMemo(() => createWindowsTerminalRegistry(), []);
  const sessionControl = useMemo(() => createWindowsSessionControl(), []);
  const controlSnapshot = useSyncExternalStore(sessionControl.subscribe, sessionControl.getSnapshot, sessionControl.getSnapshot);
  const profileStore = useMemo(() => createWindowsProfileStore(), []);
  const profileSnapshot = useSyncExternalStore(profileStore.subscribe, profileStore.getSnapshot, profileStore.getSnapshot);
  const [workspace, setWorkspace] = useState(createWindowsWorkspaceState);
  const [registryRevision, setRegistryRevision] = useState(0);
  const [newSessionName, setNewSessionName] = useState('');
  const [sessionFilter, setSessionFilter] = useState('');
  const [profileDraft, setProfileDraft] = useState<WindowsConnectionProfile | null>(null);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<WindowsPaneContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [pendingSessionReplacement, setPendingSessionReplacement] = useState<{ paneId: string; tabId: string } | null>(null);

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

  const activeProfile = profileSnapshot.profiles.find((profile) => profile.id === profileSnapshot.activeProfileId)
    ?? profileSnapshot.profiles[0]
    ?? null;
  const target = activeProfile ? profileStore.resolveTarget(activeProfile) : null;
  const controlTarget = target ? { bridgeHost: target.bridgeHost, bridgePort: target.bridgePort, authToken: target.authToken } : null;
  const validTarget = Boolean(target && !validateWindowsProfile(target));
  const draftError = profileDraft ? validateWindowsProfile(profileDraft) : null;
  const canConnect = profileDraft ? !draftError : validTarget;
  const targetForSession = (sessionName: string): WindowsTerminalTarget => target ? { ...target, sessionName } : target!;
  const openTarget = (split: boolean) => {
    let selectedTarget: WindowsTerminalTarget | null = null;
    if (profileDraft) {
      if (validateWindowsProfile(profileDraft)) return;
      const saved = profileStore.saveProfile(profileDraft);
      selectedTarget = profileStore.resolveTarget(saved);
      setProfileDraft(null);
    } else if (target) {
      selectedTarget = target;
    }
    if (!selectedTarget || validateWindowsProfile(selectedTarget)) return;
    setWorkspace((current) => {
      if (!split && hasWindowsWorkspaceTab(current, pendingSessionReplacement)) {
        return changeWindowsWorkspaceTabSession(
          current,
          pendingSessionReplacement!.paneId,
          pendingSessionReplacement!.tabId,
          selectedTarget,
        );
      }
      return split ? splitWindowsWorkspace(current, selectedTarget) : openWindowsWorkspaceTab(current, selectedTarget);
    });
    setPendingSessionReplacement(null);
  };
  const openSessionInActivePane = (sessionName: string) => {
    const nextTarget = targetForSession(sessionName);
    if (!target) return;
    setWorkspace((current) => {
      const replacement = pendingSessionReplacement;
      if (replacement && hasWindowsWorkspaceTab(current, replacement)) {
        return changeWindowsWorkspaceTabSession(
          current,
          replacement.paneId,
          replacement.tabId,
          nextTarget,
        );
      }
      return openWindowsWorkspaceTabInPane(current, current.activePaneId, nextTarget);
    });
    setPendingSessionReplacement(null);
  };
  const handleEmptyPaneSelect = (paneId: string) => {
    setPendingSessionReplacement(null);
    setWorkspace((current) => activateWindowsWorkspacePane(current, paneId));
  };
  const handleChangeContextSession = () => {
    const current = contextMenu;
    if (!current) return;
    setPendingSessionReplacement({ paneId: current.paneId, tabId: current.tabId });
    setProfileDraft(activeProfile);
    setWorkspace((workspace) => activateWindowsWorkspacePane(workspace, current.paneId));
    setContextMenu(null);
  };
  const handleMoveContextTab = (targetPaneId: string) => {
    const current = contextMenu;
    if (!current) return;
    setWorkspace((workspace) => moveWindowsWorkspaceTab(workspace, current.paneId, current.tabId, targetPaneId));
    setContextMenu(null);
  };
  const refreshSessions = () => {
    if (controlTarget) void sessionControl.refresh(controlTarget);
  };
  const createSession = () => {
    const sessionName = normalizeWindowsNewSessionName(newSessionName);
    if (!sessionName) return;
    if (!controlTarget || !activeProfile) return;
    void sessionControl.create(controlTarget, sessionName).then(() => {
      profileStore.saveProfile({ ...activeProfile, sessionName });
      setNewSessionName('');
    });
  };
  const closeSession = (sessionName: string) => {
    if (!controlTarget || !target) return;
    void sessionControl.close(controlTarget, sessionName).then(() => {
      setWorkspace((current) => closeWindowsWorkspaceTarget(current, { ...target, sessionName }));
    });
  };
  return (
    <main className="windows-shell" data-platform={window.ztermWindows?.platform || 'browser'}>
      <header className="titlebar">
        <div className="brand">ZTerm</div>
        <WindowsConnectionStateIndicator registry={registry} workspace={workspace} />
        <div className="titlebar-actions">
          <button className="title-command" onClick={() => setFileBrowserOpen((open) => !open)}>Files</button>
          <button className="icon-button" title="连接设置" aria-label="连接设置" onClick={() => setProfileDraft(activeProfile)}>⚙</button>
        </div>
      </header>
      <div className="windows-body">
        <WindowsSidebar
          store={profileStore}
          controlSnapshot={controlSnapshot}
          activeProfileId={profileSnapshot.activeProfileId}
          newSessionName={newSessionName}
          filter={sessionFilter}
          onActiveProfileChange={profileStore.setActiveProfile}
          onNewSessionNameChange={setNewSessionName}
          onFilterChange={setSessionFilter}
          onRefresh={refreshSessions}
          onCreateSession={createSession}
          onOpenSession={openSessionInActivePane}
          onCloseSession={closeSession}
        />
        <WindowsWorkspaceStage
        workspace={workspace}
        registry={registry}
        onChange={setWorkspace}
        onEmptyPaneSelect={handleEmptyPaneSelect}
        onTabContextMenu={(paneId, tabId, anchor) => setContextMenu({ paneId, tabId, left: anchor.left, top: anchor.top })}
        onSplitCurrentTab={(paneId, tabId) => {
          const pane = workspace.panes.find((candidate) => candidate.id === paneId);
          const tab = pane?.tabs.find((candidate) => candidate.id === tabId);
          const target = tab?.target;
          if (pane && target) {
            setWorkspace((current) => splitWindowsWorkspace(current, target));
          }
        }}
        onSplitNewSession={() => {
          setPendingSessionReplacement(null);
          setWorkspace((current) => splitWindowsWorkspaceEmpty(current));
        }}
        onNewPaneTab={(paneId) => {
          setPendingSessionReplacement(null);
          setWorkspace((current) => activateWindowsWorkspacePane(current, paneId));
        }}
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
        <WindowsStatusBar
          profile={activeProfile}
          registry={registry}
          workspace={workspace}
          controlError={controlSnapshot.error}
        />
      </div>
      <WindowsFileBrowserPanel open={fileBrowserOpen} onClose={() => setFileBrowserOpen(false)} />
      {profileDraft ? (
        <aside className="connection-panel" aria-label="连接设置" role="complementary">
          <div className="panel-title">连接 Profile</div>
          <label>名称<input value={profileDraft.name} onChange={(event) => setProfileDraft({ ...profileDraft, name: event.target.value })} /></label>
          <label>主机<input value={profileDraft.bridgeHost} onChange={(event) => setProfileDraft({ ...profileDraft, bridgeHost: event.target.value })} /></label>
          <label>端口<input type="number" value={profileDraft.bridgePort} onChange={(event) => setProfileDraft({ ...profileDraft, bridgePort: Number(event.target.value) })} /></label>
          <label>Session<input value={profileDraft.sessionName} onChange={(event) => setProfileDraft({ ...profileDraft, sessionName: event.target.value })} /></label>
          <label>Token<input type="password" value={profileDraft.authToken || ''} onChange={(event) => setProfileDraft({ ...profileDraft, authToken: event.target.value || undefined })} /></label>
          {draftError ? <div className="control-error">{draftError}</div> : null}
          <div className="panel-actions">
            <button className="secondary" type="button" onClick={() => setWorkspace((current) => splitWindowsWorkspaceEmpty(current))}>空分屏</button>
            <button className="secondary" disabled={!canConnect} onClick={() => openTarget(true)}>分屏连接</button>
            <button className="primary" disabled={!canConnect} onClick={() => openTarget(false)}>连接</button>
            <button className="secondary" type="button" onClick={() => setProfileDraft(null)}>取消</button>
            <button className="primary" disabled={Boolean(draftError)} onClick={() => { if (draftError) return; profileStore.saveProfile(profileDraft); setProfileDraft(null); }}>保存</button>
          </div>
        </aside>
      ) : null}
    </main>
  );
}
