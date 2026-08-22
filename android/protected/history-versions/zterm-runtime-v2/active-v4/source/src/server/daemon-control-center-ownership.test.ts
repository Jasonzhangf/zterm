import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

const forbiddenDaemonControlCenterImports = [
  './terminal-message-runtime',
  './terminal-runtime',
  './terminal-mirror-runtime',
  './terminal-transport-runtime',
  './daemon-input-queue-runtime',
  './terminal-file-transfer-runtime',
  './remote-window-stream-daemon',
  './server',
  './terminal-message-control-runtime',
];

describe('daemon control ownership red gate', () => {
  it('keeps DaemonControlCenter a generic router without server/data-plane imports', () => {
    const source = read('src/server/daemon-control-center-runtime.ts');

    for (const forbidden of forbiddenDaemonControlCenterImports) {
      expect(source).not.toContain(`from '${forbidden}'`);
      expect(source).not.toContain(`from "${forbidden}"`);
    }
    expect(source).toContain("from '@zterm/shared/terminal/control-contract'");
  });

  it('keeps the daemon control gateway limited to typed command/owner adapters', () => {
    const source = read('src/server/daemon-control-gateway-runtime.ts');

    expect(source).toContain("from './daemon-control-center-runtime'");
    expect(source).toContain("from './terminal-message-control-runtime'");
    expect(source).toContain("from './terminal-runtime-types'");
    expect(source).not.toContain("from './terminal-message-runtime'");
    expect(source).not.toContain("from './terminal-mirror-runtime'");
    expect(source).not.toContain("from './terminal-transport-runtime'");
    expect(source).not.toContain("from './daemon-input-queue-runtime'");
    expect(source).not.toContain("from './terminal-file-transfer-runtime'");
    expect(source).not.toContain("from './server'");
  });
});
