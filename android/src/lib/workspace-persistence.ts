import {
  createDefaultWorkspaceState,
  distributeEvenPaneSizes,
  generateWorkspaceId,
} from '@zterm/shared';
import {
  STORAGE_KEYS,
  type AndroidWorkspacePane,
  type AndroidWorkspaceState,
  type AndroidWorkspaceTab,
  type TerminalLayoutState,
} from './types';
import { getBrowserStorage } from './browser-storage';

function normalizeAndroidWorkspaceTab(input: unknown): AndroidWorkspaceTab | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as Partial<AndroidWorkspaceTab>;
  const id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : '';
  const sessionId = typeof candidate.sessionId === 'string' && candidate.sessionId.trim()
    ? candidate.sessionId.trim()
    : '';
  if (!id || !sessionId) {
    return null;
  }
  return { id, sessionId };
}

function normalizeAndroidWorkspacePane(input: unknown): AndroidWorkspacePane | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as Partial<AndroidWorkspacePane>;
  if (!Array.isArray(candidate.tabs) || candidate.tabs.length === 0) {
    return null;
  }
  const tabs = candidate.tabs
    .map(normalizeAndroidWorkspaceTab)
    .filter((tab): tab is AndroidWorkspaceTab => tab !== null);
  if (tabs.length === 0) {
    return null;
  }
  const id = typeof candidate.id === 'string' && candidate.id.trim()
    ? candidate.id.trim()
    : generateWorkspaceId('pane');
  const size = typeof candidate.size === 'number' && Number.isFinite(candidate.size) && candidate.size > 0
    ? candidate.size
    : 1;
  const activeTabId = typeof candidate.activeTabId === 'string' && tabs.some((tab) => tab.id === candidate.activeTabId)
    ? candidate.activeTabId
    : tabs[0].id;
  return { id, size, tabs, activeTabId };
}

export function normalizeAndroidWorkspaceState(input: unknown): AndroidWorkspaceState {
  if (!input || typeof input !== 'object') {
    return createDefaultWorkspaceState<AndroidWorkspaceTab>({ id: 'tab-init', sessionId: '' });
  }
  const candidate = input as Partial<AndroidWorkspaceState>;
  if (!Array.isArray(candidate.panes) || candidate.panes.length === 0) {
    return createDefaultWorkspaceState<AndroidWorkspaceTab>({ id: 'tab-init', sessionId: '' });
  }
  const panes = candidate.panes
    .map(normalizeAndroidWorkspacePane)
    .filter((pane): pane is AndroidWorkspacePane => pane !== null);
  if (panes.length === 0) {
    return createDefaultWorkspaceState<AndroidWorkspaceTab>({ id: 'tab-init', sessionId: '' });
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
    id: generateWorkspaceId('pane'),
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
  try {
    const raw = storage.getItem(STORAGE_KEYS.TERMINAL_LAYOUT);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Partial<AndroidWorkspaceState>).panes)) {
      return normalizeAndroidWorkspaceState(parsed);
    }
    const legacyLayout = normalizeLegacyTerminalLayout(parsed);
    if (legacyLayout) {
      return migrateLegacyTerminalLayout(legacyLayout, sessionIds, activeSessionId);
    }
    return createWorkspaceFromSessions(sessionIds, activeSessionId);
  } catch (error) {
    console.error('[workspace-persistence] Failed to read workspace:', error);
    return createWorkspaceFromSessions(sessionIds, activeSessionId);
  }
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
