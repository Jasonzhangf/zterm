import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  InteractivePtyShell,
  loadNodePty,
} from './remote-cli-blackbox.mjs';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REMOTE_CLI_RESULT_FILE,
  REMOTE_CLI_STAGES,
  RemoteCliContractError,
  assertPosixReceiptMode,
  assertSlotMatchesReceipt,
  buildOctalPrintfCommand,
  chooseExactServer,
  chooseExactSession,
  createIsolatedEnvironment,
  decodeOctalPrintfCommand,
  deriveRemoteCliOutcome,
  inspectCliConfig,
  parseRemoteCliArgs,
  readTerminalModeObservation,
  projectVisibleTerminalText,
  resolveRemoteNodePty,
  sanitizeForEvidence,
  validateManagedReceipt,
  windowsReceiptAclIsPrivate,
  writeIsolatedLoginConfig,
} from './remote-cli-blackbox-helper.mjs';
import { buildResult } from './remote-cli-blackbox.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(scriptDir, 'remote-cli-blackbox.mjs');
const repoRoot = resolve(scriptDir, '..', '..', '..');

test('terminal mode observation ignores command echo and completion status', () => {
  for (const mode of ['gfmt1:cflag=4b00:iflag=6b02', '6d02:5:4bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:ff:12:f:17:16:ff:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0']) {
    const output = `prompt printf 'MODE:%s\\n' "$(stty -g)"\r\nMODE:${mode}\r\nMODE:0\r\n`;
    assert.equal(readTerminalModeObservation(output, 'MODE'), mode);
  }
  assert.equal(readTerminalModeObservation("prompt printf 'MODE:%s\\n'\r\nMODE:0\r\n", 'MODE'), '');
});

function receipt(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: 'managed-run-20261020',
    managedTest: true,
    relayBaseUrl: 'https://relay.managed.test/zterm/',
    username: 'managed-user',
    password: 'managed-password-value',
    deviceId: 'managed-device',
    daemonHostId: 'managed-daemon-host',
    sessionName: 'managed-session',
    backend: 'tmux',
    stableId: 'tmux:$1:managed-stable',
    ...overrides,
  };
}

function withTempDirectory(action) {
  const directory = mkdtempSync(join(tmpdir(), 'remote-cli-blackbox-test-'));
  try {
    return action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function withTempDirectoryAsync(action) {
  const directory = mkdtempSync(join(tmpdir(), 'remote-cli-blackbox-test-'));
  try {
    return await action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('requires exactly the four reviewed arguments and rejects ambiguity', () => {
  const full = [
    '--receipt-file',
    './private.json',
    '--cli-bin',
    './zterm.mjs',
    '--pty-package-root',
    './runtime/node_modules',
    '--evidence-dir',
    './evidence',
  ];
  const parsed = parseRemoteCliArgs(full);
  assert.equal(parsed.receiptFile, resolve('./private.json'));
  assert.equal(parsed.cliBin, resolve('./zterm.mjs'));
  assert.equal(parsed.ptyPackageRoot, resolve('./runtime/node_modules'));
  assert.equal(parsed.evidenceDir, resolve('./evidence'));

  assert.throws(
    () => parseRemoteCliArgs(full.slice(0, -2)),
    /missing required arguments: --evidence-dir/u,
  );
  assert.throws(
    () => parseRemoteCliArgs([...full, '--evidence-dir', './other']),
    /duplicate argument: --evidence-dir/u,
  );
  assert.throws(
    () => parseRemoteCliArgs([...full, '--unknown']),
    /unknown argument: --unknown/u,
  );
  assert.throws(
    () => parseRemoteCliArgs(['--receipt-file', '--cli-bin']),
    /--receipt-file requires a value/u,
  );
});

test('the executable rejects missing arguments with a non-success result', () => {
  const result = spawnSync(process.execPath, [runnerPath], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required arguments/u);
});

test('the executable rejects a non-managed private receipt without leaking it', () => {
  withTempDirectory((directory) => {
    const privateReceipt = join(directory, 'private-receipt.json');
    const evidenceDir = join(directory, 'evidence');
    const cliBin = join(directory, 'installed-zterm.mjs');
    writeFileSync(
      privateReceipt,
      JSON.stringify(receipt({ managedTest: false })),
      { mode: 0o600 },
    );
    chmodSync(privateReceipt, 0o600);
    writeFileSync(cliBin, '#!/usr/bin/env node\n');
    const result = spawnSync(process.execPath, [
      runnerPath,
      '--receipt-file',
      privateReceipt,
      '--cli-bin',
      cliBin,
      '--pty-package-root',
      resolve(repoRoot, 'android', 'node_modules'),
      '--evidence-dir',
      evidenceDir,
    ], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /managed-password-value/u,
    );
    const reportPath = join(evidenceDir, REMOTE_CLI_RESULT_FILE);
    const reportText = readFileSync(reportPath, 'utf8');
    assert.doesNotMatch(reportText, /managed-password-value/u);
    const report = JSON.parse(reportText);
    assert.equal(report.outcome.state, 'FAILED');
    assert.equal(report.stages[0].stage, 'preflight');
  });
});

test('accepts only an explicit managed tmux receipt', () => {
  const normalized = validateManagedReceipt(receipt());
  assert.equal(normalized.managedTest, true);
  assert.equal(normalized.backend, 'tmux');
  assert.equal(normalized.relayBaseUrl, 'https://relay.managed.test/zterm/');

  assert.throws(
    () => validateManagedReceipt(receipt({ managedTest: false })),
    /managedTest: true/u,
  );
  assert.throws(
    () => validateManagedReceipt(receipt({ managedTest: 'true' })),
    /managedTest: true/u,
  );
  assert.throws(
    () => validateManagedReceipt(receipt({ backend: 'herdr' })),
    /backend must be tmux/u,
  );
  assert.throws(
    () => validateManagedReceipt(receipt({ stableId: '' })),
    /stableId is invalid/u,
  );
  assert.throws(
    () => validateManagedReceipt(receipt({ relayBaseUrl: 'file:///tmp/relay' })),
    /http\(s\) URL/u,
  );
});

test('requires POSIX 0600 and checks the Windows ACL contract without claiming success', () => {
  assert.doesNotThrow(() => assertPosixReceiptMode(0o100600, 'darwin'));
  assert.throws(
    () => assertPosixReceiptMode(0o100644, 'linux'),
    /mode 0600/u,
  );
  assert.equal(
    windowsReceiptAclIsPrivate({
      currentUserSid: 'S-1-5-21-1000',
      ownerSid: 'S-1-5-21-1000',
      entries: [
        { sid: 'S-1-5-21-1000', accessType: 'Allow' },
        { sid: 'S-1-5-18', accessType: 'Allow' },
      ],
    }),
    true,
  );
  assert.equal(
    windowsReceiptAclIsPrivate({
      currentUserSid: 'S-1-5-21-1000',
      ownerSid: 'S-1-5-21-1000',
      entries: [
        { sid: 'S-1-5-21-1000', accessType: 'Allow' },
        { sid: 'S-1-5-32-545', accessType: 'Allow' },
      ],
    }),
    false,
  );
});

test('resolves the payload runtime node-pty root from a relative path', () => {
  const installation = resolveRemoteNodePty(
    resolve(repoRoot, 'android', 'node_modules'),
  );
  assert.equal(installation.tuple, `${process.platform}-${process.arch}`);
  assert.match(installation.ptyNativePath, /pty\.node$/u);
  if (process.platform === 'win32') {
    assert.match(installation.conPtyNativePath || '', /conpty\.node$/u);
  }
});

test('stages node-pty into the owned temp root and starts only a local shell', async () => {
  await withTempDirectoryAsync(async (directory) => {
    const { pty } = loadNodePty(
      resolve(repoRoot, 'android', 'node_modules'),
      directory,
    );
    const isolated = createIsolatedEnvironment(directory);
    const shell = await InteractivePtyShell.start({
      pty,
      cwd: isolated.tmp,
      env: isolated.env,
    });
    try {
      const command = process.platform === 'win32'
        ? 'echo PTY_HELPER_LOCAL_OK'
        : "printf 'PTY_HELPER_LOCAL_OK\\n'";
      const result = await shell.runCommand(
        command,
        'REMOTE_CLI_LOCAL_PTY_HELPER',
        15_000,
      );
      assert.equal(result.exitCode, 0);
      assert.match(
        projectVisibleTerminalText(result.output),
        /PTY_HELPER_LOCAL_OK/u,
      );
    } finally {
      const closed = await shell.close();
      assert.equal(closed.closed, true);
    }
  });
});

test('selects only one exact managed server and exact session identity', () => {
  const output = projectVisibleTerminalText([
    '选择服务器',
    '  1. Other box · linux · 在线 · other-device',
    '  2. Managed box · linux · 在线 · managed-device',
    '选择 [1-2]: ',
  ].join('\r\n'));
  assert.equal(chooseExactServer(output, 'managed-device'), 2);
  assert.throws(
    () => chooseExactServer(output, 'missing-device'),
    /found 0/u,
  );
  assert.throws(
    () => chooseExactServer(`${output}\r\n  3. Duplicate · linux · 在线 · managed-device`, 'managed-device'),
    /found 2/u,
  );

  const sessions = [
    '选择 session',
    '  1. other-name · tmux · tmux:$1:managed-stable',
    '  2. managed-session · tmux · tmux:$1:managed-stable',
    '选择 [1-2]: ',
  ].join('\n');
  assert.equal(chooseExactSession(sessions, receipt()), 2);
  assert.throws(
    () => chooseExactSession(
      sessions.replace('managed-session', 'renamed-session'),
      receipt(),
    ),
    /found 0/u,
  );
});

test('octal marker input avoids plaintext and survives ANSI-separated output', () => {
  const marker = 'ZTERM_REMOTE_INPUT_1a2b3c4d';
  const command = buildOctalPrintfCommand(marker);
  assert.equal(command.includes(marker), false);
  assert.match(command, /^printf '(?:\\[0-7]{3})+'$/u);
  assert.equal(decodeOctalPrintfCommand(command), `${marker}\n`);

  const ansiSeparated = marker
    .split('')
    .map((character) => `\x1B[0;39;49m${character}`)
    .join('');
  assert.equal(projectVisibleTerminalText(ansiSeparated), marker);
  assert.equal(projectVisibleTerminalText(`${marker}\r\n`), `${marker}\n`);
});

test('isolated environment and config contain no user config or production target', () => {
  withTempDirectory((directory) => {
    const env = createIsolatedEnvironment(directory, {
      PATH: '/usr/bin',
      HOME: '/Users/example',
      USERPROFILE: 'C:\\Users\\example',
      HTTPS_PASSWORD: 'environment-secret',
      NODE_OPTIONS: '--require /tmp/user-hook.cjs',
      npm_config_userconfig: '/Users/example/.npmrc',
    }, 'linux');
    assert.equal(env.env.HOME, join(directory, 'home'));
    assert.equal(env.env.USERPROFILE, join(directory, 'home'));
    assert.equal(env.env.npm_config_userconfig, join(directory, 'npmrc'));
    assert.equal(env.env.HTTPS_PASSWORD, undefined);
    assert.equal(env.env.NODE_OPTIONS, undefined);
    assert.match(env.env.XDG_CONFIG_HOME, /home\/\.config$/u);

    const parsedReceipt = validateManagedReceipt(receipt());
    writeIsolatedLoginConfig(env.configPath, parsedReceipt);
    const config = JSON.parse(readFileSync(env.configPath, 'utf8'));
    assert.deepEqual(config, {
      zterm: {
        cli: {
          server: {
            relayBaseUrl: parsedReceipt.relayBaseUrl,
          },
          loginInput: {
            username: parsedReceipt.username,
            password: parsedReceipt.password,
          },
        },
      },
    });
    assert.equal(inspectCliConfig(env.configPath).slot1, null);
  });
});

test('validates exact slot binding and does not print password or token', () => {
  const parsedReceipt = validateManagedReceipt(receipt());
  assert.doesNotThrow(() => assertSlotMatchesReceipt({
    accountRelayBaseUrl: parsedReceipt.relayBaseUrl,
    deviceId: parsedReceipt.deviceId,
    daemonHostId: parsedReceipt.daemonHostId,
    sessionName: parsedReceipt.sessionName,
    backend: parsedReceipt.backend,
    stableId: parsedReceipt.stableId,
    widthMode: 'adaptive-phone',
  }, parsedReceipt));
  assert.throws(
    () => assertSlotMatchesReceipt({
      accountRelayBaseUrl: parsedReceipt.relayBaseUrl,
      deviceId: parsedReceipt.deviceId,
      daemonHostId: 'other-host',
      sessionName: parsedReceipt.sessionName,
      backend: parsedReceipt.backend,
      stableId: parsedReceipt.stableId,
      widthMode: 'adaptive-phone',
    }, parsedReceipt),
    /daemonHostId does not match/u,
  );

  const token = 'access-token-value';
  const rendered = sanitizeForEvidence(JSON.stringify({
    password: parsedReceipt.password,
    token,
  }), [parsedReceipt.password, token]);
  assert.equal(rendered.includes(parsedReceipt.password), false);
  assert.equal(rendered.includes(token), false);
});

test('a complete remote CLI user path does not require an external route sidecar', () => {
  assert.equal(REMOTE_CLI_STAGES.includes('actual-route-receipt'), false);
  const result = buildResult({
    receipt: validateManagedReceipt(receipt()),
    stages: REMOTE_CLI_STAGES.map((stage) => ({
      stage,
      status: 'passed',
    })),
    cleanup: { cleaned: true },
    secrets: [],
  });
  assert.equal(result.coverage, 'remote-cli-user-path');
  assert.equal(result.outcome.ok, true);
  assert.equal(result.outcome.state, 'PASSED');
});

test('an incomplete user path is FAILED and cannot rely on cleanup alone', () => {
  const outcome = deriveRemoteCliOutcome(
    REMOTE_CLI_STAGES.slice(0, -1).map((stage) => ({
      stage,
      status: 'passed',
    })),
    { cleaned: true },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.state, 'FAILED');
  assert.deepEqual(outcome.gaps, ['stage-set:incomplete']);
});

test('failed real stage never reports success even when cleanup passed', () => {
  const stages = REMOTE_CLI_STAGES.map((stage) => ({
    stage,
    status: stage === 'numbered-mirror' ? 'failed' : 'passed',
    ...(stage === 'numbered-mirror' ? { error: 'connection failed' } : {}),
  }));
  const outcome = deriveRemoteCliOutcome(stages, { cleaned: true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.state, 'FAILED');
});

test('a duplicate stage cannot replace a missing required stage', () => {
  const stages = [
    REMOTE_CLI_STAGES[0],
    ...REMOTE_CLI_STAGES.slice(0, -1),
  ].map((stage) => ({
    stage,
    status: 'passed',
  }));
  const outcome = deriveRemoteCliOutcome(stages, { cleaned: true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.state, 'FAILED');
  assert.deepEqual(outcome.gaps, ['stage-set:incomplete']);
});

test('a complete user path still fails when owned cleanup fails', () => {
  const outcome = deriveRemoteCliOutcome(
    REMOTE_CLI_STAGES.map((stage) => ({
      stage,
      status: 'passed',
    })),
    { cleaned: false },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.state, 'FAILED');
  assert.deepEqual(outcome.gaps, ['cleanup:failed']);
});
