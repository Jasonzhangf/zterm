/**
 * Mac pane workbench — renders shared PaneStage with Mac-specific terminal content.
 *
 * 核心：
 * - 每个 pane 渲染自己的 tab 列表（shared PaneTabs） + terminal surface
 * - 当 workbench.paneTreeRoot 存在时走递归 split tree 渲染（iTerm2 风格嵌套分屏）
 * - 无 paneTreeRoot 时回退 PaneStage flat 渲染
 * - desktop profile 从 shared pane-profile 读取
 *
 * 不变量：
 * - PaneTabs callback 只抛事件，workspace 状态由父组件 MacAppShell 持有
 * - 递归树的 ratio 变更通过 split node id 走 shared resizeSplitTreeNode
 * - pane 业务 payload（tabs）真源仍是 state.workspace.panes，tree 只表达布局结构
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  listSplitTreePaneIds,
  resolveSplitTreePaneNumbers,
  resizeSplitTreeNode as resizeSplitTreeWorkspace,
  type SplitTreeNode,
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

interface MacPaneTreeNodeProps {
  node: SplitTreeNode<MacWorkbenchTab>;
  activePaneId: string;
  panes: WorkspacePane<MacWorkbenchTab>[];
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
  onPaneRatioChange: (splitNodeId: string, ratio: number) => void;
  paneIndexLookup: Map<string, number>;
}

function MacPaneTreeNode({
  node,
  activePaneId,
  panes,
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
  onPaneRatioChange,
  paneIndexLookup,
}: MacPaneTreeNodeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  if (node.type === 'leaf') {
    const pane = panes.find((candidate) => candidate.id === node.pane.id) ?? {
      id: node.pane.id,
      tabs: node.pane.tabs,
      activeTabId: node.pane.activeTabId,
      size: 1,
    };
    const paneIndex = paneIndexLookup.get(pane.id) ?? 0;
    return (
      <div
        ref={containerRef as any}
        data-testid="pane-stage-frame"
        data-pane-id={pane.id}
        data-pane-active={pane.id === activePaneId ? 'true' : 'false'}
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}
      >
        <MacTerminalPane
          pane={pane as WorkspacePane<MacWorkbenchTab>}
          paneIndex={paneIndex}
          isActivePane={pane.id === activePaneId}
          hosts={hosts}
          platform={platform}
          profile={profile}
          runtimeRegistry={runtimeRegistry}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onActivatePane={onActivatePane}
          onContextMenuTab={onContextMenuTab}
          onRenameTab={onRenameTab}
          onEmptyPaneClick={onEmptyPaneClick}
        />
      </div>
    );
  }
  const isRow = node.direction === 'row';
  const firstPct = `${(node.ratio * 100).toFixed(3)}%`;
  const secondPct = `${((1 - node.ratio) * 100).toFixed(3)}%`;
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const apply = (clientX: number, clientY: number) => {
      const rect = container.getBoundingClientRect();
      const size = isRow ? rect.width : rect.height;
      if (size <= 0) return;
      const offset = isRow
        ? (clientX - rect.left) / size
        : (clientY - rect.top) / size;
      const ratio = Math.max(0.1, Math.min(0.9, offset));
      onPaneRatioChange(node.id, ratio);
    };
    apply(event.clientX, event.clientY);
    const move = (moveEvent: PointerEvent) => apply(moveEvent.clientX, moveEvent.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      ref={containerRef}
      data-testid={isRow ? 'mac-pane-split-row' : 'mac-pane-split-col'}
      data-split-node-id={node.id}
      style={{
        display: 'flex',
        flexDirection: isRow ? 'row' : 'column',
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        width: '100%',
        height: '100%',
      }}
    >
      <div
        data-testid={`mac-pane-child-${node.first.id}`}
        style={{ flex: `0 0 ${firstPct}`, display: 'flex', minHeight: 0, minWidth: 0, overflow: 'hidden' }}
      >
        <MacPaneTreeNode
          node={node.first}
          activePaneId={activePaneId}
          panes={panes}
          hosts={hosts}
          platform={platform}
          profile={profile}
          runtimeRegistry={runtimeRegistry}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onActivatePane={onActivatePane}
          onContextMenuTab={onContextMenuTab}
          onRenameTab={onRenameTab}
          onEmptyPaneClick={onEmptyPaneClick}
          onPaneRatioChange={onPaneRatioChange}
          paneIndexLookup={paneIndexLookup}
        />
      </div>
      <div
        className="mac-pane-divider"
        data-testid={`mac-pane-divider-${node.id}`}
        style={{
          flex: '0 0 2px',
          cursor: isRow ? 'col-resize' : 'row-resize',
          background: 'var(--zterm-divider, rgba(255,255,255,0.08))',
          position: 'relative',
          zIndex: 2,
          touchAction: 'none',
        }}
        onPointerDown={startDrag}
      />
      <div
        data-testid={`mac-pane-child-${node.second.id}`}
        style={{ flex: `1 1 ${secondPct}`, display: 'flex', minHeight: 0, minWidth: 0, overflow: 'hidden' }}
      >
        <MacPaneTreeNode
          node={node.second}
          activePaneId={activePaneId}
          panes={panes}
          hosts={hosts}
          platform={platform}
          profile={profile}
          runtimeRegistry={runtimeRegistry}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onActivatePane={onActivatePane}
          onContextMenuTab={onContextMenuTab}
          onRenameTab={onRenameTab}
          onEmptyPaneClick={onEmptyPaneClick}
          onPaneRatioChange={onPaneRatioChange}
          paneIndexLookup={paneIndexLookup}
        />
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

  const handleSelectTab = useCallback((paneId: string, tabId: string) => {
    setWorkbench((prev) => {
      const paneIndex = prev.workspace.panes.findIndex((p) => p.id === paneId);
      if (paneIndex < 0) return prev;
      return {
        ...prev,
        workspace: {
          ...prev.workspace,
          panes: prev.workspace.panes.map((p, i) =>
            i === paneIndex ? { ...p, activeTabId: tabId } : p,
          ),
          activePaneId: paneId,
        },
      };
    });
  }, [setWorkbench]);

  const handleCloseTab = useCallback((paneId: string, tabId: string) => {
    setWorkbench((prev) => {
      if (!prev.workspace.panes.some((pane) => pane.id === paneId && pane.tabs.some((tab) => tab.id === tabId))) {
        return prev;
      }
      return closeTab(prev, tabId);
    });
  }, [setWorkbench]);

  const handleActivatePane = useCallback((paneId: string) => {
    setWorkbench((prev) => ({
      ...prev,
      workspace: { ...prev.workspace, activePaneId: paneId },
    }));
  }, [setWorkbench]);

  const handleContextMenuTab = useCallback((paneId: string, tabId: string, anchor: { left: number; top: number }) => {
    setContextMenu({ paneId, tabId, left: anchor.left, top: anchor.top });
  }, []);

  const handleRenameTab = useCallback((_paneId: string, _tabId: string) => {
    // desktop double-click rename — 后续切片 (mac-5) 接 inline rename editor
  }, []);

  const handleEmptyPaneClick = useCallback((paneId: string) => {
    setContextMenu(null);
    setWorkbench((prev) => ({
      ...setLauncherOpen(prev, true),
      workspace: { ...prev.workspace, activePaneId: paneId },
    }));
  }, [setWorkbench]);

  const handleChangeContextSession = useCallback(() => {
    const current = contextMenu;
    if (!current) return;
    setContextMenu(null);
    setWorkbench((prev) => beginPendingSessionReplacement(prev, current.paneId, current.tabId));
  }, [contextMenu, setWorkbench]);

  const handleMoveContextTab = useCallback((targetPaneId: string) => {
    const current = contextMenu;
    if (!current) return;
    setContextMenu(null);
    setWorkbench((prev) => moveTabToPane(prev, current.paneId, current.tabId, targetPaneId));
  }, [contextMenu, setWorkbench]);

  const paneIndexLookup = useMemo(() => {
    const map = new Map<string, number>();
    if (workbench.paneTreeRoot) {
      const numbers = resolveSplitTreePaneNumbers({
        tree: workbench.paneTreeRoot,
        activePaneId: workbench.workspace.activePaneId,
      });
      for (const { paneId, index } of numbers) {
        map.set(paneId, index);
      }
    } else {
      workbench.workspace.panes.forEach((pane, index) => {
        map.set(pane.id, index + 1);
      });
    }
    return map;
  }, [workbench.paneTreeRoot, workbench.workspace.activePaneId, workbench.workspace.panes]);

  const handleTreePaneRatioChange = useCallback((splitNodeId: string, ratio: number) => {
    setWorkbench((prev) => {
      if (!prev.paneTreeRoot) return prev;
      const next = resizeSplitTreeWorkspace(
        { tree: prev.paneTreeRoot, activePaneId: prev.workspace.activePaneId },
        splitNodeId,
        ratio,
      );
      return { ...prev, paneTreeRoot: next.tree };
    });
  }, [setWorkbench]);

  const moveTargetLookup = useMemo(() => {
    if (!workbench.paneTreeRoot) return new Map<string, number>();
    return new Map(
      listSplitTreePaneIds(workbench.paneTreeRoot).map((paneId, index) => [paneId, index + 1]),
    );
  }, [workbench.paneTreeRoot]);

  const renderTreeMode = Boolean(workbench.paneTreeRoot && splitVisible);

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
      {renderTreeMode ? (
        <div
          data-testid="mac-pane-workbench-tree"
          style={{ display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0, minWidth: 0, width: '100%', height: '100%' }}
        >
          <MacPaneTreeNode
            node={workbench.paneTreeRoot!}
            activePaneId={workbench.workspace.activePaneId}
            panes={workbench.workspace.panes}
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
            onPaneRatioChange={handleTreePaneRatioChange}
            paneIndexLookup={paneIndexLookup}
          />
        </div>
      ) : null}
      {!renderTreeMode ? (
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
      ) : null}
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
            .map((pane, index) => {
              const numberLabel = moveTargetLookup.get(pane.id)
                ?? paneIndexLookup.get(pane.id)
                ?? index + 1;
              return (
                <button
                  key={pane.id}
                  type="button"
                  role="menuitem"
                  onClick={() => handleMoveContextTab(pane.id)}
                >
                  Move to P{numberLabel}
                </button>
              );
            })}
        </div>
      ) : null}
    </>
  );
}
