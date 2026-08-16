import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readScript(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('relay server independent release package gates', () => {
  it('exposes relay server npm package scripts without sharing daemon package ownership', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

    expect(packageJson.scripts['relay:prepare-npm']).toBe('node ./scripts/prepare-relay-server-npm-package.mjs');
    expect(packageJson.scripts['relay:verify-package']).toBe('node ./scripts/verify-relay-server-package.mjs');
    expect(packageJson.scripts['daemon:prepare-npm']).toBe('node ./scripts/prepare-daemon-npm-package.mjs');
  });

  it('prepares a standalone relay server package with explicit env and smoke entrypoints', () => {
    expect(existsSync(join(process.cwd(), 'scripts/prepare-relay-server-npm-package.mjs'))).toBe(true);
    const script = readScript('scripts/prepare-relay-server-npm-package.mjs');

    expect(script).toContain("@jsonstudio/zterm-relay-server");
    expect(script).toContain("src/traversal-relay/server.ts");
    expect(script).toContain("bin/zterm-relay-server");
    expect(script).toContain("runtime/server.cjs");
    expect(script).toContain("runtime/smoke.cjs");
    expect(script).toContain("ZTERM_TRAVERSAL_BASE_PATH");
    expect(script).toContain("ZTERM_TRAVERSAL_STORE_PATH");
    expect(script).toContain("ZTERM_TRAVERSAL_UPDATES_DIR");
    expect(script).toContain("ZTERM_TURN_URL");
    expect(script).toContain("/relay/updates/latest.json");
    expect(script).toContain("zterm-relay-server smoke --base-url");
    expect(script).not.toContain("@jsonstudio/zterm-daemon");
    expect(script).not.toContain("zterm-daemon install-service");
  });

  it('verifies relay server tarballs independently from daemon tarballs', () => {
    expect(existsSync(join(process.cwd(), 'scripts/verify-relay-server-package.mjs'))).toBe(true);
    const script = readScript('scripts/verify-relay-server-package.mjs');

    expect(script).toContain("jsonstudio-zterm-relay-server");
    expect(script).toContain("package/bin/zterm-relay-server");
    expect(script).toContain("package/runtime/server.cjs");
    expect(script).toContain("package/runtime/smoke.cjs");
    expect(script).toContain("@jsonstudio/zterm-relay-server");
    expect(script).toContain("zterm-relay-server smoke --base-url");
    expect(script).not.toContain("jsonstudio-zterm-daemon");
  });

  it('does not expose TURN credentials from the public health endpoint', () => {
    const source = readScript('src/traversal-relay/server.ts');
    const healthStart = source.indexOf('function buildHealthSnapshot');
    const authStart = source.indexOf('function buildAuthPayload');
    const healthSource = source.slice(healthStart, authStart);

    expect(healthSource).toContain('buildHealthTurnSnapshot');
    expect(healthSource).not.toContain('turn: TURN_CONFIG');
  });
});
