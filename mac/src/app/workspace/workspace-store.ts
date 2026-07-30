import {
  addPaneToWorkspace,
  createWorkspacePane,
  buildSplitTreeFromPanes,
  closeSplitTreePane,
  createSplitTreeLeaf,
  findSplitTreeLeaf,
  listSplitTreePaneIds,
  moveTabBetweenTreePanes,
  resizeSplitTreeNode,
  splitTreePane,
  type SplitTreeDirection,
  type SplitTreeLeafNode,
  type SplitTreePane,
  type SplitTreeNode,
  type SplitTreePlacement,
  type SplitTreeSplitNode,
  type SplitTreeTab,
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
export type { SplitTreeDirection, SplitTreePlacement };

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

/**
 * Recursive pane tree node. Each leaf wraps a MacPaneRecord (the payload),
 * each split describes how two children are arranged (row = horizontal,
 * column = vertical) and how their width/height is shared.
 */
export type MacPaneTreeNode =
  | { id: string; type: 'leaf'; pane: SplitTreePane<MacTabRecord> }
  | { id: string; type: 'split'; direction: SplitTreeDirection; ratio: number; first: MacPaneTreeNode; second: MacPaneTreeNode };

/**
 * Legacy flat `row + paneIds` shape. Kept only so existing persisted
 * `zterm:mac:workspace:v1:*` records can be upgraded through
 * `parseMacWorkspaceRecord`; production code consumes `paneTreeRoot`.
 */
export interface MacPaneTreeRecord {
  kind: 'row';
  paneIds: string[];
  lastSplit?: {
    sourcePaneId: string;
    newPaneId: string;
    direction: MacPaneSplitDirection;
  };
}

export type MacPaneTree = MacPaneTreeNode;

export interface MacWorkspaceRecord {
  workspaceId: string;
  windowId: string;
  paneTreeRoot: MacPaneTreeNode;
  /**
   * @deprecated kept for legacy `row + paneIds` UI breadcrumbs only;
   * production consumers must read `paneTreeRoot`.
   */
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
  const tree = createSplitTreeLeaf<MacTabRecord>(emptyTab, pane.id);
  return assertMacWorkspaceRecordBoundary({
    workspaceId: options.workspaceId ?? createId('workspace'),
    windowId: options.windowId,
    paneTreeRoot: tree,
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

function projectPaneTreeBreadcrumb(
  tree: MacPaneTreeNode,
  panes: MacPaneRecord[],
  previous: MacPaneTreeRecord | null | undefined,
): MacPaneTreeRecord {
  const paneIds = listSplitTreePaneIds(tree as SplitTreeNode<MacTabRecord>);
  const lastSplit = previous?.lastSplit && paneIds.includes(previous.lastSplit.newPaneId)
    ? previous.lastSplit
    : undefined;
  return {
    kind: 'row',
    paneIds,
    ...(lastSplit ? { lastSplit } : {}),
  };
}

/**
 * Build a split tree from a flat ordered list of panes. Used by the parse
 * path to upgrade legacy `paneTree: { kind: 'row', paneIds }` records into
 * the recursive tree truth on load.
 */
function buildPaneTreeRoot(
  panes: MacPaneRecord[],
  fallbackPaneIds: string[],
  previousTree?: MacPaneTreeNode,
): MacPaneTreeNode {
  if (panes.length === 0) {
    throw new MacWorkspaceStoreInvalidRecordError('Invalid Mac workspace record: at least one pane is required');
  }
  // Reuse previous tree shape if pane ids line up (preserves split ratios).
  if (previousTree) {
    const previousIds = listSplitTreePaneIds(previousTree as SplitTreeNode<MacTabRecord>);
    const currentIds = panes.map((pane) => pane.id);
    if (previousIds.length === currentIds.length && previousIds.every((id, i) => id === currentIds[i])) {
      return previousTree;
    }
  }
  const built = buildSplitTreeFromPanes<MacTabRecord>(
    panes.map((pane) => pane.tabs[0]!).filter((tab): tab is MacTabRecord => Boolean(tab)),
    fallbackPaneIds,
    (index) => panes[index]?.activeTabId ?? panes[index]?.tabs[0]?.id ?? '',
    () => createEmptyMacTab(),
  );
  if (built) {
    return materializeTree(built.tree, panes);
  }
  throw new MacWorkspaceStoreInvalidRecordError(
    'Invalid Mac workspace record: pane tree cannot be built from pane payloads',
  );
}

function withWorkspaceState(
  record: MacWorkspaceRecord,
  workspace: WorkspaceState<MacTabRecord>,
  options?: {
    updatedAt?: number;
    paneTreeRoot?: MacPaneTreeNode;
    paneTree?: MacPaneTreeRecord;
    activePaneIdOverride?: string;
  },
): MacWorkspaceRecord {
  const panes = normalizePaneSizes(workspace.panes) as MacPaneRecord[];
  const paneTreeRoot = options?.paneTreeRoot ?? record.paneTreeRoot;
  const activePaneId = options?.activePaneIdOverride ?? (
    panes.some((pane) => pane.id === workspace.activePaneId)
      ? workspace.activePaneId
      : panes[0]?.id ?? ''
  );
  const next: MacWorkspaceRecord = {
    ...record,
    panes,
    paneTreeRoot,
    activePaneId,
    paneTree: projectPaneTreeBreadcrumb(paneTreeRoot, panes, options?.paneTree ?? record.paneTree),
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
  const fallbackPaneIds = normalizedPanes.map((pane) => pane.id);
  // paneTreeRoot comes from the record (new format) or is built from legacy paneTree
  const paneTreeRoot = buildPaneTreeRoot(normalizedPanes, fallbackPaneIds, candidate.paneTreeRoot);
  const paneIdsInTree = listSplitTreePaneIds(paneTreeRoot as SplitTreeNode<MacTabRecord>);
  if (paneIdsInTree.length !== fallbackPaneIds.length) {
    throw new MacWorkspaceStoreInvalidRecordError('Invalid Mac workspace record: paneTreeRoot leaves do not match panes');
  }
  const parsed: MacWorkspaceRecord = {
    workspaceId,
    windowId,
    paneTreeRoot,
    paneTree: projectPaneTreeBreadcrumb(paneTreeRoot, normalizedPanes, candidate.paneTree),
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
  const initialTab = options.initialTab ?? createEmptyMacTab();
  const newPane = createMacWorkspacePane(initialTab, 1);
  const nextWorkspacePanes = workspace.panes.concat(newPane);
  // Mutate the source pane's leaf to include all existing tabs plus we just leave its tabs intact;
  // the new leaf is created fresh with the initial tab. Build a tree workspace from current tree shape.
  const tree = withNewPaneInserted(record, sourcePaneId, newPane, initialTab, options.direction);
  if (!tree) {
    return record;
  }
  const nextWorkspace = addPaneToWorkspace(setActivePane(workspace, sourcePane.id), newPane);
  const breadcrumb: MacPaneTreeRecord = {
    kind: 'row',
    paneIds: nextWorkspacePanes.map((pane) => pane.id),
    lastSplit: {
      sourcePaneId: sourcePane.id,
      newPaneId: newPane.id,
      direction: options.direction,
    },
  };
  return withWorkspaceState(record, nextWorkspace, {
    paneTreeRoot: tree,
    paneTree: breadcrumb,
    updatedAt: options.updatedAt,
    activePaneIdOverride: newPane.id,
  });
}

function withNewPaneInserted(
  record: MacWorkspaceRecord,
  sourcePaneId: string,
  newPane: MacPaneRecord,
  initialTab: MacTabRecord,
  direction: MacPaneSplitDirection,
): MacPaneTreeNode | null {
  const sourceLeaf = findSplitTreeLeaf(record.paneTreeRoot as SplitTreeNode<MacTabRecord>, sourcePaneId);
  if (!sourceLeaf) return null;
  const placement: SplitTreePlacement = direction === 'down' ? 'down' : 'right';
  // Build a workspace view by hydrating existing leaves from record.panes.
  const hydrated = hydrateWorkspaceFromTree(record.paneTreeRoot, record.panes);
  const result = splitTreePane<MacTabRecord>(
    { tree: hydrated, activePaneId: record.activePaneId },
    sourcePaneId,
    placement,
    initialTab,
    newPane.id,
  );
  return materializeTree(result.tree, record.panes.concat(newPane));
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
        const replacementTree = createSplitTreeLeaf<MacTabRecord>(
          replacement.tabs[0]!,
          replacement.id,
        );
        return withWorkspaceState(record, {
          panes: [replacement],
          activePaneId: replacement.id,
        }, {
          paneTreeRoot: materializeTree(replacementTree, [replacement]),
          activePaneIdOverride: replacement.id,
          updatedAt,
        });
      }
      const nextWorkspace = removePaneFromWorkspace(workspace, pane.id);
      const hydrated = hydrateWorkspaceFromTree(record.paneTreeRoot, record.panes);
      const closed = closeSplitTreePane<MacTabRecord>({ tree: hydrated, activePaneId: record.activePaneId }, pane.id, {
        fallbackPaneId: nextWorkspace.activePaneId,
      });
      return withWorkspaceState(record, nextWorkspace, {
        paneTreeRoot: materializeTree(closed.tree, record.panes.filter((p) => p.id !== pane.id)),
        activePaneIdOverride: nextWorkspace.activePaneId,
        updatedAt,
      });
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
  const sourcePane = record.panes.find((pane) => pane.id === sourcePaneId);
  const tab = sourcePane?.tabs.find((candidate) => candidate.id === tabId);
  if (!sourcePane || !tab) return record;
  const hydrated = hydrateWorkspaceFromTree(record.paneTreeRoot, record.panes);
  const moved = moveTabBetweenTreePanes<MacTabRecord>(
    { tree: hydrated, activePaneId: record.activePaneId },
    sourcePaneId,
    tabId,
    targetPaneId,
    () => createEmptyMacTab().id,
  );
  // Hydrate moved tree with updated panes payload
  const nextWorkspace = moveTabBetweenPanes(asWorkspaceState(record), sourcePaneId, tabId, targetPaneId);
  return withWorkspaceState(record, nextWorkspace, {
    paneTreeRoot: materializeTree(moved.tree, record.panes),
    activePaneIdOverride: moved.activePaneId,
    updatedAt,
  });
}

export function resizeMacWorkspacePanes(
  record: MacWorkspaceRecord,
  splitNodeId: string,
  sourceRatio: number,
  updatedAt?: number,
): MacWorkspaceRecord {
  const hydrated = hydrateWorkspaceFromTree(record.paneTreeRoot, record.panes);
  const resized = resizeSplitTreeNode<MacTabRecord>({ tree: hydrated, activePaneId: record.activePaneId }, splitNodeId, sourceRatio);
  return withWorkspaceState(record, asWorkspaceState(record), {
    paneTreeRoot: materializeTree(resized.tree, record.panes),
    updatedAt,
  });
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

/**
 * Reconstruct a SplitTreeWorkspace view by hydrating every leaf with the
 * matching MacPaneRecord payload (tabs + activeTabId). The pane tree keeps
 * structure while tabs live in the leaf payload.
 */
function hydrateWorkspaceFromTree(
  tree: MacPaneTreeNode,
  panes: MacPaneRecord[],
): SplitTreeNode<MacTabRecord> {
  const paneById = new Map(panes.map((pane) => [pane.id, pane]));
  function walk(node: MacPaneTreeNode): SplitTreeNode<MacTabRecord> {
    if (node.type === 'leaf') {
      const payload = paneById.get(node.pane.id);
      if (!payload) {
        throw new MacWorkspaceStoreInvalidRecordError(
          `Mac workspace record: tree leaf pane ${node.pane.id} is missing from panes`,
        );
      }
      return {
        id: node.id,
        type: 'leaf',
        pane: {
          id: payload.id,
          tabs: payload.tabs,
          activeTabId: payload.activeTabId,
        },
      } as SplitTreeLeafNode<MacTabRecord>;
    }
    return {
      id: node.id,
      type: 'split',
      direction: node.direction,
      ratio: node.ratio,
      first: walk(node.first),
      second: walk(node.second),
    } as SplitTreeSplitNode<MacTabRecord>;
  }
  return walk(tree);
}

/**
 * Strip leaf tab payloads and keep only pane ids. The split tree is then
 * paired with the next panes[] payload as authoritative tab source.
 */
function materializeTree(
  tree: SplitTreeNode<MacTabRecord>,
  panes: MacPaneRecord[],
): MacPaneTreeNode {
  const paneById = new Map(panes.map((pane) => [pane.id, pane]));
  function walk(node: SplitTreeNode<MacTabRecord>): MacPaneTreeNode {
    if (node.type === 'leaf') {
      const payload = paneById.get(node.pane.id);
      if (!payload) {
        throw new MacWorkspaceStoreInvalidRecordError(
          `Mac workspace record: tree leaf pane ${node.pane.id} is missing from panes`,
        );
      }
      return {
        id: node.id,
        type: 'leaf',
        pane: {
          id: payload.id,
          tabs: payload.tabs,
          activeTabId: payload.activeTabId,
        },
      };
    }
    return {
      id: node.id,
      type: 'split',
      direction: node.direction,
      ratio: node.ratio,
      first: walk(node.first),
      second: walk(node.second),
    };
  }
  return walk(tree);
}
