import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

type EdgeRegistryEntry = {
  edge_id: string;
  from_module: string;
  to_module: string;
  resource_from: string;
  resource_to: string;
  via_resources: string[];
  relation_status: 'direct' | 'via' | 'observer' | 'binding pending';
  owner_feature: string;
  allowed_callers: string[];
  forbidden_callers: string[];
  request_chain: string[];
  response_chain: string[];
  error_chain: string[];
  mainline_call_ids: string[];
  required_gates: string[];
  status: 'active' | 'design' | 'pending' | 'deprecated';
};

type EdgeRegistry = {
  schema_version: number;
  edges: EdgeRegistryEntry[];
};

type ResourceRegistry = {
  resources: Array<{ resource_id: string; direct_relations: string[] }>;
  forbidden_direct_relations: Array<{ from: string; to: string; reason: string }>;
};

type MainlineManifest = {
  lifecycles: Array<{ edges: Array<{ edge_id: string }> }>;
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

function assertPipelineChain(edgeId: string, chainName: string, nodes: string[]) {
  expect(nodes.length, `${edgeId}:${chainName}`).toBeGreaterThan(0);
  for (const node of nodes) {
    expect(node, `${edgeId}:${chainName}:${node}`).toMatch(/^[A-Z][A-Za-z0-9]+(In|Out|Error)[0-9]{2}[A-Z][A-Za-z0-9]+$/);
  }
}

describe('edge registry truth gate', () => {
  it('keeps edge registry and module review docs present', () => {
    expect(existsSync(join(root, 'docs/edge-registry.json'))).toBe(true);
    expect(existsSync(join(root, 'docs/module-registry.json'))).toBe(true);
    expect(existsSync(join(root, 'docs/modules/project-modules.md'))).toBe(true);
    expect(existsSync(join(root, 'docs/testing/module-edge-registry-test-design.md'))).toBe(true);
  });

  it('keeps every edge module, feature, resource, mainline id, and gate bound', () => {
    const registry = JSON.parse(read('docs/edge-registry.json')) as EdgeRegistry;
    const moduleRegistry = JSON.parse(read('docs/module-registry.json')) as { modules: Array<{ module_id: string }> };
    const featureRegistry = JSON.parse(read('docs/feature-registry.json')) as { features: Array<{ feature_id: string }> };
    const resourceRegistry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const mainlineManifest = JSON.parse(read('docs/wiki/mainline-call-map.json')) as MainlineManifest;
    const moduleIds = new Set(moduleRegistry.modules.map((module) => module.module_id));
    const featureIds = new Set(featureRegistry.features.map((feature) => feature.feature_id));
    const resourceIds = new Set(resourceRegistry.resources.map((resource) => resource.resource_id));
    const mainlineIds = new Set(mainlineManifest.lifecycles.flatMap((lifecycle) => lifecycle.edges.map((edge) => edge.edge_id)));
    const edgeIds = new Set<string>();

    expect(registry.schema_version).toBe(1);
    expect(registry.edges.length).toBeGreaterThanOrEqual(20);

    for (const edge of registry.edges) {
      expect(edge.edge_id).toMatch(/^edge\.[a-z0-9_.]+$/);
      expect(edgeIds.has(edge.edge_id), edge.edge_id).toBe(false);
      edgeIds.add(edge.edge_id);
      expect(moduleIds.has(edge.from_module), `${edge.edge_id}:from_module`).toBe(true);
      expect(moduleIds.has(edge.to_module), `${edge.edge_id}:to_module`).toBe(true);
      expect(featureIds.has(edge.owner_feature), `${edge.edge_id}:owner_feature`).toBe(true);
      expect(resourceIds.has(edge.resource_from), `${edge.edge_id}:resource_from`).toBe(true);
      expect(resourceIds.has(edge.resource_to), `${edge.edge_id}:resource_to`).toBe(true);
      expect(edge.allowed_callers.length, `${edge.edge_id}:allowed_callers`).toBeGreaterThan(0);
      expect(edge.forbidden_callers.length, `${edge.edge_id}:forbidden_callers`).toBeGreaterThan(0);
      expect(edge.required_gates.length, `${edge.edge_id}:required_gates`).toBeGreaterThan(0);
      expect(edge.mainline_call_ids.length, `${edge.edge_id}:mainline_call_ids`).toBeGreaterThan(0);

      for (const via of edge.via_resources) {
        expect(resourceIds.has(via), `${edge.edge_id}:via:${via}`).toBe(true);
      }

      for (const mainlineCallId of edge.mainline_call_ids) {
        expect(mainlineIds.has(mainlineCallId), `${edge.edge_id}:${mainlineCallId}`).toBe(true);
      }

      for (const gate of edge.required_gates) {
        if (isFilePath(gate)) {
          expect(resolvePath(gate), `${edge.edge_id}:${gate}`).not.toBeNull();
        }
      }

      assertPipelineChain(edge.edge_id, 'request_chain', edge.request_chain);
      assertPipelineChain(edge.edge_id, 'response_chain', edge.response_chain);
      assertPipelineChain(edge.edge_id, 'error_chain', edge.error_chain);
    }
  });

  it('keeps direct and via edge relations aligned with the resource registry', () => {
    const registry = JSON.parse(read('docs/edge-registry.json')) as EdgeRegistry;
    const resourceRegistry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const directEdges = new Set<string>();

    for (const resource of resourceRegistry.resources) {
      for (const target of resource.direct_relations) {
        directEdges.add(`${resource.resource_id}->${target}`);
      }
    }

    for (const edge of registry.edges) {
      if (edge.relation_status === 'direct') {
        expect(directEdges.has(`${edge.resource_from}->${edge.resource_to}`), edge.edge_id).toBe(true);
        expect(edge.via_resources.length, edge.edge_id).toBe(0);
      }

      if (edge.relation_status === 'via') {
        expect(edge.via_resources.length, edge.edge_id).toBeGreaterThan(0);
      }
    }
  });

  it('rejects forbidden direct resource relations in edge registry', () => {
    const registry = JSON.parse(read('docs/edge-registry.json')) as EdgeRegistry;
    const resourceRegistry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const forbidden = new Set(
      resourceRegistry.forbidden_direct_relations.map((relation) => `${relation.from}->${relation.to}`),
    );

    for (const edge of registry.edges) {
      if (edge.relation_status !== 'direct') continue;
      expect(forbidden.has(`${edge.resource_from}->${edge.resource_to}`), edge.edge_id).toBe(false);
    }
  });

  it('covers the high-risk connection and remote-window edges', () => {
    const registry = JSON.parse(read('docs/edge-registry.json')) as EdgeRegistry;
    const edgeIds = new Set(registry.edges.map((edge) => edge.edge_id));

    for (const edgeId of [
      'edge.client.active_session_to_session_transport',
      'edge.client.session_transport_to_daemon_target_transport',
      'edge.client.daemon_target_transport_to_terminal_channel',
      'edge.daemon.terminal_channel_to_subscriber',
      'edge.daemon.mirror_store_to_client_sparse_buffer',
      'edge.client_sparse_buffer_to_renderer',
      'edge.client_touch_action_to_daemon_remote_window_stream',
      'edge.relay_peer_lease_to_daemon_target_transport_via_target',
    ]) {
      expect(edgeIds.has(edgeId), edgeId).toBe(true);
    }
  });
});
