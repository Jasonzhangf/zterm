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
    public_interfaces?: string[];
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
    truth_store: string;
  }>;
};

const queuePath = 'src/lib/reliable-input/reliable-input-queue.ts';

describe('client.reliable_input ownership', () => {
  it('owns the reliable input queue runtime path', () => {
    const moduleRegistry = JSON.parse(
      read('docs/module-registry.json'),
    ) as ModuleRegistry;
    const module = moduleRegistry.modules.find(
      (candidate) => candidate.module_id === 'client.reliable_input',
    );

    expect(module).toBeTruthy();
    expect(module?.owned_paths).toContain(queuePath);
    expect(module?.public_interfaces).toContain(queuePath);
  });

  it('keeps the resource truth store bound to the queue runtime', () => {
    const resourceRegistry = JSON.parse(
      read('docs/resource-registry.json'),
    ) as ResourceRegistry;
    const resource = resourceRegistry.resources.find(
      (candidate) => candidate.resource_id === 'resource.client_reliable_input_queue',
    );

    expect(resource).toBeTruthy();
    expect(resource?.truth_store).toContain(queuePath);
  });

  it('registers the reliable input feature owner at the queue runtime', () => {
    const featureRegistry = JSON.parse(
      read('docs/feature-registry.json'),
    ) as FeatureRegistry;
    const feature = featureRegistry.features.find(
      (candidate) => candidate.feature_id === 'terminal.daemon_input',
    );

    expect(feature?.owners).toContain(queuePath);
  });

  it('keeps queue semantics outside SessionContext and transport state machines', () => {
    const source = read(queuePath);

    expect(source).not.toMatch(
      /from ['"].*(session-context|SessionContext|session-runtime)['"]/,
    );
    expect(source).not.toContain('reconnectSession');
    expect(source).not.toContain('scheduleReconnect(');
    expect(source).not.toMatch(/ws\.close|close\(4000/);
  });
});
