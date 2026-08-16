import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

type LoopManifest = {
  schema_version: number;
  loop_id: string;
  pattern: string;
  mode: string;
  enabled_mode: string;
  owner_feature: string;
  state_file: string;
  constraints_file: string;
  budget_file: string;
  run_log_file: string;
  kill_switch: {
    file: string;
    field: string;
    inactive_value: string;
    active_value: string;
  };
  actions_allowed: Record<string, boolean>;
  canonical_docs: string[];
  function_map: {
    feature_id: string;
    path: string;
  };
  mainline_call_ids: string[];
  verification_gates: string[];
  l1_report_required_fields: string[];
  upgrade_policy: {
    l2_requires_human_approval: boolean;
    l2_requires_maker_checker: boolean;
    l2_max_attempts_per_item: number;
    l3_enabled: boolean;
  };
};

type FeatureRegistry = {
  features: Array<{ feature_id: string; allowed_paths: string[]; required_gates: string[] }>;
};

type MainlineCallMap = {
  lifecycles: Array<{
    lifecycle_id: string;
    nodes: Array<{ id: string }>;
    edges: Array<{
      from: string;
      to: string;
      owner_feature: string;
      edge_id?: string;
    }>;
  }>;
};

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function readJson<T>(relativePath: string) {
  return JSON.parse(read(relativePath)) as T;
}

function resolvePath(relativePath: string) {
  const androidPath = join(root, relativePath);
  if (existsSync(androidPath)) return androidPath;

  const repoPath = join(root, '..', relativePath);
  if (existsSync(repoPath)) return repoPath;

  return null;
}

function readManifest() {
  return readJson<LoopManifest>('docs/loops/loop-manifest.json');
}

function readRegistry() {
  return readJson<FeatureRegistry>('docs/feature-registry.json');
}

function readMainlineCallMap() {
  return readJson<MainlineCallMap>('docs/wiki/mainline-call-map.json');
}

describe('loop governance truth gate', () => {
  it('keeps the loop governance gate wired into test:feature-registry', () => {
    const packageJson = read('package.json');

    expect(packageJson).toContain('src/lib/loop-governance-truth.test.ts');
  });

  it('keeps the L1 loop files and manifest present and parseable', () => {
    const manifest = readManifest();

    expect(manifest.schema_version).toBe(1);
    expect(manifest.loop_id).toBe('zterm.daily-triage');
    expect(manifest.pattern).toBe('daily-triage');
    expect(manifest.mode).toBe('L1');
    expect(manifest.owner_feature).toBe('project.loop_governance');

    for (const docPath of [
      'docs/loops/LOOP.md',
      manifest.state_file,
      manifest.constraints_file,
      manifest.budget_file,
      manifest.run_log_file,
      ...manifest.canonical_docs,
      ...manifest.verification_gates,
    ]) {
      expect(resolvePath(docPath), docPath).not.toBeNull();
    }
  });

  it('registers project.loop_governance in the feature registry, function map, and feature gates', () => {
    const registry = readRegistry();
    const functionMap = read('docs/function-map.md');
    const featureGates = read('docs/feature-gates.md');
    const feature = registry.features.find((entry) => entry.feature_id === 'project.loop_governance');

    expect(feature).toBeTruthy();
    expect(feature?.required_gates).toContain('src/lib/loop-governance-truth.test.ts');
    expect(feature?.allowed_paths).toContain('docs/loops/loop-manifest.json');
    expect(feature?.allowed_paths).toContain('docs/testing/loop-governance-test-design.md');
    expect(functionMap).toContain('`project.loop_governance`');
    expect(featureGates).toContain('`project.loop_governance`');
  });

  it('initializes the loop state as L1 report-only with an inactive kill switch', () => {
    const state = read('docs/loops/STATE.md');
    const loop = read('docs/loops/LOOP.md');

    expect(state).toContain('mode: L1');
    expect(state).toContain('kill_switch: inactive');
    expect(loop).toContain('L1 report-only');
    expect(loop).toContain('must not edit product code');
    expect(loop).toContain('start or stop daemons');
  });

  it('denies product, daemon, and git write actions in the L1 manifest and constraints', () => {
    const manifest = readManifest();
    const constraints = read('docs/loops/loop-constraints.md');

    expect(manifest.enabled_mode).toBe('L1');
    expect(manifest.actions_allowed.read_project_truth).toBe(true);
    expect(manifest.actions_allowed.write_report).toBe(true);
    expect(manifest.actions_allowed.append_run_log).toBe(true);
    expect(manifest.actions_allowed.edit_product_code).toBe(false);
    expect(manifest.actions_allowed.start_or_stop_daemon).toBe(false);
    expect(manifest.actions_allowed.stage_or_commit).toBe(false);
    expect(manifest.actions_allowed.push_or_merge).toBe(false);

    expect(constraints).toContain('Denied In L1');
    expect(constraints).toContain('Product code edits');
    expect(constraints).toContain('Starting, stopping, restarting, or installing daemons');
    expect(constraints).toContain('Staging files, committing, pushing, merging');
  });

  it('requires every L1 finding to bind to owner, gate, status, and mainline_call_id', () => {
    const manifest = readManifest();

    expect(manifest.l1_report_required_fields).toEqual([
      'feature_id',
      'owner_path',
      'allowed_path',
      'forbidden_path_check',
      'required_gate',
      'mainline_call_id',
      'status',
    ]);
  });

  it('keeps each mainline call-map edge bound to a deterministic unique edge_id', () => {
    const callMap = readMainlineCallMap();
    const seen = new Set<string>();

    for (const lifecycle of callMap.lifecycles) {
      const nodeIds = new Set(lifecycle.nodes.map((node) => node.id));
      for (const edge of lifecycle.edges) {
        const expectedEdgeId = `${lifecycle.lifecycle_id}:${edge.from}->${edge.to}`;

        expect(nodeIds.has(edge.from), expectedEdgeId).toBe(true);
        expect(nodeIds.has(edge.to), expectedEdgeId).toBe(true);
        expect(edge.edge_id).toBe(expectedEdgeId);
        expect(seen.has(expectedEdgeId), expectedEdgeId).toBe(false);
        seen.add(expectedEdgeId);
      }
    }
  });

  it('binds loop manifest mainline_call_ids to real adjacent call-map edges', () => {
    const manifest = readManifest();
    const callMap = readMainlineCallMap();
    const edgeIds = new Set(
      callMap.lifecycles.flatMap((lifecycle) => lifecycle.edges.map((edge) => edge.edge_id)),
    );

    expect(manifest.mainline_call_ids.length).toBeGreaterThan(0);
    for (const edgeId of manifest.mainline_call_ids) {
      expect(edgeIds.has(edgeId), edgeId).toBe(true);
    }
  });

  it('documents black-box and white-box testing for loop governance', () => {
    const testDesign = read('docs/testing/loop-governance-test-design.md');

    expect(testDesign).toContain('White-Box Tests');
    expect(testDesign).toContain('Module Black-Box Tests');
    expect(testDesign).toContain('Kill switch active fixture');
    expect(testDesign).toContain('Invalid `mainline_call_id` fixture');
    expect(testDesign).toContain('L1 action request fixture');
  });

  it('keeps L2 and L3 disabled until explicit upgrade criteria are satisfied', () => {
    const manifest = readManifest();
    const loop = read('docs/loops/LOOP.md');

    expect(manifest.upgrade_policy.l2_requires_human_approval).toBe(true);
    expect(manifest.upgrade_policy.l2_requires_maker_checker).toBe(true);
    expect(manifest.upgrade_policy.l2_max_attempts_per_item).toBe(3);
    expect(manifest.upgrade_policy.l3_enabled).toBe(false);
    expect(loop).toContain('L2 and L3 are not enabled by this initialization');
  });
});
