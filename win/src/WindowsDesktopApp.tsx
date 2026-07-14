import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
import {
  activateWindowsWorkspacePane,
  activateWindowsWorkspaceTab,
  closeWindowsWorkspaceTarget,
  closeWindowsWorkspaceTab,
  createWindowsWorkspaceState,
  listWindowsWorkspaceRuntimeTabs,
  openWindowsWorkspaceTab,
  resizeWindowsWorkspacePanes,
  splitWindowsWorkspace,
  type WindowsWorkspaceState,
  type WindowsWorkspaceTab,
} from './windows-workspace';

const STORAGE_KEY = 'zterm:windows:target.v1';
const DEFAULT_TARGET: WindowsTerminalTarget = { bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 'zterm' };

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
}: {
  pane: WorkspacePane<WindowsWorkspaceTab>;
  paneIndex: number;
  active: boolean;
  splitVisible: boolean;
  session: WindowsTerminalSession | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onActivatePane: () => void;
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
          <div className="terminal-empty">Choose a session to open a terminal</div>
        )}
      </div>
    </div>
  );
}

export function WindowsWorkspaceStage({
  workspace,
  registry,
  onChange,
}: {
  workspace: WindowsWorkspaceState;
  registry: ReturnType<typeof createWindowsTerminalRegistry>;
  onChange: (next: WindowsWorkspaceState) => void;
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

  useEffect(() => {
    const tabs = listWindowsWorkspaceRuntimeTabs(workspace);
    tabs.forEach((tab) => registry.ensure(tab));
    registry.retain(new Set(tabs.map((tab) => tab.id)));
    setRegistryRevision((revision) => revision + 1);
  }, [registry, workspace]);
  useEffect(() => () => registry.dispose(), [registry]);
  void registryRevision;

  const activeTab = resolveActiveTab(workspace);
  const controlTarget = { bridgeHost: target.bridgeHost, bridgePort: target.bridgePort, authToken: target.authToken };
  const validTarget = Boolean(target.bridgeHost.trim() && target.sessionName.trim() && target.bridgePort > 0);
  const openTarget = (split: boolean) => {
    if (!validTarget) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(target));
    setWorkspace((current) => split ? splitWindowsWorkspace(current, target) : openWindowsWorkspaceTab(current, target));
    setSettingsOpen(false);
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
        <button className="icon-button" title="连接设置" aria-label="连接设置" onClick={() => setSettingsOpen((open) => !open)}>⚙</button>
      </header>
      <WindowsWorkspaceStage workspace={workspace} registry={registry} onChange={setWorkspace} />
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
                  <button className="session-name" onClick={() => setTarget((current) => ({ ...current, sessionName }))}>{sessionName}</button>
                  <button className="session-close" aria-label={`关闭 ${sessionName}`} onClick={() => closeSession(sessionName)}>×</button>
                </div>
              ))}
            </div>
          </div>
          <div className="panel-actions">
            <button className="secondary" disabled={!validTarget} onClick={() => openTarget(true)}>分屏打开</button>
            <button className="primary" disabled={!validTarget} onClick={() => openTarget(false)}>新 Tab</button>
          </div>
        </aside>
      ) : null}
    </main>
  );
}
