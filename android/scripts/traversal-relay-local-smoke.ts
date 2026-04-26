import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';
import { WebSocket } from 'ws';
import wrtc from '@roamhq/wrtc';

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc as unknown as {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  RTCSessionDescription: typeof globalThis.RTCSessionDescription;
  RTCIceCandidate: typeof globalThis.RTCIceCandidate;
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const androidDir = join(scriptDir, '..');
const relayPort = 19091;
const daemonPort = 4335;
const relayUrl = `http://127.0.0.1:${relayPort}`;
const relayHostId = `local-smoke-${Date.now()}`;
const relayUsername = `smoke-${Date.now()}`;
const relayPassword = 'smoke-pass-123';
const tmuxSession = `zterm-relay-smoke-${Date.now()}`;
const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-traversal-smoke-'));
const tempHome = join(tempRoot, 'home');
mkdirSync(tempHome, { recursive: true });

const tsxBin = join(androidDir, 'node_modules', '.bin', 'tsx');

const relayEnv = {
  ...process.env,
  ZTERM_TRAVERSAL_HOST: '127.0.0.1',
  ZTERM_TRAVERSAL_PORT: String(relayPort),
  ZTERM_TRAVERSAL_DATA_DIR: join(tempRoot, 'relay-data'),
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
};

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

async function waitForDaemonRelayRegistration(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetch(`http://127.0.0.1:${daemonPort}/health`)
      .then((response) => response.json())
      .catch((error) => {
        console.warn('[traversal-relay-local-smoke] daemon health probe failed:', error);
        return null;
      });
    if (health?.ok) {
      return health;
    }
    await delay(250);
  }
  throw new Error('daemon health timeout');
}

async function rtcClientSmoke(accessToken: string) {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const signalSocket = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/client?token=${encodeURIComponent(accessToken)}&hostId=${encodeURIComponent(relayHostId)}`);
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
  const relayProc = spawn(process.execPath, [tsxBin, 'src/traversal-relay/server.ts'], {
    cwd: androidDir,
    env: relayEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const daemonProc = spawn(process.execPath, [tsxBin, 'src/server/server.ts'], {
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
    const accessToken = await registerAndLogin();

    const tmuxCreate = spawnSync('tmux', ['new-session', '-d', '-s', tmuxSession, 'printf "relay smoke ready\\n"; exec bash'], {
      encoding: 'utf-8',
    });
    if (tmuxCreate.status !== 0) {
      throw new Error(`tmux new-session failed: ${tmuxCreate.stderr || tmuxCreate.stdout}`);
    }

    await waitForDaemonRelayRegistration();
    const rtcResult = await rtcClientSmoke(accessToken);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      relayUrl,
      relayHostId,
      relayUsername,
      tmuxSession,
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
