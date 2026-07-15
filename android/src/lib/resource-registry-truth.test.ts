import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

type Resource = {
  resource_id: string;
  resource_type: string;
  identity: string;
  owner_feature: string;
  truth_store: string;
  allowed_operations: string[];
  direct_relations: string[];
  indirect_relations: string[];
  via_resources: string[];
  forbidden_direct_relations: string[];
  required_gates: string[];
  canonical_docs: string[];
};

type ResourceRegistry = {
  schema_version: number;
  resources: Resource[];
  required_indirect_relations: Array<{ from: string; to: string; via_resources: string[] }>;
  forbidden_direct_relations: Array<{ from: string; to: string; reason: string }>;
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
  return value.includes('/') || value.endsWith('.ts') || value.endsWith('.tsx') || value.endsWith('.md') || value.endsWith('.json');
}

describe('resource registry truth gate', () => {
  it('keeps global resource registry and review docs present', () => {
    expect(existsSync(join(root, 'docs/resource-registry.json'))).toBe(true);
    expect(existsSync(join(root, 'docs/resource-map.md'))).toBe(true);
    expect(existsSync(join(root, 'docs/testing/resource-truth-test-design.md'))).toBe(true);
  });

  it('keeps resources unique, owned, and locally reviewable', () => {
    const registry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const featureRegistry = JSON.parse(read('docs/feature-registry.json')) as { features: Array<{ feature_id: string }> };
    const featureIds = new Set(featureRegistry.features.map((feature) => feature.feature_id));
    const resourceIds = new Set<string>();

    expect(registry.schema_version).toBe(1);
    expect(registry.resources.length).toBeGreaterThanOrEqual(20);

    for (const resource of registry.resources) {
      expect(resource.resource_id).toMatch(/^resource\.[a-z0-9_]+$/);
      expect(resourceIds.has(resource.resource_id), resource.resource_id).toBe(false);
      resourceIds.add(resource.resource_id);
      expect(resource.resource_type).toBeTruthy();
      expect(resource.identity).toBeTruthy();
      expect(resource.truth_store).toBeTruthy();
      expect(featureIds.has(resource.owner_feature), resource.resource_id).toBe(true);
      expect(resource.allowed_operations.length, resource.resource_id).toBeGreaterThan(0);
      expect(resource.required_gates.length, resource.resource_id).toBeGreaterThan(0);
      expect(resource.canonical_docs.length, resource.resource_id).toBeGreaterThan(0);

      for (const docPath of resource.canonical_docs) {
        expect(resolvePath(docPath), `${resource.resource_id}:${docPath}`).not.toBeNull();
      }

      for (const gate of resource.required_gates) {
        if (isFilePath(gate)) {
          expect(resolvePath(gate), `${resource.resource_id}:${gate}`).not.toBeNull();
        }
      }
    }
  });

  it('keeps every declared relation bound to an existing resource id', () => {
    const registry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const resourceIds = new Set(registry.resources.map((resource) => resource.resource_id));

    for (const resource of registry.resources) {
      for (const relationId of [
        ...resource.direct_relations,
        ...resource.indirect_relations,
        ...resource.via_resources,
        ...resource.forbidden_direct_relations,
      ]) {
        expect(resourceIds.has(relationId), `${resource.resource_id}->${relationId}`).toBe(true);
      }
    }

    for (const relation of registry.required_indirect_relations) {
      expect(resourceIds.has(relation.from), relation.from).toBe(true);
      expect(resourceIds.has(relation.to), relation.to).toBe(true);
      expect(relation.via_resources.length, `${relation.from}->${relation.to}`).toBeGreaterThan(0);
      for (const via of relation.via_resources) {
        expect(resourceIds.has(via), via).toBe(true);
      }
    }

    for (const relation of registry.forbidden_direct_relations) {
      expect(resourceIds.has(relation.from), relation.from).toBe(true);
      expect(resourceIds.has(relation.to), relation.to).toBe(true);
      expect(relation.reason).toBeTruthy();
    }
  });

  it('rejects forbidden direct relations inside resource direct edges', () => {
    const registry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const byId = new Map(registry.resources.map((resource) => [resource.resource_id, resource]));

    for (const relation of registry.forbidden_direct_relations) {
      const source = byId.get(relation.from);
      expect(source, relation.from).toBeTruthy();
      expect(source?.direct_relations ?? [], `${relation.from}->${relation.to}`).not.toContain(relation.to);
    }
  });

  it('covers the required global resource surfaces', () => {
    const registry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const resourceIds = new Set(registry.resources.map((resource) => resource.resource_id));

    for (const resourceId of [
      'resource.daemon_process',
      'resource.open_tab',
      'resource.active_session',
      'resource.session_transport',
      'resource.pending_open_intent',
      'resource.platform_terminal_surface',
      'resource.platform_input_channel',
      'resource.terminal_backend',
      'resource.backend_session',
      'resource.tmux_session',
      'resource.wezterm_pane',
      'resource.mirror_store',
      'resource.daemon_input_queue',
      'resource.client_sparse_buffer',
      'resource.renderer_window',
      'resource.ui_projection',
      'resource.release_update_artifact',
      'resource.debug_channel',
    ]) {
      expect(resourceIds.has(resourceId), resourceId).toBe(true);
    }
  });

  it('keeps daemon release and CLI execution on deterministic runtime artifacts', () => {
    const devCli = read('../android/scripts/zterm-daemon.sh');
    const releaseBuilder = read('../android/scripts/prepare-global-daemon-release.sh');
    const npmPackager = read('../android/scripts/prepare-daemon-npm-package.mjs');
    const windowsRunner = read('../android/scripts/windows/zterm-daemon.ps1');

    expect(devCli).toContain('STAGED_DAEMON_ENTRY="${DAEMON_RUNTIME_DIR}/server.cjs"');
    expect(devCli).toContain('"$NODE_BIN" "$STAGED_DAEMON_ENTRY"');
    expect(devCli).not.toContain('"$NODE_BIN" "$DAEMON_ENTRY"');
    expect(devCli).not.toContain('tsx src/server/server.ts');

    expect(releaseBuilder).toContain('STAGED_DAEMON_ENTRY="${RUNTIME_DIR}/server.cjs"');
    expect(releaseBuilder).toContain('--outfile="${RUNTIME_DIR}/server.cjs"');
    expect(releaseBuilder).toContain('"$NODE_BIN" "$STAGED_DAEMON_ENTRY"');
    expect(releaseBuilder).not.toContain('"$NODE_BIN" "${ROOT_DIR}/src/server/server.ts"');
    expect(releaseBuilder).not.toContain('tsx src/server/server.ts');

    expect(npmPackager).toContain("requirePath(resolve(releaseDir, 'runtime/server.cjs')");
    expect(npmPackager).toContain("cpSync(resolve(releaseDir, 'runtime'), resolve(npmPackageDir, 'runtime')");
    expect(npmPackager).toContain("const script = resolve(packageRoot, 'support/windows/zterm-daemon.ps1')");
    expect(npmPackager).not.toContain("resolve(projectRoot, 'src/server/server.ts')");

    expect(windowsRunner).toContain('$RuntimeEntry = Join-Path $PackageRoot "runtime\\server.cjs"');
    expect(windowsRunner).toContain('throw "missing daemon runtime: $RuntimeEntry"');
    expect(windowsRunner).toContain('& $NodeExe $RuntimeEntry');
    expect(windowsRunner).not.toContain('src\\server\\server.ts');
    expect(windowsRunner).not.toContain('tsx');
  });

  it('keeps release artifacts from bypassing promoted daemon runtime artifacts', () => {
    const registry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const releaseResource = registry.resources.find(
      (resource) => resource.resource_id === 'resource.release_update_artifact',
    );
    const runtimeArtifact = registry.resources.find(
      (resource) => resource.resource_id === 'resource.daemon_runtime_artifact',
    );

    expect(releaseResource).toBeTruthy();
    expect(releaseResource?.direct_relations).toEqual(['resource.daemon_runtime_artifact']);
    expect(releaseResource?.indirect_relations).toContain('resource.daemon_process');
    expect(releaseResource?.via_resources).toContain('resource.daemon_runtime_artifact');
    expect(releaseResource?.forbidden_direct_relations).toContain('resource.daemon_process');

    expect(runtimeArtifact).toBeTruthy();
    expect(runtimeArtifact?.direct_relations).toContain('resource.daemon_process');
    expect(runtimeArtifact?.allowed_operations).toContain('execute_artifact');
  });

  it('keeps debug channels observe-only and out of business truth resources', () => {
    const registry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const debugResource = registry.resources.find((resource) => resource.resource_id === 'resource.debug_channel');
    const transportRuntime = read('../android/src/server/terminal-transport-runtime.ts');
    const debugRuntime = read('../android/src/server/terminal-debug-runtime.ts');

    expect(debugResource).toBeTruthy();
    expect(debugResource?.direct_relations).toEqual([]);
    expect(debugResource?.allowed_operations).toEqual([
      'observe',
      'record_metadata',
      'record_trace_metadata',
      'summarize_bounded_trace',
      'diagnose',
    ]);
    expect(debugResource?.forbidden_direct_relations).toEqual(
      expect.arrayContaining([
        'resource.open_tab',
        'resource.active_session',
        'resource.mirror_store',
        'resource.client_sparse_buffer',
        'resource.ui_projection',
      ]),
    );

    expect(transportRuntime).toContain('payloadSummary: deps.summarizePayload(message)');
    expect(transportRuntime).not.toContain('payload: deps.summarizePayload(message)');
    expect(debugRuntime).toContain("'payloadSummary'");
    expect(debugRuntime).not.toContain("copy.payload =");
  });
});
