import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function readRepo(relativePath: string) {
  return readFileSync(join(root, '..', relativePath), 'utf8');
}

type ModuleRegistry = {
  modules: Array<{
    module_id: string;
    status: string;
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

const nodeContractPath = 'packages/shared/src/terminal/node-contract.ts';
const debugContractPath = 'packages/shared/src/terminal/debug-contract.ts';

describe('shared foundation contract ownership', () => {
  it('owns node and debug contract files in active shared modules', () => {
    const moduleRegistry = JSON.parse(read('docs/module-registry.json')) as ModuleRegistry;
    const nodeModule = moduleRegistry.modules.find(
      (candidate) => candidate.module_id === 'shared.node_contract',
    );
    const debugModule = moduleRegistry.modules.find(
      (candidate) => candidate.module_id === 'shared.debug_contract',
    );

    expect(nodeModule?.status).toBe('active');
    expect(nodeModule?.owned_paths).toContain(nodeContractPath);
    expect(debugModule?.status).toBe('active');
    expect(debugModule?.owned_paths).toContain(debugContractPath);
    expect(
      moduleRegistry.modules.filter((candidate) =>
        candidate.owned_paths?.includes(nodeContractPath),
      ),
    ).toHaveLength(1);
    expect(
      moduleRegistry.modules.filter((candidate) =>
        candidate.owned_paths?.includes(debugContractPath),
      ),
    ).toHaveLength(1);
  });

  it('binds the node and debug features and resources to the same owners', () => {
    const featureRegistry = JSON.parse(read('docs/feature-registry.json')) as FeatureRegistry;
    const resourceRegistry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const nodeFeature = featureRegistry.features.find(
      (candidate) => candidate.feature_id === 'shared.node_contract',
    );
    const debugFeature = featureRegistry.features.find(
      (candidate) => candidate.feature_id === 'shared.debug_contract',
    );
    const runtimeNodeRegistry = resourceRegistry.resources.find(
      (candidate) => candidate.resource_id === 'resource.runtime_node_registry',
    );
    const debugSnapshotRegistry = resourceRegistry.resources.find(
      (candidate) => candidate.resource_id === 'resource.debug_snapshot_registry',
    );

    expect(nodeFeature?.owners).toContain(nodeContractPath);
    expect(debugFeature?.owners).toContain(debugContractPath);
    expect(runtimeNodeRegistry?.owner_feature).toBe('shared.node_contract');
    expect(runtimeNodeRegistry?.truth_store).toContain(nodeContractPath);
    expect(debugSnapshotRegistry?.owner_feature).toBe('shared.debug_contract');
    expect(debugSnapshotRegistry?.truth_store).toContain(debugContractPath);
  });

  it('declares shared contract and observability consumer imports in source and package exports', () => {
    const packageJson = JSON.parse(readRepo('packages/shared/package.json')) as {
      exports: Record<string, string>;
    };
    const debugContractSource = readRepo(debugContractPath);
    const nodeContractSource = readRepo(nodeContractPath);
    const clientSnapshotSource = read('src/lib/client-debug-snapshot.ts');
    const runtimeDebugStoreSource = read('src/server/runtime-debug-store.ts');
    const terminalDebugRuntimeSource = read('src/server/terminal-debug-runtime.ts');
    const serverSource = read('src/server/server.ts');

    expect(debugContractSource).toMatch(/from '\.\/node-contract'/);
    expect(nodeContractSource).toMatch(/from '\.\/control-contract'/);
    expect(clientSnapshotSource).toContain('@zterm/shared/terminal/debug-contract');
    expect(clientSnapshotSource).toContain('@zterm/shared/terminal/node-contract');
    expect(runtimeDebugStoreSource).toContain('@zterm/shared/terminal/debug-contract');
    expect(runtimeDebugStoreSource).toContain('@zterm/shared/terminal/node-contract');
    expect(terminalDebugRuntimeSource).toContain('@zterm/shared/terminal/debug-contract');
    expect(serverSource).toContain('@zterm/shared/terminal/debug-contract');
    expect(packageJson.exports['./terminal/node-contract']).toContain('node-contract.ts');
    expect(packageJson.exports['./terminal/debug-contract']).toContain('debug-contract.ts');
  });

  it('keeps the production debug contract free of business payload fields', () => {
    const source = readRepo(debugContractPath);

    expect(source).not.toMatch(/terminalRow|bufferLines|sessionTransport|mirrorRevision|payloadText|terminalText/i);
    expect(source).toContain('sensitivity');
    expect(source).toContain('dropCount');
  });

  it('wires the shared contract tests into the v2 gate', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };

    const v2Gate = packageJson.scripts['test:runtime-architecture-v2'];
    expect(v2Gate).toContain('--dir ../packages/shared');
    expect(v2Gate).toContain('src/terminal/node-contract.test.ts');
    expect(v2Gate).toContain('src/terminal/debug-contract.test.ts');
  });
});
