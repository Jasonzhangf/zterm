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
});
