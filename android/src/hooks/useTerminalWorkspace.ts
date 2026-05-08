import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  cloneWorkspaceState,
  createWorkspacePane,
  DEFAULT_MAX_SPLIT_COUNT,
  distributeEvenPaneSizes,
  findPaneContainingTab,
  moveTabBetweenPanes,
  resolveActivePane,
  resolveActiveTab,
  resolveMaxSplitCount,
  updateWorkspacePane,
} from '@zterm/shared';
import { persistWorkspace, readPersistedWorkspace } from '../lib/workspace-persistence';
import type {
  AndroidWorkspacePane,
  AndroidWorkspaceState,
  AndroidWorkspaceTab,
  Session,
} from '../lib/types';

function sessionToWorkspaceTab(sessionId: string): AndroidWorkspaceTab {
  return {
    id: `tab-${sessionId}`,
    sessionId,
  };
}

function workspaceStatesEqual(left: AndroidWorkspaceState, right: AndroidWorkspaceState): boolean {
  if (left === right) {
    return true;
  }
  if (left.activePaneId !== right.activePaneId || left.panes.length !== right.panes.length) {
    return false;
  }
  for (let index = 0; index < left.panes.length; index += 1) {
    const a = left.panes[index];
    const b = right.panes[index];
    if (!a || !b) {
      return false;
    }
    if (
      a.id !== b.id
      || a.activeTabId !== b.activeTabId
      || Math.abs((a.size || 0) - (b.size || 0)) > 0.000001
      || a.tabs.length !== b.tabs.length
    ) {
      return false;
    }
    for (let tabIndex = 0; tabIndex < a.tabs.length; tabIndex += 1) {
      if (
        a.tabs[tabIndex]?.id !== b.tabs[tabIndex]?.id
        || a.tabs[tabIndex]?.sessionId !== b.tabs[tabIndex]?.sessionId
      ) {
        return false;
      }
    }
  }
  return true;
}

function syncWorkspaceWithSessions(
  current: AndroidWorkspaceState,
  sessions: Session[],
  activeSessionId: string | null,
): AndroidWorkspaceState {
  if (sessions.length === 0) {
    return readPersistedWorkspace([], activeSessionId);
  }

  const sessionIds = new Set(sessions.map((session) => session.id));
  let next = cloneWorkspaceState(current);

  next.panes = next.panes
    .map((pane) => ({
      ...pane,
      tabs: pane.tabs.filter((tab) => sessionIds.has(tab.sessionId)),
    }))
    .filter((pane) => pane.tabs.length > 0);

  if (next.panes.length === 0) {
    const firstSessionId = activeSessionId || sessions[0]?.id || '';
    const tab = sessionToWorkspaceTab(firstSessionId);
    return {
      panes: [{ id: 'pane-main', size: 1, tabs: [tab], activeTabId: tab.id }],
      activePaneId: 'pane-main',
    };
  }

  next.panes = next.panes.map((pane) => {
    const hasActive = pane.tabs.some((tab) => tab.id === pane.activeTabId);
    return hasActive ? pane : { ...pane, activeTabId: pane.tabs[0].id };
  });

  if (!next.panes.some((pane) => pane.id === next.activePaneId)) {
    next.activePaneId = next.panes[0].id;
  }

  if (activeSessionId && next.panes.length === 1) {
    const activeTabId = `tab-${activeSessionId}`;
    const activePaneIndex = next.panes.findIndex((pane) => pane.tabs.some((tab) => tab.id === activeTabId));
    if (activePaneIndex >= 0) {
      next.activePaneId = next.panes[activePaneIndex].id;
      next.panes[activePaneIndex] = {
        ...next.panes[activePaneIndex],
        activeTabId,
      };
    }
  }

  next.panes = distributeEvenPaneSizes(next.panes);
  return workspaceStatesEqual(current, next) ? current : next;
}

function cleanupWorkspaceAfterMove(current: AndroidWorkspaceState): AndroidWorkspaceState {
  const panes = current.panes
    .filter((pane) => pane.tabs.length > 0)
    .map((pane) => {
      const hasActive = pane.tabs.some((tab) => tab.id === pane.activeTabId);
      return hasActive ? pane : { ...pane, activeTabId: pane.tabs[0].id };
    });
  if (panes.length === 0) {
    return current;
  }
  return {
    panes: distributeEvenPaneSizes(panes),
    activePaneId: panes.some((pane) => pane.id === current.activePaneId)
      ? current.activePaneId
      : panes[0].id,
  };
}

function splitOutTabToNewPane(
  current: AndroidWorkspaceState,
  activeSessionId: string | null,
): AndroidWorkspaceState | null {
  const next = cloneWorkspaceState(current);
  const protectedTabId = activeSessionId ? `tab-${activeSessionId}` : null;

  for (let paneIndex = 0; paneIndex < next.panes.length; paneIndex += 1) {
    const pane = next.panes[paneIndex];
    if (pane.tabs.length <= 1) {
      continue;
    }
    const movableTab = [...pane.tabs].reverse().find((tab) => tab.id !== protectedTabId) || null;
    if (!movableTab) {
      continue;
    }
    next.panes[paneIndex] = {
      ...pane,
      tabs: pane.tabs.filter((tab) => tab.id !== movableTab.id),
      activeTabId:
        pane.activeTabId === movableTab.id
          ? (pane.tabs.find((tab) => tab.id !== movableTab.id)?.id ?? pane.activeTabId)
          : pane.activeTabId,
    };
    next.panes.splice(paneIndex + 1, 0, createWorkspacePane(movableTab, 1));
    next.panes = distributeEvenPaneSizes(next.panes);
    return next;
  }

  return null;
}

export interface UseTerminalWorkspaceOptions {
  sessions: Session[];
  activeSessionId: string | null;
  viewportWidth: number;
  viewportHeight?: number;
  maxSplitCount?: number;
}

export interface UseTerminalWorkspaceResult {
  workspace: AndroidWorkspaceState;
  splitVisible: boolean;
  splitAvailable: boolean;
  activePane: AndroidWorkspacePane | null;
  activeTab: AndroidWorkspaceTab | null;
  activePaneSessionId: string | null;
  currentMaxSplitCount: number;
  findPaneForSession: (sessionId: string) => AndroidWorkspacePane | null;
  getPaneSessionIds: (paneId: string) => string[];
  toggleSplit: () => void;
  setSplitCount: (count: number) => void;
  moveSessionToOtherPane: (sessionId: string) => void;
  assignSessionToPane: (sessionId: string, paneId: string) => void;
  attachSessionsToPane: (
    sessionIds: string[],
    paneId: string,
    options?: { restoreSnapshot?: AndroidWorkspaceState | null },
  ) => void;
  attachSessionToPane: (
    sessionId: string,
    paneId: string,
    options?: { restoreSnapshot?: AndroidWorkspaceState | null },
  ) => void;
  setActivePane: (paneId: string) => void;
  switchTabInPane: (paneId: string, tabId: string) => void;
  closeTabInPane: (paneId: string, tabId: string) => void;
  cycleTabInPane: (paneId: string, direction: 'next' | 'previous') => void;
}

export function useTerminalWorkspace({
  sessions,
  activeSessionId,
  viewportWidth,
  viewportHeight,
  maxSplitCount = DEFAULT_MAX_SPLIT_COUNT,
}: UseTerminalWorkspaceOptions): UseTerminalWorkspaceResult {
  const sessionIds = sessions.map((session) => session.id);
  const [workspace, setWorkspace] = useState<AndroidWorkspaceState>(() => (
    readPersistedWorkspace(sessionIds, activeSessionId)
  ));
  const currentMaxSplitCount = resolveMaxSplitCount(
    viewportWidth,
    viewportHeight ?? (typeof window !== 'undefined' ? window.innerHeight : 800),
    0.22,
    maxSplitCount,
  );

  useLayoutEffect(() => {
    setWorkspace((current) => syncWorkspaceWithSessions(current, sessions, activeSessionId));
  }, [sessions, activeSessionId]);

  useEffect(() => {
    persistWorkspace(workspace);
  }, [workspace]);

  useEffect(() => {
    if (workspace.panes.length <= currentMaxSplitCount) {
      return;
    }
    setWorkspace((current) => {
      const safeCount = Math.max(1, currentMaxSplitCount);
      if (current.panes.length <= safeCount) {
        return current;
      }
      if (safeCount === 1) {
        const allTabs = current.panes.flatMap((pane) => pane.tabs);
        const firstPane = current.panes[0];
        return {
          panes: [{ ...firstPane, tabs: allTabs, activeTabId: firstPane.activeTabId }],
          activePaneId: firstPane.id,
        };
      }
      let next = cloneWorkspaceState(current);
      while (next.panes.length > safeCount) {
        const removedPane = next.panes[next.panes.length - 1];
        const keptPane = next.panes[next.panes.length - 2];
        next = {
          panes: [
            ...next.panes.slice(0, -2),
            {
              ...keptPane,
              tabs: [...keptPane.tabs, ...removedPane.tabs],
            },
          ],
          activePaneId: next.activePaneId === removedPane.id ? keptPane.id : next.activePaneId,
        };
      }
      return {
        panes: distributeEvenPaneSizes(next.panes),
        activePaneId: next.activePaneId,
      };
    });
  }, [currentMaxSplitCount, workspace.panes.length]);

  const splitAvailable = sessions.length > 1;
  const splitVisible = workspace.panes.length >= 2 && workspace.panes.every((pane) => pane.tabs.length >= 1);
  const activePane = resolveActivePane(workspace) as AndroidWorkspacePane | null;
  const activeTab = resolveActiveTab(workspace) as AndroidWorkspaceTab | null;
  const activePaneSessionId = activeTab?.sessionId || null;

  const findPaneForSession = useCallback((sessionId: string) => {
    const tabId = `tab-${sessionId}`;
    return findPaneContainingTab(workspace, tabId) as AndroidWorkspacePane | null;
  }, [workspace]);

  const getPaneSessionIds = useCallback((paneId: string) => {
    const pane = workspace.panes.find((candidate) => candidate.id === paneId);
    return pane ? pane.tabs.map((tab) => tab.sessionId) : [];
  }, [workspace]);

  const toggleSplit = useCallback(() => {
    setWorkspace((current) => {
      if (current.panes.length >= 2) {
        const allTabs = current.panes.flatMap((pane) => pane.tabs);
        const firstPane = current.panes[0];
        return {
          panes: [{ ...firstPane, tabs: allTabs, activeTabId: firstPane.activeTabId }],
          activePaneId: firstPane.id,
        };
      }
      const expanded = splitOutTabToNewPane(current, activeSessionId);
      if (!expanded) {
        return current;
      }
      return {
        ...expanded,
        activePaneId: current.activePaneId,
      };
    });
  }, [activeSessionId]);

  const setSplitCount = useCallback((count: number) => {
    setWorkspace((current) => {
      const safeCount = Math.max(1, Math.min(count, currentMaxSplitCount));
      if (safeCount === current.panes.length) {
        return current;
      }
      if (safeCount === 1) {
        const allTabs = current.panes.flatMap((pane) => pane.tabs);
        const firstPane = current.panes[0];
        return {
          panes: [{ ...firstPane, tabs: allTabs, activeTabId: firstPane.activeTabId }],
          activePaneId: firstPane.id,
        };
      }
      let next = cloneWorkspaceState(current);
      while (next.panes.length < safeCount) {
        const expanded = splitOutTabToNewPane(next, activeSessionId);
        if (!expanded) {
          break;
        }
        next = {
          ...expanded,
          activePaneId: next.activePaneId,
        };
      }
      while (next.panes.length > safeCount) {
        const removedPane = next.panes[next.panes.length - 1];
        const keptPane = next.panes[next.panes.length - 2];
        next = {
          panes: [
            ...next.panes.slice(0, -2),
            { ...keptPane, tabs: [...keptPane.tabs, ...removedPane.tabs] },
          ],
          activePaneId: next.activePaneId === removedPane.id ? keptPane.id : next.activePaneId,
        };
      }
      next.panes = distributeEvenPaneSizes(next.panes);
      return next;
    });
  }, [activeSessionId, currentMaxSplitCount]);

  const moveSessionToOtherPane = useCallback((sessionId: string) => {
    setWorkspace((current) => {
      const tabId = `tab-${sessionId}`;
      const sourcePane = findPaneContainingTab(current, tabId) as AndroidWorkspacePane | null;
      if (!sourcePane || current.panes.length < 2) {
        return current;
      }
      const targetPane = current.panes.find((pane) => pane.id !== sourcePane.id);
      if (!targetPane) {
        return current;
      }
      return cleanupWorkspaceAfterMove(moveTabBetweenPanes(current, sourcePane.id, tabId, targetPane.id));
    });
  }, []);

  const assignSessionToPane = useCallback((sessionId: string, paneId: string) => {
    setWorkspace((current) => {
      const tabId = `tab-${sessionId}`;
      const sourcePane = findPaneContainingTab(current, tabId) as AndroidWorkspacePane | null;
      if (!sourcePane || sourcePane.id === paneId) {
        return current;
      }
      const moved = cleanupWorkspaceAfterMove(moveTabBetweenPanes(current, sourcePane.id, tabId, paneId));
      return {
        ...moved,
        activePaneId: paneId,
        panes: moved.panes.map((pane) => (pane.id === paneId ? { ...pane, activeTabId: tabId } : pane)),
      };
    });
  }, []);

  const attachSessionsToPane = useCallback((
    sessionIdsToAttach: string[],
    paneId: string,
    options?: { restoreSnapshot?: AndroidWorkspaceState | null },
  ) => {
    setWorkspace((current) => {
      const normalizedSessionIds = [...new Set(sessionIdsToAttach.map((sessionId) => sessionId.trim()).filter(Boolean))];
      if (normalizedSessionIds.length === 0) {
        return current;
      }
      const restoreSnapshot = options?.restoreSnapshot || null;
      const targetPaneId = paneId.trim();
      if (!targetPaneId) {
        console.error('[useTerminalWorkspace] Refused to attach sessions without an explicit paneId.', {
          sessionIds: normalizedSessionIds,
        });
        return current;
      }
      let next = restoreSnapshot
        ? syncWorkspaceWithSessions(restoreSnapshot, sessions, activeSessionId)
        : cloneWorkspaceState(current);

      let targetPane = next.panes.find((pane) => pane.id === targetPaneId) || null;
      if (!targetPane) {
        targetPane = current.panes.find((pane) => pane.id === targetPaneId) || null;
        if (targetPane) {
          next.panes.push({
            ...targetPane,
            tabs: targetPane.tabs.filter((tab) => sessions.some((session) => session.id === tab.sessionId)),
          });
        }
      }

      if (!targetPane) {
        console.error('[useTerminalWorkspace] Refused to attach sessions to a missing pane.', {
          paneId: targetPaneId,
          sessionIds: normalizedSessionIds,
          workspacePaneIds: next.panes.map((pane) => pane.id),
        });
        return current;
      }

      normalizedSessionIds.forEach((sessionId) => {
        const tabId = `tab-${sessionId}`;
        const sourcePane = findPaneContainingTab(next, tabId) as AndroidWorkspacePane | null;
        if (sourcePane && sourcePane.id !== targetPaneId) {
          next = cleanupWorkspaceAfterMove(moveTabBetweenPanes(next, sourcePane.id, tabId, targetPaneId));
          return;
        }
        if (!sourcePane) {
          next = updateWorkspacePane(next, targetPaneId, (pane) => ({
            ...pane,
            tabs: pane.tabs.some((tab) => tab.id === tabId)
              ? pane.tabs
              : [...pane.tabs, sessionToWorkspaceTab(sessionId)],
          }));
        }
      });

      const activeSessionIdToAttach = normalizedSessionIds[0]!;
      const activeTabId = `tab-${activeSessionIdToAttach}`;
      next = updateWorkspacePane(next, targetPaneId, (pane) => ({
        ...pane,
        activeTabId,
      }));
      next = cleanupWorkspaceAfterMove({
        ...next,
        activePaneId: targetPaneId,
      });
      return next;
    });
  }, [activeSessionId, sessions]);

  const attachSessionToPane = useCallback((
    sessionId: string,
    paneId: string,
    options?: { restoreSnapshot?: AndroidWorkspaceState | null },
  ) => {
    attachSessionsToPane([sessionId], paneId, options);
  }, [attachSessionsToPane]);

  const setActivePane = useCallback((paneId: string) => {
    setWorkspace((current) => {
      if (current.activePaneId === paneId) {
        return current;
      }
      return { ...current, activePaneId: paneId };
    });
  }, []);

  const switchTabInPane = useCallback((paneId: string, tabId: string) => {
    setWorkspace((current) => ({
      ...updateWorkspacePane(current, paneId, (pane) => ({
        ...pane,
        activeTabId: tabId,
      })),
      activePaneId: paneId,
    }));
  }, []);

  const closeTabInPane = useCallback((paneId: string, tabId: string) => {
    setWorkspace((current) => {
      const next = updateWorkspacePane(current, paneId, (pane) => {
        const remaining = pane.tabs.filter((tab) => tab.id !== tabId);
        if (remaining.length === 0) {
          return pane;
        }
        const newActiveId = pane.activeTabId === tabId ? remaining[0].id : pane.activeTabId;
        return { ...pane, tabs: remaining, activeTabId: newActiveId };
      });
      const nonEmptyPanes = next.panes.filter((pane) => pane.tabs.length > 0);
      if (nonEmptyPanes.length === 0) {
        return current;
      }
      return {
        ...next,
        panes: distributeEvenPaneSizes(nonEmptyPanes.length > 0 ? nonEmptyPanes : next.panes),
        activePaneId: nonEmptyPanes.some((pane) => pane.id === next.activePaneId)
          ? next.activePaneId
          : nonEmptyPanes[0]?.id || next.activePaneId,
      };
    });
  }, []);

  const cycleTabInPane = useCallback((paneId: string, direction: 'next' | 'previous') => {
    setWorkspace((current) => {
      const pane = current.panes.find((candidate) => candidate.id === paneId);
      if (!pane || pane.tabs.length <= 1) {
        return current;
      }
      const currentIndex = pane.tabs.findIndex((tab) => tab.id === pane.activeTabId);
      const nextIndex = direction === 'next'
        ? (currentIndex + 1) % pane.tabs.length
        : (currentIndex - 1 + pane.tabs.length) % pane.tabs.length;
      return {
        ...updateWorkspacePane(current, paneId, (targetPane) => ({
          ...targetPane,
          activeTabId: targetPane.tabs[nextIndex]?.id || targetPane.activeTabId,
        })),
        activePaneId: paneId,
      };
    });
  }, []);

  return {
    workspace,
    splitVisible,
    splitAvailable,
    activePane,
    activeTab,
    activePaneSessionId,
    currentMaxSplitCount,
    findPaneForSession,
    getPaneSessionIds,
    toggleSplit,
    setSplitCount,
    moveSessionToOtherPane,
    assignSessionToPane,
    attachSessionsToPane,
    attachSessionToPane,
    setActivePane,
    switchTabInPane,
    closeTabInPane,
    cycleTabInPane,
  };
}
