import { execFileSync, spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';
import { WebSocket } from 'ws';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const androidDir = join(scriptDir, '..');
const relayBaseUrl = requireEnv('RELAY_BASE_URL');
const relayUsername = requireEnv('RELAY_USERNAME');
const relayPassword = requireEnv('RELAY_PASSWORD');
const externalHostId = process.env.UDP_DIRECT_DEVICE_HOST_ID?.trim() || '';
const relayHostId = externalHostId || `udp-device-${Date.now()}`;
const relayDeviceId = `udp-device-daemon-${Date.now()}`;
const clientDeviceId = `udp-device-client-${Date.now()}`;
const tmuxSession = `zterm-udp-device-${Date.now()}`;
const daemonPort = 4368;
const cdpPort = 19223;
const appId = 'com.zterm.android';
const activity = 'com.zterm.android/.MainActivity';
const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-udp-device-'));
const tempHome = join(tempRoot, 'home');
mkdirSync(tempHome, { recursive: true });
const tsxBin = join(androidDir, 'node_modules', '.bin', 'tsx');

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for UDP direct device smoke`);
  return value;
}

function url(base: string, path: string) {
  return new URL(path.replace(/^\//, ''), base).toString();
}

function run(command: string, args: string[], cwd = androidDir) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function adb(serial: string, args: string[]) {
  return run('adb', ['-s', serial, ...args], androidDir);
}

function resolveSerial() {
  return process.env.ANDROID_SERIAL?.trim() || process.argv.find((value) => value.startsWith('--serial='))?.slice('--serial='.length) || '';
}

function directIceServer(turnUrl?: string) {
  if (!turnUrl) return [];
  const stunUrl = turnUrl.replace(/^turns:/i, 'stuns:').replace(/^turn:/i, 'stun:').replace(/\?.*$/, '');
  if (!/^stuns?:/i.test(stunUrl)) throw new Error(`TURN URL cannot be converted to STUN: ${turnUrl}`);
  return [{ urls: stunUrl }];
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

async function waitForExternalDaemon(accessToken: string, hostId: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const devices = await fetch(url(relayBaseUrl, '/api/devices'), {
      headers: { authorization: `Bearer ${accessToken}` },
    }).then((r) => r.json()).catch(() => null) as any;
    const hit = Array.isArray(devices?.devices) && devices.devices.some((device: any) => (
      device.daemon?.connected === true && device.daemon?.hostId === hostId
    ));
    if (hit) return;
    await delay(500);
  }
  throw new Error(`external daemon did not register with relay: ${hostId}`);
}

function findWebViewSocket(serial: string) {
  const unixSockets = adb(serial, ['shell', 'cat', '/proc/net/unix']);
  const sockets = unixSockets.match(/@webview_devtools_remote_\d+/g) || [];
  if (sockets.length === 0) throw new Error('no Android WebView DevTools socket found');
  try {
    const pid = adb(serial, ['shell', 'pidof', appId]).trim();
    const exact = sockets.find((socket) => socket.endsWith(`_${pid}`));
    if (exact) return exact;
  } catch {}
  return sockets[0]!;
}

async function cdpEval(serial: string, expression: string) {
  const socketName = findWebViewSocket(serial);
  adb(serial, ['forward', `tcp:${cdpPort}`, `localabstract:${socketName.slice(1)}`]);
  const pages = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json()) as any[];
  const page = pages.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
  if (!page) throw new Error('Android WebView has no debuggable page target');

  return await new Promise<any>((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const requestId = 1;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('CDP Runtime.evaluate timed out'));
    }, 40_000);
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    socket.on('message', (raw) => {
      let message: any;
      try {
        message = JSON.parse(String(raw));
      } catch (error) {
        clearTimeout(timeout);
        socket.close();
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (message.id !== requestId) return;
      clearTimeout(timeout);
      if (message.error) {
        socket.close();
        reject(new Error(`CDP Runtime.evaluate failed: ${JSON.stringify(message.error)}`));
        return;
      }
      if (message.result?.exceptionDetails) {
        const details = message.result.exceptionDetails;
        const description = details.exception?.description || details.text || 'Runtime.evaluate exception';
        socket.close();
        reject(new Error(`CDP Runtime.evaluate exception: ${description}`));
        return;
      }
      socket.close();
      const value = message.result?.result?.value;
      if (value === undefined) {
        reject(new Error('CDP Runtime.evaluate returned no value'));
        return;
      }
      resolve(value);
    });
    socket.once('open', () => {
      socket.send(JSON.stringify({
        id: requestId,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
  });
}

async function runDeviceDirectCheck(auth: any, iceServers: any[], serial: string) {
  const signalUrl = new URL(auth.ws.client);
  signalUrl.searchParams.set('token', auth.accessToken);
  signalUrl.searchParams.set('hostId', relayHostId);
  signalUrl.searchParams.set('deviceId', clientDeviceId);
  const rejectTailscaleCandidates = process.env.UDP_DIRECT_DEVICE_ALLOW_TAILSCALE !== '1';
  const expression = `(async () => {
    const signalUrl = new URL(${JSON.stringify(signalUrl.toString())});
    const iceServers = ${JSON.stringify(iceServers)};
    const rejectTailscaleCandidates = ${JSON.stringify(rejectTailscaleCandidates)};
    const signalSocket = new WebSocket(signalUrl.toString());
    const peer = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });
    const channel = peer.createDataChannel('zterm', { ordered: true });
    const signalTypes = [];
    let marker = null;
    let filteredTailscaleCandidates = 0;
    const isTailscaleAddress = (value) => {
      const address = String(value || '');
      return /^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\./.test(address)
        || /^fd7a:115c:a1e0:/i.test(address);
    };
    const candidateAddress = (candidate) => {
      if (candidate?.address) return candidate.address;
      const parts = String(candidate?.candidate || '').split(' ');
      const typIndex = parts.indexOf('typ');
      return typIndex > 0 ? parts[typIndex - 1] : '';
    };
    const isTailscaleCandidate = (candidate) => {
      const raw = String(candidate?.candidate || candidate || '');
      return /100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.|fd7a:115c:a1e0:/i.test(raw)
        || isTailscaleAddress(candidateAddress(candidate));
    };
    const stripTailscaleCandidates = (sdp) => {
      if (typeof sdp !== 'string') return sdp;
      return sdp.split(new RegExp("\\\\r?\\\\n")).filter((line) => {
        if (!line.startsWith('a=candidate:')) return true;
        return !isTailscaleCandidate({ candidate: line.slice(2) });
      }).join("\\r\\n");
    };
    const cleanup = () => {
      try { channel.close(); } catch (e) {}
      try { peer.close(); } catch (e) {}
      try { signalSocket.close(); } catch (e) {}
    };
    return await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const finish = async () => {
        const stats = await peer.getStats();
        let selectedPair = null;
        const candidates = [];
        stats.forEach((report) => {
          if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
            candidates.push({
              kind: report.type,
              type: report.candidateType,
              address: report.address || report.ip,
              port: report.port,
              protocol: report.protocol,
            });
          }
          if (!selectedPair && report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) selectedPair = report;
        });
        if (!selectedPair) throw new Error('no nominated ICE pair: ' + JSON.stringify(candidates));
        const local = stats.get(selectedPair.localCandidateId);
        const remote = stats.get(selectedPair.remoteCandidateId);
        const pair = {
          local: { type: local?.candidateType, address: local?.address || local?.ip, port: local?.port, protocol: local?.protocol },
          remote: { type: remote?.candidateType, address: remote?.address || remote?.ip, port: remote?.port, protocol: remote?.protocol },
          rttMs: typeof selectedPair.currentRoundTripTime === 'number' ? Math.round(selectedPair.currentRoundTripTime * 1000) : undefined,
        };
        if (pair.local.type === 'relay' || pair.remote.type === 'relay') throw new Error('relay ICE pair rejected');
        if (rejectTailscaleCandidates && (isTailscaleAddress(pair.local.address) || isTailscaleAddress(pair.remote.address))) {
          throw new Error('Tailscale ICE pair rejected: ' + JSON.stringify({ pair, candidates, signalTypes, filteredTailscaleCandidates }));
        }
        settled = true;
        cleanup();
        resolve({ ok: true, signalTypes, selectedPair: pair, marker, filteredTailscaleCandidates, candidates });
      };
      signalSocket.onopen = async () => {
        try {
          signalSocket.send(JSON.stringify({ type: 'rtc-init', payload: { iceServers, iceTransportPolicy: 'all' } }));
          const offer = await peer.createOffer();
          offer.sdp = stripTailscaleCandidates(offer.sdp);
          await peer.setLocalDescription(offer);
          signalSocket.send(JSON.stringify({ type: 'rtc-offer', payload: { sdp: offer.sdp, type: offer.type } }));
        } catch (error) {
          fail(error);
        }
      };
      signalSocket.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          signalTypes.push(message.type);
          if (message.type === 'rtc-answer') {
            const sdp = stripTailscaleCandidates(message.payload?.sdp || '');
            await peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
          }
          if (message.type === 'rtc-candidate' && message.payload?.candidate) {
            if (rejectTailscaleCandidates && isTailscaleCandidate(message.payload)) {
              filteredTailscaleCandidates += 1;
            } else {
              await peer.addIceCandidate(new RTCIceCandidate(message.payload));
            }
          }
          if (message.type === 'rtc-error') throw new Error(message.payload?.message || 'rtc-error');
        } catch (error) {
          fail(error);
        }
      };
      peer.onicecandidate = (event) => {
        if (!event.candidate) return;
        const payload = event.candidate.toJSON();
        if (rejectTailscaleCandidates && isTailscaleCandidate(payload)) {
          filteredTailscaleCandidates += 1;
          return;
        }
        if (signalSocket.readyState === 1) signalSocket.send(JSON.stringify({ type: 'rtc-candidate', payload }));
      };
      channel.onopen = () => channel.send(JSON.stringify({ type: 'list-sessions' }));
      channel.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'sessions') {
            marker = 'sessions response received';
            void finish().catch(fail);
          }
        } catch (error) {
          fail(error);
        }
      };
      channel.onerror = () => fail(new Error('data channel error'));
      signalSocket.onerror = () => fail(new Error('signaling websocket error'));
      signalSocket.onclose = () => { if (!settled) fail(new Error('signaling websocket closed')); };
      setTimeout(() => fail(new Error('UDP direct device timeout')), 30000);
    });
  })()`;
  return await cdpEval(serial, expression);
}

async function main() {
  const serial = resolveSerial();
  if (!serial) throw new Error('ANDROID_SERIAL or --serial=<serial> is required');
  const auth = await login();
  let tmux: ReturnType<typeof spawnSync> | null = null;
  let daemon: ReturnType<typeof spawn> | null = null;
  if (!externalHostId) {
    tmux = spawnSync('tmux', ['new-session', '-d', '-s', tmuxSession, 'printf "udp device ready\\n"; exec bash'], { encoding: 'utf8' });
    if (tmux.status !== 0) throw new Error(`tmux create failed: ${tmux.stderr || tmux.stdout}`);
    daemon = spawn(tsxBin, ['src/server/server.ts'], {
      cwd: androidDir,
      env: {
        ...process.env,
        HOME: tempHome,
        ZTERM_HOST: '127.0.0.1',
        ZTERM_PORT: String(daemonPort),
        ZTERM_TRAVERSAL_RELAY_URL: relayBaseUrl,
        ZTERM_TRAVERSAL_USERNAME: relayUsername,
        ZTERM_TRAVERSAL_PASSWORD: relayPassword,
        ZTERM_TRAVERSAL_HOST_ID: relayHostId,
        ZTERM_TRAVERSAL_DEVICE_ID: relayDeviceId,
        ZTERM_TRAVERSAL_DEVICE_NAME: 'udp-device-daemon',
        ZTERM_TRAVERSAL_PLATFORM: 'darwin',
        ZTERM_TRAVERSAL_APP_VERSION: 'udp-device',
        ZTERM_TRAVERSAL_DAEMON_VERSION: 'udp-device',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  const logs: string[] = [];
  daemon?.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  daemon?.stderr?.on('data', (chunk) => logs.push(String(chunk)));
  try {
    if (externalHostId) {
      await waitForExternalDaemon(auth.accessToken, externalHostId);
    } else {
      await waitForDaemon(auth.accessToken);
    }
    adb(serial, ['shell', 'am', 'start', '-n', activity]);
    await delay(1500);
    const iceServers = directIceServer(auth.turn?.url);
    const result = await runDeviceDirectCheck(auth, iceServers, serial);
    if (!result || result.ok !== true) throw new Error(`UDP direct device result missing: ${JSON.stringify(result)}`);
    if (result.marker !== 'sessions response received') throw new Error(`RTC data channel marker missing: ${JSON.stringify(result)}`);
    if (!result.selectedPair?.local || !result.selectedPair?.remote) throw new Error(`RTC selected ICE pair missing: ${JSON.stringify(result)}`);
    const badSignalType = result.signalTypes?.find((type: string) => !['rtc-init', 'rtc-offer', 'rtc-answer', 'rtc-candidate', 'rtc-error', 'rtc-close'].includes(type));
    if (badSignalType) throw new Error(`unexpected signaling payload: ${badSignalType}`);
    if (result.selectedPair?.local?.type === 'relay' || result.selectedPair?.remote?.type === 'relay') throw new Error('relay ICE pair rejected');
    process.stdout.write(JSON.stringify({ ok: true, relay: 'signaling-only', targetHostId: relayHostId, serial, iceServers, result, daemonLogsTail: logs.slice(-30) }, null, 2) + '\n');
  } finally {
    daemon?.kill('SIGINT');
    await delay(daemon ? 1000 : 0);
    if (tmux && !externalHostId) spawnSync('tmux', ['kill-session', '-t', tmuxSession], { encoding: 'utf8' });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exit(1); });
