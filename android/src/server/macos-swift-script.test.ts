import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  prepareSwiftScript,
  resolveCachedSwiftScript,
  swiftScriptCacheKey,
  swiftScriptCachePath,
} from './macos-swift-script';

const SOURCE = 'print("zterm-swift-script-cache-ok")\n';

describe('macos swift script cache', () => {
  let cacheDir = '';
  const previousCacheDir = process.env.ZTERM_SWIFT_SCRIPT_CACHE_DIR;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'zterm-swift-cache-test-'));
    process.env.ZTERM_SWIFT_SCRIPT_CACHE_DIR = cacheDir;
  });

  afterEach(() => {
    if (previousCacheDir === undefined) {
      delete process.env.ZTERM_SWIFT_SCRIPT_CACHE_DIR;
    } else {
      process.env.ZTERM_SWIFT_SCRIPT_CACHE_DIR = previousCacheDir;
    }
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('keys the cache by source and swift version', () => {
    expect(swiftScriptCacheKey(SOURCE, '5')).toBe(swiftScriptCacheKey(SOURCE, '5'));
    expect(swiftScriptCacheKey(SOURCE, '5')).not.toBe(swiftScriptCacheKey(`${SOURCE}print(1)\n`, '5'));
    expect(swiftScriptCacheKey(SOURCE, '5')).not.toBe(swiftScriptCacheKey(SOURCE, '6'));
  });

  it('reports no cached command before the source was compiled', () => {
    expect(resolveCachedSwiftScript(SOURCE, '5')).toBeNull();
  });

  it('compiles the source once and reuses the cached binary', async () => {
    const command = await prepareSwiftScript({ swiftBinary: 'swift', source: SOURCE });
    if (command.args.length > 0) {
      // No Swift toolchain on this host: the documented interpreter command is
      // the only available path, so there is nothing to assert about the cache.
      expect(command).toEqual({ command: 'swift', args: ['-swift-version', '5', '-e', SOURCE] });
      return;
    }
    expect(command.command).toBe(swiftScriptCachePath(SOURCE, '5'));
    expect(existsSync(command.command)).toBe(true);
    expect(execFileSync(command.command, { encoding: 'utf8' })).toContain('zterm-swift-script-cache-ok');
    expect(resolveCachedSwiftScript(SOURCE, '5')).toEqual({ command: command.command, args: [] });
    await expect(prepareSwiftScript({ swiftBinary: 'swift', source: SOURCE })).resolves.toEqual(command);
  }, 180_000);

  it('falls back to the interpreter command when the compiler is unavailable', async () => {
    await expect(
      prepareSwiftScript({ swiftBinary: '/nonexistent/zterm-swift', source: SOURCE }),
    ).resolves.toEqual({ command: '/nonexistent/zterm-swift', args: ['-swift-version', '5', '-e', SOURCE] });
    expect(resolveCachedSwiftScript(SOURCE, '5')).toBeNull();
  }, 60_000);
});