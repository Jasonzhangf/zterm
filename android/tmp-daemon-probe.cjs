const WebSocket = require('ws');

const host = '127.0.0.1';
const port = 3333;
const token = 'wterm-4123456';
const targetSessionName = process.argv[2];
if (!targetSessionName) throw new Error('need session name');
const clientSessionId = `probe-${targetSessionName}-${Date.now()}`;
const base = `ws://${host}:${port}/ws?token=${encodeURIComponent(token)}`;
const connectPayloadBase = {
  clientSessionId,
  name: targetSessionName,
  bridgeHost: host,
  bridgePort: port,
  sessionName: targetSessionName,
  terminalWidthMode: 'mirror-fixed',
  authToken: token,
  authType: 'password',
};

function waitFor(ws, predicate, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    const onMessage = (data) => {
      const msg = JSON.parse(String(data));
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
  });
}

async function main() {
  const control = new WebSocket(base);
  await new Promise((resolve, reject) => {
    control.once('open', resolve);
    control.once('error', reject);
  });
  control.send(JSON.stringify({ type: 'session-open', payload: connectPayloadBase }));
  const ticketMsg = await waitFor(control, (msg) => msg.type === 'session-ticket');
  const sessionTransportToken = ticketMsg.payload.sessionTransportToken;

  const sessionWs = new WebSocket(base);
  const events = [];
  sessionWs.on('message', (data) => {
    try { events.push(JSON.parse(String(data))); } catch {}
  });
  await new Promise((resolve, reject) => {
    sessionWs.once('open', resolve);
    sessionWs.once('error', reject);
  });
  sessionWs.send(JSON.stringify({ type: 'connect', payload: { ...connectPayloadBase, sessionTransportToken } }));
  await waitFor(sessionWs, (msg) => msg.type === 'connected');
  const headMsg = await waitFor(sessionWs, (msg) => msg.type === 'buffer-head');
  const head = headMsg.payload || {};
  sessionWs.send(JSON.stringify({ type: 'buffer-sync-request', payload: {
    knownRevision: 0,
    localStartIndex: 0,
    localEndIndex: 0,
    requestStartIndex: Math.max(0, (head.availableEndIndex || head.latestEndIndex || 0) - 120),
    requestEndIndex: head.availableEndIndex || head.latestEndIndex || 0,
  } }));
  const syncMsg = await waitFor(sessionWs, (msg) => msg.type === 'buffer-sync');
  console.log(JSON.stringify({ session: targetSessionName, head, sync: syncMsg.payload || null }, null, 2));
  sessionWs.close();
  control.close();
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
