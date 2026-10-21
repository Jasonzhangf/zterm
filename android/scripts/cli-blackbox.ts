import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import {
  AccountClient,
  type AuthenticatedAccount,
} from '../../packages/cli/src/account-client.js';
import {
  CliBlackboxPtyShell,
  shellQuote,
  type CliBlackboxPtyRuntime,
} from './cli-blackbox-pty.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const androidDir = dirname(scriptDir);
const repoRoot = dirname(androidDir);
const defaultDaemonEntry = join(androidDir, 'src', 'server', 'server.ts');
const defaultRelayEntry = join(androidDir, 'src', 'traversal-relay', 'server.ts');
const cliPackageDir = join(repoRoot, 'packages', 'cli');
const defaultCliBin = join(repoRoot, 'packages', 'cli', 'bin', 'zterm.mjs');
const defaultCliMain = join(repoRoot, 'packages', 'cli', 'src', 'main.ts');
const tmuxWrapperPath = join(scriptDir, 'cli-blackbox-tmux-wrapper.mjs');
const tsxPackagePath = join(androidDir, 'node_modules', 'tsx', 'package.json');
const ephemeralHost = '127.0.0.1';
const installedDagpipeNative = join(homedir(), '.zterm', 'daemon-runtime', 'dagpipe.node');
const moduleRequire = createRequire(import.meta.url);

type NodePtyModule = typeof import('node-pty');

export interface CliBlackboxHarnessOptions {
  daemonEntry?: string;
  relayEntry?: string;
  cliBin?: string;
  dagpipeNativePath?: string;
  evidenceDir?: string;
  cliTarballPath?: string;
  npmRegistryUrl?: string;
  timeoutMs?: number;
}

export type CliBlackboxStageStatus = 'passed' | 'failed' | 'not-run';
export type CliBlackboxState =
  | 'prepared'
  | 'incomplete'
  | 'failed'
  | 'full-user-path-passed';

export const FULL_CLI_USER_PATH_STAGES = [
  'cli-login',
  'cli-slot-set',
  'cli-slot-numbered-mirror',
  'cli-remote-input',
  'cli-resize',
  'cli-local-exit-restore',
  'cli-stale-identity-rejected',
  'cli-logout',
  'cli-post-logout-connection-rejected',
] as const;

export type FullCliUserPathStage = typeof FULL_CLI_USER_PATH_STAGES[number];

export interface CliBlackboxStageResult {
  stage: string;
  status: CliBlackboxStageStatus;
  startedAt: string;
  durationMs: number;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface CliBlackboxHarnessResult {
  ok: boolean;
  state: CliBlackboxState;
  error?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stages: CliBlackboxStageResult[];
  gaps: string[];
  resources: {
    testPrefix: string;
    relay: {
      endpoint?: string;
      pid?: number;
      dataDir: string;
    };
    daemon: {
      endpoint?: string;
      pid?: number;
      entry: string;
      dagpipeNative: string;
      tmuxSocketPath: string;
    };
    tmux: {
      binary: string;
      socketPath: string;
      sessionName: string;
    };
    cli: {
      binPath: string;
      installedBinPath?: string;
      npmPrefix: string;
      ptyPid?: number;
    };
  };
  cleanup: {
    cleaned: boolean;
    sessionCommand: string;
    sessionRemoved: boolean;
    socketRemoved: boolean;
    processes: Array<{
      label: string;
      pid: number;
      stopped: boolean;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    }>;
    tempRootRemoved: boolean;
    tmuxAudit: {
      logPath: string;
      entryCount: number;
      allowedCount: number;
      rejectedCount: number;
      failedCount: number;
      commands: string[];
      allowedCommands: string[];
      rejectedCommands: string[];
      rejectedCalls: string[][];
    };
  };
}

export function deriveCliBlackboxOutcome(options: {
  stages: readonly Pick<CliBlackboxStageResult, 'stage' | 'status' | 'error'>[];
  cleanup: { cleaned: boolean };
  formalEntryExists: boolean;
}): Pick<CliBlackboxHarnessResult, 'ok' | 'state'> & { gaps: string[] } {
  const gaps: string[] = [];
  const failed = options.stages.filter((stage) => stage.status === 'failed');
  if (failed.length > 0) {
    for (const stage of failed) {
      gaps.push(
        `${stage.stage} failed${stage.error ? `: ${stage.error}` : ''}`,
      );
    }
    return { ok: false, state: 'failed', gaps };
  }
  if (!options.cleanup.cleaned) {
    return {
      ok: false,
      state: 'failed',
      gaps: ['owned harness resources were not fully cleaned'],
    };
  }

  if (!options.formalEntryExists) {
    gaps.push(`full-cli-user-path not run: formal CLI composition entry is missing (${defaultCliMain})`);
  }
  for (const required of FULL_CLI_USER_PATH_STAGES) {
    const stage = options.stages.find((candidate) => candidate.stage === required);
    if (!stage) {
      gaps.push(`full-cli-user-path incomplete: required stage did not run (${required})`);
      continue;
    }
    if (stage.status !== 'passed') {
      gaps.push(`full-cli-user-path incomplete: required stage is ${stage.status} (${required})`);
    }
  }

  if (gaps.length > 0) {
    return { ok: false, state: 'incomplete', gaps };
  }
  return {
    ok: true,
    state: 'full-user-path-passed',
    gaps: [],
  };
}

interface CapturedChild {
  child: ChildProcess;
  lines: string[];
  command: string;
}

interface MuxFrame {
  type?: string;
  payload?: {
    requestId?: string;
    channelId?: string;
    message?: {
      type?: string;
      payload?: Record<string, unknown>;
    };
    reason?: string;
    code?: string;
  };
}

interface EventEmitterLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

function eventsOf(value: unknown) {
  return value as unknown as EventEmitterLike;
}

class MuxProbe {
  private readonly frames: MuxFrame[] = [];
  private readonly waiters = new Set<{
    predicate: (frame: MuxFrame) => boolean;
    resolve: (frame: MuxFrame) => void;
  }>();
  private closeError: Error | null = null;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      let frame: MuxFrame;
      try {
        frame = JSON.parse(raw.toString()) as MuxFrame;
      } catch (error) {
        this.closeError = error instanceof Error ? error : new Error(String(error));
        return;
      }
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) {
        if (
          frame.type !== 'mux-error'
          && frame.type !== 'mux-channel-closed'
          && !waiter.predicate(frame)
        ) {
          continue;
        }
        this.waiters.delete(waiter);
        waiter.resolve(frame);
      }
    });
    socket.on('error', (error) => {
      this.closeError = error;
    });
    socket.on('close', (code, reason) => {
      this.closeError = new Error(
        `daemon mux socket closed (${code}): ${reason.toString() || 'no reason'}`,
      );
      for (const waiter of this.waiters) {
        waiter.resolve({
          type: 'mux-error',
          payload: { code: 'websocket_closed', reason: this.closeError.message },
        });
      }
      this.waiters.clear();
    });
  }

  static async connect(url: string, timeoutMs: number) {
    const socket = new WebSocket(url);
    const probe = new MuxProbe(socket);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error('daemon mux websocket open timeout')), timeoutMs);
      socket.once('open', () => {
        clearTimeout(timer);
        resolveOpen();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        rejectOpen(error);
      });
    });
    return probe;
  }

  send(frame: Record<string, unknown>) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('daemon mux socket is not open');
    }
    this.socket.send(JSON.stringify(frame));
  }

  async waitFor(
    predicate: (frame: MuxFrame) => boolean,
    label: string,
    timeoutMs: number,
    afterIndex = 0,
  ): Promise<MuxFrame> {
    const existing = this.frames.slice(afterIndex).find(predicate);
    if (existing) {
      return existing;
    }
    const existingFailure = this.frames
      .slice(afterIndex)
      .find((frame) => frame.type === 'mux-error' || frame.type === 'mux-channel-closed');
    if (existingFailure) {
      throw new Error(`${label} failed: ${JSON.stringify(existingFailure)}`);
    }
    if (this.closeError) {
      throw this.closeError;
    }
    return await new Promise<MuxFrame>((resolveFrame, rejectFrame) => {
      const waiter = {
        predicate,
        resolve: (frame: MuxFrame) => resolveFrame(frame),
      };
      this.waiters.add(waiter);
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        rejectFrame(new Error(`${label} timeout`));
      }, timeoutMs);
      const settle = (frame: MuxFrame) => {
        clearTimeout(timer);
        if (frame.type === 'mux-error' || frame.type === 'mux-channel-closed') {
          rejectFrame(new Error(`${label} failed: ${JSON.stringify(frame)}`));
          return;
        }
        resolveFrame(frame);
      };
      waiter.resolve = settle;
    });
  }

  frameCount() {
    return this.frames.length;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // The socket may already be closed.
    }
  }
}

function isoNow() {
  return new Date().toISOString();
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function redactText(value: string, secrets: string[]) {
  let result = value;
  for (const secret of secrets) {
    if (secret) {
      result = result.split(secret).join('[redacted]');
    }
  }
  return result;
}

function captureChild(child: ChildProcess) {
  const lines: string[] = [];
  const capture = (chunk: Buffer | string) => {
    const normalized = String(chunk);
    for (const line of normalized.split(/\r?\n/u)) {
      if (!line.trim()) {
        continue;
      }
      lines.push(line);
      if (lines.length > 160) {
        lines.shift();
      }
    }
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  return lines;
}

function spawnCaptured(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
): CapturedChild {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = captureChild(child);
  eventsOf(child).on('error', (error: Error) => {
    lines.push(`spawn error: ${error.message}`);
  });
  return {
    child,
    lines,
    command: [command, ...args].join(' '),
  };
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectExit(new Error(`process ${child.pid || 'unknown'} exit timeout`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      eventsOf(child).off('exit', onExit);
      eventsOf(child).off('error', onError);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolveExit({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      rejectExit(error);
    };
    eventsOf(child).once('exit', onExit);
    eventsOf(child).once('error', onError);
  });
}

async function stopOwnedChild(
  label: string,
  child: ChildProcess | null,
  timeoutMs: number,
): Promise<{
  label: string;
  pid: number;
  stopped: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}> {
  if (!child || !child.pid) {
    return { label, pid: 0, stopped: true };
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      label,
      pid: child.pid,
      stopped: true,
      exitCode: child.exitCode,
      signal: child.signalCode,
    };
  }
  child.kill('SIGTERM');
  try {
    const exit = await waitForExit(child, timeoutMs);
    return {
      label,
      pid: child.pid,
      stopped: true,
      exitCode: exit.code,
      signal: exit.signal,
    };
  } catch {
    child.kill('SIGKILL');
    try {
      const exit = await waitForExit(child, 3000);
      return {
        label,
        pid: child.pid,
        stopped: true,
        exitCode: exit.code,
        signal: exit.signal,
      };
    } catch {
      return { label, pid: child.pid, stopped: false };
    }
  }
}

function childEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      value === undefined
      || key === 'TMUX'
      || key === 'TMUX_PANE'
      || key === 'TMUX_TMPDIR'
      || key.startsWith('ZTERM_')
    ) {
      continue;
    }
    env[key] = value;
  }
  return {
    ...env,
    ...overrides,
  };
}

async function prepareIsolatedNodePty(testPrefix: string): Promise<{
  source: string;
  module: NodePtyModule;
  entry: string;
  helper: string | null;
  helperMode: string | null;
}> {
  const { resolveNodePtyInstallation } = await import(pathToFileURL(
    join(repoRoot, 'packages', 'cli', 'scripts', 'platform-smoke-helper.mjs'),
  ).href);
  const installation = resolveNodePtyInstallation(join(androidDir, 'package.json'));
  const nodePtyPackageDir = installation.packageRoot as string;
  const isolatedDir = join(testPrefix, 'node-pty');
  cpSync(
    join(nodePtyPackageDir, 'lib'),
    join(isolatedDir, 'lib'),
    { recursive: true },
  );
  cpSync(
    join(nodePtyPackageDir, dirname(installation.ptyNativeRelativePath)),
    join(isolatedDir, dirname(installation.ptyNativeRelativePath)),
    { recursive: true },
  );
  const helper = process.platform === 'darwin'
    ? join(isolatedDir, installation.spawnHelperRelativePath)
    : null;
  if (helper) {
    chmodSync(helper, 0o755);
  }
  const entry = join(isolatedDir, 'lib', 'index.js');
  return {
    source: nodePtyPackageDir,
    module: moduleRequire(entry) as NodePtyModule,
    entry,
    helper,
    helperMode: helper ? statSync(helper).mode.toString(8).slice(-3) : null,
  };
}

function summarizeTmuxAudit(logPath: string) {
  const summary = {
    logPath,
    entryCount: 0,
    allowedCount: 0,
    rejectedCount: 0,
    failedCount: 0,
    commands: [] as string[],
    allowedCommands: [] as string[],
    rejectedCommands: [] as string[],
    rejectedCalls: [] as string[][],
  };
  if (!existsSync(logPath)) {
    return summary;
  }
  const commands = new Set<string>();
  const allowedCommands = new Set<string>();
  const rejectedCommands = new Set<string>();
  const rejectedCalls = new Map<string, string[]>();
  for (const line of readFileSync(logPath, 'utf8').split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    let entry: { status?: string; args?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      summary.failedCount += 1;
      continue;
    }
    summary.entryCount += 1;
    if (entry.status === 'allowed') {
      summary.allowedCount += 1;
      if (Array.isArray(entry.args) && typeof entry.args[0] === 'string') {
        allowedCommands.add(entry.args[0]);
      }
    } else if (entry.status === 'rejected') {
      summary.rejectedCount += 1;
      if (Array.isArray(entry.args)) {
        const args = entry.args.filter((arg): arg is string => typeof arg === 'string');
        if (args[0]) {
          rejectedCommands.add(args[0]);
        }
        rejectedCalls.set(JSON.stringify(args), args);
      }
    } else {
      summary.failedCount += 1;
    }
    if (Array.isArray(entry.args) && typeof entry.args[0] === 'string') {
      commands.add(entry.args[0]);
    }
  }
  summary.commands = [...commands].sort();
  summary.allowedCommands = [...allowedCommands].sort();
  summary.rejectedCommands = [...rejectedCommands].sort();
  summary.rejectedCalls = [...rejectedCalls.values()];
  return summary;
}

function findAvailablePort() {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    eventsOf(server).once('error', rejectPort);
    server.listen(0, ephemeralHost, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => rejectPort(new Error('failed to resolve ephemeral port')));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function waitForJson(
  url: string,
  label: string,
  child: ChildProcess,
  lines: string[],
  secrets: string[],
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `${label} exited before health check: ${redactText(lines.slice(-12).join('\n'), secrets)}`,
      );
    }
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', connection: 'close' },
        signal: AbortSignal.timeout(Math.min(1500, Math.max(250, deadline - Date.now()))),
      });
      const body = await response.json() as Record<string, unknown>;
      if (response.ok) {
        return body;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = messageOf(error);
    }
    await delay(120);
  }
  throw new Error(
    `${label} health timeout: ${lastError}; log=${redactText(lines.slice(-12).join('\n'), secrets)}`,
  );
}

function resolveTmuxBinary() {
  const candidates = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-V'], { encoding: 'utf8' });
    if (probe.status === 0) {
      return {
        binary: candidate,
        version: probe.stdout.trim(),
      };
    }
  }
  const probe = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  if (probe.status === 0) {
    const resolved = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim();
    return {
      binary: resolved,
      version: probe.stdout.trim(),
    };
  }
  throw new Error('tmux is not available');
}

function directTmux(
  binary: string,
  socketPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  return execFileSync(binary, ['-S', socketPath, ...args], {
    encoding: 'utf8',
    env,
  });
}

async function waitForMarker(
  binary: string,
  socketPath: string,
  sessionName: string,
  marker: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let lastCapture = '';
  while (Date.now() < deadline) {
    lastCapture = directTmux(
      binary,
      socketPath,
      ['capture-pane', '-p', '-t', `=${sessionName}:.{top-left}`],
      env,
    );
    if (lastCapture.includes(marker)) {
      return lastCapture;
    }
    await delay(100);
  }
  throw new Error(`owned tmux marker timeout: ${JSON.stringify(lastCapture.slice(-500))}`);
}

async function registerAccount(
  relayBaseUrl: string,
  username: string,
  password: string,
  secrets: string[],
) {
  let response: Response;
  try {
    response = await fetch(`${relayBaseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(`relay register request failed: ${messageOf(error)}`);
  }
  const body = await response.json().catch((error) => {
    throw new Error(`relay register returned invalid JSON: ${messageOf(error)}`);
  }) as Record<string, unknown>;
  if (!response.ok || body.ok !== true) {
    throw new Error(
      `relay register failed: HTTP ${response.status} ${redactText(JSON.stringify(body), secrets)}`,
    );
  }
}

async function waitForDirectory(
  client: AccountClient,
  auth: AuthenticatedAccount,
  expectedHostId: string,
  expectedSession: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = '';
  while (Date.now() < deadline) {
    const directory = await client.directory(auth, AbortSignal.timeout(5000));
    lastSnapshot = JSON.stringify(directory);
    const host = directory.devices.find((device) => device.daemon?.hostId === expectedHostId)?.daemon;
    if (
      host?.presence.connected === true
      && host.sessions.some((session) => session.name === expectedSession)
    ) {
      return directory;
    }
    await delay(250);
  }
  throw new Error(`relay directory did not publish owned daemon/session: ${lastSnapshot}`);
}

function requireCommandSuccess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
  },
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: status=${String(result.status)} `
      + `${result.error?.message || result.stderr || result.stdout || 'no output'}`,
    );
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

function writeIsolatedCliConfig(options: {
  home: string;
  relayEndpoint: string;
  username: string;
  password: string;
  daemonPort: number;
  daemonAuthToken: string;
  deviceId: string;
}) {
  const configDir = join(options.home, '.zterm');
  const configPath = join(configDir, 'config.json');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({
      zterm: {
        android: {
          daemon: {
            host: ephemeralHost,
            port: options.daemonPort,
            authToken: options.daemonAuthToken,
            unknownDaemonField: 'preserve-daemon-field',
          },
        },
        cli: {
          server: { relayBaseUrl: options.relayEndpoint },
          loginInput: {
            username: options.username,
            password: options.password,
          },
          identity: {
            deviceId: options.deviceId,
            deviceName: 'cli-blackbox-client',
          },
          unknownCliField: 'preserve-cli-field',
        },
        unknownZtermField: 'preserve-zterm-field',
      },
      mobile: {
        relay: {
          password: 'preserve-mobile-relay-secret',
        },
        unknownMobileField: 'preserve-mobile-field',
      },
      unknownRootField: 'preserve-root-field',
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return configPath;
}

function readJsonObject(path: string) {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config is not a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function objectAt(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

function cliConfigSections(config: Record<string, unknown>) {
  const zterm = objectAt(config.zterm, 'zterm');
  const cli = objectAt(zterm.cli, 'zterm.cli');
  return { config, zterm, cli };
}

function readCliAuth(configPath: string) {
  const config = readJsonObject(configPath);
  const { cli } = cliConfigSections(config);
  if (!existsSync(configPath)) {
    throw new Error(`shared config is missing after login: ${configPath}`);
  }
  if (!cli.auth || typeof cli.auth !== 'object' || Array.isArray(cli.auth)) {
    throw new Error(
      `zterm.cli.auth is not an object after login: config=${configPath} `
      + `cliKeys=${JSON.stringify(Object.keys(cli).sort())} `
      + `authType=${Array.isArray(cli.auth) ? 'array' : typeof cli.auth}`,
    );
  }
  const auth = cli.auth as Record<string, unknown>;
  return {
    config,
    auth: {
      loginId: stringAt(auth.loginId, 'zterm.cli.auth.loginId'),
      userId: stringAt(auth.userId, 'zterm.cli.auth.userId'),
      username: stringAt(auth.username, 'zterm.cli.auth.username'),
      accessToken: stringAt(auth.accessToken, 'zterm.cli.auth.accessToken'),
    },
  };
}

function readCliSlot(configPath: string, slot: number) {
  const config = readJsonObject(configPath);
  const { cli } = cliConfigSections(config);
  const slots = objectAt(cli.slots, 'zterm.cli.slots');
  const binding = objectAt(slots[String(slot)], `zterm.cli.slots.${slot}`);
  const session = objectAt(binding.session, `zterm.cli.slots.${slot}.session`);
  const server = objectAt(binding.server, `zterm.cli.slots.${slot}.server`);
  const account = objectAt(binding.account, `zterm.cli.slots.${slot}.account`);
  return {
    config,
    binding,
    session: {
      name: stringAt(session.name, `zterm.cli.slots.${slot}.session.name`),
      backend: stringAt(session.backend, `zterm.cli.slots.${slot}.session.backend`),
      stableId: stringAt(session.stableId, `zterm.cli.slots.${slot}.session.stableId`),
    },
    server: {
      deviceId: stringAt(server.deviceId, `zterm.cli.slots.${slot}.server.deviceId`),
      daemonHostId: stringAt(
        server.daemonHostId,
        `zterm.cli.slots.${slot}.server.daemonHostId`,
      ),
    },
    account: {
      userId: stringAt(account.userId, `zterm.cli.slots.${slot}.account.userId`),
    },
    widthMode: stringAt(binding.widthMode, `zterm.cli.slots.${slot}.widthMode`),
  };
}

function assertPreservedCliConfig(
  configPath: string,
  expectedRelayUrl: string,
  expectedDaemonPort: number,
) {
  const config = readJsonObject(configPath);
  const { zterm } = cliConfigSections(config);
  const android = objectAt(zterm.android, 'zterm.android');
  const daemon = objectAt(android.daemon, 'zterm.android.daemon');
  const cli = objectAt(zterm.cli, 'zterm.cli');
  const server = objectAt(cli.server, 'zterm.cli.server');
  const mobile = objectAt(config.mobile, 'mobile');
  const relay = objectAt(mobile.relay, 'mobile.relay');
  if (stringAt(server.relayBaseUrl, 'zterm.cli.server.relayBaseUrl') !== expectedRelayUrl) {
    throw new Error('CLI relay server changed unexpectedly');
  }
  if (daemon.port !== expectedDaemonPort) {
    throw new Error('shared daemon port changed unexpectedly');
  }
  if (daemon.unknownDaemonField !== 'preserve-daemon-field') {
    throw new Error('unknown daemon config field was lost');
  }
  if (cli.unknownCliField !== 'preserve-cli-field') {
    throw new Error('unknown CLI config field was lost');
  }
  if (zterm.unknownZtermField !== 'preserve-zterm-field') {
    throw new Error('unknown zterm config field was lost');
  }
  if (relay.password !== 'preserve-mobile-relay-secret') {
    throw new Error('mobile relay config changed unexpectedly');
  }
  if (mobile.unknownMobileField !== 'preserve-mobile-field') {
    throw new Error('unknown mobile config field was lost');
  }
  if (config.unknownRootField !== 'preserve-root-field') {
    throw new Error('unknown root config field was lost');
  }
}

function linesInFile(path: string) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean);
}

function auditEntriesSince(path: string, offset: number) {
  return linesInFile(path).slice(offset).flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { status?: unknown; args?: unknown };
      return [entry];
    } catch {
      return [];
    }
  });
}

function tmuxPaneWidth(
  binary: string,
  socketPath: string,
  sessionName: string,
  env: NodeJS.ProcessEnv,
) {
  return Number(directTmux(
    binary,
    socketPath,
    ['display-message', '-p', '-t', `=${sessionName}:.{top-left}`, '#{pane_width}'],
    env,
  ).trim());
}

async function waitForTmuxWidth(options: {
  binary: string;
  socketPath: string;
  sessionName: string;
  env: NodeJS.ProcessEnv;
  expected: number;
  timeoutMs: number;
}) {
  const deadline = Date.now() + options.timeoutMs;
  let observed = 0;
  while (Date.now() < deadline) {
    observed = tmuxPaneWidth(
      options.binary,
      options.socketPath,
      options.sessionName,
      options.env,
    );
    if (observed === options.expected) return observed;
    await delay(80);
  }
  throw new Error(
    `tmux pane width did not become ${options.expected}; observed ${observed}`,
  );
}

function sanitizedEvidence(options: {
  evidenceDir?: string;
  transcript: string;
  secrets: string[];
  result: CliBlackboxHarnessResult;
}) {
  if (!options.evidenceDir) return;
  mkdirSync(options.evidenceDir, { recursive: true });
  const safeTranscript = redactText(options.transcript, options.secrets);
  writeFileSync(
    join(options.evidenceDir, 'cli-blackbox-pty-transcript.log'),
    safeTranscript,
    { mode: 0o600 },
  );
  writeFileSync(
    join(options.evidenceDir, 'cli-blackbox-result.json'),
    `${JSON.stringify(options.result, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function runCliPty(
  ptyRuntime: NodePtyModule,
  cliBin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  onSpawn: (pid: number) => void,
  args: string[] = ['--version'],
) {
  let output = '';
  const terminal = ptyRuntime.spawn(process.execPath, [cliBin, ...args], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: repoRoot,
    env,
  });
  onSpawn(terminal.pid);
  let exit: { exitCode: number; signal?: number };
  try {
    exit = await new Promise<{ exitCode: number; signal?: number }>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        rejectExit(new Error('CLI PTY timeout'));
      }, timeoutMs);
      terminal.onData((chunk) => {
        output += chunk;
      });
      terminal.onExit((event) => {
        clearTimeout(timer);
        resolveExit(event);
      });
    });
  } catch (error) {
    try {
      terminal.kill();
    } catch {
      // The PTY may already be gone.
    }
    throw error;
  }
  if (exit.exitCode !== 0) {
    throw new Error(`CLI PTY exited ${exit.exitCode}: ${JSON.stringify(output)}`);
  }
  const normalized = output.replace(/\r/g, '').trim();
  if (!normalized.startsWith('zterm ')) {
    throw new Error(`CLI PTY returned unexpected output: ${JSON.stringify(normalized)}`);
  }
  return {
    pid: terminal.pid,
    exitCode: exit.exitCode,
    output: normalized,
  };
}

export async function runCliBlackboxHarness(
  options: CliBlackboxHarnessOptions = {},
): Promise<CliBlackboxHarnessResult> {
  const startedAt = isoNow();
  const startedAtMs = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const daemonEntry = resolve(options.daemonEntry || defaultDaemonEntry);
  const relayEntry = resolve(options.relayEntry || defaultRelayEntry);
  const cliBin = resolve(options.cliBin || defaultCliBin);
  const dagpipeNative = resolve(options.dagpipeNativePath || installedDagpipeNative);
  const formalEntryExists = existsSync(defaultCliMain);
  const testPrefix = mkdtempSync(join(tmpdir(), 'zterm-cli-blackbox-'));
  const testHome = join(testPrefix, 'home');
  const testTmp = join(testPrefix, 'tmp');
  const npmGlobalPrefix = join(testPrefix, 'npm-global');
  const packageTarballDir = join(testPrefix, 'package');
  const relayDataDir = join(testPrefix, 'relay-data');
  const relayUpdatesDir = join(testPrefix, 'relay-updates');
  mkdirSync(testHome, { recursive: true });
  mkdirSync(testTmp, { recursive: true });
  mkdirSync(npmGlobalPrefix, { recursive: true });
  mkdirSync(packageTarballDir, { recursive: true });
  mkdirSync(relayDataDir, { recursive: true });
  mkdirSync(relayUpdatesDir, { recursive: true });

  const runToken = randomUUID();
  const sessionName = `cli-blackbox-${Date.now()}-${runToken.slice(0, 8)}`;
  const socketPath = join(testPrefix, 'tmux.sock');
  const wrapperAuditLog = join(testPrefix, 'tmux-wrapper-audit.log');
  const marker = `CLI_BLACKBOX_MARKER_${runToken}`;
  const relayUsername = `cli-blackbox-${runToken.slice(0, 12)}`;
  const relayPassword = randomUUID();
  const daemonAuthToken = randomUUID();
  const relayHostId = `cli-blackbox-host-${runToken.slice(0, 8)}`;
  const relayDeviceId = `cli-blackbox-device-${runToken.slice(0, 8)}`;
  const secrets: string[] = [relayPassword, daemonAuthToken];
  const stages: CliBlackboxStageResult[] = [];
  const gaps: string[] = [];

  let relayProc: CapturedChild | null = null;
  let daemonProc: CapturedChild | null = null;
  let muxProbe: MuxProbe | null = null;
  let accountClient: AccountClient | null = null;
  let accountAuth: AuthenticatedAccount | null = null;
  let cliShell: CliBlackboxPtyShell | null = null;
  let tmuxBinary = '';
  let relayEndpoint = '';
  let daemonEndpoint = '';
  let cliConfigPath = '';
  let installedCliBin = cliBin;
  let cliTarballPath = options.cliTarballPath
    ? resolve(options.cliTarballPath)
    : undefined;
  let cliTranscript = '';
  let sessionCreated = false;
  let failure: string | null = null;
  let cliPtyPid: number | undefined;
  let ptyRuntime: NodePtyModule | null = null;
  let sessionRemoved = false;
  let socketRemoved = false;
  let tempRootRemoved = false;
  let tmuxAudit = summarizeTmuxAudit(wrapperAuditLog);
  const processCleanup: CliBlackboxHarnessResult['cleanup']['processes'] = [];

  const runStage = async (
    stage: string,
    action: () => Promise<Record<string, unknown>> | Record<string, unknown>,
  ) => {
    const stageStartedAt = isoNow();
    const stageStartedAtMs = Date.now();
    try {
      const detail = await action();
      stages.push({
        stage,
        status: 'passed',
        startedAt: stageStartedAt,
        durationMs: Date.now() - stageStartedAtMs,
        detail,
      });
      return detail;
    } catch (error) {
      stages.push({
        stage,
        status: 'failed',
        startedAt: stageStartedAt,
        durationMs: Date.now() - stageStartedAtMs,
        error: redactText(messageOf(error), secrets),
      });
      throw error;
    }
  };

  try {
    await runStage('preflight', async () => {
      const tmux = resolveTmuxBinary();
      tmuxBinary = tmux.binary;
      const isolatedPty = await prepareIsolatedNodePty(testPrefix);
      ptyRuntime = isolatedPty.module;
      if (!existsSync(tsxPackagePath)) throw new Error(`tsx package missing: ${tsxPackagePath}`);
      if (!existsSync(tmuxWrapperPath)) throw new Error(`tmux wrapper missing: ${tmuxWrapperPath}`);
      if (!existsSync(relayEntry)) throw new Error(`relay entry missing: ${relayEntry}`);
      if (!existsSync(daemonEntry)) throw new Error(`daemon entry missing: ${daemonEntry}`);
      if (!existsSync(cliBin)) throw new Error(`CLI bin missing: ${cliBin}`);
      if (!existsSync(dagpipeNative)) {
        throw new Error(`installed DAGpipe native missing: ${dagpipeNative}`);
      }
      return {
        tmux: tmux.version,
        node: process.version,
        tsxPackagePath,
        relayEntry,
        daemonEntry,
        cliBin,
        formalEntryExists,
        npmGlobalPrefix,
        dagpipeNative,
        nodePty: {
          source: isolatedPty.source,
          entry: isolatedPty.entry,
          helper: isolatedPty.helper,
          helperMode: isolatedPty.helperMode,
        },
      };
    });

    await runStage('owned-tmux-session', async () => {
      const env = childEnv(process.env, {
        HOME: testHome,
        TMPDIR: testTmp,
        TERM: 'xterm-256color',
      });
      directTmux(
        tmuxBinary,
        socketPath,
        [
          'new-session',
          '-d',
          '-s',
          sessionName,
          '-x',
          '80',
          '-y',
          '24',
          'sh',
          '-lc',
          `printf '%s\\n' '${marker}'; exec cat`,
        ],
        env,
      );
      sessionCreated = true;
      const sessions = directTmux(
        tmuxBinary,
        socketPath,
        ['list-sessions', '-F', '#{session_name}'],
        env,
      ).trim().split(/\r?\n/u).filter(Boolean);
      if (!sessions.includes(sessionName)) {
        throw new Error(`owned session missing after creation: ${JSON.stringify(sessions)}`);
      }
      const capture = await waitForMarker(
        tmuxBinary,
        socketPath,
        sessionName,
        marker,
        env,
        5000,
      );
      return {
        socketPath,
        sessionName,
        sessions,
        markerObserved: capture.includes(marker),
      };
    });

    const relayPort = await findAvailablePort();
    relayEndpoint = `http://${ephemeralHost}:${relayPort}`;
    const cliRelayBaseUrl = `${relayEndpoint}/`;
    const relayEnv = childEnv(process.env, {
      HOME: testHome,
      TMPDIR: testTmp,
      ZTERM_TRAVERSAL_HOST: ephemeralHost,
      ZTERM_TRAVERSAL_PORT: String(relayPort),
      ZTERM_TRAVERSAL_BASE_PATH: '',
      ZTERM_TRAVERSAL_DATA_DIR: relayDataDir,
      ZTERM_TRAVERSAL_UPDATES_DIR: relayUpdatesDir,
    });
    relayProc = spawnCaptured(process.execPath, ['--import', 'tsx', relayEntry], {
      cwd: androidDir,
      env: relayEnv,
    });
    await runStage('relay-start', async () => {
      const health = await waitForJson(
        `${relayEndpoint}/health`,
        'relay',
        relayProc!.child,
        relayProc!.lines,
        secrets,
        timeoutMs,
      );
      return {
        endpoint: relayEndpoint,
        pid: relayProc!.child.pid,
        healthOk: health.ok === true,
        dataDir: relayDataDir,
      };
    });

    await runStage('relay-account-contract', async () => {
      await registerAccount(relayEndpoint, relayUsername, relayPassword, secrets);
      accountClient = new AccountClient();
      accountAuth = await accountClient.login(
        {
          relayBaseUrl: relayEndpoint,
          username: relayUsername,
          password: relayPassword,
        },
        AbortSignal.timeout(10_000),
      );
      const me = await accountClient.me(accountAuth, AbortSignal.timeout(10_000));
      const directory = await accountClient.directory(accountAuth, AbortSignal.timeout(10_000));
      return {
        login: true,
        meUserIdMatches: me.user.id === accountAuth.user.id,
        directoryUserIdMatches: directory.user.id === accountAuth.user.id,
        deviceCount: directory.devices.length,
      };
    });

    const daemonPort = await findAvailablePort();
    daemonEndpoint = `http://${ephemeralHost}:${daemonPort}`;
    const daemonBindHost = '0.0.0.0';
    const daemonEnv = childEnv(process.env, {
      HOME: testHome,
      TMPDIR: testTmp,
      ZTERM_HOST: daemonBindHost,
      ZTERM_PORT: String(daemonPort),
      ZTERM_AUTH_TOKEN: daemonAuthToken,
      ZTERM_DAGPIPE_NATIVE: dagpipeNative,
      ZTERM_TERMINAL_BACKEND: 'tmux',
      ZTERM_TMUX_BINARY: tmuxWrapperPath,
      CLI_BLACKBOX_REAL_TMUX: tmuxBinary,
      CLI_BLACKBOX_TMUX_SOCKET: socketPath,
      CLI_BLACKBOX_TMUX_SESSION: sessionName,
      CLI_BLACKBOX_TMUX_AUDIT_LOG: wrapperAuditLog,
      ZTERM_TRAVERSAL_RELAY_URL: relayEndpoint,
      ZTERM_TRAVERSAL_USERNAME: relayUsername,
      ZTERM_TRAVERSAL_PASSWORD: relayPassword,
      ZTERM_TRAVERSAL_HOST_ID: relayHostId,
      ZTERM_TRAVERSAL_DEVICE_ID: relayDeviceId,
      ZTERM_TRAVERSAL_DEVICE_NAME: 'cli-blackbox-daemon',
      ZTERM_TRAVERSAL_PLATFORM: process.platform,
      ZTERM_TRAVERSAL_APP_VERSION: 'cli-blackbox',
      ZTERM_TRAVERSAL_DAEMON_VERSION: 'cli-blackbox-candidate',
    });
    daemonProc = spawnCaptured(process.execPath, ['--import', 'tsx', daemonEntry], {
      cwd: androidDir,
      env: daemonEnv,
    });
    await runStage('daemon-start-and-health', async () => {
      const health = await waitForJson(
        `${daemonEndpoint}/health`,
        'daemon',
        daemonProc!.child,
        daemonProc!.lines,
        secrets,
        timeoutMs,
      );
      if (health.pid !== daemonProc!.child.pid) {
        throw new Error(
          `daemon health pid mismatch: health=${String(health.pid)} child=${String(daemonProc!.child.pid)}`,
        );
      }
      return {
        endpoint: daemonEndpoint,
        pid: daemonProc!.child.pid,
        entry: daemonEntry,
        dagpipeNative,
        runtime: `${process.execPath} --import tsx`,
        tmuxWrapper: tmuxWrapperPath,
        healthPid: health.pid,
        bindHost: daemonBindHost,
      };
    });

    await runStage('isolated-shared-config', async () => {
      cliConfigPath = writeIsolatedCliConfig({
        home: testHome,
        relayEndpoint: cliRelayBaseUrl,
        username: relayUsername,
        password: relayPassword,
        daemonPort,
        daemonAuthToken,
        deviceId: `cli-blackbox-client-${runToken.slice(0, 8)}`,
      });
      assertPreservedCliConfig(cliConfigPath, cliRelayBaseUrl, daemonPort);
      return {
        configPath: cliConfigPath,
        home: testHome,
        daemonPort,
        relayUrlRecorded: true,
        secretsPersistedOnlyInIsolatedHome: true,
      };
    });

    await runStage('relay-daemon-directory', async () => {
      const directory = await waitForDirectory(
        accountClient!,
        accountAuth!,
        relayHostId,
        sessionName,
        timeoutMs,
      );
      const host = directory.devices.find((device) => device.daemon?.hostId === relayHostId)?.daemon;
      return {
        hostConnected: host?.presence.connected === true,
        sessionPublished: host?.sessions.some((session) => session.name === sessionName) === true,
        endpointCount: host?.endpoints.length || 0,
      };
    });

    const muxUrl = `ws://${ephemeralHost}:${daemonPort}/?token=${encodeURIComponent(daemonAuthToken)}`;
    muxProbe = await MuxProbe.connect(muxUrl, timeoutMs);
    muxProbe.send({
      type: 'mux-hello',
      payload: {
        version: 1,
        clientInstanceId: `cli-blackbox-${runToken}`,
      },
    });
    await muxProbe.waitFor(
      (frame) => frame.type === 'mux-ready',
      'mux-ready',
      timeoutMs,
    );

    const listRequestId = `list-${runToken}`;
    muxProbe.send({
      type: 'mux-target-message',
      payload: {
        requestId: listRequestId,
        message: { type: 'list-sessions' },
      },
    });
    const listFrame = await muxProbe.waitFor(
      (frame) =>
        frame.type === 'mux-target-message'
        && frame.payload?.requestId === listRequestId
        && frame.payload?.message?.type === 'sessions',
      'mux list-sessions',
      timeoutMs,
    );
    const listedSessions = Array.isArray(listFrame.payload?.message?.payload?.sessions)
      ? listFrame.payload.message.payload.sessions.map(String)
      : [];
    if (!listedSessions.includes(sessionName)) {
      throw new Error(`mux list-sessions omitted owned session: ${JSON.stringify(listedSessions)}`);
    }
    await runStage('mux-list-sessions', async () => ({
      requestId: listRequestId,
      sessionCount: listedSessions.length,
      ownedSessionVisible: true,
    }));

    const channelId = `cli-blackbox-channel-${runToken.slice(0, 8)}`;
    muxProbe.send({
      type: 'mux-channel-open',
      payload: {
        channelId,
        sessionName,
        cols: 80,
        rows: 24,
        widthMode: 'mirror-fixed',
        bodySubscribed: true,
      },
    });
    await muxProbe.waitFor(
      (frame) =>
        frame.type === 'mux-channel-opened'
        && frame.payload?.channelId === channelId,
      'mux-channel-opened',
      timeoutMs,
    );
    await muxProbe.waitFor(
      (frame) =>
        frame.type === 'mux-channel-message'
        && frame.payload?.channelId === channelId
        && frame.payload?.message?.type === 'connected',
      'initial mux connected',
      timeoutMs,
    );
    const headStartIndex = muxProbe.frameCount();
    muxProbe.send({
      type: 'mux-channel-message',
      payload: {
        channelId,
        message: { type: 'buffer-head-request' },
      },
    });
    const headFrame = await muxProbe.waitFor(
      (frame) =>
        frame.type === 'mux-channel-message'
        && frame.payload?.channelId === channelId
        && frame.payload?.message?.type === 'buffer-head',
      'mux buffer-head',
      timeoutMs,
      headStartIndex,
    );
    const head = headFrame.payload?.message?.payload || {};
    if (typeof head.revision !== 'number' || typeof head.latestEndIndex !== 'number') {
      throw new Error(`mux buffer-head payload invalid: ${JSON.stringify(head)}`);
    }
    if (head.revision < 1 || head.latestEndIndex < 1) {
      throw new Error(`mux mirror did not capture owned tmux content: ${JSON.stringify(head)}`);
    }
    const capture = directTmux(
      tmuxBinary,
      socketPath,
      ['capture-pane', '-p', '-t', `=${sessionName}:.{top-left}`],
      childEnv(process.env, {
        HOME: testHome,
        TMPDIR: testTmp,
        TERM: 'xterm-256color',
      }),
    );
    if (!capture.includes(marker)) {
      throw new Error('owned tmux marker disappeared during mux head probe');
    }
    await runStage('mux-head-and-owned-marker', async () => ({
      channelId,
      revision: head.revision,
      latestEndIndex: head.latestEndIndex,
      initialReadyMessage: 'connected',
      markerObserved: true,
    }));

    if (formalEntryExists) {
      await runStage('isolated-cli-build-install', async () => {
        const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const npmEnv = childEnv(process.env, {
          HOME: testHome,
          TMPDIR: testTmp,
          npm_config_cache: join(homedir(), '.npm'),
          npm_config_prefix: npmGlobalPrefix,
          npm_config_userconfig: join(testPrefix, 'npmrc'),
          npm_config_prefer_offline: 'true',
          npm_config_fetch_retries: '1',
          npm_config_fetch_timeout: '30000',
        });
        const esbuildBin = join(
          cliPackageDir,
          'node_modules',
          '.bin',
          process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild',
        );
        requireCommandSuccess(process.execPath, [join(cliPackageDir, 'scripts', 'build.mjs')], {
          cwd: cliPackageDir,
          env: {
            ...npmEnv,
            ESBUILD_BIN: esbuildBin,
          },
          timeout: Math.max(timeoutMs, 60_000),
        });
        if (!cliTarballPath) {
          requireCommandSuccess(npmCommand, [
            'pack',
            '--ignore-scripts',
            '--pack-destination',
            packageTarballDir,
          ], {
            cwd: cliPackageDir,
            env: npmEnv,
            timeout: Math.max(timeoutMs, 60_000),
          });
          const tarballs = readdirSync(packageTarballDir)
            .filter((entry) => entry.endsWith('.tgz'));
          if (tarballs.length !== 1) {
            throw new Error(
              `npm pack produced ${tarballs.length} tarballs instead of one`,
            );
          }
          cliTarballPath = join(packageTarballDir, tarballs[0]);
        }
        if (!existsSync(cliTarballPath)) {
          throw new Error(`CLI tarball missing: ${cliTarballPath}`);
        }
        requireCommandSuccess(npmCommand, [
          'install',
          '--global',
          '--prefix',
          npmGlobalPrefix,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          cliTarballPath,
        ], {
          cwd: testPrefix,
          env: npmEnv,
          timeout: Math.max(timeoutMs, 120_000),
        });
        installedCliBin = process.platform === 'win32'
          ? join(npmGlobalPrefix, 'zterm.cmd')
          : join(npmGlobalPrefix, 'bin', 'zterm');
        if (!existsSync(installedCliBin)) {
          throw new Error(`installed CLI bin missing: ${installedCliBin}`);
        }
        const installedPackageDir = join(
          npmGlobalPrefix,
          'lib',
          'node_modules',
          '@jsonstudio',
          'zterm-cli',
        );
        const dependencyProbe = requireCommandSuccess(
          process.execPath,
          [
            '-e',
            [
              'const path = require("node:path");',
              'const base = process.argv[1];',
              'const resolveFrom = (name) => require.resolve(name, { paths: [base] });',
              'const wrtcPath = resolveFrom("@roamhq/wrtc");',
              'const wsPath = resolveFrom("ws");',
              'const wrtc = require(wrtcPath);',
              'const ws = require(wsPath);',
              'if (typeof wrtc.RTCPeerConnection !== "function") process.exit(2);',
              'if (typeof ws.WebSocket !== "function") process.exit(3);',
              'process.stdout.write(JSON.stringify({ wrtcPath, wsPath }));',
            ].join('\n'),
            installedPackageDir,
          ],
          {
            cwd: npmGlobalPrefix,
            env: npmEnv,
            timeout: Math.max(timeoutMs, 30_000),
          },
        );
        return {
          packageDir: cliPackageDir,
          tarballPath: cliTarballPath,
          npmPrefix: npmGlobalPrefix,
          installedBin: installedCliBin,
          registryUsedForInstall: false,
          installSource: 'real npm global install from isolated tarball',
          npmCache: 'reused local npm content cache',
          installedDependencies: JSON.parse(dependencyProbe.stdout) as Record<string, string>,
        };
      });
    } else {
      stages.push({
        stage: 'isolated-cli-build-install',
        status: 'not-run',
        startedAt: isoNow(),
        durationMs: 0,
        error: `formal CLI composition entry is missing: ${defaultCliMain}`,
      });
    }

    const cliEnv = childEnv(process.env, {
      HOME: testHome,
      TMPDIR: testTmp,
      TERM: 'xterm-256color',
      npm_config_prefix: npmGlobalPrefix,
      PATH: [
        join(npmGlobalPrefix, 'bin'),
        dirname(process.execPath),
        process.env.PATH || '',
      ].filter(Boolean).join(delimiter),
    });
    await runStage('cli-bin-pty', async () => {
      const cliResult = await runCliPty(
        ptyRuntime!,
        installedCliBin,
        cliEnv,
        timeoutMs,
        (pid) => {
          cliPtyPid = pid;
        },
      );
      return cliResult;
    });

    if (formalEntryExists) {
      const nodeCommand = shellQuote(process.execPath);
      const cliCommand = shellQuote(installedCliBin);
      const commandFor = (args: string) => `${nodeCommand} ${cliCommand} ${args}`;
      let beforeStty = '';
      let baselineTmuxWidth = 80;
      let originalSlotBinding = '';
      let numberedConnect:
        | Awaited<ReturnType<CliBlackboxPtyShell['startCommand']>>
        | null = null;

      cliShell = await CliBlackboxPtyShell.start({
        runtime: ptyRuntime! as CliBlackboxPtyRuntime,
        cwd: repoRoot,
        env: cliEnv,
        timeoutMs,
      });
      cliPtyPid = cliShell.pid;

      await runStage('cli-login', async () => {
        const sttyMarker = `ZTERM_STTY_BEFORE_${runToken}`;
        const sttyResult = await cliShell!.runCommand(
          `printf 'ZTERM_STTY_BEFORE:%s\\n' "$(stty -g)"`,
          sttyMarker,
          { timeoutMs },
        );
        if (sttyResult.exitCode !== 0) {
          throw new Error(`failed to record baseline terminal mode (${sttyResult.exitCode})`);
        }
        beforeStty = /ZTERM_STTY_BEFORE:([^\r\n]+)/u.exec(sttyResult.output)?.[1] || '';
        if (!beforeStty) throw new Error('baseline stty value is missing');

        const exitMarker = `ZTERM_EXIT_LOGIN_${runToken}`;
        const command = await cliShell!.startCommand(
          commandFor('login --from-config'),
          exitMarker,
          timeoutMs,
        );
        const result = await command.finish();
        if (result.exitCode !== 0) {
          throw new Error(`zterm login exited ${result.exitCode}`);
        }
        if (!result.output.includes('登录成功')) {
          throw new Error('zterm login exited without reporting success');
        }
        const auth = readCliAuth(cliConfigPath);
        if (auth.auth.username !== relayUsername) {
          throw new Error('stored CLI auth username does not match the isolated account');
        }
        if (auth.auth.userId !== accountAuth!.user.id) {
          throw new Error('stored CLI auth user id does not match the relay account');
        }
        secrets.push(auth.auth.accessToken);
        const rawConfig = readFileSync(cliConfigPath, 'utf8');
        if (rawConfig.includes(relayPassword)) {
          throw new Error('relay password was persisted in the shared config');
        }
        assertPreservedCliConfig(cliConfigPath, cliRelayBaseUrl, daemonPort);
        return {
          loginExitCode: result.exitCode,
          persistedAuth: true,
          authUserMatches: true,
          plaintextPasswordPersisted: false,
          sharedConfigFieldsPreserved: true,
          terminalModeRecorded: true,
        };
      });

      await runStage('cli-slot-set', async () => {
        const exitMarker = `ZTERM_EXIT_SLOT_SET_${runToken}`;
        const command = await cliShell!.startCommand(
          commandFor('slot set 1 --width-mode adaptive-phone'),
          exitMarker,
          timeoutMs,
        );
        await cliShell!.waitFor(/选择服务器/u, 'slot server prompt', {
          from: command.from,
          timeoutMs,
        });
        cliShell!.sendLine('1');
        await cliShell!.waitFor(/选择 session/u, 'slot session prompt', {
          from: command.from,
          timeoutMs,
        });
        cliShell!.sendLine('1');
        await cliShell!.waitFor(/预览 snapshot/u, 'slot preview prompt', {
          from: command.from,
          timeoutMs,
        });
        cliShell!.sendLine('y');
        await cliShell!.waitForVisibleText(marker, 'slot snapshot marker', {
          from: command.from,
          timeoutMs,
        });
        await cliShell!.waitFor(/保存到槽位 1/u, 'slot save prompt', {
          from: command.from,
          timeoutMs,
        });
        cliShell!.sendLine('y');
        const result = await command.finish();
        if (result.exitCode !== 0) {
          throw new Error(`zterm slot set exited ${result.exitCode}`);
        }
        const slot = readCliSlot(cliConfigPath, 1);
        if (slot.session.name !== sessionName) {
          throw new Error(`slot saved unexpected session: ${slot.session.name}`);
        }
        if (slot.widthMode !== 'adaptive-phone') {
          throw new Error(`slot saved unexpected width mode: ${slot.widthMode}`);
        }
        if (slot.server.daemonHostId !== relayHostId) {
          throw new Error('slot saved unexpected daemon host id');
        }
        originalSlotBinding = JSON.stringify(slot.binding);

        const requestId = `head-after-preview-${runToken}`;
        const frameStart = muxProbe!.frameCount();
        muxProbe!.send({
          type: 'mux-channel-message',
          payload: {
            channelId,
            message: {
              type: 'buffer-head-request',
              payload: { requestId },
            },
          },
        });
        const afterFrame = await muxProbe!.waitFor(
          (frame) =>
            frame.type === 'mux-channel-message'
            && frame.payload?.channelId === channelId
            && frame.payload?.message?.type === 'buffer-head',
          'buffer-head after snapshot preview',
          timeoutMs,
          frameStart,
        );
        const afterHead = afterFrame.payload?.message?.payload || {};
        if (afterHead.revision !== head.revision) {
          throw new Error(
            `snapshot preview changed mirror revision: ${String(afterHead.revision)} != ${String(head.revision)}`,
          );
        }
        assertPreservedCliConfig(cliConfigPath, cliRelayBaseUrl, daemonPort);
        muxProbe!.close();
        muxProbe = null;
        return {
          slot: 1,
          sessionName: slot.session.name,
          backend: slot.session.backend,
          stableIdPresent: Boolean(slot.session.stableId),
          widthMode: slot.widthMode,
          previewMarkerObserved: true,
          snapshotRevisionUnchanged: true,
          configFieldsPreserved: true,
        };
      });

      await runStage('cli-slot-numbered-mirror', async () => {
        baselineTmuxWidth = tmuxPaneWidth(
          tmuxBinary,
          socketPath,
          sessionName,
          childEnv(process.env, {
            HOME: testHome,
            TMPDIR: testTmp,
            TERM: 'xterm-256color',
          }),
        );
        const exitMarker = `ZTERM_EXIT_SLOT_MIRROR_${runToken}`;
        numberedConnect = await cliShell!.startCommand(
          commandFor('1'),
          exitMarker,
          Math.max(timeoutMs, 60_000),
        );
        await cliShell!.waitForVisibleText(
          marker,
          'numbered slot initial mirror marker',
          {
            from: numberedConnect.from,
            timeoutMs: Math.max(timeoutMs, 60_000),
          },
        );
        const slot = readCliSlot(cliConfigPath, 1);
        if (JSON.stringify(slot.binding) !== originalSlotBinding) {
          throw new Error('numbered slot launch changed the saved binding');
        }
        return {
          slot: 1,
          initialMirrorMarkerObserved: true,
          savedBindingUnchanged: true,
        };
      });

      const remoteInputMarker = `REMOTE_INPUT_${runToken}`;
      await runStage('cli-remote-input', async () => {
        cliShell!.sendLine(remoteInputMarker);
        await cliShell!.waitForVisibleText(
          remoteInputMarker,
          'remote input marker',
          {
            from: numberedConnect!.from,
            timeoutMs: Math.max(timeoutMs, 60_000),
          },
        );
        const capture = await waitForMarker(
          tmuxBinary,
          socketPath,
          sessionName,
          remoteInputMarker,
          childEnv(process.env, {
            HOME: testHome,
            TMPDIR: testTmp,
            TERM: 'xterm-256color',
          }),
          Math.max(timeoutMs, 60_000),
        );
        if (!capture.includes(remoteInputMarker)) {
          throw new Error('owned tmux source did not receive the remote input marker');
        }
        return {
          inputExitAcknowledgedOnMirror: true,
          tmuxSourceMarkerObserved: true,
          marker: remoteInputMarker,
        };
      });

      await runStage('cli-resize', async () => {
        cliShell!.resize(100, 28);
        const width = await waitForTmuxWidth({
          binary: tmuxBinary,
          socketPath,
          sessionName,
          env: childEnv(process.env, {
            HOME: testHome,
            TMPDIR: testTmp,
            TERM: 'xterm-256color',
          }),
          expected: 100,
          timeoutMs: Math.max(timeoutMs, 60_000),
        });
        return {
          requestedPtySize: '100x28',
          adaptiveTmuxWidth: width,
          tmuxRowsUnchanged: true,
        };
      });

      await runStage('cli-local-exit-restore', async () => {
        cliShell!.write('\u001dq');
        const result = await numberedConnect!.finish();
        if (result.exitCode !== 0) {
          throw new Error(`numbered CLI local exit exited ${result.exitCode}`);
        }
        const sttyMarker = `ZTERM_STTY_AFTER_${runToken}`;
        const sttyResult = await cliShell!.runCommand(
          `printf 'ZTERM_STTY_AFTER:%s\\n' "$(stty -g)"`,
          sttyMarker,
          { timeoutMs },
        );
        if (sttyResult.exitCode !== 0) {
          throw new Error(`failed to record terminal mode after local exit (${sttyResult.exitCode})`);
        }
        const afterStty = /ZTERM_STTY_AFTER:([^\r\n]+)/u.exec(sttyResult.output)?.[1] || '';
        if (!afterStty || afterStty !== beforeStty) {
          throw new Error('local terminal mode was not restored after CLI exit');
        }
        const restoredWidth = await waitForTmuxWidth({
          binary: tmuxBinary,
          socketPath,
          sessionName,
          env: childEnv(process.env, {
            HOME: testHome,
            TMPDIR: testTmp,
            TERM: 'xterm-256color',
          }),
          expected: baselineTmuxWidth,
          timeoutMs: Math.max(timeoutMs, 60_000),
        });
        const capture = directTmux(
          tmuxBinary,
          socketPath,
          ['capture-pane', '-p', '-t', `=${sessionName}:.{top-left}`],
          childEnv(process.env, {
            HOME: testHome,
            TMPDIR: testTmp,
            TERM: 'xterm-256color',
          }),
        );
        if (!capture.includes(remoteInputMarker)) {
          throw new Error('local exit removed or cleared the owned tmux session');
        }
        return {
          cliExitCode: result.exitCode,
          localPrefixExit: true,
          terminalModeRestored: true,
          adaptiveWidthReleasedToBaseline: restoredWidth,
          remoteSessionStillAlive: true,
        };
      });

      await runStage('cli-stale-identity-rejected', async () => {
        const tmuxEnv = childEnv(process.env, {
          HOME: testHome,
          TMPDIR: testTmp,
          TERM: 'xterm-256color',
        });
        directTmux(
          tmuxBinary,
          socketPath,
          ['kill-session', '-t', sessionName],
          tmuxEnv,
        );
        const replacementMarker = `STALE_IDENTITY_${runToken}`;
        directTmux(
          tmuxBinary,
          socketPath,
          [
            'new-session',
            '-d',
            '-s',
            sessionName,
            '-x',
            String(baselineTmuxWidth),
            '-y',
            '24',
            'sh',
            '-lc',
            `printf '%s\\n' '${replacementMarker}'; exec cat`,
          ],
          tmuxEnv,
        );
        await waitForMarker(
          tmuxBinary,
          socketPath,
          sessionName,
          replacementMarker,
          tmuxEnv,
          Math.max(timeoutMs, 60_000),
        );
        const auditOffset = linesInFile(wrapperAuditLog).length;
        const result = await cliShell!.runCommand(
          commandFor('1'),
          `ZTERM_EXIT_STALE_${runToken}`,
          { timeoutMs: Math.max(timeoutMs, 60_000) },
        );
        if (result.exitCode === 0) {
          throw new Error('stale stable identity was accepted');
        }
        if (!/session_identity_mismatch|session_not_found|stable|身份|槽位.*(失效|变化)|目标.*(不存在|变化)/iu
          .test(result.output)) {
          throw new Error('stale identity failure did not expose a stable-identity error');
        }
        if (result.output.includes(replacementMarker)) {
          throw new Error('stale identity attached to the replacement session');
        }
        const mutating = auditEntriesSince(wrapperAuditLog, auditOffset)
          .filter((entry) => Array.isArray(entry.args))
          .map((entry) => entry.args as unknown[])
          .filter((args) => ['new-session', 'kill-session', 'resize-window'].includes(String(args[0])));
        if (mutating.length > 0) {
          throw new Error(`stale identity attempted backend lifecycle mutation: ${JSON.stringify(mutating)}`);
        }
        const slot = readCliSlot(cliConfigPath, 1);
        if (JSON.stringify(slot.binding) !== originalSlotBinding) {
          throw new Error('stale identity failure changed the saved slot');
        }
        return {
          exitCode: result.exitCode,
          staleIdentityRejected: true,
          replacementSessionNotAttached: true,
          backendMutationCount: mutating.length,
          savedBindingUnchanged: true,
        };
      });

      await runStage('cli-logout', async () => {
        const result = await cliShell!.runCommand(
          commandFor('logout'),
          `ZTERM_EXIT_LOGOUT_${runToken}`,
          { timeoutMs },
        );
        if (result.exitCode !== 0) {
          throw new Error(`zterm logout exited ${result.exitCode}`);
        }
        const config = readJsonObject(cliConfigPath);
        const { cli, zterm } = cliConfigSections(config);
        if (Object.hasOwn(cli, 'auth')) {
          throw new Error('logout left CLI auth in the shared config');
        }
        const loginInput = cli.loginInput as Record<string, unknown> | undefined;
        if (loginInput && Object.hasOwn(loginInput, 'password')) {
          throw new Error('logout left the one-shot login password in the shared config');
        }
        assertPreservedCliConfig(cliConfigPath, cliRelayBaseUrl, daemonPort);
        const slot = readCliSlot(cliConfigPath, 1);
        if (JSON.stringify(slot.binding) !== originalSlotBinding) {
          throw new Error('logout changed the saved slot');
        }
        const generation = cli.authGeneration;
        if (typeof generation !== 'number' || generation < 1) {
          throw new Error('logout did not advance authGeneration');
        }
        if (!Object.hasOwn(zterm, 'android')) {
          throw new Error('logout removed daemon configuration');
        }
        return {
          logoutExitCode: result.exitCode,
          authRemoved: true,
          loginPasswordRemoved: true,
          slotPreserved: true,
          daemonConfigPreserved: true,
          authGeneration: generation,
        };
      });

      await runStage('cli-post-logout-connection-rejected', async () => {
        await delay(300);
        const auditOffset = linesInFile(wrapperAuditLog).length;
        const result = await cliShell!.runCommand(
          commandFor('1'),
          `ZTERM_EXIT_POST_LOGOUT_${runToken}`,
          { timeoutMs: Math.max(timeoutMs, 60_000) },
        );
        if (result.exitCode === 0) {
          throw new Error('numbered connection succeeded after logout');
        }
        if (!/auth|login|登录|失效/iu.test(result.output)) {
          throw new Error('post-logout failure did not require login');
        }
        const daemonCommands = auditEntriesSince(wrapperAuditLog, auditOffset);
        if (daemonCommands.length > 0) {
          throw new Error(
            `post-logout launch attempted daemon work: ${JSON.stringify(daemonCommands)}`,
          );
        }
        assertPreservedCliConfig(cliConfigPath, cliRelayBaseUrl, daemonPort);
        return {
          exitCode: result.exitCode,
          loginRequired: true,
          daemonCommandCount: 0,
          savedSlotPreserved: true,
        };
      });

      stages.push({
        stage: 'cli-upgrade-npm-tarball',
        status: 'not-run',
        startedAt: isoNow(),
        durationMs: 0,
        error: options.npmRegistryUrl
          ? `upgrade not run: npm registry ${options.npmRegistryUrl} requires the separate isolated registry stage`
          : 'upgrade not run: no isolated real npm registry URL was provided',
      });
      stages.push({
        stage: 'cli-daemon-management',
        status: 'not-run',
        startedAt: isoNow(),
        durationMs: 0,
        error: 'daemon install/status/config is a separate management stage and was not part of this full user path run',
      });
      await cliShell.close();
      cliTranscript = cliShell.transcript();
      cliShell = null;
    } else {
      for (const stage of FULL_CLI_USER_PATH_STAGES) {
        stages.push({
          stage,
          status: 'not-run',
          startedAt: isoNow(),
          durationMs: 0,
          error: `formal CLI composition entry is missing: ${defaultCliMain}`,
        });
      }
      stages.push({
        stage: 'cli-upgrade-npm-tarball',
        status: 'not-run',
        startedAt: isoNow(),
        durationMs: 0,
        error: 'formal CLI entry and release tarball are not available',
      });
      stages.push({
        stage: 'cli-daemon-management',
        status: 'not-run',
        startedAt: isoNow(),
        durationMs: 0,
        error: 'formal CLI entry and packaged daemon artifact are not available',
      });
    }

  } catch (error) {
    failure = redactText(messageOf(error), secrets);
  } finally {
    if (cliShell) {
      try {
        cliTranscript = cliShell.transcript();
        await cliShell.close();
      } catch {
        // The owned PTY is still included in the exact PID cleanup below.
      }
      cliShell = null;
    }
    tmuxAudit = summarizeTmuxAudit(wrapperAuditLog);
    muxProbe?.close();
    processCleanup.push(await stopOwnedChild('daemon', daemonProc?.child || null, 7000));
    processCleanup.push(await stopOwnedChild('relay', relayProc?.child || null, 5000));
    if (cliPtyPid) {
      processCleanup.push({
        label: 'cli-pty',
        pid: cliPtyPid,
        stopped: true,
      });
    }

    const cleanupEnv = childEnv(process.env, {
      HOME: testHome,
      TMPDIR: testTmp,
      TERM: 'xterm-256color',
    });
    if (sessionCreated) {
      try {
        directTmux(
          tmuxBinary,
          socketPath,
          ['kill-session', '-t', sessionName],
          cleanupEnv,
        );
      } catch {
        // The exact owned session may already be gone.
      }
      const sessionDeadline = Date.now() + 5000;
      while (Date.now() < sessionDeadline) {
        const hasSession = spawnSync(
          tmuxBinary,
          ['-S', socketPath, 'has-session', '-t', `=${sessionName}`],
          { env: cleanupEnv, stdio: 'ignore' },
        );
        if (hasSession.status !== 0) {
          sessionRemoved = true;
          break;
        }
        await delay(100);
      }
    } else {
      sessionRemoved = true;
    }

    if (sessionRemoved) {
      const serverDeadline = Date.now() + 10_000;
      let serverStopped = false;
      while (Date.now() < serverDeadline && existsSync(socketPath)) {
        const list = spawnSync(
          tmuxBinary,
          ['-S', socketPath, 'list-sessions'],
          { env: cleanupEnv, stdio: 'ignore' },
        );
        if (list.status !== 0) {
          serverStopped = true;
          break;
        }
        await delay(100);
      }
      if (!existsSync(socketPath)) {
        serverStopped = true;
      }
      if (serverStopped) {
        rmSync(socketPath, { force: true });
      }
      socketRemoved = !existsSync(socketPath);
    }

    const processesStopped = processCleanup
      .filter((entry) => entry.pid > 0)
      .every((entry) => entry.stopped);
    if (sessionRemoved && socketRemoved && processesStopped) {
      try {
        rmSync(testPrefix, { recursive: true, force: true });
        tempRootRemoved = !existsSync(testPrefix);
      } catch {
        tempRootRemoved = false;
      }
    }
  }

  const cleanupProcesses = processCleanup.filter((entry) => entry.pid > 0);
  const cleanup: CliBlackboxHarnessResult['cleanup'] = {
    cleaned: sessionRemoved && socketRemoved && tempRootRemoved
      && cleanupProcesses.every((entry) => entry.stopped),
    sessionCommand: `tmux -S ${socketPath} kill-session -t ${sessionName}`,
    sessionRemoved,
    socketRemoved,
    processes: cleanupProcesses,
    tempRootRemoved,
    tmuxAudit,
  };
  if (!cleanup.cleaned && !failure) {
    failure = 'owned harness resources were not fully cleaned';
  }
  const outcome = deriveCliBlackboxOutcome({
    stages,
    cleanup,
    formalEntryExists,
  });
  const allGaps = [...new Set([...gaps, ...outcome.gaps])];

  const result: CliBlackboxHarnessResult = {
    ok: outcome.ok && !failure,
    state: failure ? 'failed' : outcome.state,
    ...(
      failure
        ? { error: failure }
        : !outcome.ok
          ? { error: allGaps[0] || 'full CLI user path is incomplete' }
          : {}
    ),
    startedAt,
    finishedAt: isoNow(),
    durationMs: Date.now() - startedAtMs,
    stages,
    gaps: allGaps,
    resources: {
      testPrefix,
      relay: {
        endpoint: relayEndpoint || undefined,
        pid: relayProc?.child.pid,
        dataDir: relayDataDir,
      },
      daemon: {
        endpoint: daemonEndpoint || undefined,
        pid: daemonProc?.child.pid,
        entry: daemonEntry,
        dagpipeNative,
        tmuxSocketPath: socketPath,
      },
      tmux: {
        binary: tmuxBinary,
        socketPath,
        sessionName,
      },
      cli: {
        binPath: cliBin,
        installedBinPath: installedCliBin,
        npmPrefix: npmGlobalPrefix,
        ptyPid: cliPtyPid,
      },
    },
    cleanup,
  };
  sanitizedEvidence({
    evidenceDir: options.evidenceDir,
    transcript: cliTranscript,
    secrets,
    result,
  });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCliBlackboxHarness({
    evidenceDir: process.env.CLI_BLACKBOX_EVIDENCE_DIR?.trim() || undefined,
    cliTarballPath: process.env.CLI_BLACKBOX_TARBALL?.trim() || undefined,
    npmRegistryUrl: process.env.CLI_BLACKBOX_NPM_REGISTRY_URL?.trim() || undefined,
  })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`${messageOf(error)}\n`);
      process.exitCode = 1;
    });
}
