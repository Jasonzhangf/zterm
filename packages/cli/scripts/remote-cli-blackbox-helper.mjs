import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import {
  environmentSecrets,
  redactText,
  resolveNodePtyInstallation,
} from './platform-smoke-helper.mjs';

export const REMOTE_CLI_RESULT_FILE = 'remote-cli-result.json';

export const REMOTE_CLI_STAGES = Object.freeze([
  'preflight',
  'pty-prepare',
  'login-from-config',
  'slot-configure-preview',
  'numbered-mirror',
  'remote-marker-input',
  'adaptive-resize',
  'local-exit-restore',
  'logout',
  'post-logout-rejected',
]);

export const REMOTE_CLI_ARGUMENTS = Object.freeze([
  '--receipt-file',
  '--cli-bin',
  '--pty-package-root',
  '--evidence-dir',
]);

export const RECEIPT_FIELDS = Object.freeze([
  'schemaVersion',
  'runId',
  'managedTest',
  'relayBaseUrl',
  'username',
  'password',
  'deviceId',
  'daemonHostId',
  'sessionName',
  'backend',
  'stableId',
]);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const MARKER_CHARACTERS = /^[A-Za-z0-9_.:-]+$/u;
const ENVIRONMENT_SECRET_NAME = /(?:TOKEN|PASSWORD|SECRET|KEY)/iu;

export class RemoteCliContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RemoteCliContractError';
    this.code = code;
  }
}

export function parseRemoteCliArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!REMOTE_CLI_ARGUMENTS.includes(name)) {
      throw new RemoteCliContractError(
        'unknown_argument',
        `unknown argument: ${name}`,
      );
    }
    if (values.has(name)) {
      throw new RemoteCliContractError(
        'duplicate_argument',
        `duplicate argument: ${name}`,
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new RemoteCliContractError(
        'missing_argument_value',
        `${name} requires a value`,
      );
    }
    values.set(name, resolve(value));
    index += 1;
  }

  const missing = REMOTE_CLI_ARGUMENTS.filter((name) => !values.has(name));
  if (missing.length > 0) {
    throw new RemoteCliContractError(
      'missing_argument',
      `missing required arguments: ${missing.join(', ')}`,
    );
  }

  return {
    receiptFile: values.get('--receipt-file'),
    cliBin: values.get('--cli-bin'),
    ptyPackageRoot: values.get('--pty-package-root'),
    evidenceDir: values.get('--evidence-dir'),
  };
}

export function requireReadableFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new RemoteCliContractError(
      'missing_file',
      `${label} is missing or inaccessible`,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new RemoteCliContractError(
      'invalid_file',
      `${label} must be a regular non-symlink file`,
    );
  }
  return stat;
}

export function requireDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new RemoteCliContractError(
      'missing_directory',
      `${label} is missing or inaccessible`,
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RemoteCliContractError(
      'invalid_directory',
      `${label} must be a real directory`,
    );
  }
  return stat;
}

export function assertReceiptNotInsideEvidence(receiptFile, evidenceDir) {
  const receipt = realpathSync(receiptFile);
  const evidence = realpathSync(evidenceDir);
  const relation = relative(evidence, receipt);
  if (
    relation === ''
    || (!relation.startsWith('..') && !isAbsolute(relation))
  ) {
    throw new RemoteCliContractError(
      'receipt_inside_evidence',
      'private receipt must not be stored inside the upload evidence directory',
    );
  }
}

export function assertPosixReceiptMode(mode, platform = process.platform) {
  if (platform === 'win32') return;
  if ((mode & 0o777) !== 0o600) {
    throw new RemoteCliContractError(
      'receipt_not_private',
      'private receipt must have POSIX mode 0600',
    );
  }
}

export function windowsReceiptAclIsPrivate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const currentUserSid = requiredReceiptText(value.currentUserSid);
  const ownerSid = requiredReceiptText(value.ownerSid);
  if (!currentUserSid || !ownerSid) return false;
  const allowed = new Set([
    currentUserSid,
    'S-1-5-18',
    'S-1-5-32-544',
  ]);
  if (!allowed.has(ownerSid)) return false;
  if (!Array.isArray(value.entries)) return false;
  const allowEntries = value.entries.filter((entry) =>
    entry
    && typeof entry === 'object'
    && entry.accessType === 'Allow'
    && typeof entry.sid === 'string');
  if (!allowEntries.every((entry) => allowed.has(entry.sid))) {
    return false;
  }
  return allowEntries.some((entry) => entry.sid === currentUserSid);
}

export function readWindowsReceiptAcl(path) {
  const script = `
$ErrorActionPreference = 'Stop'
$path = $env:REMOTE_CLI_RECEIPT_PATH
$acl = Get-Acl -LiteralPath $path
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner = ([Security.Principal.NTAccount]$acl.Owner).Translate(
  [Security.Principal.SecurityIdentifier]
).Value
$entries = @($acl.Access | ForEach-Object {
  [pscustomobject]@{
    sid = $_.IdentityReference.Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
    accessType = $_.AccessControlType.ToString()
    rights = $_.FileSystemRights.ToString()
  }
})
[pscustomobject]@{
  currentUserSid = $current
  ownerSid = $owner
  entries = $entries
} | ConvertTo-Json -Depth 5 -Compress
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: Object.fromEntries([
        ...Object.entries(process.env).filter(([name]) =>
          !ENVIRONMENT_SECRET_NAME.test(name)),
        ['REMOTE_CLI_RECEIPT_PATH', path],
      ]),
      windowsHide: true,
      timeout: 15_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new RemoteCliContractError(
      'receipt_acl_unreadable',
      'unable to read private receipt Windows ACL',
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new RemoteCliContractError(
      'receipt_acl_invalid',
      'private receipt Windows ACL response was invalid',
    );
  }
}

export function assertReceiptPrivacy(
  path,
  {
    platform = process.platform,
    mode = undefined,
    aclReader = readWindowsReceiptAcl,
  } = {},
) {
  const stat = requireReadableFile(path, 'receipt file');
  if (platform === 'win32') {
    const acl = aclReader(path);
    if (!windowsReceiptAclIsPrivate(acl)) {
      throw new RemoteCliContractError(
        'receipt_not_private',
        'private receipt ACL permits a principal outside the test owner',
      );
    }
    return { kind: 'windows-acl', verified: true };
  }
  assertPosixReceiptMode(mode ?? stat.mode, platform);
  return { kind: 'posix-mode-0600', verified: true };
}

export function readManagedReceiptFile(path) {
  requireReadableFile(path, 'receipt file');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new RemoteCliContractError(
      'receipt_invalid_json',
      'receipt file is not valid JSON',
    );
  }
  return validateManagedReceipt(parsed);
}

export function validateManagedReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteCliContractError(
      'receipt_invalid',
      'receipt must be a JSON object',
    );
  }
  for (const field of RECEIPT_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      throw new RemoteCliContractError(
        'receipt_missing_field',
        `receipt is missing ${field}`,
      );
    }
  }
  if (value.schemaVersion !== 1) {
    throw new RemoteCliContractError(
      'receipt_schema_invalid',
      'receipt schemaVersion must be 1',
    );
  }
  if (value.managedTest !== true) {
    throw new RemoteCliContractError(
      'receipt_not_managed_test',
      'receipt must explicitly declare managedTest: true',
    );
  }
  if (value.backend !== 'tmux') {
    throw new RemoteCliContractError(
      'receipt_backend_invalid',
      'receipt backend must be tmux',
    );
  }

  const runId = requireSafeText(value.runId, 'runId', 160);
  if (!MARKER_CHARACTERS.test(runId)) {
    throw new RemoteCliContractError(
      'receipt_run_id_invalid',
      'receipt runId contains unsupported characters',
    );
  }
  const relayBaseUrl = requireRelayBaseUrl(value.relayBaseUrl);
  const username = requireSafeText(value.username, 'username', 512);
  const password = requireSafeText(value.password, 'password', 4_096);
  const deviceId = requireSafeText(value.deviceId, 'deviceId', 512);
  const daemonHostId = requireSafeText(value.daemonHostId, 'daemonHostId', 512);
  const sessionName = requireSafeText(value.sessionName, 'sessionName', 512);
  const stableId = requireSafeText(value.stableId, 'stableId', 1_024);

  return {
    schemaVersion: 1,
    runId,
    managedTest: true,
    relayBaseUrl,
    username,
    password,
    deviceId,
    daemonHostId,
    sessionName,
    backend: 'tmux',
    stableId,
  };
}

function requireSafeText(value, label, maxLength) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || CONTROL_CHARACTERS.test(value)
  ) {
    throw new RemoteCliContractError(
      'receipt_field_invalid',
      `receipt ${label} is invalid`,
    );
  }
  return value;
}

function requiredReceiptText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function requireRelayBaseUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RemoteCliContractError(
      'receipt_field_invalid',
      'receipt relayBaseUrl is invalid',
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new RemoteCliContractError(
      'receipt_field_invalid',
      'receipt relayBaseUrl is not a URL',
    );
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.search
    || parsed.hash
  ) {
    throw new RemoteCliContractError(
      'receipt_field_invalid',
      'receipt relayBaseUrl must be an http(s) URL without query or fragment',
    );
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

export function resolveRemoteNodePty(ptyPackageRoot) {
  requireDirectory(ptyPackageRoot, 'pty package root');
  const resolvedRoot = realpathSync(ptyPackageRoot);
  const resolutionBase = join(
    resolvedRoot,
    '__remote_cli_blackbox_resolution__.cjs',
  );
  const installation = resolveNodePtyInstallation(resolutionBase);
  if (!existsSync(installation.entry)) {
    throw new RemoteCliContractError(
      'node_pty_missing',
      'node-pty package entry is missing',
    );
  }
  return installation;
}

export function createIsolatedEnvironment(
  root,
  baseEnvironment = process.env,
  platform = process.platform,
) {
  const home = join(root, 'home');
  const appData = join(home, 'AppData');
  const tmp = join(root, 'tmp');
  const npmCache = join(root, 'npm-cache');
  const npmPrefix = join(root, 'npm-prefix');
  const npmConfig = join(root, 'npmrc');
  for (const directory of [
    home,
    appData,
    tmp,
    npmCache,
    npmPrefix,
    join(home, '.config'),
    join(home, '.cache'),
    join(home, '.local', 'share'),
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writeFileSync(npmConfig, '', { mode: 0o600 });

  const env = { ...baseEnvironment };
  for (const name of Object.keys(env)) {
    if (ENVIRONMENT_SECRET_NAME.test(name)) delete env[name];
  }
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;

  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    npm_config_cache: npmCache,
    npm_config_prefix: npmPrefix,
    npm_config_userconfig: npmConfig,
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_PREFIX: npmPrefix,
    NPM_CONFIG_USERCONFIG: npmConfig,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ENV: platform === 'win32' ? env.ENV || '' : '/dev/null',
  });
  if (platform === 'win32') {
    env.APPDATA = join(appData, 'Roaming');
    env.LOCALAPPDATA = join(appData, 'Local');
    mkdirSync(env.APPDATA, { recursive: true, mode: 0o700 });
    mkdirSync(env.LOCALAPPDATA, { recursive: true, mode: 0o700 });
  }
  env.PATH = [
    dirname(process.execPath),
    env.PATH || '',
  ].filter(Boolean).join(platform === 'win32' ? ';' : ':');

  return {
    env,
    home,
    configPath: join(home, '.zterm', 'config.json'),
    npmCache,
    npmPrefix,
    npmConfig,
    tmp,
  };
}

export function writeIsolatedLoginConfig(configPath, receipt) {
  const directory = dirname(configPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const body = {
    zterm: {
      cli: {
        server: {
          relayBaseUrl: receipt.relayBaseUrl,
        },
        loginInput: {
          username: receipt.username,
          password: receipt.password,
        },
      },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(body, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(configPath, 0o600);
  return body;
}

export function inspectCliConfig(configPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new RemoteCliContractError(
      'isolated_config_invalid',
      'isolated CLI config is unreadable or invalid',
    );
  }
  const zterm = objectAt(objectAt(parsed, 'config').zterm, 'zterm');
  const cliObject = objectAt(zterm.cli, 'cli');
  const auth = cliObject.auth && typeof cliObject.auth === 'object'
    && !Array.isArray(cliObject.auth)
    ? cliObject.auth
    : null;
  const loginInput = cliObject.loginInput
    && typeof cliObject.loginInput === 'object'
    && !Array.isArray(cliObject.loginInput)
    ? cliObject.loginInput
    : null;
  return {
    hasAuth: Boolean(auth),
    loginPasswordPresent: Boolean(
      loginInput && Object.hasOwn(loginInput, 'password'),
    ),
    loginUsernamePreserved: Boolean(
      loginInput && typeof loginInput.username === 'string',
    ),
    accessToken: auth && typeof auth.accessToken === 'string'
      ? auth.accessToken
      : '',
    slot1: readOptionalSlot(cliObject, 1),
  };
}

function readOptionalSlot(cli, slot) {
  if (
    !cli.slots
    || typeof cli.slots !== 'object'
    || Array.isArray(cli.slots)
    || !cli.slots[String(slot)]
  ) {
    return null;
  }
  return readSlot(cli, slot);
}

function readSlot(cli, slot) {
  const slots = objectAt(cli.slots, 'slots');
  const binding = objectAt(slots[String(slot)], `slot ${slot}`);
  const account = objectAt(binding.account, 'slot account');
  const server = objectAt(binding.server, 'slot server');
  const session = objectAt(binding.session, 'slot session');
  return {
    accountRelayBaseUrl: typeof account.relayBaseUrl === 'string'
      ? account.relayBaseUrl
      : '',
    deviceId: typeof server.deviceId === 'string' ? server.deviceId : '',
    daemonHostId: typeof server.daemonHostId === 'string'
      ? server.daemonHostId
      : '',
    sessionName: typeof session.name === 'string' ? session.name : '',
    backend: typeof session.backend === 'string' ? session.backend : '',
    stableId: typeof session.stableId === 'string' ? session.stableId : '',
    widthMode: typeof binding.widthMode === 'string' ? binding.widthMode : '',
  };
}

function objectAt(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteCliContractError(
      'isolated_config_invalid',
      `isolated CLI config ${label} is invalid`,
    );
  }
  return value;
}

export function assertSlotMatchesReceipt(slot, receipt) {
  const expected = {
    accountRelayBaseUrl: receipt.relayBaseUrl,
    deviceId: receipt.deviceId,
    daemonHostId: receipt.daemonHostId,
    sessionName: receipt.sessionName,
    backend: receipt.backend,
    stableId: receipt.stableId,
    widthMode: 'adaptive-phone',
  };
  for (const [field, value] of Object.entries(expected)) {
    if (slot[field] !== value) {
      throw new RemoteCliContractError(
        'slot_binding_mismatch',
        `slot 1 ${field} does not match the managed receipt`,
      );
    }
  }
}

export function projectVisibleTerminalText(value) {
  return String(value)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r/gu, '');
}

export function parsePromptChoices(value) {
  const visible = projectVisibleTerminalText(value);
  return [...visible.matchAll(/^\s*([1-9]\d*)\.\s+(.+?)\s*$/gmu)].map(
    (match) => ({
      index: Number(match[1]),
      label: match[2],
    }),
  );
}

export function chooseExactServer(output, deviceId) {
  const matches = parsePromptChoices(output).filter((choice) =>
    choice.label.endsWith(` · ${deviceId}`));
  if (matches.length !== 1) {
    throw new RemoteCliContractError(
      'server_choice_ambiguous',
      `expected one managed server choice, found ${matches.length}`,
    );
  }
  return matches[0].index;
}

export function chooseExactSession(output, receipt) {
  const prefix = `${receipt.sessionName} · ${receipt.backend} · ${receipt.stableId}`;
  const matches = parsePromptChoices(output).filter((choice) =>
    choice.label === prefix);
  if (matches.length !== 1) {
    throw new RemoteCliContractError(
      'session_choice_ambiguous',
      `expected one managed session choice, found ${matches.length}`,
    );
  }
  return matches[0].index;
}

export function markerForRun(runId) {
  const digest = createHash('sha256')
    .update(String(runId), 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `ZTERM_REMOTE_INPUT_${digest}`;
}

export function buildOctalPrintfCommand(marker) {
  if (typeof marker !== 'string' || !/^[\x20-\x7e]+$/u.test(marker)) {
    throw new RemoteCliContractError(
      'marker_invalid',
      'marker must be printable ASCII',
    );
  }
  const octal = [...Buffer.from(`${marker}\n`, 'utf8')]
    .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
    .join('');
  return `printf '${octal}'`;
}

export function decodeOctalPrintfCommand(command) {
  const match = /^printf '((?:\\[0-7]{3})+)'$/u.exec(command);
  if (!match) {
    throw new RemoteCliContractError(
      'octal_command_invalid',
      'command is not a strict octal printf command',
    );
  }
  const bytes = [...match[1].matchAll(/\\([0-7]{3})/gu)].map((entry) =>
    Number.parseInt(entry[1], 8));
  return Buffer.from(bytes).toString('utf8');
}

export function deriveRemoteCliOutcome(stages, cleanup) {
  const failed = stages.filter((stage) => stage.status === 'failed');
  if (failed.length > 0) {
    return {
      ok: false,
      state: 'FAILED',
      gaps: failed.map((stage) => `${stage.stage}:${stage.error || 'failed'}`),
    };
  }
  const notPassed = stages.filter((stage) => stage.status !== 'passed');
  if (notPassed.length > 0) {
    return {
      ok: false,
      state: 'FAILED',
      gaps: notPassed.map((stage) => `${stage.stage}:${stage.status}`),
    };
  }
  const stageCounts = new Map();
  for (const stage of stages) {
    stageCounts.set(stage.stage, (stageCounts.get(stage.stage) || 0) + 1);
  }
  if (
    stages.length !== REMOTE_CLI_STAGES.length
    || REMOTE_CLI_STAGES.some((stage) => stageCounts.get(stage) !== 1)
  ) {
    return {
      ok: false,
      state: 'FAILED',
      gaps: ['stage-set:incomplete'],
    };
  }
  if (!cleanup?.cleaned) {
    return {
      ok: false,
      state: 'FAILED',
      gaps: ['cleanup:failed'],
    };
  }
  return { ok: true, state: 'PASSED', gaps: [] };
}

export function secretValues(receipt, env = process.env, extra = []) {
  return [...new Set([
    receipt.password,
    ...environmentSecrets(env),
    ...extra,
  ].filter((value) => typeof value === 'string' && value.length >= 4))];
}

export function sanitizeForEvidence(value, secrets) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForEvidence(entry, secrets));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeForEvidence(entry, secrets),
      ]),
    );
  }
  return value;
}

export function writeEvidenceJson(evidenceDir, name, value, secrets) {
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const path = join(evidenceDir, name);
  const body = `${JSON.stringify(
    sanitizeForEvidence(value, secrets),
    null,
    2,
  )}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function publicClientInfo(
  platform = process.platform,
  arch = process.arch,
  version = process.version,
) {
  return {
    os: platform,
    arch,
    node: version,
    nativeWindowsProcess: platform === 'win32',
  };
}

export function publicTargetInfo(receipt) {
  return {
    runId: receipt.runId,
    managedTest: receipt.managedTest,
    deviceId: receipt.deviceId,
    daemonHostId: receipt.daemonHostId,
    sessionName: receipt.sessionName,
    backend: receipt.backend,
    stableId: receipt.stableId,
  };
}

export function ensureNodeVersion(minimumMajor = 22) {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isSafeInteger(major) || major < minimumMajor) {
    throw new RemoteCliContractError(
      'node_version_unsupported',
      `Node ${minimumMajor} or newer is required`,
    );
  }
}

export function readTerminalModeObservation(output, marker) {
  const prefix = `${marker}:`;
  for (const line of output.replace(/\r/gu, '').split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length);
    if (/^(?:gfmt1:|[0-9a-f]+:)/u.test(value)) return value;
  }
  return '';
}

export function ensureCliBin(cliBin) {
  requireReadableFile(cliBin, 'installed CLI JavaScript file');
  if (!statSync(cliBin).isFile()) {
    throw new RemoteCliContractError(
      'cli_bin_invalid',
      'installed CLI JavaScript file is invalid',
    );
  }
  return realpathSync(cliBin);
}
