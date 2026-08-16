import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

describe('daemon session catalog ownership gates', () => {
  it('keeps backend session catalog construction in the dedicated daemon owner', () => {
    const catalogSource = read('src/server/daemon-session-catalog-runtime.ts');
    const controlSource = read('src/server/terminal-message-control-runtime.ts');

    expect(catalogSource).toContain('export function buildSessionsCatalogPayload');
    expect(catalogSource).toContain('export function handleListSessionsMessageRuntime');
    expect(catalogSource).toContain("from './terminal-session-activity-runtime'");

    expect(controlSource).not.toContain('function buildSessionsCatalogPayload(');
    expect(controlSource).not.toContain('function handleListSessionsMessageRuntime(');
    expect(controlSource).not.toContain('list_sessions_failed');
    expect(controlSource).toContain("from './daemon-session-catalog-runtime'");
  });

  it('keeps list-sessions delegation on the gateway pointing at the catalog owner', () => {
    const gatewaySource = read('src/server/daemon-control-gateway-runtime.ts');

    expect(gatewaySource).toContain(
      "import { handleListSessionsMessageRuntime } from './daemon-session-catalog-runtime';",
    );
    const controlImportStart = gatewaySource.indexOf("from './terminal-message-control-runtime'");
    expect(controlImportStart).toBeGreaterThanOrEqual(0);
    const importOpenBrace = gatewaySource.lastIndexOf('import {', controlImportStart);
    const controlImportBlock = gatewaySource.slice(importOpenBrace, controlImportStart + 60);
    expect(controlImportBlock).not.toContain('handleListSessionsMessageRuntime');
  });

  it('forbids the catalog owner from importing server/mirror/transport/control god runtimes', () => {
    const source = read('src/server/daemon-session-catalog-runtime.ts');

    for (const forbidden of [
      './terminal-message-control-runtime',
      './terminal-message-runtime',
      './terminal-mirror-runtime',
      './terminal-transport-runtime',
      './terminal-runtime',
      './daemon-input-queue-runtime',
      './terminal-file-transfer-runtime',
      './remote-window-stream-daemon',
      './server',
    ]) {
      expect(source, forbidden).not.toContain(`from '${forbidden}'`);
      expect(source, forbidden).not.toContain(`from "${forbidden}"`);
    }
  });
});
