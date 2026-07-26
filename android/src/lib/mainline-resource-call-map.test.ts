import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

type ResourceRegistry = {
  resources: Array<{ resource_id: string; direct_relations: string[] }>;
  forbidden_direct_relations: Array<{ from: string; to: string }>;
};

type MainlineManifest = {
  lifecycles: Array<{
    lifecycle_id: string;
    edges: Array<{
      edge_id: string;
      from: string;
      to: string;
      resource_from: string;
      resource_to: string;
      via_resources: string[];
      relation_status: 'direct' | 'via' | 'observer';
    }>;
  }>;
};

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

describe('mainline resource call map gate', () => {
  it('keeps every mainline edge resource-bound', () => {
    const registry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const manifest = JSON.parse(read('docs/wiki/mainline-call-map.json')) as MainlineManifest;
    const resourceIds = new Set(registry.resources.map((resource) => resource.resource_id));

    for (const lifecycle of manifest.lifecycles) {
      for (const edge of lifecycle.edges) {
        expect(edge.resource_from, edge.edge_id).toMatch(/^resource\./);
        expect(edge.resource_to, edge.edge_id).toMatch(/^resource\./);
        expect(resourceIds.has(edge.resource_from), edge.edge_id).toBe(true);
        expect(resourceIds.has(edge.resource_to), edge.edge_id).toBe(true);
        expect(['direct', 'via', 'observer']).toContain(edge.relation_status);
        expect(edge.relation_status, edge.edge_id).not.toBe('binding pending');
        expect(Array.isArray(edge.via_resources), edge.edge_id).toBe(true);
        for (const via of edge.via_resources) {
          expect(resourceIds.has(via), `${edge.edge_id}:${via}`).toBe(true);
        }
      }
    }
  });

  it('rejects forbidden direct resource edges in the call map', () => {
    const registry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const manifest = JSON.parse(read('docs/wiki/mainline-call-map.json')) as MainlineManifest;
    const forbidden = new Set(registry.forbidden_direct_relations.map((relation) => `${relation.from}->${relation.to}`));

    for (const lifecycle of manifest.lifecycles) {
      for (const edge of lifecycle.edges) {
        if (edge.relation_status === 'direct') {
          expect(forbidden.has(`${edge.resource_from}->${edge.resource_to}`), edge.edge_id).toBe(false);
        }
      }
    }
  });

  it('requires direct edges to exist in the registry unless marked via or observer', () => {
    const registry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const manifest = JSON.parse(read('docs/wiki/mainline-call-map.json')) as MainlineManifest;
    const directEdges = new Set<string>();

    for (const resource of registry.resources) {
      for (const target of resource.direct_relations) {
        directEdges.add(`${resource.resource_id}->${target}`);
      }
    }

    for (const lifecycle of manifest.lifecycles) {
      for (const edge of lifecycle.edges) {
        if (edge.relation_status === 'direct') {
          expect(directEdges.has(`${edge.resource_from}->${edge.resource_to}`), edge.edge_id).toBe(true);
        }
        if (edge.relation_status === 'via') {
          expect(edge.via_resources.length, edge.edge_id).toBeGreaterThan(0);
        }
      }
    }
  });
});
