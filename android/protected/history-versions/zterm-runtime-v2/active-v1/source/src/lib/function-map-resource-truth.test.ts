import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

describe('function map resource truth gate', () => {
  it('keeps function map bound to the resource registry', () => {
    const functionMap = read('docs/function-map.md');

    expect(functionMap).toContain('## Resource Binding Map');
    expect(functionMap).toContain('docs/resource-registry.json');
    expect(functionMap).toContain('docs/resource-map.md');
  });

  it('does not invent resource ids outside the registry', () => {
    const registry = JSON.parse(read('docs/resource-registry.json')) as {
      resources: Array<{ resource_id: string }>;
    };
    const functionMap = read('docs/function-map.md');
    const resourceIds = new Set(registry.resources.map((resource) => resource.resource_id));
    const referencedResourceIds = Array.from(functionMap.matchAll(/`(resource\.[a-z0-9_]+)`/g)).map((match) => match[1]);

    expect(referencedResourceIds.length).toBeGreaterThan(20);

    for (const resourceId of referencedResourceIds) {
      expect(resourceIds.has(resourceId), resourceId).toBe(true);
    }
  });

  it('binds critical global features to resource ids', () => {
    const functionMap = read('docs/function-map.md');

    for (const featureId of [
      'terminal.open_tabs',
      'terminal.transport_lifecycle',
      'terminal.daemon_input',
      'terminal.buffer_render',
      'terminal.keyboard_ime',
      'daemon.runtime_entry',
      'daemon.windows_wezterm_backend',
      'daemon.cli_shell',
      'daemon.cli_node',
      'daemon.support',
      'mainline_source.android',
      'mainline_source.daemon',
      'mainline_source.cli',
    ]) {
      const line = functionMap.split('\n').find((row) => row.includes(`\`${featureId}\``) && row.includes('resource.'));
      expect(line, featureId).toBeTruthy();
    }
  });
});
