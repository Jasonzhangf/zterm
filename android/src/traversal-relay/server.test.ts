import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src/traversal-relay/server.ts'), 'utf8');
}

describe('traversal relay server directory contract', () => {
  it('exposes an authenticated account directory HTTP endpoint', () => {
    const source = readServerSource();

    expect(source).toContain("pathname === routePath('/api/directory')");
    expect(source).toContain("message: 'unauthorized'");
    expect(source).toContain('directory: store.getAccountDirectory(user.id)');
  });

  it('serves update manifest and APK assets from the relay updates directory', () => {
    const source = readServerSource();

    expect(source).toContain('ZTERM_TRAVERSAL_UPDATES_DIR');
    expect(source).toContain("pathname === routePath('/updates/latest.json')");
    expect(source).toContain("pathname.startsWith(routePath('/updates/'))");
    expect(source).toContain("request.method === 'GET' || request.method === 'HEAD'");
    expect(source).toContain("request.method === 'HEAD'");
    expect(source).toContain("response.setHeader('Content-Length', fileStat.size)");
    expect(source).toContain('createReadStream(filePath).pipe(response)');
    expect(source).toContain("message: 'update manifest not found'");
  });

  it('broadcasts directory snapshots alongside legacy device snapshots', () => {
    const source = readServerSource();

    const broadcastStart = source.indexOf('function broadcastDevices');
    const broadcastEnd = source.indexOf('async function handleHttpRequest');
    const broadcastSource = source.slice(broadcastStart, broadcastEnd);

    expect(broadcastSource).toContain("type: 'devices-snapshot'");
    expect(broadcastSource).toContain("type: 'directory-snapshot'");
    expect(broadcastSource).toContain('store.getAccountDirectory(userId)');
  });

  it('lets authenticated daemon hosts publish directory updates without crossing signaling ownership', () => {
    const source = readServerSource();

    const hostStart = source.indexOf('function registerHost');
    const hostEnd = source.indexOf('function registerClient');
    const hostSource = source.slice(hostStart, hostEnd);

    expect(hostSource).toContain("envelope.type === 'directory-update'");
    expect(hostSource).toContain('store.publishDaemonDirectory');
    expect(hostSource).toContain('broadcastDevices(user.id)');
    expect(hostSource).toContain("envelope.type !== 'relay-signal'");
  });
});
