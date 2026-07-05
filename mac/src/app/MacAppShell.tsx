import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  buildBridgeServerPresetIdentityId,
  formatBridgeEndpoint,
  formatBridgeSessionTarget,
  setDefaultBridgeServer,
  upsertBridgeServer,
  type BridgeSettings,
  type EditableHost,
  type Host,
  type PanePlatform,
} from '@zterm/shared';
import { ConnectionLauncher } from '../components/ConnectionLauncher';
import { MacFileBrowserPanel } from './file-browser/MacFileBrowserPanel';
import { MacPaneWorkbench } from './MacPaneWorkbench';
import {
  createMacRuntimeRegistry,
  type MacRuntimeEnsureTarget,
  type MacRuntimeRegistry,
} from './runtime/MacRuntimeRegistry';
import {
  buildMacServerDirectorySessionKey,
  fetchMacServerDirectoryLiveSessionSnapshot,
  projectMacServerDirectory,
  resolveMacServerDirectoryOpenIntent,
  type MacServerDirectoryLiveSessionSnapshot,
  type MacServerDirectoryRefreshState,
} from './server-directory/MacServerDirectory';
import { MacServerDirectoryRail } from './server-directory/MacServerDirectoryRail';
import {
  appendEmptyTab,
  createInitialWorkbenchState,
  listWorkbenchRuntimeKeys,
  openConnectionInWorkbench,
  openLocalTmuxInWorkbench,
  resolveActiveTab,
  resolveLocalTmuxSessionName,
  resolveTabTarget,
  resolveTabRuntimeKey,
  setLauncherOpen,
  splitActivePaneRight,
  type MacWorkbenchState,
  type MacWorkbenchTab,
  createWorkbenchStateFromWorkspaceRecord,
  createWorkspaceRecordFromWorkbenchState,
} from './workbench';
import {
  createMacWorkspaceStore,
  type MacRuntimeKey,
  type MacWorkspaceStore,
} from './workspace/workspace-store';

interface MacAppShellProps {
  windowId?: string;
  hosts: Host[];
  isLoaded: boolean;
  bridgeSettings: BridgeSettings;
  setBridgeSettings: Dispatch<SetStateAction<BridgeSettings>>;
  addHost: (host: EditableHost) => Host;
  updateHost: (id: string, updates: Partial<EditableHost>) => void;
  /**
   * test-only: 注入初始 workbench 状态（让测试可驱动 layout state）
   * 生产代码不传（默认 createInitialWorkbenchState）
   */
  __initialWorkbench?: MacWorkbenchState;
  /**
   * test-only: 外部 observer 拿 setWorkbench 引用
   * 生产代码不传
   */
  __workbenchSetter?: (setter: Dispatch<SetStateAction<MacWorkbenchState>>) => void;
}

const DEFAULT_RENDERER_WINDOW_ID = 'browser-dev-window';

function toEditableHost(host: Host): EditableHost {
  return {
    name: host.name,
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    sessionName: host.sessionName,
    authToken: host.authToken,
    authType: host.authType,
    password: host.password,
    privateKey: host.privateKey,
    tags: host.tags,
    pinned: host.pinned,
    lastConnected: host.lastConnected,
    autoCommand: host.autoCommand,
  };
}

function resolveTabRuntimeEnsureTarget(
  tab: MacWorkbenchTab | null,
  hosts: Host[],
): MacRuntimeEnsureTarget | null {
  if (!tab) {
    return null;
  }
  const runtimeKey = resolveTabRuntimeKey(tab, hosts);
  if (!runtimeKey) {
    return null;
  }
  if (tab.kind === 'local-tmux') {
    const sessionName = resolveLocalTmuxSessionName(tab);
    if (!sessionName) {
      return null;
    }
    return {
      kind: 'local-tmux',
      runtimeKey,
      sessionName,
      title: tab.title,
    };
  }
  if (tab.kind !== 'connection') {
    return null;
  }
  const target = resolveTabTarget(tab, hosts);
  if (!target) {
    return null;
  }
  return {
    kind: 'remote',
    runtimeKey,
    target,
  };
}

function resolveWorkbenchRuntimeEnsureTargets(
  workbench: MacWorkbenchState,
  hosts: Host[],
): MacRuntimeEnsureTarget[] {
  const seen = new Set<MacRuntimeKey>();
  const targets: MacRuntimeEnsureTarget[] = [];
  workbench.workspace.panes.forEach((pane) => {
    pane.tabs.forEach((tab) => {
      const target = resolveTabRuntimeEnsureTarget(tab, hosts);
      if (!target || seen.has(target.runtimeKey)) {
        return;
      }
      seen.add(target.runtimeKey);
      targets.push(target);
    });
  });
  return targets;
}

function resolveWorkbenchOpenSessionKeys(workbench: MacWorkbenchState, hosts: Host[]) {
  const sessionKeys = new Set<string>();
  workbench.workspace.panes.forEach((pane) => {
    pane.tabs.forEach((tab) => {
      if (tab.kind !== 'connection') {
        return;
      }
      const target = resolveTabTarget(tab, hosts);
      if (!target) {
        return;
      }
      const serverId = buildBridgeServerPresetIdentityId(target.bridgeHost, target.bridgePort, (target as Host).daemonHostId || (target as Host).relayHostId);
      sessionKeys.add(buildMacServerDirectorySessionKey(serverId, target.sessionName));
    });
  });
  return Array.from(sessionKeys);
}

function createBrowserWorkspaceStore(): MacWorkspaceStore | null {
  if (typeof globalThis.window === 'undefined' || !globalThis.window.localStorage) {
    return null;
  }
  return createMacWorkspaceStore(globalThis.window.localStorage);
}

function createInitialWorkbenchForWindow(
  windowId: string,
  hosts: Host[],
  injected?: MacWorkbenchState,
): MacWorkbenchState {
  if (injected) {
    return injected;
  }
  const store = createBrowserWorkspaceStore();
  if (!store) {
    return createInitialWorkbenchState();
  }
  return createWorkbenchStateFromWorkspaceRecord(store.load(windowId), hosts);
}

export function MacAppShell(props: MacAppShellProps) {
  const {
    hosts,
    isLoaded,
    bridgeSettings,
    setBridgeSettings,
    addHost,
    updateHost,
  } = props;
  const windowId = props.windowId?.trim() || DEFAULT_RENDERER_WINDOW_ID;
  const workspaceStoreRef = useRef<MacWorkspaceStore | null>(null);
  if (workspaceStoreRef.current === null) {
    workspaceStoreRef.current = createBrowserWorkspaceStore();
  }
  const [workbench, setWorkbench] = useState<MacWorkbenchState>(() => {
    return createInitialWorkbenchForWindow(windowId, hosts, props.__initialWorkbench);
  });
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [serverLiveSessions, setServerLiveSessions] = useState<Record<string, MacServerDirectoryLiveSessionSnapshot>>({});
  const [serverRefreshStates, setServerRefreshStates] = useState<Record<string, MacServerDirectoryRefreshState>>({});
  // notify test observer of setWorkbench ref
  useEffect(() => {
    if (props.__workbenchSetter) {
      props.__workbenchSetter(setWorkbench);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const runtimeRegistryRef = useRef<MacRuntimeRegistry | null>(null);
  if (!runtimeRegistryRef.current) {
    runtimeRegistryRef.current = createMacRuntimeRegistry();
  }
  const runtimeRegistry = runtimeRegistryRef.current;
  const previousRuntimeKeysRef = useRef<Set<MacRuntimeKey>>(new Set());

  const activeTab = useMemo(() => resolveActiveTab(workbench), [workbench]);
  const splitVisible = workbench.workspace.panes.length > 1;
  const platform: PanePlatform = 'desktop';
  const activeTarget = useMemo(() => resolveTabTarget(activeTab, hosts), [activeTab, hosts]);
  const activeRuntimeKey = useMemo(() => resolveTabRuntimeKey(activeTab, hosts), [activeTab, hosts]);
  const activeRuntimeEnsureTarget = useMemo(() => resolveTabRuntimeEnsureTarget(activeTab, hosts), [activeTab, hosts]);
  const runtimeEnsureTargets = useMemo(() => resolveWorkbenchRuntimeEnsureTargets(workbench, hosts), [workbench, hosts]);
  const liveRuntimeKeys = useMemo(() => new Set(listWorkbenchRuntimeKeys(workbench, hosts)), [workbench, hosts]);
  const openSessionKeys = useMemo(() => resolveWorkbenchOpenSessionKeys(workbench, hosts), [workbench, hosts]);
  const serverDirectoryProjection = useMemo(() => projectMacServerDirectory({
    bridgeSettings,
    hosts,
    liveSessions: Object.values(serverLiveSessions),
    refreshStates: serverRefreshStates,
    openSessionKeys,
  }), [bridgeSettings, hosts, openSessionKeys, serverLiveSessions, serverRefreshStates]);

  useEffect(() => {
    if (props.__initialWorkbench) {
      return;
    }
    const store = workspaceStoreRef.current;
    if (!store) {
      return;
    }
    const previousRecord = store.load(windowId);
    store.save(createWorkspaceRecordFromWorkbenchState(workbench, {
      windowId,
      hosts,
      previousRecord,
    }));
  }, [hosts, props.__initialWorkbench, windowId, workbench]);

  useEffect(() => () => runtimeRegistry.dispose(), [runtimeRegistry]);

  useEffect(() => {
    runtimeEnsureTargets.forEach((target) => runtimeRegistry.ensureRuntime(target, {
      connect: Boolean(activeRuntimeEnsureTarget && target.runtimeKey === activeRuntimeEnsureTarget.runtimeKey),
    }));
    previousRuntimeKeysRef.current.forEach((runtimeKey) => {
      if (!liveRuntimeKeys.has(runtimeKey)) {
        runtimeRegistry.releaseRuntime(runtimeKey);
      }
    });
    previousRuntimeKeysRef.current = liveRuntimeKeys;
  }, [activeRuntimeEnsureTarget, liveRuntimeKeys, runtimeEnsureTargets, runtimeRegistry]);

  useEffect(() => {
    if (activeRuntimeKey && !liveRuntimeKeys.has(activeRuntimeKey)) {
      runtimeRegistry.setActiveRuntimeKey(null);
      return;
    }
    runtimeRegistry.setActiveRuntimeKey(activeRuntimeKey);
  }, [activeRuntimeKey, liveRuntimeKeys, runtimeRegistry]);

  const rememberTarget = (target: EditableHost) => {
    setBridgeSettings((current) => {
      const next = upsertBridgeServer(current, {
        name: target.name,
        targetHost: target.bridgeHost,
        targetPort: target.bridgePort,
        authToken: target.authToken,
      });
      return setDefaultBridgeServer(next, buildBridgeServerPresetIdentityId(target.bridgeHost, target.bridgePort));
    });
  };

  const handleOpenHost = (host: Host, append: boolean) => {
    const target = toEditableHost(host);
    rememberTarget(target);
    setWorkbench((current) => openConnectionInWorkbench(current, target, { persistedHostId: host.id, append }));
  };

  const handleOpenLocalTmuxSession = (sessionName: string, append: boolean) => {
    setWorkbench((current) => openLocalTmuxInWorkbench(current, sessionName, { append }));
  };

  const handleOpenServerDirectorySession = (serverId: string, sessionName: string, append: boolean) => {
    const intent = resolveMacServerDirectoryOpenIntent(serverDirectoryProjection, serverId, sessionName);
    rememberTarget(intent.target);
    setWorkbench((current) => openConnectionInWorkbench(current, intent.target, {
      persistedHostId: intent.persistedHostId,
      append,
    }));
  };

  const handleRefreshServerDirectoryServer = (serverId: string) => {
    const server = serverDirectoryProjection.servers.find((item) => item.id === serverId);
    if (!server) {
      setServerRefreshStates((current) => ({
        ...current,
        [serverId]: {
          status: 'error',
          error: `Unknown Mac server: ${serverId}`,
          refreshedAt: Date.now(),
        },
      }));
      return;
    }
    setServerRefreshStates((current) => ({
      ...current,
      [serverId]: {
        status: 'loading',
        refreshedAt: current[serverId]?.refreshedAt,
      },
    }));
    void fetchMacServerDirectoryLiveSessionSnapshot(server)
      .then((snapshot) => {
        setServerLiveSessions((current) => ({
          ...current,
          [snapshot.serverId]: snapshot,
        }));
        setServerRefreshStates((current) => ({
          ...current,
          [serverId]: {
            status: 'ready',
            refreshedAt: Date.now(),
          },
        }));
      })
      .catch((error: unknown) => {
        setServerRefreshStates((current) => ({
          ...current,
          [serverId]: {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            refreshedAt: Date.now(),
          },
        }));
      });
  };

  const handleCreateWindow = () => {
    void window.ztermMac?.windowManager?.createWindow();
  };

  const handleSaveDraft = (draft: EditableHost, editingHostId?: string, connectAfterSave?: boolean) => {
    const normalized: EditableHost = {
      ...draft,
      name: draft.name.trim(),
      bridgeHost: draft.bridgeHost.trim(),
      bridgePort: Math.max(1, Math.floor(draft.bridgePort || bridgeSettings.targetPort || 3333)),
      sessionName: draft.sessionName.trim(),
      authToken: draft.authToken?.trim() || '',
      autoCommand: draft.autoCommand?.trim() || '',
      authType: draft.authType || 'password',
      password: draft.password || '',
      privateKey: draft.privateKey || '',
      tags: draft.tags || [],
      pinned: Boolean(draft.pinned),
    };

    if (!normalized.bridgeHost || !normalized.sessionName) {
      return;
    }

    rememberTarget(normalized);

    if (editingHostId) {
      updateHost(editingHostId, normalized);
      if (connectAfterSave) {
        setWorkbench((current) => openConnectionInWorkbench(current, normalized, { persistedHostId: editingHostId }));
      } else {
        setWorkbench((current) => setLauncherOpen(current, false));
      }
      return;
    }

    const saved = addHost(normalized);
    if (connectAfterSave) {
      setWorkbench((current) => openConnectionInWorkbench(current, toEditableHost(saved), { persistedHostId: saved.id }));
      return;
    }
    setWorkbench((current) => setLauncherOpen(current, false));
  };

  const endpointLabel = activeTarget
    ? formatBridgeEndpoint({ bridgeHost: activeTarget.bridgeHost, bridgePort: activeTarget.bridgePort })
    : formatBridgeEndpoint({ bridgeHost: bridgeSettings.targetHost || 'not-set', bridgePort: bridgeSettings.targetPort || 3333 });

  if (!isLoaded) {
    return <div className="mac-shell-loading">Loading workspace…</div>;
  }

  return (
    <div className="mac-shell-root" data-window-id={windowId}>
      <header className="mac-shell-header">
        <div>
          <strong>ZTerm Mac Rewrite</strong>
          <span>{activeTarget ? formatBridgeSessionTarget(activeTarget) : 'No active session'}</span>
        </div>
        <div className="mac-header-actions">
          <span className="mac-endpoint-pill">{endpointLabel}</span>
          <button className="mac-secondary-button" type="button" onClick={() => setWorkbench((current) => appendEmptyTab(current))}>
            + Tab
          </button>
          <button className="mac-secondary-button" type="button" onClick={handleCreateWindow}>
            New Window
          </button>
          <button className="mac-secondary-button" type="button" onClick={() => setFileBrowserOpen(true)}>
            Files
          </button>
          <button className="mac-primary-button" type="button" onClick={() => setWorkbench((current) => setLauncherOpen(current, true))}>
            Open connection
          </button>
        </div>
      </header>

      <div className="mac-tab-strip" data-split-visible={splitVisible ? 'true' : 'false'}>
        <button
          className="mac-secondary-button"
          type="button"
          onClick={() => setWorkbench((current) => splitActivePaneRight(current))}
          disabled={workbench.workspace.panes.length >= 4}
          title="Split pane right"
        >
          ⎘ Split
        </button>
      </div>

      <main className="mac-workspace-main">
        <MacServerDirectoryRail
          projection={serverDirectoryProjection}
          onOpenSession={handleOpenServerDirectorySession}
          onRefreshServer={handleRefreshServerDirectoryServer}
          onOpenConnectionLauncher={() => setWorkbench((current) => setLauncherOpen(current, true))}
        />
        <section className="mac-terminal-stage">
          <MacPaneWorkbench
            workbench={workbench}
            setWorkbench={setWorkbench}
            hosts={hosts}
            platform={platform}
            splitVisible={splitVisible}
            runtimeRegistry={runtimeRegistry}
            bridgeSettings={bridgeSettings}
          />
        </section>
      </main>

      <ConnectionLauncher
        open={workbench.launcherOpen}
        hosts={hosts}
        bridgeSettings={bridgeSettings}
        onClose={() => setWorkbench((current) => setLauncherOpen(current, false))}
        onOpenHost={handleOpenHost}
        onOpenLocalTmuxSession={handleOpenLocalTmuxSession}
        onSaveDraft={handleSaveDraft}
      />
      <MacFileBrowserPanel
        open={fileBrowserOpen}
        onClose={() => setFileBrowserOpen(false)}
      />
    </div>
  );
}
