import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const requiredDocs = [
  'docs/wiki/daemon.md',
  'docs/wiki/cli.md',
  'docs/wiki/mainline-source.md',
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

  it('keeps generated html sourced from mermaid diagrams', () => {
    for (const file of ['daemon', 'cli', 'mainline-source']) {
      const md = read(`docs/wiki/${file}.md`);
      const html = read(`docs/wiki/generated/${file}.html`);
      expect(md).toContain('```mermaid');
      expect(html).toContain('<div class="mermaid">');
      expect(html).toContain('flowchart TD');
    }
  });
});
