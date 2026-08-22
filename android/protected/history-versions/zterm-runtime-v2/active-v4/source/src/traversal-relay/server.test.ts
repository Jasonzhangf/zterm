import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  const main = readFileSync(join(process.cwd(), 'src/traversal-relay/server.ts'), 'utf8');
  const helpers = readFileSync(join(process.cwd(), 'src/traversal-relay/server-helpers.ts'), 'utf8');
  return `${main}\n${helpers}`;
}

function readRtcBridgeSource() {
  return readFileSync(join(process.cwd(), 'src/server/rtc-bridge.ts'), 'utf8');
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

  it('keeps relay device stream heartbeat on typed control envelopes', () => {
    const source = readServerSource();
    const deviceStart = source.indexOf('function registerDeviceStream');
    const deviceSource = source.slice(deviceStart);

    expect(source).toContain("'control-ping'");
    expect(source).toContain("'control-pong'");
    expect(deviceSource).toContain("message.type === 'control-ping'");
    expect(deviceSource).toContain("type: 'control-pong'");
    expect(deviceSource).toContain('receivedAt: Date.now()');
    expect(deviceSource).not.toContain("type: 'ping'");
    expect(deviceSource).not.toContain("type: 'pong'");
  });

  it('binds relay client debug logs and snapshots to the authenticated connection device', () => {
    const source = readServerSource();

    expect(source).toContain('const relayDeviceId = connection.deviceId;');
    expect(source).toContain('deviceId mismatch for client-debug-log');
    expect(source).toContain('deviceId mismatch for client-debug-snapshot');
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

  it('retires stale persisted device bindings before accepting a new daemon registration', () => {
    const source = readServerSource();
    const hostStart = source.indexOf('function registerHost');
    const hostEnd = source.indexOf('function registerClient');
    const hostSource = source.slice(hostStart, hostEnd);

    expect(hostSource).toContain('store.clearOtherDaemonHostBindings');
    expect(hostSource.indexOf('store.clearOtherDaemonHostBindings')).toBeLessThan(
      hostSource.indexOf('hosts.set(key, host)'),
    );
  });

  it('keeps client relay peers idle for 30 minutes after signaling close before notifying the daemon', () => {
    const source = readServerSource();

    const clientStart = source.indexOf('function registerClient');
    const deviceStart = source.indexOf('function registerDeviceStream');
    const clientSource = source.slice(clientStart, deviceStart);

    expect(source).toContain('RELAY_CLIENT_PEER_IDLE_TIMEOUT_MS = 30 * 60 * 1000');
    expect(source).toContain('markClientPeerIdle');
    expect(source).toContain('setTimeout(() => closeIdleClientPeer');

    expect(clientSource).not.toContain("reason: 'client relay websocket closed'");
    expect(clientSource).not.toContain("reason: 'client relay websocket error'");
    expect(clientSource).toContain("markClientPeerIdle(client, 'client relay websocket closed')");
    expect(clientSource).toContain("markClientPeerIdle(client, 'client relay websocket error')");
  });

  it('keys relay peer leases by the concrete client device and rebinds only that client before idle expiry', () => {
    const source = readServerSource();
    const clientStart = source.indexOf('function registerClient');
    const deviceStart = source.indexOf('function registerDeviceStream');
    const clientSource = source.slice(clientStart, deviceStart);

    expect(source).toContain('function clientPeerLeaseKey(userId: string, hostId: string, deviceId: string)');
    expect(source).toContain('if (!normalizedDeviceId)');
    expect(source).toContain('return null');
    expect(source).not.toContain("deviceId || 'anonymous'");
    expect(clientSource).toContain('!user || !hostId || !deviceId');
    expect(clientSource).toContain("deviceId is required");
    expect(source).toContain('function findActiveClientPeerByLeaseKey');
    expect(source).toContain('function bindClientPeerSocket');
    expect(source).toContain("previousSocket.close(1000, 'relay client socket replaced')");
    expect(source).toContain('if (client.socket !== ws || !clients.has(client.peerId))');
    expect(source).toContain('clearIdleClientPeersForHost(host.userId, host.hostId, reason)');
  });

  it('lets relay resume renegotiate the same peer id instead of ignoring a second rtc-init', () => {
    const rtcBridgeSource = readRtcBridgeSource();
    const initStart = rtcBridgeSource.indexOf("if (message.type === 'rtc-init')");
    const initBlock = rtcBridgeSource.slice(initStart, initStart + 260);

    expect(rtcBridgeSource).toContain('function initializePeerConnection');
    expect(rtcBridgeSource).toContain("peer.transport.close('rtc peer replaced by new init')");
    expect(rtcBridgeSource).toContain('peer.ready = false');
    expect(initBlock).toContain('initializePeerConnection(peer, message.payload)');
    expect(initBlock).not.toContain('if (peer.peerConnection)');
  });
});
