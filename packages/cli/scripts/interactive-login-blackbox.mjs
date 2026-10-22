#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { resolveRemoteNodePty } from './remote-cli-blackbox-helper.mjs';
import { resolveNpmInvocation } from './process-entry.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliDir = dirname(scriptDir);
const repoRoot = resolve(cliDir, '..', '..');
const androidDir = join(repoRoot, 'android');
const defaultEvidenceDir = join(repoRoot, 'tmp', 'interactive-login-blackbox');
const USERNAME = 'fixture-interactive-user';
const PASSWORD = 'fixture-interactive-password-not-real';
const ACCESS_TOKEN = 'fixture-interactive-access-token-not-real';
const USER_ID = 'fixture-interactive-user-id';
const EXIT_MARKER = /ZTERM_BLACKBOX_EXIT=(\d+)/u;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

const evidenceDir = resolve(argumentValue('--evidence-dir') ?? defaultEvidenceDir);
const keepTemp = process.argv.includes('--keep-temp');
const requireFromCli = createRequire(join(cliDir, 'package.json'));
const packageManifest = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sanitize(text) {
  return String(text)
    .split(PASSWORD).join('[redacted-password]')
    .split(ACCESS_TOKEN).join('[redacted-token]');
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} exited ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

function isolatedEnvironment(home, extra = {}) {
  const env = {
    HOME: home,
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    TERM: 'xterm-256color',
    SHELL: '/bin/sh',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    ...extra,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

function writeScenarioConfig(home, relayBaseUrl) {
  const configDir = join(home, '.zterm');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, 'config.json'),
    `${JSON.stringify({
      zterm: {
        cli: {
          server: { relayBaseUrl },
        },
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function readScenarioConfig(home) {
  return JSON.parse(readFileSync(join(home, '.zterm', 'config.json'), 'utf8'));
}

async function waitFor(predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForFile(path, label, timeoutMs = 8_000) {
  return waitFor(() => {
    if (!existsSync(path)) return undefined;
    const value = readFileSync(path, 'utf8').trim();
    return value.length > 0 ? value : undefined;
  }, label, timeoutMs);
}

async function buildInstalledCli(root, prefix, env) {
  const staging = join(root, 'staging');
  const tarballDir = join(root, 'tarball');
  mkdirSync(join(staging, 'bin'), { recursive: true });
  mkdirSync(join(staging, 'dist'), { recursive: true });
  mkdirSync(tarballDir, { recursive: true });
  copyFileSync(join(cliDir, 'bin', 'zterm.mjs'), join(staging, 'bin', 'zterm.mjs'));
  copyFileSync(join(cliDir, 'README.md'), join(staging, 'README.md'));
  copyFileSync(join(cliDir, 'LICENSE'), join(staging, 'LICENSE'));
  chmodSync(join(staging, 'bin', 'zterm.mjs'), 0o755);
  writeFileSync(
    join(staging, 'package.json'),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
    { mode: 0o644 },
  );

  const esbuild = requireFromCli('esbuild');
  await esbuild.build({
    entryPoints: [join(cliDir, 'src', 'main.ts')],
    outfile: join(staging, 'dist', 'main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    define: {
      __ZTERM_CLI_VERSION__: JSON.stringify(packageManifest.version),
    },
    external: ['ws', '@roamhq/wrtc'],
    logLevel: 'silent',
    absWorkingDir: cliDir,
  });

  const npm = resolveNpmInvocation([
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    tarballDir,
  ], { env });
  const packed = runProcess(npm.command, npm.args, { cwd: staging, env, timeout: 60_000 });
  const packRecord = JSON.parse(packed.stdout.trim())[0];
  assert(packRecord && typeof packRecord.filename === 'string', 'npm pack did not report a filename');
  const tarball = join(tarballDir, packRecord.filename);
  assert(existsSync(tarball), `npm pack output is missing: ${tarball}`);

  const packageRoot = join(
    prefix,
    'lib',
    'node_modules',
    '@jsonstudio',
    'zterm-cli',
  );
  mkdirSync(packageRoot, { recursive: true });
  runProcess('tar', ['-xzf', tarball, '-C', packageRoot, '--strip-components=1'], {
    env,
    timeout: 30_000,
  });
  chmodSync(join(packageRoot, 'bin', 'zterm.mjs'), 0o755);

  const dependencyRoot = join(packageRoot, 'node_modules');
  mkdirSync(join(dependencyRoot, '@roamhq'), { recursive: true });
  symlinkSync(
    realpathSync(dirname(requireFromCli.resolve('ws/package.json'))),
    join(dependencyRoot, 'ws'),
    'dir',
  );
  symlinkSync(
    realpathSync(dirname(requireFromCli.resolve('@roamhq/wrtc/package.json'))),
    join(dependencyRoot, '@roamhq', 'wrtc'),
    'dir',
  );

  mkdirSync(join(prefix, 'bin'), { recursive: true });
  const bin = join(prefix, 'bin', 'zterm');
  symlinkSync(
    '../lib/node_modules/@jsonstudio/zterm-cli/bin/zterm.mjs',
    bin,
  );
  const relation = relative(repoRoot, realpathSync(bin));
  assert(
    relation.startsWith('..') || isAbsolute(relation),
    'installed zterm bin resolves inside the source tree',
  );

  const version = runProcess(bin, ['--version'], { cwd: root, env, timeout: 30_000 });
  assert(
    version.stdout.trim() === `zterm ${packageManifest.version}`,
    `installed zterm version mismatch: ${version.stdout.trim()}`,
  );
  return {
    bin,
    packageRoot,
    tarball,
    version: version.stdout.trim(),
  };
}

function startAccountFixture() {
  let loginRequests = 0;
  let matchedLogins = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method !== 'POST' || request.url !== '/zterm/api/auth/login') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"error":"not_found"}\n');
        return;
      }
      loginRequests += 1;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end('{"error":"invalid_json"}\n');
        return;
      }
      if (body.username !== USERNAME || body.password !== PASSWORD) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end('{"error":"invalid_credentials"}\n');
        return;
      }
      matchedLogins += 1;
      const payload = {
        accessToken: ACCESS_TOKEN,
        user: {
          id: USER_ID,
          username: USERNAME,
        },
        directory: {
          schemaVersion: 1,
          user: {
            id: USER_ID,
            username: USERNAME,
          },
          devices: [],
          updatedAt: '2026-10-21T00:00:00.000Z',
        },
      };
      const value = `${JSON.stringify(payload)}\n`;
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(value),
      });
      response.end(value);
    });
  });
  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectStart(new Error('account fixture has no TCP address'));
        return;
      }
      resolveStart({
        relayBaseUrl: `http://127.0.0.1:${address.port}/zterm/`,
        snapshot: () => ({ loginRequests, matchedLogins }),
        close: () => new Promise((resolveClose) => {
          server.closeAllConnections?.();
          server.close(() => resolveClose());
        }),
      });
    });
  });
}

function stageNodePty(root) {
  const installation = resolveRemoteNodePty(androidDir);
  const stagedRoot = join(root, 'node-pty');
  cpSync(installation.packageRoot, stagedRoot, {
    recursive: true,
    dereference: true,
  });
  const prebuilds = join(stagedRoot, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const name of readdirSync(prebuilds)) {
      const helper = join(prebuilds, name, 'spawn-helper');
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  }
  const pty = createRequire(join(stagedRoot, 'package.json'))(stagedRoot);
  assert(pty && typeof pty.spawn === 'function', 'staged node-pty has no spawn()');
  return pty;
}

function writeRunner(scenarioDir) {
  const runner = join(scenarioDir, 'runner.sh');
  writeFileSync(runner, [
    '#!/bin/sh',
    'before=$1',
    'pidfile=$2',
    'zterm=$3',
    'after=$4',
    'stty -g > "$before"',
    'sh -c \'echo $$ > "$1"; exec "$2" login\' sh "$pidfile" "$zterm"',
    'code=$?',
    'stty -g > "$after"',
    'printf "ZTERM_BLACKBOX_EXIT=%s\\n" "$code"',
    '',
  ].join('\n'), { mode: 0o755 });
  return runner;
}

async function runScenario({ pty, ztermBin, root, name, relayBaseUrl, action }) {
  const scenarioDir = join(root, 'scenarios', name);
  const home = join(scenarioDir, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeScenarioConfig(home, relayBaseUrl);
  const before = join(scenarioDir, 'stty-before');
  const after = join(scenarioDir, 'stty-after');
  const pidfile = join(scenarioDir, 'zterm.pid');
  const runner = writeRunner(scenarioDir);
  const env = isolatedEnvironment(home);
  const terminal = pty.spawn('/bin/sh', ['-i'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: scenarioDir,
    env,
  });
  let output = '';
  const dataSubscription = terminal.onData((chunk) => {
    output += chunk;
  });

  const result = {
    name,
    exitCode: undefined,
    rawModeRestored: false,
    pidReleased: false,
    passwordEchoed: false,
    interruptEchoed: false,
    loginSucceeded: false,
    loginRequests: undefined,
  };
  try {
    await delay(150);
    terminal.write(`${[
      runner,
      before,
      pidfile,
      ztermBin,
      after,
    ].map(shellQuote).join(' ')}\n`);
    await action({
      terminal,
      output: () => output,
      pidfile,
    });
    const marker = await waitFor(
      () => EXIT_MARKER.exec(output),
      `${name} exit marker`,
      10_000,
    );
    result.exitCode = Number(marker[1]);
    await delay(30);
    assert(existsSync(before), `${name} did not record stty before`);
    assert(existsSync(after), `${name} did not record stty after`);
    result.rawModeRestored = readFileSync(before, 'utf8').trim()
      === readFileSync(after, 'utf8').trim();
    const pid = Number(readFileSync(pidfile, 'utf8').trim());
    result.pidReleased = Number.isSafeInteger(pid) && !isProcessAlive(pid);
    result.passwordEchoed = output.includes(PASSWORD);
    result.interruptEchoed = output.includes('^C');
    result.loginSucceeded = output.includes('登录成功');
    return result;
  } catch (error) {
    error.message = `${error.message}\n${name} output:\n${sanitize(output).slice(-4_000)}`;
    throw error;
  } finally {
    dataSubscription.dispose();
    if (isProcessAlive(terminal.pid)) terminal.kill();
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForPrompt(state, pattern, label) {
  return waitFor(() => pattern.test(state.output()), label);
}

async function sendSignalAtPrompt({ terminal, output, pidfile }, signal, prompt) {
  await waitForPrompt({ output }, prompt, `${signal} ${prompt} prompt`);
  const pid = Number(await waitForFile(pidfile, `${signal} zterm pid`));
  assert(Number.isSafeInteger(pid), `${signal} zterm pid is invalid`);
  process.kill(pid, signal);
}

async function run() {
  mkdirSync(evidenceDir, { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zterm-interactive-login-')));
  const prefix = join(root, 'npm-prefix');
  const npmCache = join(root, 'npm-cache');
  mkdirSync(prefix, { recursive: true });
  mkdirSync(npmCache, { recursive: true });
  const env = isolatedEnvironment(join(root, 'build-home'), {
    npm_config_cache: npmCache,
    npm_config_userconfig: join(root, 'npmrc'),
  });
  writeFileSync(env.npm_config_userconfig, 'audit=false\nfund=false\nupdate-notifier=false\n', {
    mode: 0o600,
  });
  const result = {
    ok: false,
    installed: undefined,
    fixture: undefined,
    success: undefined,
    cancellations: [],
    cleanup: undefined,
  };
  let fixture;
  try {
    result.installed = await buildInstalledCli(root, prefix, env);
    const pty = stageNodePty(root);
    fixture = await startAccountFixture();
    const relayBaseUrl = fixture.relayBaseUrl;

    result.success = await runScenario({
      pty,
      ztermBin: result.installed.bin,
      root,
      name: 'success',
      relayBaseUrl,
      action: async ({ terminal, output }) => {
        await waitForPrompt({ output }, /账号/u, 'username prompt');
        terminal.write(`${USERNAME}\r`);
        await waitForPrompt({ output }, /密码/u, 'password prompt');
        terminal.write(`${PASSWORD}\r`);
      },
    });
    assert(result.success.exitCode === 0, `successful login exited ${result.success.exitCode}`);
    assert(result.success.rawModeRestored, 'successful login did not restore the exact PTY mode');
    assert(!result.success.passwordEchoed, 'password was echoed by the PTY');
    assert(result.success.loginSucceeded, 'successful login did not report success');
    const configText = readFileSync(join(root, 'scenarios', 'success', 'home', '.zterm', 'config.json'), 'utf8');
    const config = JSON.parse(configText);
    const auth = config?.zterm?.cli?.auth;
    assert(auth && auth.username === USERNAME, 'successful login did not persist the account');
    assert(auth.accessToken === ACCESS_TOKEN, 'successful login did not persist the access token');
    assert(!configText.includes(PASSWORD), 'successful login persisted the password');
    const fixtureAfterSuccess = fixture.snapshot();
    assert(fixtureAfterSuccess.matchedLogins === 1, 'account fixture did not receive one matched login');

    const cancellations = [
      { name: 'sigterm-text', signal: 'SIGTERM', prompt: /账号/u },
      { name: 'sighup-text', signal: 'SIGHUP', prompt: /账号/u },
      { name: 'sigterm-password', signal: 'SIGTERM', prompt: /密码/u },
      { name: 'sighup-password', signal: 'SIGHUP', prompt: /密码/u },
      { name: 'ctrl-c-password', ctrlC: true, prompt: /密码/u },
    ];
    for (const scenario of cancellations) {
      const scenarioResult = await runScenario({
        pty,
        ztermBin: result.installed.bin,
        root,
        name: scenario.name,
        relayBaseUrl,
        action: async (state) => {
          if (scenario.prompt.source.includes('密码')) {
            await waitForPrompt(state, /账号/u, 'username prompt');
            state.terminal.write(`${USERNAME}\r`);
          }
          if (scenario.ctrlC) {
            await waitForPrompt(state, scenario.prompt, 'password prompt');
            state.terminal.write('\u0003');
            return;
          }
          await sendSignalAtPrompt(state, scenario.signal, scenario.prompt);
        },
      });
      scenarioResult.signal = scenario.ctrlC ? 'Ctrl+C-byte' : scenario.signal;
      result.cancellations.push(scenarioResult);
    }

    for (const cancelled of result.cancellations) {
      assert(cancelled.exitCode === 130, `${cancelled.name} exited ${cancelled.exitCode}`);
      assert(cancelled.rawModeRestored, `${cancelled.name} did not restore the exact PTY mode`);
      assert(cancelled.pidReleased, `${cancelled.name} left the CLI process alive`);
      assert(!cancelled.passwordEchoed, `${cancelled.name} echoed the password`);
      if (cancelled.signal === 'Ctrl+C-byte') {
        assert(!cancelled.interruptEchoed, 'Ctrl+C byte was echoed by the terminal');
      }
      const config = readScenarioConfig(join(root, 'scenarios', cancelled.name, 'home'));
      assert(!config?.zterm?.cli?.auth, `${cancelled.name} persisted login state`);
    }
    assert(
      fixture.snapshot().matchedLogins === 1,
      'cancellation paths reached the account fixture',
    );
    result.fixture = fixture.snapshot();
    result.ok = true;
    return result;
  } finally {
    if (fixture) await fixture.close();
    if (!keepTemp) {
      rmSync(root, { recursive: true, force: true });
      result.cleanup = { tempRootRemoved: true, tempRoot: root };
    } else {
      result.cleanup = { tempRootRemoved: false, tempRoot: root };
    }
    writeFileSync(
      join(evidenceDir, 'interactive-login-blackbox-result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      { mode: 0o644 },
    );
  }
}

try {
  const result = await run();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`interactive login blackbox failed: ${sanitize(messageOf(error))}\n`);
  process.exitCode = 1;
}
