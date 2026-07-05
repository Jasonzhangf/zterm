import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type MainlineEdge = {
  edge_id: string;
  from: string;
  to: string;
  owner_feature: string;
  caller: string;
  callee: string;
  semantic_input: string;
  semantic_output: string;
  status: 'anchored' | 'binding pending';
  verification_gates: string[];
};

type MainlineLifecycle = {
  lifecycle_id: string;
  nodes: Array<{
    id: string;
    owner_feature: string;
    entrypoint: string;
    status: 'anchored' | 'binding pending';
  }>;
  edges: MainlineEdge[];
};

type MainlineCallMap = {
  schema_version: number;
  lifecycles: MainlineLifecycle[];
};

const REQUIRED_FEATURE_IDS = [
  'mac.entrypoint',
  'mac.window_lifecycle',
  'mac.workspace_store',
  'mac.runtime_registry',
  'mac.local_tmux_provider',
  'mac.server_directory',
  'mac.quick_connect',
  'mac.terminal_pane',
  'mac.file_browser_core',
  'mac.file_browser_ui',
  'mac.platform_fs',
  'mac.legacy_cleanup',
];

const REQUIRED_NODE_IDS = [
  'MAC-00-AppEntry',
  'MAC-01-DesktopBootstrap',
  'MAC-02-WindowRecord',
  'MAC-03-WorkspaceLoad',
  'MAC-04-WorkspaceShell',
  'MAC-05-ServerDirectory',
  'MAC-17-ServerLiveRefresh',
  'MAC-06-OpenTabIntent',
  'MAC-19-QuickConnectDiscovery',
  'MAC-20-QuickConnectOpen',
  'MAC-07-PaneTreeUpdate',
  'MAC-08-RuntimeEnsure',
  'MAC-18-LocalTmuxProvider',
  'MAC-09-RuntimeActivity',
  'MAC-10-TerminalProjection',
  'MAC-11-Renderer',
  'MAC-12-FileBrowserOpen',
  'MAC-13-FileProviderRead',
  'MAC-14-FilePreview',
  'MAC-15-WindowRestore',
  'MAC-16-LegacyRemoval',
];

const REQUIRED_EDGES: Array<[string, string]> = [
  ['MAC-00-AppEntry', 'MAC-01-DesktopBootstrap'],
  ['MAC-01-DesktopBootstrap', 'MAC-02-WindowRecord'],
  ['MAC-02-WindowRecord', 'MAC-03-WorkspaceLoad'],
  ['MAC-03-WorkspaceLoad', 'MAC-04-WorkspaceShell'],
  ['MAC-05-ServerDirectory', 'MAC-06-OpenTabIntent'],
  ['MAC-05-ServerDirectory', 'MAC-17-ServerLiveRefresh'],
  ['MAC-17-ServerLiveRefresh', 'MAC-05-ServerDirectory'],
  ['MAC-06-OpenTabIntent', 'MAC-03-WorkspaceLoad'],
  ['MAC-04-WorkspaceShell', 'MAC-19-QuickConnectDiscovery'],
  ['MAC-19-QuickConnectDiscovery', 'MAC-20-QuickConnectOpen'],
  ['MAC-20-QuickConnectOpen', 'MAC-03-WorkspaceLoad'],
  ['MAC-03-WorkspaceLoad', 'MAC-07-PaneTreeUpdate'],
  ['MAC-03-WorkspaceLoad', 'MAC-08-RuntimeEnsure'],
  ['MAC-08-RuntimeEnsure', 'MAC-18-LocalTmuxProvider'],
  ['MAC-18-LocalTmuxProvider', 'MAC-09-RuntimeActivity'],
  ['MAC-08-RuntimeEnsure', 'MAC-09-RuntimeActivity'],
  ['MAC-09-RuntimeActivity', 'MAC-10-TerminalProjection'],
  ['MAC-10-TerminalProjection', 'MAC-11-Renderer'],
  ['MAC-04-WorkspaceShell', 'MAC-12-FileBrowserOpen'],
  ['MAC-12-FileBrowserOpen', 'MAC-13-FileProviderRead'],
  ['MAC-13-FileProviderRead', 'MAC-14-FilePreview'],
  ['MAC-02-WindowRecord', 'MAC-15-WindowRestore'],
  ['MAC-16-LegacyRemoval', 'MAC-04-WorkspaceShell'],
];

function resolveMacRoot() {
  const candidates = [
    process.cwd(),
    path.join(process.cwd(), 'mac'),
    path.resolve(process.cwd(), '..', 'mac'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'src', 'App.tsx')));
  if (!found) {
    throw new Error(`Unable to resolve mac root from ${process.cwd()}`);
  }
  return found;
}

const macRoot = resolveMacRoot();
const repoRoot = path.dirname(macRoot);

function readMac(relativePath: string) {
  return fs.readFileSync(path.join(macRoot, relativePath), 'utf8');
}

function readRepo(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function listFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listFiles(entryPath);
    }
    return [entryPath];
  });
}

function parseMainlineCallMap(): MainlineCallMap {
  return JSON.parse(readMac(path.join('docs', 'mainline-call-map.json'))) as MainlineCallMap;
}

describe('Mac architecture truth', () => {
  it('keeps App on the MacDesktopApp production entrypoint', () => {
    const appSource = readMac(path.join('src', 'App.tsx'));

    expect(appSource).toContain("import { MacDesktopApp } from './app/MacDesktopApp';");
    expect(appSource).toContain('<MacDesktopApp />');
    expect(appSource).not.toContain('ShellWorkspace');
  });

  it('keeps current Mac docs aligned with the production entrypoint truth', () => {
    const spec = readMac(path.join('docs', 'spec.md'));
    const architecture = readMac(path.join('docs', 'architecture.md'));
    const desktopPlan = readMac(path.join('docs', 'desktop-workspace-plan.md'));
    const docs = [spec, architecture, desktopPlan].join('\n');

    expect(docs).not.toContain('App.tsx` still renders `ShellWorkspace`');
    expect(docs).not.toContain('Production renderer entrypoint: `App -> ShellWorkspace`');
    expect(docs).toContain('`mac/src/App.tsx` renders `MacDesktopApp`');
    expect(docs).toContain('Production renderer entrypoint: `App -> MacDesktopApp -> MacAppShell`');
  });

  it('exposes the required Mac function owners before deeper refactors', () => {
    const functionMap = readMac(path.join('docs', 'function-map.md'));

    for (const featureId of REQUIRED_FEATURE_IDS) {
      expect(functionMap).toContain(`\`${featureId}\``);
    }

    expect(functionMap).toContain('binding pending');
    expect(functionMap).toContain('MacRuntimeRegistry');
    expect(functionMap).toContain('FileBrowserCore');
  });

  it('keeps the mainline call map parseable and aligned to required node IDs', () => {
    const callMap = parseMainlineCallMap();
    const lifecycle = callMap.lifecycles.find((item) => item.lifecycle_id === 'mac_desktop_mainline');

    expect(callMap.schema_version).toBe(1);
    expect(lifecycle).toBeTruthy();

    const nodes = new Set(lifecycle?.nodes.map((node) => node.id));
    for (const nodeId of REQUIRED_NODE_IDS) {
      expect(nodes.has(nodeId)).toBe(true);
    }
  });

  it('keeps mainline edges adjacent and queryable', () => {
    const callMap = parseMainlineCallMap();
    const lifecycle = callMap.lifecycles.find((item) => item.lifecycle_id === 'mac_desktop_mainline');
    expect(lifecycle).toBeTruthy();
    if (!lifecycle) return;

    const nodeIds = new Set(lifecycle.nodes.map((node) => node.id));
    const edgePairs = new Set(lifecycle.edges.map((edge) => `${edge.from}->${edge.to}`));

    for (const [from, to] of REQUIRED_EDGES) {
      expect(edgePairs.has(`${from}->${to}`)).toBe(true);
    }

    for (const edge of lifecycle.edges) {
      expect(edge.edge_id).toMatch(/^MAC-EDGE-\d{4}$/);
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
      expect(REQUIRED_FEATURE_IDS).toContain(edge.owner_feature);
      expect(edge.caller.trim().length).toBeGreaterThan(0);
      expect(edge.callee.trim().length).toBeGreaterThan(0);
      expect(edge.semantic_input.trim().length).toBeGreaterThan(0);
      expect(edge.semantic_output.trim().length).toBeGreaterThan(0);
      expect(['anchored', 'binding pending', 'anchored smoke-only']).toContain(edge.status);
      expect(edge.verification_gates.length).toBeGreaterThan(0);
    }
  });

  it('keeps the goal plan available as the slice execution contract', () => {
    const goalPlan = readRepo(path.join('docs', 'goals', 'mac-desktop-workspace-refactor-plan.md'));

    expect(goalPlan).toContain('Slice 0: Docs And Gates');
    expect(goalPlan).toContain('MacRuntimeRegistry');
    expect(goalPlan).toContain('MacFileBrowser');
  });

  it('keeps alpha readiness tracked as an explicit non-alpha truth source', () => {
    const architecture = readMac(path.join('docs', 'architecture.md'));
    const taskBoard = readMac('task.md');
    const skill = readRepo(path.join('.agents', 'skills', 'zterm-mac-dev', 'SKILL.md'));
    const readiness = readMac(path.join('docs', 'alpha-readiness.md'));
    const functionMap = readMac(path.join('docs', 'function-map.md'));
    const testDesign = readMac(path.join('docs', 'testing', 'mac-desktop-workspace-test-design.md'));
    const alphaSmoke = readMac(path.join('scripts', 'alpha-p0-packaged-smoke.mjs'));
    const packageJson = JSON.parse(readMac('package.json')) as { scripts?: Record<string, string> };

    expect(architecture).toContain('mac/docs/alpha-readiness.md');
    expect(taskBoard).toContain('Alpha readiness');
    expect(skill).toContain('状态 / Alpha 汇报对账门禁');
    expect(readiness).toContain('Current verdict: ready for Jason internal alpha as an unsigned local package.');
    expect(readiness).toContain('P0 blockers before Jason alpha');
    expect(readiness).toContain('None for Jason internal alpha using the current unsigned local package.');
    expect(readiness).toContain('Remote server rail open');
    expect(readiness).toContain('server-rail-remote-open-final2');
    expect(readiness).toContain('T-A4');
    expect(readiness).toContain('buffer-gate-all-t-a4-final');
    expect(readiness).toContain('large-reading');
    expect(readiness).toContain('T-A5');
    expect(readiness).toContain('disconnect-reconnect-final2');
    expect(readiness).toContain('transport-owner close surfaces explicit `error`');
    expect(readiness).toContain('Alpha package handoff');
    expect(readiness).toContain('mac/docs/alpha-handoff.md');
    expect(readiness).toContain('Evidence retention');
    expect(readiness).toContain('Internal alpha handoff requires');
    expect(packageJson.scripts?.['blackbox:terminal-buffer']).toBe('node scripts/terminal-buffer-blackbox-gate.mjs');
    expect(packageJson.scripts?.['smoke:alpha-p0']).toBe('node scripts/alpha-p0-packaged-smoke.mjs');
    expect(fs.existsSync(path.join(macRoot, 'scripts', 'terminal-buffer-blackbox-gate.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(macRoot, 'scripts', 'alpha-p0-packaged-smoke.mjs'))).toBe(true);
    expect(taskBoard).toContain('blackbox:terminal-buffer');
    expect(taskBoard).toContain('smoke:alpha-p0');
    expect(skill).toContain('session truth');
    expect(readiness).toContain('terminal buffer black-box gate');
    expect(readiness).toContain('header-restore-final2');
    expect(functionMap).toContain('blackbox:terminal-buffer');
    expect(functionMap).toContain('smoke:alpha-p0');
    expect(testDesign).toContain('Terminal buffer black-box');
    expect(testDesign).toContain('header-restore');
    expect(testDesign).toContain('server-rail-remote-open');
    expect(testDesign).toContain('disconnect-reconnect');
    expect(testDesign).toContain('active runtime connect count is `2`');
    expect(alphaSmoke).toContain("server-rail-remote-open");
    expect(alphaSmoke).toContain("runServerRailRemoteOpenCase");
    expect(alphaSmoke).toContain("disconnect-reconnect");
    expect(alphaSmoke).toContain("runDisconnectReconnectCase");
    expect(functionMap).toContain('MAC-CALL-RUNTIME-004');
    expect(functionMap).toContain('MAC-CALL-LOCAL-TMUX-004');
  });

  it('anchors MacWorkspaceStore before workspace integration slices', () => {
    const functionMap = readMac(path.join('docs', 'function-map.md'));
    const workspaceStoreSource = readMac(path.join('src', 'app', 'workspace', 'workspace-store.ts'));
    const workbenchSource = readMac(path.join('src', 'app', 'workbench.ts'));
    const callMap = parseMainlineCallMap();
    const lifecycle = callMap.lifecycles.find((item) => item.lifecycle_id === 'mac_desktop_mainline');
    expect(lifecycle).toBeTruthy();
    if (!lifecycle) return;

    const workspaceNode = lifecycle.nodes.find((node) => node.id === 'MAC-03-WorkspaceLoad');
    const paneTreeNode = lifecycle.nodes.find((node) => node.id === 'MAC-07-PaneTreeUpdate');
    const paneTreeEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0008');

    expect(workspaceStoreSource).toContain('export interface MacWorkspaceRecord');
    expect(workspaceStoreSource).toContain('export interface MacTabRecord');
    expect(workspaceStoreSource).toContain('export type MacPaneTree');
    expect(workspaceStoreSource).toContain('export function createMacWorkspaceStore');
    expect(workspaceStoreSource).toContain('export function splitMacWorkspacePane');
    expect(workspaceStoreSource).toContain('export function moveMacWorkspaceTab');
    expect(workspaceStoreSource).toContain('export function resizeMacWorkspacePanes');
    expect(workbenchSource.trim()).toBe("export * from './workspace/workbench-model';");
    expect(functionMap).toContain('`mac.workspace_store` | `MacWorkspaceStore`, `MacPaneTree`, `splitMacWorkspacePane`');
    expect(workspaceNode?.status).toBe('anchored');
    expect(paneTreeNode?.status).toBe('anchored');
    expect(paneTreeEdge?.status).toBe('anchored');
    expect(paneTreeEdge?.verification_gates).toContain('mac/src/app/workspace/workspace-store.test.ts');
  });

  it('keeps workspace records free of runtime-owned state fields', () => {
    const workspaceStoreSource = readMac(path.join('src', 'app', 'workspace', 'workspace-store.ts'));
    const forbiddenFields = [
      'runtimeState',
      'transportState',
      'bufferState',
      'renderProjection',
      'terminalRuntime',
      'connectionState',
    ];

    for (const field of forbiddenFields) {
      expect(workspaceStoreSource).not.toMatch(new RegExp(`${field}[?]?:`));
    }

    expect(workspaceStoreSource).toContain('FORBIDDEN_WORKSPACE_RECORD_KEYS');
    expect(workspaceStoreSource).toContain('assertMacWorkspaceRecordBoundary');
  });

  it('anchors MacRuntimeRegistry as the only current production runtime owner', () => {
    const functionMap = readMac(path.join('docs', 'function-map.md'));
    const registrySource = readMac(path.join('src', 'app', 'runtime', 'MacRuntimeRegistry.ts'));
    const appShellSource = readMac(path.join('src', 'app', 'MacAppShell.tsx'));
    const paneWorkbenchSource = readMac(path.join('src', 'app', 'MacPaneWorkbench.tsx'));
    const callMap = parseMainlineCallMap();
    const lifecycle = callMap.lifecycles.find((item) => item.lifecycle_id === 'mac_desktop_mainline');
    expect(lifecycle).toBeTruthy();
    if (!lifecycle) return;

    const runtimeEnsureNode = lifecycle.nodes.find((node) => node.id === 'MAC-08-RuntimeEnsure');
    const runtimeActivityNode = lifecycle.nodes.find((node) => node.id === 'MAC-09-RuntimeActivity');
    const runtimeEnsureEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0009');
    const runtimeActivityEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0010');
    const terminalProjectionEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0011');
    const reconnectNode = lifecycle.nodes.find((node) => node.id === 'MAC-21-ReconnectRecovery');
    const reconnectIntentEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0025');
    const reconnectConnectEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0026');

    expect(registrySource).toContain('export interface MacRuntimeRegistry');
    expect(registrySource).toContain('export function createMacRuntimeRegistry');
    expect(registrySource).toContain('ensureRuntime(target');
    expect(registrySource).toContain('createTerminalRuntime');
    expect(registrySource).toContain('setActiveRuntimeKey');
    expect(registrySource).toContain('releaseRuntime');
    expect(appShellSource).toContain('createMacRuntimeRegistry');
    expect(appShellSource).not.toContain('createTerminalRuntime');
    expect(appShellSource).not.toContain('useTerminalRuntimeState');
    expect(paneWorkbenchSource).toContain('useMacRuntimeState');
    expect(paneWorkbenchSource).not.toContain('.connectRemote');
    expect(paneWorkbenchSource).not.toContain('.connectLocalTmux');
    expect(functionMap).toContain('`mac.runtime_registry` | `MacRuntimeRegistry`, `createMacRuntimeRegistry`, `useMacRuntimeState`');
    expect(functionMap).toContain('MAC-CALL-RUNTIME-004');
    expect(runtimeEnsureNode?.status).toBe('anchored');
    expect(runtimeActivityNode?.status).toBe('anchored');
    expect(reconnectNode?.status).toBe('anchored');
    expect(runtimeEnsureEdge?.status).toBe('anchored');
    expect(runtimeActivityEdge?.status).toBe('anchored');
    expect(terminalProjectionEdge?.status).toBe('anchored');
    expect(reconnectIntentEdge?.status).toBe('anchored');
    expect(reconnectConnectEdge?.status).toBe('anchored');
    expect(runtimeEnsureEdge?.verification_gates).toContain('mac/src/app/runtime/MacRuntimeRegistry.test.ts');
    expect(runtimeEnsureEdge?.verification_gates).toContain(
      'pnpm --dir mac run smoke:alpha-p0 -- --case=header-restore',
    );
    expect(runtimeActivityEdge?.verification_gates).toContain(
      'pnpm --dir mac run smoke:alpha-p0 -- --case=header-restore',
    );
    expect(terminalProjectionEdge?.verification_gates).toContain(
      'pnpm --dir mac run smoke:alpha-p0 -- --case=header-restore',
    );
    expect(reconnectIntentEdge?.verification_gates).toContain(
      'pnpm --dir mac run smoke:alpha-p0 -- --case=disconnect-reconnect',
    );
    expect(reconnectConnectEdge?.verification_gates).toContain(
      'pnpm --dir mac run smoke:alpha-p0 -- --case=disconnect-reconnect',
    );
  });

  it('keeps local tmux provider capture aligned with session truth', () => {
    const functionMap = readMac(path.join('docs', 'function-map.md'));
    const testDesign = readMac(path.join('docs', 'testing', 'mac-desktop-workspace-test-design.md'));
    const localTmuxSource = readMac(path.join('electron', 'local-tmux.ts'));
    const callMap = parseMainlineCallMap();
    const lifecycle = callMap.lifecycles.find((item) => item.lifecycle_id === 'mac_desktop_mainline');
    expect(lifecycle).toBeTruthy();
    if (!lifecycle) return;

    const localTmuxNode = lifecycle.nodes.find((node) => node.id === 'MAC-18-LocalTmuxProvider');
    const localTmuxRequestEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0020');
    const localTmuxReturnEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0021');
    const localTmuxSmokeCloseNode = lifecycle.nodes.find((node) => node.id === 'MAC-22-LocalTmuxSmokeClose');
    const localTmuxSmokeCloseEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0027');

    expect(functionMap).toContain('`mac.local_tmux_provider` | `LocalTmuxManager`, `readSessionCapture`, `captureToBufferPayload`, `forceCloseForSmoke`');
    expect(functionMap).toContain('MAC-CALL-LOCAL-TMUX-004');
    expect(localTmuxSource).toContain('#{alternate_on}');
    expect(localTmuxSource).toContain('forceCloseForSmoke');
    expect(localTmuxSource).toContain("options?.visibleOnly || alternateOn ? `-${paneRows}` : `-${historySize}`");
    expect(localTmuxSource).toContain("['capture-pane', '-e', '-p', '-t', target, '-S', captureStart]");
    expect(localTmuxSource).not.toContain("'-E', '-1'");
    expect(localTmuxSource).not.toContain('"-E", "-1"');
    expect(testDesign).toContain('Canonical tmux capture must include visible pane bottom');
    expect(testDesign).toContain('alternate screen capture uses bounded visible current screen truth');
    expect(localTmuxNode?.status).toBe('anchored');
    expect(localTmuxRequestEdge?.status).toBe('anchored');
    expect(localTmuxReturnEdge?.status).toBe('anchored');
    expect(localTmuxSmokeCloseNode?.status).toBe('anchored smoke-only');
    expect(localTmuxSmokeCloseEdge?.status).toBe('anchored smoke-only');
    expect(localTmuxRequestEdge?.verification_gates).toContain('mac/src/lib/local-tmux-transport.test.ts');
    expect(localTmuxReturnEdge?.verification_gates).toContain('pnpm --dir mac run blackbox:terminal-buffer -- --case=all');
    expect(localTmuxSmokeCloseEdge?.verification_gates).toContain(
      'pnpm --dir mac run smoke:alpha-p0 -- --case=disconnect-reconnect',
    );
  });

  it('anchors MacServerDirectory as projection-only server rail owner', () => {
    const functionMap = readMac(path.join('docs', 'function-map.md'));
    const serverDirectorySource = readMac(path.join('src', 'app', 'server-directory', 'MacServerDirectory.ts'));
    const railSource = readMac(path.join('src', 'app', 'server-directory', 'MacServerDirectoryRail.tsx'));
    const appShellSource = readMac(path.join('src', 'app', 'MacAppShell.tsx'));
    const callMap = parseMainlineCallMap();
    const lifecycle = callMap.lifecycles.find((item) => item.lifecycle_id === 'mac_desktop_mainline');
    expect(lifecycle).toBeTruthy();
    if (!lifecycle) return;

    const serverNode = lifecycle.nodes.find((node) => node.id === 'MAC-05-ServerDirectory');
    const openTabNode = lifecycle.nodes.find((node) => node.id === 'MAC-06-OpenTabIntent');
    const serverOpenEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0006');
    const openWorkspaceEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0007');

    const serverRefreshNode = lifecycle.nodes.find((node) => node.id === 'MAC-17-ServerLiveRefresh');
    const serverRefreshRequestEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0018');
    const serverRefreshProjectEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0019');

    expect(serverDirectorySource).toContain('export function projectMacServerDirectory');
    expect(serverDirectorySource).toContain('export async function fetchMacServerDirectoryLiveSessionSnapshot');
    expect(serverDirectorySource).toContain('export function resolveMacServerDirectoryOpenIntent');
    expect(serverDirectorySource).not.toContain('openConnectionInWorkbench');
    expect(serverDirectorySource).not.toContain('createMacRuntimeRegistry');
    expect(serverDirectorySource).not.toContain('TerminalRuntimeController');
    expect(railSource).toContain('export function MacServerDirectoryRail');
    expect(railSource).toContain('onRefreshServer');
    expect(appShellSource).toContain('projectMacServerDirectory');
    expect(appShellSource).toContain('fetchMacServerDirectoryLiveSessionSnapshot');
    expect(appShellSource).toContain('MacServerDirectoryRail');
    expect(functionMap).toContain('`mac.server_directory` | `MacServerDirectory`, `projectMacServerDirectory`, `fetchMacServerDirectoryLiveSessionSnapshot`, `MacServerDirectoryRail`');
    expect(serverNode?.status).toBe('anchored');
    expect(serverRefreshNode?.status).toBe('anchored');
    expect(openTabNode?.status).toBe('anchored');
    expect(serverOpenEdge?.status).toBe('anchored');
    expect(serverRefreshRequestEdge?.status).toBe('anchored');
    expect(serverRefreshProjectEdge?.status).toBe('anchored');
    expect(openWorkspaceEdge?.status).toBe('anchored');
    expect(serverOpenEdge?.verification_gates).toContain('mac/src/app/server-directory/MacServerDirectory.test.ts');
    expect(serverOpenEdge?.verification_gates).toContain(
      'pnpm --dir mac run smoke:alpha-p0 -- --case=server-rail-remote-open',
    );
    expect(openWorkspaceEdge?.verification_gates).toContain(
      'pnpm --dir mac run smoke:alpha-p0 -- --case=server-rail-remote-open',
    );
    expect(serverRefreshRequestEdge?.verification_gates).toContain('mac/src/app/MacAppShell.layout.test.tsx');
  });

  it('anchors QuickConnect discovery as explicit launcher-owned open flow', () => {
    const functionMap = readMac(path.join('docs', 'function-map.md'));
    const testDesign = readMac(path.join('docs', 'testing', 'mac-desktop-workspace-test-design.md'));
    const launcherSource = readMac(path.join('src', 'components', 'ConnectionLauncher.tsx'));
    const appShellSource = readMac(path.join('src', 'app', 'MacAppShell.tsx'));
    const callMap = parseMainlineCallMap();
    const lifecycle = callMap.lifecycles.find((item) => item.lifecycle_id === 'mac_desktop_mainline');
    expect(lifecycle).toBeTruthy();
    if (!lifecycle) return;

    const discoveryNode = lifecycle.nodes.find((node) => node.id === 'MAC-19-QuickConnectDiscovery');
    const openNode = lifecycle.nodes.find((node) => node.id === 'MAC-20-QuickConnectOpen');
    const discoveryEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0022');
    const openEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0023');
    const workspaceEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0024');

    expect(functionMap).toContain('`mac.quick_connect` | `ConnectionLauncher`');
    expect(testDesign).toContain('MAC-19-QuickConnectDiscovery');
    expect(launcherSource).toContain('sessionFetcher = fetchTmuxSessions');
    expect(launcherSource).toContain('Discover sessions');
    expect(launcherSource).not.toContain('openConnectionInWorkbench');
    expect(launcherSource).not.toContain('createMacRuntimeRegistry');
    expect(appShellSource).toContain('onSaveDraft={handleSaveDraft}');
    expect(discoveryNode?.status).toBe('anchored');
    expect(openNode?.status).toBe('anchored');
    expect(discoveryEdge?.status).toBe('anchored');
    expect(openEdge?.status).toBe('anchored');
    expect(workspaceEdge?.status).toBe('anchored');
    expect(discoveryEdge?.verification_gates).toContain('mac/src/components/ConnectionLauncher.test.tsx');
    expect(workspaceEdge?.verification_gates).toContain('packaged QuickConnect/session discovery smoke');
  });

  it('anchors MacWindowManager as BrowserWindow and renderer windowId owner', () => {
    const functionMap = readMac(path.join('docs', 'function-map.md'));
    const windowManagerSource = readMac(path.join('..', 'mac', 'electron', 'window-manager.ts'));
    const electronMainSource = readMac(path.join('..', 'mac', 'electron', 'main.ts'));
    const desktopAppSource = readMac(path.join('src', 'app', 'MacDesktopApp.tsx'));
    const appShellSource = readMac(path.join('src', 'app', 'MacAppShell.tsx'));
    const callMap = parseMainlineCallMap();
    const lifecycle = callMap.lifecycles.find((item) => item.lifecycle_id === 'mac_desktop_mainline');
    expect(lifecycle).toBeTruthy();
    if (!lifecycle) return;

    const windowNode = lifecycle.nodes.find((node) => node.id === 'MAC-02-WindowRecord');
    const restoreNode = lifecycle.nodes.find((node) => node.id === 'MAC-15-WindowRestore');
    const windowEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0002');
    const workspaceLoadEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0003');
    const windowRestoreEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0016');

    expect(windowManagerSource).toContain('export function createMacWindowManager');
    expect(windowManagerSource).toContain('export function createFileMacWindowRecordStore');
    expect(windowManagerSource).toContain('export function createMacWindowMenuTemplate');
    expect(windowManagerSource).toContain('restoreWindows()');
    expect(windowManagerSource).toContain('prepareForQuit()');
    expect(windowManagerSource).toContain('buildMacRendererLoadTarget');
    expect(windowManagerSource).toContain("query: { windowId: options.windowId }");
    expect(electronMainSource).toContain('createMacWindowManager');
    expect(electronMainSource).toContain('createMacWindowMenuTemplate');
    expect(electronMainSource).toContain('createFileMacWindowRecordStore');
    expect(electronMainSource).toContain('restoreWindows');
    expect(desktopAppSource).toContain('resolveMacRendererWindowId');
    expect(desktopAppSource).toContain('windowId={windowId}');
    expect(appShellSource).toContain('createMacWorkspaceStore');
    expect(appShellSource).toContain('createWorkspaceRecordFromWorkbenchState');
    expect(functionMap).toContain('`mac.window_lifecycle` | `MacWindowManager`, `createMacWindowManager`, `createMacWindowMenuTemplate`, `createFileMacWindowRecordStore`');
    expect(windowNode?.status).toBe('anchored');
    expect(restoreNode?.status).toBe('anchored');
    expect(windowEdge?.status).toBe('anchored');
    expect(workspaceLoadEdge?.status).toBe('anchored');
    expect(windowRestoreEdge?.status).toBe('anchored');
    expect(windowEdge?.verification_gates).toContain('mac/src/electron/window-manager.test.ts');
    expect(workspaceLoadEdge?.verification_gates).toContain(
      'pnpm --dir mac run smoke:alpha-p0 -- --case=header-restore',
    );
  });

  it('anchors the file browser branch with shared policy, platform IO, and UI projection owners', () => {
    const functionMap = readMac(path.join('docs', 'function-map.md'));
    const fileBrowserCoreSource = readRepo(path.join('packages', 'shared', 'src', 'files', 'file-browser-core.ts'));
    const electronFileSystemSource = readMac(path.join('electron', 'file-system.ts'));
    const appShellSource = readMac(path.join('src', 'app', 'MacAppShell.tsx'));
    const fileBrowserPanelSource = readMac(path.join('src', 'app', 'file-browser', 'MacFileBrowserPanel.tsx'));
    const callMap = parseMainlineCallMap();
    const lifecycle = callMap.lifecycles.find((item) => item.lifecycle_id === 'mac_desktop_mainline');
    expect(lifecycle).toBeTruthy();
    if (!lifecycle) return;

    const fileOpenNode = lifecycle.nodes.find((node) => node.id === 'MAC-12-FileBrowserOpen');
    const fileProviderNode = lifecycle.nodes.find((node) => node.id === 'MAC-13-FileProviderRead');
    const filePreviewNode = lifecycle.nodes.find((node) => node.id === 'MAC-14-FilePreview');
    const fileOpenEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0013');
    const fileProviderEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0014');
    const filePreviewEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0015');

    expect(fileBrowserCoreSource).toContain('export function normalizeFileBrowserPath');
    expect(fileBrowserCoreSource).toContain('export function decideFileBrowserPreview');
    expect(fileBrowserCoreSource).not.toMatch(/from ['"]react['"]/);
    expect(fileBrowserCoreSource).not.toMatch(/from ['"]electron['"]/);
    expect(fileBrowserCoreSource).not.toContain('TerminalRuntime');
    expect(fileBrowserCoreSource).not.toContain('ztermMac');
    expect(electronFileSystemSource).toContain('export function createMacLocalFileSystemService');
    expect(electronFileSystemSource).toContain('export function registerMacFileSystemIpcHandlers');
    expect(electronFileSystemSource).not.toContain('decideFileBrowserPreview');
    expect(electronFileSystemSource).not.toMatch(/binary|large text|text preview/i);
    expect(appShellSource).toContain('MacFileBrowserPanel');
    expect(fileBrowserPanelSource).toContain('projectFileBrowserDirectoryResult');
    expect(fileBrowserPanelSource).toContain('decideFileBrowserPreview');
    expect(fileBrowserPanelSource).not.toContain('.connectRemote');
    expect(fileBrowserPanelSource).not.toContain('.connectLocalTmux');
    expect(fileBrowserPanelSource).not.toContain('createMacRuntimeRegistry');
    expect(fileBrowserPanelSource).not.toContain('TerminalRuntimeController');
    expect(functionMap).toContain('`mac.file_browser_core` | `FileBrowserCore` policy functions');
    expect(functionMap).toContain('`mac.file_browser_ui` | `MacFileBrowserPanel`');
    expect(functionMap).toContain('`mac.platform_fs` | `createMacLocalFileSystemService`, `registerMacFileSystemIpcHandlers`');
    expect(fileOpenNode?.status).toBe('anchored');
    expect(fileProviderNode?.status).toBe('anchored');
    expect(filePreviewNode?.status).toBe('anchored');
    expect(fileOpenEdge?.status).toBe('anchored');
    expect(fileProviderEdge?.status).toBe('anchored');
    expect(filePreviewEdge?.status).toBe('anchored');
    expect(fileProviderEdge?.verification_gates).toContain('mac/src/electron/file-system.test.ts');
    expect(filePreviewEdge?.verification_gates).toContain('packages/shared/src/files/file-browser-core.test.ts');
  });

  it('hard-gates legacy ShellWorkspace source removal after replacement coverage', () => {
    const functionMap = readMac(path.join('docs', 'function-map.md'));
    const testDesign = readMac(path.join('docs', 'testing', 'mac-desktop-workspace-test-design.md'));
    const callMap = parseMainlineCallMap();
    const lifecycle = callMap.lifecycles.find((item) => item.lifecycle_id === 'mac_desktop_mainline');
    expect(lifecycle).toBeTruthy();
    if (!lifecycle) return;

    const legacyNode = lifecycle.nodes.find((node) => node.id === 'MAC-16-LegacyRemoval');
    const legacyEdge = lifecycle.edges.find((edge) => edge.edge_id === 'MAC-EDGE-0017');

    expect(fs.existsSync(path.join(macRoot, 'src', 'pages', 'ShellWorkspace.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(macRoot, 'src', 'pages', 'ShellWorkspace.split-tree.test.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(macRoot, 'src', 'lib', 'shell-workspace.ts'))).toBe(false);
    expect(legacyNode?.status).toBe('anchored');
    expect(legacyEdge?.status).toBe('anchored');
    expect(functionMap).toContain('`mac.legacy_cleanup` | architecture truth gate and deletion commits');
    expect(functionMap).toContain('ShellWorkspace source physically removed');
    expect(testDesign).toContain('Slice 7 legacy cleanup | obsolete ShellWorkspace source removal | implemented');

    const productionReferences = listFiles(path.join(macRoot, 'src'))
      .filter((filePath) => /\.(ts|tsx)$/.test(filePath))
      .filter((filePath) => !/\.test\.(ts|tsx)$/.test(filePath))
      .filter((filePath) => !filePath.endsWith(path.join('src', 'lib', 'mac-architecture-truth.test.ts')))
      .flatMap((filePath) => {
        const source = fs.readFileSync(filePath, 'utf8');
        return source.includes('ShellWorkspace') ? [path.relative(macRoot, filePath)] : [];
      });

    expect(productionReferences).toEqual([]);
  });
});
