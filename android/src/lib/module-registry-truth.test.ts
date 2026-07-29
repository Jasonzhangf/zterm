import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

type ModuleRegistryEntry = {
  module_id: string;
  runtime_side: 'project' | 'daemon' | 'client' | 'shared' | 'relay' | 'release' | 'observability';
  level: number;
  parent_module_id: string | null;
  owner_feature: string;
  responsibility: string;
  owned_resources: string[];
  consumed_resources: string[];
  pending_resources: string[];
  public_interfaces: string[];
  forbidden_resources: string[];
  canonical_docs: string[];
  required_gates: string[];
  status: 'active' | 'design' | 'pending' | 'deprecated';
};

type ModuleRegistry = {
  schema_version: number;
  modules: ModuleRegistryEntry[];
};

const root = process.cwd();
const repoRoot = join(root, '..');

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function resolvePath(relativePath: string) {
  const androidPath = join(root, relativePath);
  if (existsSync(androidPath)) return androidPath;
  const repoPath = join(repoRoot, relativePath);
  if (existsSync(repoPath)) return repoPath;
  return null;
}

function isFilePath(value: string) {
  return (
    value.includes('/') ||
    value.endsWith('.ts') ||
    value.endsWith('.tsx') ||
    value.endsWith('.md') ||
    value.endsWith('.json') ||
    value.endsWith('.sh') ||
    value.endsWith('.mjs') ||
    value.endsWith('.java')
  );
}

function collectSourceFiles(relativeDir: string): string[] {
  const start = join(root, relativeDir);
  const result: string[] = [];
  const visit = (absolutePath: string) => {
    for (const entry of readdirSync(absolutePath)) {
      const next = join(absolutePath, entry);
      const stat = statSync(next);
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === 'coverage') {
          continue;
        }
        visit(next);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) {
        result.push(next);
      }
    }
  };
  visit(start);
  return result;
}

describe('module registry truth gate', () => {
  it('keeps project module registry and review docs present', () => {
    expect(existsSync(join(root, 'docs/module-registry.json'))).toBe(true);
    expect(existsSync(join(root, 'docs/modules/project-modules.md'))).toBe(true);
    expect(existsSync(join(root, 'docs/testing/module-edge-registry-test-design.md'))).toBe(true);
  });

  it('keeps module ids unique, parented, feature-owned, and locally reviewable', () => {
    const registry = JSON.parse(read('docs/module-registry.json')) as ModuleRegistry;
    const featureRegistry = JSON.parse(read('docs/feature-registry.json')) as { features: Array<{ feature_id: string }> };
    const featureIds = new Set(featureRegistry.features.map((feature) => feature.feature_id));
    const moduleIds = new Set<string>();

    expect(registry.schema_version).toBe(1);
    expect(registry.modules.length).toBeGreaterThanOrEqual(25);

    for (const module of registry.modules) {
      expect(module.module_id).toMatch(/^(project|daemon|client|shared|relay|release|observability)\.[a-z0-9_]+$/);
      expect(moduleIds.has(module.module_id), module.module_id).toBe(false);
      moduleIds.add(module.module_id);
      expect(module.runtime_side, module.module_id).toBe(module.module_id.split('.')[0]);
      expect(module.level, module.module_id).toBeGreaterThanOrEqual(0);
      expect(featureIds.has(module.owner_feature), module.module_id).toBe(true);
      expect(module.responsibility, module.module_id).toBeTruthy();
      expect(module.public_interfaces.length, module.module_id).toBeGreaterThan(0);
      expect(module.canonical_docs.length, module.module_id).toBeGreaterThan(0);
      expect(module.required_gates.length, module.module_id).toBeGreaterThan(0);

      if (module.level === 0) {
        expect(module.parent_module_id, module.module_id).toBeNull();
      } else {
        expect(module.parent_module_id, module.module_id).toBeTruthy();
      }

      for (const docPath of module.canonical_docs) {
        expect(resolvePath(docPath), `${module.module_id}:${docPath}`).not.toBeNull();
      }

      for (const gate of module.required_gates) {
        if (isFilePath(gate)) {
          expect(resolvePath(gate), `${module.module_id}:${gate}`).not.toBeNull();
        }
      }
    }

    for (const module of registry.modules) {
      if (!module.parent_module_id) continue;
      const parent = registry.modules.find((candidate) => candidate.module_id === module.parent_module_id);
      expect(parent, `${module.module_id}:parent=${module.parent_module_id}`).toBeTruthy();
      expect(parent?.level ?? -1, module.module_id).toBeLessThan(module.level);
    }
  });

  it('keeps module resource references bound to active truth and design resources pending', () => {
    const registry = JSON.parse(read('docs/module-registry.json')) as ModuleRegistry;
    const resourceRegistry = JSON.parse(read('docs/resource-registry.json')) as {
      resources: Array<{ resource_id: string; status?: 'active' | 'design' | 'pending' | 'deprecated' }>;
    };
    const resourceIds = new Set(resourceRegistry.resources.map((resource) => resource.resource_id));
    const statusByResource = new Map(resourceRegistry.resources.map((resource) => [resource.resource_id, resource.status ?? 'active']));

    for (const module of registry.modules) {
      for (const resourceId of [...module.owned_resources, ...module.consumed_resources, ...module.pending_resources, ...module.forbidden_resources]) {
        expect(resourceIds.has(resourceId), `${module.module_id}:${resourceId}`).toBe(true);
      }

      for (const resourceId of [...module.owned_resources, ...module.consumed_resources]) {
        expect(statusByResource.get(resourceId), `${module.module_id}:${resourceId}`).toBe('active');
      }

      for (const resourceId of module.pending_resources) {
        expect(statusByResource.get(resourceId), `${module.module_id}:${resourceId}`).not.toBe('active');
        expect(module.owned_resources, `${module.module_id}:${resourceId}`).not.toContain(resourceId);
        expect(module.consumed_resources, `${module.module_id}:${resourceId}`).not.toContain(resourceId);
        expect(module.forbidden_resources, `${module.module_id}:${resourceId}`).not.toContain(resourceId);
      }

      for (const owned of module.owned_resources) {
        expect(module.forbidden_resources, `${module.module_id}:${owned}`).not.toContain(owned);
      }
    }
  });

  it('documents pending module resources as design target state', () => {
    const moduleReview = read('docs/modules/project-modules.md');
    const testDesign = read('docs/testing/module-edge-registry-test-design.md');

    expect(moduleReview).toMatch(/pending resources/i);
    expect(testDesign).toMatch(/design\/pending resources/i);
    expect(testDesign).toMatch(/pending_resources` in `docs\/module-registry\.json`/);
  });

  it('keeps concrete resources owned by at most one module', () => {
    const registry = JSON.parse(read('docs/module-registry.json')) as ModuleRegistry;
    const ownersByResource = new Map<string, string>();

    for (const module of registry.modules) {
      for (const resourceId of module.owned_resources) {
        const existingOwner = ownersByResource.get(resourceId);
        expect(existingOwner, `${resourceId}: ${existingOwner ?? ''} and ${module.module_id}`).toBeUndefined();
        ownersByResource.set(resourceId, module.module_id);
      }
    }
  });

  it('covers the required first-pass project modules', () => {
    const registry = JSON.parse(read('docs/module-registry.json')) as ModuleRegistry;
    const moduleIds = new Set(registry.modules.map((module) => module.module_id));

    for (const moduleId of [
      'daemon.runtime_entry',
      'daemon.connection_gateway',
      'daemon.terminal_backend',
      'daemon.mirror_store',
      'daemon.transport_subscriber',
      'daemon.input_queue',
      'daemon.remote_window_stream',
      'client.app_shell',
      'client.connection_home',
      'client.daemon_connection',
      'client.session_runtime',
      'client.terminal_channel_mux',
      'client.buffer_store',
      'client.renderer_window',
      'client.input_runtime',
      'client.session_drawer_preview',
      'client.remote_window_overlay',
      'shared.protocol',
      'shared.resource_contract',
      'shared.terminal_types',
      'shared.connection_types',
      'shared.test_contracts',
      'relay.account_directory',
      'relay.peer_lease',
      'release.update_artifact',
      'release.daemon_artifact',
      'observability.debug_channel',
    ]) {
      expect(moduleIds.has(moduleId), moduleId).toBe(true);
    }
  });

  it('keeps TraversalSocket construction owned by client.daemon_connection', () => {
    const allowedFiles = new Set([
      join(root, 'src/lib/client-daemon-connection.ts'),
      join(root, 'src/lib/client-daemon-connection.test.ts'),
      join(root, 'src/contexts/session-context-infra-runtime.test.ts'),
      join(root, 'src/lib/tmux-sessions.test.ts'),
      join(root, 'src/lib/traversal/socket.test.ts'),
      join(root, 'src/lib/traversal/socket.ts'),
    ]);

    for (const filePath of collectSourceFiles('src')) {
      const source = readFileSync(filePath, 'utf8');
      const importsTraversalSocket = /import\s+\{\s*TraversalSocket\s*\}\s+from\s+['"][^'"]*traversal\/socket['"]/.test(source);
      const constructsTraversalSocket = /new\s+TraversalSocket\s*\(/.test(source);
      if (!importsTraversalSocket && !constructsTraversalSocket) {
        continue;
      }
      expect(allowedFiles.has(filePath), filePath.replace(`${root}/`, '')).toBe(true);
    }
  });

  it('keeps raw session socket access constrained to the daemon-connection migration allowlist', () => {
    const allowedFiles = new Set([
      join(root, 'src/contexts/session-context-buffer-runtime.ts'),
      join(root, 'src/contexts/session-context-infra-facade-runtime.ts'),
      join(root, 'src/contexts/session-context-session-runtime.ts'),
      join(root, 'src/contexts/session-context-socket-runtime.ts'),
      join(root, 'src/contexts/session-context-transport-open-runtime.ts'),
      join(root, 'src/contexts/session-context-transport-orchestration-runtime.ts'),
      join(root, 'src/contexts/session-context-transport-runtime.ts'),
      join(root, 'src/lib/runtime-debug-flush.ts'),
    ]);

    for (const filePath of collectSourceFiles('src')) {
      if (/\.test\.(ts|tsx)$/.test(filePath)) {
        continue;
      }
      const source = readFileSync(filePath, 'utf8');
      const readsRawSessionSocket = /readSessionTransportSocket\s*\(/.test(source)
        || /readSessionTransportResource\s*\([^)]*\)\.socket/.test(source);
      if (!readsRawSessionSocket) {
        continue;
      }
      expect(allowedFiles.has(filePath), filePath.replace(`${root}/`, '')).toBe(true);
    }
  });

  it('forbids daemonConnection-present paths from falling back to raw session socket access', () => {
    const forbiddenFallback = /daemonConnection(?:\?|\.)[^;\n]*(?:readSessionSocket|readSessionResource|readSessionTargetSocket|readOpenSessionSocket)[^;\n]*(?:\|\||\?\?)[^;\n]*(?:readSessionTransportSocket|readSessionTransportResource)/;

    for (const filePath of collectSourceFiles('src')) {
      if (/\.test\.(ts|tsx)$/.test(filePath)) {
        continue;
      }
      const source = readFileSync(filePath, 'utf8');
      expect(forbiddenFallback.test(source), filePath.replace(`${root}/`, '')).toBe(false);
    }
  });

  it('forbids queued session opens from falling back to legacy session-ticket sockets', () => {
    const source = read('src/contexts/session-context-transport-open-runtime.ts');
    const queueStart = source.indexOf('export function queueSessionTransportOpenIntentRuntime');
    const queueEnd = source.indexOf('export function applyTransportOpenConnectedEffectsRuntime');

    expect(queueStart).toBeGreaterThanOrEqual(0);
    expect(queueEnd).toBeGreaterThan(queueStart);

    const queueSource = source.slice(queueStart, queueEnd);
    expect(queueSource).not.toContain('ensureControlTransportForSessionOpen');
    expect(queueSource).toContain('client.daemon_connection mux opener unavailable');
    expect(queueSource).toContain('deletePendingSessionTransportOpenIntent');
  });

  it('forbids client legacy control/session-ticket transport openers from creating physical sockets', () => {
    const forbiddenSymbols = [
      'ensureControlTransportForSessionOpen',
      'ensureControlTransportForSessionOpenOrchestrationRuntime',
      'openSessionTransportByIntentRuntime',
      'handleControlTransportMessage',
      'failPendingControlTargetIntents',
    ];
    const forbiddenControlSocketBuild = /buildTraversalSocketForHost\([^)]*['"]control['"]/;
    const forbiddenSessionSocketBuild = /buildTraversalSocketForHost\([^)]*['"]session['"]/;

    for (const filePath of collectSourceFiles('src')) {
      if (/\.test\.(ts|tsx)$/.test(filePath)) {
        continue;
      }
      const relativePath = filePath.replace(`${root}/`, '');
      if (!relativePath.startsWith('src/contexts/')) {
        continue;
      }
      const source = readFileSync(filePath, 'utf8');
      for (const symbol of forbiddenSymbols) {
        expect(source.includes(symbol), `${relativePath} still contains ${symbol}`).toBe(false);
      }
      expect(forbiddenControlSocketBuild.test(source), relativePath).toBe(false);
      expect(forbiddenSessionSocketBuild.test(source), relativePath).toBe(false);
    }
  });

  it('keeps client daemon connection construction in transport owner files only', () => {
    const allowedFiles = new Set([
      join(root, 'src/contexts/session-context-infra-facade-runtime.ts'),
      join(root, 'src/contexts/session-context-transport-orchestration-runtime.ts'),
      join(root, 'src/lib/client-daemon-connection.ts'),
    ]);

    for (const filePath of collectSourceFiles('src')) {
      if (/\.test\.(ts|tsx)$/.test(filePath)) {
        continue;
      }
      const source = readFileSync(filePath, 'utf8');
      if (!source.includes('createClientDaemonConnection(')) {
        continue;
      }
      expect(allowedFiles.has(filePath), filePath.replace(`${root}/`, '')).toBe(true);
    }
  });

  it('keeps Session free of buffer/head truth and forbids visible-range fallback reads', () => {
    const typesSource = read('src/lib/types.ts');
    const sessionInterfaceMatch = typesSource.match(/export interface Session \{[\s\S]*?\n\}/);
    expect(sessionInterfaceMatch, 'missing Session interface').toBeTruthy();
    const sessionInterface = sessionInterfaceMatch?.[0] || '';

    expect(sessionInterface).not.toMatch(/\bbuffer\??\s*:/);
    expect(sessionInterface).not.toContain('daemonHeadRevision');
    expect(sessionInterface).not.toContain('daemonHeadEndIndex');

    for (const filePath of collectSourceFiles('src')) {
      if (/\.test\.(ts|tsx)$/.test(filePath)) {
        continue;
      }
      const source = readFileSync(filePath, 'utf8');
      const relativePath = filePath.replace(`${root}/`, '');
      expect(source, relativePath).not.toContain('sessionBufferHeadsRef');
      // Exclude runtime-debug scope string literals like 'session.buffer.head' — only forbid property reads.
      expect(source, relativePath).not.toMatch(/(?<!['"`])\bsession\.buffer\b/);
      expect(source, relativePath).not.toMatch(/\bsession\.daemonHeadRevision\b/);
      expect(source, relativePath).not.toMatch(/\bsession\.daemonHeadEndIndex\b/);
    }

    const visibleRangeSource = read('src/contexts/session-visible-range-helpers.ts');
    expect(visibleRangeSource).not.toContain('resolveSessionBufferView');
    expect(visibleRangeSource).not.toMatch(/import type \{[^}]*\bSession\b/);
  });
});
