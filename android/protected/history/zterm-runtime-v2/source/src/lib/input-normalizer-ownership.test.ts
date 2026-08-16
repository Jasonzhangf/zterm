import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

type ModuleRegistry = {
  modules: Array<{
    module_id: string;
    owned_paths?: string[];
  }>;
};

type FeatureRegistry = {
  features: Array<{
    feature_id: string;
    owners: string[];
  }>;
};

type ResourceRegistry = {
  resources: Array<{
    resource_id: string;
    owner_feature: string;
    truth_store: string;
  }>;
};

type EdgeRegistry = {
  import_edges: Array<{
    from_module: string;
    to_module: string;
    status: string;
  }>;
};

const normalizerPath = 'src/lib/terminal-input-normalization.ts';

describe('client.input_normalizer ownership', () => {
  it('owns the committed-text normalizer exclusively', () => {
    const moduleRegistry = JSON.parse(
      read('docs/module-registry.json'),
    ) as ModuleRegistry;
    const module = moduleRegistry.modules.find(
      (candidate) => candidate.module_id === 'client.input_normalizer',
    );

    expect(module).toBeTruthy();
    expect(module?.owned_paths).toContain(normalizerPath);
    expect(
      moduleRegistry.modules.find(
        (candidate) => candidate.module_id === 'client.runtime',
      )?.owned_paths,
    ).not.toContain(normalizerPath);
  });

  it('registers the feature and resource with the same owner', () => {
    const featureRegistry = JSON.parse(
      read('docs/feature-registry.json'),
    ) as FeatureRegistry;
    const resourceRegistry = JSON.parse(
      read('docs/resource-registry.json'),
    ) as ResourceRegistry;
    const feature = featureRegistry.features.find(
      (candidate) => candidate.feature_id === 'client.input_normalizer',
    );
    const resource = resourceRegistry.resources.find(
      (candidate) => candidate.resource_id === 'resource.client_input_normalizer',
    );

    expect(feature?.owners).toContain(normalizerPath);
    expect(resource?.owner_feature).toBe('client.input_normalizer');
    expect(resource?.truth_store).toContain(normalizerPath);
  });

  it('declares the real consumer import edges', () => {
    const edgeRegistry = JSON.parse(read('docs/edge-registry.json')) as EdgeRegistry;
    const declared = new Set(
      edgeRegistry.import_edges.map((edge) => `${edge.from_module}->${edge.to_module}`),
    );

    expect(declared.has('client.app_shell->client.input_normalizer')).toBe(true);
    expect(declared.has('client.dom_renderer->client.input_normalizer')).toBe(true);
  });

  it('keeps normalization pure and outside transport/backend/session truth', () => {
    const source = read(normalizerPath);

    expect(source).not.toMatch(
      /from ['"].*(session-transport|session-context|backend|mirror|transport)['"]/,
    );
    expect(source).not.toContain('readSessionTransport');
  });

  it('has positive and negative normalization coverage', () => {
    const testSource = read('src/lib/terminal-input-normalization.test.ts');

    expect(testSource).toContain('keeps CJK unchanged');
    expect(testSource).toContain('keeps CJK, emoji, and non-ascii symbols');
    expect(testSource).toContain('returns empty string unchanged');
  });
});
