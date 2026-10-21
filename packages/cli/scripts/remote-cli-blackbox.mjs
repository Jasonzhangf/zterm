#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  REMOTE_CLI_RESULT_FILE,
  RemoteCliContractError,
  assertReceiptNotInsideEvidence,
  assertReceiptPrivacy,
  assertSlotMatchesReceipt,
  buildOctalPrintfCommand,
  chooseExactServer,
  chooseExactSession,
  createIsolatedEnvironment,
  deriveRemoteCliOutcome,
  ensureCliBin,
  ensureNodeVersion,
  inspectCliConfig,
  markerForRun,
  parseRemoteCliArgs,
  projectVisibleTerminalText,
  publicClientInfo,
  publicTargetInfo,
  readManagedReceiptFile,
  readTerminalModeObservation,
  requireDirectory,
  requireReadableFile,
  resolveRemoteNodePty,
  sanitizeForEvidence,
  secretValues,
  writeEvidenceJson,
  writeIsolatedLoginConfig,
} from './remote-cli-blackbox-helper.mjs';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;
const RESIZED_COLS = 100;
const RESIZED_ROWS = 28;
const COMMAND_TIMEOUT_MS = 75_000;
const CONNECTION_TIMEOUT_MS = 120_000;

function isoTimestamp() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error) {
  return error instanceof RemoteCliContractError
    ? error.code
    : 'remote_cli_blackbox_error';
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function windowsQuote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function sleep(milliseconds) {
  return delay(milliseconds);
}

function commandMarker(runId, label) {
  return `REMOTE_CLI_${label}_${runId.replace(/[^A-Za-z0-9]/gu, '_')}`;
}

class InteractivePtyShell {
  constructor(terminal, prompt, platform) {
    this.terminal = terminal;
    this.prompt = prompt;
    this.platform = platform;
    this.output = '';
    this.closed = false;
    this.commandInFlight = false;
    this.exitPromise = new Promise((resolve) => {
      terminal.onExit((event) => {
        this.closed = true;
        resolve(event);
      });
    });
    terminal.onData((chunk) => {
      this.output += chunk;
      if (this.output.length > 2_000_000) {
        this.output = this.output.slice(-1_000_000);
      }
    });
  }

  static async start({ pty, cwd, env, platform = process.platform }) {
    const suffix = `${Date.now()}_${randomBytes(4).toString('hex')}`;
    const prompt = `__ZTERM_REMOTE_CLI_${suffix}__`;
    const shell = platform === 'win32'
      ? env.ComSpec || 'cmd.exe'
      : '/bin/sh';
    const args = platform === 'win32'
      ? ['/D', '/Q', '/V:ON']
      : ['-i'];
    const terminal = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: {
        ...env,
        ...(platform === 'win32'
          ? { PROMPT: prompt }
          : { PS1: `${prompt} `, PS2: '' }),
      },
    });
    const interactive = new InteractivePtyShell(terminal, prompt, platform);
    await interactive.waitForVisibleText(
      prompt,
      'isolated shell prompt',
      { timeoutMs: 15_000 },
    );
    return interactive;
  }

  mark() {
    return this.output.length;
  }

  write(data) {
    if (this.closed) {
      throw new RemoteCliContractError(
        'pty_closed',
        'isolated PTY shell is closed',
      );
    }
    this.terminal.write(data);
  }

  sendLine(line) {
    this.write(`${line}${this.platform === 'win32' ? '\r' : '\n'}`);
  }

  resize(cols, rows) {
    this.terminal.resize(cols, rows);
  }

  outputSince(offset) {
    return this.output.slice(offset);
  }

  visibleSince(offset) {
    return projectVisibleTerminalText(this.output.slice(offset));
  }

  async waitForVisibleText(
    expected,
    label,
    { from = 0, timeoutMs = COMMAND_TIMEOUT_MS } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const visible = this.visibleSince(from);
      const matched = expected instanceof RegExp
        ? expected.exec(visible)?.[0]
        : visible.includes(expected)
          ? expected
          : undefined;
      if (expected instanceof RegExp) expected.lastIndex = 0;
      if (matched !== undefined) return matched;
      if (this.closed) {
        throw new RemoteCliContractError(
          'pty_exited_early',
          `${label} failed because the PTY shell exited`,
        );
      }
      await sleep(30);
    }
    throw new RemoteCliContractError(
      'pty_wait_timeout',
      `${label} timed out`,
    );
  }

  async startCommand(command, marker, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (this.commandInFlight) {
      throw new RemoteCliContractError(
        'pty_command_busy',
        'another PTY command is already active',
      );
    }
    this.commandInFlight = true;
    const from = this.mark();
    const line = this.platform === 'win32'
      ? `${command} & echo ${marker}:!ERRORLEVEL!`
      : `${command}; printf '\\n${marker}:%s\\n' "$?"`;
    this.sendLine(line);
    let settled = false;
    return {
      from,
      finish: async () => {
        if (settled) {
          throw new RemoteCliContractError(
            'pty_command_settled',
            'PTY command result was already consumed',
          );
        }
        settled = true;
        try {
          const exitPattern = new RegExp(
            `${escapeRegExp(marker)}:(-?\\d+)`,
          );
          const matched = await this.waitForVisibleText(
            exitPattern,
            `command exit ${marker}`,
            { from, timeoutMs },
          );
          const exitCode = Number(exitPattern.exec(matched)?.[1]);
          await this.waitForVisibleText(this.prompt, 'shell prompt restored', {
            from,
            timeoutMs,
          });
          return {
            exitCode,
            output: this.visibleSince(from),
          };
        } finally {
          this.commandInFlight = false;
        }
      },
    };
  }

  async runCommand(command, marker, timeoutMs = COMMAND_TIMEOUT_MS) {
    const started = await this.startCommand(command, marker, timeoutMs);
    return await started.finish();
  }

  async close(timeoutMs = 5_000) {
    if (this.closed) return { closed: true, forced: false };
    if (this.commandInFlight) {
      this.terminal.kill();
    } else {
      this.terminal.write(this.platform === 'win32' ? 'exit\r' : 'exit\n');
    }
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      await sleep(30);
    }
    const forced = !this.closed;
    if (forced) {
      this.terminal.kill();
      const killDeadline = Date.now() + timeoutMs;
      while (!this.closed && Date.now() < killDeadline) {
        await sleep(30);
      }
    }
    return { closed: this.closed, forced };
  }
}

function loadNodePty(ptyPackageRoot, stageRoot = undefined) {
  const installation = resolveRemoteNodePty(ptyPackageRoot);
  let packageRoot = installation.packageRoot;
  if (stageRoot) {
    packageRoot = join(stageRoot, 'node-pty');
    cpSync(installation.packageRoot, packageRoot, {
      recursive: true,
      dereference: true,
    });
    const spawnHelper = join(
      packageRoot,
      installation.spawnHelperRelativePath,
    );
    if (process.platform !== 'win32' && existsSync(spawnHelper)) {
      chmodSync(spawnHelper, 0o755);
    }
  }
  const packageRequire = createRequire(installation.entry);
  const pty = packageRequire(packageRoot);
  if (
    !pty
    || typeof pty.spawn !== 'function'
  ) {
    throw new RemoteCliContractError(
      'node_pty_invalid',
      'node-pty does not expose spawn()',
    );
  }
  return {
    pty,
    installation: {
      ...installation,
      packageRoot,
      originalPackageRoot: installation.packageRoot,
      ...(stageRoot
        ? {
            stagedSpawnHelperRelativePath: installation.spawnHelperRelativePath,
          }
        : {}),
    },
  };
}

function cliCommand(cliBin, args, platform) {
  if (platform === 'win32') {
    const rendered = args.map(windowsQuote).join(' ');
    return `"%ZTERM_REMOTE_NODE%" "%ZTERM_REMOTE_CLI%"${rendered ? ` ${rendered}` : ''}`;
  }
  const rendered = args.map(shellQuote).join(' ');
  return `"$ZTERM_REMOTE_NODE" "$ZTERM_REMOTE_CLI"${rendered ? ` ${rendered}` : ''}`;
}

function createStageRecorder() {
  const stages = [];
  return {
    stages,
    async run(stage, action) {
      const startedAt = isoTimestamp();
      const startedMs = Date.now();
      try {
        const details = await action();
        const result = {
          stage,
          status: 'passed',
          startedAt,
          durationMs: Date.now() - startedMs,
          ...(details === undefined ? {} : { details }),
        };
        stages.push(result);
        return result;
      } catch (error) {
        stages.push({
          stage,
          status: 'failed',
          startedAt,
          durationMs: Date.now() - startedMs,
          error: errorMessage(error),
          errorCode: errorCode(error),
        });
        throw error;
      }
    },
    record(stage, status, details = {}) {
      stages.push({
        stage,
        status,
        startedAt: isoTimestamp(),
        durationMs: 0,
        details,
      });
    },
  };
}

async function executeHarness({
  options,
  receipt,
  privacy,
  cliBin,
  stages,
  secrets,
  state,
}) {
  const client = publicClientInfo();
  const target = publicTargetInfo(receipt);
  stages.run('preflight', async () => ({
    client,
    cliBin,
    target,
    privateReceipt: privacy.kind,
  }));

  const ptyRoot = realpathSync(options.ptyPackageRoot);
  requireDirectory(ptyRoot, 'pty package root');
  const { pty, installation } = loadNodePty(
    ptyRoot, process.platform === 'win32' ? undefined : state.tempRoot,
  );
  const isolated = createIsolatedEnvironment(state.tempRoot);
  isolated.env.ZTERM_REMOTE_NODE = process.execPath;
  isolated.env.ZTERM_REMOTE_CLI = cliBin;
  writeIsolatedLoginConfig(isolated.configPath, receipt);
  chmodSync(isolated.configPath, 0o600);
  state.isolated = isolated;

  let shell;
  await stages.run('pty-prepare', async () => {
    shell = await InteractivePtyShell.start({
      pty,
      cwd: isolated.tmp,
      env: isolated.env,
    });
    state.shell = shell;
    return {
      tuple: installation.tuple,
      nodePtyEntry: installation.entry,
      ptyNativeRelativePath: installation.ptyNativeRelativePath,
      ...(installation.conPtyNativePath
        ? {
            conPtyNativeRelativePath: relative(
              installation.originalPackageRoot,
              installation.conPtyNativePath,
            ),
          }
        : {}),
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      terminalSize: `${DEFAULT_ROWS}x${DEFAULT_COLS}`,
      isolatedConfig: 'created-0600',
    };
  });

  let beforeStty = '';
  if (process.platform !== 'win32') {
    const marker = commandMarker(receipt.runId, 'stty_before');
    const result = await shell.runCommand(
      `printf '${marker}:%s\\n' "$(stty -g)"`,
      marker,
      COMMAND_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      throw new RemoteCliContractError(
        'stty_before_failed',
        'failed to record baseline local terminal mode',
      );
    }
    beforeStty = readTerminalModeObservation(result.output, marker);
    if (!beforeStty) {
      throw new RemoteCliContractError(
        'stty_before_missing',
        'baseline local terminal mode is missing',
      );
    }
  }

  await stages.run('login-from-config', async () => {
    const marker = commandMarker(receipt.runId, 'login');
    const result = await shell.runCommand(
      cliCommand(cliBin, ['login', '--from-config'], process.platform),
      marker,
      COMMAND_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      throw new RemoteCliContractError(
        'login_failed',
        `zterm login --from-config exited ${result.exitCode}`,
      );
    }
    if (!projectVisibleTerminalText(result.output).includes('登录成功')) {
      throw new RemoteCliContractError(
        'login_success_missing',
        'zterm login did not report success',
      );
    }
    const config = inspectCliConfig(isolated.configPath);
    if (!config.hasAuth) {
      throw new RemoteCliContractError(
        'login_state_missing',
        'isolated config has no persisted CLI auth after login',
      );
    }
    if (config.loginPasswordPresent) {
      throw new RemoteCliContractError(
        'login_password_persisted',
        'one-shot login password remained in the isolated config',
      );
    }
    if (!config.accessToken) {
      throw new RemoteCliContractError(
        'login_token_missing',
        'persisted CLI auth has no access token',
      );
    }
    secrets.push(config.accessToken);
    return {
      exitCode: result.exitCode,
      loginStatePersisted: true,
      oneShotPasswordConsumed: true,
      newProcessLoginReuseStage: 'slot-configure-preview',
    };
  });

  await stages.run('slot-configure-preview', async () => {
    const marker = commandMarker(receipt.runId, 'slot');
    const command = await shell.startCommand(
      cliCommand(
        cliBin,
        ['slot', 'set', '1', '--width-mode', 'adaptive-phone'],
        process.platform,
      ),
      marker,
      CONNECTION_TIMEOUT_MS,
    );
    await shell.waitForVisibleText(/选择服务器/u, 'server prompt', {
      from: command.from,
      timeoutMs: CONNECTION_TIMEOUT_MS,
    });
    await shell.waitForVisibleText(receipt.deviceId, 'complete managed server row', {
      from: command.from, timeoutMs: CONNECTION_TIMEOUT_MS,
    });
    const serverIndex = chooseExactServer(
      shell.visibleSince(command.from),
      receipt.deviceId,
    );
    shell.sendLine(String(serverIndex));

    await shell.waitForVisibleText(/选择 session/u, 'session prompt', {
      from: command.from,
      timeoutMs: CONNECTION_TIMEOUT_MS,
    });
    await shell.waitForVisibleText(receipt.stableId, 'complete managed session row', {
      from: command.from, timeoutMs: CONNECTION_TIMEOUT_MS,
    });
    const sessionIndex = chooseExactSession(
      shell.visibleSince(command.from),
      receipt,
    );
    shell.sendLine(String(sessionIndex));

    await shell.waitForVisibleText(
      /预览 snapshot？/u,
      'snapshot preview prompt',
      {
        from: command.from,
        timeoutMs: CONNECTION_TIMEOUT_MS,
      },
    );
    const previewFrom = shell.mark();
    shell.sendLine('y');
    await shell.waitForVisibleText(
      receipt.runId,
      'managed session snapshot marker',
      {
        from: previewFrom,
        timeoutMs: CONNECTION_TIMEOUT_MS,
      },
    );
    await shell.waitForVisibleText(
      /保存到槽位 1？/u,
      'slot save prompt',
      {
        from: command.from,
        timeoutMs: CONNECTION_TIMEOUT_MS,
      },
    );
    shell.sendLine('y');
    const result = await command.finish();
    if (result.exitCode !== 0) {
      throw new RemoteCliContractError(
        'slot_configure_failed',
        `zterm slot set exited ${result.exitCode}`,
      );
    }
    const config = inspectCliConfig(isolated.configPath);
    if (!config.slot1) {
      throw new RemoteCliContractError(
        'slot_missing',
        'slot 1 was not saved in the isolated config',
      );
    }
    assertSlotMatchesReceipt(config.slot1, receipt);
    return {
      exitCode: result.exitCode,
      newProcessUsedPersistedLogin: true,
      exactServerDeviceId: config.slot1.deviceId,
      exactDaemonHostId: config.slot1.daemonHostId,
      exactSessionName: config.slot1.sessionName,
      exactBackend: config.slot1.backend,
      exactStableIdPresent: Boolean(config.slot1.stableId),
      snapshotMarkerObserved: true,
      savedWidthMode: config.slot1.widthMode,
    };
  });

  let numberedCommand;
  await stages.run('numbered-mirror', async () => {
    const marker = commandMarker(receipt.runId, 'numbered');
    numberedCommand = await shell.startCommand(
      cliCommand(cliBin, ['1'], process.platform),
      marker,
      CONNECTION_TIMEOUT_MS,
    );
    await shell.waitForVisibleText(
      receipt.runId,
      'numbered slot initial mirror marker',
      {
        from: numberedCommand.from,
        timeoutMs: CONNECTION_TIMEOUT_MS,
      },
    );
    await shell.waitForVisibleText(
      '本地命令：Ctrl+] q',
      'terminal local-command guidance',
      {
        from: numberedCommand.from,
        timeoutMs: CONNECTION_TIMEOUT_MS,
      },
    );
    return {
      slot: 1,
      initialMirrorMarkerObserved: true,
      savedBindingReused: true,
    };
  });

  const remoteMarker = markerForRun(
    `${receipt.runId}:${randomBytes(16).toString('hex')}`,
  );
  const markerCommand = buildOctalPrintfCommand(remoteMarker);
  await stages.run('remote-marker-input', async () => {
    if (markerCommand.includes(remoteMarker)) {
      throw new RemoteCliContractError(
        'marker_plaintext_visible',
        'octal marker command contains the plaintext marker',
      );
    }
    const from = shell.mark();
    shell.sendLine(markerCommand);
    await shell.waitForVisibleText(remoteMarker, 'remote marker output', {
      from,
      timeoutMs: CONNECTION_TIMEOUT_MS,
    });
    return {
      octalEncodedInput: true,
      typedCommandContainsPlaintextMarker: false,
      remoteOutputObserved: true,
      markerInputCount: 1,
    };
  });

  await stages.run('adaptive-resize', async () => {
    shell.resize(RESIZED_COLS, RESIZED_ROWS);
    const marker = commandMarker(`${receipt.runId}_${randomBytes(8).toString('hex')}`, 'resize');
    const from = shell.mark();
    shell.sendLine(`( zterm_resize_attempt=0; while [ "$zterm_resize_attempt" -lt 200 ]; do zterm_resize_size=$(stty size); [ "\${zterm_resize_size##* }" = "${RESIZED_COLS}" ] && break; zterm_resize_attempt=$((zterm_resize_attempt + 1)); sleep 0.05; done; printf '${marker}:%s\\n' "$zterm_resize_size" )`);
    const matched = await shell.waitForVisibleText(
      new RegExp(`${escapeRegExp(marker)}:(\\d+)\\s+${RESIZED_COLS}`, 'u'),
      `remote PTY width ${RESIZED_COLS}`,
      {
        from,
        timeoutMs: CONNECTION_TIMEOUT_MS,
      },
    );
    const rows = Number(
      new RegExp(`${escapeRegExp(marker)}:(\\d+)`, 'u').exec(matched)?.[1],
    );
    if (!Number.isSafeInteger(rows) || rows < 1) {
      throw new RemoteCliContractError(
        'resize_rows_invalid',
        'remote PTY resize rows are invalid',
      );
    }
    return {
      localPtyResize: `${RESIZED_ROWS}x${RESIZED_COLS}`,
      remoteColumns: RESIZED_COLS,
      remoteRows: rows,
      widthMode: 'adaptive-phone',
    };
  });

  await stages.run('local-exit-restore', async () => {
    shell.write('\u001dq');
    const result = await numberedCommand.finish();
    if (result.exitCode !== 0) {
      throw new RemoteCliContractError(
        'local_exit_failed',
        `numbered CLI local exit exited ${result.exitCode}`,
      );
    }

    let terminalModeRestored = true;
    if (process.platform !== 'win32') {
      const marker = commandMarker(receipt.runId, 'stty_after');
      const sttyResult = await shell.runCommand(
        `printf '${marker}:%s\\n' "$(stty -g)"`,
        marker,
        COMMAND_TIMEOUT_MS,
      );
      if (sttyResult.exitCode !== 0) {
        throw new RemoteCliContractError(
          'stty_after_failed',
          'failed to record local terminal mode after CLI exit',
        );
      }
      const afterStty = readTerminalModeObservation(sttyResult.output, marker);
      terminalModeRestored = Boolean(afterStty) && afterStty === beforeStty;
      if (!terminalModeRestored) {
        throw new RemoteCliContractError(
          'terminal_mode_not_restored',
          'local terminal mode changed after numbered CLI exit',
        );
      }
    }
    return {
      exitCode: result.exitCode,
      ctrlCloseAndLowercaseQ: true,
      shellPromptRestored: true,
      terminalModeRestored,
      cleanupScope: 'own-pty-only',
      fixtureLifecycleCommandsIssued: 0,
    };
  });

  await stages.run('logout', async () => {
    const marker = commandMarker(receipt.runId, 'logout');
    const result = await shell.runCommand(
      cliCommand(cliBin, ['logout'], process.platform),
      marker,
      COMMAND_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      throw new RemoteCliContractError(
        'logout_failed',
        `zterm logout exited ${result.exitCode}`,
      );
    }
    const config = inspectCliConfig(isolated.configPath);
    if (config.hasAuth) {
      throw new RemoteCliContractError(
        'logout_auth_remains',
        'CLI auth remained in the isolated config after logout',
      );
    }
    if (config.loginPasswordPresent) {
      throw new RemoteCliContractError(
        'logout_password_remains',
        'one-shot login password remained after logout',
      );
    }
    if (!config.slot1) {
      throw new RemoteCliContractError(
        'logout_slot_removed',
        'logout removed slot 1 from the isolated config',
      );
    }
    assertSlotMatchesReceipt(config.slot1, receipt);
    return {
      exitCode: result.exitCode,
      authRemoved: true,
      slotPreserved: true,
      loginPasswordAbsent: true,
    };
  });

  await stages.run('post-logout-rejected', async () => {
    const marker = commandMarker(receipt.runId, 'post_logout');
    const result = await shell.runCommand(
      cliCommand(cliBin, ['1'], process.platform),
      marker,
      CONNECTION_TIMEOUT_MS,
    );
    if (result.exitCode === 0) {
      throw new RemoteCliContractError(
        'post_logout_connection_succeeded',
        'numbered connection succeeded after logout',
      );
    }
    if (!/auth|login|登录|失效/iu.test(projectVisibleTerminalText(result.output))) {
      throw new RemoteCliContractError(
        'post_logout_error_missing',
        'post-logout failure did not require login',
      );
    }
    return {
      exitCode: result.exitCode,
      loginRequired: true,
      savedSlotPreserved: true,
    };
  });

}

function buildResult({
  receipt,
  stages,
  cleanup,
  secrets,
}) {
  const outcome = deriveRemoteCliOutcome(stages, cleanup);
  return {
    schemaVersion: 1,
    coverage: 'remote-cli-user-path',
    runId: receipt?.runId || '',
    generatedAt: isoTimestamp(),
    client: publicClientInfo(),
    target: receipt ? publicTargetInfo(receipt) : null,
    stages,
    cleanup,
    outcome,
  };
}

function printSummary(result, evidenceDir, secrets) {
  const line = `remote-cli-blackbox: ${result.outcome.state} coverage=${result.coverage} evidence=${evidenceDir}\n`;
  process.stdout.write(sanitizeForEvidence(line, secrets));
}

async function main() {
  let options;
  let receipt;
  let privacy;
  let cliBin;
  const stageRecorder = createStageRecorder();
  const state = {
    tempRoot: mkdtempSync(join(tmpdir(), 'zterm-remote-cli-blackbox-')),
    shell: undefined,
    isolated: undefined,
  };
  let secrets = [];
  let result;
  let fatalError;

  try {
    options = parseRemoteCliArgs(process.argv.slice(2));
    ensureNodeVersion(22);
    mkdirSync(options.evidenceDir, { recursive: true, mode: 0o700 });
    chmodSync(options.evidenceDir, 0o700);
    const evidenceDir = realpathSync(options.evidenceDir);
    options.evidenceDir = evidenceDir;
    requireReadableFile(options.receiptFile, 'receipt file');
    assertReceiptNotInsideEvidence(options.receiptFile, evidenceDir);
    privacy = assertReceiptPrivacy(options.receiptFile);
    receipt = readManagedReceiptFile(options.receiptFile);
    secrets = secretValues(receipt);
    cliBin = ensureCliBin(options.cliBin);
    options.cliBin = cliBin;

    await executeHarness({
      options,
      receipt,
      privacy,
      cliBin,
      stages: stageRecorder,
      secrets,
      state,
    });
  } catch (error) {
    fatalError = error;
    if (stageRecorder.stages.length === 0) {
      stageRecorder.record('preflight', 'failed', {
        errorCode: errorCode(error),
        error: errorMessage(error),
      });
    }
  } finally {
    let shellClosed = false;
    let shellForced = false;
    let tempRemoved = false;
    try {
      if (state.shell) {
        const closed = await state.shell.close();
        shellClosed = closed.closed;
        shellForced = closed.forced;
      } else {
        shellClosed = true;
      }
      if (state.tempRoot) {
        rmSync(state.tempRoot, { recursive: true, force: true });
        tempRemoved = true;
      }
    } catch {
      tempRemoved = false;
    }
    const cleanup = {
      cleaned: shellClosed && tempRemoved,
      ownPtyClosed: shellClosed,
      ownPtyForced: shellForced,
      tempRootRemoved: tempRemoved,
      remoteFixtureTouched: false,
    };
    result = buildResult({
      receipt,
      stages: stageRecorder.stages,
      cleanup,
      secrets,
    });
    if (fatalError && state.shell) {
      result.failureTerminalTail = sanitizeForEvidence(
        state.shell.visibleSince(0).slice(-12_000),
        secrets,
      );
    }
    if (options?.evidenceDir) {
      try {
        writeEvidenceJson(
          options.evidenceDir,
          REMOTE_CLI_RESULT_FILE,
          result,
          secrets,
        );
      } catch (error) {
        fatalError ||= error;
      }
    }
  }

  if (fatalError) {
    const detail = sanitizeForEvidence(errorMessage(fatalError), secrets);
    process.stderr.write(
      `remote-cli-blackbox: ${result.outcome.state} (${errorCode(fatalError)}): ${detail}\n`,
    );
    process.exitCode = 1;
  } else if (!result.outcome.ok) {
    const gaps = sanitizeForEvidence(
      result.outcome.gaps.join(', '),
      secrets,
    );
    process.stderr.write(
      `remote-cli-blackbox: ${result.outcome.state}: ${gaps}\n`,
    );
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
  if (options?.evidenceDir) {
    printSummary(result, options.evidenceDir, secrets);
  }
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
const scriptPath = realpathSync(fileURLToPath(import.meta.url));
if (invokedPath === scriptPath) {
  await main();
  process.exit(process.exitCode ?? 0);
}

export {
  InteractivePtyShell,
  buildResult,
  cliCommand,
  executeHarness,
  loadNodePty,
  main,
};
