import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'verify-web-assets-version.mjs');

function runFixture(contents, buildNumber = '2664') {
  const directory = mkdtempSync(join(tmpdir(), 'zterm-web-assets-'));
  writeFileSync(join(directory, 'index.js'), contents);
  const result = spawnSync(process.execPath, [script, directory, buildNumber], { encoding: 'utf8' });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

function runApkFixture(contents, buildNumber = '2664') {
  const directory = mkdtempSync(join(tmpdir(), 'zterm-web-assets-apk-'));
  const assetDirectory = join(directory, 'assets', 'public');
  const apkPath = join(directory, 'fixture.apk');
  mkdirSync(assetDirectory, { recursive: true });
  writeFileSync(join(assetDirectory, 'index.js'), contents);
  const archiveResult = spawnSync('zip', ['-qr', apkPath, 'assets'], { cwd: directory });
  if (archiveResult.status !== 0) {
    throw new Error(archiveResult.stderr || 'zip fixture failed');
  }
  const result = spawnSync(process.execPath, [script, apkPath, buildNumber], { encoding: 'utf8' });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

describe('Android WebView asset version gate', () => {
  it('accepts assets whose embedded version matches the build number', () => {
    const result = runFixture('const version = "0.1.3.2664"; const code = "1100026640";');
    expect(result.status).toBe(0);
  });

  it('rejects stale assets even when the native build number is current', () => {
    const result = runFixture('const version = "0.1.3.1001"; const code = "1100010010";');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('web assets do not contain 0.1.3.2664');
  });

  it('rejects a stale WebView bundle inside an APK with a current native version', () => {
    const result = runApkFixture('const version = "0.1.3.1001"; const code = "1100010010";');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('web assets do not contain 0.1.3.2664');
  });
});
