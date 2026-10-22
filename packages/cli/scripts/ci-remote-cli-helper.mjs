import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveNpmInvocation } from './process-entry.mjs';
import { spawnOwnedFixtureBridge } from './fixture-turn-bridge.mjs';
import {
  environmentSecrets,
  installedCliPackageRoot,
  redactText,
} from './platform-smoke-helper.mjs';
import { assertReceiptPrivacy } from './remote-cli-blackbox-helper.mjs';

export const CI_REMOTE_RECEIPT_ENV = 'ZTERM_CLI_E2E_RECEIPT_20261020';
export const CI_REMOTE_REQUIRED_ENV = 'ZTERM_REQUIRE_REMOTE_CLI';
export const CI_REMOTE_RESULT_FILE = 'ci-remote-cli-result.json';

export const CI_REMOTE_ARGUMENTS = Object.freeze([
  '--cli-tarball',
  '--daemon-payload-root',
  '--evidence-dir',
  '--private-receipt-dir',
]);

const REMOTE_USER_PATH_STAGE = 'remote-cli-user-path';
const RTC_CONSUMER_STAGE = 'rtc-consumer';
const COMMAND_TIMEOUT_MS = 20 * 60 * 1_000;
const NPM_TIMEOUT_MS = 5 * 60 * 1_000;
const SAFE_LOG_LIMIT = 8_000;
const TIMING_EVIDENCE_PREFIX = 'rtc-timing-evidence:';
const TIMING_EVIDENCE_LIMIT = 512;
const SENSITIVE_ENVIRONMENT_NAME =
  /(?:TOKEN|PASSWORD|SECRET|KEY|RECEIPT)/iu;
const SENSITIVE_RECEIPT_FIELD =
  /(?:token|password|secret|credential|authorization|key)/iu;

const RTC_TIMING_EVENTS = new Set([
  'ws.construct',
  'ws.open',
  'ws.close',
  'ws.error',
  'ws.send',
  'ws.receive',
  'network.socket',
  'network.lookup',
  'network.connect',
  'network.secureConnect',
  'pc.construct',
  'pc.close',
  'pc.first-relay-candidate',
  'datachannel.create',
  'datachannel.open',
  'datachannel.close',
  'iceconnectionstatechange',
  'connectionstatechange',
  'icegatheringstatechange',
  ...[
    'createOffer',
    'setLocalDescription',
    'setRemoteDescription',
    'addIceCandidate',
    'getStats',
  ].flatMap((method) => [
    `${method}.begin`,
    `${method}.end`,
    `${method}.error`,
  ]),
]);
const RTC_TIMING_TYPES = new Set([
  'rtc-init', 'rtc-offer', 'rtc-answer', 'rtc-candidate', 'rtc-error',
  'hello', 'mux-hello', 'ping', 'pong', 'other',
]);
const RTC_TIMING_STATES = new Set([
  'new',
  'checking',
  'connecting',
  'connected',
  'completed',
  'disconnected',
  'failed',
  'closed',
  'gathering',
  'complete',
  'open',
  'closing',
]);
const RTC_TIMING_KEYS = new Set([
  'event',
  'ms',
  'ws',
  'pc',
  'type',
  'state',
  'ice',
  'connection',
  'gathering',
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, '..');

export class CiRemoteContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CiRemoteContractError';
    this.code = code;
  }
}

function timestamp() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error) {
  return error instanceof CiRemoteContractError
    ? error.code
    : 'ci_remote_cli_error';
}

function requireValue(argv, index, name) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new CiRemoteContractError(
      'missing_argument_value',
      `${name} requires a value`,
    );
  }
  return value;
}

export function parseCiRemoteArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!CI_REMOTE_ARGUMENTS.includes(name)) {
      throw new CiRemoteContractError(
        'unknown_argument',
        `unknown argument: ${name}`,
      );
    }
    if (values.has(name)) {
      throw new CiRemoteContractError(
        'duplicate_argument',
        `duplicate argument: ${name}`,
      );
    }
    values.set(name, resolve(requireValue(argv, index + 1, name)));
    index += 1;
  }
  const missing = CI_REMOTE_ARGUMENTS.filter((name) => !values.has(name));
  if (missing.length > 0) {
    throw new CiRemoteContractError(
      'missing_argument',
      `missing required arguments: ${missing.join(', ')}`,
    );
  }
  return {
    cliTarball: values.get('--cli-tarball'),
    daemonPayloadRoot: values.get('--daemon-payload-root'),
    evidenceDir: values.get('--evidence-dir'),
    privateReceiptDir: values.get('--private-receipt-dir'),
  };
}

export function parseRequiredFlag(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return value;
  if (/^(?:1|true|yes)$/iu.test(String(value).trim())) return true;
  if (/^(?:0|false|no)$/iu.test(String(value).trim())) return false;
  throw new CiRemoteContractError(
    'invalid_required_flag',
    `${CI_REMOTE_REQUIRED_ENV} must be a boolean`,
  );
}

function requireRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new CiRemoteContractError(
      'missing_file',
      `${label} is missing or inaccessible`,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CiRemoteContractError(
      'invalid_file',
      `${label} must be a regular non-symlink file`,
    );
  }
}

function requireDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new CiRemoteContractError(
      'missing_directory',
      `${label} is missing or inaccessible`,
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CiRemoteContractError(
      'invalid_directory',
      `${label} must be a real directory`,
    );
  }
}

function assertOutside(parent, child, code, message) {
  const relation = relative(parent, child);
  if (
    relation === ''
    || (!relation.startsWith(`..${sep}`)
      && relation !== '..'
      && !isAbsolute(relation))
  ) {
    throw new CiRemoteContractError(code, message);
  }
}

function assertInside(parent, child, code, message) {
  const relation = relative(parent, child);
  if (
    relation === ''
    || relation === '..'
    || relation.startsWith(`..${sep}`)
    || isAbsolute(relation)
  ) {
    throw new CiRemoteContractError(code, message);
  }
}

export function normalizeReceiptText(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CiRemoteContractError(
      'receipt_secret_missing',
      `${CI_REMOTE_RECEIPT_ENV} is empty`,
    );
  }
  return value.startsWith('\uFEFF') ? value.slice(1) : value;
}

function readReceiptForRedaction(secret) {
  try {
    const value = JSON.parse(
      secret.startsWith('\uFEFF') ? secret.slice(1) : secret,
    );
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function collectSensitiveValues(value, field = '', output = []) {
  if (typeof value === 'string') {
    if (SENSITIVE_RECEIPT_FIELD.test(field) && value.length >= 4) {
      output.push(value);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSensitiveValues(entry, field, output);
    }
    return output;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      collectSensitiveValues(entry, key, output);
    }
  }
  return output;
}

export function receiptSecrets(secret, env = process.env) {
  const values = [
    secret,
    ...environmentSecrets(env),
    ...collectSensitiveValues(readReceiptForRedaction(secret)),
  ];
  return [...new Set(values.filter(
    (value) => typeof value === 'string' && value.length >= 4,
  ))];
}

function safeOutput(value, secrets) {
  const redacted = redactText(value || '', secrets);
  if (redacted.length <= SAFE_LOG_LIMIT) return redacted;
  return `[earlier output truncated]\n${redacted.slice(-SAFE_LOG_LIMIT)}`;
}

function writeSafeFile(path, value, secrets, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, safeOutput(value, secrets), {
    encoding: 'utf8',
    mode,
  });
  chmodSync(path, mode);
}

function writeSafeJson(path, value, secrets) {
  writeSafeFile(path, `${JSON.stringify(value, null, 2)}\n`, secrets);
}

export function createChildEnvironment(root, prefix, baseEnv = process.env) {
  const home = join(root, 'home');
  const temp = join(root, 'temp');
  const appData = join(home, 'AppData');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temp, { recursive: true, mode: 0o700 });
  mkdirSync(join(appData, 'Roaming'), { recursive: true, mode: 0o700 });
  mkdirSync(join(appData, 'Local'), { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([name]) =>
      !SENSITIVE_ENVIRONMENT_NAME.test(name)),
  );
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(appData, 'Roaming'),
    LOCALAPPDATA: join(appData, 'Local'),
    TEMP: temp,
    TMP: temp,
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_prefix: prefix,
    npm_config_userconfig: join(root, 'npmrc'),
    npm_config_globalconfig: join(root, 'global-npmrc'),
  };
}

export function resolveInstalledJsBin(prefix) {
  const packageRoot = realpathSync(installedCliPackageRoot(prefix));
  const manifestPath = join(packageRoot, 'package.json');
  requireRegularFile(manifestPath, 'installed CLI package manifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest?.name !== '@jsonstudio/zterm-cli') {
    throw new CiRemoteContractError(
      'installed_package_name_mismatch',
      'installed CLI package name is not @jsonstudio/zterm-cli',
    );
  }
  const manifestBin = typeof manifest.bin === 'string'
    ? manifest.bin
    : manifest.bin?.zterm;
  if (typeof manifestBin !== 'string' || manifestBin.trim().length === 0) {
    throw new CiRemoteContractError(
      'installed_bin_missing',
      'installed CLI manifest does not declare bin.zterm',
    );
  }
  if (isAbsolute(manifestBin)) {
    throw new CiRemoteContractError(
      'installed_bin_absolute',
      'installed CLI bin.zterm must be package-relative',
    );
  }
  const cliBin = realpathSync(join(packageRoot, manifestBin));
  assertInside(
    packageRoot,
    cliBin,
    'installed_bin_outside_package',
    'installed CLI bin.zterm resolves outside the package',
  );
  requireRegularFile(cliBin, 'installed CLI JavaScript bin');
  if (!/\.(?:c?js|mjs)$/iu.test(cliBin)) {
    throw new CiRemoteContractError(
      'installed_bin_not_javascript',
      'installed CLI bin.zterm must resolve to a JavaScript file',
    );
  }
  return {
    packageRoot,
    manifestPath,
    name: manifest.name,
    version: manifest.version,
    cliBin,
  };
}

export function resolveVitestCli() {
  const requireFromCli = createRequire(join(packageDir, 'package.json'));
  const manifestPath = requireFromCli.resolve('vitest/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string'
    ? manifest.bin
    : manifest.bin?.vitest;
  if (typeof bin !== 'string' || !bin.trim()) {
    throw new CiRemoteContractError(
      'vitest_bin_missing',
      'installed Vitest package does not declare bin.vitest',
    );
  }
  const entry = realpathSync(join(dirname(manifestPath), bin));
  requireRegularFile(entry, 'Vitest CLI entry');
  return entry;
}

const WINDOWS_PRIVATE_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = $env:REMOTE_CLI_PRIVATE_PATH
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
foreach ($sid in @($current, $system, $administrators)) {
  $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $allow)
  $acl.AddAccessRule($rule) | Out-Null
}
Set-Acl -LiteralPath $path -AclObject $acl
`;

export function protectWindowsPrivateFile(path, env = process.env) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PRIVATE_ACL_SCRIPT],
    {
      encoding: 'utf8',
      env: {
        ...createChildEnvironment(
          dirname(path),
          dirname(path),
          env,
        ),
        REMOTE_CLI_PRIVATE_PATH: path,
      },
      windowsHide: true,
      timeout: 30_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new CiRemoteContractError(
      'receipt_acl_protection_failed',
      'unable to protect the private receipt ACL before writing',
    );
  }
}

export function writePrivateReceipt({
  secret,
  privateReceiptDir,
  platform = process.platform,
  env = process.env,
}) {
  const text = normalizeReceiptText(secret);
  mkdirSync(privateReceiptDir, {
    recursive: true,
    mode: 0o700,
  });
  chmodSync(privateReceiptDir, 0o700);
  const runDir = mkdtempSync(join(privateReceiptDir, 'receipt-'));
  let complete = false;
  try {
    chmodSync(runDir, 0o700);
    const receiptPath = join(runDir, 'managed-receipt.json');
    const descriptor = openSync(receiptPath, 'wx', 0o600);
    closeSync(descriptor);
    chmodSync(receiptPath, 0o600);
    if (platform === 'win32') {
      protectWindowsPrivateFile(receiptPath, env);
    }
    writeFileSync(receiptPath, text, 'utf8');
    if (platform !== 'win32') chmodSync(receiptPath, 0o600);
    assertReceiptPrivacy(receiptPath, { platform });
    complete = true;
    return { receiptPath, runDir };
  } finally {
    if (!complete) {
      rmSync(runDir, { recursive: true, force: true });
    }
  }
}

export function runOwnedCommand(
  command,
  args,
  {
    cwd,
    env,
    timeoutMs = COMMAND_TIMEOUT_MS,
  },
) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    env,
    timeout: timeoutMs,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    command,
    args,
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.code === 'ETIMEDOUT',
    error: result.error
      ? { code: result.error.code || '', message: result.error.message }
      : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    durationMs: Date.now() - startedAt,
  };
}

function stageEntry(name, coverage) {
  return {
    name,
    coverage,
    status: 'not-run',
    actualOs: process.platform,
    exitCode: null,
    signal: null,
    timedOut: false,
  };
}

export function deriveCiRemoteOutcome({
  receiptPresent,
  required,
  setupPassed,
  stages,
  cleanupPassed,
}) {
  const gaps = [];
  if (!receiptPresent) {
    gaps.push(
      `${CI_REMOTE_RECEIPT_ENV} is not configured; Windows remote CLI is UNVERIFIED`,
    );
    return {
      state: required ? 'FAILED' : 'UNVERIFIED',
      ok: !required,
      gaps,
    };
  }
  if (!setupPassed) gaps.push('isolated CLI install or preflight failed');
  for (const stage of stages) {
    if (stage.status !== 'passed') {
      gaps.push(`${stage.name} did not pass`);
    }
  }
  if (!cleanupPassed) gaps.push('owned temporary resources were not fully removed');
  const ok = gaps.length === 0;
  return { state: ok ? 'PASSED' : 'FAILED', ok, gaps };
}

function readRemoteCliReport(evidenceDir) {
  const path = join(evidenceDir, 'remote-cli-result.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function summarizeVitestReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const testResults = Array.isArray(value.testResults)
    ? value.testResults.map((entry) => ({
        name: typeof entry?.name === 'string' ? basename(entry.name) : '',
        status: typeof entry?.status === 'string' ? entry.status : '',
        assertionResults: Array.isArray(entry?.assertionResults)
          ? entry.assertionResults.map((assertion) => ({
              title: typeof assertion?.title === 'string'
                ? assertion.title
                : '',
              status: typeof assertion?.status === 'string'
                ? assertion.status
                : '',
              ...(assertion?.status === 'failed' && Array.isArray(assertion.failureMessages)
                ? { failureMessages: assertion.failureMessages.filter(message => typeof message === 'string') }
                : {}),
            }))
          : [],
      }))
    : [];
  const assertions = testResults.flatMap((entry) => entry.assertionResults);
  return {
    success: value.success === true,
    numTotalTests: Number(value.numTotalTests || 0),
    numPassedTests: Number(value.numPassedTests || 0),
    numFailedTests: Number(value.numFailedTests || 0),
    numPendingTests: Number(value.numPendingTests || 0),
    passedAssertions: assertions.filter((entry) =>
      entry.status === 'passed').length,
    failedAssertions: assertions.filter((entry) =>
      entry.status === 'failed').length,
    skippedAssertions: assertions.filter((entry) =>
      entry.status === 'skipped' || entry.status === 'pending').length,
    routeEvidence: collectRouteEvidence(value),
    timingEvidence: collectTimingEvidence(value),
    testResults,
  };
}

export function externalRtcConsumerPassed(summary) {
  return Boolean(
    summary
    && summary.success === true
    && summary.numTotalTests >= 1
    && summary.numFailedTests === 0
    && summary.passedAssertions >= 1
    && summary.failedAssertions === 0
    && summary.skippedAssertions === 0
    && summary.routeEvidence?.some(line => {
      const evidence = JSON.parse(line.slice('rtc-route-evidence: '.length));
      return evidence.stage === 'open' && evidence.path === 'rtc-relay'
        && evidence.relayTransport === 'turn' && evidence.localCandidateType === 'relay'
        && evidence.remoteCandidateType === 'relay';
    }),
  );
}

function parseVitestReport(path) {
  if (!existsSync(path)) return null;
  try {
    return summarizeVitestReport(
      JSON.parse(readFileSync(path, 'utf8')),
    );
  } catch {
    return null;
  }
}

function stageFromCommand(stage, result, platform) {
  return {
    ...stage,
    status: result.exitCode === 0 && !result.error ? 'passed' : 'failed',
    actualOs: platform,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    errorCode: result.error?.code || '',
    error: safeOutput(result.error?.message || '', []),
  };
}

function commandExitMetadata(result) {
  return [
    `exitCode=${String(result.exitCode)}`,
    `signal=${String(result.signal)}`,
    `timedOut=${String(result.timedOut)}`,
    `durationMs=${String(result.durationMs)}`,
  ].join('\n');
}

function commandMetadata(result) {
  return [
    `command=${JSON.stringify([result.command, ...result.args])}`,
    commandExitMetadata(result),
  ].join('\n');
}

function commandLog(result) {
  return [
    commandMetadata(result),
    '',
    '[stdout]',
    result.stdout,
    '[stderr]',
    result.stderr,
  ].join('\n');
}

export function compactRouteEvidenceLine(line) {
  const prefix = 'rtc-route-evidence:';
  if (typeof line !== 'string' || !line.startsWith(prefix)) return '';
  try {
    const value = JSON.parse(line.slice(prefix.length).trim());
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const compact = Object.fromEntries(
      [
        'stage',
        'path',
        'relayTransport',
        'localCandidateType',
        'remoteCandidateType',
      ]
        .filter((field) => typeof value[field] === 'string')
        .map((field) => [field, value[field]]),
    );
    return Object.keys(compact).length > 0
      ? `${prefix} ${JSON.stringify(compact)}`
      : '';
  } catch {
    return '';
  }
}

function collectRouteEvidence(value, output = []) {
  if (typeof value === 'string') {
    for (const line of value.split(/\r?\n/u)) {
      const compact = compactRouteEvidenceLine(line);
      if (compact) output.push(compact);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectRouteEvidence(entry, output);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      collectRouteEvidence(entry, output);
    }
  }
  return output;
}

function timingFieldNumber(value, integer) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && (!integer || Number.isInteger(value));
}

export function projectTimingEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  if (Object.keys(value).some((key) => !RTC_TIMING_KEYS.has(key))) return null;
  if (!timingFieldNumber(value.ms, false)) return null;
  if (typeof value.event !== 'string' || !RTC_TIMING_EVENTS.has(value.event)) {
    return null;
  }
  const compact = { event: value.event };
  for (const field of ['ms', 'ws', 'pc']) {
    if (!(field in value)) continue;
    if (!timingFieldNumber(value[field], field !== 'ms')) return null;
    compact[field] = value[field];
  }
  for (const field of ['type', 'state', 'ice', 'connection', 'gathering']) {
    if (!(field in value)) continue;
    const entry = value[field];
    const allowed = field === 'type' ? RTC_TIMING_TYPES : RTC_TIMING_STATES;
    if (typeof entry !== 'string' || !allowed.has(entry)) return null;
    compact[field] = entry;
  }
  return compact;
}

export function compactTimingEvidenceLine(line) {
  if (typeof line !== 'string' || !line.startsWith(TIMING_EVIDENCE_PREFIX)) {
    return '';
  }
  const text = line.slice(TIMING_EVIDENCE_PREFIX.length).trim();
  if (!text) return '';
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return '';
  }
  const compact = projectTimingEvidence(value);
  return compact
    ? `${TIMING_EVIDENCE_PREFIX} ${JSON.stringify(compact)}`
    : '';
}

export function collectTimingEvidence(value, output = []) {
  const push = (compact) => {
    if (compact && output.length < TIMING_EVIDENCE_LIMIT) {
      output.push(compact);
    }
  };
  if (typeof value === 'string') {
    for (const line of value.split(/\r?\n/u)) {
      if (output.length >= TIMING_EVIDENCE_LIMIT) break;
      push(compactTimingEvidenceLine(line));
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (output.length >= TIMING_EVIDENCE_LIMIT) break;
      collectTimingEvidence(entry, output);
    }
    return output;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      if (output.length >= TIMING_EVIDENCE_LIMIT) break;
      collectTimingEvidence(entry, output);
    }
  }
  return output;
}

export function collectBridgeTimingEvidence(text) {
  const events = new Set(['tcp.accept', 'wss.construct', 'wss.open',
    'native.first-bytes', 'wss.first-bytes', 'tcp.close', 'wss.close', 'health',
    'reservation.ready', 'reservation.claim', 'reservation.failed']);
  const keys = new Set(['ms', 'event', 'connection', 'bytes', 'sequence']);
  const output = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith('rtc-bridge-timing: ')) continue;
    let value;
    try { value = JSON.parse(line.slice('rtc-bridge-timing: '.length)); }
    catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !keys.has(key)) || !events.has(value.event)
      || !timingFieldNumber(value.ms, true) || !timingFieldNumber(value.connection, true)
      || ('bytes' in value && !timingFieldNumber(value.bytes, true))
      || ('sequence' in value && !timingFieldNumber(value.sequence, true))) continue;
    output.push(value);
    if (output.length === 512) break;
  }
  return output;
}

export function rtcConsumerLog(result, routeEvidence, timingEvidence) {
  const merged = [
    ...collectRouteEvidence(result.stdout),
    ...(routeEvidence || []),
  ];
  const mergedTiming = [
    ...collectTimingEvidence(result.stdout),
    ...(timingEvidence || []),
  ].slice(0, TIMING_EVIDENCE_LIMIT);
  return [
    commandMetadata(result),
    '',
    '[safe-route-output]',
    ...[...new Set(merged)],
    '[safe-timing-output]',
    ...[...new Set(mergedTiming)],
    '[other-output-omitted]',
  ].join('\n');
}

function assertWin32(platform) {
  if (platform !== 'win32') {
    throw new CiRemoteContractError(
      'windows_runner_required',
      'managed Windows remote CLI acceptance must run on native win32',
    );
  }
}

export function createRemoteUserPathArgs({
  privateReceiptPath,
  cliBin,
  ptyPackageRoot,
  evidenceDir,
}) {
  return [
    '--receipt-file',
    privateReceiptPath,
    '--cli-bin',
    cliBin,
    '--pty-package-root',
    ptyPackageRoot,
    '--evidence-dir',
    evidenceDir,
  ];
}

export function createRtcConsumerEnvironment({
  baseEnv,
  privateReceiptPath,
  evidenceDir,
}) {
  return {
    ...baseEnv,
    ZTERM_RTC_FIXTURE_RECEIPT: privateReceiptPath,
    ZTERM_RTC_FIXTURE_EVIDENCE_DIR: evidenceDir,
  };
}

function runUserPathStage({
  privateReceiptPath,
  cliBin,
  daemonPayloadRoot,
  evidenceDir,
  env,
  platform,
  secrets,
  commandRunner,
}) {
  const stageDir = join(evidenceDir, REMOTE_USER_PATH_STAGE);
  mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  const runnerPath = join(scriptDir, 'remote-cli-blackbox.mjs');
  const result = commandRunner(
    process.execPath,
    [
      runnerPath,
      ...createRemoteUserPathArgs({
        privateReceiptPath,
        cliBin,
        ptyPackageRoot: join(daemonPayloadRoot, 'runtime', 'node_modules'),
        evidenceDir: stageDir,
      }),
    ],
    {
      cwd: stageDir,
      env,
    },
  );
  writeSafeFile(
    join(stageDir, 'ci-command.log'),
    commandExitMetadata(result),
    secrets,
  );
  const report = readRemoteCliReport(stageDir);
  const stage = stageFromCommand(
    stageEntry(REMOTE_USER_PATH_STAGE, 'remote-cli-user-path'),
    result,
    platform,
  );
  stage.resultState = typeof report?.outcome?.state === 'string'
    ? report.outcome.state
    : '';
  stage.coverage = typeof report?.coverage === 'string'
    ? report.coverage
    : stage.coverage;
  stage.actualOs = typeof report?.client?.os === 'string'
    ? report.client.os
    : stage.actualOs;
  if (
    stage.status === 'passed'
    && (
      stage.actualOs !== 'win32'
      || stage.resultState !== 'PASSED'
      || stage.coverage !== 'remote-cli-user-path'
    )
  ) {
    stage.status = 'failed';
    stage.errorCode = 'remote_user_path_report_invalid';
    stage.error = 'remote CLI report did not prove a Windows user-path pass';
  }
  return stage;
}

function runRtcConsumerStage({
  privateReceiptPath,
  evidenceDir,
  tempRoot,
  env,
  platform,
  secrets,
  commandRunner,
}) {
  const stageDir = join(evidenceDir, RTC_CONSUMER_STAGE);
  mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  const reportPath = join(tempRoot, 'vitest-result.json');
  const vitestEnv = createRtcConsumerEnvironment({
    baseEnv: env,
    privateReceiptPath,
    evidenceDir: stageDir,
  });
  const result = commandRunner(
    process.execPath,
    [
      resolveVitestCli(),
      'run',
      'src/application-liveconsumer.test.ts',
      '--reporter=json',
      '--outputFile',
      reportPath,
    ],
    {
      cwd: packageDir,
      env: vitestEnv,
    },
  );
  const summary = parseVitestReport(reportPath);
  // Vitest's JSON file omits direct process.stdout writes from the consumer.
  if (summary) {
    summary.routeEvidence = [...new Set([
      ...summary.routeEvidence,
      ...collectRouteEvidence(result.stdout),
    ])];
    summary.timingEvidence = [...new Set([
      ...summary.timingEvidence,
      ...collectTimingEvidence(result.stdout),
    ])].slice(0, TIMING_EVIDENCE_LIMIT);
  }
  writeSafeFile(
    join(stageDir, 'vitest-command.log'),
    rtcConsumerLog(
      result,
      summary?.routeEvidence || [],
      summary?.timingEvidence || collectTimingEvidence(result.stdout),
    ),
    secrets,
  );
  if (summary) {
    writeSafeJson(
      join(stageDir, 'vitest-summary.json'),
      summary,
      secrets,
    );
  }
  const stage = stageFromCommand(
    stageEntry(RTC_CONSUMER_STAGE, 'rtc-public-api-consumer'),
    result,
    platform,
  );
  const realPass = externalRtcConsumerPassed(summary);
  if (stage.status === 'passed' && !realPass) {
    stage.status = 'failed';
    stage.errorCode = 'rtc_consumer_not_executed';
    stage.error =
      'Vitest did not prove an executed TURN relay/relay consumer';
  }
  return stage;
}

function buildResult({
  platform,
  arch,
  nodeVersion,
  required,
  receiptPresent,
  setupPassed,
  stages,
  cleanupPassed,
  preflightError,
  preflightErrorCode,
}) {
  const outcome = deriveCiRemoteOutcome({
    receiptPresent,
    required,
    setupPassed,
    stages,
    cleanupPassed,
  });
  return {
    schemaVersion: 1,
    generatedAt: timestamp(),
    required,
    client: {
      os: platform,
      arch,
      node: nodeVersion,
      nativeWindowsProcess: platform === 'win32',
    },
    receipt: {
      present: receiptPresent,
      materialized: false,
    },
    setup: {
      passed: setupPassed,
      ...(preflightError ? { error: preflightError } : {}),
      ...(preflightErrorCode ? { errorCode: preflightErrorCode } : {}),
    },
    stages,
    cleanup: {
      passed: cleanupPassed,
      privateReceiptRemoved: false,
      tempPrefixRemoved: false,
      externalFixtureTouched: false,
    },
    outcome,
  };
}

export async function runCiRemoteCli({
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.version,
  commandRunner = runOwnedCommand,
  receiptWriter = writePrivateReceipt,
  bridgeSpawner = spawnOwnedFixtureBridge,
} = {}) {
  const options = parseCiRemoteArgs(argv);
  const required = parseRequiredFlag(env[CI_REMOTE_REQUIRED_ENV]);
  const rawSecret = env[CI_REMOTE_RECEIPT_ENV];
  const receiptPresent = (
    typeof rawSecret === 'string'
    && rawSecret.length > 0
  );
  mkdirSync(options.evidenceDir, { recursive: true, mode: 0o700 });
  chmodSync(options.evidenceDir, 0o700);
  const resultPath = join(options.evidenceDir, CI_REMOTE_RESULT_FILE);
  const stages = [
    stageEntry(REMOTE_USER_PATH_STAGE, 'remote-cli-user-path'),
    stageEntry(RTC_CONSUMER_STAGE, 'rtc-public-api-consumer'),
  ];
  let setupPassed = false;
  let preflightError;
  let preflightErrorCode;
  let secrets = [];
  let privateRunDir;
  let privateReceiptWritten = false;
  let tempRoot;
  let cleanupPassed = true;
  let privateReceiptRemoved = false;
  let tempPrefixRemoved = false;
  let bridge;
  let bridgeLogPath;
  let bridgeResult = { required: false, ready: false, closed: true };

  try {
    if (!receiptPresent) {
      if (required) {
        preflightError =
          `${CI_REMOTE_RECEIPT_ENV} is required but is not configured`;
      }
    } else {
      try {
        assertWin32(platform);
        requireRegularFile(options.cliTarball, 'platform-smoke CLI tarball');
        requireDirectory(
          options.daemonPayloadRoot,
          'daemon platform payload root',
        );
        assertOutside(
          options.evidenceDir,
          options.privateReceiptDir,
          'receipt_inside_evidence',
          'private receipt directory must be outside the uploaded evidence directory',
        );
        const secret = normalizeReceiptText(rawSecret);
        secrets = receiptSecrets(secret, env);
        const privateReceipt = receiptWriter({
          secret,
          privateReceiptDir: options.privateReceiptDir,
          platform,
          env,
        });
        privateRunDir = privateReceipt.runDir;
        privateReceiptWritten = true;
        const privateReceiptPath = privateReceipt.receiptPath;
        tempRoot = mkdtempSync(join(
          dirname(options.evidenceDir),
          'ci-remote-cli-work-',
        ));
        const prefix = join(tempRoot, 'prefix');
        mkdirSync(prefix, { recursive: true, mode: 0o700 });
        const childEnv = createChildEnvironment(tempRoot, prefix, env);
        assertOutside(
          options.evidenceDir,
          privateReceiptPath,
          'receipt_inside_evidence',
          'private receipt must be outside the uploaded evidence directory',
        );

        const npm = resolveNpmInvocation([
          'install',
          '--global',
          '--prefix',
          prefix,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          options.cliTarball,
        ], { env: childEnv });
        const install = commandRunner(npm.command, npm.args, {
          cwd: tempRoot,
          env: childEnv,
          timeoutMs: NPM_TIMEOUT_MS,
        });
        writeSafeFile(
          join(options.evidenceDir, 'isolated-cli-install.log'),
          commandLog(install),
          secrets,
        );
        if (install.error || install.exitCode !== 0) {
          throw new CiRemoteContractError(
            'isolated_cli_install_failed',
            'isolated platform-smoke CLI install failed',
          );
        }
        const installed = resolveInstalledJsBin(prefix);
        const receipt = JSON.parse(readFileSync(privateReceiptPath, 'utf8'));
        if (receipt.fixtureTransport) {
          const transport = receipt.fixtureTransport;
          if (transport.kind !== 'turn-tcp-over-authenticated-wss'
            || new URL(transport.bridgeUrl).protocol !== 'wss:'
            || typeof transport.token !== 'string' || !transport.token
            || !Number.isInteger(transport.listeningPort) || transport.listeningPort < 1 || transport.listeningPort > 65535) {
            throw new CiRemoteContractError('invalid_fixture_transport', 'invalid private fixture TURN bridge control');
          }
          bridgeResult = { required: true, kind: transport.kind, nativePublicUdpProved: false,
            ready: false, closed: false };
          const controlPath = join(privateRunDir, 'turn-client.json');
          writeFileSync(controlPath, JSON.stringify({ role: 'client', options: {
            listenHost: '127.0.0.1', listenPort: transport.listeningPort,
            bridgeUrl: transport.bridgeUrl, token: transport.token,
          } }), { mode: 0o600 });
          bridgeLogPath = join(privateRunDir, 'turn-client.log');
          bridge = bridgeSpawner({ role: 'client', controlPath, logPath: bridgeLogPath });
          bridgeResult.pid = bridge.pid;
          await bridge.ready;
          await bridge.assertHealthy();
          bridgeResult.ready = true;
        }
        setupPassed = true;

        stages[0] = runUserPathStage({
          privateReceiptPath,
          cliBin: installed.cliBin,
          daemonPayloadRoot: options.daemonPayloadRoot,
          evidenceDir: options.evidenceDir,
          env: childEnv,
          platform,
          secrets,
          commandRunner,
        });
        if (bridge) await bridge.assertHealthy();
        if (bridge) await bridge.prepareNextConnection();
        stages[1] = runRtcConsumerStage({
          privateReceiptPath,
          evidenceDir: options.evidenceDir,
          tempRoot,
          env: childEnv,
          platform,
          secrets,
          commandRunner,
        });
        if (bridge) await bridge.assertHealthy();
      } catch (error) {
        preflightError = safeOutput(errorMessage(error), secrets);
        preflightErrorCode = errorCode(error);
      }
    }
  } finally {
    if (bridge) {
      try {
        const closed = await bridge.close();
        bridgeResult.closed = closed.closed;
        if (closed.errors.length) bridgeResult.errors = closed.errors.map(error => safeOutput(error, secrets));
      } catch (error) {
        bridgeResult.closed = false;
        bridgeResult.errors = [safeOutput(errorMessage(error), secrets)];
      }
    }
    if (bridgeLogPath && existsSync(bridgeLogPath)) {
      bridgeResult.timingEvidence = collectBridgeTimingEvidence(readFileSync(bridgeLogPath, 'utf8'));
    }
    try {
      if (!bridgeResult.closed) {
        privateReceiptRemoved = false;
      } else if (privateRunDir) {
        rmSync(privateRunDir, { recursive: true, force: true });
        privateReceiptRemoved = !existsSync(privateRunDir);
      } else {
        privateReceiptRemoved = true;
      }
    } catch {
      privateReceiptRemoved = false;
    }
    try {
      if (!bridgeResult.closed) {
        tempPrefixRemoved = false;
      } else if (tempRoot) {
        rmSync(tempRoot, { recursive: true, force: true });
        tempPrefixRemoved = !existsSync(tempRoot);
      } else {
        tempPrefixRemoved = true;
      }
    } catch {
      tempPrefixRemoved = false;
    }
    cleanupPassed = privateReceiptRemoved && tempPrefixRemoved && bridgeResult.closed;
    delete env[CI_REMOTE_RECEIPT_ENV];
  }

  const result = buildResult({
    platform,
    arch,
    nodeVersion,
    required,
    receiptPresent,
    setupPassed,
    stages,
    cleanupPassed,
    preflightError,
    preflightErrorCode,
  });
  result.receipt.materialized = privateReceiptWritten;
  result.fixtureTransport = bridgeResult;
  result.cleanup.privateReceiptRemoved = privateReceiptRemoved;
  result.cleanup.tempPrefixRemoved = tempPrefixRemoved;
  if (preflightError && receiptPresent) {
    result.outcome.state = 'FAILED';
    result.outcome.ok = false;
    result.outcome.gaps = [
      preflightError,
      ...result.outcome.gaps,
    ];
  }
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(resultPath, 0o600);
  process.stdout.write(
    `ci-remote-cli: ${result.outcome.state} evidence=${options.evidenceDir}\n`,
  );
  if (result.outcome.ok) return 0;
  process.exitCode = 1;
  return 1;
}
