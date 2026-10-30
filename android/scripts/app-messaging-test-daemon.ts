/**
 * Isolated `/app` transport process for the cross-machine E2E gate.
 *
 * It composes the product owners directly (`daemon.app_gateway`,
 * `daemon.app_messaging`, and the durable store) on a minimal HTTP server so
 * the test never starts terminal services, tmux, or relay state.
 */
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import {
  createDaemonAppMessagingRuntime,
} from '../src/server/daemon-app-messaging-runtime';
import { createDaemonAppGateway } from '../src/server/daemon-app-websocket-runtime';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim() ?? '';
  if (!value) {
    console.error(`missing required env ${name}`);
    process.exit(2);
  }
  return value;
}

const port = Number(requiredEnv('APP_TEST_PORT'));
const token = requiredEnv('ZTERM_AUTH_TOKEN');
const deviceId = requiredEnv('ZTERM_TRAVERSAL_DEVICE_ID');
const daemonHostId = requiredEnv('ZTERM_TRAVERSAL_HOST_ID');
const appRootDir = requiredEnv('ZTERM_APP_ROOT');
const maxInboxRecords = process.env.APP_TEST_MAX_INBOX_RECORDS
  ? Number(process.env.APP_TEST_MAX_INBOX_RECORDS)
  : undefined;
const peerRequestTimeoutMs = process.env.APP_TEST_PEER_TIMEOUT_MS
  ? Number(process.env.APP_TEST_PEER_TIMEOUT_MS)
  : undefined;

if (!Number.isInteger(port) || port <= 0) {
  console.error('APP_TEST_PORT must be a positive integer');
  process.exit(2);
}

const home = homedir();
const messaging = createDaemonAppMessagingRuntime({
  appRootDir: appRootDir || home,
  deviceId,
  daemonHostId,
  ...(maxInboxRecords === undefined ? {} : { maxInboxRecords }),
  ...(peerRequestTimeoutMs === undefined ? {} : { peerRequestTimeoutMs }),
});
await messaging.initialize();

const server = createServer((_request, response) => {
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});

const gateway = createDaemonAppGateway({
  requiredAuthToken: token,
  daemonHostId,
  deviceId,
  messaging,
  log: (message) => console.error(`[app-test-daemon] ${message}`),
});

server.on('upgrade', (request, socket, head) => {
  if (gateway.handleServerUpgrade(request, socket, head)) return;
  socket.destroy();
});

let closing = false;
function shutdown(reason: string, code = 0) {
  if (closing) return;
  closing = true;
  console.error(`[app-test-daemon] shutdown: ${reason}`);
  gateway.dispose();
  messaging.dispose();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1500).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));

server.listen(port, '127.0.0.1', () => {
  console.log(`[app-test-daemon] ready ${deviceId} ${daemonHostId} 127.0.0.1:${port}`);
});
