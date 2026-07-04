import {
  addPaneToWorkspace,
  createWorkspacePane,
  moveTabBetweenPanes,
  normalizePaneSizes,
  removePaneFromWorkspace,
  resizePaneRatio,
  setActivePane,
  updateWorkspacePane,
  type WorkspacePane,
  type WorkspaceState,
  type WorkspaceTab,
} from '@zterm/shared';

export type MacRuntimeKey =
  | `remote:${string}:${string}`
  | `local-tmux:${string}`;

export type MacWorkspaceTabKind = 'empty' | 'remote' | 'local-tmux';
export type MacPaneSplitDirection = 'right' | 'down';

export interface MacWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MacWindowRecord {
  windowId: string;
  title: string;
  bounds?: MacWindowBounds;
  workspaceId: string;
  lastFocusedAt: number;
}

export interface MacTabRecord extends WorkspaceTab {
  id: string;
  kind: MacWorkspaceTabKind;
  title: string;
  runtimeKey?: MacRuntimeKey;
  serverId?: string;
  sessionName?: string;
  localSessionName?: string;
}

export type MacPaneRecord = WorkspacePane<MacTabRecord>;

export interface MacPaneTreeRecord {
  kind: 'row';
  paneIds: string[];
  lastSplit?: {
    sourcePaneId: string;
    newPaneId: string;
    direction: MacPaneSplitDirection;
  };
}

export type MacPaneTree = MacPaneTreeRecord;

export interface MacWorkspaceRecord {
  workspaceId: string;
  windowId: string;
  paneTree: MacPaneTreeRecord;
  panes: MacPaneRecord[];
  activePaneId: string;
  updatedAt: number;
}

export interface MacWorkspaceStoreStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface MacWorkspaceStoreClock {
  now(): number;
}

export interface CreateMacWorkspaceStoreOptions {
  clock?: MacWorkspaceStoreClock;
}

export interface MacWorkspaceStore {
  load(windowId: string): MacWorkspaceRecord;
  save(record: MacWorkspaceRecord): MacWorkspaceRecord;
  update(windowId: string, updater: (record: MacWorkspaceRecord) => MacWorkspaceRecord): MacWorkspaceRecord;
  remove(windowId: string): void;
  storageKey(windowId: string): string;
}

export class MacWorkspaceStoreInvalidRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MacWorkspaceStoreInvalidRecordError';
  }
}

export const MAC_WORKSPACE_STORAGE_PREFIX = 'zterm:mac:workspace:v1:';
export const LEGACY_SHELL_WORKSPACE_STORAGE_KEY = 'zterm:mac:shell-workspace:v1';

const FORBIDDEN_WORKSPACE_RECORD_KEYS = new Set([
  'runtimeState',
  'transport',
  'transportState',
  'buffer',
  'bufferState',
  'render',
  'renderProjection',
  'terminalRuntime',
  'controller',
  'connectionState',
]);

function defaultNow() {
  return Date.now();
}

function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MacWorkspaceStoreInvalidRecordError(`Invalid Mac workspace record: ${field} must be a non-empty string`);
  }
}

function collectForbiddenRecordKeys(input: unknown, path: string[] = []): string[] {
  if (!input || typeof input !== 'object') {
    return [];
  }
  if (Array.isArray(input)) {
    return input.flatMap((item, index) => collectForbiddenRecordKeys(item, [...path, String(index)]));
  }
  const found: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const currentPath = [...path, key];
    if (FORBIDDEN_WORKSPACE_RECORD_KEYS.has(key)) {
      found.push(currentPath.join('.'));
    }
    found.push(...collectForbiddenRecordKeys(value, currentPath));
  }
  return found;
}

export function assertMacWorkspaceRecordBoundary(record: MacWorkspaceRecord): MacWorkspaceRecord {
  const forbidden = collectForbiddenRecordKeys(record);
  if (forbidden.length > 0) {
    throw new MacWorkspaceStoreInvalidRecordError(
      `Mac workspace record contains runtime-owned fields: ${forbidden.join(', ')}`,
    );
  }
  return record;
}

export function buildRemoteMacRuntimeKey(serverId: string, sessionName: string): MacRuntimeKey {
  return `remote:${serverId}:${sessionName}`;
}

export function buildLocalTmuxMacRuntimeKey(sessionName: string): MacRuntimeKey {
  return `local-tmux:${sessionName}`;
}

export function createEmptyMacTab(id = createId('tab')): MacTabRecord {
  return {
    id,
    kind: 'empty',
    title: 'New tab',
  };
}

export function createRemoteMacTab(options: {
  id?: string;
  title?: string;
  serverId: string;
  sessionName: string;
}): MacTabRecord {
  const sessionName = options.sessionName.trim();
  const serverId = options.serverId.trim();
  return {
    id: options.id ?? createId('tab'),
    kind: 'remote',
    title: options.title?.trim() || sessionName || serverId || 'Remote session',
    serverId,
    sessionName,
    runtimeKey: buildRemoteMacRuntimeKey(serverId, sessionName),
  };
}

export function createLocalTmuxMacTab(options: {
  id?: string;
  title?: string;
  sessionName: string;
}): MacTabRecord {
  const sessionName = options.sessionName.trim();
  return {
    id: options.id ?? createId('tab'),
    kind: 'local-tmux',
    title: options.title?.trim() || sessionName || 'Local tmux',
    localSessionName: sessionName,
    runtimeKey: buildLocalTmuxMacRuntimeKey(sessionName),
  };
}

export function createMacWorkspacePane(tab: MacTabRecord, size = 1): MacPaneRecord {
  return createWorkspacePane<MacTabRecord>(tab, size);
}

export function createInitialMacWorkspaceRecord(options: {
  windowId: string;
  workspaceId?: string;
  updatedAt?: number;
}): MacWorkspaceRecord {
  assertNonEmptyString(options.windowId, 'windowId');
  const emptyTab = createEmptyMacTab();
  const pane = createMacWorkspacePane(emptyTab, 1);
  return assertMacWorkspaceRecordBoundary({
    workspaceId: options.workspaceId ?? createId('workspace'),
    windowId: options.windowId,
    paneTree: {
      kind: 'row',
      paneIds: [pane.id],
    },
    panes: [pane],
    activePaneId: pane.id,
    updatedAt: options.updatedAt ?? defaultNow(),
  });
}

function asWorkspaceState(record: MacWorkspaceRecord): WorkspaceState<MacTabRecord> {
  return {
    panes: record.panes,
    activePaneId: record.activePaneId,
  };
}

function normalizePaneTree(
  current: MacPaneTreeRecord | null | undefined,
  panes: MacPaneRecord[],
): MacPaneTreeRecord {
  const paneIds = panes.map((pane) => pane.id);
  const lastSplit = current?.lastSplit && paneIds.includes(current.lastSplit.newPaneId)
    ? current.lastSplit
    : undefined;
  return {
    kind: 'row',
    paneIds,
    ...(lastSplit ? { lastSplit } : {}),
  };
}

function withWorkspaceState(
  record: MacWorkspaceRecord,
  workspace: WorkspaceState<MacTabRecord>,
  options?: {
    updatedAt?: number;
    paneTree?: MacPaneTreeRecord;
  },
): MacWorkspaceRecord {
  const panes = normalizePaneSizes(workspace.panes) as MacPaneRecord[];
  const next: MacWorkspaceRecord = {
    ...record,
    panes,
    activePaneId: panes.some((pane) => pane.id === workspace.activePaneId)
      ? workspace.activePaneId
      : panes[0]?.id ?? '',
    paneTree: normalizePaneTree(options?.paneTree ?? record.paneTree, panes),
    updatedAt: options?.updatedAt ?? defaultNow(),
  };
  return parseMacWorkspaceRecord(next);
}

export function parseMacWorkspaceRecord(input: unknown): MacWorkspaceRecord {
  if (!input || typeof input !== 'object') {
    throw new MacWorkspaceStoreInvalidRecordError('Invalid Mac workspace record: expected object');
  }
  const candidate = input as Partial<MacWorkspaceRecord>;
  assertNonEmptyString(candidate.workspaceId, 'workspaceId');
  assertNonEmptyString(candidate.windowId, 'windowId');
  const workspaceId = candidate.workspaceId;
  const windowId = candidate.windowId;
  if (!Array.isArray(candidate.panes) || candidate.panes.length === 0) {
    throw new MacWorkspaceStoreInvalidRecordError('Invalid Mac workspace record: panes must be a non-empty array');
  }
  assertNonEmptyString(candidate.activePaneId, 'activePaneId');
  const activePaneId = candidate.activePaneId;
  if (!candidate.panes.some((pane) => pane.id === candidate.activePaneId)) {
    throw new MacWorkspaceStoreInvalidRecordError('Invalid Mac workspace record: activePaneId must reference a pane');
  }
  for (const pane of candidate.panes) {
    assertNonEmptyString(pane.id, 'pane.id');
    if (!Array.isArray(pane.tabs) || pane.tabs.length === 0) {
      throw new MacWorkspaceStoreInvalidRecordError('Invalid Mac workspace record: pane.tabs must be non-empty');
    }
    assertNonEmptyString(pane.activeTabId, 'pane.activeTabId');
    if (!pane.tabs.some((tab) => tab.id === pane.activeTabId)) {
      throw new MacWorkspaceStoreInvalidRecordError('Invalid Mac workspace record: pane.activeTabId must reference a tab');
    }
    for (const tab of pane.tabs) {
      assertNonEmptyString(tab.id, 'tab.id');
      assertNonEmptyString(tab.title, 'tab.title');
      if (!['empty', 'remote', 'local-tmux'].includes((tab as MacTabRecord).kind)) {
        throw new MacWorkspaceStoreInvalidRecordError('Invalid Mac workspace record: tab.kind is unsupported');
      }
    }
  }
  const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
    ? candidate.updatedAt
    : defaultNow();
  const normalizedPanes = normalizePaneSizes(candidate.panes as MacPaneRecord[]) as MacPaneRecord[];
  const parsed: MacWorkspaceRecord = {
    workspaceId,
    windowId,
    paneTree: normalizePaneTree(candidate.paneTree, normalizedPanes),
    panes: normalizedPanes,
    activePaneId,
    updatedAt,
  };
  return assertMacWorkspaceRecordBoundary(parsed);
}

export function createMacWorkspaceRecordStorageKey(windowId: string) {
  assertNonEmptyString(windowId, 'windowId');
  return `${MAC_WORKSPACE_STORAGE_PREFIX}${windowId}`;
}

export function createMacWorkspaceStore(
  storage: MacWorkspaceStoreStorage,
  options: CreateMacWorkspaceStoreOptions = {},
): MacWorkspaceStore {
  const clock = options.clock ?? { now: defaultNow };
  return {
    storageKey: createMacWorkspaceRecordStorageKey,
    load(windowId: string) {
      const key = createMacWorkspaceRecordStorageKey(windowId);
      const stored = storage.getItem(key);
      if (!stored) {
        return createInitialMacWorkspaceRecord({ windowId, updatedAt: clock.now() });
      }
      return parseMacWorkspaceRecord(JSON.parse(stored));
    },
    save(record: MacWorkspaceRecord) {
      const parsed = parseMacWorkspaceRecord({
        ...record,
        updatedAt: record.updatedAt || clock.now(),
      });
      storage.setItem(createMacWorkspaceRecordStorageKey(parsed.windowId), JSON.stringify(parsed));
      return parsed;
    },
    update(windowId: string, updater: (record: MacWorkspaceRecord) => MacWorkspaceRecord) {
      const current = this.load(windowId);
      const next = parseMacWorkspaceRecord({
        ...updater(current),
        updatedAt: clock.now(),
      });
      storage.setItem(createMacWorkspaceRecordStorageKey(next.windowId), JSON.stringify(next));
      return next;
    },
    remove(windowId: string) {
      storage.removeItem?.(createMacWorkspaceRecordStorageKey(windowId));
    },
  };
}

export function openMacWorkspaceTab(
  record: MacWorkspaceRecord,
  tab: MacTabRecord,
  options: {
    paneId?: string;
    append?: boolean;
    updatedAt?: number;
  } = {},
): MacWorkspaceRecord {
  const workspace = asWorkspaceState(record);
  const paneId = options.paneId ?? workspace.activePaneId;
  const pane = workspace.panes.find((item) => item.id === paneId) ?? workspace.panes[0];
  if (!pane) {
    return record;
  }
  const replacingEmpty = !options.append && pane.tabs.length === 1 && pane.tabs[0].kind === 'empty';
  const nextWorkspace = updateWorkspacePane(workspace, pane.id, (currentPane) => ({
    ...currentPane,
    tabs: replacingEmpty ? [tab] : [...currentPane.tabs, tab],
    activeTabId: tab.id,
  }));
  return withWorkspaceState(record, setActivePane(nextWorkspace, pane.id), { updatedAt: options.updatedAt });
}

export function splitMacWorkspacePane(
  record: MacWorkspaceRecord,
  options: {
    sourcePaneId?: string;
    direction: MacPaneSplitDirection;
    initialTab?: MacTabRecord;
    updatedAt?: number;
  },
): MacWorkspaceRecord {
  const workspace = asWorkspaceState(record);
  const sourcePaneId = options.sourcePaneId ?? workspace.activePaneId;
  const sourcePane = workspace.panes.find((pane) => pane.id === sourcePaneId);
  if (!sourcePane) {
    return record;
  }
  const newPane = createMacWorkspacePane(options.initialTab ?? createEmptyMacTab(), 1);
  const nextWorkspace = addPaneToWorkspace(setActivePane(workspace, sourcePane.id), newPane);
  const paneTree: MacPaneTreeRecord = normalizePaneTree({
    ...record.paneTree,
    lastSplit: {
      sourcePaneId: sourcePane.id,
      newPaneId: newPane.id,
      direction: options.direction,
    },
  }, nextWorkspace.panes as MacPaneRecord[]);
  return withWorkspaceState(record, nextWorkspace, { paneTree, updatedAt: options.updatedAt });
}

export function activateMacWorkspacePane(
  record: MacWorkspaceRecord,
  paneId: string,
  updatedAt?: number,
): MacWorkspaceRecord {
  return withWorkspaceState(record, setActivePane(asWorkspaceState(record), paneId), { updatedAt });
}

export function activateMacWorkspaceTab(
  record: MacWorkspaceRecord,
  tabId: string,
  updatedAt?: number,
): MacWorkspaceRecord {
  let workspace = asWorkspaceState(record);
  for (const pane of workspace.panes) {
    if (pane.tabs.some((tab) => tab.id === tabId)) {
      workspace = updateWorkspacePane(workspace, pane.id, (currentPane) => ({
        ...currentPane,
        activeTabId: tabId,
      }));
      workspace = setActivePane(workspace, pane.id);
      return withWorkspaceState(record, workspace, { updatedAt });
    }
  }
  return record;
}

export function closeMacWorkspaceTab(
  record: MacWorkspaceRecord,
  tabId: string,
  updatedAt?: number,
): MacWorkspaceRecord {
  const workspace = asWorkspaceState(record);
  for (const pane of workspace.panes) {
    if (!pane.tabs.some((tab) => tab.id === tabId)) {
      continue;
    }
    if (pane.tabs.length === 1) {
      if (workspace.panes.length === 1) {
        const replacement = createMacWorkspacePane(createEmptyMacTab(), 1);
        return withWorkspaceState(record, {
          panes: [replacement],
          activePaneId: replacement.id,
        }, { updatedAt });
      }
      return withWorkspaceState(record, removePaneFromWorkspace(workspace, pane.id), { updatedAt });
    }
    const remaining = pane.tabs.filter((tab) => tab.id !== tabId);
    const activeTabId = pane.activeTabId === tabId
      ? remaining[remaining.length - 1]?.id ?? remaining[0].id
      : pane.activeTabId;
    const next = updateWorkspacePane(workspace, pane.id, (currentPane) => ({
      ...currentPane,
      tabs: remaining,
      activeTabId,
    }));
    return withWorkspaceState(record, next, { updatedAt });
  }
  return record;
}

export function moveMacWorkspaceTab(
  record: MacWorkspaceRecord,
  sourcePaneId: string,
  tabId: string,
  targetPaneId: string,
  updatedAt?: number,
): MacWorkspaceRecord {
  return withWorkspaceState(
    record,
    moveTabBetweenPanes(asWorkspaceState(record), sourcePaneId, tabId, targetPaneId),
    { updatedAt },
  );
}

export function resizeMacWorkspacePanes(
  record: MacWorkspaceRecord,
  sourcePaneId: string,
  targetPaneId: string,
  sourceRatio: number,
  updatedAt?: number,
): MacWorkspaceRecord {
  return withWorkspaceState(
    record,
    resizePaneRatio(asWorkspaceState(record), sourcePaneId, targetPaneId, sourceRatio),
    { updatedAt },
  );
}

export function createMemoryMacWorkspaceStorage(initial?: Record<string, string>): MacWorkspaceStoreStorage & {
  dump(): Record<string, string>;
} {
  const values = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    dump: () => Object.fromEntries(values.entries()),
  };
}
