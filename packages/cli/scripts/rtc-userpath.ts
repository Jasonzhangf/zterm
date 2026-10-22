import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { build as esbuild } from 'esbuild';

import { AccountClient, type AuthenticatedAccount } from '../src/account-client.js';
import { createApplicationConnection } from '../src/application-connection.js';
import type {
  SessionChannel,
  SessionConnection,
} from '../src/connection.js';
import type {
  RelayAccountDirectory,
  RelayEndpointCandidate,
} from '../../shared/src/connection/relay-directory.js';
import type { TerminalBufferPayload } from '../../shared/src/connection/types.js';
import type {
  TerminalSnapshotResultPayload,
} from '../../shared/src/connection/protocol.js';
import type { TraversalDiagnostics } from '../../shared/src/connection/traversal/types.js';
import { resolveNpmInvocation } from './process-entry.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(scriptDir, '..');
const repoRoot = resolve(cliDir, '..', '..');
const mainEntry = join(cliDir, 'src', 'main.ts');
const sourceManifestPath = join(cliDir, 'package.json');
const remoteRunnerPath = join(scriptDir, 'remote-cli-blackbox.mjs');
const DEFAULT_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 240_000;
const RUNNER_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 30_000;
const RTC_PATHS = new Set(['rtc-direct', 'rtc-relay']);
const DIRECT_ENDPOINT_KINDS = new Set(['lan', 'tailscale', 'ipv4', 'ipv6']);
const REMOTE_CLI_RESULT_FILE = 'remote-cli-result.json';

interface RtcFixtureModule {
  startRtcFixture(options: {
    evidenceDir: string;
    hold?: boolean;
    exposeRelay?: boolean;
    turnRequired?: boolean;
    interactiveSession?: boolean;
    timeoutMs?: number;
  }): Promise<FixtureHandle>;
}

interface PlatformSmokeHelperModule {
  resolveNodePtyInstallation(path: string): {
    tuple: string;
  };
}

interface RemoteCliHelperModule {
  assertReceiptPrivacy(path: string): {
    kind: string;
    verified: boolean;
  };
}

interface FixtureReceipt {
  schemaVersion: 1;
  kind: 'zterm-rtc-fixture';
  runId: string;
  managedTest: true;
  relayBaseUrl: string;
  publicRelayBaseUrl: string;
  username: string;
  password: string;
  deviceId: string;
  daemonHostId: string;
  sessionName: string;
  backend: 'tmux';
  stableId: string;
  evidenceDir: string;
  runtimeRoot: string;
  receiptPath: string;
  publicReceiptPath: string;
  tmux?: {
    socketPath?: string;
  };
  turn?: {
    containerId?: string;
    containerName?: string;
  };
  [key: string]: unknown;
}

interface PublicFixtureReceipt {
  ok: boolean;
  status: string;
  state: string;
  runId: string;
  selfcheck?: {
    direct?: PublicSelfcheck | null;
    relay?: PublicSelfcheck | null;
    tunnelRelay?: PublicSelfcheck | null;
  };
  cleanup?: {
    state?: string;
  };
}

interface PublicSelfcheck {
  ok?: boolean;
  path?: string;
  relayTransport?: string | null;
  selectedIcePair?: {
    local?: { candidateType?: string };
    remote?: { candidateType?: string };
    localCandidateType?: string;
    remoteCandidateType?: string;
  } | null;
  muxReady?: boolean;
  ownedSessionVisible?: boolean;
}

interface FixtureHandle {
  receiptPath: string;
  publicReceipt: PublicFixtureReceipt;
  close(): Promise<unknown>;
}

interface ProcessResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface CompactRoute {
  observation: 'public-api-probe';
  stage: TraversalDiagnostics['stage'];
  path: string | null;
  relayTransport: string | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  localProtocol: string | null;
  remoteProtocol: string | null;
  roundTripTimeMs: number | null;
}

interface StageRecord {
  name: string;
  status: 'passed' | 'failed';
  startedAt: string;
  durationMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

interface ControllerResult {
  schemaVersion: 1;
  state: 'passed' | 'failed';
  coverage: 'darwin-real-cli-rtc-business';
  generatedAt: string;
  stages: StageRecord[];
  fixture: {
    publicReceipt: string;
    status: string;
    state: string;
    direct: Record<string, unknown> | null;
    relay: Record<string, unknown> | null;
    cleanup: Record<string, unknown>;
  } | null;
  apiProbe: {
    route: CompactRoute | null;
    mirrorSubscribed: boolean;
    mirrorFixed: boolean;
    snapshotAvailable: boolean;
    inputSent: false;
    adaptiveLeaseHeld: false;
    postBinProbeOpen: boolean;
    postBinRemoteSessionPresent: boolean;
  } | null;
  bin: {
    resultFile: string;
    outcome: Record<string, unknown> | null;
    controlledCandidateScope: {
      directoryRequests: number;
      directWsCandidatesReplaced: number;
      rtcCandidatesRetained: number;
    } | null;
    routeObservation: 'not-instrumented-in-bin-process';
  } | null;
  cleanup: Record<string, unknown>;
  firstDeviation: string | null;
}

interface ControllerState {
  fixture: FixtureHandle | null;
  proxy: DirectoryRewriteProxy | null;
  probeConnection: SessionConnection | null;
  probeChannel: SessionChannel | null;
  unsubscribeProbe: (() => void) | null;
  tempRoot: string | null;
  child: ReturnType<typeof spawn> | null;
}

interface RunOptions {
  evidenceDir: string;
  ptyPackageRoot: string;
  interactiveSession: boolean;
}

function parseArgs(argv: string[]): RunOptions {
  const evidenceIndex = argv.indexOf('--evidence-dir');
  if (evidenceIndex < 0) {
    throw new Error('--evidence-dir is required');
  }
  const ptyIndex = argv.indexOf('--pty-package-root');
  const interactiveSession = argv.includes('--interactive-session');
  const evidenceDir = argv[evidenceIndex + 1];
  if (!evidenceDir || evidenceDir.startsWith('--')) {
    throw new Error('--evidence-dir requires a value');
  }
  const androidPackageJson = join(repoRoot, 'android', 'package.json');
  const ptyPackageRoot = ptyIndex >= 0
    ? argv[ptyIndex + 1]
    : dirname(androidPackageJson);
  if (!ptyPackageRoot || ptyPackageRoot.startsWith('--')) {
    throw new Error('--pty-package-root requires a value');
  }
  return {
    evidenceDir: resolve(evidenceDir),
    ptyPackageRoot: resolve(ptyPackageRoot),
    interactiveSession,
  };
}

function isoTimestamp() {
  return new Date().toISOString();
}

async function loadScriptModule<T>(filename: string): Promise<T> {
  const moduleUrl = new URL(filename, import.meta.url).href;
  return await import(moduleUrl) as T;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function redactText(value: unknown, secrets: string[]) {
  let text = String(value);
  for (const secret of [...new Set(secrets)]
    .filter((candidate) => candidate.length >= 4)
    .sort((left, right) => right.length - left.length)) {
    text = text.replaceAll(secret, '[REDACTED]');
  }
  return text;
}

function requireString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`fixture receipt is missing ${field}`);
  }
  return value;
}

function readFixtureReceipt(path: string): FixtureReceipt {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as FixtureReceipt;
  if (parsed.managedTest !== true || parsed.backend !== 'tmux') {
    throw new Error('fixture receipt is not a managed tmux receipt');
  }
  requireString(parsed.runId, 'runId');
  requireString(parsed.relayBaseUrl, 'relayBaseUrl');
  requireString(parsed.username, 'username');
  requireString(parsed.password, 'password');
  requireString(parsed.deviceId, 'deviceId');
  requireString(parsed.daemonHostId, 'daemonHostId');
  requireString(parsed.sessionName, 'sessionName');
  requireString(parsed.stableId, 'stableId');
  return parsed;
}

function secretsForReceipt(receipt: FixtureReceipt) {
  return [
    receipt.password,
    typeof receipt.accessToken === 'string' ? receipt.accessToken : '',
    typeof receipt.daemon === 'object'
      && receipt.daemon
      && typeof (receipt.daemon as Record<string, unknown>).authToken === 'string'
      ? String((receipt.daemon as Record<string, unknown>).authToken)
      : '',
    typeof receipt.turn === 'object'
      && receipt.turn
      && typeof (receipt.turn as Record<string, unknown>).credential === 'string'
      ? String((receipt.turn as Record<string, unknown>).credential)
      : '',
    typeof receipt.turn === 'object'
      && receipt.turn
      && typeof (receipt.turn as Record<string, unknown>).username === 'string'
      ? String((receipt.turn as Record<string, unknown>).username)
      : '',
  ].filter(Boolean);
}

function writePrivateText(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function writePublicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  chmodSync(path, 0o644);
}

function isolatedNpmEnvironment(root: string) {
  const home = join(root, 'home');
  const cache = join(root, 'npm-cache');
  const config = join(root, 'npmrc');
  for (const directory of [home, cache, join(home, '.config')]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writePrivateText(config, '');
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: cache,
    NPM_CONFIG_CACHE: cache,
    npm_config_userconfig: config,
    NPM_CONFIG_USERCONFIG: config,
    npm_config_audit: 'false',
    NPM_CONFIG_AUDIT: 'false',
    npm_config_fund: 'false',
    NPM_CONFIG_FUND: 'false',
    npm_config_update_notifier: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    onChild?: (child: ReturnType<typeof spawn> | null) => void;
  },
): Promise<ProcessResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  options.onChild?.(child);
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, options.timeoutMs);
  timer.unref();
  const result = await new Promise<ProcessResult>((resolveResult, rejectResult) => {
    child.once('error', rejectResult);
    child.once('close', (exitCode, signal) => {
      resolveResult({
        command,
        args,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  }).finally(() => {
    clearTimeout(timer);
    options.onChild?.(null);
  });
  return result;
}

function requireProcessSuccess(result: ProcessResult, label: string, secrets: string[]) {
  if (result.timedOut) {
    throw new Error(`${label} timed out after ${result.command} ${result.args.join(' ')}`);
  }
  if (result.exitCode !== 0) {
    const detail = redactText(
      result.stderr.trim() || result.stdout.trim() || 'no process output',
      secrets,
    );
    throw new Error(`${label} exited ${String(result.exitCode)}: ${detail}`);
  }
}

async function buildAndInstallCli(
  tempRoot: string,
  evidenceDir: string,
  secrets: string[],
) {
  const stagingDir = join(tempRoot, 'package');
  const tarballDir = join(tempRoot, 'tarball');
  const npmPrefix = join(tempRoot, 'npm-prefix');
  mkdirSync(join(stagingDir, 'bin'), { recursive: true, mode: 0o700 });
  mkdirSync(join(stagingDir, 'dist'), { recursive: true, mode: 0o700 });
  mkdirSync(tarballDir, { recursive: true, mode: 0o700 });
  mkdirSync(npmPrefix, { recursive: true, mode: 0o700 });

  copyFileSync(join(cliDir, 'bin', 'zterm.mjs'), join(stagingDir, 'bin', 'zterm.mjs'));
  copyFileSync(join(cliDir, 'README.md'), join(stagingDir, 'README.md'));
  copyFileSync(join(cliDir, 'LICENSE'), join(stagingDir, 'LICENSE'));
  chmodSync(join(stagingDir, 'bin', 'zterm.mjs'), 0o755);

  const manifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(
    join(stagingDir, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o644 },
  );

  await esbuild({
    entryPoints: [mainEntry],
    outfile: join(stagingDir, 'dist', 'main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    absWorkingDir: cliDir,
    external: ['ws', '@roamhq/wrtc'],
    define: {
      __ZTERM_CLI_VERSION__: JSON.stringify(String(manifest.version || '0.0.0')),
    },
    logLevel: 'silent',
  });

  const npmEnv = isolatedNpmEnvironment(tempRoot);
  const npm = resolveNpmInvocation([]);
  const pack = await runProcess(
    npm.command,
    [
      ...npm.args,
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      tarballDir,
      stagingDir,
    ],
    {
      cwd: tempRoot,
      env: npmEnv,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  );
  requireProcessSuccess(pack, 'npm pack', secrets);
  let packed: unknown;
  try {
    packed = JSON.parse(pack.stdout.trim());
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON: ${errorMessage(error)}`);
  }
  const packedItem = Array.isArray(packed) ? packed[0] : packed;
  const filename = packedItem && typeof packedItem === 'object'
    && typeof (packedItem as Record<string, unknown>).filename === 'string'
    ? String((packedItem as Record<string, unknown>).filename)
    : '';
  if (!filename) throw new Error('npm pack did not report a tarball filename');
  const tarballPath = join(tarballDir, basename(filename));
  if (!existsSync(tarballPath)) throw new Error('npm pack tarball is missing');

  const install = await runProcess(
    npm.command,
    [
      ...npm.args,
      'install',
      '--global',
      '--prefix',
      npmPrefix,
      '--no-audit',
      '--no-fund',
      tarballPath,
    ],
    {
      cwd: tempRoot,
      env: npmEnv,
      timeoutMs: INSTALL_TIMEOUT_MS,
    },
  );
  requireProcessSuccess(install, 'npm install', secrets);

  const installedRoot = join(npmPrefix, 'lib', 'node_modules', '@jsonstudio', 'zterm-cli');
  const cliBin = join(installedRoot, 'dist', 'main.mjs');
  const installedLauncher = join(npmPrefix, 'bin', 'zterm');
  if (!existsSync(cliBin)) throw new Error(`installed CLI JavaScript is missing: ${cliBin}`);
  if (!existsSync(installedLauncher)) {
    throw new Error(`installed zterm launcher is missing: ${installedLauncher}`);
  }

  const version = await runProcess(
    installedLauncher,
    ['--version'],
    {
      cwd: tempRoot,
      env: npmEnv,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  );
  requireProcessSuccess(version, 'installed zterm --version', secrets);
  const versionText = redactText(version.stdout.trim(), secrets);
  if (!/^zterm\s+\S+/u.test(versionText)) {
    throw new Error(`installed zterm --version returned unexpected output: ${versionText}`);
  }

  return {
    tarballPath,
    stagingDir,
    npmPrefix,
    installedRoot,
    cliBin: realpathSync(cliBin),
    installedLauncher: realpathSync(installedLauncher),
    version: versionText,
  };
}

function combineRelayPath(basePath: string, requestPath: string) {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const suffix = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  return `${base}${suffix}` || '/';
}

function isJsonDirectoryRequest(request: IncomingMessage) {
  if (request.method !== 'GET') return false;
  const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  return pathname.endsWith('/api/directory');
}

function rewriteDirectoryPayload(value: unknown) {
  const result = {
    rewrittenDevices: 0,
    directWsCandidatesReplaced: 0,
    rtcCandidatesRetained: 0,
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const payload = value as Record<string, unknown>;
  const directory = payload.directory;
  if (!directory || typeof directory !== 'object' || Array.isArray(directory)) return result;
  const devices = (directory as Record<string, unknown>).devices;
  if (!Array.isArray(devices)) return result;

  for (const deviceValue of devices) {
    if (!deviceValue || typeof deviceValue !== 'object' || Array.isArray(deviceValue)) {
      continue;
    }
    const device = deviceValue as Record<string, unknown>;
    const daemon = device.daemon;
    if (!daemon || typeof daemon !== 'object' || Array.isArray(daemon)) continue;
    const daemonRecord = daemon as Record<string, unknown>;
    const endpoints = daemonRecord.endpoints;
    if (!Array.isArray(endpoints)) continue;
    const original = endpoints.filter(
      (endpoint): endpoint is RelayEndpointCandidate => Boolean(
        endpoint
        && typeof endpoint === 'object'
        && !Array.isArray(endpoint)
        && typeof (endpoint as Record<string, unknown>).kind === 'string',
      ),
    );
    const direct = original.filter((endpoint) => DIRECT_ENDPOINT_KINDS.has(endpoint.kind));
    const rtc = original.filter((endpoint) =>
      endpoint.kind === 'rtc-direct' || endpoint.kind === 'relay-rtc');
    if (rtc.length === 0) continue;
    const unreachable: RelayEndpointCandidate = {
      id: `rtc-userpath-unreachable-ws-${String(
        daemonRecord.hostId || result.rewrittenDevices,
      )}`,
      kind: direct[0]?.kind && DIRECT_ENDPOINT_KINDS.has(direct[0].kind)
        ? direct[0].kind
        : 'lan',
      host: '127.0.0.1',
      port: 1,
      wsUrl: 'ws://127.0.0.1:1/ws/client',
      authRequired: false,
      lastSeenAt: new Date().toISOString(),
    };
    daemonRecord.endpoints = [unreachable, ...rtc];
    result.rewrittenDevices += 1;
    result.directWsCandidatesReplaced += direct.length;
    result.rtcCandidatesRetained += rtc.length;
  }
  return result;
}

class DirectoryRewriteProxy {
  private server = createServer((request, response) => {
    void this.handle(request, response);
  });

  private activeRequests = new Set<ReturnType<typeof httpRequest>>();

  public url = '';

  public directoryRequests = 0;

  public directWsCandidatesReplaced = 0;

  public rtcCandidatesRetained = 0;

  constructor(private readonly targetBaseUrl: string) {}

  async start() {
    await new Promise<void>((resolveStart, rejectStart) => {
      this.server.once('error', rejectStart);
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          rejectStart(new Error('directory proxy did not bind an ephemeral port'));
          return;
        }
        this.url = `http://127.0.0.1:${address.port}/`;
        resolveStart();
      });
    });
    return this.url;
  }

  async close() {
    for (const request of this.activeRequests) {
      request.destroy();
    }
    this.activeRequests.clear();
    await new Promise<void>((resolveClose) => {
      this.server.close(() => resolveClose());
      this.server.closeAllConnections();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    try {
      const body = await readRequestBody(request);
      const upstreamUrl = new URL(this.targetBaseUrl);
      const incomingUrl = new URL(request.url || '/', 'http://127.0.0.1');
      upstreamUrl.pathname = combineRelayPath(upstreamUrl.pathname, incomingUrl.pathname);
      upstreamUrl.search = incomingUrl.search;

      const headers = Object.fromEntries(
        Object.entries(request.headers)
          .filter(([name, value]) =>
            value !== undefined
            && !['host', 'connection', 'content-length', 'transfer-encoding'].includes(name)),
      ) as Record<string, string | string[]>;
      headers.host = upstreamUrl.host;
      headers['accept-encoding'] = 'identity';
      if (body.length > 0) headers['content-length'] = String(body.length);

      const requestFn = upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest;
      const upstream = requestFn(upstreamUrl, {
        method: request.method,
        headers,
      }, (upstreamResponse) => {
        const chunks: Buffer[] = [];
        upstreamResponse.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        upstreamResponse.once('end', () => {
          try {
            let responseBody = Buffer.concat(chunks);
            const responseHeaders = { ...upstreamResponse.headers };
            delete responseHeaders.connection;
            delete responseHeaders['transfer-encoding'];
            if (
              upstreamResponse.statusCode === 200
              && isJsonDirectoryRequest(request)
            ) {
              const parsed = JSON.parse(responseBody.toString('utf8')) as unknown;
              const rewrite = rewriteDirectoryPayload(parsed);
              if (rewrite.rewrittenDevices > 0) {
                this.directoryRequests += 1;
                this.directWsCandidatesReplaced += rewrite.directWsCandidatesReplaced;
                this.rtcCandidatesRetained += rewrite.rtcCandidatesRetained;
                responseBody = Buffer.from(`${JSON.stringify(parsed)}\n`);
              }
            }
            responseHeaders['content-length'] = String(responseBody.length);
            response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
            response.end(responseBody);
          } catch (error) {
            response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(`directory proxy rewrite failed: ${errorMessage(error)}\n`);
          } finally {
            this.activeRequests.delete(upstream);
          }
        });
      });
      this.activeRequests.add(upstream);
      upstream.once('error', (error) => {
        this.activeRequests.delete(upstream);
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        response.end(`directory proxy upstream failed: ${errorMessage(error)}\n`);
      });
      if (body.length > 0) upstream.write(body);
      upstream.end();
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end(`directory proxy failed: ${errorMessage(error)}\n`);
    }
  }
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function exactDevice(
  directory: RelayAccountDirectory,
  receipt: FixtureReceipt,
) {
  const device = directory.devices.find((candidate) =>
    candidate.deviceId === receipt.deviceId
    && candidate.daemon?.hostId === receipt.daemonHostId);
  if (!device?.daemon) {
    throw new Error('directory does not contain the exact fixture daemon target');
  }
  return device;
}

async function openApiProbe(
  receipt: FixtureReceipt,
  projectedReceiptPath: string,
) {
  const accountClient = new AccountClient();
  const login = await accountClient.login({
    relayBaseUrl: receipt.relayBaseUrl,
    username: receipt.username,
    password: receipt.password,
  }, new AbortController().signal);
  const current = await accountClient.me({
    relayBaseUrl: receipt.relayBaseUrl,
    accessToken: login.accessToken,
  }, new AbortController().signal);
  const directory = await accountClient.directory({
    relayBaseUrl: receipt.relayBaseUrl,
    accessToken: current.accessToken,
  }, new AbortController().signal);
  exactDevice(directory, receipt);
  const account: AuthenticatedAccount = {
    relayBaseUrl: receipt.relayBaseUrl,
    accessToken: current.accessToken,
    user: current.user,
    directory,
    ws: current.ws ?? login.ws,
    turn: current.turn ?? login.turn,
  };
  const connection = await createApplicationConnection(
    account,
    {
      deviceId: receipt.deviceId,
      daemonHostId: receipt.daemonHostId,
    },
  );
  const route = await waitForCompactRoute(connection, PROBE_TIMEOUT_MS);

  const bufferMessages = new Map<string, TerminalBufferPayload>();
  const channelClosures: string[] = [];
  let pendingMirrorResolve: (() => void) | null = null;
  const unsubscribe = connection.onEvent((event) => {
    if (
      event.type === 'channel-message'
      && event.message.type === 'buffer-sync'
    ) {
      bufferMessages.set(event.channelId, event.message.payload);
      pendingMirrorResolve?.();
      pendingMirrorResolve = null;
    }
    if (event.type === 'channel-closed') {
      channelClosures.push(`${event.channelId}:${event.reason}`);
    }
  });

  const channel = await connection.openExisting({
    sessionName: receipt.sessionName,
    backend: receipt.backend,
    stableId: receipt.stableId,
    widthMode: 'mirror-fixed',
    bodySubscribed: true,
  });
  await waitForMirror(channel.id, bufferMessages, () => {
    pendingMirrorResolve = pendingMirrorResolve || (() => undefined);
  }, PROBE_TIMEOUT_MS);
  if (bufferMessages.size === 0) {
    throw new Error('probe did not receive an authoritative buffer-sync mirror frame');
  }
  if (channelClosures.length > 0) {
    throw new Error(`probe channel closed before business run: ${channelClosures.join(',')}`);
  }
  const snapshot = await waitForSnapshot(connection, receipt, PROBE_TIMEOUT_MS);
  return {
    connection,
    channel,
    unsubscribe,
    route,
    snapshot,
    projectedReceiptPath,
  };
}

async function waitForMirror(
  channelId: string,
  messages: Map<string, TerminalBufferPayload>,
  _notify: () => void,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (messages.has(channelId)) return messages.get(channelId)!;
    await delay(50);
  }
  throw new Error('timed out waiting for probe buffer-sync mirror');
}

async function waitForSnapshot(
  connection: SessionConnection,
  receipt: FixtureReceipt,
  timeoutMs: number,
): Promise<TerminalSnapshotResultPayload> {
  const deadline = Date.now() + timeoutMs;
  let last: TerminalSnapshotResultPayload | null = null;
  while (Date.now() < deadline) {
    last = await connection.readSnapshot({
      backend: receipt.backend,
      stableId: receipt.stableId,
      maxLines: 200,
    });
    if (last.status === 'available') return last;
    await delay(100);
  }
  throw new Error(
    `probe snapshot did not become available: ${last?.status === 'unavailable' || last?.status === 'failed' ? last.status : 'missing'}`,
  );
}

function snapshotContains(snapshot: TerminalSnapshotResultPayload, needle: string) {
  if (snapshot.status !== 'available') return false;
  return snapshot.body.lines.some((line) => {
    if (!line || typeof line !== 'object' || !('t' in line)) return false;
    return String(line.t).includes(needle);
  });
}

function compactRouteDiagnostics(diagnostics: TraversalDiagnostics | null): CompactRoute {
  if (!diagnostics) throw new Error('API probe omitted traversal diagnostics');
  const pair = diagnostics.selectedIcePair;
  const local = pair?.local;
  const remote = pair?.remote;
  const path = diagnostics.resolvedPath ?? null;
  if (diagnostics.stage !== 'open' || !path || !RTC_PATHS.has(path)) {
    throw new Error(`API probe did not reach an open RTC route: stage=${diagnostics.stage} path=${String(path)}`);
  }
  if (!local?.candidateType || !remote?.candidateType) {
    throw new Error('API probe selected ICE pair is missing local or remote candidate type');
  }
  if (path === 'rtc-relay') {
    if (
      diagnostics.resolvedRelayTransport !== 'turn'
      || (local.candidateType !== 'relay' && remote.candidateType !== 'relay')
    ) {
      throw new Error('API probe rtc-relay did not select a TURN relay candidate pair');
    }
  } else if (
    diagnostics.resolvedRelayTransport !== 'direct'
    || local.candidateType === 'relay'
    || remote.candidateType === 'relay'
  ) {
    throw new Error('API probe rtc-direct selected TURN candidates');
  }
  return {
    observation: 'public-api-probe',
    stage: diagnostics.stage,
    path,
    relayTransport: diagnostics.resolvedRelayTransport ?? null,
    localCandidateType: local.candidateType,
    remoteCandidateType: remote.candidateType,
    localProtocol: local.protocol ?? null,
    remoteProtocol: remote.protocol ?? null,
    roundTripTimeMs: pair?.roundTripTimeMs ?? null,
  };
}

async function waitForCompactRoute(
  connection: SessionConnection,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return compactRouteDiagnostics(connection.getDiagnostics());
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('API probe did not expose RTC selected ICE facts');
}

function publicSelfcheck(value: PublicSelfcheck | null | undefined) {
  if (!value) return null;
  const localCandidateType = value.selectedIcePair?.local?.candidateType
    || value.selectedIcePair?.localCandidateType
    || null;
  const remoteCandidateType = value.selectedIcePair?.remote?.candidateType
    || value.selectedIcePair?.remoteCandidateType
    || null;
  return {
    ok: value.ok === true,
    path: value.path ?? null,
    relayTransport: value.relayTransport ?? null,
    localCandidateType,
    remoteCandidateType,
    muxReady: value.muxReady === true,
    ownedSessionVisible: value.ownedSessionVisible === true,
  };
}

function requireFixtureEvidence(publicReceipt: PublicFixtureReceipt) {
  if (publicReceipt.ok !== true || publicReceipt.selfcheck?.direct?.ok !== true) {
    throw new Error('RTC fixture did not report a ready direct selfcheck');
  }
  if (publicReceipt.selfcheck?.relay?.ok !== true) {
    throw new Error('RTC fixture did not report a ready TURN relay selfcheck');
  }
}

async function runRemoteCli(
  cliBin: string,
  receiptPath: string,
  ptyPackageRoot: string,
  evidenceDir: string,
  state: ControllerState,
  secrets: string[],
) {
  const binEvidence = join(evidenceDir, 'bin');
  mkdirSync(binEvidence, { recursive: true, mode: 0o700 });
  chmodSync(binEvidence, 0o700);
  const result = await runProcess(
    process.execPath,
    [
      remoteRunnerPath,
      '--receipt-file',
      receiptPath,
      '--cli-bin',
      cliBin,
      '--pty-package-root',
      ptyPackageRoot,
      '--evidence-dir',
      binEvidence,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env },
      timeoutMs: RUNNER_TIMEOUT_MS,
      onChild: (child) => {
        state.child = child;
      },
    },
  );
  writePrivateText(
    join(evidenceDir, 'remote-cli-run.stdout.log'),
    redactText(result.stdout, secrets),
  );
  writePrivateText(
    join(evidenceDir, 'remote-cli-run.stderr.log'),
    redactText(result.stderr, secrets),
  );
  const resultPath = join(binEvidence, REMOTE_CLI_RESULT_FILE);
  const runnerResult = existsSync(resultPath)
    ? JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>
    : null;
  try {
    requireProcessSuccess(result, 'remote-cli-blackbox', secrets);
  } catch (error) {
    Object.assign(error as Error, {
      runnerResult,
      resultPath,
    });
    throw error;
  }
  if (!runnerResult) {
    throw new Error('remote-cli-blackbox did not write its result');
  }
  return {
    result: runnerResult,
    resultPath,
  };
}

async function closeController(state: ControllerState) {
  const cleanup = {
    probeChannelClosed: true,
    probeConnectionClosed: true,
    fixtureClosed: true,
    proxyClosed: true,
    npmTempRemoved: true,
  };
  let fixtureFinalReceipt: PublicFixtureReceipt | null = null;
  try {
    state.unsubscribeProbe?.();
    state.unsubscribeProbe = null;
  } catch {
    state.probeConnection?.close('rtc-userpath-probe-cleanup');
  }
  try {
    state.probeChannel?.close('rtc-userpath-controller-cleanup');
  } catch {
    cleanup.probeChannelClosed = false;
  }
  try {
    state.probeConnection?.close('rtc-userpath-controller-complete');
  } catch {
    cleanup.probeConnectionClosed = false;
  }
  try {
    const finalReceipt = await state.fixture?.close();
    if (finalReceipt && typeof finalReceipt === 'object') {
      fixtureFinalReceipt = finalReceipt as PublicFixtureReceipt;
    }
  } catch {
    cleanup.fixtureClosed = false;
  }
  try {
    await state.proxy?.close();
  } catch {
    cleanup.proxyClosed = false;
  }
  if (state.tempRoot) {
    try {
      rmSync(state.tempRoot, { recursive: true, force: true });
    } catch {
      cleanup.npmTempRemoved = false;
    }
  }
  return {
    cleanup,
    fixtureFinalReceipt,
  };
}

async function main() {
  const evidenceDir = resolve(parseArgs(process.argv.slice(2)).evidenceDir);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  chmodSync(evidenceDir, 0o700);
  const state: ControllerState = {
    fixture: null,
    proxy: null,
    probeConnection: null,
    probeChannel: null,
    unsubscribeProbe: null,
    tempRoot: null,
    child: null,
  };
  const stages: StageRecord[] = [];
  let fixturePublic: PublicFixtureReceipt | null = null;
  let apiProbeDetails: ControllerResult['apiProbe'] = null;
  let binDetails: ControllerResult['bin'] = null;
  let cleanup: Record<string, unknown> = {};
  let firstDeviation: string | null = null;
  let secrets: string[] = [];

  const runStage = async <T extends Record<string, unknown> | void>(
    name: string,
    action: () => Promise<T>,
  ) => {
    const startedAt = isoTimestamp();
    const startedMs = Date.now();
    try {
      const details = await action();
      stages.push({
        name,
        status: 'passed',
        startedAt,
        durationMs: Date.now() - startedMs,
        ...(details === undefined
          ? {}
          : { details: details as Record<string, unknown> }),
      });
      return details;
    } catch (error) {
      firstDeviation ||= `${name}: ${redactText(errorMessage(error), secrets)}`;
      stages.push({
        name,
        status: 'failed',
        startedAt,
        durationMs: Date.now() - startedMs,
        error: redactText(errorMessage(error), secrets),
      });
      throw error;
    }
  };

  try {
    const options = parseArgs(process.argv.slice(2));
    const fixtureModule = await loadScriptModule<RtcFixtureModule>('./rtc-fixture.mjs');
    const platformModule = await loadScriptModule<PlatformSmokeHelperModule>(
      './platform-smoke-helper.mjs',
    );
    const remoteHelperModule = await loadScriptModule<RemoteCliHelperModule>(
      './remote-cli-blackbox-helper.mjs',
    );
    state.tempRoot = mkdtempSync(join(tmpdir(), 'zterm-rtc-userpath-'));
    const installed = await runStage('build-install', async () => {
      const initialSecrets = secrets;
      const result = await buildAndInstallCli(state.tempRoot!, evidenceDir, initialSecrets);
      return {
        builtFromActualMain: mainEntry,
        tarballToOwnedTemp: true,
        isolatedGlobalPrefix: result.npmPrefix,
        installedJavaScript: result.cliBin,
        installedLauncher: result.installedLauncher,
        version: result.version,
      } as const;
    });

    const fixtureStarted = await runStage('start-rtc-fixture', async () => {
      const fixture = await fixtureModule.startRtcFixture({
        evidenceDir,
        hold: true,
        exposeRelay: false,
        turnRequired: true,
        interactiveSession: options.interactiveSession,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      state.fixture = fixture;
      requireFixtureEvidence(fixture.publicReceipt);
      return {
        publicReceipt: fixture.publicReceipt as PublicFixtureReceipt,
      };
    });
    fixturePublic = fixtureStarted.publicReceipt;

    await remoteHelperModule.assertReceiptPrivacy(state.fixture!.receiptPath);
    const originalReceipt = readFixtureReceipt(state.fixture!.receiptPath);
    secrets = secretsForReceipt(originalReceipt);

    state.proxy = new DirectoryRewriteProxy(originalReceipt.relayBaseUrl);
    await state.proxy.start();
    const projectedPath = join(evidenceDir, 'private', 'projected-receipt.json');
    const projectedReceipt = {
      ...originalReceipt,
      relayBaseUrl: state.proxy.url,
    };
    writePrivateText(projectedPath, `${JSON.stringify(projectedReceipt, null, 2)}\n`);
    if ((statSync(projectedPath).mode & 0o777) !== 0o600) {
      throw new Error('projected private receipt is not mode 0600');
    }

    await runStage('api-probe-mirror', async () => {
      const probeReceipt = readFixtureReceipt(projectedPath);
      const probe = await openApiProbe(probeReceipt, projectedPath);
      state.probeConnection = probe.connection;
      state.probeChannel = probe.channel;
      state.unsubscribeProbe = probe.unsubscribe;
      const snapshotAvailable = snapshotContains(probe.snapshot, originalReceipt.runId);
      if (!snapshotAvailable) {
        throw new Error('probe snapshot did not contain the fixture runId marker');
      }
      apiProbeDetails = {
        route: probe.route,
        mirrorSubscribed: true,
        mirrorFixed: true,
        snapshotAvailable,
        inputSent: false,
        adaptiveLeaseHeld: false,
        postBinProbeOpen: false,
        postBinRemoteSessionPresent: false,
      };
      return {
        route: probe.route,
        mirrorSubscribed: true,
        snapshotAvailable,
        inputSent: false,
        adaptiveLeaseHeld: false,
      };
    });

    const ptyInstallation = platformModule.resolveNodePtyInstallation(
      join(options.ptyPackageRoot, 'package.json'),
    );
    const beforeDirectoryRequests = state.proxy.directoryRequests;
    const beforeWsReplacements = state.proxy.directWsCandidatesReplaced;
    const beforeRtcRetained = state.proxy.rtcCandidatesRetained;
    const binResult = await runStage('installed-bin-user-path', async () => {
      const recordRunnerResult = (
        result: Record<string, unknown>,
        resultFile: string,
      ) => {
        const outcome = result.outcome && typeof result.outcome === 'object'
          ? result.outcome as Record<string, unknown>
          : null;
        const scope = {
          directoryRequests: state.proxy!.directoryRequests - beforeDirectoryRequests,
          directWsCandidatesReplaced:
            state.proxy!.directWsCandidatesReplaced - beforeWsReplacements,
          rtcCandidatesRetained: state.proxy!.rtcCandidatesRetained - beforeRtcRetained,
        };
        binDetails = {
          resultFile,
          outcome,
          controlledCandidateScope: scope,
          routeObservation: 'not-instrumented-in-bin-process',
        };
        return { outcome, scope };
      };

      try {
        const runner = await runRemoteCli(
          installed.installedJavaScript,
          projectedPath,
          options.ptyPackageRoot,
          evidenceDir,
          state,
          secrets,
        );
        const { outcome, scope } = recordRunnerResult(
          runner.result,
          runner.resultPath,
        );
        if (outcome?.ok !== true || outcome?.state !== 'PASSED') {
          throw new Error(`remote-cli-blackbox outcome is not passed: ${JSON.stringify(outcome)}`);
        }
        if (runner.result.coverage !== 'remote-cli-user-path') {
          throw new Error(`remote-cli-blackbox coverage mismatch: ${String(runner.result.coverage)}`);
        }
        if (scope.directoryRequests < 1) {
          throw new Error('installed bin never read the controlled directory');
        }
        return {
          outcome,
          controlledCandidateScope: scope,
          ptyPackageRoot: options.ptyPackageRoot,
          ptyTuple: ptyInstallation.tuple,
        } as const;
      } catch (error) {
        const failedRun = error as Error & {
          runnerResult?: Record<string, unknown> | null;
          resultPath?: string;
        };
        if (failedRun.runnerResult && failedRun.resultPath) {
          recordRunnerResult(
            failedRun.runnerResult,
            failedRun.resultPath,
          );
        }
        throw error;
      }
    });

    await runStage('post-bin-probe-remains', async () => {
      if (!state.probeConnection || !state.probeChannel) {
        throw new Error('probe resources are missing');
      }
      if (state.probeConnection.state !== 'ready') {
        throw new Error(`probe connection is not ready after bin exit: ${state.probeConnection.state}`);
      }
      if (!state.probeConnection.channels.has(state.probeChannel.id)) {
        throw new Error('probe channel is absent after bin exit');
      }
      const sessions = await state.probeConnection.listSessions({ backend: 'tmux' });
      if (!sessions.sessions.includes(originalReceipt.sessionName)) {
        throw new Error('remote session is absent after bin exit');
      }
      const snapshot = await waitForSnapshot(
        state.probeConnection,
        originalReceipt,
        PROBE_TIMEOUT_MS,
      );
      if (!snapshotContains(snapshot, originalReceipt.runId)) {
        throw new Error('remote snapshot lost the fixture runId after bin exit');
      }
      apiProbeDetails = {
        ...apiProbeDetails!,
        postBinProbeOpen: true,
        postBinRemoteSessionPresent: true,
      };
      return {
        probeConnectionState: state.probeConnection.state,
        probeChannelPresent: true,
        remoteSessionPresent: true,
        snapshotAvailable: true,
      };
    });

    if (!binResult || !binResult.outcome) {
      throw new Error('installed bin stage returned no result');
    }
  } catch (error) {
    firstDeviation ||= redactText(errorMessage(error), secrets);
  } finally {
    const closed = await closeController(state);
    cleanup = closed.cleanup;
    if (closed.fixtureFinalReceipt) {
      fixturePublic = closed.fixtureFinalReceipt;
    }
    const cleanupDeviations = Object.entries(cleanup)
      .filter(([, complete]) => complete !== true)
      .map(([resource]) => resource);
    if (fixturePublic && fixturePublic.cleanup?.state !== 'complete') {
      cleanupDeviations.push(
        `fixture cleanup ${String(fixturePublic.cleanup?.state || 'missing')}`,
      );
    }
    if (cleanupDeviations.length > 0) {
      cleanup.deviations = cleanupDeviations;
      firstDeviation ||= `cleanup: ${cleanupDeviations.join(',')}`;
    }
    const result: ControllerResult = {
      schemaVersion: 1,
      state: firstDeviation ? 'failed' : 'passed',
      coverage: 'darwin-real-cli-rtc-business',
      generatedAt: isoTimestamp(),
      stages,
      fixture: fixturePublic
        ? {
            publicReceipt: state.fixture?.publicReceipt
              ? join(dirname(state.fixture.receiptPath), '..', 'public', 'receipt.json')
              : '',
            status: fixturePublic.status,
            state: fixturePublic.state,
            direct: publicSelfcheck(fixturePublic.selfcheck?.direct),
            relay: publicSelfcheck(fixturePublic.selfcheck?.relay),
            cleanup: fixturePublic.cleanup || {},
          }
        : null,
      apiProbe: apiProbeDetails,
      bin: binDetails,
      cleanup,
      firstDeviation,
    };
    writePrivateText(
      join(evidenceDir, 'rtc-userpath-result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }

  if (firstDeviation) {
    process.stderr.write(
      `rtc-userpath: FAILED: ${redactText(firstDeviation, secrets)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `rtc-userpath: PASSED coverage=darwin-real-cli-rtc-business evidence=${evidenceDir}\n`,
  );
}

await main();
