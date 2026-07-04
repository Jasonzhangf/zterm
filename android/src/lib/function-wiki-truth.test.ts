import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const requiredDocs = [
  'docs/wiki/daemon.md',
  'docs/wiki/cli.md',
  'docs/wiki/mainline-source.md',
  'docs/wiki/mainline-call-map.json',
  'docs/wiki/generated/daemon.html',
  'docs/wiki/generated/cli.html',
  'docs/wiki/generated/mainline-source.html',
] as const;

const requiredFunctionMapIds = [
  'daemon.runtime_entry',
  'daemon.cli_shell',
  'daemon.cli_node',
  'daemon.support',
  'mainline_source.android',
  'mainline_source.daemon',
  'mainline_source.cli',
] as const;

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function resolvePath(relativePath: string) {
  const androidPath = join(root, relativePath);
  if (existsSync(androidPath)) return androidPath;

  const repoPath = join(root, '..', relativePath);
  if (existsSync(repoPath)) return repoPath;

  return null;
}

describe('function wiki truth gate', () => {
  it('keeps worker wiki md files and generated mermaid html files present', () => {
    for (const relativePath of requiredDocs) {
      expect(existsSync(join(root, relativePath))).toBe(true);
    }
  });

  it('keeps daemon and cli function ids in the function map', () => {
    const functionMap = read('docs/function-map.md');
    for (const id of requiredFunctionMapIds) {
      expect(functionMap).toContain(id);
    }
    expect(functionMap).toContain('zterm-daemon.sh run');
    expect(functionMap).toContain('configure-relay');
    expect(functionMap).toContain('src/server/server.ts');
  });

  it('keeps architecture and workflow linked to worker wiki truth sources', () => {
    const architecture = read('docs/architecture.md');
    const workflow = read('docs/dev-workflow.md');

    for (const path of [
      'docs/wiki/daemon.md',
      'docs/wiki/cli.md',
      'docs/wiki/mainline-source.md',
    ]) {
      expect(architecture).toContain(path);
      expect(workflow).toContain(path);
    }
    expect(architecture).toContain('scripts/build-function-wiki.mjs');
  });

  it('keeps wiki pages aligned with daemon and cli mainline source owners', () => {
    const daemon = read('docs/wiki/daemon.md');
    const cli = read('docs/wiki/cli.md');
    const mainline = read('docs/wiki/mainline-source.md');

    expect(daemon).toContain('feature_id`: `daemon.runtime_entry');
    expect(daemon).toContain('src/server/server.ts');
    expect(daemon).toContain('terminal-mirror-runtime.ts');
    expect(daemon).toContain('remote-screenshot-daemon.ts');

    expect(cli).toContain('feature_id`: `daemon.cli_shell');
    expect(cli).toContain('scripts/zterm-daemon.sh');
    expect(cli).toContain('install-service');
    expect(cli).toContain('configure-relay');

    expect(mainline).toContain('Android Mainline');
    expect(mainline).toContain('Daemon Mainline');
    expect(mainline).toContain('CLI Mainline');
  });

  it('keeps the machine-readable mainline call map aligned with wiki nodes and registry owners', () => {
    const manifest = JSON.parse(read('docs/wiki/mainline-call-map.json')) as {
      schema_version: number;
      lifecycles: Array<{
        lifecycle_id: string;
        title: string;
        entrypoint: string;
        owner_feature: string;
        canonical_docs: string[];
        verification_gates: string[];
        nodes: Array<{ id: string; label: string }>;
        edges: Array<{ from: string; to: string; owner_feature: string; status: string; edge_id?: string }>;
      }>;
    };
    const mainline = read('docs/wiki/mainline-source.md');
    const registry = JSON.parse(read('docs/feature-registry.json')) as {
      features: Array<{ feature_id: string }>;
    };
    const featureIds = new Set(registry.features.map((feature) => feature.feature_id));

    expect(manifest.schema_version).toBe(1);
    expect(manifest.lifecycles.map((lifecycle) => lifecycle.lifecycle_id)).toEqual([
      'android_mainline',
      'daemon_mainline',
      'cli_mainline',
    ]);

    for (const lifecycle of manifest.lifecycles) {
      expect(mainline).toContain(lifecycle.title);
      expect(featureIds.has(lifecycle.owner_feature), lifecycle.owner_feature).toBe(true);

      const nodeIds = new Set(lifecycle.nodes.map((node) => node.id));
      expect(nodeIds.has(lifecycle.entrypoint), lifecycle.entrypoint).toBe(true);

      for (const docPath of lifecycle.canonical_docs) {
        expect(resolvePath(docPath), docPath).not.toBeNull();
      }

      for (const gatePath of lifecycle.verification_gates) {
        expect(resolvePath(gatePath), gatePath).not.toBeNull();
      }

      for (const node of lifecycle.nodes) {
        expect(mainline, node.id).toContain(node.id);
      }

      for (const edge of lifecycle.edges) {
        const expectedEdgeId = `${lifecycle.lifecycle_id}:${edge.from}->${edge.to}`;
        expect(nodeIds.has(edge.from), `${lifecycle.lifecycle_id}:${edge.from}`).toBe(true);
        expect(nodeIds.has(edge.to), `${lifecycle.lifecycle_id}:${edge.to}`).toBe(true);
        expect(featureIds.has(edge.owner_feature), edge.owner_feature).toBe(true);
        expect(['anchored', 'partial', 'binding pending']).toContain(edge.status);
        expect(edge.edge_id).toBe(expectedEdgeId);
      }
    }
  });

  it('keeps generated html offline and sourced from mermaid diagrams', () => {
    for (const file of ['daemon', 'cli', 'mainline-source']) {
      const md = read(`docs/wiki/${file}.md`);
      const html = read(`docs/wiki/generated/${file}.html`);
      expect(md).toContain('```mermaid');
      expect(html).toContain('<svg class="wiki-graph"');
      expect(html).toContain('<pre class="source">');
      expect(html).toContain('flowchart TD');
      expect(html).not.toContain('cdn.jsdelivr.net');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('https://');
    }
  });
});
