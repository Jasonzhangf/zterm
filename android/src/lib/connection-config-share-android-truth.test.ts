import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const androidRoot = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(androidRoot, relativePath), 'utf8');
}

describe('connection config share Android entry truth', () => {
  it('keeps the native zterm import intent filter wired to the appUrlOpen importer', () => {
    const manifest = read('native/android/app/src/main/AndroidManifest.xml');
    const appSource = read('src/App.tsx');

    expect(manifest).toContain('android.intent.action.VIEW');
    expect(manifest).toContain('android:scheme="zterm"');
    expect(manifest).toContain('android:host="connection"');
    expect(manifest).toContain('android:path="/import"');
    expect(appSource).toContain("CapacitorApp.addListener('appUrlOpen'");
    expect(appSource).toContain('zterm://connection/import');
    expect(appSource).toContain('parseConnectionConfigShareLink');
    expect(appSource).toContain('parsed.hosts.map((host) => upsertHost(host))');
    expect(appSource).not.toContain('upsertHost(parsed.host)');
  });
});
