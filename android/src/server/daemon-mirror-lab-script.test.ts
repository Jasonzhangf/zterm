import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('daemon mirror lab isolation gate', () => {
  it('uses an isolated managed-daemon test port instead of the user configured service port', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain('ZTERM_TEST_DAEMON_PORT');
    expect(script).toContain("process.env.ZTERM_TEST_DAEMON_PORT || '46333'");
    expect(script).not.toContain("process.env.ZTERM_PORT || config.port || 45761");
    expect(script).toContain("const port = useManagedDaemon ? MANAGED_DAEMON_TEST_PORT : String(config.port)");
  });

  it('spawns tsx directly instead of asking node to execute the shell shim', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain("spawn(tsxBin, ['src/server/server.ts']");
    expect(script).not.toContain("spawn(process.execPath, [tsxBin, 'src/server/server.ts']");
  });
});
