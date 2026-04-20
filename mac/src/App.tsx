import { useEffect, useMemo, useState } from 'react';
import {
  PaneStage,
  buildServerPresetId,
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

export default function App() {
  const width = useWindowWidth();
  const layout = useMemo(() => resolveLayoutProfile({ width }), [width]);
  const { hosts, isLoaded, addHost, updateHost, deleteHost } = useHostStorage();
  const { settings, setSettings } = useBridgeSettingsStorage();
  const terminalSession = useBridgeTerminalSession();
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<'closed' | 'create' | 'edit'>('closed');

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

  const handleSaveHost = (hostData: EditableHost) => {
    let nextHost: Host | undefined;

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
    }
    setEditorMode('closed');
  };

  const handleDeleteHost = (hostId: string) => {
    const currentIndex = hosts.findIndex((host) => host.id === hostId);
    deleteHost(hostId);
    if (selectedHostId === hostId) {
      const fallback = hosts[currentIndex + 1] || hosts[currentIndex - 1];
      setSelectedHostId(fallback?.id || null);
    }
    if (editorMode !== 'closed' && selectedHostId === hostId) {
      setEditorMode('closed');
    }
  };

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
            onConnectRequested={terminalSession.connect}
          />
        ),
      },
    ],
    [
      handleDeleteHost,
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">ZTERM · MAC MINIMAL PACKAGE</div>
          <h1>Shared connection flow + live terminal render</h1>
          <p>
            Default to one row with vertical split panes. This stage now reuses Android’s saved
            host / bridge / tmux-session flow and renders bridge terminal snapshots in the Mac pane.
          </p>
        </div>
        <div className="profile-badge">
          <span>{layout.profile}</span>
          <strong>{layout.columns} col</strong>
        </div>
      </header>

      {!isLoaded ? (
        <div className="loading-state">Loading saved connections…</div>
      ) : (
        <PaneStage columns={slots.length} slots={slots} />
      )}
    </div>
  );
}
