import {
  createDefaultWorkspaceState,
  distributeEvenPaneSizes,
} from '@zterm/shared';
import {
  STORAGE_KEYS,
  type AndroidWorkspacePane,
  type AndroidWorkspaceState,
  type AndroidWorkspaceTab,
  type TerminalLayoutState,
} from './types';
import { getBrowserStorage } from './browser-storage';

function normalizeAndroidWorkspaceTab(input: unknown, paneIndex: number, tabIndex: number): AndroidWorkspaceTab {
  if (!input || typeof input !== 'object') {
    throw new Error(`workspace pane ${paneIndex} tab ${tabIndex} must be an object`);
  }
  const candidate = input as Partial<AndroidWorkspaceTab>;
  const id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : '';
  const sessionId = typeof candidate.sessionId === 'string' && candidate.sessionId.trim()
    ? candidate.sessionId.trim()
    : '';
  if (!id || !sessionId) {
    throw new Error(`workspace pane ${paneIndex} tab ${tabIndex} must declare explicit id and sessionId`);
  }
  return { id, sessionId };
}

function normalizeAndroidWorkspacePane(input: unknown, index: number): AndroidWorkspacePane {
  if (!input || typeof input !== 'object') {
    throw new Error(`workspace pane ${index} must be an object`);
  }
  const candidate = input as Partial<AndroidWorkspacePane>;
  if (!Array.isArray(candidate.tabs)) {
    throw new Error(`workspace pane ${index} must declare tabs`);
  }
  const tabs = candidate.tabs.map((tab, tabIndex) => normalizeAndroidWorkspaceTab(tab, index, tabIndex));
  const id = typeof candidate.id === 'string' && candidate.id.trim()
    ? candidate.id.trim()
    : '';
  if (!id || typeof candidate.size !== 'number' || !Number.isFinite(candidate.size) || candidate.size <= 0) {
    throw new Error(`workspace pane ${index} must declare explicit id and positive size`);
  }
  const size = candidate.size;
  if (tabs.length === 0) {
    if (candidate.tabs.length > 0) {
      throw new Error(`workspace pane ${index} contains no valid tabs`);
    }
    if (typeof candidate.activeTabId !== 'string' || candidate.activeTabId !== '') {
      throw new Error(`empty workspace pane ${index} must declare activeTabId as empty string`);
    }
    return { id, size, tabs, activeTabId: '' };
  }
  if (typeof candidate.activeTabId !== 'string' || !tabs.some((tab) => tab.id === candidate.activeTabId)) {
    throw new Error(`workspace pane ${index} activeTabId must reference a declared tab`);
  }
  const activeTabId = candidate.activeTabId;
  return { id, size, tabs, activeTabId };
}

export function normalizeAndroidWorkspaceState(input: unknown): AndroidWorkspaceState {
  if (!input || typeof input !== 'object') {
    throw new Error('workspace state must be an object');
  }
  const candidate = input as Partial<AndroidWorkspaceState>;
  if (!Array.isArray(candidate.panes) || candidate.panes.length === 0) {
    throw new Error('workspace state must declare at least one pane');
  }
  const panes = candidate.panes.map(normalizeAndroidWorkspacePane);
  if (panes.length === 0) {
    throw new Error('workspace state must declare at least one valid pane');
  }
  const normalizedPanes = distributeEvenPaneSizes(panes);
  const activePaneId = typeof candidate.activePaneId === 'string'
    && normalizedPanes.some((pane) => pane.id === candidate.activePaneId)
    ? candidate.activePaneId
    : normalizedPanes[0].id;
  return { panes: normalizedPanes, activePaneId };
}

function normalizeLegacyTerminalLayout(input: unknown): TerminalLayoutState | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as Partial<TerminalLayoutState>;
  if (
    !('splitEnabled' in candidate)
    && !('splitSecondarySessionId' in candidate)
    && !('splitPaneAssignments' in candidate)
  ) {
    return null;
  }
  const assignmentsInput = candidate.splitPaneAssignments;
  const splitPaneAssignments: TerminalLayoutState['splitPaneAssignments'] = {};
  if (assignmentsInput && typeof assignmentsInput === 'object') {
    for (const [sessionId, paneId] of Object.entries(assignmentsInput)) {
      if (!sessionId.trim()) {
        continue;
      }
      splitPaneAssignments[sessionId] = paneId === 'secondary' ? 'secondary' : 'primary';
    }
  }
  return {
    splitEnabled: Boolean(candidate.splitEnabled),
    splitSecondarySessionId:
      typeof candidate.splitSecondarySessionId === 'string' && candidate.splitSecondarySessionId.trim()
        ? candidate.splitSecondarySessionId.trim()
        : null,
    splitPaneAssignments,
  };
}

function createPane(
  sessionIds: string[],
  paneId: string,
  activeSessionId: string | null,
): AndroidWorkspacePane | null {
  if (sessionIds.length === 0) {
    return null;
  }
  const tabs: AndroidWorkspaceTab[] = sessionIds.map((sessionId) => ({
    id: `tab-${sessionId}`,
    sessionId,
  }));
  const resolvedActiveSessionId = activeSessionId && sessionIds.includes(activeSessionId)
    ? activeSessionId
    : sessionIds[0];
  return {
    id: paneId,
    size: 1,
    tabs,
    activeTabId: `tab-${resolvedActiveSessionId}`,
  };
}

function migrateLegacyTerminalLayout(
  layout: TerminalLayoutState,
  sessionIds: string[],
  activeSessionId: string | null,
): AndroidWorkspaceState {
  if (sessionIds.length === 0) {
    return createDefaultWorkspaceState<AndroidWorkspaceTab>({ id: 'tab-init', sessionId: '' });
  }

  const uniqueSessionIds = Array.from(new Set(sessionIds.filter(Boolean)));
  const primarySessionIds = uniqueSessionIds.filter(
    (sessionId) => layout.splitPaneAssignments[sessionId] !== 'secondary',
  );
  const secondarySessionIds = uniqueSessionIds.filter(
    (sessionId) => layout.splitPaneAssignments[sessionId] === 'secondary',
  );

  if (!layout.splitEnabled || secondarySessionIds.length === 0) {
    return createWorkspaceFromSessions(uniqueSessionIds, activeSessionId);
  }

  const primaryPane = createPane(
    primarySessionIds.length > 0 ? primarySessionIds : [uniqueSessionIds[0]],
    'pane-main',
    activeSessionId,
  );
  const secondaryPane = createPane(
    secondarySessionIds,
    'pane-secondary',
    layout.splitSecondarySessionId && secondarySessionIds.includes(layout.splitSecondarySessionId)
      ? layout.splitSecondarySessionId
      : activeSessionId,
  );

  if (!primaryPane || !secondaryPane) {
    return createWorkspaceFromSessions(uniqueSessionIds, activeSessionId);
  }

  return {
    panes: distributeEvenPaneSizes([primaryPane, secondaryPane]),
    activePaneId: activeSessionId && secondarySessionIds.includes(activeSessionId)
      ? secondaryPane.id
      : primaryPane.id,
  };
}

export function createWorkspaceFromSessions(
  sessionIds: string[],
  activeSessionId: string | null = null,
): AndroidWorkspaceState {
  if (sessionIds.length === 0) {
    return createDefaultWorkspaceState<AndroidWorkspaceTab>({ id: 'tab-init', sessionId: '' });
  }
  const tabs: AndroidWorkspaceTab[] = sessionIds.map((sessionId) => ({
    id: `tab-${sessionId}`,
    sessionId,
  }));
  const resolvedActiveSessionId = activeSessionId && sessionIds.includes(activeSessionId)
    ? activeSessionId
    : sessionIds[0];
  const pane: AndroidWorkspacePane = {
    id: 'pane-main',
    size: 1,
    tabs,
    activeTabId: `tab-${resolvedActiveSessionId}`,
  };
  return { panes: [pane], activePaneId: pane.id };
}

export function resolvePersistedLiveSessionIds(
  sessionIds: string[] = [],
  activeSessionId: string | null = null,
): string[] {
  const workspace = readPersistedWorkspace(sessionIds, activeSessionId);
  const visiblePaneSessionIds = workspace.panes
    .map((pane) => pane.tabs.find((tab) => tab.id === pane.activeTabId)?.sessionId || null)
    .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.trim().length > 0);
  return Array.from(new Set(visiblePaneSessionIds));
}

export function readPersistedWorkspace(
  sessionIds: string[] = [],
  activeSessionId: string | null = null,
): AndroidWorkspaceState {
  const storage = getBrowserStorage();
  if (!storage) {
    return createWorkspaceFromSessions(sessionIds, activeSessionId);
  }
  const raw = storage.getItem(STORAGE_KEYS.TERMINAL_LAYOUT);
  if (raw === null) {
    return createWorkspaceFromSessions(sessionIds, activeSessionId);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error('[workspace-persistence] Failed to parse workspace:', error);
    throw error;
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Partial<AndroidWorkspaceState>).panes)) {
    return normalizeAndroidWorkspaceState(parsed);
  }
  const legacyLayout = normalizeLegacyTerminalLayout(parsed);
  if (legacyLayout) {
    return migrateLegacyTerminalLayout(legacyLayout, sessionIds, activeSessionId);
  }
  throw new Error('persisted workspace must match the workspace or legacy terminal layout schema');
}

export function persistWorkspace(workspace: AndroidWorkspaceState): void {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify(workspace));
  } catch (error) {
    console.error('[workspace-persistence] Failed to persist workspace:', error);
  }
}
