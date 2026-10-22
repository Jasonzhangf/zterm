import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startCoturn } from './rtc-fixture.mjs';
import { spawnOwnedFixtureBridge } from './fixture-turn-bridge.mjs';

const index = process.argv.indexOf('--evidence-dir');
if (index < 0 || !process.argv[index + 1]) throw new Error('--evidence-dir is required');
const prepareNextConnection = process.argv.includes('--prepare-next-connection');
const evidenceDir = resolve(process.argv[index + 1]);
mkdirSync(evidenceDir, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'zterm-turn-foundation-'));
const receipt = { runId: `foundation-${Date.now()}-${randomBytes(3).toString('hex')}`, runtimeRoot: root };
const wrtc = createRequire(import.meta.url)('@roamhq/wrtc');
const peers = [];
const channels = [];
let turn;
let frontend;
let client;
let tunnel;
let error;
const result = { coverage: 'real-turn-rtc-foundation', physicalPath: 'TURN/TCP over loopback WebSocket',
  nativePublicUdpProved: false, prepareNextConnection, ok: false, cleanup: {} };

function resolvePublicIpv4(host) {
  const lookup = spawnSync('curl', ['--fail', '--silent', '--show-error', '--max-time', '15',
    `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`], { encoding: 'utf8' });
  assert.equal(lookup.status, 0, 'live fixture DNS lookup failed');
  const address = JSON.parse(lookup.stdout).Answer?.find(answer => answer.type === 1)?.data;
  assert(address, 'live fixture DNS lookup returned no IPv4 address');
  return address;
}

function bounded(promise, label, timeout = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeout);
  })]).finally(() => clearTimeout(timer));
}
function event(target, name) {
  const waiting = new Promise(resolveEvent => {
    const handler = value => { target.removeEventListener(name, handler); resolveEvent(value); };
    target.addEventListener(name, handler);
  });
  return waiting;
}
async function gather(peer) {
  if (peer.iceGatheringState === 'complete') return;
  await bounded(new Promise(resolveGather => {
    peer.onicegatheringstatechange = () => {
      if (peer.iceGatheringState === 'complete') {
        peer.onicegatheringstatechange = null;
        resolveGather();
      }
    };
  }), 'ICE gathering');
}
async function selectedPair(peer) {
  const stats = await peer.getStats();
  let pair;
  stats.forEach(record => {
    if (record.type === 'transport' && record.selectedCandidatePairId) pair = stats.get(record.selectedCandidatePairId);
  });
  assert(pair, 'native selected ICE pair is required');
  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  assert.equal(local?.candidateType, 'relay');
  assert.equal(remote?.candidateType, 'relay');
  return { localCandidateType: local.candidateType, remoteCandidateType: remote.candidateType,
    localProtocol: local.protocol, remoteProtocol: remote.protocol };
}

try {
  turn = await startCoturn({ turnRequested: true, turnRequired: true, turnTransport: 'tcp' }, receipt);
  assert(turn.configured, turn.error);
  assert(turn.url.endsWith('transport=tcp'));
  const token = randomBytes(24).toString('hex');
  const frontendControl = join(root, 'frontend.json');
  writeFileSync(frontendControl, JSON.stringify({ role: 'frontend', options: {
    listenHost: '127.0.0.1', listenPort: 0, relayOrigin: 'http://127.0.0.1:1',
    turnTarget: { host: '127.0.0.1', port: turn.listeningPort }, token,
  } }), { mode: 0o600 });
  frontend = await spawnOwnedFixtureBridge({ role: 'frontend', controlPath: frontendControl,
    logPath: join(root, 'frontend.log') });
  await frontend.ready;
  result.frontendPid = frontend.pid;
  const bridgeUrl = new URL('/fixture/turn', frontend.origin);
  bridgeUrl.protocol = 'ws:';
  let resolvedBridgeAddress;
  if (process.argv.includes('--public-wss')) {
    const edge = resolvePublicIpv4('region1.v2.argotunnel.com');
    const logPath = join(evidenceDir, 'cloudflared.log');
    const log = openSync(logPath, 'a', 0o600);
    tunnel = spawn('cloudflared', ['tunnel', '--edge', `${edge}:7844`, '--protocol', 'http2',
      '--url', frontend.origin, '--no-autoupdate'], { stdio: ['ignore', log, log] });
    closeSync(log);
    result.tunnelPid = tunnel.pid;
    result.edgeAddress = edge;
    const deadline = Date.now() + 60000;
    let publicOrigin;
    while (Date.now() < deadline && tunnel.exitCode === null) {
      const output = readFileSync(logPath, 'utf8');
      publicOrigin = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/u)?.[0];
      if (publicOrigin && output.includes('Registered tunnel connection')) break;
      await delay(250);
    }
    assert(publicOrigin && readFileSync(logPath, 'utf8').includes('Registered tunnel connection'), 'public fixture tunnel not ready');
    bridgeUrl.href = new URL('/fixture/turn', publicOrigin).href;
    bridgeUrl.protocol = 'wss:';
    resolvedBridgeAddress = resolvePublicIpv4(bridgeUrl.hostname);
    result.physicalPath = 'TURN/TCP over authenticated public WSS';
    result.publicOrigin = publicOrigin;
  }
  const clientControl = join(root, 'client.json');
  writeFileSync(clientControl, JSON.stringify({ role: 'client', options: {
    listenHost: '127.0.0.1', listenPort: 0, bridgeUrl: bridgeUrl.href, token, resolvedBridgeAddress,
  } }), { mode: 0o600 });
  client = await spawnOwnedFixtureBridge({ role: 'client', controlPath: clientControl,
    logPath: join(root, 'client.log') });
  await client.ready;
  result.clientPid = client.pid;
  const config = { iceTransportPolicy: 'relay', iceServers: [{
    urls: `turn:127.0.0.1:${client.listeningPort}?transport=tcp`, username: turn.username, credential: turn.credential,
  }] };
  if (prepareNextConnection) {
    await client.prepareNextConnection();
    result.prepareNextConnectionReady = true;
  }
  const first = new wrtc.RTCPeerConnection(config);
  const second = new wrtc.RTCPeerConnection(config);
  peers.push(first, second);
  const incoming = event(second, 'datachannel');
  const outgoing = first.createDataChannel('fixture-turn-foundation');
  channels.push(outgoing);
  await first.setLocalDescription(await first.createOffer());
  await gather(first);
  await second.setRemoteDescription(first.localDescription);
  await second.setLocalDescription(await second.createAnswer());
  await gather(second);
  await first.setRemoteDescription(second.localDescription);
  result.candidates = peers.map(peer => peer.localDescription.sdp.split('\r\n')
    .filter(line => line.startsWith('a=candidate:')));
  const accepted = (await bounded(incoming, 'datachannel')).channel;
  channels.push(accepted);
  await Promise.all(channels.map(channel => channel.readyState === 'open' ? Promise.resolve() : bounded(event(channel, 'open'), 'open')));
  const payloadA = Buffer.from([0, 1, 255, 7, 0, 89]);
  const payloadB = Buffer.from('actual-TURN-foundation');
  const firstMessage = event(outgoing, 'message');
  const secondMessage = event(accepted, 'message');
  outgoing.send(payloadA);
  accepted.send(payloadB);
  assert(Buffer.from((await bounded(firstMessage, 'first binary message')).data).equals(payloadB));
  assert(Buffer.from((await bounded(secondMessage, 'second binary message')).data).equals(payloadA));
  result.pairs = await Promise.all(peers.map(selectedPair));
  result.bidirectionalBinary = true;
  result.turnControlTransport = 'tcp';
  await Promise.all([frontend.assertHealthy(), client.assertHealthy()]);
  result.ok = true;
} catch (failure) {
  error = failure;
  result.error = failure.message;
  result.peerStates = peers.map(peer => ({ ice: peer.iceConnectionState, connection: peer.connectionState }));
} finally {
  for (const channel of channels) channel.close();
  for (const peer of peers) peer.close();
  const deadline = Date.now() + 2000;
  while (channels.some(channel => channel.readyState !== 'closed') && Date.now() < deadline) await delay(10);
  result.cleanup.peersClosed = peers.every(peer => peer.connectionState === 'closed')
    && channels.every(channel => channel.readyState === 'closed');
  for (const [name, owner] of [['client', client], ['frontend', frontend]]) {
    try { result.cleanup[name] = owner ? await owner.close() : { closed: true, errors: [] }; }
    catch (failure) { result.cleanup[name] = { closed: false, errors: [failure.message] }; }
  }
  if (tunnel && tunnel.exitCode === null) {
    const exited = new Promise(resolveExit => tunnel.once('exit', resolveExit));
    tunnel.kill('SIGTERM');
    try { await bounded(exited, 'tunnel close'); } catch (failure) { result.cleanup.tunnelError = failure.message; }
  }
  result.cleanup.tunnelClosed = !tunnel || tunnel.exitCode !== null || tunnel.signalCode !== null;
  if (turn?.containerId) {
    const logs = spawnSync(turn.dockerBinary, ['logs', turn.containerId], { encoding: 'utf8' });
    const safe = `${logs.stdout ?? ''}\n${logs.stderr ?? ''}`.replaceAll(turn.credential, '[redacted]');
    writeFileSync(join(evidenceDir, 'coturn.log'), safe);
    const stop = spawnSync(turn.dockerBinary, ['stop', '--time', '1', turn.containerId], { encoding: 'utf8' });
    const remove = spawnSync(turn.dockerBinary, ['rm', turn.containerId], { encoding: 'utf8' });
    result.cleanup.coturnRemoved = stop.status === 0 && remove.status === 0;
  } else result.cleanup.coturnRemoved = true;
  result.cleanup.complete = result.cleanup.peersClosed && result.cleanup.client.closed
    && result.cleanup.frontend.closed && result.cleanup.coturnRemoved && result.cleanup.tunnelClosed;
  result.ok &&= result.cleanup.complete;
  if (result.cleanup.complete) rmSync(root, { recursive: true, force: true });
  else result.cleanup.retainedRoot = root;
  writeFileSync(join(evidenceDir, 'foundation-result.json'), JSON.stringify(result, null, 2));
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n', () => process.exit(result.ok && !error ? 0 : 1));
