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

import { useEffect, useRef, useState } from 'react';
import { MacTerminalView, PaneStage, PaneTabs, resolvePaneProfile, resizePaneRatio } from '@zterm/shared';
import type {
  BridgeSettings,
  Host,
  PanePlatform,
  PaneProfile,
  PaneSlotDefinition,
  PaneTabDescriptor,
  WorkspacePane,
} from '@zterm/shared';
import {
  resolveLocalTmuxSessionName,
  resolveTabRuntimeKey,
  resolveTabTarget,
  closeTab,
  moveTabToPane,
  beginPendingSessionReplacement,
  setLauncherOpen,
  type MacWorkbenchTab,
  type MacWorkbenchState,
} from './workbench';
import { useMacRuntimeState, type MacRuntimeRegistry } from './runtime/MacRuntimeRegistry';

interface MacPaneWorkbenchProps {
  workbench: MacWorkbenchState;
  setWorkbench: (next: MacWorkbenchState | ((prev: MacWorkbenchState) => MacWorkbenchState)) => void;
  hosts: Host[];
  platform: PanePlatform;
  splitVisible: boolean;
  runtimeRegistry: MacRuntimeRegistry;
  bridgeSettings: BridgeSettings;
}

function MacTerminalPane({
  pane,
  paneIndex,
  isActivePane,
  hosts,
  platform,
  profile,
  runtimeRegistry,
  onSelectTab,
  onCloseTab,
  onActivatePane,
  onContextMenuTab,
  onRenameTab,
  onEmptyPaneClick,
}: {
  pane: WorkspacePane<MacWorkbenchTab>;
  paneIndex: number;
  isActivePane: boolean;
  hosts: Host[];
  platform: PanePlatform;
  profile: PaneProfile;
  runtimeRegistry: MacRuntimeRegistry;
  onSelectTab: (paneId: string, tabId: string) => void;
  onCloseTab: (paneId: string, tabId: string) => void;
  onActivatePane: (paneId: string) => void;
  onContextMenuTab: (paneId: string, tabId: string, anchor: { left: number; top: number }) => void;
  onRenameTab: (paneId: string, tabId: string) => void;
  onEmptyPaneClick: (paneId: string) => void;
}) {
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0] ?? null;
  const activeTarget = resolveTabTarget(activeTab, hosts);
  const localTmuxSessionName = resolveLocalTmuxSessionName(activeTab);
  const runtimeKey = resolveTabRuntimeKey(activeTab, hosts);
  const runtimeState = useMacRuntimeState(runtimeRegistry, runtimeKey);

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
  const terminalSizeLabel = `${runtimeState.render.cols || 0}x${runtimeState.render.rows || 0}`;
  const connectionError = 'error' in runtimeState.connection ? runtimeState.connection.error : '';

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
              <span className="mac-terminal-size">{terminalSizeLabel}</span>
              {connectionError ? <span className="mac-terminal-error">{connectionError}</span> : null}
              <button
                className="mac-terminal-control"
                type="button"
                data-testid={`mac-terminal-reconnect-${pane.id}`}
                disabled={!runtimeKey}
                onClick={() => runtimeRegistry.reconnectRuntime(runtimeKey)}
              >
                Reconnect
              </button>
              <button
                className="mac-terminal-control"
                type="button"
                data-testid={`mac-terminal-disconnect-${pane.id}`}
                disabled={!runtimeKey}
                onClick={() => runtimeRegistry.disconnectRuntime(runtimeKey)}
              >
                Disconnect
              </button>
            </div>
            <div className="mac-terminal-canvas">
              <MacTerminalView
                projection={runtimeState.render}
                active={isActivePane}
                allowDomFocus
                onInput={(data: string) => runtimeRegistry.sendInput(runtimeKey, data)}
                onResize={(cols: number, rows: number) => runtimeRegistry.resizeTerminal(runtimeKey, cols, rows)}
                onViewportChange={(viewState) => runtimeRegistry.updateViewport(runtimeKey, viewState as any)}
              />
            </div>
          </>
        ) : (
          <button
            className="mac-terminal-empty"
            type="button"
            data-testid={`mac-empty-pane-select-${pane.id}`}
            onClick={() => onEmptyPaneClick(pane.id)}
          >
            <span>Choose session</span>
          </button>
        )}
      </div>
    </div>
  );
}

interface MacPaneContextMenuState {
  paneId: string;
  tabId: string;
  left: number;
  top: number;
}

export function MacPaneWorkbench({
  workbench,
  setWorkbench,
  hosts,
  platform,
  splitVisible,
  runtimeRegistry,
}: MacPaneWorkbenchProps) {
  const profile = resolvePaneProfile({ platform, splitVisible });
  const [contextMenu, setContextMenu] = useState<MacPaneContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

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
    const stillExists = workbench.workspace.panes.some((pane) => (
      pane.id === contextMenu.paneId && pane.tabs.some((tab) => tab.id === contextMenu.tabId)
    ));
    if (!stillExists) {
      setContextMenu(null);
    }
  }, [contextMenu, workbench.workspace.panes]);

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
      if (!prev.workspace.panes.some((pane) => pane.id === paneId && pane.tabs.some((tab) => tab.id === tabId))) {
        return prev;
      }
      return closeTab(prev, tabId);
    });
  };

  const handleActivatePane = (paneId: string) => {
    setWorkbench((prev) => ({
      ...prev,
      workspace: { ...prev.workspace, activePaneId: paneId },
    }));
  };

  const handleContextMenuTab = (paneId: string, tabId: string, anchor: { left: number; top: number }) => {
    setContextMenu({ paneId, tabId, left: anchor.left, top: anchor.top });
  };

  const handleRenameTab = (paneId: string, tabId: string) => {
    // desktop double-click rename — 后续切片 (mac-5) 接 inline rename editor
    void paneId;
    void tabId;
  };

  const handleEmptyPaneClick = (paneId: string) => {
    setContextMenu(null);
    setWorkbench((prev) => ({
      ...setLauncherOpen(prev, true),
      workspace: { ...prev.workspace, activePaneId: paneId },
    }));
  };

  const handleChangeContextSession = () => {
    const current = contextMenu;
    if (!current) return;
    setContextMenu(null);
    setWorkbench((prev) => beginPendingSessionReplacement(prev, current.paneId, current.tabId));
  };

  const handleMoveContextTab = (targetPaneId: string) => {
    const current = contextMenu;
    if (!current) return;
    setContextMenu(null);
    setWorkbench((prev) => moveTabToPane(prev, current.paneId, current.tabId, targetPaneId));
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
        runtimeRegistry={runtimeRegistry}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onActivatePane={handleActivatePane}
        onContextMenuTab={handleContextMenuTab}
        onRenameTab={handleRenameTab}
        onEmptyPaneClick={handleEmptyPaneClick}
      />
    ),
  }));

  return (
    <>
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
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="mac-pane-context-menu"
          data-testid="mac-pane-context-menu"
          style={{ left: contextMenu.left, top: contextMenu.top }}
          role="menu"
        >
          <button type="button" role="menuitem" onClick={handleChangeContextSession}>
            Change session
          </button>
          {workbench.workspace.panes
            .filter((pane) => pane.id !== contextMenu.paneId)
            .map((pane, index) => (
              <button
                key={pane.id}
                type="button"
                role="menuitem"
                onClick={() => handleMoveContextTab(pane.id)}
              >
                Move to P{workbench.workspace.panes.findIndex((candidate) => candidate.id === pane.id) + 1 || index + 1}
              </button>
            ))}
        </div>
      ) : null}
    </>
  );
}
