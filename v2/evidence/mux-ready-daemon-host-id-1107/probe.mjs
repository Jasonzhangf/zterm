// Isolated mux-ready probe with guaranteed child cleanup.
//
// Task identity is supplied through the daemon's supported process-level
// configuration entry `ZTERM_TRAVERSAL_HOST_ID`/`ZTERM_TRAVERSAL_RELAY_*`.
// This probe does NOT override HOME or ZTERM_HOME and does not write any
// production config file. The daemon still reads its existing ~/.zterm config
// as usual; only the child process env is task-specific.
//
// Usage:
//   node probe.mjs                     # isolated success receipt
//   node probe.mjs --expect-startup-failure  # forced startup-failure cleanup receipt
//
// The entire post-spawn lifecycle runs under try/finally. Cleanup kills only
// the exact spawned child, waits for its exit, then removes the probe scratch
// directory.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { finalizeProbeScratch } from './cleanup-receipt.mjs';

const root = '/Volumes/Intel/playground/zterm/worktrees/mux-ready-daemon-host-id-20261107';
const androidRoot = join(root, 'android');
const require = createRequire(join(androidRoot, 'package.json'));
const { WebSocket } = require('ws');

const EXPECT_STARTUP_FAILURE = process.argv.includes('--expect-startup-failure');
const expectedHostId = `probe-${randomBytes(6).toString('hex')}`;
const authToken = `probe-${randomBytes(6).toString('hex')}`;
const scratchRoot = await mkdtemp(join(tmpdir(), 'zterm-mux-ready-probe-'));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopOwnedChild(child, transcript) {
  if (!child || typeof child.pid !== 'number') {
    return { pid: null, exited: true };
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      pid: child.pid,
      exited: true,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    };
  }
  child.kill('SIGTERM');
  transcript.push(`cleanup: SIGTERM pid=${child.pid}`);
  let exited = await waitForExit(child, 5000);
  if (!exited) {
    child.kill('SIGKILL');
    transcript.push(`cleanup: SIGKILL pid=${child.pid}`);
    exited = await waitForExit(child, 3000);
  }
  return {
    pid: child.pid,
    exited,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
  };
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate probe port')));
        return;
      }
      resolve({ port: address.port, server });
    });
  });
}

async function waitForServer(url, child, timeoutMs, transcript) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return {
        ok: false,
        reason: `child exited before ready: code=${child.exitCode} signal=${child.signalCode}`,
        lastError,
      };
    }
    try {
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.close();
      return { ok: true, lastError: null };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      transcript.push(`waitForServer retry: ${lastError}`);
      await delay(250);
    }
  }
  return { ok: false, reason: 'timeout', lastError };
}

function requestMuxReady(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('mux-ready timeout'));
    }, 8000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'mux-hello',
        payload: {
          version: 1,
          clientInstanceId: 'mux-ready-probe',
        },
      }));
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'mux-ready') {
        clearTimeout(timer);
        ws.close();
        resolve(message);
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const reservation = await reservePort();
const port = reservation.port;
if (!EXPECT_STARTUP_FAILURE) {
  await new Promise((resolve) => reservation.server.close(resolve));
}

const transcript = [];
let child = null;
let frame = null;
let failure = null;
let cleanup = null;

try {
  child = spawn(
    join(androidRoot, 'node_modules', '.bin', 'tsx'),
    [join(androidRoot, 'src', 'server', 'server.ts')],
    {
      cwd: androidRoot,
      env: {
        ...process.env,
        ZTERM_PORT: String(port),
        ZTERM_HOST: '127.0.0.1',
        ZTERM_AUTH_TOKEN: authToken,
        // Supported daemon config entry: task-specific relay identity.
        // The relay URL points at a closed local port so the child never
        // reaches a real relay; the unref'd reconnect timer does not block exit.
        ZTERM_TRAVERSAL_RELAY_URL: 'http://127.0.0.1:1/relay/',
        ZTERM_TRAVERSAL_USERNAME: 'mux-ready-probe',
        ZTERM_TRAVERSAL_PASSWORD: 'mux-ready-probe',
        ZTERM_TRAVERSAL_HOST_ID: expectedHostId,
        // Intentionally no HOME or ZTERM_HOME override.
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  transcript.push(`CHILD_PID=${child.pid}`);
  child.stdout.on('data', (chunk) => transcript.push(`[stdout] ${String(chunk).trim()}`));
  child.stderr.on('data', (chunk) => transcript.push(`[stderr] ${String(chunk).trim()}`));

  const wsUrl = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(authToken)}`;
  const connect = await waitForServer(
    wsUrl,
    child,
    EXPECT_STARTUP_FAILURE ? 4000 : 15000,
    transcript,
  );
  if (!connect.ok) {
    throw new Error(`daemon did not come up: ${connect.reason} (lastError=${connect.lastError})`);
  }
  frame = await requestMuxReady(wsUrl);
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  cleanup = await finalizeProbeScratch({
    scratchRoot,
    childResult: await stopOwnedChild(child, transcript),
    transcript,
  });
  if (EXPECT_STARTUP_FAILURE) {
    await new Promise((resolve) => reservation.server.close(resolve));
  }
}

cleanup = {
  ...cleanup,
  exitCode: cleanup.exitCode ?? null,
  signalCode: cleanup.signalCode ?? null,
};
const cleanupReceipt = cleanup;
const cleanupSucceeded = cleanup.ok === true && cleanup.exited === true;

if (!cleanupSucceeded) {
  failure ??= new Error(`owned child cleanup failed: ${cleanup.reason ?? 'unknown cleanup failure'}`);
}

if (EXPECT_STARTUP_FAILURE) {
  const forcedFailureObserved = failure !== null;
  console.log(JSON.stringify({
    mode: 'startup-failure-cleanup',
    forcedFailureObserved,
    failureMessage: failure?.message ?? null,
    cleanup: cleanupReceipt,
    ok: forcedFailureObserved && cleanupSucceeded,
  }, null, 2));
  if (!forcedFailureObserved || !cleanupSucceeded) {
    throw new Error('startup-failure cleanup assertion failed');
  }
  process.exit(0);
}

if (failure) {
  console.log(JSON.stringify({
    mode: 'success',
    failureMessage: failure.message,
    cleanup: cleanupReceipt,
    ok: false,
  }, null, 2));
  process.exit(1);
}

const payload = frame?.payload || {};
const receivedHostId = typeof payload.daemonHostId === 'string' ? payload.daemonHostId : '';
const ok = frame?.type === 'mux-ready'
  && receivedHostId === expectedHostId
  && cleanupSucceeded;

console.log(JSON.stringify({
  type: frame?.type ?? null,
  payload: {
    version: payload.version ?? null,
    daemonHostId: receivedHostId || null,
  },
  expectedHostId,
  identitySource: 'ZTERM_TRAVERSAL_HOST_ID (daemon config env)',
  homeOverride: false,
  cleanup: cleanupReceipt,
  ok,
}, null, 2));

if (!ok) {
  throw new Error(`mux-ready daemonHostId assertion failed: expected=${expectedHostId} received=${receivedHostId || '(missing)'}`);
}
