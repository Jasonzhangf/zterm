import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PaneStage,
  buildServerPresetId,
  formatBridgeEndpoint,
  formatBridgeSessionTarget,
  resolveLayoutProfile,
  setDefaultBridgeServer,
  upsertBridgeServer,
  useBridgeSettingsStorage,
  useHostStorage,
  type EditableHost,
  type Host,
  type PaneSlotDefinition,
} from '@zterm/shared';
import { useBridgeTerminalSession } from './lib/use-bridge-terminal';
import { ConnectionsSlot } from './pages/ConnectionsSlot';
import { DetailsSlot } from './pages/DetailsSlot';
import { TerminalSlot } from './pages/TerminalSlot';

interface WorkspaceTargetTab {
  id: string;
  title: string;
  target: EditableHost;
  persistedHostId?: string;
}

function useWindowWidth() {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 0 : window.innerWidth,
  );

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return width;
}

function toEditableHost(host: Host | EditableHost): EditableHost {
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

function buildWorkspaceTargetKey(host: Pick<EditableHost, 'bridgeHost' | 'bridgePort' | 'sessionName' | 'name'>) {
  return [
    formatBridgeEndpoint({ bridgeHost: host.bridgeHost, bridgePort: host.bridgePort }).toLowerCase(),
    (host.sessionName?.trim() || host.name?.trim() || '').toLowerCase(),
  ].join('::');
}

function buildWorkspaceTab(host: Host | EditableHost, persistedHostId?: string): WorkspaceTargetTab {
  const target = toEditableHost(host);
  return {
    id: buildWorkspaceTargetKey(target),
    title: target.sessionName.trim() || target.name.trim() || 'Terminal',
    target,
    persistedHostId,
  };
}

export default function App() {
  const width = useWindowWidth();
  const layout = useMemo(() => resolveLayoutProfile({ width }), [width]);
  const { hosts, isLoaded, addHost, updateHost, deleteHost } = useHostStorage();
  const { settings, setSettings } = useBridgeSettingsStorage();
  const terminalSession = useBridgeTerminalSession();
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<'closed' | 'create' | 'edit'>('closed');
  const [openTabs, setOpenTabs] = useState<WorkspaceTargetTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  useEffect(() => {
    if (hosts.length === 0) {
      setSelectedHostId(null);
      if (editorMode === 'edit') {
        setEditorMode('closed');
      }
      return;
    }

    if (!selectedHostId || !hosts.some((host) => host.id === selectedHostId)) {
      setSelectedHostId(hosts[0].id);
    }
  }, [editorMode, hosts, selectedHostId]);

  const selectedHost = useMemo(
    () => hosts.find((host) => host.id === selectedHostId),
    [hosts, selectedHostId],
  );
  const isEditing = editorMode !== 'closed';

  const switchToTabTarget = useCallback((tab: WorkspaceTargetTab) => {
    setActiveTabId(tab.id);
    if (tab.persistedHostId) {
      setSelectedHostId(tab.persistedHostId);
    }

    const activeRuntimeKey = terminalSession.state.activeTarget
      ? buildWorkspaceTargetKey(terminalSession.state.activeTarget)
      : '';

    if (activeRuntimeKey !== tab.id) {
      terminalSession.connect(tab.target);
    }
  }, [terminalSession]);

  const upsertWorkspaceTab = useCallback((host: Host | EditableHost, persistedHostId?: string) => {
    const nextTab = buildWorkspaceTab(host, persistedHostId);
    setOpenTabs((current) => {
      const existing = current.find((tab) => tab.id === nextTab.id);
      if (!existing) {
        return [...current, nextTab];
      }
      return current.map((tab) => (tab.id === nextTab.id ? { ...tab, ...nextTab } : tab));
    });
    setActiveTabId(nextTab.id);
    return nextTab;
  }, []);

  useEffect(() => {
    if (hosts.length === 0) {
      setOpenTabs([]);
      return;
    }

    setOpenTabs((current) => {
      const synced = current
        .map((tab) => {
          if (!tab.persistedHostId) {
            return tab;
          }
          const host = hosts.find((item) => item.id === tab.persistedHostId);
          return host ? buildWorkspaceTab(host, host.id) : null;
        })
        .filter((tab): tab is WorkspaceTargetTab => tab !== null);

      if (synced.length > 0) {
        return synced;
      }

      const first = hosts[0];
      return [buildWorkspaceTab(first, first.id)];
    });
  }, [hosts]);

  useEffect(() => {
    if (openTabs.length === 0) {
      setActiveTabId(null);
      return;
    }

    if (!activeTabId || !openTabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId(openTabs[0].id);
    }
  }, [activeTabId, openTabs]);

  const activeWorkspaceTab = useMemo(
    () => openTabs.find((tab) => tab.id === activeTabId) || null,
    [activeTabId, openTabs],
  );

  const handleSaveHost = (hostData: EditableHost) => {
    let nextHost: Host | undefined;
    const previousTabId = editorMode === 'edit' && selectedHost ? buildWorkspaceTargetKey(selectedHost) : null;

    if (editorMode === 'edit' && selectedHost) {
      updateHost(selectedHost.id, hostData);
      nextHost = { ...selectedHost, ...hostData };
    } else {
      nextHost = addHost(hostData);
    }

    setSettings((current) => {
      const nextSettings = upsertBridgeServer(current, {
        name: nextHost?.name,
        targetHost: hostData.bridgeHost,
        targetPort: hostData.bridgePort,
        authToken: hostData.authToken,
      });
      const presetId = buildServerPresetId(hostData.bridgeHost, hostData.bridgePort);
      return nextSettings.defaultServerId ? nextSettings : setDefaultBridgeServer(nextSettings, presetId);
    });

    if (nextHost) {
      setSelectedHostId(nextHost.id);
      const nextTab = buildWorkspaceTab(nextHost, nextHost.id);
      setOpenTabs((current) => {
        const filtered = current.filter(
          (tab) => tab.persistedHostId !== nextHost?.id && (!previousTabId || tab.id !== previousTabId),
        );
        return [...filtered, nextTab];
      });
      if (!activeTabId || activeTabId === previousTabId) {
        setActiveTabId(nextTab.id);
      }
    }
    setEditorMode('closed');
  };

  const handleDeleteHost = (hostId: string) => {
    const currentIndex = hosts.findIndex((host) => host.id === hostId);
    const removedTabs = openTabs.filter((tab) => tab.persistedHostId === hostId).map((tab) => tab.id);

    deleteHost(hostId);
    if (selectedHostId === hostId) {
      const fallback = hosts[currentIndex + 1] || hosts[currentIndex - 1];
      setSelectedHostId(fallback?.id || null);
    }
    if (editorMode !== 'closed' && selectedHostId === hostId) {
      setEditorMode('closed');
    }

    setOpenTabs((current) => current.filter((tab) => tab.persistedHostId !== hostId));

    if (removedTabs.includes(activeTabId || '')) {
      const fallback = openTabs.find((tab) => tab.persistedHostId !== hostId) || null;
      if (!fallback) {
        terminalSession.disconnect();
        setActiveTabId(null);
      } else {
        switchToTabTarget(fallback);
      }
    }
  };

  const handleOpenHost = useCallback((hostId: string) => {
    const host = hosts.find((item) => item.id === hostId);
    if (!host) {
      return;
    }
    setSelectedHostId(host.id);
    setEditorMode('closed');
    const nextTab = upsertWorkspaceTab(host, host.id);
    switchToTabTarget(nextTab);
  }, [hosts, switchToTabTarget, upsertWorkspaceTab]);

  const handleConnectRequested = useCallback((hostData: EditableHost) => {
    const persistedHostId = editorMode === 'edit' && selectedHost ? selectedHost.id : undefined;
    const nextTab = upsertWorkspaceTab(hostData, persistedHostId);
    switchToTabTarget(nextTab);
  }, [editorMode, selectedHost, switchToTabTarget, upsertWorkspaceTab]);

  const handleCloseTab = useCallback((tabId: string) => {
    const remaining = openTabs.filter((tab) => tab.id !== tabId);
    setOpenTabs(remaining);

    if (activeTabId !== tabId) {
      return;
    }

    const fallback = remaining[remaining.length - 1] || null;
    if (!fallback) {
      setActiveTabId(null);
      terminalSession.disconnect();
      return;
    }

    switchToTabTarget(fallback);
  }, [activeTabId, openTabs, switchToTabTarget, terminalSession]);

  const baseSlots = useMemo<PaneSlotDefinition[]>(
    () => [
      {
        id: 'connections',
        title: 'Connections',
        subtitle: 'Server groups, saved targets, and shared connection entry.',
        badge: 'Server-first list',
        render: () => (
          <ConnectionsSlot
            hosts={hosts}
            selectedHostId={selectedHostId}
            onSelectHost={(hostId) => {
              setSelectedHostId(hostId);
              if (layout.columns === 2) {
                setEditorMode('closed');
              }
            }}
            onOpenHost={handleOpenHost}
            onCreateHost={() => setEditorMode('create')}
            onEditHost={(hostId) => {
              setSelectedHostId(hostId);
              setEditorMode('edit');
            }}
            onDeleteHost={handleDeleteHost}
          />
        ),
      },
      {
        id: 'terminal',
        title: 'Terminal',
        subtitle: 'Primary stage now renders live bridge snapshots instead of mock text.',
        badge: 'Main execution pane',
        render: () => (
          <TerminalSlot
            host={selectedHost}
            session={terminalSession.state}
            isDetailsVisible={layout.columns === 2 && isEditing}
            onInput={terminalSession.sendInput}
            onResize={terminalSession.resizeTerminal}
            onDisconnect={terminalSession.disconnect}
          />
        ),
      },
      {
        id: 'details',
        title: 'Details',
        subtitle: 'Connection properties flow shared from Android truth source.',
        badge: isEditing ? 'Editing pane' : 'Inspector',
        render: () => (
          <DetailsSlot
            host={editorMode === 'create' ? undefined : selectedHost}
            bridgeSettings={settings}
            bridgeRuntime={terminalSession.state}
            isEditing={isEditing}
            onSave={handleSaveHost}
            onCancel={() => setEditorMode('closed')}
            onConnectRequested={handleConnectRequested}
          />
        ),
      },
    ],
    [
      handleConnectRequested,
      handleDeleteHost,
      handleOpenHost,
      hosts,
      isEditing,
      layout.columns,
      selectedHost,
      selectedHostId,
      settings,
      terminalSession,
    ],
  );

  const slots = useMemo(() => {
    if (layout.columns <= 1) {
      return isEditing ? [baseSlots[2]] : [baseSlots[0]];
    }

    if (layout.columns === 2) {
      return [baseSlots[0], isEditing ? baseSlots[2] : baseSlots[1]];
    }

    return baseSlots;
  }, [baseSlots, isEditing, layout.columns]);

  const shellTitle = selectedHost ? selectedHost.name : 'ZTerm';
  const shellSubtitle = selectedHost
    ? formatBridgeSessionTarget(selectedHost)
    : 'Tabby-inspired Mac shell · shared connection flow';
  const inspectorTabLabel = editorMode === 'create'
    ? 'New connection'
    : isEditing && selectedHost
      ? `Edit ${selectedHost.name}`
      : selectedHost
        ? `Inspector · ${selectedHost.name}`
        : 'Inspector';

  const handleShellTabSelect = (tab: 'connections' | 'inspector') => {
    if (tab === 'inspector') {
      if (selectedHost) {
        setEditorMode((current) => (current === 'closed' ? 'edit' : current));
      } else {
        setEditorMode('create');
      }
      return;
    }

    setEditorMode('closed');
  };

  return (
    <div className="app-shell">
      <header className="window-chrome">
        <div className="traffic-lights" aria-hidden="true">
          <span className="traffic-light red" />
          <span className="traffic-light yellow" />
          <span className="traffic-light green" />
        </div>

        <div className="chrome-title-group">
          <div className="chrome-eyebrow">ZTERM · MAC DESKTOP</div>
          <div className="chrome-title">{shellTitle}</div>
          <div className="chrome-subtitle">{shellSubtitle}</div>
        </div>

        <div className="chrome-tools">
          <span className="chrome-tool-pill">{layout.profile}</span>
          <span className="chrome-tool-pill">{layout.columns} col</span>
          <span className="chrome-tool-pill">vertical split</span>
        </div>
      </header>

      <div className="workspace-tabstrip" role="tablist" aria-label="workspace shell">
        <button
          className={`workspace-tab ${layout.columns <= 1 && !isEditing ? 'active' : ''}`}
          type="button"
          onClick={() => handleShellTabSelect('connections')}
        >
          Connections · {hosts.length}
        </button>
        {openTabs.map((tab) => {
          const isActive = !isEditing && activeTabId === tab.id;
          const runtimeMatches = terminalSession.state.activeTarget
            ? buildWorkspaceTargetKey(terminalSession.state.activeTarget) === tab.id
            : false;
          const runtimeState = runtimeMatches ? terminalSession.state.status : 'idle';

          return (
            <div
              key={tab.id}
              className={`workspace-tab tab-with-close ${isActive ? 'active' : ''}`}
              role="presentation"
            >
              <button
                className="workspace-tab-trigger"
                type="button"
                onClick={() => {
                  setEditorMode('closed');
                  switchToTabTarget(tab);
                }}
              >
                <span className={`tab-runtime-dot ${runtimeState}`} />
                <span>{tab.title}</span>
              </button>
              <button
                className="workspace-tab-close"
                type="button"
                onClick={() => handleCloseTab(tab.id)}
                aria-label={`Close ${tab.title}`}
              >
                ×
              </button>
            </div>
          );
        })}
        <button className="workspace-tab add-tab" type="button" onClick={() => setEditorMode('create')}>
          +
        </button>
        <button
          className={`workspace-tab ${isEditing ? 'active' : ''}`}
          type="button"
          onClick={() => handleShellTabSelect('inspector')}
        >
          {inspectorTabLabel}
        </button>
        <div className="workspace-tab ghost">
          {layout.columns >= 3 ? 'Connections · Tabs · Inspector' : 'single runtime · multi tabs'}
        </div>
      </div>

      {!isLoaded ? (
        <div className="loading-state">Loading saved connections…</div>
      ) : (
        <PaneStage columns={slots.length} slots={slots} />
      )}
    </div>
  );
}
