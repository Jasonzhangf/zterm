import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  RTC_FIXTURE_KIND,
  RTC_FIXTURE_SCHEMA_VERSION,
  assertOwnedRuntimePath,
  assertPrivateReceipt,
  buildPublicReceipt,
  extractCloudflaredQuickTunnelUrl,
  fixtureCleanupCommand,
  fixtureRunPaths,
  parseRtcFixtureArgs,
  readPrivateReceipt,
  waitForRtcFixtureHold,
  writePrivateReceipt,
} from './rtc-fixture-helper.mjs';

function receiptFixture(evidenceDir) {
  const runId = 'fixture-run-1';
  const paths = fixtureRunPaths(evidenceDir, runId);
  return {
    schemaVersion: RTC_FIXTURE_SCHEMA_VERSION,
    kind: RTC_FIXTURE_KIND,
    runId,
    managedTest: true,
    state: 'held',
    status: 'ready',
    ok: true,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:01.000Z',
    evidenceDir,
    runtimeRoot: paths.runtimeRoot,
    homeDir: join(paths.runtimeRoot, 'home'),
    tmpDir: join(paths.runtimeRoot, 'tmp'),
    receiptPath: paths.receiptPath,
    publicReceiptPath: paths.publicReceiptPath,
    relayBaseUrl: 'http://127.0.0.1:49152',
    publicRelayBaseUrl: 'https://fixture.trycloudflare.com/',
    username: 'fixture-private-username',
    password: 'fixture-private-password',
    accessToken: 'fixture-private-access-token',
    deviceId: 'fixture-device',
    daemonHostId: 'fixture-host',
    sessionName: `rtc-fixture-${runId}`,
    backend: 'tmux',
    stableId: 'tmux:fixture-stable-id',
    relay: {
      pid: 101,
      logPath: join(paths.runtimeRoot, 'logs', 'relay.log'),
    },
    daemon: {
      pid: 102,
      authToken: 'fixture-private-daemon-token',
      nativePath: '/fixture/dagpipe.node',
      endpoint: 'http://127.0.0.1:49153',
      listener: { host: '0.0.0.0', port: 49153 },
      logPath: join(paths.runtimeRoot, 'logs', 'daemon.log'),
    },
    tmux: {
      binary: '/fixture/tmux',
      socketPath: paths.tmuxSocketPath,
      serverPid: 103,
    },
    turn: {
      required: true,
      configured: true,
      containerId: 'a'.repeat(64),
      containerName: `zterm-rtc-fixture-coturn-${runId}`,
      listeningPort: 49154,
      relayPortRange: { min: 50000, max: 50015 },
      authConfigPath: join(paths.runtimeRoot, 'coturn', 'turnserver.conf'),
      username: 'fixture-private-turn-user',
      credential: 'fixture-private-turn-credential',
    },
    cleanup: {
      state: 'pending',
      command: null,
      resources: null,
    },
    gaps: [],
  };
}

test('parses the bounded fixture CLI and rejects ambiguous cleanup', () => {
  const parsed = parseRtcFixtureArgs([
    '--evidence-dir',
    './evidence',
    '--hold',
    '--expose-relay',
    '--turn-required',
    '--native-path',
    './dagpipe.node',
  ]);
  assert.equal(parsed.evidenceDir, resolve('./evidence'));
  assert.equal(parsed.hold, true);
  assert.equal(parsed.exposeRelay, true);
  assert.equal(parsed.turnRequired, true);
  assert.equal(parsed.nativePath, resolve('./dagpipe.node'));
  assert.throws(
    () => parseRtcFixtureArgs(['--unknown']),
    /unknown rtc fixture argument/u,
  );
  assert.throws(
    () => parseRtcFixtureArgs([
      '--cleanup-private-receipt',
      './receipt.json',
      '--hold',
    ]),
    /cannot be combined/u,
  );
});

test('writes a schema-valid private receipt with mode 0600', () => {
  const root = mkdtempSync(join(tmpdir(), 'rtc-fixture-test-'));
  const receipt = receiptFixture(root);
  try {
    writePrivateReceipt(receipt.receiptPath, receipt);
    assert.equal(statSync(receipt.receiptPath).mode & 0o777, 0o600);
    assert.deepEqual(readPrivateReceipt(receipt.receiptPath), receipt);
    assert.match(readFileSync(receipt.receiptPath, 'utf8'), /"managedTest": true/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('public receipt redacts all fixture credentials and tokens', () => {
  const root = mkdtempSync(join(tmpdir(), 'rtc-fixture-public-'));
  const receipt = receiptFixture(root);
  try {
    receipt.selfcheck = {
      direct: {
        attempted: true,
        ok: true,
        path: 'rtc-direct',
        relayTransport: 'direct',
        selectedIcePair: {
          local: { candidateType: 'host', protocol: 'udp' },
          remote: { candidateType: 'host', protocol: 'udp' },
          roundTripTimeMs: 1,
        },
        muxReady: true,
        ownedSessionVisible: true,
      },
    };
    const publicReceipt = buildPublicReceipt(receipt);
    const serialized = JSON.stringify(publicReceipt);
    for (const secret of [
      receipt.username,
      receipt.password,
      receipt.accessToken,
      receipt.daemon.authToken,
      receipt.turn.username,
      receipt.turn.credential,
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.equal(publicReceipt.receipt.privatePath, receipt.receiptPath);
    assert.equal(publicReceipt.selfcheck.direct.relayTransport, 'direct');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('private receipt validation rejects foreign runtime and coturn identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'rtc-fixture-owned-'));
  const receipt = receiptFixture(root);
  try {
    const ownedFile = join(receipt.runtimeRoot, 'owned.txt');
    assert.equal(assertOwnedRuntimePath(receipt, ownedFile), ownedFile);
    assert.throws(
      () => assertOwnedRuntimePath(receipt, join(root, 'foreign.sock')),
      /escapes runtimeRoot/u,
    );
    assert.throws(
      () => assertPrivateReceipt({
        ...structuredClone(receipt),
        runtimeRoot: join(root, 'rtc-fixture-runs', receipt.runId, 'foreign-runtime'),
      }),
      /runtimeRoot/u,
    );
    assert.throws(
      () => assertPrivateReceipt({
        ...structuredClone(receipt),
        turn: {
          ...receipt.turn,
          containerName: 'zterm-rtc-fixture-coturn-foreign',
        },
      }),
      /container name is not owned/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extracts only a real quick tunnel URL from cloudflared output', () => {
  const output = [
    'INF Requesting new quick Tunnel on trycloudflare.com...',
    'INF |  https://example-test.trycloudflare.com  |',
    'INF Registered tunnel connection',
  ].join('\n');
  assert.equal(
    extractCloudflaredQuickTunnelUrl(output),
    'https://example-test.trycloudflare.com',
  );
  assert.equal(extractCloudflaredQuickTunnelUrl('no tunnel url'), '');
});

test('cleanup command targets only the private receipt', () => {
  const scriptPath = '/fixture/rtc-fixture.mjs';
  const receiptPath = '/fixture/evidence/private/receipt.json';
  const command = fixtureCleanupCommand(scriptPath, receiptPath);
  assert.match(command, /--cleanup-private-receipt/u);
  assert.equal(command.includes(scriptPath), true);
  assert.equal(command.includes(receiptPath), true);
  assert.doesNotMatch(command, /kill-server|docker prune|rm -rf/u);
});

test('hold waits until the owned receipt reports cleanup completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rtc-fixture-hold-'));
  const receipt = receiptFixture(root);
  try {
    writePrivateReceipt(receipt.receiptPath, receipt);
    const closed = structuredClone(receipt);
    closed.state = 'closed';
    closed.cleanup = {
      ...closed.cleanup,
      state: 'complete',
      completedAt: '2026-10-20T00:00:02.000Z',
    };
    setTimeout(() => writePrivateReceipt(closed.receiptPath, closed), 20);
    const observed = await waitForRtcFixtureHold(receipt.receiptPath, {
      pollMs: 5,
    });
    assert.equal(observed.state, 'closed');
    assert.equal(observed.cleanup.state, 'complete');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
