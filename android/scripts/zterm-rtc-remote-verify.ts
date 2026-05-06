import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { WebSocket } from 'ws';
import wrtc from '@roamhq/wrtc';

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc as unknown as {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  RTCSessionDescription: typeof globalThis.RTCSessionDescription;
  RTCIceCandidate: typeof globalThis.RTCIceCandidate;
};

const relayBaseUrl = 'https://coder2.codewhisper.cc/relay/';
const relayUsername = 'jason-relay-z49giz';
const relayPassword = 'ZtermhhIhJeBF35';
const relayHostId = `rtc-verify-${Date.now()}`;
const relayDeviceId = `rtc-device-${Date.now()}`;
const daemonPort = 4351;
const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-rtc-remote-verify-'));
const homeDir = join(tempRoot, 'home');
mkdirSync(homeDir, { recursive: true });
const daemonLogs: string[] = [];
const debugRtcMsgs: string[] = [];

function buildUrl(path: string) {
  return new URL(path.replace(/^\//, ''), relayBaseUrl).toString();
}

async function login() {
  const response = await fetch(buildUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: relayUsername, password: relayPassword }),
  });
  const body = await response.json() as any;
  if (!response.ok || !body.accessToken) throw new Error(`login failed: ${JSON.stringify(body)}`);
  return body as {
    accessToken: string;
    ws: { client: string };
    turn: { url: string; username?: string; credential?: string } | null;
  };
}

async function waitForRelayDevice(accessToken: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(buildUrl('/api/devices'), { headers: { authorization: `Bearer ${accessToken}` } });
      const body = await res.json() as any;
      const hit = Array.isArray(body.devices) && body.devices.find((d: any) => d?.deviceId === relayDeviceId && d?.daemon?.connected === true && d?.daemon?.hostId === relayHostId);
      if (hit) return { body, hit };
    } catch {}
    await delay(1000);
  }
  throw new Error('relay device not visible in api/devices');
}

async function rtcSmoke(accessToken: string, signalBase: string, iceServers: RTCIceServer[], relayOnly: boolean) {
  return await new Promise<any>((resolve, reject) => {
    const signalUrl = new URL(signalBase);
    signalUrl.searchParams.set('token', accessToken);
    signalUrl.searchParams.set('hostId', relayHostId);
    const signalSocket = new WebSocket(signalUrl.toString());
    const peerConnection = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: relayOnly ? 'relay' : 'all',
    });
    const channel = peerConnection.createDataChannel('zterm', { ordered: true });
    let settled = false;

    const cleanup = () => {
      try { channel.close(); } catch {}
      try { peerConnection.close(); } catch {}
      try { signalSocket.close(); } catch {}
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const finish = async () => {
      try {
        const stats = await peerConnection.getStats();
        let selectedPair: any = null;
        stats.forEach((report) => {
          if (!selectedPair && report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) selectedPair = report;
        });
        const out: any = { relayOnly, selectedPairFound: Boolean(selectedPair), candidateTypes: null };
        if (selectedPair) {
          const local = selectedPair.localCandidateId ? stats.get(selectedPair.localCandidateId) as any : undefined;
          const remote = selectedPair.remoteCandidateId ? stats.get(selectedPair.remoteCandidateId) as any : undefined;
          out.candidateTypes = { local: local?.candidateType || null, remote: remote?.candidateType || null };
        }
        settled = true;
        cleanup();
        resolve(out);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    signalSocket.on('open', async () => {
      try {
        signalSocket.send(JSON.stringify({ type: 'rtc-init', payload: { iceServers } }));
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        signalSocket.send(JSON.stringify({ type: 'rtc-offer', payload: { type: offer.type, sdp: offer.sdp } }));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    signalSocket.on('message', async (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type: string; payload?: Record<string, unknown> };
        if (msg.type === 'rtc-answer') {
          await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: String(msg.payload?.sdp || '') }));
          return;
        }
        if (msg.type === 'rtc-candidate' && msg.payload?.candidate) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(msg.payload as RTCIceCandidateInit));
          return;
        }
        debugRtcMsgs.push(JSON.stringify(msg));
        if (msg.type === 'rtc-error') {
          fail(new Error(String(msg.payload?.message || 'rtc-error')));
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate || signalSocket.readyState !== WebSocket.OPEN) return;
      signalSocket.send(JSON.stringify({ type: 'rtc-candidate', payload: event.candidate.toJSON() }));
    };

    channel.onopen = () => { void finish(); };
    channel.onerror = () => fail(new Error('datachannel error'));
    signalSocket.onerror = () => fail(new Error('signal websocket error'));
    signalSocket.onclose = () => { if (!settled) fail(new Error('signal websocket closed')); };
    setTimeout(() => fail(new Error(`rtc timeout relayOnly=${relayOnly}; msgs=${debugRtcMsgs.slice(-20).join(' | ')}`)), 25000).unref?.();
  });
}

async function main() {
  const tmuxSession = `zterm-rtc-verify-${Date.now()}`;
  const tmuxCreate = spawnSync('tmux', ['new-session', '-d', '-s', tmuxSession, 'printf "rtc verify ready\\n"; exec bash'], { encoding: 'utf-8' });
  if (tmuxCreate.status !== 0) throw new Error(`tmux create failed: ${tmuxCreate.stderr || tmuxCreate.stdout}`);

  const daemonProc = spawn('pnpm', ['exec', 'tsx', 'src/server/server.ts'], {
    cwd: join(process.cwd()),
    env: {
      ...process.env,
      HOME: homeDir,
      ZTERM_HOST: '127.0.0.1',
      ZTERM_PORT: String(daemonPort),
      ZTERM_TRAVERSAL_RELAY_URL: relayBaseUrl,
      ZTERM_TRAVERSAL_USERNAME: relayUsername,
      ZTERM_TRAVERSAL_PASSWORD: relayPassword,
      ZTERM_TRAVERSAL_HOST_ID: relayHostId,
      ZTERM_TRAVERSAL_DEVICE_ID: relayDeviceId,
      ZTERM_TRAVERSAL_DEVICE_NAME: relayDeviceId,
      ZTERM_TRAVERSAL_PLATFORM: 'darwin',
      ZTERM_TRAVERSAL_APP_VERSION: 'rtc-verify',
      ZTERM_TRAVERSAL_DAEMON_VERSION: 'rtc-verify',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemonProc.stdout.on('data', (c) => daemonLogs.push(String(c)));
  daemonProc.stderr.on('data', (c) => daemonLogs.push(String(c)));

  try {
    const auth = await login();
    const relayDevice = await waitForRelayDevice(auth.accessToken);
    const iceServers: RTCIceServer[] = auth.turn?.url ? [{ urls: auth.turn.url, username: auth.turn.username, credential: auth.turn.credential }] : [];
    const p2p = await rtcSmoke(auth.accessToken, auth.ws.client, iceServers, false);
    console.log(JSON.stringify({ stage: 'p2p-ok', p2p }, null, 2));
    const relay = await rtcSmoke(auth.accessToken, auth.ws.client, iceServers, true);
    console.log(JSON.stringify({
      ok: true,
      relayHostId,
      relayDeviceId,
      relayDevice,
      p2p,
      relay,
      daemonLogsTail: daemonLogs.slice(-80),
    }, null, 2));
  } finally {
    daemonProc.kill('SIGINT');
    await delay(1000);
    spawnSync('tmux', ['kill-session', '-t', tmuxSession], { encoding: 'utf-8' });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
