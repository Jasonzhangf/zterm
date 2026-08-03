import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import { setTimeout as delay } from 'timers/promises';
import { WebSocket } from 'ws';

type RelayEnvelope = {
  type?: string;
  peerId?: string;
  reason?: string;
  message?: {
    type?: string;
    payload?: Record<string, unknown>;
  };
  payload?: { message?: string };
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const androidDir = join(scriptDir, '..');
const tsxBin = join(androidDir, 'node_modules', '.bin', 'tsx');
const relayHostId = `lease-host-${Date.now()}`;
const relayDaemonDeviceId = `lease-daemon-${Date.now()}`;
const relayUsername = `lease-${Date.now()}`;
const relayPassword = `lease-${randomUUID()}`;
const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-relay-peer-lease-'));
const relayUpdatesDir = join(tempRoot, 'updates');
mkdirSync(relayUpdatesDir, { recursive: true });
writeFileSync(join(relayUpdatesDir, 'latest.json'), '{"versionCode":1,"apkUrl":"noop.apk"}\n');
writeFileSync(join(relayUpdatesDir, 'noop.apk'), 'noop');

async function findAvailablePort(host: string) {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to resolve dynamic port')));
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

async function waitForHealth(url: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`relay health timeout: ${lastError}`);
}

async function registerAndLogin(relayUrl: string) {
  const registerResponse = await fetch(`${relayUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: relayUsername, password: relayPassword }),
  });
  if (!registerResponse.ok) {
    throw new Error(`register failed: HTTP ${registerResponse.status} ${await registerResponse.text()}`);
  }
  const loginResponse = await fetch(`${relayUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: relayUsername, password: relayPassword }),
  });
  const login = await loginResponse.json() as { accessToken?: string };
  if (!loginResponse.ok || !login.accessToken) {
    throw new Error(`login failed: HTTP ${loginResponse.status} ${JSON.stringify(login)}`);
  }
  return login.accessToken;
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 5_000) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    timeout.unref?.();
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function openSocket(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error(`websocket open timeout: ${url}`));
    }, 5_000);
    timeout.unref?.();
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('open', handleOpen);
      socket.off('error', handleError);
      socket.off('close', handleClose);
    };
    const handleOpen = () => {
      cleanup();
      resolve(socket);
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleClose = () => {
      cleanup();
      reject(new Error(`websocket closed before open: ${url}`));
    };
    socket.once('open', handleOpen);
    socket.once('error', handleError);
    socket.once('close', handleClose);
  });
}

function waitForEnvelope(
  socket: WebSocket,
  predicate: (envelope: RelayEnvelope) => boolean,
  timeoutMs = 5_000,
) {
  return new Promise<RelayEnvelope>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('relay envelope timeout'));
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
        const envelope = JSON.parse(String(raw)) as RelayEnvelope;
        if (!predicate(envelope)) {
          return;
        }
        cleanup();
        resolve(envelope);
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const handleError = () => {
      cleanup();
      reject(new Error('relay websocket error'));
    };
    const handleClose = () => {
      cleanup();
      reject(new Error('relay websocket closed'));
    };
    socket.on('message', handleMessage);
    socket.once('error', handleError);
    socket.once('close', handleClose);
  });
}

function waitForClose(socket: WebSocket, timeoutMs = 2_000) {
  return new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('relay websocket close timeout'));
    }, timeoutMs);
    timeout.unref?.();
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('close', handleClose);
    };
    const handleClose = (code: number, reason: Buffer) => {
      cleanup();
      resolve({ code, reason: String(reason) });
    };
    socket.once('close', handleClose);
  });
}

async function expectNoHostPeerClose(hostSocket: WebSocket, peerId: string, windowMs = 400) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, windowMs);
    timeout.unref?.();
    const cleanup = () => {
      clearTimeout(timeout);
      hostSocket.off('message', handleMessage);
    };
    const handleMessage = (raw: unknown) => {
      const envelope = JSON.parse(String(raw)) as RelayEnvelope;
      if (envelope.type === 'relay-peer-close' && envelope.peerId === peerId) {
        cleanup();
        reject(new Error(`peer ${peerId} closed during idle lease window: ${envelope.reason || ''}`));
      }
    };
    hostSocket.on('message', handleMessage);
  });
}

async function expectMissingDeviceRejected(url: string) {
  const socket = await openSocket(url);
  try {
    const errorEnvelope = await waitForEnvelope(
      socket,
      (envelope) => envelope.type === 'rtc-error' && envelope.payload?.message === 'deviceId is required',
      2_000,
    );
    return errorEnvelope.payload?.message || '';
  } finally {
    socket.close();
  }
}

async function openClient(relayPort: number, accessToken: string, deviceId: string) {
  return await openSocket(
    `ws://127.0.0.1:${relayPort}/ws/client?token=${encodeURIComponent(accessToken)}&hostId=${encodeURIComponent(relayHostId)}&deviceId=${encodeURIComponent(deviceId)}`,
  );
}

async function sendInitAndReadPeer(hostSocket: WebSocket, clientSocket: WebSocket) {
  const peerPromise = waitForEnvelope(
    hostSocket,
    (envelope) => envelope.type === 'relay-signal' && envelope.message?.type === 'rtc-init',
  );
  clientSocket.send(JSON.stringify({ type: 'rtc-init', payload: { smoke: true } }));
  const envelope = await peerPromise as RelayEnvelope & { message?: { type?: string } };
  if (!envelope.peerId) {
    throw new Error(`relay signal did not include peerId: ${JSON.stringify(envelope)}`);
  }
  return envelope.peerId;
}

async function main() {
  const relayPort = await findAvailablePort('127.0.0.1');
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  const relayProc = spawn(tsxBin, ['src/traversal-relay/server.ts'], {
    cwd: androidDir,
    env: {
      ...process.env,
      ZTERM_TRAVERSAL_HOST: '127.0.0.1',
      ZTERM_TRAVERSAL_PORT: String(relayPort),
      ZTERM_TRAVERSAL_BASE_PATH: '',
      ZTERM_TRAVERSAL_DATA_DIR: join(tempRoot, 'data'),
      ZTERM_TRAVERSAL_UPDATES_DIR: relayUpdatesDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const relayOutput: string[] = [];
  relayProc.stdout.on('data', (chunk) => relayOutput.push(String(chunk)));
  relayProc.stderr.on('data', (chunk) => relayOutput.push(String(chunk)));

  try {
    await waitForHealth(`${relayUrl}/health`);
    const accessToken = await registerAndLogin(relayUrl);
    const hostSocket = await openSocket(
      `ws://127.0.0.1:${relayPort}/ws/host?token=${encodeURIComponent(accessToken)}&hostId=${encodeURIComponent(relayHostId)}&deviceId=${encodeURIComponent(relayDaemonDeviceId)}`,
    );
    await waitForEnvelope(hostSocket, (envelope) => envelope.type === 'relay-ready');

    const phoneA1 = await openClient(relayPort, accessToken, 'phone-a');
    const firstPeerId = await sendInitAndReadPeer(hostSocket, phoneA1);
    const replacedClose = waitForClose(phoneA1);
    const phoneA2 = await openClient(relayPort, accessToken, 'phone-a');
    const replacementPeerId = await sendInitAndReadPeer(hostSocket, phoneA2);
    const replacedSocketClose = await replacedClose;
    if (replacementPeerId !== firstPeerId) {
      throw new Error(`new same-device signaling did not replace peer lease: ${firstPeerId} -> ${replacementPeerId}`);
    }
    if (replacedSocketClose.reason !== 'relay client socket replaced') {
      throw new Error(`old signaling socket close reason mismatch: ${JSON.stringify(replacedSocketClose)}`);
    }

    phoneA2.close(1000, 'smoke idle');
    await expectNoHostPeerClose(hostSocket, firstPeerId);

    const phoneA3 = await openClient(relayPort, accessToken, 'phone-a');
    const resumedPeerId = await sendInitAndReadPeer(hostSocket, phoneA3);
    const phoneB = await openClient(relayPort, accessToken, 'phone-b');
    const secondDevicePeerId = await sendInitAndReadPeer(hostSocket, phoneB);
    const missingDeviceError = await expectMissingDeviceRejected(
      `ws://127.0.0.1:${relayPort}/ws/client?token=${encodeURIComponent(accessToken)}&hostId=${encodeURIComponent(relayHostId)}`,
    );

    if (resumedPeerId !== firstPeerId) {
      throw new Error(`same phone did not resume peer lease: ${firstPeerId} -> ${resumedPeerId}`);
    }
    if (secondDevicePeerId === firstPeerId) {
      throw new Error(`different phone reused peer lease ${firstPeerId}`);
    }

    phoneA3.close(1000, 'smoke done');
    phoneB.close(1000, 'smoke done');
    hostSocket.close(1000, 'smoke done');

    process.stdout.write(`${JSON.stringify({
      ok: true,
      relayUrl,
      relayHostId,
      firstPeerId,
      replacementPeerId,
      resumedPeerId,
      secondDevicePeerId,
      missingDeviceError,
    }, null, 2)}\n`);
  } catch (error) {
    const output = relayOutput.join('');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nrelay output:\n${output}`);
  } finally {
    relayProc.kill('SIGTERM');
    await waitForExit(relayProc);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
