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
import {
  createTerminalRuntime,
  useTerminalRuntimeState,
  type TerminalRuntimeController,
} from '../lib/terminal-runtime';
import { MacPaneWorkbench } from './MacPaneWorkbench';
import {
  appendEmptyTab,
  createInitialWorkbenchState,
  openConnectionInWorkbench,
  resolveActiveTab,
  resolveTabTarget,
  setLauncherOpen,
  splitActivePaneRight,
  type MacWorkbenchState,
} from './workbench';

interface MacAppShellProps {
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

export function MacAppShell(props: MacAppShellProps) {
  const {
    hosts,
    isLoaded,
    bridgeSettings,
    setBridgeSettings,
    addHost,
    updateHost,
  } = props;
  const [workbench, setWorkbench] = useState<MacWorkbenchState>(() => {
    if (props.__initialWorkbench) {
      return props.__initialWorkbench;
    }
    return createInitialWorkbenchState();
  });
  // notify test observer of setWorkbench ref
  useEffect(() => {
    if (props.__workbenchSetter) {
      props.__workbenchSetter(setWorkbench);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const runtimeRef = useRef<TerminalRuntimeController | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = createTerminalRuntime();
  }
  const runtime = runtimeRef.current;
  const runtimeState = useTerminalRuntimeState(runtime);

  const activeTab = useMemo(() => resolveActiveTab(workbench), [workbench]);
  const splitVisible = workbench.workspace.panes.length > 1;
  const platform: PanePlatform = 'desktop';
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

      <main className="mac-terminal-stage">
        <MacPaneWorkbench
          workbench={workbench}
          setWorkbench={setWorkbench}
          hosts={hosts}
          platform={platform}
          splitVisible={splitVisible}
          runtime={runtime}
          runtimeState={runtimeState}
          bridgeSettings={bridgeSettings}
        />
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
