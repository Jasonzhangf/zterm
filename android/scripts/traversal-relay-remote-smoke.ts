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
const daemonPort = 4336;
const relayBaseUrl = process.env.RELAY_BASE_URL || 'https://coder2.codewhisper.cc/relay/';
const relayHostId = `remote-smoke-${Date.now()}`;
const relayDeviceId = `device-${Date.now()}`;
const relayDeviceName = 'remote-smoke-daemon';
const relayUsername = process.env.RELAY_USERNAME || `remote-smoke-${Date.now()}`;
const relayPassword = process.env.RELAY_PASSWORD || 'remote-smoke-pass-123';
const tmuxSession = `zterm-remote-relay-smoke-${Date.now()}`;
const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-traversal-remote-smoke-'));
const tempHome = join(tempRoot, 'home');
mkdirSync(tempHome, { recursive: true });
const tsxBin = join(androidDir, 'node_modules', '.bin', 'tsx');

const daemonEnv = {
  ...process.env,
  HOME: tempHome,
  ZTERM_HOST: '127.0.0.1',
  ZTERM_PORT: String(daemonPort),
  ZTERM_TRAVERSAL_RELAY_URL: relayBaseUrl,
  ZTERM_TRAVERSAL_USERNAME: relayUsername,
  ZTERM_TRAVERSAL_PASSWORD: relayPassword,
  ZTERM_TRAVERSAL_HOST_ID: relayHostId,
  ZTERM_TRAVERSAL_DEVICE_ID: relayDeviceId,
  ZTERM_TRAVERSAL_DEVICE_NAME: relayDeviceName,
  ZTERM_TRAVERSAL_PLATFORM: 'darwin',
  ZTERM_TRAVERSAL_APP_VERSION: 'remote-smoke',
  ZTERM_TRAVERSAL_DAEMON_VERSION: 'remote-smoke-daemon',
};

function buildUrl(base: string, path: string) {
  return new URL(path.replace(/^\//, ''), base).toString();
}

async function ensureAccount() {
  const registerUrl = buildUrl(relayBaseUrl, '/api/auth/register');
  const loginUrl = buildUrl(relayBaseUrl, '/api/auth/login');

  const register = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: relayUsername, password: relayPassword }),
  });
  if (!register.ok && register.status !== 409) {
    throw new Error(`register failed: HTTP ${register.status} ${await register.text()}`);
  }

  const login = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: relayUsername, password: relayPassword }),
  });
  const loginBody = await login.json() as any;
  if (!login.ok || !loginBody.accessToken) {
    throw new Error(`login failed: ${JSON.stringify(loginBody)}`);
  }
  return loginBody as {
    accessToken: string;
    ws?: { client?: string };
    turn?: { url?: string; username?: string; credential?: string };
  };
}

async function waitForDaemonRelayRegistration(accessToken: string, timeoutMs = 20000) {
  const devicesUrl = buildUrl(relayBaseUrl, '/api/devices');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [health, devicesPayload] = await Promise.all([
      fetch(`http://127.0.0.1:${daemonPort}/health`).then((r) => r.json()).catch(() => null),
      fetch(devicesUrl, { headers: { authorization: `Bearer ${accessToken}` } }).then((r) => r.json()).catch(() => null),
    ]);
    if (
      health?.ok && Array.isArray(devicesPayload?.devices)
      && devicesPayload.devices.some((device: any) =>
        device?.deviceId === relayDeviceId
        && device?.daemon?.connected === true
        && device?.daemon?.hostId === relayHostId)
    ) {
      return { health, devices: devicesPayload.devices };
    }
    await delay(500);
  }
  throw new Error('daemon relay registration timeout');
}

async function rtcClientSmoke(opts: {
  accessToken: string;
  signalUrl: string;
  iceServers: RTCIceServer[];
  relayOnly: boolean;
}) {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const parsed = new URL(opts.signalUrl);
    parsed.searchParams.set('token', opts.accessToken);
    parsed.searchParams.set('hostId', relayHostId);
    const signalSocket = new WebSocket(parsed.toString());
    const peerConnection = new RTCPeerConnection({
      iceServers: opts.iceServers,
      iceTransportPolicy: opts.relayOnly ? 'relay' : 'all',
    });
    const channel = peerConnection.createDataChannel('zterm', { ordered: true });
    let settled = false;

    const finish = async () => {
      try {
        const stats = await peerConnection.getStats();
        let selectedPair: any = null;
        stats.forEach((report) => {
          if (!selectedPair && report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
            selectedPair = report;
          }
        });
        let candidateTypes: Record<string, unknown> = {};
        if (selectedPair) {
          const local = selectedPair.localCandidateId ? stats.get(selectedPair.localCandidateId) as any : undefined;
          const remote = selectedPair.remoteCandidateId ? stats.get(selectedPair.remoteCandidateId) as any : undefined;
          candidateTypes = {
            local: local?.candidateType || null,
            remote: remote?.candidateType || null,
          };
        }
        resolve({ ok: true, relayOnly: opts.relayOnly, candidateTypes, hostId: relayHostId });
      } catch (error) {
        reject(error);
      } finally {
        try { channel.close(); } catch {}
        try { peerConnection.close(); } catch {}
        try { signalSocket.close(); } catch {}
      }
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      try { channel.close(); } catch {}
      try { peerConnection.close(); } catch {}
      try { signalSocket.close(); } catch {}
      reject(error);
    };

    signalSocket.on('open', async () => {
      try {
        signalSocket.send(JSON.stringify({ type: 'rtc-init', payload: { iceServers: opts.iceServers } }));
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
          await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: String(message.payload?.sdp || '') }));
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

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate || signalSocket.readyState !== WebSocket.OPEN) return;
      signalSocket.send(JSON.stringify({ type: 'rtc-candidate', payload: event.candidate.toJSON() }));
    };

    channel.onopen = () => {
      if (settled) return;
      settled = true;
      void finish();
    };
    channel.onerror = () => fail(new Error('datachannel error'));
    signalSocket.on('error', () => fail(new Error('signal websocket error')));
    signalSocket.on('close', () => { if (!settled) fail(new Error('signal websocket closed')); });

    setTimeout(() => fail(new Error(`rtc smoke timeout relayOnly=${opts.relayOnly}`)), 20000).unref?.();
  });
}

async function main() {
  const login = await ensureAccount();
  const tmuxCreate = spawnSync('tmux', ['new-session', '-d', '-s', tmuxSession, 'printf "remote relay smoke ready\\n"; exec bash'], { encoding: 'utf-8' });
  if (tmuxCreate.status !== 0) {
    throw new Error(`tmux new-session failed: ${tmuxCreate.stderr || tmuxCreate.stdout}`);
  }

  const daemonProc = spawn(process.execPath, [tsxBin, 'src/server/server.ts'], {
    cwd: androidDir,
    env: daemonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const daemonLogs: string[] = [];
  daemonProc.stdout.on('data', (c) => daemonLogs.push(String(c)));
  daemonProc.stderr.on('data', (c) => daemonLogs.push(String(c)));

  try {
    const daemonRegistration = await waitForDaemonRelayRegistration(login.accessToken);
    const signalUrl = login.ws?.client;
    if (!signalUrl) throw new Error('missing ws.client in login response');
    const iceServers: RTCIceServer[] = login.turn?.url ? [{
      urls: login.turn.url,
      username: login.turn.username,
      credential: login.turn.credential,
    }] : [];

    const p2pResult = await rtcClientSmoke({ accessToken: login.accessToken, signalUrl, iceServers, relayOnly: false });
    const relayResult = await rtcClientSmoke({ accessToken: login.accessToken, signalUrl, iceServers, relayOnly: true });

    process.stdout.write(JSON.stringify({
      ok: true,
      relayBaseUrl,
      relayHostId,
      relayDeviceId,
      relayUsername,
      daemonRegistration,
      p2pResult,
      relayResult,
      daemonLogsTail: daemonLogs.slice(-40),
    }, null, 2) + '\n');
  } finally {
    spawnSync('tmux', ['kill-session', '-t', tmuxSession], { encoding: 'utf-8' });
    daemonProc.kill('SIGINT');
    await delay(1000);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
