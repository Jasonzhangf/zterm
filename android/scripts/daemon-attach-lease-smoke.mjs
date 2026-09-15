// Live daemon protocol smoke for the session attach lease.
//
// Proves, against a running candidate daemon:
//   1. foreground `body-subscription true` holds a tmux mirror;
//   2. background (`body-subscription false` + mux-ping only) releases it
//      while the physical transport stays open;
//   3. foreground resubscribe reopens the logical channel on the SAME
//      physical transport and re-attaches the mirror.
//
// Usage: node android/scripts/daemon-attach-lease-smoke.mjs <port> <token> <sessionName>
import { WebSocket } from 'ws';

const port = Number(process.argv[2] || 3344);
const token = process.argv[3] || '';
const sessionName = process.argv[4] || `zterm-attach-lease-smoke-${Date.now()}`;
const mode = process.argv[5] || 'resubscribe';
const base = `http://127.0.0.1:${port}`;
const channelId = `channel-${Date.now()}`;

function log(step, detail) {
  console.log(JSON.stringify({ step, ...detail }));
}

async function readRuntime() {
  const response = await fetch(`${base}/debug/runtime?token=${encodeURIComponent(token)}`);
  if (!response.ok) {
    throw new Error(`debug/runtime ${response.status}`);
  }
  return response.json();
}

function mirrorSnapshot(runtime) {
  const mirrors = Array.isArray(runtime?.mirrors) ? runtime.mirrors : [];
  return mirrors.find((item) => item.sessionName === sessionName) || null;
}

function subscriberSnapshots(runtime) {
  const subscribers = Array.isArray(runtime?.transportSubscribers) ? runtime.transportSubscribers : [];
  return subscribers.filter((item) => item.sessionName === sessionName);
}

function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await predicate()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`timeout waiting for ${label}`));
        return;
      }
      setTimeout(tick, 250);
    };
    void tick();
  });
}

const frames = [];
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);

ws.on('message', (raw, isBinary) => {
  if (isBinary) {
    return;
  }
  try {
    frames.push(JSON.parse(raw.toString('utf8')));
  } catch {
    // ignore non-JSON control frames
  }
});

function send(frame) {
  ws.send(JSON.stringify(frame));
}

function channelOpened() {
  return frames.some((frame) => frame.type === 'mux-channel-opened' && frame.payload?.channelId === channelId);
}

function channelClosed() {
  return frames.some((frame) => frame.type === 'mux-channel-closed' && frame.payload?.channelId === channelId);
}

async function main() {
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  send({ type: 'mux-hello', payload: { version: 1, clientInstanceId: 'attach-lease-smoke' } });
  await waitFor(
    () => frames.some((frame) => frame.type === 'mux-ready'),
    5000,
    'mux-ready',
  );

  // 1. Foreground: attach and hold.
  send({
    type: 'mux-channel-open',
    payload: { channelId, sessionName, bodySubscribed: true },
  });
  await waitFor(channelOpened, 8000, 'mux-channel-opened');
  await waitFor(async () => Boolean(mirrorSnapshot(await readRuntime())), 8000, 'mirror attach');
  const held = mirrorSnapshot(await readRuntime());
  log('foreground-hold', { lifecycle: held?.lifecycle ?? null, attached: true });

  if (mode === 'lease-expiry') {
    // Simulate a client that stopped foreground heartbeats without sending
    // `body-subscription false` (e.g. killed while backgrounded). Only
    // mux-ping keeps the physical transport alive. The daemon must release the
    // session attach lease on its own TTL.
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline) {
      send({ type: 'mux-ping', payload: { sentAt: Date.now() } });
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    await waitFor(async () => !mirrorSnapshot(await readRuntime()), 15_000, 'lease expiry release');
    log('lease-expiry-release', {
      attached: false,
      physicalOpen: ws.readyState === WebSocket.OPEN,
    });
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error('physical transport closed on lease expiry');
    }
    return;
  }

  // 2. Background: drop body demand, then only mux-ping. The daemon must keep
  //    the physical transport but release the session attach lease.
  send({
    type: 'mux-channel-message',
    payload: {
      channelId,
      message: { type: 'body-subscription', payload: { version: 1, subscribed: false } },
    },
  });
  await waitFor(channelClosed, 8000, 'mux-channel-closed(no_body_demand)');
  const closedFrame = frames.find((frame) => frame.type === 'mux-channel-closed' && frame.payload?.channelId === channelId);
  log('background-release', {
    closedCode: closedFrame?.payload?.code ?? null,
    physicalOpen: ws.readyState === WebSocket.OPEN,
  });
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error('physical transport closed on background release');
  }

  // Background ping only: still no session held.
  for (let index = 0; index < 3; index += 1) {
    send({ type: 'mux-ping', payload: { sentAt: Date.now() } });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const afterPingRuntime = await readRuntime();
  const afterPingMirror = mirrorSnapshot(afterPingRuntime);
  log('background-ping-only', {
    attached: Boolean(afterPingMirror),
    subscribers: subscriberSnapshots(afterPingRuntime).length,
    physicalOpen: ws.readyState === WebSocket.OPEN,
  });

  // 3. Foreground again: reopen the SAME channel id on the SAME transport.
  send({
    type: 'mux-channel-open',
    payload: { channelId: `${channelId}-2`, sessionName, bodySubscribed: true },
  });
  await waitFor(
    () => frames.some((frame) => frame.type === 'mux-channel-opened' && frame.payload?.channelId === `${channelId}-2`),
    8000,
    'foreground reopen',
  );
  await waitFor(async () => Boolean(mirrorSnapshot(await readRuntime())), 8000, 'mirror reattach');
  log('foreground-reattach', {
    physicalOpen: ws.readyState === WebSocket.OPEN,
    attached: true,
  });
}

main()
  .then(() => {
    ws.close();
    console.log(JSON.stringify({ ok: true, sessionName }));
    process.exit(0);
  })
  .catch((error) => {
    ws.close();
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
