import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveNpmInvocation } from './process-entry.mjs';
import {
  assertSupportedTuple,
  environmentSecrets,
  findSingleFile,
  formalCliInvocation,
  installedCliBin,
  installedCliPackageRoot,
  parseDaemonCompileResult,
  parsePlatformSmokeArgs,
  readJson,
  redactText,
  resolveNodePtyInstallation,
  resolveWrtcInstallation,
  runProcess,
  sanitizeValue,
  tupleOf,
} from './platform-smoke-helper.mjs';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const packageDir = resolve(scriptDir, '..');
const repoRoot = resolve(packageDir, '..', '..');
const androidDir = join(repoRoot, 'android');
const packageManifest = readJson(join(packageDir, 'package.json'));
const requiredNodeMajor = 22;

function isoNow() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function outsideSource(path) {
  const relation = relative(repoRoot, path);
  return relation.startsWith('..') || isAbsolute(relation);
}

function outputDetail(result) {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.trim().slice(-6_000),
    stderr: result.stderr.trim().slice(-6_000),
  };
}

function createSandboxEnv(sandboxRoot, prefix) {
  const home = join(sandboxRoot, 'home');
  const appData = join(home, 'AppData');
  mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(appData, 'Roaming'),
    LOCALAPPDATA: join(appData, 'Local'),
    TERM: 'xterm-256color',
    npm_config_cache: join(sandboxRoot, 'npm-cache'),
    npm_config_prefix: prefix,
    npm_config_userconfig: join(sandboxRoot, 'npmrc'),
  };
}

function runFormalCli(binPath, args, sandbox, env) {
  const invocation = formalCliInvocation(
    binPath,
    args,
    process.platform,
    env,
  );
  return runProcess(invocation.command, invocation.args, {
    cwd: sandbox,
    env,
    timeout: 30_000,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

function waitForIceGatheringComplete(peer, timeoutMs) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      peer.removeEventListener?.('icegatheringstatechange', check);
      rejectPromise(new Error('RTC ICE gathering timeout'));
    }, timeoutMs);
    const check = () => {
      if (peer.iceGatheringState !== 'complete') return;
      clearTimeout(timer);
      peer.removeEventListener?.('icegatheringstatechange', check);
      resolvePromise();
    };
    peer.addEventListener('icegatheringstatechange', check);
    check();
  });
}

function waitForEvent(target, eventName, label, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      target.removeEventListener?.(eventName, onEvent);
      rejectPromise(new Error(`${label} timeout`));
    }, timeoutMs);
    const onEvent = (event) => {
      clearTimeout(timer);
      target.removeEventListener?.(eventName, onEvent);
      resolvePromise(event);
    };
    target.addEventListener(eventName, onEvent);
  });
}

function waitForChannelMessage(channel, expected, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      channel.removeEventListener?.('message', onMessage);
      rejectPromise(new Error(`RTC DataChannel message timeout: ${expected}`));
    }, timeoutMs);
    const onMessage = (event) => {
      const value = String(event.data);
      if (value !== expected) return;
      clearTimeout(timer);
      channel.removeEventListener?.('message', onMessage);
      resolvePromise(value);
    };
    channel.addEventListener('message', onMessage);
  });
}

async function runDataChannelRoundTrip(wrtc, timeoutMs) {
  const first = new wrtc.RTCPeerConnection({ iceServers: [] });
  const second = new wrtc.RTCPeerConnection({ iceServers: [] });
  const runId = `${Date.now()}-${process.pid}`;
  const channelName = `platform-smoke-${runId}`;
  const outbound = `offerer-to-answerer-${runId}`;
  const inbound = `answerer-to-offerer-${runId}`;
  let firstChannel;
  let secondChannel;

  try {
    firstChannel = first.createDataChannel(channelName, { ordered: true });
    const receivedChannel = waitForEvent(
      second,
      'datachannel',
      'RTC answer datachannel',
      timeoutMs,
    ).then((event) => event.channel);

    const offer = await first.createOffer();
    await first.setLocalDescription(offer);
    await waitForIceGatheringComplete(first, timeoutMs);

    await second.setRemoteDescription(first.localDescription);
    const answer = await second.createAnswer();
    await second.setLocalDescription(answer);
    await waitForIceGatheringComplete(second, timeoutMs);
    await first.setRemoteDescription(second.localDescription);

    secondChannel = await receivedChannel;
    if (secondChannel.label !== channelName) {
      throw new Error(
        `RTC DataChannel label mismatch: ${secondChannel.label}`,
      );
    }

    await Promise.all([
      firstChannel.readyState === 'open'
        ? Promise.resolve()
        : waitForEvent(
          firstChannel,
          'open',
          'RTC offer DataChannel open',
          timeoutMs,
        ),
      secondChannel.readyState === 'open'
        ? Promise.resolve()
        : waitForEvent(
          secondChannel,
          'open',
          'RTC answer DataChannel open',
          timeoutMs,
        ),
    ]);

    const replyPromise = waitForChannelMessage(
      firstChannel,
      inbound,
      timeoutMs,
    );
    const echoPromise = waitForChannelMessage(
      secondChannel,
      outbound,
      timeoutMs,
    );
    firstChannel.send(outbound);
    secondChannel.send(inbound);

    const [reply, echo] = await Promise.all([replyPromise, echoPromise]);
    return {
      channelName,
      offererReceived: reply === inbound,
      answererReceived: echo === outbound,
      ordered: true,
    };
  } finally {
    try {
      firstChannel?.close();
    } catch {
      // The channel may already be closed.
    }
    try {
      secondChannel?.close();
    } catch {
      // The channel may already be closed.
    }
    first.close();
    second.close();
  }
}

async function runWrtcSmoke(installedPackageJson, timeoutMs) {
  const installation = resolveWrtcInstallation(installedPackageJson);
  const packageRequire = createRequire(installedPackageJson);
  const wrtc = packageRequire('@roamhq/wrtc');
  if (typeof wrtc.RTCPeerConnection !== 'function') {
    throw new Error('installed wrtc module has no RTCPeerConnection');
  }
  const roundTrip = await runDataChannelRoundTrip(wrtc, timeoutMs);
  return {
    modulePath: installation.wrtcEntry,
    nativePath: installation.nativePath,
    ...roundTrip,
  };
}

function posixQuote(value) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function windowsQuote(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function createPtyProbeScript(path, runId) {
  const source = `import process from 'node:process';

const runId = ${JSON.stringify(runId)};
if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  process.stderr.write('PTY_PROBE_NOT_TTY\\n');
  process.exit(2);
}

const previousRawMode = process.stdin.isRaw === true;
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('PTY_RAW_READY:' + runId + '\\r\\n');

process.stdin.once('data', (chunk) => {
  const bytes = Buffer.from(chunk);
  process.stdout.write(
    'PTY_RAW_DATA:' + runId + ':' + bytes.toString('hex') + '\\r\\n',
  );
  process.stdin.setRawMode(previousRawMode);
  process.stdout.write('PTY_RAW_RESTORED:' + runId + '\\r\\n');
  setTimeout(() => process.exit(0), 25);
});
`;
  writeFileSync(path, source, { mode: 0o600 });
}

async function runPtySmoke(sandboxRoot, timeoutMs, daemonPackageRoot) {
  const installation = resolveNodePtyInstallation(
    daemonPackageRoot
      ? join(daemonPackageRoot, 'runtime', 'server.cjs')
      : join(androidDir, 'package.json'),
  );
  const stagedPackageRoot = join(sandboxRoot, 'node-pty');
  cpSync(installation.packageRoot, stagedPackageRoot, {
    recursive: true,
    dereference: true,
  });
  const stagedSpawnHelper = join(
    stagedPackageRoot,
    installation.spawnHelperRelativePath,
  );
  if (process.platform !== 'win32' && existsSync(stagedSpawnHelper)) {
    chmodSync(stagedSpawnHelper, 0o755);
  }
  const packageRequire = createRequire(join(stagedPackageRoot, 'package.json'));
  const pty = packageRequire(stagedPackageRoot);
  const stagedPtyNativePath = join(
    stagedPackageRoot,
    installation.ptyNativeRelativePath,
  );
  const stagedConPtyNativePath = installation.conPtyNativePath
    ? join(stagedPackageRoot, installation.ptyNativeRelativePath.replace(
        /pty\.node$/u,
        'conpty.node',
      ))
    : undefined;
  const runId = `${Date.now()}-${process.pid}`;
  const probePath = join(sandboxRoot, `pty-probe-${runId}.mjs`);
  createPtyProbeScript(probePath, runId);

  const shell = process.platform === 'win32'
    ? process.env.ComSpec || 'cmd.exe'
    : '/bin/sh';
  const shellArgs = process.platform === 'win32'
    ? ['/D', '/Q']
    : ['-i'];
  const terminal = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: sandboxRoot,
    env: {
      ...process.env,
      HOME: join(sandboxRoot, 'home'),
      USERPROFILE: join(sandboxRoot, 'home'),
      TERM: 'xterm-256color',
      PS1: `PLATFORM_SMOKE_${runId}> `,
    },
  });
  let output = '';
  let exited = false;
  let resolveExit;
  const exitPromise = new Promise((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  terminal.onData((chunk) => {
    output += chunk;
    if (output.length > 2_000_000) output = output.slice(-1_000_000);
  });
  terminal.onExit((event) => {
    exited = true;
    resolveExit(event);
  });

  const waitForText = async (text, label, from = 0) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const visible = output.slice(from).replaceAll('\r', '');
      if (visible.includes(text)) return visible;
      if (exited) throw new Error(`${label} failed: PTY exited`);
      await delay(30);
    }
    throw new Error(`${label} timeout`);
  };

  const writeLine = (text) => {
    terminal.write(`${text}${process.platform === 'win32' ? '\r' : '\n'}`);
  };

  try {
    if (process.platform !== 'win32') {
      writeLine(`printf 'PTY_STTY_BEFORE:${runId}:%s\\n' "$(stty -g)"`);
      await waitForText(`PTY_STTY_BEFORE:${runId}:`, 'PTY stty baseline');
    }

    const command = process.platform === 'win32'
      ? `${windowsQuote(process.execPath)} ${windowsQuote(probePath)}`
      : `${posixQuote(process.execPath)} ${posixQuote(probePath)}`;
    writeLine(command);
    await waitForText(`PTY_RAW_READY:${runId}`, 'PTY raw-ready');

    const probeInput = `host-to-pty-${runId}`;
    terminal.write(probeInput);
    const expectedHex = Buffer.from(probeInput).toString('hex');
    await waitForText(
      `PTY_RAW_DATA:${runId}:${expectedHex}`,
      'PTY host-to-child input',
    );
    await waitForText(
      `PTY_RAW_RESTORED:${runId}`,
      'PTY child raw-mode restore',
    );

    if (process.platform === 'win32') {
      writeLine(`echo PTY_RECOVERED:${runId}`);
      const recovered = await waitForText(
        `PTY_RECOVERED:${runId}`,
        'ConPTY recovery',
      );
      return {
        shell,
        tuple: installation.tuple,
        ptyNativePath: stagedPtyNativePath,
        conPtyNativePath: stagedConPtyNativePath,
        inputSent: true,
        outputReceived: true,
        recovered: recovered.includes(`PTY_RECOVERED:${runId}`),
      };
    }

    writeLine(`printf 'PTY_STTY_AFTER:${runId}:%s\\n' "$(stty -g)"`);
    const afterText = await waitForText(
      `PTY_STTY_AFTER:${runId}:`,
      'PTY stty recovery',
    );
    const beforeMatch = new RegExp(
      `PTY_STTY_BEFORE:${runId}:([^\\r\\n]+)`,
    ).exec(output);
    const afterMatch = new RegExp(
      `PTY_STTY_AFTER:${runId}:([^\\r\\n]+)`,
    ).exec(afterText);
    if (!beforeMatch || !afterMatch || beforeMatch[1] !== afterMatch[1]) {
      throw new Error('PTY terminal mode was not restored');
    }
    return {
      shell,
      tuple: installation.tuple,
      ptyNativePath: stagedPtyNativePath,
      inputSent: true,
      outputReceived: true,
      recovered: true,
      terminalModeRestored: true,
    };
  } finally {
    if (!exited) {
      try {
        writeLine('exit');
      } catch {
        // The exact owned PTY may already be closed.
      }
      await Promise.race([exitPromise, delay(1_000)]);
    }
    if (!exited) {
      try {
        terminal.kill();
      } catch {
        // The exact owned PTY may already be closed.
      }
      await Promise.race([exitPromise, delay(2_000)]);
    }
  }
}

async function findUnusedLoopbackPort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectPromise(new Error('failed to allocate a loopback port'));
        return;
      }
      server.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise(address.port);
      });
    });
  });
}

async function runDaemonPayloadReadOnly(daemonPackageRoot, sandboxRoot, env, timeoutMs) {
  const manifest = readJson(join(daemonPackageRoot, 'zterm-package.json'));
  if (manifest?.schemaVersion !== 1) {
    throw new Error('daemon platform manifest schemaVersion must be 1');
  }
  if (
    manifest.platform?.os !== process.platform
    || manifest.platform?.arch !== process.arch
  ) {
    throw new Error(
      `daemon platform mismatch: ${manifest.platform?.os}-${manifest.platform?.arch}`,
    );
  }
  const missing = (manifest.runtimeComponents || []).filter(
    (component) => typeof component !== 'string'
      || !existsSync(join(daemonPackageRoot, component)),
  );
  if (missing.length > 0) {
    throw new Error(
      `daemon platform payload is missing components: ${missing.join(', ')}`,
    );
  }

  const invocation = process.platform === 'win32'
    ? {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(daemonPackageRoot, 'support', 'windows', 'zterm-daemon.ps1'),
        ],
      }
    : {
        command: join(daemonPackageRoot, 'support', 'zterm-daemon.sh'),
        args: [],
      };
  const port = await findUnusedLoopbackPort();
  const payloadEnv = {
    ...env,
    HOME: join(sandboxRoot, 'home'),
    USERPROFILE: join(sandboxRoot, 'home'),
    ZTERM_PACKAGE_ROOT: daemonPackageRoot,
    ZTERM_HOST: '127.0.0.1',
    ZTERM_PORT: String(port),
  };
  const config = runProcess(
    invocation.command,
    [...invocation.args, 'config'],
    {
      cwd: sandboxRoot,
      env: payloadEnv,
      timeout: timeoutMs,
    },
  );
  const status = runProcess(
    invocation.command,
    [...invocation.args, 'status'],
    {
      cwd: sandboxRoot,
      env: payloadEnv,
      timeout: timeoutMs,
      allowFailure: true,
    },
  );
  if (status.exitCode !== 1 || !/not running/iu.test(status.stdout)) {
    throw new Error(
      `daemon payload status did not report a stopped process: exit=${
        String(status.exitCode)
      } stdout=${JSON.stringify(status.stdout.trim())}`,
    );
  }
  return {
    packageName: manifest.package?.name,
    packageVersion: manifest.package?.version,
    components: manifest.runtimeComponents.length,
    configExitCode: config.exitCode,
    statusExitCode: status.exitCode,
    statusObservedStopped: true,
  };
}

function loadDaemonNative(path) {
  const nativeRequire = createRequire(import.meta.url);
  const native = nativeRequire(path);
  if (typeof native.compilePhase0 !== 'function') {
    throw new Error('DAGpipe native does not export compilePhase0');
  }
  const compiled = parseDaemonCompileResult(native.compilePhase0());
  return {
    path,
    exports: Object.keys(native).sort(),
    compilePhase0Ok: true,
  };
}

async function main() {
  const options = parsePlatformSmokeArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'Usage: node packages/cli/scripts/platform-smoke.mjs '
        + '[--evidence-dir <dir>] [--timeout-ms <ms>] '
        + '[--daemon-native <node-file>] [--daemon-package-root <dir>] '
        + '[--skip-build]\n',
    );
    return 0;
  }

  const tuple = assertSupportedTuple();
  if (Number(process.versions.node.split('.')[0]) !== requiredNodeMajor) {
    throw new Error(
      `platform smoke requires Node ${requiredNodeMajor}; actual ${process.versions.node}`,
    );
  }

  mkdirSync(options.evidenceDir, { recursive: true });
  const summaryPath = join(options.evidenceDir, 'platform-smoke-summary.json');
  const secrets = environmentSecrets();
  const startedAt = isoNow();
  const checks = [];
  const artifacts = {
    evidenceDir: options.evidenceDir,
    tarballPath: undefined,
    installedPrefix: undefined,
    installedBin: undefined,
  };
  let sandboxRoot;
  let daemonPackageRoot;

  const runCheck = async (name, action) => {
    const startedAtMs = Date.now();
    try {
      const detail = await action();
      checks.push({
        name,
        status: 'passed',
        durationMs: Date.now() - startedAtMs,
        detail: sanitizeValue(detail, secrets),
      });
      return detail;
    } catch (error) {
      checks.push({
        name,
        status: 'failed',
        durationMs: Date.now() - startedAtMs,
        error: redactText(errorMessage(error), secrets),
      });
      throw error;
    }
  };

  try {
    sandboxRoot = mkdtempSync(join(tmpdir(), 'zterm-platform-smoke-'));
    const tarballDir = join(sandboxRoot, 'tarball');
    const prefix = join(sandboxRoot, 'prefix');
    const outside = join(sandboxRoot, 'outside-source');
    mkdirSync(tarballDir, { recursive: true });
    mkdirSync(prefix, { recursive: true });
    mkdirSync(outside, { recursive: true });
    artifacts.installedPrefix = prefix;
    if (options.daemonPackageRoot) {
      daemonPackageRoot = resolve(options.daemonPackageRoot);
      artifacts.daemonPackageRoot = daemonPackageRoot;
    }
    const env = createSandboxEnv(sandboxRoot, prefix);

    await runCheck('host-tuple', async () => ({
      platform: process.platform,
      arch: process.arch,
      tuple,
      node: process.versions.node,
      expectedNodeMajor: requiredNodeMajor,
    }));

    if (!options.skipBuild) {
      await runCheck('formal-cli-build', async () => {
        const result = runProcess(
          process.execPath,
          [join(packageDir, 'scripts', 'build.mjs')],
          {
            cwd: packageDir,
            env,
            timeout: Math.max(options.timeoutMs, 60_000),
          },
        );
        const distEntry = join(packageDir, 'dist', 'main.mjs');
        if (!existsSync(distEntry)) {
          throw new Error(`formal CLI build did not create ${distEntry}`);
        }
        return {
          distEntry,
          ...outputDetail(result),
        };
      });
    }

    const packResult = await runCheck('real-npm-pack', async () => {
      const npm = resolveNpmInvocation([
        'pack',
        '--ignore-scripts',
        '--pack-destination',
        tarballDir,
      ], { env });
      const result = runProcess(npm.command, npm.args, {
        cwd: packageDir,
        env,
        timeout: Math.max(options.timeoutMs, 60_000),
      });
      const generated = findSingleFile(tarballDir, '.tgz');
      const evidenceTarball = join(
        options.evidenceDir,
        'zterm-cli-platform-smoke.tgz',
      );
      copyFileSync(generated, evidenceTarball);
      artifacts.tarballPath = evidenceTarball;
      return {
        generated,
        evidenceCopy: evidenceTarball,
        ...outputDetail(result),
      };
    });
    const tarballPath = packResult.evidenceCopy;

    const packageRoot = installedCliPackageRoot(prefix);
    const installedBin = installedCliBin(prefix);
    artifacts.installedBin = installedBin;
    await runCheck('isolated-tarball-install', async () => {
      const npm = resolveNpmInvocation([
        'install',
        '--global',
        '--prefix',
        prefix,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        tarballPath,
      ], { env });
      const result = runProcess(npm.command, npm.args, {
        cwd: outside,
        env,
        timeout: Math.max(options.timeoutMs, 120_000),
      });
      if (!existsSync(installedBin)) {
        throw new Error(`installed formal CLI bin is missing: ${installedBin}`);
      }
      if (!outsideSource(installedBin)) {
        throw new Error(`installed CLI is inside the source tree: ${installedBin}`);
      }
      const installedPackageJson = join(packageRoot, 'package.json');
      if (!existsSync(installedPackageJson)) {
        throw new Error(
          `installed CLI package manifest is missing: ${installedPackageJson}`,
        );
      }
      return {
        prefix,
        packageRoot,
        installedBin,
        outsideSource: true,
        ...outputDetail(result),
      };
    });

    await runCheck('installed-formal-bin', async () => {
      const version = runFormalCli(
        installedBin,
        ['--version'],
        outside,
        env,
      );
      const expectedVersion = `zterm ${packageManifest.version}`;
      if (version.stdout.trim() !== expectedVersion) {
        throw new Error(
          `installed bin version mismatch: ${JSON.stringify(version.stdout.trim())}`,
        );
      }
      const help = runFormalCli(installedBin, ['--help'], outside, env);
      if (!help.stdout.includes('zterm daemon install')) {
        throw new Error('installed bin help is missing daemon install');
      }
      const slots = runFormalCli(
        installedBin,
        ['slot', 'list'],
        outside,
        env,
      );
      return {
        cwd: outside,
        version: version.stdout.trim(),
        helpHasDaemonManagement: true,
        emptySlotListExit: slots.exitCode,
        sourceBinUsed: false,
      };
    });

    const installedPackageJson = join(packageRoot, 'package.json');
    await runCheck('wrtc-native-datachannel', async () => (
      runWrtcSmoke(
        installedPackageJson,
        Math.max(options.timeoutMs, 15_000),
      )
    ));

    await runCheck('node-pty-conpty-roundtrip', async () => (
      runPtySmoke(
        sandboxRoot,
        Math.max(options.timeoutMs, 15_000),
        daemonPackageRoot,
      )
    ));

    if (daemonPackageRoot) {
      await runCheck('daemon-platform-payload-readonly', async () => (
        runDaemonPayloadReadOnly(
          daemonPackageRoot,
          sandboxRoot,
          env,
          Math.max(options.timeoutMs, 30_000),
        )
      ));
    } else {
      checks.push({
        name: 'daemon-platform-payload-readonly',
        status: 'not-run',
        durationMs: 0,
        reason: 'daemon platform package root was not provided',
        requiredInput: '--daemon-package-root <dir>',
      });
    }

    const daemonNativePath = options.daemonNativePath
      || (daemonPackageRoot
        ? join(daemonPackageRoot, 'runtime', 'dagpipe.node')
        : undefined)
      || join(androidDir, 'native', 'dagpipe', 'index.node');
    if (existsSync(daemonNativePath)) {
      await runCheck('dagpipe-native-load', async () => (
        loadDaemonNative(daemonNativePath)
      ));
    } else {
      checks.push({
        name: 'dagpipe-native-load',
        status: 'not-run',
        durationMs: 0,
        reason:
          'DAGpipe native is not staged; pass --daemon-native or build android/native/dagpipe/index.node',
        requiredInput: daemonNativePath,
      });
    }

    return 0;
  } catch (error) {
    return {
      exitCode: 1,
      error: redactText(errorMessage(error), secrets),
    };
  } finally {
    let cleanupOk = !sandboxRoot || !existsSync(sandboxRoot);
    if (sandboxRoot && existsSync(sandboxRoot)) {
      try {
        rmSync(sandboxRoot, { recursive: true, force: true });
        cleanupOk = !existsSync(sandboxRoot);
      } catch {
        cleanupOk = false;
      }
    }
    checks.push({
      name: 'owned-sandbox-cleanup',
      status: cleanupOk ? 'passed' : 'failed',
      durationMs: 0,
      detail: cleanupOk ? { removed: true } : { removed: false },
    });

    const failed = checks.filter((check) => check.status === 'failed');
    const finalState = failed.length === 0 ? 'passed' : 'failed';
    const daemonReadOnlyCheck = checks.find(
      (check) => check.name === 'daemon-platform-payload-readonly',
    );
    const daemonPlatformManagement = !daemonPackageRoot
      ? 'not-run-entry-pending'
      : daemonReadOnlyCheck?.status === 'passed'
        ? 'payload-config-status-passed-install-pending'
        : daemonReadOnlyCheck?.status === 'failed'
          ? 'failed'
          : 'not-run-after-earlier-failure';
    const summary = sanitizeValue({
      schemaVersion: 1,
      state: finalState,
      coverage: {
        cliComponents: finalState,
        linuxMacFullUserPath: 'not-run-by-platform-smoke',
        windowsRemoteUserPath: 'unverified-input-required',
        daemonPlatformManagement,
      },
      host: {
        platform: process.platform,
        arch: process.arch,
        tuple,
        node: process.versions.node,
        npm: process.env.npm_config_user_agent || 'not-reported',
      },
      startedAt,
      finishedAt: isoNow(),
      durationMs: Date.now() - Date.parse(startedAt),
      checks,
      artifacts,
      remainingInputs: {
        fullUnixUserPath:
          'Run the existing android/scripts/cli-blackbox.ts harness with a built DAGpipe native and tmux.',
        windowsRemoteUserPath:
          'Provide a reachable Unix daemon plus test identity receipt; do not reuse WSL as the Windows client.',
        daemonPlatformManagement:
          'Provide the platform package directory and verified staging entry; install verification remains pending the launcher package entry.',
      },
      evidencePath: summaryPath,
    }, secrets);
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (finalState !== 'passed') return 1;
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
    .then((result) => {
      process.exitCode = typeof result === 'number' ? result : result.exitCode;
      if (result && typeof result === 'object' && result.error) {
        process.stderr.write(`${result.error}\n`);
      }
    })
    .catch((error) => {
      process.stderr.write(`${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
