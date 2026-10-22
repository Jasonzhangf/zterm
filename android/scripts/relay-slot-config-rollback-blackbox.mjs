#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import {
  apiRequest,
  assertNoForbiddenCloudFields,
  closeWebSocket,
  loginAccount,
  prepareCandidateRelayPackage,
  presenceWriteViaDaemonSocket,
  registerAccount,
  relayFailureText,
  resolvePreviousRelayRuntime,
  startRelayRuntime,
  stopRelayRuntime,
  writePrivateJson,
} from '../../packages/cli/scripts/slot-sync-fixture-helper.mjs';
import { redactText } from '../../packages/cli/scripts/platform-smoke-helper.mjs';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const androidDir = resolve(scriptDir, '..');
const repoRoot = resolve(androidDir, '..');

function isoNow() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function outsideSource(path) {
  const relation = relative(repoRoot, path);
  return relation.startsWith('..') || isAbsolute(relation);
}

export function parseRollbackArgs(argv, env = process.env) {
  const options = {
    evidenceDir: undefined,
    previousRelayRuntime: env.ZTERM_PREVIOUS_RELAY_RUNTIME
      ? resolve(env.ZTERM_PREVIOUS_RELAY_RUNTIME)
      : undefined,
    timeoutMs: 60_000,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--evidence-dir') {
      const value = argv[++index];
      if (!value) throw new Error('--evidence-dir requires a value');
      options.evidenceDir = resolve(value);
      continue;
    }
    if (arg === '--previous-relay-runtime') {
      const value = argv[++index];
      if (!value) throw new Error('--previous-relay-runtime requires a value');
      options.previousRelayRuntime = resolve(value);
      continue;
    }
    if (arg === '--timeout-ms') {
      const timeoutMs = Number(argv[++index]);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
        throw new Error('--timeout-ms must be an integer of at least 1000');
      }
      options.timeoutMs = timeoutMs;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`unknown rollback blackbox argument: ${arg}`);
  }
  return options;
}

class SkippedCase extends Error {}

function cloudSlot(slot, name, options = {}) {
  return {
    slot,
    server: {
      deviceId: `rollback-device-${name}`,
      daemonHostId: `rollback-host-${name}`,
      displayName: `Rollback ${name}`,
    },
    session: {
      backend: 'tmux',
      stableId: `rollback-stable-${name}`,
      name,
    },
    widthMode: options.widthMode || 'adaptive-phone',
    ...(options.alias ? { alias: options.alias } : {}),
  };
}

function normalizeConfig(config) {
  if (!config || config.configured !== true) return config;
  return {
    configured: true,
    slots: [...config.slots].sort((left, right) => left.slot - right.slot),
  };
}

async function main() {
  const options = parseRollbackArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'Usage: ZTERM_PREVIOUS_RELAY_RUNTIME=<actual previous server.cjs> '
        + 'node android/scripts/relay-slot-config-rollback-blackbox.mjs '
        + '--evidence-dir <dir> [--timeout-ms <ms>]\n',
    );
    return 0;
  }
  if (!options.evidenceDir) {
    throw new Error('--evidence-dir is required');
  }

  mkdirSync(options.evidenceDir, { recursive: true });
  const summaryPath = join(
    options.evidenceDir,
    'relay-slot-config-rollback-summary.json',
  );
  const receiptsPath = join(
    options.evidenceDir,
    'relay-slot-config-rollback-receipts.json',
  );
  const runLogPath = join(
    options.evidenceDir,
    'relay-slot-config-rollback-run.log',
  );
  const startedAt = isoNow();
  const secrets = new Set();
  const receipts = [];
  const passedCases = new Map();
  const cleanup = {
    relay: null,
    websocket: 'not-opened',
    tempRoot: undefined,
    tempRootRemoved: false,
  };
  let testRoot;
  let currentRelay;
  let candidatePackage;
  let previousRuntime;
  let cloudFileBeforeRollback = '';

  const sanitize = (value) => redactText(String(value), [...secrets]);
  const sanitizeValue = (value) => {
    if (Array.isArray(value)) return value.map(sanitizeValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, sanitizeValue(child)]),
      );
    }
    if (typeof value === 'string') return sanitize(value);
    return value;
  };

  const writeEvidence = (state = 'running', extra = {}) => {
    const passed = receipts.filter((entry) => entry.status === 'passed').length;
    const failed = receipts.filter((entry) => entry.status === 'failed').length;
    const skipped = receipts.filter((entry) => entry.status === 'skipped').length;
    const unverified = receipts.filter((entry) => entry.status === 'unverified').length;
    const summary = sanitizeValue({
      schemaVersion: 1,
      state,
      startedAt,
      finishedAt: state === 'running' ? undefined : isoNow(),
      host: {
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
      },
      input: {
        previousRelayRuntime: options.previousRelayRuntime,
        evidenceDir: options.evidenceDir,
      },
      candidateRelay: candidatePackage
        ? {
            name: candidatePackage.name,
            version: candidatePackage.version,
            runtime: candidatePackage.runtimePath,
          }
        : undefined,
      previousRelay: previousRuntime
        ? {
            packageName: previousRuntime.manifest?.name,
            packageVersion: previousRuntime.manifest?.version,
            runtime: previousRuntime.runtimePath,
          }
        : undefined,
      counts: { total: receipts.length, passed, failed, skipped, unverified },
      cleanup,
      evidence: {
        summary: summaryPath,
        receipts: receiptsPath,
        runLog: runLogPath,
      },
      ...extra,
    });
    writePrivateJson(summaryPath, summary);
    writePrivateJson(receiptsPath, sanitizeValue(receipts));
    writePrivateJson(runLogPath, {
      state,
      counts: summary.counts,
      lines: receipts.map((entry) => (
        `[${entry.startedAt}] ${entry.name} ${entry.status}: `
        + (entry.error || entry.reason || 'complete')
      )),
      cleanup,
    });
    return summary;
  };

  const runCase = async (name, input, action) => {
    const caseStartedAt = isoNow();
    const caseStartedMs = Date.now();
    try {
      const detail = await action();
      receipts.push({
        name,
        status: 'passed',
        startedAt: caseStartedAt,
        durationMs: Date.now() - caseStartedMs,
        input,
        result: detail?.result ?? { observed: true },
        sideEffects: detail?.sideEffects ?? {},
        cleanup: detail?.cleanup ?? {
          status: 'owned-resources-retained-until-final-cleanup',
        },
      });
      passedCases.set(name, true);
      writeEvidence();
      return true;
    } catch (error) {
      const skipped = error instanceof SkippedCase;
      receipts.push({
        name,
        status: skipped ? 'skipped' : 'failed',
        startedAt: caseStartedAt,
        durationMs: Date.now() - caseStartedMs,
        input,
        result: skipped
          ? { reason: sanitize(errorMessage(error)) }
          : { error: sanitize(errorMessage(error)) },
        sideEffects: error?.sideEffects ?? {},
        cleanup: { status: 'owned-resources-retained-until-final-cleanup' },
        ...(skipped ? { reason: sanitize(errorMessage(error)) } : {
          error: sanitize(errorMessage(error)),
        }),
      });
      passedCases.set(name, false);
      writeEvidence();
      return false;
    }
  };

  const requireCase = (name) => {
    if (!passedCases.get(name)) {
      throw new SkippedCase(`dependency did not pass: ${name}`);
    }
  };

  try {
    previousRuntime = resolvePreviousRelayRuntime(options.previousRelayRuntime);
  } catch (error) {
    receipts.push({
      name: 'previous-runtime-input',
      status: 'unverified',
      startedAt: isoNow(),
      durationMs: 0,
      input: { env: 'ZTERM_PREVIOUS_RELAY_RUNTIME' },
      result: { error: sanitize(errorMessage(error)) },
      sideEffects: {},
      cleanup: { status: 'not-started' },
      error: sanitize(errorMessage(error)),
    });
    writeEvidence('unverified');
    throw error;
  }
  if (!previousRuntime) {
    receipts.push({
      name: 'previous-runtime-input',
      status: 'unverified',
      startedAt: isoNow(),
      durationMs: 0,
      input: { env: 'ZTERM_PREVIOUS_RELAY_RUNTIME' },
      result: { reason: 'actual previous runnable relay runtime was not supplied' },
      sideEffects: {},
      cleanup: { status: 'not-started' },
      reason: 'actual previous runnable relay runtime was not supplied',
    });
    const summary = writeEvidence('unverified');
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 1;
  }
  if (!outsideSource(previousRuntime.runtimePath)) {
    throw new Error('ZTERM_PREVIOUS_RELAY_RUNTIME must point outside the source repository');
  }
  if (
    previousRuntime.manifest?.name
    && previousRuntime.manifest.name !== '@jsonstudio/zterm-relay-server'
  ) {
    throw new Error(
      `unexpected previous relay package name: ${previousRuntime.manifest.name}`,
    );
  }

  testRoot = join(
    tmpdir(),
    `zterm-relay-rollback-blackbox-${process.pid}-${Date.now()}`,
  );
  mkdirSync(testRoot, { recursive: true, mode: 0o700 });
  cleanup.tempRoot = testRoot;
  writeEvidence();

  await runCase('prepare-current-candidate-package', {}, async () => {
    candidatePackage = prepareCandidateRelayPackage(
      repoRoot,
      join(testRoot, 'candidate-relay-package'),
      Math.max(options.timeoutMs, 120_000),
    );
    return {
      result: {
        name: candidatePackage.name,
        version: candidatePackage.version,
        officialPrepareEntry: true,
      },
      sideEffects: { installedNothing: true },
    };
  });

  let account1;
  let account2;
  let acceptedCloudOne;
  let acceptedCloudTwo;

  await runCase('candidate-writes-cloud-before-rollback', {}, async () => {
    requireCase('prepare-current-candidate-package');
    currentRelay = await startRelayRuntime({
      runtimePath: candidatePackage.runtimePath,
      rootDir: join(testRoot, 'relay'),
      label: 'candidate relay before rollback',
      timeoutMs: Math.max(options.timeoutMs, 15_000),
    });
    cleanup.relay = { pid: currentRelay.pid, state: 'running' };
    secrets.add(currentRelay.baseUrl);

    const password1 = `rollback-password-a-${randomUUID()}`;
    const password2 = `rollback-password-b-${randomUUID()}`;
    const username1 = `rollback-a-${process.pid}-${Date.now()}`;
    const username2 = `rollback-b-${process.pid}-${Date.now()}`;
    const user1 = await registerAccount(currentRelay.baseUrl, username1, password1);
    const user2 = await registerAccount(currentRelay.baseUrl, username2, password2);
    const login1 = await loginAccount(currentRelay.baseUrl, username1, password1);
    const login2 = await loginAccount(currentRelay.baseUrl, username2, password2);
    account1 = {
      username: username1,
      password: password1,
      userId: user1.id,
      token: login1.accessToken,
    };
    account2 = {
      username: username2,
      password: password2,
      userId: user2.id,
      token: login2.accessToken,
    };
    secrets.add(password1);
    secrets.add(password2);
    secrets.add(account1.token);
    secrets.add(account2.token);

    const slotsOne = [
      cloudSlot(1, 'accepted-one', { alias: 'Accepted One' }),
      cloudSlot(2, 'accepted-two', {
        alias: 'Accepted Two',
        widthMode: 'mirror-fixed',
      }),
    ];
    const slotsTwo = [cloudSlot(9, 'accepted-account-two')];
    const putOne = await apiRequest(currentRelay.baseUrl, '/api/cli/slots', {
      method: 'PUT',
      token: account1.token,
      body: { schemaVersion: 1, slots: slotsOne },
    });
    if (!putOne.ok) {
      const error = new Error(`candidate cloud slot write failed with HTTP ${putOne.status}`);
      error.sideEffects = {
        status: putOne.status,
        response: sanitize(putOne.text.slice(0, 1_000)),
      };
      throw error;
    }
    const putTwo = await apiRequest(currentRelay.baseUrl, '/api/cli/slots', {
      method: 'PUT',
      token: account2.token,
      body: { schemaVersion: 1, slots: slotsTwo },
    });
    if (!putTwo.ok) {
      const error = new Error(`candidate account-two cloud write failed with HTTP ${putTwo.status}`);
      error.sideEffects = {
        status: putTwo.status,
        response: sanitize(putTwo.text.slice(0, 1_000)),
      };
      throw error;
    }
    acceptedCloudOne = normalizeConfig(putOne.payload?.config);
    acceptedCloudTwo = normalizeConfig(putTwo.payload?.config);
    assert(
      JSON.stringify(acceptedCloudOne) === JSON.stringify({ configured: true, slots: slotsOne }),
      'candidate did not return the accepted account-one cloud map',
    );
    assert(
      JSON.stringify(acceptedCloudTwo) === JSON.stringify({ configured: true, slots: slotsTwo }),
      'candidate did not return the accepted account-two cloud map',
    );
    assert(existsSync(currentRelay.cloudPath), 'candidate cloud resource file is missing');
    cloudFileBeforeRollback = readFileSync(currentRelay.cloudPath, 'utf8');

    const stopped = await stopRelayRuntime(currentRelay);
    cleanup.relay = stopped;
    currentRelay = undefined;
    return {
      result: {
        accountOneSlots: [1, 2],
        accountTwoSlots: [9],
        cloudFileObserved: true,
      },
      sideEffects: { cloudConfigurationWrites: 2 },
      cleanup: { status: 'candidate-before-rollback-exited', relay: stopped },
    };
  });

  let oldLogin;
  let oldPresence;

  await runCase('actual-previous-runtime-legacy-write', {}, async () => {
    requireCase('candidate-writes-cloud-before-rollback');
    currentRelay = await startRelayRuntime({
      runtimePath: previousRuntime.runtimePath,
      rootDir: join(testRoot, 'relay'),
      label: 'actual previous relay runtime',
      timeoutMs: Math.max(options.timeoutMs, 15_000),
    });
    cleanup.relay = { pid: currentRelay.pid, state: 'running', package: previousRuntime.manifest ?? null };
    secrets.add(currentRelay.baseUrl);
    oldLogin = await loginAccount(
      currentRelay.baseUrl,
      account1.username,
      account1.password,
    );
    secrets.add(oldLogin.accessToken);
    oldPresence = await presenceWriteViaDaemonSocket(oldLogin, {
      hostId: `rollback-presence-host-${process.pid}`,
      deviceId: `rollback-presence-device-${process.pid}`,
      deviceName: 'rollback-fixture-daemon',
      platform: 'fixture',
      appVersion: 'fixture',
      daemonVersion: previousRuntime.manifest?.version || 'previous',
    });

    const oldGetCloud = await apiRequest(currentRelay.baseUrl, '/api/cli/slots', {
      token: oldLogin.accessToken,
    });
    const oldPutCloud = await apiRequest(currentRelay.baseUrl, '/api/cli/slots', {
      method: 'PUT',
      token: oldLogin.accessToken,
      body: { schemaVersion: 1, slots: [] },
    });
    assert(oldGetCloud.status === 404, `previous relay cloud GET returned ${oldGetCloud.status}, expected 404`);
    assert(oldPutCloud.status === 404, `previous relay cloud PUT returned ${oldPutCloud.status}, expected 404`);

    await closeWebSocket(oldPresence.socket);
    cleanup.websocket = 'closed';
    await delay(250);
    const cloudFileAfterOld = existsSync(currentRelay.cloudPath)
      ? readFileSync(currentRelay.cloudPath, 'utf8')
      : '';
    assert(
      cloudFileAfterOld === cloudFileBeforeRollback,
      'previous runtime changed the independent cloud resource',
    );
    assert(existsSync(currentRelay.storePath), 'previous runtime did not write the legacy store');

    const stopped = await stopRelayRuntime(currentRelay);
    cleanup.relay = stopped;
    currentRelay = undefined;
    return {
      result: {
        previousLoginSucceeded: true,
        daemonPresenceDeviceId: oldPresence.deviceId,
        cloudGetStatus: oldGetCloud.status,
        cloudPutStatus: oldPutCloud.status,
        legacyStoreObserved: true,
        cloudFileUnchanged: true,
      },
      sideEffects: {
        legacyUsersTokensDevicesWritten: true,
        cloudConfigurationWrites: 0,
      },
      cleanup: { status: 'previous-runtime-exited', relay: stopped },
    };
  });

  await runCase('candidate-reload-preserves-cloud-and-legacy-state', {}, async () => {
    requireCase('actual-previous-runtime-legacy-write');
    currentRelay = await startRelayRuntime({
      runtimePath: candidatePackage.runtimePath,
      rootDir: join(testRoot, 'relay'),
      label: 'candidate relay after rollback',
      timeoutMs: Math.max(options.timeoutMs, 15_000),
    });
    cleanup.relay = { pid: currentRelay.pid, state: 'running' };
    secrets.add(currentRelay.baseUrl);

    const cloudOne = await apiRequest(currentRelay.baseUrl, '/api/cli/slots', {
      token: oldLogin.accessToken,
    });
    const cloudTwo = await apiRequest(currentRelay.baseUrl, '/api/cli/slots', {
      token: account2.token,
    });
    assert(cloudOne.ok, `candidate reload cloud read 1 returned ${cloudOne.status}`);
    assert(cloudTwo.ok, `candidate reload cloud read 2 returned ${cloudTwo.status}`);
    assert(
      JSON.stringify(normalizeConfig(cloudOne.payload?.config))
        === JSON.stringify(acceptedCloudOne),
      'accepted account-one cloud map did not survive the actual previous runtime',
    );
    assert(
      JSON.stringify(normalizeConfig(cloudTwo.payload?.config))
        === JSON.stringify(acceptedCloudTwo),
      'accepted account-two cloud map did not survive the actual previous runtime',
    );
    assertNoForbiddenCloudFields(cloudOne.payload?.config, [
      account1.token,
      account2.token,
      oldLogin.accessToken,
      account1.password,
      account2.password,
      currentRelay.baseUrl,
    ]);
    assertNoForbiddenCloudFields(cloudTwo.payload?.config, [
      account1.token,
      account2.token,
      oldLogin.accessToken,
      account1.password,
      account2.password,
      currentRelay.baseUrl,
    ]);

    const oldTokenMe = await apiRequest(currentRelay.baseUrl, '/api/auth/me', {
      token: oldLogin.accessToken,
    });
    const secondTokenMe = await apiRequest(currentRelay.baseUrl, '/api/auth/me', {
      token: account2.token,
    });
    assert(oldTokenMe.ok, 'latest token generated by previous runtime was not preserved');
    assert(secondTokenMe.ok, 'second account token was not preserved');
    assert(oldTokenMe.payload?.user?.id === account1.userId, 'latest token changed account');
    assert(secondTokenMe.payload?.user?.id === account2.userId, 'second token changed account');

    const devices = await apiRequest(currentRelay.baseUrl, '/api/devices', {
      token: oldLogin.accessToken,
    });
    assert(devices.ok, `candidate reload device read returned ${devices.status}`);
    const presenceRecord = devices.payload?.devices?.find(
      (device) => device.deviceId === oldPresence.deviceId,
    );
    assert(presenceRecord, 'device written by the previous runtime was not preserved');
    assert(
      !presenceRecord.daemon || presenceRecord.daemon.connected === false,
      'previous runtime presence did not persist its disconnected state',
    );

    const cloudFile = readFileSync(currentRelay.cloudPath, 'utf8');
    for (const secret of [
      account1.token,
      account2.token,
      oldLogin.accessToken,
      account1.password,
      account2.password,
      currentRelay.baseUrl,
    ]) {
      assert(!cloudFile.includes(secret), 'cloud resource contains an account or endpoint secret');
    }

    const stopped = await stopRelayRuntime(currentRelay);
    cleanup.relay = stopped;
    currentRelay = undefined;
    return {
      result: {
        cloudSlotsAccountOne: [1, 2],
        cloudSlotsAccountTwo: [9],
        latestPreviousRuntimeTokenAccepted: true,
        secondAccountTokenAccepted: true,
        previousRuntimeDevicePreserved: true,
        cloudPayloadSecretsAbsent: true,
      },
      sideEffects: {
        cloudConfigurationWrites: 0,
        wholeStoreRestoreUsed: false,
      },
      cleanup: { status: 'candidate-after-rollback-exited', relay: stopped },
    };
  });

  let cleanupError;
  try {
    const stopped = await stopRelayRuntime(currentRelay);
    cleanup.websocket = 'none-open';
    if (currentRelay) cleanup.relay = stopped;
  } catch (error) {
    cleanupError = error;
    cleanup.relay = {
      pid: currentRelay?.pid,
      exited: false,
      error: sanitize(errorMessage(error)),
      outputTail: sanitize(relayFailureText(currentRelay)),
    };
  }
  if (!cleanupError && existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true, force: true });
    cleanup.tempRootRemoved = !existsSync(testRoot);
    if (!cleanup.tempRootRemoved) cleanupError = new Error('temporary root was not removed');
  }

  const failed = receipts.filter((entry) => entry.status === 'failed').length;
  const skipped = receipts.filter((entry) => entry.status === 'skipped').length;
  const finalState = cleanupError || failed > 0 || skipped > 0 ? 'failed' : 'passed';
  const summary = writeEvidence(finalState, {
    cleanupError: cleanupError ? sanitize(errorMessage(cleanupError)) : undefined,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return finalState === 'passed' ? 0 : 1;
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
