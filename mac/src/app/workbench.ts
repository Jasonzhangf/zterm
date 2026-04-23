import type { EditableHost, Host } from '@zterm/shared';

export interface MacWorkbenchTab {
  id: string;
  kind: 'empty' | 'connection';
  title: string;
  persistedHostId?: string;
  draftTarget?: EditableHost;
}

export interface MacWorkbenchState {
  tabs: MacWorkbenchTab[];
  activeTabId: string;
  launcherOpen: boolean;
}

function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildConnectionTitle(target: EditableHost) {
  return target.sessionName.trim() || target.name.trim() || target.bridgeHost.trim() || 'Connection';
}

export function createEmptyTab(): MacWorkbenchTab {
  return {
    id: createId('tab'),
    kind: 'empty',
    title: 'New tab',
  };
}

export function createConnectionTab(target: EditableHost, persistedHostId?: string): MacWorkbenchTab {
  return {
    id: createId('tab'),
    kind: 'connection',
    title: buildConnectionTitle(target),
    persistedHostId,
    draftTarget: { ...target },
  };
}

export function createInitialWorkbenchState(): MacWorkbenchState {
  const empty = createEmptyTab();
  return {
    tabs: [empty],
    activeTabId: empty.id,
    launcherOpen: false,
  };
}

function normalizeTabs(tabs: MacWorkbenchTab[]) {
  return tabs.length > 0 ? tabs : [createEmptyTab()];
}

export function setLauncherOpen(state: MacWorkbenchState, launcherOpen: boolean): MacWorkbenchState {
  return {
    ...state,
    launcherOpen,
  };
}

export function activateTab(state: MacWorkbenchState, tabId: string): MacWorkbenchState {
  if (!state.tabs.some((tab) => tab.id === tabId)) {
    return state;
  }
  return {
    ...state,
    activeTabId: tabId,
  };
}

export function appendEmptyTab(state: MacWorkbenchState): MacWorkbenchState {
  const empty = createEmptyTab();
  return {
    ...state,
    tabs: [...state.tabs, empty],
    activeTabId: empty.id,
    launcherOpen: true,
  };
}

export function closeTab(state: MacWorkbenchState, tabId: string): MacWorkbenchState {
  const currentIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (currentIndex === -1) {
    return state;
  }

  const nextTabs = normalizeTabs(state.tabs.filter((tab) => tab.id !== tabId));
  const fallbackIndex = Math.max(0, Math.min(currentIndex - 1, nextTabs.length - 1));
  const nextActiveId = state.activeTabId === tabId
    ? nextTabs[fallbackIndex]?.id || nextTabs[0].id
    : state.activeTabId;

  return {
    ...state,
    tabs: nextTabs,
    activeTabId: nextActiveId,
  };
}

export function openConnectionInWorkbench(
  state: MacWorkbenchState,
  target: EditableHost,
  options?: { persistedHostId?: string; append?: boolean },
): MacWorkbenchState {
  const nextTab = createConnectionTab(target, options?.persistedHostId);
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const activeTab = activeIndex >= 0 ? state.tabs[activeIndex] : null;
  const shouldReplaceActive = !options?.append && activeTab?.kind === 'empty';

  if (shouldReplaceActive && activeIndex >= 0) {
    const nextTabs = [...state.tabs];
    nextTabs[activeIndex] = {
      ...nextTab,
      id: activeTab.id,
    };
    return {
      ...state,
      tabs: nextTabs,
      activeTabId: activeTab.id,
      launcherOpen: false,
    };
  }

  return {
    ...state,
    tabs: [...state.tabs, nextTab],
    activeTabId: nextTab.id,
    launcherOpen: false,
  };
}

export function resolveTabTarget(tab: MacWorkbenchTab | null | undefined, hosts: Host[]) {
  if (!tab || tab.kind !== 'connection') {
    return null;
  }
  if (tab.persistedHostId) {
    const persisted = hosts.find((host) => host.id === tab.persistedHostId);
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
      } satisfies EditableHost;
    }
  }
  return tab.draftTarget ? { ...tab.draftTarget } : null;
}
