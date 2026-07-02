import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

type FeatureRegistryEntry = {
  feature_id: string;
  owners: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  required_gates: string[];
  truth_sources: string[];
};

type FeatureRegistry = {
  schema_version: number;
  features: FeatureRegistryEntry[];
};

const androidRoot = process.cwd();
const repoRoot = join(androidRoot, '..');
const registryPath = join(androidRoot, 'docs', 'feature-registry.json');
const functionMapPath = join(androidRoot, 'docs', 'function-map.md');
const featureGatesPath = join(androidRoot, 'docs', 'feature-gates.md');
const architecturePath = join(androidRoot, 'docs', 'architecture.md');
const workflowPath = join(androidRoot, 'docs', 'dev-workflow.md');

const requiredFeatureIds = [
  'terminal.copy_mode',
  'terminal.quickbar',
  'terminal.keyboard_ime',
  'terminal.schedule',
  'terminal.remote_screenshot',
  'terminal.open_tabs',
  'terminal.transport_lifecycle',
  'terminal.daemon_input',
  'terminal.buffer_render',
  'terminal.workspace_panes',
  'terminal.session_group_layout',
  'terminal.interaction_runtime',
  'terminal.shell_actions',
  'connections.history_projection',
  'daemon.file_transfer',
] as const;

const requiredCoveragePaths = [
  'src/pages/useTerminalPageCopyRuntime.ts',
  'src/components/terminal/TerminalQuickBar.tsx',
  'src/pages/terminal-keyboard-lift.ts',
  'src/server/schedule-engine.ts',
  'src/lib/remote-screenshot-runtime.ts',
  'src/hooks/useOpenTabRuntime.ts',
  'src/contexts/session-context-transport-runtime.ts',
  'src/server/terminal-message-runtime.ts',
  'src/contexts/session-context-buffer-runtime.ts',
  'src/hooks/useTerminalWorkspace.ts',
  'src/lib/terminal-layout-profile.ts',
  'src/pages/useTerminalPageInteractionRuntime.ts',
  'src/pages/useTerminalPageShellActionsRuntime.ts',
  'src/lib/connections-server-groups.ts',
  'src/lib/file-transfer-message-runtime.ts',
] as const;

function readRegistry(): FeatureRegistry {
  return JSON.parse(readFileSync(registryPath, 'utf8')) as FeatureRegistry;
}

function readFunctionMap() {
  return readFileSync(functionMapPath, 'utf8');
}

function resolveExistingPath(relativePath: string) {
  const androidPath = join(androidRoot, relativePath);
  if (existsSync(androidPath)) return androidPath;

  const repoPath = join(repoRoot, relativePath);
  if (existsSync(repoPath)) return repoPath;

  return null;
}

describe('feature registry truth gate', () => {
  it('keeps the global feature registry and its companion docs present', () => {
    expect(existsSync(registryPath)).toBe(true);
    expect(existsSync(functionMapPath)).toBe(true);
    expect(existsSync(featureGatesPath)).toBe(true);
  });

  it('keeps feature ids unique and every path resolvable', () => {
    const registry = readRegistry();
    const seen = new Set<string>();

    for (const feature of registry.features) {
      expect(feature.feature_id).toBeTruthy();
      expect(seen.has(feature.feature_id)).toBe(false);
      seen.add(feature.feature_id);

      expect(feature.owners.length).toBeGreaterThan(0);
      expect(feature.allowed_paths.length).toBeGreaterThan(0);
      expect(feature.required_gates.length).toBeGreaterThan(0);
      expect(feature.truth_sources.length).toBeGreaterThan(0);

      for (const relativePath of [
        ...feature.owners,
        ...feature.allowed_paths,
        ...feature.required_gates,
        ...feature.truth_sources,
      ]) {
        expect(resolveExistingPath(relativePath)).not.toBeNull();
      }

      for (const relativePath of feature.forbidden_paths) {
        const absolutePath = resolveExistingPath(relativePath);
        expect(absolutePath).not.toBeNull();
        if (!absolutePath) return;
        expect(statSync(absolutePath).isFile() || statSync(absolutePath).isDirectory()).toBe(true);
      }
    }
  });

  it('covers required high-risk feature ids and owner paths', () => {
    const registry = readRegistry();
    const featureIds = new Set(registry.features.map((feature) => feature.feature_id));

    for (const featureId of requiredFeatureIds) {
      expect(featureIds.has(featureId)).toBe(true);
    }

    const coveredPaths = new Set<string>();
    for (const feature of registry.features) {
      for (const relativePath of [...feature.owners, ...feature.allowed_paths]) {
        coveredPaths.add(relativePath);
      }
    }

    for (const relativePath of requiredCoveragePaths) {
      expect(coveredPaths.has(relativePath)).toBe(true);
    }
  });

  it('keeps the human function map in lockstep with the machine registry feature ids', () => {
    const registry = readRegistry();
    const functionMap = readFunctionMap();
    const registryFeatureIds = new Set(registry.features.map((feature) => feature.feature_id));

    for (const featureId of registryFeatureIds) {
      expect(functionMap, featureId).toContain(`\`${featureId}\``);
    }

    const functionMapFeatureIds = Array.from(functionMap.matchAll(/\| `([a-z0-9_.]+)` \|/g))
      .map((match) => match[1])
      .filter((featureId) => featureId.includes('.'));
    for (const featureId of functionMapFeatureIds) {
      expect(registryFeatureIds.has(featureId), featureId).toBe(true);
    }
  });

  it('documents the registry as an architecture and workflow gate', () => {
    const architectureSource = readFileSync(architecturePath, 'utf8');
    const workflowSource = readFileSync(workflowPath, 'utf8');

    expect(architectureSource).toContain('docs/feature-registry.json');
    expect(architectureSource).toContain('docs/function-map.md');
    expect(architectureSource).toContain('docs/feature-gates.md');

    expect(workflowSource).toContain('docs/feature-registry.json');
    expect(workflowSource).toContain('Feature Registry');
    expect(workflowSource).toContain('required gates');
  });
});
