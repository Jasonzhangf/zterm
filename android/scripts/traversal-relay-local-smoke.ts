import { spawn, spawnSync } from 'child_process';
import { createServer } from 'http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import { WebSocket } from 'ws';
import wrtc from '@roamhq/wrtc';
import { buildTraversalPlan } from '../src/lib/traversal/config';
import { selectBestTraversalRoute } from '../src/lib/traversal/route-selector';

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc as unknown as {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  RTCSessionDescription: typeof globalThis.RTCSessionDescription;
  RTCIceCandidate: typeof globalThis.RTCIceCandidate;
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const androidDir = join(scriptDir, '..');
const relayHostId = `local-smoke-${Date.now()}`;
const relayDeviceId = `device-${Date.now()}`;
const relayClientDeviceId = `client-${Date.now()}`;
const relayDeviceName = 'local-smoke-daemon';
const relayUsername = `smoke-${Date.now()}`;
const relayPassword = `smoke-${randomUUID()}`;
const tmuxSession = `zterm-relay-smoke-${Date.now()}`;
const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-traversal-smoke-'));
const tempHome = join(tempRoot, 'home');
const relayUpdatesDir = join(tempRoot, 'relay-updates');
mkdirSync(tempHome, { recursive: true });
mkdirSync(relayUpdatesDir, { recursive: true });
writeFileSync(join(relayUpdatesDir, 'zterm-relay-smoke.apk'), 'relay update smoke apk bytes');
writeFileSync(join(relayUpdatesDir, 'latest.json'), `${JSON.stringify({
  versionName: '0.0.0-relay-smoke',
  versionCode: 1,
  apkUrl: 'zterm-relay-smoke.apk',
  sha256: 'relay-smoke-sha',
  notes: [],
}, null, 2)}\n`);

const tsxBin = join(androidDir, 'node_modules', '.bin', 'tsx');

async function findAvailablePort(host: string) {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to resolve dynamic smoke port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

let relayPort = 0;
let daemonPort = 0;
let relayUrl = '';

let globalAccessToken = '';

function waitForExit(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function closeResource(label: string, close: () => void) {
  try {
    close();
  } catch (error) {
    console.warn(`[traversal-relay-local-smoke] Failed to close ${label}:`, error);
  }
}

async function waitForHealth(url: string, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`${label} health timeout: ${lastError}`);
}

async function registerAndLogin() {
  const registerResponse = await fetch(`${relayUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: relayUsername, password: relayPassword }),
  });
  const registerBody = await registerResponse.json();
  if (!registerResponse.ok) {
    throw new Error(`register failed: ${JSON.stringify(registerBody)}`);
  }

  const loginResponse = await fetch(`${relayUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: relayUsername, password: relayPassword }),
  });
  const loginBody = await loginResponse.json() as { accessToken?: string };
  if (!loginResponse.ok || !loginBody.accessToken) {
    throw new Error(`login failed: ${JSON.stringify(loginBody)}`);
  }
  return loginBody.accessToken;
}

async function fetchRelayUpdateSmoke() {
  const manifestUrl = `${relayUrl}/updates/latest.json`;
  const manifestResponse = await fetch(manifestUrl);
  const manifest = await manifestResponse.json() as { apkUrl?: string; versionCode?: number; versionName?: string };
  if (!manifestResponse.ok || manifest.apkUrl !== 'zterm-relay-smoke.apk') {
    throw new Error(`relay update manifest smoke failed: HTTP ${manifestResponse.status} ${JSON.stringify(manifest)}`);
  }
  const apkUrl = new URL(manifest.apkUrl, manifestUrl).toString();
  const apkResponse = await fetch(apkUrl);
  const apkText = await apkResponse.text();
  if (!apkResponse.ok || apkText !== 'relay update smoke apk bytes') {
    throw new Error(`relay update apk smoke failed: HTTP ${apkResponse.status} body=${JSON.stringify(apkText)}`);
  }
  return {
    manifestUrl,
    apkUrl,
    versionName: manifest.versionName || '',
    versionCode: manifest.versionCode || 0,
    bytes: apkText.length,
  };
}

async function waitForDaemonRelayRegistration(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [health, devicesPayload] = await Promise.all([
      fetch(`http://127.0.0.1:${daemonPort}/health`)
        .then((response) => response.json())
        .catch((error) => {
          console.warn('[traversal-relay-local-smoke] daemon health probe failed:', error);
          return null;
        }),
      fetch(`${relayUrl}/api/devices`, {
        headers: {
          authorization: `Bearer ${globalAccessToken}`,
        },
      })
        .then((response) => response.json())
        .catch((error) => {
          console.warn('[traversal-relay-local-smoke] relay devices probe failed:', error);
          return null;
        }),
    ]);
    if (
      health?.ok
      && Array.isArray(devicesPayload?.devices)
      && devicesPayload.devices.some((device: any) =>
        device?.deviceId === relayDeviceId
        && device?.daemon?.connected === true
        && device?.daemon?.hostId === relayHostId)
    ) {
      return {
        health,
        devices: devicesPayload.devices,
      };
    }
    await delay(250);
  }
  throw new Error('daemon relay registration timeout');
}

function directoryContainsSmokeSession(directory: any) {
  return Array.isArray(directory?.devices)
    && directory.devices.some((device: any) =>
      device?.deviceId === relayDeviceId
      && device?.daemon?.hostId === relayHostId
      && Array.isArray(device?.daemon?.endpoints)
      && device.daemon.endpoints.some((endpoint: any) =>
        endpoint?.kind === 'relay-rtc'
        && endpoint?.relayHostId === relayHostId)
      && Array.isArray(device?.daemon?.sessions)
      && device.daemon.sessions.some((session: any) => session?.name === tmuxSession));
}

async function waitForAccountDirectory(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastPayload: unknown = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${relayUrl}/api/directory`, {
      headers: {
        authorization: `Bearer ${globalAccessToken}`,
      },
    });
    const payload = await response.json();
    lastPayload = payload;
    if (response.ok && directoryContainsSmokeSession(payload.directory)) {
      return payload.directory;
    }
    await delay(250);
  }
  throw new Error(`account directory timeout: ${JSON.stringify(lastPayload)}`);
}

async function waitForDirectoryStreamSnapshot(socket: WebSocket, timeoutMs = 10_000) {
  socket.send(JSON.stringify({
    type: 'devices-request',
    payload: {
      deviceId: relayClientDeviceId,
      deviceName: 'local-smoke-client',
      platform: 'smoke-client',
      appVersion: 'smoke',
    },
  }));

  return await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('directory stream snapshot timeout'));
    }, timeoutMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', handleMessage);
      socket.off('error', handleError);
      socket.off('close', handleClose);
    };

    const handleMessage = (raw: unknown) => {
      try {
        const payload = JSON.parse(String(raw)) as { type?: string; payload?: { directory?: unknown } };
        const directory = payload.payload?.directory;
        if (payload.type === 'directory-snapshot' && directoryContainsSmokeSession(directory)) {
          cleanup();
          resolve(directory);
        }
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const handleError = () => {
      cleanup();
      reject(new Error('directory stream websocket error'));
    };

    const handleClose = () => {
      cleanup();
      reject(new Error('directory stream websocket closed before directory snapshot'));
    };

    socket.on('message', handleMessage);
    socket.on('error', handleError);
    socket.on('close', handleClose);
  });
}

function selectSmokeRouteFromDirectory(directory: any) {
  const daemonDevice = Array.isArray(directory?.devices)
    ? directory.devices.find((device: any) => device?.daemon?.hostId === relayHostId)
    : null;
  const endpoints = daemonDevice?.daemon?.endpoints || [];
  const relayWsBase = relayUrl.replace(/^http/, 'ws');
  const plan = buildTraversalPlan(
    {
      bridgeHost: '',
      bridgePort: daemonPort,
      relayHostId,
      daemonHostId: relayHostId,
      relayEndpointCandidates: endpoints,
      transportMode: 'auto',
    },
    {
      signalUrl: '',
      turnServerUrl: '',
      turnUsername: '',
      turnCredential: '',
      transportMode: 'auto',
      traversalPathPriority: ['tailscale', 'ipv6', 'ipv4', 'rtc-relay'],
      traversalRelay: {
        relayBaseUrl: relayUrl,
        accessToken: globalAccessToken,
        userId: String(directory?.user?.id || ''),
        username: String(directory?.user?.username || relayUsername),
        deviceId: relayClientDeviceId,
        deviceName: 'local-smoke-client',
        platform: 'smoke-client',
        wsDevicesUrl: `${relayWsBase}/ws/devices`,
        wsHostUrl: `${relayWsBase}/ws/host`,
        wsClientUrl: `${relayWsBase}/ws/client`,
        turnUrl: 'turn:127.0.0.1:3478?transport=udp',
        turnUsername: 'smoke-turn',
        turnCredential: 'smoke-turn',
        updatedAt: Date.now(),
      },
    },
  );
  const selection = selectBestTraversalRoute({
    candidates: plan.candidates,
    scope: {
      accountId: String(directory?.user?.id || ''),
      daemonHostId: relayHostId,
    },
  });
  if (!selection.selected) {
    throw new Error(`route selection failed: ${JSON.stringify(selection.diagnostics)}`);
  }
  return {
    selected: selection.selected,
    diagnostics: selection.diagnostics,
  };
}

async function connectDeviceStream(accessToken: string) {
  return await new Promise<{ socket: WebSocket; firstSnapshot: unknown[] }>((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${relayPort}/ws/devices?token=${encodeURIComponent(accessToken)}&deviceId=${encodeURIComponent(relayClientDeviceId)}&deviceName=${encodeURIComponent('local-smoke-client')}&platform=smoke-client&appVersion=smoke`,
    );
    const timeout = setTimeout(() => {
      reject(new Error('device stream timeout'));
    }, 10_000);
    timeout.unref?.();
    let settled = false;

    const finishResolve = (snapshot: unknown[]) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ socket, firstSnapshot: snapshot });
    };

    const finishReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'device-meta',
        payload: {
          deviceId: relayClientDeviceId,
          deviceName: 'local-smoke-client',
          platform: 'smoke-client',
          appVersion: 'smoke',
        },
      }));
    });

    socket.on('message', (raw) => {
      try {
        const payload = JSON.parse(String(raw)) as { type?: string; payload?: { devices?: unknown[] } };
        if (payload.type === 'devices-snapshot' && Array.isArray(payload.payload?.devices)) {
          finishResolve(payload.payload.devices);
        }
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.on('error', () => finishReject(new Error('device stream websocket error')));
    socket.on('close', () => finishReject(new Error('device stream websocket closed before snapshot')));
  });
}

async function connectReplacementHost(accessToken: string, hostId: string, deviceId: string) {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${relayPort}/ws/host?token=${encodeURIComponent(accessToken)}&hostId=${encodeURIComponent(hostId)}&deviceId=${encodeURIComponent(deviceId)}&deviceName=${encodeURIComponent(deviceId)}&platform=smoke&appVersion=smoke&daemonVersion=smoke`,
    );
    const timeout = setTimeout(() => reject(new Error(`replacement host ${deviceId} ready timeout`)), 10_000);
    timeout.unref?.();
    socket.on('message', (raw) => {
      const envelope = JSON.parse(String(raw)) as { type?: string; reason?: string };
      if (envelope.type === 'relay-error') {
        clearTimeout(timeout);
        reject(new Error(envelope.reason || 'replacement host relay error'));
        return;
      }
      if (envelope.type === 'relay-ready') {
        clearTimeout(timeout);
        resolve(socket);
      }
    });
    socket.on('error', () => {
      clearTimeout(timeout);
      reject(new Error(`replacement host ${deviceId} websocket error`));
    });
  });
}

async function waitForReplacementDirectory(
  accessToken: string,
  hostId: string,
  deviceId: string,
  sessionName: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastDirectory: any = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${relayUrl}/api/directory`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const payload = await response.json() as { directory?: any };
    lastDirectory = payload.directory;
    const matching = Array.isArray(payload.directory?.devices)
      ? payload.directory.devices.filter((device: any) => device?.daemon?.hostId === hostId)
      : [];
    if (
      matching.length === 1
      && matching[0]?.deviceId === deviceId
      && matching[0]?.daemon?.presence?.connected === true
      && matching[0]?.daemon?.sessions?.length === 1
      && matching[0]?.daemon?.sessions?.[0]?.name === sessionName
    ) {
      return matching[0];
    }
    await delay(100);
  }
  throw new Error(`replacement directory timeout: ${JSON.stringify(lastDirectory)}`);
}

async function hostReplacementSmoke(accessToken: string) {
  const hostId = `${relayHostId}-replace`;
  const oldDeviceId = `${relayDeviceId}-old`;
  const newDeviceId = `${relayDeviceId}-new`;
  const oldSession = `${tmuxSession}-old`;
  const newSession = `${tmuxSession}-new`;
  const oldSocket = await connectReplacementHost(accessToken, hostId, oldDeviceId);
  const oldPublishedAt = new Date().toISOString();
  oldSocket.send(JSON.stringify({
    type: 'directory-update',
    directory: { endpoints: [], sessions: [{ name: oldSession, updatedAt: oldPublishedAt }], publishedAt: oldPublishedAt },
  }));
  await waitForReplacementDirectory(accessToken, hostId, oldDeviceId, oldSession);

  const oldClosed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('replaced host close timeout')), 10_000);
    timeout.unref?.();
    oldSocket.once('close', (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: String(reason) });
    });
  });
  const newSocket = await connectReplacementHost(accessToken, hostId, newDeviceId);
  const oldClose = await oldClosed;
  if (oldClose.code !== 1012 || oldClose.reason !== 'host relay replaced') {
    throw new Error(`unexpected replaced host close: ${JSON.stringify(oldClose)}`);
  }
  const newPublishedAt = new Date().toISOString();
  newSocket.send(JSON.stringify({
    type: 'directory-update',
    directory: { endpoints: [], sessions: [{ name: newSession, updatedAt: newPublishedAt }], publishedAt: newPublishedAt },
  }));
  const directoryDevice = await waitForReplacementDirectory(accessToken, hostId, newDeviceId, newSession);
  closeResource('replacement host socket', () => newSocket.close());
  return { hostId, oldDeviceId, newDeviceId, oldClose, directoryDevice };
}

async function rtcClientSmoke(accessToken: string) {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const signalSocket = new WebSocket(
      `ws://127.0.0.1:${relayPort}/ws/client?token=${encodeURIComponent(accessToken)}&hostId=${encodeURIComponent(relayHostId)}&deviceId=${encodeURIComponent(relayClientDeviceId)}`,
    );
    const peerConnection = new RTCPeerConnection({ iceServers: [] });
    const channel = peerConnection.createDataChannel('zterm', { ordered: true });
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      closeResource('data channel', () => channel.close());
      closeResource('peer connection', () => peerConnection.close());
      closeResource('signal socket', () => signalSocket.close());
      reject(error);
    };

    signalSocket.on('open', async () => {
      try {
        signalSocket.send(JSON.stringify({
          type: 'rtc-init',
          payload: { iceServers: [] },
        }));
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        signalSocket.send(JSON.stringify({ type: 'rtc-offer', payload: { sdp: offer.sdp, type: offer.type } }));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    signalSocket.on('message', async (raw) => {
      try {
        const message = JSON.parse(String(raw)) as { type: string; payload?: Record<string, unknown> };
        if (message.type === 'rtc-answer') {
          await peerConnection.setRemoteDescription(new RTCSessionDescription({
            type: 'answer',
            sdp: String(message.payload?.sdp || ''),
          }));
          return;
        }
        if (message.type === 'rtc-candidate' && message.payload?.candidate) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(message.payload as RTCIceCandidateInit));
          return;
        }
        if (message.type === 'rtc-error') {
          fail(new Error(String(message.payload?.message || 'rtc error')));
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    signalSocket.on('error', () => fail(new Error('relay signal websocket error')));
    signalSocket.on('close', () => {
      if (!settled) {
        fail(new Error('relay signal websocket closed before completion'));
      }
    });

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate || signalSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      signalSocket.send(JSON.stringify({ type: 'rtc-candidate', payload: event.candidate.toJSON() }));
    };

    channel.onopen = () => {
      channel.send(JSON.stringify({ type: 'list-sessions' }));
    };

    channel.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as { type?: string; payload?: { sessions?: string[] } };
        if (payload.type === 'sessions' && Array.isArray(payload.payload?.sessions)) {
          settled = true;
          resolve({
            ok: true,
            hostId: relayHostId,
            sessions: payload.payload.sessions,
          });
          closeResource('data channel', () => channel.close());
          closeResource('peer connection', () => peerConnection.close());
          closeResource('signal socket', () => signalSocket.close());
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    setTimeout(() => fail(new Error('rtc smoke timeout')), 12_000).unref?.();
  });
}

async function main() {
  relayPort = await findAvailablePort('127.0.0.1');
  daemonPort = await findAvailablePort('127.0.0.1');
  relayUrl = `http://127.0.0.1:${relayPort}`;

  const relayEnv = {
    ...process.env,
    ZTERM_TRAVERSAL_HOST: '127.0.0.1',
    ZTERM_TRAVERSAL_PORT: String(relayPort),
    // Local smoke must always probe the relay server at its root health path.
    // Inherited deployment env may set a non-empty base path like /relay.
    ZTERM_TRAVERSAL_BASE_PATH: '',
    ZTERM_TRAVERSAL_DATA_DIR: join(tempRoot, 'relay-data'),
    ZTERM_TRAVERSAL_UPDATES_DIR: relayUpdatesDir,
  };

  const daemonEnv = {
    ...process.env,
    HOME: tempHome,
    ZTERM_HOST: '127.0.0.1',
    ZTERM_PORT: String(daemonPort),
    ZTERM_TRAVERSAL_RELAY_URL: relayUrl,
    ZTERM_TRAVERSAL_USERNAME: relayUsername,
    ZTERM_TRAVERSAL_PASSWORD: relayPassword,
    ZTERM_TRAVERSAL_HOST_ID: relayHostId,
    ZTERM_TRAVERSAL_DEVICE_ID: relayDeviceId,
    ZTERM_TRAVERSAL_DEVICE_NAME: relayDeviceName,
    ZTERM_TRAVERSAL_PLATFORM: 'darwin',
    ZTERM_TRAVERSAL_APP_VERSION: 'smoke',
    ZTERM_TRAVERSAL_DAEMON_VERSION: 'smoke-daemon',
  };

  const relayProc = spawn(tsxBin, ['src/traversal-relay/server.ts'], {
    cwd: androidDir,
    env: relayEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const daemonProc = spawn(tsxBin, ['src/server/server.ts'], {
    cwd: androidDir,
    env: daemonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const relayStdout: string[] = [];
  const daemonStdout: string[] = [];
  relayProc.stdout.on('data', (chunk) => relayStdout.push(String(chunk)));
  relayProc.stderr.on('data', (chunk) => relayStdout.push(String(chunk)));
  daemonProc.stdout.on('data', (chunk) => daemonStdout.push(String(chunk)));
  daemonProc.stderr.on('data', (chunk) => daemonStdout.push(String(chunk)));

  try {
    await waitForHealth(`${relayUrl}/health`, 'relay');
    const relayUpdateSmoke = await fetchRelayUpdateSmoke();
    const tmuxCreate = spawnSync('tmux', ['new-session', '-d', '-s', tmuxSession, 'printf "relay smoke ready\\n"; exec bash'], {
      encoding: 'utf-8',
    });
    if (tmuxCreate.status !== 0) {
      throw new Error(`tmux new-session failed: ${tmuxCreate.stderr || tmuxCreate.stdout}`);
    }

    const accessToken = await registerAndLogin();
    globalAccessToken = accessToken;
    const hostReplacement = await hostReplacementSmoke(accessToken);
    const deviceStream = await connectDeviceStream(accessToken);
    const daemonRegistration = await waitForDaemonRelayRegistration();
    const accountDirectory = await waitForAccountDirectory();
    const directoryStreamSnapshot = await waitForDirectoryStreamSnapshot(deviceStream.socket);
    const routeSelection = selectSmokeRouteFromDirectory(accountDirectory);
    const rtcResult = await rtcClientSmoke(accessToken);
    closeResource('device stream socket', () => deviceStream.socket.close());

    process.stdout.write(`${JSON.stringify({
      ok: true,
      relayUrl,
      relayHostId,
      relayDeviceId,
      relayClientDeviceId,
      relayUsername,
      tmuxSession,
      hostReplacement,
      daemonRegistration,
      accountDirectory,
      deviceStreamSnapshot: deviceStream.firstSnapshot,
      directoryStreamSnapshot,
      routeSelection,
      relayUpdateSmoke,
      rtcResult,
    }, null, 2)}\n`);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', tmuxSession], { encoding: 'utf-8' });
    daemonProc.kill('SIGINT');
    relayProc.kill('SIGINT');
    await Promise.all([waitForExit(daemonProc), waitForExit(relayProc)]).catch((error) => {
      console.warn('[traversal-relay-local-smoke] Failed while waiting child exit:', error);
    });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
