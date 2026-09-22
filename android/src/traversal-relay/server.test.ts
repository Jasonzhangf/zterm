import { spawn, type ChildProcess } from 'child_process';
import { createServer as createNetServer } from 'net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

function readServerSource() {
  const main = readFileSync(join(process.cwd(), 'src/traversal-relay/server.ts'), 'utf8');
  const helpers = readFileSync(join(process.cwd(), 'src/traversal-relay/server-helpers.ts'), 'utf8');
  return `${main}\n${helpers}`;
}

function readRtcBridgeSource() {
  return readFileSync(join(process.cwd(), 'src/server/rtc-bridge.ts'), 'utf8');
}

function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate relay test port')));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHttpOk(url: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`relay server did not become healthy: ${lastError}`);
}

async function startRelayServer() {
  const port = await availablePort();
  const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-relay-host-replace-test-'));
  const updatesDir = join(tempRoot, 'updates');
  mkdirSync(updatesDir, { recursive: true });
  writeFileSync(join(updatesDir, 'latest.json'), '{"versionCode":1,"apkUrl":"noop.apk"}\n');
  writeFileSync(join(updatesDir, 'noop.apk'), 'noop');

  const output: string[] = [];
  const child = spawn(join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['src/traversal-relay/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ZTERM_TRAVERSAL_HOST: '127.0.0.1',
      ZTERM_TRAVERSAL_PORT: String(port),
      ZTERM_TRAVERSAL_BASE_PATH: '',
      ZTERM_TRAVERSAL_DATA_DIR: join(tempRoot, 'data'),
      ZTERM_TRAVERSAL_UPDATES_DIR: updatesDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHttpOk(`${baseUrl}/health`);
  } catch (error) {
    await stopRelayServer(child, tempRoot);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.join('')}`);
  }
  return { baseUrl, wsBaseUrl: `ws://127.0.0.1:${port}`, child, tempRoot, output };
}

async function stopRelayServer(child: ChildProcess, tempRoot: string) {
  if (child.exitCode === null && !child.killed) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGKILL');
        }
        resolve();
      }, 3000);
      timeout.unref?.();
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

async function registerAndLogin(baseUrl: string) {
  const username = `relay-host-replace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const password = `pw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(registerResponse.status).toBe(201);
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const login = await loginResponse.json() as { accessToken?: string };
  expect(loginResponse.ok).toBe(true);
  expect(login.accessToken).toBeTruthy();
  return login.accessToken as string;
}

function waitForEnvelope<T extends Record<string, unknown>>(
  socket: WebSocket,
  predicate: (envelope: T) => boolean,
  timeoutMs = 5000,
) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('relay envelope timeout'));
    }, timeoutMs);
    timeout.unref?.();
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onMessage = (raw: WebSocket.RawData) => {
      const envelope = JSON.parse(String(raw)) as T;
      if (!predicate(envelope)) return;
      cleanup();
      resolve(envelope);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`websocket closed while waiting: ${code} ${reason.toString()}`));
    };
    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function waitForClose(socket: WebSocket, timeoutMs = 5000) {
  return new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('websocket close timeout')), timeoutMs);
    timeout.unref?.();
    socket.once('close', (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function openSocket(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`websocket open timeout: ${url}`)), 5000);
    timeout.unref?.();
    socket.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return socket;
}

async function connectHost(wsBaseUrl: string, accessToken: string, hostId: string, deviceId: string) {
  const socket = await openSocket(
    `${wsBaseUrl}/ws/host?token=${encodeURIComponent(accessToken)}&hostId=${encodeURIComponent(hostId)}&deviceId=${encodeURIComponent(deviceId)}&deviceName=${encodeURIComponent(deviceId)}&platform=test&appVersion=test&daemonVersion=test`,
  );
  await waitForEnvelope(socket, (envelope: { type?: string }) => envelope.type === 'relay-ready');
  return socket;
}

async function connectClient(wsBaseUrl: string, accessToken: string, hostId: string, deviceId: string) {
  return await openSocket(
    `${wsBaseUrl}/ws/client?token=${encodeURIComponent(accessToken)}&hostId=${encodeURIComponent(hostId)}&deviceId=${encodeURIComponent(deviceId)}`,
  );
}

async function waitForDirectoryDevice(
  baseUrl: string,
  accessToken: string,
  hostId: string,
  deviceId: string,
  sessionName: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastDirectory: unknown = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/directory`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.ok).toBe(true);
    const payload = await response.json() as { directory?: { devices?: Array<any> } };
    lastDirectory = payload.directory;
    const matches = payload.directory?.devices?.filter((device) => device?.daemon?.hostId === hostId) || [];
    if (
      matches.length === 1
      && matches[0]?.deviceId === deviceId
      && matches[0]?.daemon?.presence?.connected === true
      && matches[0]?.daemon?.sessions?.length === 1
      && matches[0]?.daemon?.sessions?.[0]?.name === sessionName
    ) {
      return matches[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`directory device timeout: ${JSON.stringify(lastDirectory)}`);
}

function publishDirectory(socket: WebSocket, sessionName: string) {
  socket.send(JSON.stringify({
    type: 'directory-update',
    directory: {
      endpoints: [],
      sessions: [{ name: sessionName, updatedAt: new Date().toISOString() }],
      publishedAt: new Date().toISOString(),
    },
  }));
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

  it('replaces the authenticated stable host generation without letting the old socket retire the new host', () => {
    const source = readServerSource();
    const closeHostStart = source.indexOf('function closeHost');
    const registerHostStart = source.indexOf('function registerHost');
    const registerHostEnd = source.indexOf('function registerClient');
    const closeHostSource = source.slice(closeHostStart, registerHostStart);
    const hostSource = source.slice(registerHostStart, registerHostEnd);

    expect(hostSource).not.toContain('host ${hostId} already connected');
    expect(hostSource).toContain('const replacedHost = hosts.get(key)');
    expect(hostSource).toContain("replacedHost.socket.close(1012, 'host relay replaced')");
    expect(hostSource.indexOf('hosts.set(key, host)')).toBeLessThan(
      hostSource.indexOf("replacedHost.socket.close(1012, 'host relay replaced')"),
    );
    expect(hostSource).toContain('if (hosts.get(key) !== host)');
    expect(closeHostSource).toContain('if (hosts.get(key) !== host)');
    expect(closeHostSource).toContain('closeHostPeers(host.userId, host.hostId, reason)');
  });

  it('executes stable host replacement without stale old-socket callbacks retiring the new host', async () => {
    const relay = await startRelayServer();
    const sockets: WebSocket[] = [];
    try {
      const accessToken = await registerAndLogin(relay.baseUrl);
      const hostId = 'stable-host';
      const oldHost = await connectHost(relay.wsBaseUrl, accessToken, hostId, 'daemon-old');
      sockets.push(oldHost);
      publishDirectory(oldHost, 'old-session');
      await waitForDirectoryDevice(relay.baseUrl, accessToken, hostId, 'daemon-old', 'old-session');

      const oldClient = await connectClient(relay.wsBaseUrl, accessToken, hostId, 'phone-a');
      sockets.push(oldClient);
      oldClient.send(JSON.stringify({ type: 'rtc-init', payload: { marker: 'old-client' } }));
      const oldPeer = await waitForEnvelope(oldHost, (envelope: { type?: string; peerId?: string }) => (
        envelope.type === 'relay-signal' && Boolean(envelope.peerId)
      ));

      const oldHostClose = waitForClose(oldHost);
      const oldClientClose = waitForClose(oldClient);
      const replacementHost = await connectHost(relay.wsBaseUrl, accessToken, hostId, 'daemon-new');
      sockets.push(replacementHost);
      expect(await oldHostClose).toEqual({ code: 1012, reason: 'host relay replaced' });
      expect(await oldClientClose).toEqual({ code: 1013, reason: 'host relay replaced' });

      publishDirectory(replacementHost, 'new-session');
      await waitForDirectoryDevice(relay.baseUrl, accessToken, hostId, 'daemon-new', 'new-session');

      const replacementClient = await connectClient(relay.wsBaseUrl, accessToken, hostId, 'phone-a');
      sockets.push(replacementClient);
      replacementClient.send(JSON.stringify({ type: 'rtc-init', payload: { marker: 'replacement-client' } }));
      const replacementPeer = await waitForEnvelope(replacementHost, (envelope: { type?: string; peerId?: string }) => (
        envelope.type === 'relay-signal' && Boolean(envelope.peerId)
      ));
      expect(replacementPeer.peerId).not.toBe(oldPeer.peerId);

      const siblingHost = await connectHost(relay.wsBaseUrl, accessToken, 'sibling-host', 'daemon-sibling');
      sockets.push(siblingHost);
      publishDirectory(siblingHost, 'sibling-session');
      await waitForDirectoryDevice(relay.baseUrl, accessToken, hostId, 'daemon-new', 'new-session');
      await waitForDirectoryDevice(relay.baseUrl, accessToken, 'sibling-host', 'daemon-sibling', 'sibling-session');
    } finally {
      for (const socket of sockets) {
        if (socket.readyState < WebSocket.CLOSING) {
          socket.close(1000, 'test cleanup');
        }
      }
      await stopRelayServer(relay.child, relay.tempRoot);
    }
  }, 15_000);

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
    expect(source).toContain('clearIdleClientPeersForHost(userId, hostId, reason)');
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
