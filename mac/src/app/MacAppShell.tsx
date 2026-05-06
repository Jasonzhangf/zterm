import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  TerminalView,
  buildBridgeServerPresetIdentityId,
  formatBridgeEndpoint,
  formatBridgeSessionTarget,
  getResolvedSessionName,
  setDefaultBridgeServer,
  upsertBridgeServer,
  type BridgeSettings,
  type EditableHost,
  type Host,
} from '@zterm/shared';
import { ConnectionLauncher } from '../components/ConnectionLauncher';
import {
  createTerminalRuntime,
  useTerminalRuntimeState,
  type TerminalRuntimeController,
} from '../lib/terminal-runtime';
import {
  activateTab,
  appendEmptyTab,
  closeTab,
  createInitialWorkbenchState,
  openConnectionInWorkbench,
  resolveTabTarget,
  setLauncherOpen,
} from './workbench';

interface MacAppShellProps {
  hosts: Host[];
  isLoaded: boolean;
  bridgeSettings: BridgeSettings;
  setBridgeSettings: Dispatch<SetStateAction<BridgeSettings>>;
  addHost: (host: EditableHost) => Host;
  updateHost: (id: string, updates: Partial<EditableHost>) => void;
}

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

function buildTargetSignature(target: EditableHost | null) {
  if (!target) {
    return '';
  }
  return JSON.stringify({
    name: target.name,
    bridgeHost: target.bridgeHost,
    bridgePort: target.bridgePort,
    sessionName: target.sessionName,
    authToken: target.authToken || '',
    authType: target.authType,
    password: target.password || '',
    privateKey: target.privateKey || '',
    autoCommand: target.autoCommand || '',
  });
}

export function MacAppShell({
  hosts,
  isLoaded,
  bridgeSettings,
  setBridgeSettings,
  addHost,
  updateHost,
}: MacAppShellProps) {
  const [workbench, setWorkbench] = useState(createInitialWorkbenchState);
  const runtimeRef = useRef<TerminalRuntimeController | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = createTerminalRuntime();
  }
  const runtime = runtimeRef.current;
  const runtimeState = useTerminalRuntimeState(runtime);

  const activeTab = useMemo(
    () => workbench.tabs.find((tab) => tab.id === workbench.activeTabId) ?? workbench.tabs[0] ?? null,
    [workbench],
  );
  const activeTarget = useMemo(() => resolveTabTarget(activeTab, hosts), [activeTab, hosts]);
  const activeTargetSignature = useMemo(() => buildTargetSignature(activeTarget), [activeTarget]);
  const lastConnectedSignatureRef = useRef('');

  useEffect(() => () => runtime.dispose(), [runtime]);

  useEffect(() => {
    if (!activeTarget) {
      lastConnectedSignatureRef.current = '';
      runtime.disconnect();
      return;
    }
    if (activeTargetSignature === lastConnectedSignatureRef.current) {
      return;
    }
    lastConnectedSignatureRef.current = activeTargetSignature;
    runtime.connectRemote(activeTarget);
  }, [activeTarget, activeTargetSignature, runtime]);

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
    <div className="mac-shell-root">
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
          <button className="mac-primary-button" type="button" onClick={() => setWorkbench((current) => setLauncherOpen(current, true))}>
            Open connection
          </button>
        </div>
      </header>

      <div className="mac-tab-strip">
        {workbench.tabs.map((tab) => {
          const selected = tab.id === workbench.activeTabId;
          return (
            <div className={`mac-tab ${selected ? 'active' : ''}`} key={tab.id}>
              <button type="button" className="mac-tab-button" onClick={() => setWorkbench((current) => activateTab(current, tab.id))}>
                <span className={`mac-tab-dot ${selected ? runtimeState.connection.status : 'idle'}`} />
                <span>{tab.title}</span>
              </button>
              {workbench.tabs.length > 1 ? (
                <button className="mac-tab-close" type="button" onClick={() => setWorkbench((current) => closeTab(current, tab.id))}>
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      <main className="mac-terminal-stage">
        {activeTarget ? (
          <>
            <div className="mac-terminal-meta">
              <span className={`mac-runtime-pill ${runtimeState.connection.status}`}>{runtimeState.connection.status}</span>
              <span>{formatBridgeSessionTarget(activeTarget)}</span>
              <span>{runtimeState.connection.connectedSessionId || getResolvedSessionName(activeTarget)}</span>
            </div>
            {runtimeState.connection.error ? <div className="mac-terminal-error">{runtimeState.connection.error}</div> : null}
            <div className="mac-terminal-surface">
              <TerminalView
                sessionId={runtimeState.connection.connectedSessionId || getResolvedSessionName(activeTarget)}
                projection={runtimeState.render}
                active
                allowDomFocus
                themeId={bridgeSettings.terminalThemeId}
                onInput={(data) => runtime.sendInput(data)}
                onResize={(cols, rows) => runtime.resizeTerminal(cols, rows)}
                onViewportChange={(viewState) => runtime.updateViewport(viewState)}
              />
            </div>
          </>
        ) : (
          <button className="mac-empty-stage" type="button" onClick={() => setWorkbench((current) => setLauncherOpen(current, true))}>
            <span className="mac-empty-plus">+</span>
            <strong>Open connection</strong>
            <span>先建立新的 app shell，再继续往下切 buffer worker / split。</span>
          </button>
        )}
      </main>

      <ConnectionLauncher
        open={workbench.launcherOpen}
        hosts={hosts}
        bridgeSettings={bridgeSettings}
        onClose={() => setWorkbench((current) => setLauncherOpen(current, false))}
        onOpenHost={handleOpenHost}
        onSaveDraft={handleSaveDraft}
      />
    </div>
  );
}
