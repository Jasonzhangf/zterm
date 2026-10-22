#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  apiRequest,
  assertNoForbiddenCloudFields,
  closeWebSocket,
  fixtureBinding,
  loginAccount,
  prepareCandidateRelayPackage,
  readJsonFile,
  registerAccount,
  relayFailureText,
  startRelayRuntime,
  stopRelayRuntime,
  writePrivateJson,
} from './slot-sync-fixture-helper.mjs';
import {
  formalCliInvocation,
  installedCliBin,
  redactText,
  runProcess,
} from './platform-smoke-helper.mjs';
import { resolveNpmInvocation } from './process-entry.mjs';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const packageDir = resolve(scriptDir, '..');
const repoRoot = resolve(packageDir, '..', '..');
const requiredNodeMajor = 22;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isoNow() {
  return new Date().toISOString();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseSlotSyncArgs(argv, env = process.env) {
  const options = {
    cliTarball: env.CLI_TARBALL ? resolve(env.CLI_TARBALL) : undefined,
    evidenceDir: undefined,
    timeoutMs: 60_000,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cli-tarball') {
      const value = argv[++index];
      if (!value) throw new Error('--cli-tarball requires a value');
      options.cliTarball = resolve(value);
      continue;
    }
    if (arg === '--evidence-dir') {
      const value = argv[++index];
      if (!value) throw new Error('--evidence-dir requires a value');
      options.evidenceDir = resolve(value);
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
    if (arg.startsWith('--')) {
      throw new Error(`unknown slot sync argument: ${arg}`);
    }
    if (options.cliTarball) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    options.cliTarball = resolve(arg);
  }
  return options;
}

class SkippedCase extends Error {}

function outsideSource(path) {
  const relation = relative(repoRoot, path);
  return relation.startsWith('..') || isAbsolute(relation);
}

function isolatedEnvironment(homeDir, extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      name.startsWith('ZTERM_')
      || name.startsWith('npm_config_')
      || name.startsWith('NPM_CONFIG_')
      || name === 'NODE_OPTIONS'
      || name === 'NODE_PATH'
      || name === 'TMUX'
      || name === 'TMUX_PANE'
      || name === 'TMUX_TMPDIR'
    ) {
      continue;
    }
    env[name] = value;
  }
  const appData = join(homeDir, 'AppData');
  return {
    ...env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    APPDATA: join(appData, 'Roaming'),
    LOCALAPPDATA: join(appData, 'Local'),
    TERM: 'xterm-256color',
    LANG: env.LANG || 'C.UTF-8',
    ...extra,
  };
}

function installFormalCli(options) {
  const {
    cliTarball,
    rootDir,
    timeoutMs,
  } = options;
  if (!existsSync(cliTarball)) {
    throw new Error(`CLI tarball is missing: ${cliTarball}`);
  }
  const prefix = join(rootDir, 'npm-prefix');
  const npmCache = join(rootDir, 'npm-cache');
  const npmHome = join(rootDir, 'npm-home');
  const npmUserConfig = join(rootDir, 'npmrc');
  mkdirSync(prefix, { recursive: true });
  mkdirSync(npmHome, { recursive: true });
  writeFileSync(npmUserConfig, '', { mode: 0o600 });

  const binPath = installedCliBin(prefix);
  const env = isolatedEnvironment(npmHome, {
    npm_config_prefix: prefix,
    NPM_CONFIG_PREFIX: prefix,
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_userconfig: npmUserConfig,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    npm_config_audit: 'false',
    NPM_CONFIG_AUDIT: 'false',
    npm_config_fund: 'false',
    NPM_CONFIG_FUND: 'false',
    npm_config_update_notifier: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  });
  const npm = resolveNpmInvocation([
    'install',
    '--global',
    '--prefix',
    prefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    cliTarball,
  ], { env });
  const result = runProcess(npm.command, npm.args, {
    cwd: rootDir,
    env,
    timeout: Math.max(timeoutMs, 180_000),
  });
  if (!existsSync(binPath)) {
    throw new Error(`installed formal zterm bin is missing: ${binPath}`);
  }
  if (!outsideSource(binPath)) {
    throw new Error(`installed formal zterm bin is inside the source tree: ${binPath}`);
  }
  return {
    prefix,
    binPath,
    install: {
      exitCode: result.exitCode,
      stdout: result.stdout.trim().slice(-2_000),
      stderr: result.stderr.trim().slice(-2_000),
    },
  };
}

function configPath(homeDir) {
  return join(homeDir, '.zterm', 'config.json');
}

function seedHome(homeDir, options) {
  const {
    relayBaseUrl,
    username,
    password,
    userId,
    slots = {},
  } = options;
  writePrivateJson(configPath(homeDir), {
    zterm: {
      cli: {
        server: { relayBaseUrl },
        loginInput: { username, password },
        slots,
        fixtureUnrelatedCliField: { preserve: true },
      },
      fixtureUnrelatedSection: { preserve: true },
    },
    fixtureOutsideZterm: { preserve: true },
  });
}

function readHomeConfig(homeDir) {
  return readJsonFile(configPath(homeDir));
}

function updateHomeSlots(homeDir, mutate) {
  const config = readHomeConfig(homeDir);
  const slots = config?.zterm?.cli?.slots ?? {};
  config.zterm.cli.slots = mutate(slots) ?? slots;
  writePrivateJson(configPath(homeDir), config);
}

function configText(homeDir) {
  const path = configPath(homeDir);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function rememberConfigSecrets(config, secrets) {
  const token = config?.zterm?.cli?.auth?.accessToken;
  if (typeof token === 'string' && token) secrets.add(token);
}

function accountSlots(config, account) {
  const result = {};
  for (const [slot, binding] of Object.entries(config?.zterm?.cli?.slots ?? {})) {
    if (
      binding?.account?.relayBaseUrl === account.relayBaseUrl
      && binding?.account?.userId === account.userId
    ) {
      result[slot] = binding;
    }
  }
  return result;
}

function setLocalSlots(homeDir, bindings) {
  updateHomeSlots(homeDir, () => ({ ...bindings }));
}

function addLocalSlot(homeDir, slot, binding) {
  updateHomeSlots(homeDir, (slots) => ({ ...slots, [String(slot)]: binding }));
}

function removeCurrentAccountSlots(homeDir, account) {
  updateHomeSlots(homeDir, (slots) => {
    const next = { ...slots };
    for (const [slot, binding] of Object.entries(next)) {
      if (
        binding?.account?.relayBaseUrl === account.relayBaseUrl
        && binding?.account?.userId === account.userId
      ) {
        delete next[slot];
      }
    }
    return next;
  });
}

function bindingTarget(binding) {
  return {
    account: binding.account,
    server: binding.server,
    session: binding.session,
    widthMode: binding.widthMode,
  };
}

function sortSlots(slots) {
  return [...slots].sort((left, right) => left.slot - right.slot);
}

async function main() {
  const options = parseSlotSyncArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'Usage: node packages/cli/scripts/slot-sync-blackbox.mjs '
        + '[--cli-tarball <tgz>] --evidence-dir <dir> [--timeout-ms <ms>]\n'
        + 'CLI_TARBALL can replace --cli-tarball.\n',
    );
    return 0;
  }
  if (!options.cliTarball) {
    throw new Error('CLI tarball is required through CLI_TARBALL or --cli-tarball');
  }
  if (!options.evidenceDir) {
    throw new Error('--evidence-dir is required');
  }
  if (Number(process.versions.node.split('.')[0]) !== requiredNodeMajor) {
    throw new Error(
      `slot sync blackbox requires Node ${requiredNodeMajor}; actual ${process.versions.node}`,
    );
  }

  mkdirSync(options.evidenceDir, { recursive: true });
  const summaryPath = join(options.evidenceDir, 'slot-sync-blackbox-summary.json');
  const commandsPath = join(options.evidenceDir, 'slot-sync-blackbox-commands.json');
  const receiptsPath = join(options.evidenceDir, 'slot-sync-blackbox-receipts.json');
  const runLogPath = join(options.evidenceDir, 'slot-sync-blackbox-run.log');
  const testRoot = join(
    tmpdir(),
    `zterm-slot-sync-blackbox-${process.pid}-${Date.now()}`,
  );
  mkdirSync(testRoot, { recursive: true, mode: 0o700 });

  const startedAt = isoNow();
  const secrets = new Set();
  const commands = [];
  const receipts = [];
  const passedCases = new Map();
  const cleanup = {
    relay: null,
    websocket: 'not-opened',
    tempRoot: testRoot,
    tempRootRemoved: false,
  };
  let relayState;
  let installed;
  let candidatePackage;
  let fatalError;

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
    const failed = receipts.filter((entry) => entry.status === 'failed');
    const skipped = receipts.filter((entry) => entry.status === 'skipped');
    const passed = receipts.filter((entry) => entry.status === 'passed');
    const summary = sanitizeValue({
      schemaVersion: 1,
      state,
      host: {
        platform: process.platform,
        arch: process.arch,
        tuple: `${process.platform}-${process.arch}`,
        node: process.versions.node,
      },
      startedAt,
      finishedAt: state === 'running' ? undefined : isoNow(),
      input: {
        cliTarball: options.cliTarball,
        evidenceDir: options.evidenceDir,
      },
      candidateRelay: candidatePackage
        ? {
            name: candidatePackage.name,
            version: candidatePackage.version,
          }
        : undefined,
      installedFormalCli: installed
        ? {
            bin: installed.binPath,
            outsideSource: outsideSource(installed.binPath),
          }
        : undefined,
      counts: {
        total: receipts.length,
        passed: passed.length,
        failed: failed.length,
        skipped: skipped.length,
      },
      coverage: {
        installedFormalCli: installed ? 'executed' : 'not-run',
        realRelayProcess: relayState ? 'executed' : 'not-run',
        windowsConpty: 'covered-by-existing-native-platform-gate',
        nativeWrtcDependency: 'covered-by-existing-native-platform-gate',
      },
      cleanup,
      fatalError: fatalError ? sanitize(errorMessage(fatalError)) : undefined,
      evidence: {
        summary: summaryPath,
        commands: commandsPath,
        receipts: receiptsPath,
        runLog: runLogPath,
      },
      ...extra,
    });
    writePrivateJson(summaryPath, summary);
    writePrivateJson(commandsPath, sanitizeValue(commands));
    writePrivateJson(receiptsPath, sanitizeValue(receipts));
    const lines = receipts.map((entry) => (
      `[${entry.startedAt}] ${entry.name} ${entry.status}: `
      + (entry.error || entry.reason || 'complete')
    ));
    writePrivateJson(runLogPath, {
      state,
      lines,
      counts: summary.counts,
      cleanup,
    });
    return summary;
  };

  const runCase = async (name, input, action) => {
    const caseStartedAt = isoNow();
    const caseStartedMs = Date.now();
    try {
      const detail = await action();
      const receipt = {
        name,
        status: 'passed',
        startedAt: caseStartedAt,
        durationMs: Date.now() - caseStartedMs,
        input,
        result: detail?.result ?? { observed: true },
        sideEffects: detail?.sideEffects ?? {},
        cleanup: { status: 'owned-resources-retained-until-final-cleanup' },
      };
      receipts.push(receipt);
      passedCases.set(name, true);
      writeEvidence();
      return true;
    } catch (error) {
      const skipped = error instanceof SkippedCase;
      const receipt = {
        name,
        status: skipped ? 'skipped' : 'failed',
        startedAt: caseStartedAt,
        durationMs: Date.now() - caseStartedMs,
        input,
        result: {
          exitCode: error?.exitCode,
          ...(skipped ? { reason: sanitize(errorMessage(error)) } : {
            error: sanitize(errorMessage(error)),
            causeCode: error?.code,
          }),
        },
        sideEffects: error?.sideEffects ?? {},
        cleanup: { status: 'owned-resources-retained-until-final-cleanup' },
        ...(skipped ? { reason: sanitize(errorMessage(error)) } : {
          error: sanitize(errorMessage(error)),
        }),
      };
      receipts.push(receipt);
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

  const runCli = (homeDir, args, label) => {
    const cwd = join(homeDir, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const env = isolatedEnvironment(homeDir);
    const invocation = formalCliInvocation(
      installed.binPath,
      args,
      process.platform,
      env,
    );
    const result = runProcess(invocation.command, invocation.args, {
      cwd,
      env,
      timeout: options.timeoutMs,
      allowFailure: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    commands.push({
      label,
      args,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error ? errorMessage(result.error) : undefined,
    });
    return result;
  };

  const expectExit = (result, expected, label) => {
    if (result.exitCode !== expected) {
      const error = new Error(
        `${label} exit ${String(result.exitCode)}; expected ${expected}; `
          + `stdout=${JSON.stringify(sanitize(result.stdout.trim()))}; `
          + `stderr=${JSON.stringify(sanitize(result.stderr.trim()))}`,
      );
      error.exitCode = result.exitCode;
      error.sideEffects = {
        stdout: sanitize(result.stdout.trim()),
        stderr: sanitize(result.stderr.trim()),
      };
      throw error;
    }
    return result;
  };

  const expectConfigUnchanged = (homeDir, before, label) => {
    const after = configText(homeDir);
    assert(
      before === after,
      `${label} changed local config; beforePresent=${before !== undefined}, `
        + `afterPresent=${after !== undefined}`,
    );
  };

  const getCloud = async (account) => {
    const response = await apiRequest(relayState.baseUrl, '/api/cli/slots', {
      token: account.accessToken,
    });
    if (!response.ok) {
      throw new Error(`cloud slot read failed with HTTP ${response.status}`);
    }
    assert(response.payload?.ok === true, 'cloud slot read response is not ok');
    assert(response.payload?.schemaVersion === 1, 'cloud slot schemaVersion is not 1');
    assert(
      response.payload?.user?.id === account.userId,
      'cloud slot response user does not match the authenticated fixture',
    );
    return response.payload.config;
  };

  const putCloud = async (account, slots) => {
    const response = await apiRequest(relayState.baseUrl, '/api/cli/slots', {
      method: 'PUT',
      token: account.accessToken,
      body: { schemaVersion: 1, slots },
    });
    if (!response.ok) {
      throw new Error(`cloud slot write failed with HTTP ${response.status}`);
    }
    assert(response.payload?.ok === true, 'cloud slot write response is not ok');
    return response.payload.config;
  };

  const cloudSlot = (slot, name, options = {}) => ({
    slot,
    ...(options.alias ? { alias: options.alias } : {}),
    server: {
      deviceId: `cloud-device-${name}`,
      daemonHostId: `cloud-host-${name}`,
      displayName: `Cloud ${name}`,
    },
    session: {
      backend: 'tmux',
      stableId: `cloud-stable-${name}`,
      name,
    },
    widthMode: options.widthMode || 'adaptive-phone',
  });

  try {
    writeEvidence();
    candidatePackage = prepareCandidateRelayPackage(
      repoRoot,
      join(testRoot, 'candidate-relay-package'),
      Math.max(options.timeoutMs, 120_000),
    );
    installed = installFormalCli({
      cliTarball: options.cliTarball,
      rootDir: testRoot,
      timeoutMs: options.timeoutMs,
    });
    relayState = await startRelayRuntime({
      runtimePath: candidatePackage.runtimePath,
      rootDir: join(testRoot, 'relay'),
      label: 'current candidate relay',
      timeoutMs: Math.max(options.timeoutMs, 15_000),
    });
    cleanup.relay = { pid: relayState.pid, state: 'running' };
    secrets.add(relayState.baseUrl);

  } catch (error) {
    fatalError = error;
  }

  if (fatalError) {
    const result = await stopRelayRuntime(relayState).catch((error) => ({
      pid: relayState?.pid,
      exited: false,
      error: errorMessage(error),
    }));
    cleanup.relay = result;
    if (result.exited && existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
      cleanup.tempRootRemoved = !existsSync(testRoot);
    }
    writeEvidence('failed');
    throw fatalError;
  }

  let account1;
  let account2;
  try {
    const username1 = `slot-blackbox-a-${process.pid}-${Date.now()}`;
    const password1 = `password-a-${randomUUID()}`;
    const user1 = await registerAccount(relayState.baseUrl, username1, password1);
    account1 = {
      username: username1,
      password: password1,
      userId: user1.id,
      relayBaseUrl: `${relayState.baseUrl}/`,
      accessToken: (await loginAccount(relayState.baseUrl, username1, password1)).accessToken,
    };
    const username2 = `slot-blackbox-b-${process.pid}-${Date.now()}`;
    const password2 = `password-b-${randomUUID()}`;
    const user2 = await registerAccount(relayState.baseUrl, username2, password2);
    account2 = {
      username: username2,
      password: password2,
      userId: user2.id,
      relayBaseUrl: `${relayState.baseUrl}/`,
      accessToken: (await loginAccount(relayState.baseUrl, username2, password2)).accessToken,
    };
    secrets.add(password1);
    secrets.add(password2);
    secrets.add(account1.accessToken);
    secrets.add(account2.accessToken);
  } catch (error) {
    fatalError = error;
  }

  if (fatalError) {
    const result = await stopRelayRuntime(relayState).catch((error) => ({
      pid: relayState?.pid,
      exited: false,
      error: errorMessage(error),
    }));
    cleanup.relay = result;
    if (result.exited && existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
      cleanup.tempRootRemoved = !existsSync(testRoot);
    }
    writeEvidence('failed');
    throw fatalError;
  }

  const homeA = join(testRoot, 'home-a');
  const homeB = join(testRoot, 'home-b');
  const homeC = join(testRoot, 'home-c');
  const firstBinding = fixtureBinding({
    relayBaseUrl: relayState.baseUrl,
    userId: account1?.userId || 'pending',
    slotName: 'old-unnamed',
    widthMode: 'adaptive-phone',
  });
  seedHome(homeA, {
    relayBaseUrl: relayState.baseUrl,
    username: account1?.username || 'pending',
    password: account1?.password || 'pending',
    userId: account1?.userId || 'pending',
    slots: { '1': firstBinding },
  });
  seedHome(homeB, {
    relayBaseUrl: relayState.baseUrl,
    username: account1?.username || 'pending',
    password: account1?.password || 'pending',
    userId: account1?.userId || 'pending',
  });
  seedHome(homeC, {
    relayBaseUrl: relayState.baseUrl,
    username: account2?.username || 'pending',
    password: account2?.password || 'pending',
    userId: account2?.userId || 'pending',
    slots: {
      '10': fixtureBinding({
        relayBaseUrl: relayState.baseUrl,
        userId: account2?.userId || 'pending',
        slotName: 'account-two',
        widthMode: 'mirror-fixed',
      }),
    },
  });
  secrets.add(account1?.password);
  secrets.add(account2?.password);
  writeEvidence();

  await runCase('installed-help', { args: ['--help'] }, async () => {
    const result = expectExit(runCli(homeA, ['--help'], 'installed-help'), 0, 'help');
    for (const required of [
      'slot pull',
      'slot push',
      'slot rename',
    ]) {
      assert(result.stdout.includes(required), `installed help is missing ${required}`);
    }
    return {
      result: { exitCode: result.exitCode, helpIncludesSyncCommands: true },
      sideEffects: { configChanged: false },
    };
  });

  for (const [name, args] of [
    ['parser-pull-no-mutation', ['slot', 'pull']],
    ['parser-push-no-mutation', ['slot', 'push']],
    ['parser-mixed-scope-no-mutation', ['slot', 'pull', '1', '--all']],
  ]) {
    await runCase(name, { args }, async () => {
      const before = configText(homeA);
      const result = expectExit(runCli(homeA, args, name), 2, name);
      expectConfigUnchanged(homeA, before, name);
      return {
        result: {
          exitCode: result.exitCode,
          stdout: sanitize(result.stdout.trim()),
          stderr: sanitize(result.stderr.trim()),
        },
        sideEffects: { configChanged: false },
      };
    });
  }

  await runCase('login-home-a-and-old-unnamed-list', {}, async () => {
    const before = readHomeConfig(homeA);
    const originalSlot = before.zterm.cli.slots['1'];
    const login = expectExit(
      runCli(homeA, ['login', '--from-config'], 'login-home-a'),
      0,
      'login-home-a',
    );
    const afterLogin = readHomeConfig(homeA);
    rememberConfigSecrets(afterLogin, secrets);
    assert(
      afterLogin.zterm.cli.loginInput?.password === undefined,
      'from-config password was not consumed',
    );
    assert(
      JSON.stringify(afterLogin).includes('password-a-') === false,
      'local config still contains the fixture password',
    );
    assert(
      JSON.stringify(afterLogin.zterm.cli.slots['1']) === JSON.stringify(originalSlot),
      'login changed the old unnamed slot',
    );
    const list = expectExit(
      runCli(homeA, ['slot', 'list'], 'list-old-unnamed'),
      0,
      'list-old-unnamed',
    );
    assert(
      list.stdout.includes('old-unnamed') && list.stdout.includes('Fixture old-unnamed'),
      'old unnamed slot is not readable from installed list output',
    );
    assert(!login.stdout.includes(account1.accessToken), 'login output exposed a token');
    return {
      result: {
        loginExitCode: login.exitCode,
        listExitCode: list.exitCode,
        oldUnnamedReadable: true,
        passwordConsumed: true,
      },
      sideEffects: { configChangedByExpectedLogin: true, slotChanged: false },
    };
  });

  for (const [name, homeDir, account, label] of [
    ['login-home-b', homeB, account1, 'login-home-b'],
    ['login-home-c', homeC, account2, 'login-home-c'],
  ]) {
    await runCase(name, { home: name.endsWith('-b') ? 'B' : 'C' }, async () => {
      const login = expectExit(
        runCli(homeDir, ['login', '--from-config'], label),
        0,
        label,
      );
      const config = readHomeConfig(homeDir);
      rememberConfigSecrets(config, secrets);
      assert(config.zterm.cli.loginInput?.password === undefined, 'fixture password remained');
      assert(
        config.zterm.cli.auth?.userId === account.userId,
        'login committed the wrong account',
      );
      assert(!login.stdout.includes(account.accessToken), 'login output exposed a token');
      return {
        result: { exitCode: login.exitCode, sameAccount: account === account1 },
        sideEffects: { configChangedByExpectedLogin: true },
      };
    });
  }

  await runCase('rename-keeps-target', {}, async () => {
    requireCase('login-home-a-and-old-unnamed-list');
    const before = readHomeConfig(homeA);
    const original = before.zterm.cli.slots['1'];
    const alias = 'Fixture Alias One';
    const rename = expectExit(
      runCli(homeA, ['slot', 'rename', '1', alias], 'rename-slot-one'),
      0,
      'rename-slot-one',
    );
    const after = readHomeConfig(homeA);
    const renamed = after.zterm.cli.slots['1'];
    assert(renamed.alias === alias, 'rename did not persist the alias');
    assert(
      JSON.stringify(bindingTarget(renamed)) === JSON.stringify(bindingTarget(original)),
      'rename changed the slot target or width',
    );
    const list = expectExit(
      runCli(homeA, ['slot', 'list'], 'list-renamed-slot'),
      0,
      'list-renamed-slot',
    );
    assert(list.stdout.includes(alias), 'installed list did not project the persisted alias');
    return {
      result: {
        exitCode: rename.exitCode,
        aliasPersisted: true,
        targetUnchanged: true,
        listExitCode: list.exitCode,
      },
      sideEffects: { changedFields: ['zterm.cli.slots.1.alias'] },
    };
  });

  await runCase('never-configured-pull-no-local-write', {}, async () => {
    requireCase('login-home-a-and-old-unnamed-list');
    addLocalSlot(homeA, 7, fixtureBinding({
      relayBaseUrl: relayState.baseUrl,
      userId: account1.userId,
      slotName: 'never-configured-local',
    }));
    const before = configText(homeA);
    const result = expectExit(
      runCli(homeA, ['slot', 'pull', '7'], 'pull-never-configured'),
      1,
      'pull-never-configured',
    );
    expectConfigUnchanged(homeA, before, 'pull-never-configured');
    assert(
      /(?:not configured|未配置|不存在|missing|cloud_config_missing)/iu.test(
        `${result.stdout}\n${result.stderr}`,
      ),
      'never-configured pull did not report an explicit missing cloud configuration',
    );
    return {
      result: {
        exitCode: result.exitCode,
        explicitMissingConfig: true,
      },
      sideEffects: { configChanged: false },
    };
  });

  await runCase('single-push-pull-roundtrip', {}, async () => {
    requireCase('login-home-a-and-old-unnamed-list');
    requireCase('login-home-b');
    const pushedBinding = fixtureBinding({
      relayBaseUrl: relayState.baseUrl,
      userId: account1.userId,
      slotName: 'roundtrip',
      alias: 'Round Trip',
      widthMode: 'mirror-fixed',
    });
    setLocalSlots(homeA, { '1': pushedBinding });
    const push = expectExit(
      runCli(homeA, ['slot', 'push', '1'], 'push-slot-one'),
      0,
      'push-slot-one',
    );
    setLocalSlots(homeB, {});
    const pull = expectExit(
      runCli(homeB, ['slot', 'pull', '1'], 'pull-slot-one-home-b'),
      0,
      'pull-slot-one-home-b',
    );
    const pulled = readHomeConfig(homeB).zterm.cli.slots['1'];
    assert(
      JSON.stringify(pulled) === JSON.stringify(pushedBinding),
      'A push 1 then B pull 1 did not round-trip alias, target, and width',
    );
    assert(pulled.alias === 'Round Trip', 'round-trip alias changed');
    assert(pulled.widthMode === 'mirror-fixed', 'round-trip width changed');
    return {
      result: {
        pushExitCode: push.exitCode,
        pullExitCode: pull.exitCode,
        alias: pulled.alias,
        widthMode: pulled.widthMode,
        targetRoundTripped: true,
      },
      sideEffects: { homeBCurrentAccountSlots: [1] },
    };
  });

  await runCase('single-push-preserves-other-cloud-slots', {}, async () => {
    requireCase('single-push-pull-roundtrip');
    const slotTwo = fixtureBinding({
      relayBaseUrl: relayState.baseUrl,
      userId: account1.userId,
      slotName: 'preserved-two',
      alias: 'Preserve Two',
    });
    addLocalSlot(homeA, 2, slotTwo);
    expectExit(
      runCli(homeA, ['slot', 'push', '2'], 'push-slot-two'),
      0,
      'push-slot-two',
    );
    const updatedOne = {
      ...readHomeConfig(homeA).zterm.cli.slots['1'],
      alias: 'Updated One',
    };
    addLocalSlot(homeA, 1, updatedOne);
    expectExit(
      runCli(homeA, ['slot', 'push', '1'], 'push-updated-slot-one'),
      0,
      'push-updated-slot-one',
    );
    const cloud = await getCloud(account1);
    const slots = Object.fromEntries(cloud.slots.map((entry) => [String(entry.slot), entry]));
    assert(cloud.configured === true, 'cloud account is not configured after push');
    assert(slots['1']?.alias === 'Updated One', 'single push did not update slot 1');
    assert(slots['2']?.alias === 'Preserve Two', 'single push erased cloud slot 2');
    return {
      result: { cloudSlots: [1, 2], preservedOtherSlot: true },
      sideEffects: { overwrittenCloudScope: [1] },
    };
  });

  await runCase('full-push-replaces-cloud-map', {}, async () => {
    requireCase('single-push-pull-roundtrip');
    await putCloud(account1, [
      cloudSlot(3, 'cloud-only-three'),
      cloudSlot(4, 'cloud-only-four'),
    ]);
    const one = fixtureBinding({
      relayBaseUrl: relayState.baseUrl,
      userId: account1.userId,
      slotName: 'full-one',
      alias: 'Full One',
    });
    const two = fixtureBinding({
      relayBaseUrl: relayState.baseUrl,
      userId: account1.userId,
      slotName: 'full-two',
      alias: 'Full Two',
      widthMode: 'mirror-fixed',
    });
    setLocalSlots(homeA, { '1': one, '2': two });
    const push = expectExit(
      runCli(homeA, ['slot', 'push', '--all'], 'push-all-replacement'),
      0,
      'push-all-replacement',
    );
    const cloud = await getCloud(account1);
    assert(
      JSON.stringify(sortSlots(cloud.slots).map((entry) => entry.slot)) === '[1,2]',
      'push --all did not fully replace the cloud map',
    );
    return {
      result: { exitCode: push.exitCode, cloudSlots: [1, 2], cloudOnlySlotsRemoved: true },
      sideEffects: { overwrittenCloudScope: 'current-account-all' },
    };
  });

  await runCase('full-pull-scope-preserves-foreign-slot', {}, async () => {
    requireCase('login-home-b');
    requireCase('full-push-replaces-cloud-map');
    const foreign = fixtureBinding({
      relayBaseUrl: relayState.baseUrl,
      userId: account2.userId,
      slotName: 'foreign-unrepresented',
      alias: 'Foreign Seven',
      widthMode: 'mirror-fixed',
    });
    setLocalSlots(homeB, {
      '5': fixtureBinding({
        relayBaseUrl: relayState.baseUrl,
        userId: account1.userId,
        slotName: 'local-only-five',
      }),
      '6': fixtureBinding({
        relayBaseUrl: relayState.baseUrl,
        userId: account1.userId,
        slotName: 'local-only-six',
      }),
      '7': foreign,
    });
    const pull = expectExit(
      runCli(homeB, ['slot', 'pull', '--all'], 'pull-all-home-b'),
      0,
      'pull-all-home-b',
    );
    const config = readHomeConfig(homeB);
    const current = accountSlots(config, account1);
    assert(
      JSON.stringify(Object.keys(current).map(Number).sort((left, right) => left - right)) === '[1,2]',
      'pull --all did not replace only the current account map',
    );
    assert(
      JSON.stringify(config.zterm.cli.slots['7']) === JSON.stringify(foreign),
      'pull --all did not preserve the unrepresented foreign slot',
    );
    assert(
      config.zterm.cli.fixtureUnrelatedCliField?.preserve === true
        && config.fixtureOutsideZterm?.preserve === true,
      'pull --all removed unrelated local configuration',
    );
    return {
      result: {
        exitCode: pull.exitCode,
        currentAccountSlots: [1, 2],
        foreignSlotsPreserved: [7],
        unrelatedConfigPreserved: true,
      },
      sideEffects: { removedLocalOnlySlots: [5, 6] },
    };
  });

  await runCase('foreign-incoming-collision-rejects-whole-pull', {}, async () => {
    requireCase('login-home-b');
    requireCase('full-pull-scope-preserves-foreign-slot');
    const foreignCollision = fixtureBinding({
      relayBaseUrl: relayState.baseUrl,
      userId: account2.userId,
      slotName: 'foreign-collision-two',
      alias: 'Foreign Collision',
    });
    setLocalSlots(homeB, {
      '2': foreignCollision,
      '5': fixtureBinding({
        relayBaseUrl: relayState.baseUrl,
        userId: account1.userId,
        slotName: 'must-not-change',
      }),
    });
    const before = configText(homeB);
    const result = expectExit(
      runCli(homeB, ['slot', 'pull', '--all'], 'pull-foreign-collision'),
      1,
      'pull-foreign-collision',
    );
    expectConfigUnchanged(homeB, before, 'pull-foreign-collision');
    return {
      result: {
        exitCode: result.exitCode,
        wholePullRejected: true,
        localConfigUnchanged: true,
      },
      sideEffects: { changedSlots: [] },
    };
  });

  await runCase('intentional-empty-all-clears-selected-account-only', {}, async () => {
    requireCase('login-home-a-and-old-unnamed-list');
    requireCase('login-home-b');
    requireCase('login-home-c');
    const accountTwoBinding = readHomeConfig(homeC).zterm.cli.slots['10'];
    const pushAccountTwo = expectExit(
      runCli(homeC, ['slot', 'push', '10'], 'push-account-two-slot-ten'),
      0,
      'push-account-two-slot-ten',
    );
    const accountTwoCloud = await getCloud(account2);
    assert(
      accountTwoCloud.configured === true
        && accountTwoCloud.slots.some((entry) => entry.slot === 10),
      'second account push did not create isolated cloud state',
    );
    assert(
      JSON.stringify(accountTwoBinding.session) === JSON.stringify(
        accountTwoCloud.slots.find((entry) => entry.slot === 10)?.session,
      ),
      'second account cloud slot target changed',
    );

    removeCurrentAccountSlots(homeA, account1);
    const pushEmpty = expectExit(
      runCli(homeA, ['slot', 'push', '--all'], 'push-all-intentional-empty'),
      0,
      'push-all-intentional-empty',
    );
    const emptyCloud = await getCloud(account1);
    assert(
      emptyCloud.configured === true && emptyCloud.slots.length === 0,
      'push --all did not create an explicitly configured empty map',
    );
    const accountTwoAfter = await getCloud(account2);
    assert(
      accountTwoAfter.configured === true
        && accountTwoAfter.slots.some((entry) => entry.slot === 10),
      'account 1 empty push changed account 2 cloud data',
    );

    const foreign = fixtureBinding({
      relayBaseUrl: relayState.baseUrl,
      userId: account2.userId,
      slotName: 'foreign-empty-pull-preserve',
      alias: 'Foreign Preserved',
    });
    setLocalSlots(homeB, {
      '5': fixtureBinding({
        relayBaseUrl: relayState.baseUrl,
        userId: account1.userId,
        slotName: 'empty-pull-local-five',
      }),
      '7': foreign,
    });
    const pullEmpty = expectExit(
      runCli(homeB, ['slot', 'pull', '--all'], 'pull-all-empty-account-one'),
      0,
      'pull-all-empty-account-one',
    );
    const config = readHomeConfig(homeB);
    assert(
      Object.keys(accountSlots(config, account1)).length === 0,
      'empty pull did not clear the selected account scope',
    );
    assert(
      JSON.stringify(config.zterm.cli.slots['7']) === JSON.stringify(foreign),
      'empty pull removed an unrepresented foreign slot',
    );
    assert(
      JSON.stringify(sortSlots((await getCloud(account2)).slots).map((entry) => entry.slot))
        === '[10]',
      'selected-account empty pull changed the second account cloud map',
    );
    return {
      result: {
        accountOneEmptyPushExitCode: pushEmpty.exitCode,
        accountOneEmptyPullExitCode: pullEmpty.exitCode,
        accountTwoPushExitCode: pushAccountTwo.exitCode,
        accountOneConfiguredEmpty: true,
        accountTwoSlots: [10],
        foreignSlotsPreserved: [7],
      },
      sideEffects: {
        accountOneSlotsRemoved: [5],
        accountTwoCloudUnchanged: true,
      },
    };
  });

  await runCase('second-account-cloud-isolation', {}, async () => {
    requireCase('intentional-empty-all-clears-selected-account-only');
    const first = await getCloud(account1);
    const second = await getCloud(account2);
    assert(first.configured === true && first.slots.length === 0, 'account 1 cloud map changed');
    assert(
      second.configured === true
        && JSON.stringify(second.slots.map((entry) => entry.slot)) === '[10]',
      'account 2 cloud map is not isolated',
    );
    return {
      result: {
        accountOneConfiguredEmpty: true,
        accountTwoSlots: [10],
        isolated: true,
      },
      sideEffects: { cloudWrites: 0 },
    };
  });

  await runCase('cloud-payload-has-no-account-token-or-endpoint', {}, async () => {
    requireCase('second-account-cloud-isolation');
    const payloads = [await getCloud(account1), await getCloud(account2)];
    for (const payload of payloads) {
      assertNoForbiddenCloudFields(payload, [
        account1.accessToken,
        account2.accessToken,
        account1.password,
        account2.password,
        relayState.baseUrl,
      ]);
    }
    const cloudFile = existsSync(relayState.cloudPath)
      ? readFileSync(relayState.cloudPath, 'utf8')
      : '';
    for (const secret of [
      account1.accessToken,
      account2.accessToken,
      account1.password,
      account2.password,
      relayState.baseUrl,
    ]) {
      assert(!cloudFile.includes(secret), 'cloud slot file contains an account or endpoint secret');
    }
    return {
      result: {
        cloudPayloadsAudited: payloads.length,
        forbiddenOwnershipFieldsAbsent: true,
        forbiddenSecretsAbsent: true,
      },
      sideEffects: { cloudWrites: 0 },
    };
  });

  let cleanupError;
  let stopResult;
  try {
    stopResult = await stopRelayRuntime(relayState);
    cleanup.relay = stopResult;
    cleanup.websocket = 'none-open';
  } catch (error) {
    cleanupError = error;
    cleanup.relay = {
      pid: relayState?.pid,
      exited: false,
      error: sanitize(errorMessage(error)),
      outputTail: sanitize(relayFailureText(relayState)),
    };
  }
  if (!cleanupError && stopResult?.exited) {
    rmSync(testRoot, { recursive: true, force: true });
    cleanup.tempRootRemoved = !existsSync(testRoot);
    if (!cleanup.tempRootRemoved) cleanupError = new Error('temporary root was not removed');
  }

  const failed = receipts.filter((entry) => entry.status === 'failed');
  const skipped = receipts.filter((entry) => entry.status === 'skipped');
  const finalState = cleanupError
    ? 'failed'
    : failed.length === 0 && skipped.length === 0
      ? 'passed'
      : 'failed';
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
