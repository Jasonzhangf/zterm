import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';
import { WebSocket } from 'ws';
import wrtc from '@roamhq/wrtc';

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc as any;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const androidDir = join(scriptDir, '..');
const relayBaseUrl = requireEnv('RELAY_BASE_URL');
const relayUsername = requireEnv('RELAY_USERNAME');
const relayPassword = requireEnv('RELAY_PASSWORD');
const relayHostId = `udp-direct-${Date.now()}`;
const relayDeviceId = `udp-direct-device-${Date.now()}`;
const tmuxSession = `zterm-udp-direct-${Date.now()}`;
const daemonPort = 4367;
const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-udp-direct-'));
const tempHome = join(tempRoot, 'home');
mkdirSync(tempHome, { recursive: true });
const tsxBin = join(androidDir, 'node_modules', '.bin', 'tsx');

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for UDP direct smoke`);
  return value;
}

function url(base: string, path: string) {
  return new URL(path.replace(/^\//, ''), base).toString();
}

function directIceServer(turnUrl?: string) {
  const servers: Array<{ urls: string }> = [];
  if (turnUrl) {
    const stunUrl = turnUrl.replace(/^turns:/i, 'stuns:').replace(/^turn:/i, 'stun:').replace(/\?.*$/, '');
    if (!/^stuns?:/i.test(stunUrl)) throw new Error(`TURN URL cannot be converted to STUN: ${turnUrl}`);
    servers.push({ urls: stunUrl });
  }
  servers.push(
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  );
  return servers;
}

async function login() {
  const response = await fetch(url(relayBaseUrl, '/api/auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: relayUsername, password: relayPassword }),
  });
  const body = await response.json() as any;
  if (!response.ok || !body.accessToken) throw new Error(`login failed: ${JSON.stringify(body)}`);
  return body;
}

async function waitForDaemon(accessToken: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const [health, devices] = await Promise.all([
      fetch(`http://127.0.0.1:${daemonPort}/health`).then((r) => r.json()).catch(() => null),
      fetch(url(relayBaseUrl, '/api/devices'), { headers: { authorization: `Bearer ${accessToken}` } }).then((r) => r.json()).catch(() => null),
    ]);
    if (health?.ok && devices?.devices?.some((device: any) => (
      device.deviceId === relayDeviceId && device.daemon?.connected === true && device.daemon?.hostId === relayHostId
    ))) return;
    await delay(500);
  }
  throw new Error('daemon did not register with relay');
}

async function runDirectCheck(auth: any, iceServers: any[]) {
  const signalUrl = new URL(auth.ws.client);
  signalUrl.searchParams.set('token', auth.accessToken);
  signalUrl.searchParams.set('hostId', relayHostId);
  signalUrl.searchParams.set('deviceId', `${relayDeviceId}-client`);
  const signalSocket = new WebSocket(signalUrl.toString());
  const peer = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });
  const channel = peer.createDataChannel('zterm', { ordered: true });
  const signalTypes: string[] = [];
  let selectedPair: any = null;
  let settled = false;
  const finish = (error?: Error, value?: any) => {
    if (settled) return;
    settled = true;
    try { channel.close(); } catch {}
    try { peer.close(); } catch {}
    try { signalSocket.close(); } catch {}
    error ? rejectPromise(error) : resolvePromise(value);
  };
  let resolvePromise!: (value: any) => void;
  let rejectPromise!: (error: Error) => void;

  return await new Promise<any>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    const fail = (error: Error) => finish(error);
    const inspect = async () => {
      const stats = await peer.getStats();
      stats.forEach((report: any) => {
        if (!selectedPair && report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) selectedPair = report;
      });
      if (!selectedPair) throw new Error('no nominated ICE candidate pair');
      const local = stats.get(selectedPair.localCandidateId) as any;
      const remote = stats.get(selectedPair.remoteCandidateId) as any;
      const pair = {
        local: { type: local?.candidateType, address: local?.address || local?.ip, port: local?.port, protocol: local?.protocol },
        remote: { type: remote?.candidateType, address: remote?.address || remote?.ip, port: remote?.port, protocol: remote?.protocol },
        rttMs: typeof selectedPair.currentRoundTripTime === 'number' ? Math.round(selectedPair.currentRoundTripTime * 1000) : undefined,
      };
      if (pair.local.type === 'relay' || pair.remote.type === 'relay') throw new Error(`UDP direct gate rejected relay ICE pair: ${JSON.stringify(pair)}`);
      finish(undefined, { ok: true, signalTypes, selectedPair: pair, marker: 'list-sessions response received' });
    };
    signalSocket.on('open', async () => {
      try {
        signalSocket.send(JSON.stringify({ type: 'rtc-init', payload: { iceServers, iceTransportPolicy: 'all' } }));
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        signalSocket.send(JSON.stringify({ type: 'rtc-offer', payload: { sdp: offer.sdp, type: offer.type } }));
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    signalSocket.on('message', async (raw) => {
      try {
        const message = JSON.parse(String(raw));
        signalTypes.push(String(message.type || 'unknown'));
        if (message.type === 'rtc-answer') await peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: String(message.payload?.sdp || '') }));
        if (message.type === 'rtc-candidate' && message.payload?.candidate) await peer.addIceCandidate(new RTCIceCandidate(message.payload));
        if (message.type === 'rtc-error') throw new Error(String(message.payload?.message || 'rtc-error'));
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    peer.onicecandidate = (event: any) => {
      if (event.candidate && signalSocket.readyState === WebSocket.OPEN) signalSocket.send(JSON.stringify({ type: 'rtc-candidate', payload: event.candidate.toJSON() }));
    };
    channel.onopen = () => channel.send(JSON.stringify({ type: 'list-sessions' }));
    channel.onmessage = (event: any) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'sessions') void inspect().catch(fail);
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    };
    channel.onerror = () => fail(new Error('data channel error'));
    signalSocket.on('error', () => fail(new Error('signaling websocket error')));
    signalSocket.on('close', () => { if (!settled) fail(new Error('signaling websocket closed')); });
    setTimeout(() => fail(new Error('UDP direct smoke timeout')), 25_000).unref?.();
  });
}

async function main() {
  const auth = await login();
  const tmux = spawnSync('tmux', ['new-session', '-d', '-s', tmuxSession, 'printf "udp direct ready\\n"; exec bash'], { encoding: 'utf8' });
  if (tmux.status !== 0) throw new Error(`tmux create failed: ${tmux.stderr || tmux.stdout}`);
  const daemon = spawn(tsxBin, ['src/server/server.ts'], {
    cwd: androidDir,
    env: { ...process.env, HOME: tempHome, ZTERM_HOST: '127.0.0.1', ZTERM_PORT: String(daemonPort), ZTERM_TRAVERSAL_RELAY_URL: relayBaseUrl, ZTERM_TRAVERSAL_USERNAME: relayUsername, ZTERM_TRAVERSAL_PASSWORD: relayPassword, ZTERM_TRAVERSAL_HOST_ID: relayHostId, ZTERM_TRAVERSAL_DEVICE_ID: relayDeviceId, ZTERM_TRAVERSAL_DEVICE_NAME: 'udp-direct-daemon', ZTERM_TRAVERSAL_PLATFORM: 'darwin', ZTERM_TRAVERSAL_APP_VERSION: 'udp-direct', ZTERM_TRAVERSAL_DAEMON_VERSION: 'udp-direct' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  daemon.stdout.on('data', (chunk) => logs.push(String(chunk)));
  daemon.stderr.on('data', (chunk) => logs.push(String(chunk)));
  try {
    await waitForDaemon(auth.accessToken);
    const iceServers = directIceServer(auth.turn?.url);
    const result = await runDirectCheck(auth, iceServers);
    if (result.signalTypes.some((type: string) => !['rtc-init', 'rtc-offer', 'rtc-answer', 'rtc-candidate', 'rtc-error', 'rtc-close'].includes(type))) throw new Error(`unexpected signaling payload: ${result.signalTypes.join(',')}`);
    process.stdout.write(JSON.stringify({ ok: true, relay: 'signaling-only', iceServers, result, daemonLogsTail: logs.slice(-30) }, null, 2) + '\n');
  } finally {
    daemon.kill('SIGINT');
    await delay(1000);
    spawnSync('tmux', ['kill-session', '-t', tmuxSession], { encoding: 'utf8' });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exit(1); });
