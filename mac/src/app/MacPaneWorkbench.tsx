/**
 * Mac pane workbench — renders shared PaneStage with Mac-specific terminal content.
 *
 * 核心：
 * - 每个 pane 渲染自己的 tab 列表（shared PaneTabs） + terminal surface
 * - splitVisible 时使用 PaneStage，single 时直接渲染（PaneStage 自己也支持 single mode，
 *   但这里为避免 desktop 顶栏空 pane 渲染空内容，single 走自渲染 + PaneTabs）
 * - desktop profile 从 shared pane-profile 读取
 *
 * 不变量：
 * - PaneTabs callback 只抛事件（onSelectTab / onCloseTab / onContextMenuTab / onLongPressTab / onRenameTab），
 *   workspace 状态由父组件 MacAppShell 持有
 * - PaneStage onPaneRatioChange 抛 ratio 变更，父组件用 shared resizePaneRatio 写回
 * - pane 数量/比例由 shared workspace-model 唯一真源管
 */

import { MacTerminalView, PaneStage, PaneTabs, resolvePaneProfile, resizePaneRatio } from '@zterm/shared';
import { useEffect, useRef } from 'react';
import type {
  BridgeSettings,
  EditableHost,
  Host,
  PanePlatform,
  PaneProfile,
  PaneSlotDefinition,
  PaneTabDescriptor,
  WorkspacePane,
} from '@zterm/shared';
import type { MacWorkbenchTab, MacWorkbenchState } from './workbench';
import type { TerminalRuntimeController } from '../lib/terminal-runtime';
import type { TerminalRuntimeState } from '../lib/terminal-runtime';

interface MacPaneWorkbenchProps {
  workbench: MacWorkbenchState;
  setWorkbench: (next: MacWorkbenchState | ((prev: MacWorkbenchState) => MacWorkbenchState)) => void;
  hosts: Host[];
  platform: PanePlatform;
  splitVisible: boolean;
  runtime: TerminalRuntimeController;
  runtimeState: TerminalRuntimeState;
  bridgeSettings: BridgeSettings;
}

function resolveTabTarget(tab: MacWorkbenchTab | null | undefined, hosts: Host[]): EditableHost | null {
  if (!tab || tab.kind !== 'connection') {
    return null;
  }
  if (tab.persistedHostId) {
    const persisted = hosts.find((h) => h.id === tab.persistedHostId);
    if (persisted) {
      return {
        name: persisted.name,
        bridgeHost: persisted.bridgeHost,
        bridgePort: persisted.bridgePort,
        sessionName: persisted.sessionName,
        authToken: persisted.authToken,
        authType: persisted.authType,
        password: persisted.password,
        privateKey: persisted.privateKey,
        tags: persisted.tags,
        pinned: persisted.pinned,
        lastConnected: persisted.lastConnected,
        autoCommand: persisted.autoCommand,
      };
    }
  }
  return tab.draftTarget ? { ...tab.draftTarget } : null;
}

function resolveLocalTmuxSessionName(tab: MacWorkbenchTab | null | undefined) {
  return tab?.kind === 'local-tmux' ? tab.localSessionName?.trim() || '' : '';
}

function buildActiveTabRuntimeSignature(tab: MacWorkbenchTab | null, hosts: Host[]) {
  if (!tab) return '';
  if (tab.kind === 'local-tmux') {
    return JSON.stringify({ kind: 'local-tmux', sessionName: resolveLocalTmuxSessionName(tab) });
  }
  const target = resolveTabTarget(tab, hosts);
  if (!target) return '';
  return JSON.stringify({
    kind: 'connection',
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

function MacTerminalPane({
  pane,
  paneIndex,
  isActivePane,
  hosts,
  platform,
  profile,
  runtime,
  runtimeState,
  onSelectTab,
  onCloseTab,
  onActivatePane,
  onContextMenuTab,
  onRenameTab,
}: {
  pane: WorkspacePane<MacWorkbenchTab>;
  paneIndex: number;
  isActivePane: boolean;
  hosts: Host[];
  platform: PanePlatform;
  profile: PaneProfile;
  runtime: TerminalRuntimeController;
  runtimeState: TerminalRuntimeState;
  onSelectTab: (paneId: string, tabId: string) => void;
  onCloseTab: (paneId: string, tabId: string) => void;
  onActivatePane: (paneId: string) => void;
  onContextMenuTab: (paneId: string, tabId: string, anchor: { left: number; top: number }) => void;
  onRenameTab: (paneId: string, tabId: string) => void;
}) {
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0] ?? null;
  const activeTarget = resolveTabTarget(activeTab, hosts);
  const localTmuxSessionName = resolveLocalTmuxSessionName(activeTab);
  const lastSignatureRef = useRef('');
  const activeTabRuntimeSignature = buildActiveTabRuntimeSignature(activeTab, hosts);

  useEffect(() => {
    if (activeTab?.kind === 'local-tmux') {
      if (!localTmuxSessionName) {
        lastSignatureRef.current = '';
        return;
      }
      if (activeTabRuntimeSignature === lastSignatureRef.current) {
        return;
      }
      lastSignatureRef.current = activeTabRuntimeSignature;
      runtime.connectLocalTmux({ sessionName: localTmuxSessionName, title: activeTab.title });
      return;
    }
    if (!activeTarget) {
      lastSignatureRef.current = '';
      return;
    }
    if (activeTabRuntimeSignature === lastSignatureRef.current) {
      return;
    }
    lastSignatureRef.current = activeTabRuntimeSignature;
    runtime.connectRemote(activeTarget);
  }, [activeTab, activeTarget, activeTabRuntimeSignature, localTmuxSessionName, runtime]);

  const tabDescriptors: PaneTabDescriptor[] = pane.tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    isActive: tab.id === pane.activeTabId,
    badge: tab.kind === 'connection' ? '·' : tab.kind === 'local-tmux' ? 'tmux' : undefined,
  }));
  const terminalLabel = activeTab?.kind === 'local-tmux'
    ? `Local tmux · ${localTmuxSessionName}`
    : activeTarget
      ? activeTarget.name || activeTarget.sessionName
      : '';
  const hasTerminal = Boolean(activeTarget || localTmuxSessionName);

  return (
    <div
      data-pane-id={pane.id}
      data-pane-active={isActivePane ? 'true' : 'false'}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}
    >
      <PaneTabs
        platform={platform}
        profile={profile}
        paneId={pane.id}
        paneIndex={paneIndex}
        isActivePane={isActivePane}
        tabs={tabDescriptors}
        onSelectTab={(tabId) => onSelectTab(pane.id, tabId)}
        onCloseTab={(tabId) => onCloseTab(pane.id, tabId)}
        onActivatePane={onActivatePane}
        onContextMenuTab={(tabId, anchor) => onContextMenuTab(pane.id, tabId, anchor)}
        onRenameTab={(tabId) => onRenameTab(pane.id, tabId)}
      />
      <div className="mac-terminal-surface">
        {hasTerminal ? (
          <>
            <div className="mac-terminal-meta">
              <span className={`mac-runtime-pill ${runtimeState.connection.status}`}>{runtimeState.connection.status}</span>
              <span>{terminalLabel}</span>
            </div>
            <div className="mac-terminal-canvas">
              <MacTerminalView
                projection={runtimeState.render}
                active={isActivePane}
                allowDomFocus
                onInput={(data: string) => runtime.sendInput(data)}
              />
            </div>
          </>
        ) : (
          <div className="mac-terminal-empty">
            <span>No session</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function MacPaneWorkbench({
  workbench,
  setWorkbench,
  hosts,
  platform,
  splitVisible,
  runtime,
  runtimeState,
}: MacPaneWorkbenchProps) {
  const profile = resolvePaneProfile({ platform, splitVisible });

  const handleSelectTab = (paneId: string, tabId: string) => {
    setWorkbench((prev) => {
      const next = { ...prev };
      const paneIndex = next.workspace.panes.findIndex((p) => p.id === paneId);
      if (paneIndex < 0) return prev;
      return {
        ...next,
        workspace: {
          ...next.workspace,
          panes: next.workspace.panes.map((p, i) =>
            i === paneIndex ? { ...p, activeTabId: tabId } : p,
          ),
          activePaneId: paneId,
        },
      };
    });
  };

  const handleCloseTab = (paneId: string, tabId: string) => {
    setWorkbench((prev) => {
      const pane = prev.workspace.panes.find((p) => p.id === paneId);
      if (!pane) return prev;
      const remaining = pane.tabs.filter((t) => t.id !== tabId);
      if (remaining.length === 0) {
        if (prev.workspace.panes.length === 1) {
          return prev;
        }
        return {
          ...prev,
          workspace: {
            ...prev.workspace,
            panes: prev.workspace.panes.filter((p) => p.id !== paneId),
          },
        };
      }
      const nextActiveTab = pane.activeTabId === tabId
        ? remaining[remaining.length - 1]?.id ?? remaining[0].id
        : pane.activeTabId;
      return {
        ...prev,
        workspace: {
          ...prev.workspace,
          panes: prev.workspace.panes.map((p) =>
            p.id === paneId ? { ...p, tabs: remaining, activeTabId: nextActiveTab } : p,
          ),
        },
      };
    });
  };

  const handleActivatePane = (paneId: string) => {
    setWorkbench((prev) => ({
      ...prev,
      workspace: { ...prev.workspace, activePaneId: paneId },
    }));
  };

  const handleContextMenuTab = (paneId: string, tabId: string, _anchor: { left: number; top: number }) => {
    // desktop right-click 当前阶段不弹菜单 — 后续切片 (mac-5) 接 PaneTabs context menu
    // 此处不修改状态，但保留 callback 让红测可观察 event 路由
    void paneId;
    void tabId;
  };

  const handleRenameTab = (paneId: string, tabId: string) => {
    // desktop double-click rename — 后续切片 (mac-5) 接 inline rename editor
    void paneId;
    void tabId;
  };

  const slots: PaneSlotDefinition[] = workbench.workspace.panes.map((pane, index) => ({
    id: pane.id,
    title: `Pane ${index + 1}`,
    size: pane.size,
    isActive: pane.id === workbench.workspace.activePaneId,
    tabIds: pane.tabs.map((t) => t.id),
    activeTabId: pane.activeTabId,
    render: () => (
      <MacTerminalPane
        pane={pane}
        paneIndex={index}
        isActivePane={pane.id === workbench.workspace.activePaneId}
        hosts={hosts}
        platform={platform}
        profile={profile}
        runtime={runtime}
        runtimeState={runtimeState}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onActivatePane={handleActivatePane}
        onContextMenuTab={handleContextMenuTab}
        onRenameTab={handleRenameTab}
      />
    ),
  }));

  return (
    <PaneStage
      platform={platform}
      splitVisible={splitVisible}
      slots={slots}
      onActivatePane={handleActivatePane}
      onPaneRatioChange={(event) => {
        setWorkbench((prev) => ({
          ...prev,
          workspace: resizePaneRatio(prev.workspace, event.sourcePaneId, event.targetPaneId, event.ratio),
        }));
      }}
    />
  );
}
