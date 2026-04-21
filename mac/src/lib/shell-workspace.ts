import type { EditableHost } from '@zterm/shared';

export const SHELL_WORKSPACE_STORAGE_KEY = 'zterm:mac:shell-workspace:v1';
export const SHELL_PROFILE_STORAGE_KEY = 'zterm:mac:shell-profiles:v1';

export type QuickPaletteTab = 'shortcuts' | 'clipboard';

export interface ShellWorkspaceTab {
  id: string;
  title: string;
  kind: 'empty' | 'connection';
  persistedHostId?: string;
  target?: EditableHost;
}

export interface ShellWorkspacePane {
  id: string;
  size: number;
  tabs: ShellWorkspaceTab[];
  activeTabId: string;
}

export interface ShellWorkspaceState {
  panes: ShellWorkspacePane[];
  activePaneId: string;
}

export interface ShellProfileRecord {
  id: string;
  name: string;
  workspace: ShellWorkspaceState;
  createdAt: number;
  updatedAt: number;
}

function generateId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeTarget(input: unknown): EditableHost | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const candidate = input as Partial<EditableHost>;
  if (typeof candidate.name !== 'string' || typeof candidate.bridgeHost !== 'string') {
    return undefined;
  }
  return {
    name: candidate.name,
    bridgeHost: candidate.bridgeHost,
    bridgePort: typeof candidate.bridgePort === 'number' ? candidate.bridgePort : 3333,
    sessionName: typeof candidate.sessionName === 'string' ? candidate.sessionName : '',
    authToken: typeof candidate.authToken === 'string' ? candidate.authToken : undefined,
    authType: candidate.authType === 'key' ? 'key' : 'password',
    password: typeof candidate.password === 'string' ? candidate.password : undefined,
    privateKey: typeof candidate.privateKey === 'string' ? candidate.privateKey : undefined,
    tags: Array.isArray(candidate.tags) ? candidate.tags.filter((item): item is string => typeof item === 'string') : [],
    pinned: candidate.pinned === true,
    lastConnected: typeof candidate.lastConnected === 'number' ? candidate.lastConnected : undefined,
    autoCommand: typeof candidate.autoCommand === 'string' ? candidate.autoCommand : undefined,
  };
}

export function createEmptyWorkspaceTab(): ShellWorkspaceTab {
  return {
    id: generateId('tab'),
    title: '+',
    kind: 'empty',
  };
}

export function createConnectionWorkspaceTab(target: EditableHost, persistedHostId?: string): ShellWorkspaceTab {
  return {
    id: generateId('tab'),
    title: target.sessionName?.trim() || target.name.trim() || 'Terminal',
    kind: 'connection',
    persistedHostId,
    target,
  };
}

export function createWorkspacePane(size = 1): ShellWorkspacePane {
  const tab = createEmptyWorkspaceTab();
  return {
    id: generateId('pane'),
    size,
    tabs: [tab],
    activeTabId: tab.id,
  };
}

export function createDefaultWorkspaceState(): ShellWorkspaceState {
  const pane = createWorkspacePane(1);
  return {
    panes: [pane],
    activePaneId: pane.id,
  };
}

export function cloneWorkspaceState(state: ShellWorkspaceState): ShellWorkspaceState {
  return JSON.parse(JSON.stringify(state)) as ShellWorkspaceState;
}

export function normalizePaneSizes(panes: ShellWorkspacePane[]) {
  const safe = panes.map((pane) => ({ ...pane, size: Number.isFinite(pane.size) && pane.size > 0 ? pane.size : 1 }));
  const total = safe.reduce((sum, pane) => sum + pane.size, 0) || safe.length || 1;
  return safe.map((pane) => ({ ...pane, size: pane.size / total }));
}

export function normalizeWorkspaceState(input: unknown): ShellWorkspaceState {
  if (!input || typeof input !== 'object') {
    return createDefaultWorkspaceState();
  }

  const candidate = input as Partial<ShellWorkspaceState>;
  if (!Array.isArray(candidate.panes) || candidate.panes.length === 0) {
    return createDefaultWorkspaceState();
  }

  const panes = candidate.panes
    .map((pane): ShellWorkspacePane | null => {
      if (!pane || typeof pane !== 'object') {
        return null;
      }
      const rawPane = pane as Partial<ShellWorkspacePane>;
      if (!Array.isArray(rawPane.tabs) || rawPane.tabs.length === 0) {
        return null;
      }

      const tabs = rawPane.tabs
        .map((tab): ShellWorkspaceTab | null => {
          if (!tab || typeof tab !== 'object') {
            return null;
          }
          const rawTab = tab as Partial<ShellWorkspaceTab>;
          const kind = rawTab.kind === 'connection' ? 'connection' : 'empty';
          const baseTitle = typeof rawTab.title === 'string' && rawTab.title.trim() ? rawTab.title : kind === 'empty' ? '+' : 'Terminal';
          return {
            id: typeof rawTab.id === 'string' && rawTab.id ? rawTab.id : generateId('tab'),
            title: baseTitle,
            kind,
            persistedHostId: typeof rawTab.persistedHostId === 'string' ? rawTab.persistedHostId : undefined,
            target: kind === 'connection' ? normalizeTarget(rawTab.target) : undefined,
          };
        })
        .filter((tab): tab is ShellWorkspaceTab => tab !== null);

      if (tabs.length === 0) {
        return null;
      }

      const activeTabId = typeof rawPane.activeTabId === 'string' && tabs.some((tab) => tab.id === rawPane.activeTabId)
        ? rawPane.activeTabId
        : tabs[0].id;

      return {
        id: typeof rawPane.id === 'string' && rawPane.id ? rawPane.id : generateId('pane'),
        size: typeof rawPane.size === 'number' ? rawPane.size : 1,
        tabs,
        activeTabId,
      };
    })
    .filter((pane): pane is ShellWorkspacePane => pane !== null);

  if (panes.length === 0) {
    return createDefaultWorkspaceState();
  }

  const normalizedPanes = normalizePaneSizes(panes);
  const activePaneId = typeof candidate.activePaneId === 'string' && normalizedPanes.some((pane) => pane.id === candidate.activePaneId)
    ? candidate.activePaneId
    : normalizedPanes[0].id;

  return {
    panes: normalizedPanes,
    activePaneId,
  };
}

export function loadShellWorkspaceState() {
  if (typeof window === 'undefined') {
    return createDefaultWorkspaceState();
  }

  try {
    const stored = localStorage.getItem(SHELL_WORKSPACE_STORAGE_KEY);
    return stored ? normalizeWorkspaceState(JSON.parse(stored)) : createDefaultWorkspaceState();
  } catch (error) {
    console.error('[shell-workspace] failed to load workspace state:', error);
    return createDefaultWorkspaceState();
  }
}

export function saveShellWorkspaceState(state: ShellWorkspaceState) {
  if (typeof window === 'undefined') {
    return;
  }
  localStorage.setItem(SHELL_WORKSPACE_STORAGE_KEY, JSON.stringify(normalizeWorkspaceState(state)));
}

export function loadShellProfiles() {
  if (typeof window === 'undefined') {
    return [] as ShellProfileRecord[];
  }

  try {
    const stored = localStorage.getItem(SHELL_PROFILE_STORAGE_KEY);
    if (!stored) {
      return [] as ShellProfileRecord[];
    }
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [] as ShellProfileRecord[];
    }
    return parsed
      .map((item): ShellProfileRecord | null => {
        if (!item || typeof item !== 'object') {
          return null;
        }
        const candidate = item as Partial<ShellProfileRecord>;
        if (typeof candidate.name !== 'string' || !candidate.name.trim()) {
          return null;
        }
        return {
          id: typeof candidate.id === 'string' && candidate.id ? candidate.id : generateId('profile'),
          name: candidate.name.trim(),
          workspace: normalizeWorkspaceState(candidate.workspace),
          createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
          updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
        };
      })
      .filter((profile): profile is ShellProfileRecord => profile !== null);
  } catch (error) {
    console.error('[shell-workspace] failed to load profiles:', error);
    return [] as ShellProfileRecord[];
  }
}

export function saveShellProfiles(profiles: ShellProfileRecord[]) {
  if (typeof window === 'undefined') {
    return;
  }
  localStorage.setItem(SHELL_PROFILE_STORAGE_KEY, JSON.stringify(profiles));
}

export function createShellProfile(name: string, workspace: ShellWorkspaceState): ShellProfileRecord {
  const now = Date.now();
  return {
    id: generateId('profile'),
    name,
    workspace: normalizeWorkspaceState(workspace),
    createdAt: now,
    updatedAt: now,
  };
}
