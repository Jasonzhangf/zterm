import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, arch as processArch, platform as processPlatform } from 'node:os';
import { basename, isAbsolute, join, resolve, win32 } from 'node:path';
import {
  DEFAULT_NPM_REGISTRY,
  resolveNpmGlobalPrefix,
  spawnProcess,
  type ProcessResult,
  type ProcessRunner,
  type PublicError,
} from './release.js';

export const DAEMON_PACKAGE_NAME = '@jsonstudio/zterm-daemon';
export const DAEMON_PAYLOAD_PACKAGES = {
  'darwin-arm64': '@jsonstudio/zterm-daemon-darwin-arm64',
  'linux-x64': '@jsonstudio/zterm-daemon-linux-x64',
  'win32-x64': '@jsonstudio/zterm-daemon-win32-x64',
} as const;

export interface DaemonPackageManifest {
  schemaVersion: number;
  package: {
    name: string;
    version: string;
  };
  platform: {
    os: NodeJS.Platform;
    arch: string;
    node: {
      minimum: string;
      abi: string;
    };
  };
  runtimeComponents: string[];
}

interface DaemonPublicManifest {
  name: string;
  version: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export type DaemonInstallPhase = 'resolve' | 'download' | 'stage' | 'publish-shim' | 'verify';

export interface DaemonInstallResult {
  phase: DaemonInstallPhase;
  installedVersion?: string;
  payloadPackage?: string;
  payloadPath?: string;
  commandAvailable: boolean | 'unknown';
  filesWritten: string[];
  previousEntryPreserved: boolean | 'unknown';
  userShims?: string[];
  error?: PublicError;
}

export interface DaemonInstallOptions {
  homeDir?: string;
  prefix?: string;
  version?: string;
  registry?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  nodeAbi?: string;
  stagingDir?: string;
  packageManager?: string;
  runner?: ProcessRunner;
  signal?: AbortSignal;
}

export interface DaemonCommandOptions {
  homeDir?: string;
  prefix?: string;
  platform?: NodeJS.Platform;
  packageManager?: string;
  runner?: ProcessRunner;
  signal?: AbortSignal;
}

export interface DaemonCommandResult extends ProcessResult {
  state: 'observed' | 'legacy_migration_required' | 'entry_unavailable';
}

function publicError(code: string, message: string): PublicError {
  return { code, message };
}

function processError(result: ProcessResult): string {
  return result.error?.message || result.stderr.trim() || result.stdout.trim() || 'unknown error';
}

function successful(result: ProcessResult): boolean {
  return result.exitCode === 0 && !result.signal && !result.error;
}

function parseNodeVersion(version: string): [number, number, number] | undefined {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

function nodeVersionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = parseNodeVersion(actual);
  const minimumParts = parseNodeVersion(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
}

export function daemonGlobalEntryPath(
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? win32.join(prefix, 'zterm-daemon.cmd')
    : join(prefix, 'bin/zterm-daemon');
}

export function daemonPackageRoot(
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? win32.join(prefix, 'node_modules', '@jsonstudio', 'zterm-daemon')
    : join(prefix, 'lib', 'node_modules', '@jsonstudio', 'zterm-daemon');
}

export function stagedDaemonPackageRoot(stagingDir: string): string {
  return join(stagingDir, 'node_modules', '@jsonstudio', 'zterm-daemon');
}

export function daemonPayloadPackageName(
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  return DAEMON_PAYLOAD_PACKAGES[`${platform}-${arch}` as keyof typeof DAEMON_PAYLOAD_PACKAGES];
}

export function daemonPayloadPackageRoot(
  nodeModulesRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  const payloadName = daemonPayloadPackageName(platform, arch);
  return payloadName
    ? join(nodeModulesRoot, ...payloadName.split('/'))
    : undefined;
}

export function daemonPayloadComponents(
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const tuple = `${platform}-${arch}`;
  const components = [
    'runtime/server.cjs',
    'runtime/dagpipe.node',
    'runtime/node_modules/node-pty',
    'runtime/node_modules/@roamhq/wrtc',
    `runtime/node_modules/@roamhq/wrtc-${tuple}/wrtc.node`,
    'support/terminal-config-command.cjs',
  ];
  if (platform === 'win32') {
    components.push('support/windows/zterm-daemon.ps1');
  } else {
    components.push('support/zterm-daemon.sh');
  }
  if (platform === 'darwin') {
    components.push('support/zterm-daemon');
  }
  return components;
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function validatePublicManifest(
  manifest: DaemonPublicManifest,
  requestedVersion?: string,
): PublicError | undefined {
  if (
    manifest.name !== DAEMON_PACKAGE_NAME ||
    typeof manifest.version !== 'string' ||
    !manifest.bin ||
    typeof manifest.bin['zterm-daemon'] !== 'string' ||
    typeof manifest.bin.wterm !== 'string'
  ) {
    return publicError(
      'daemon_public_package_manifest_invalid',
      'daemon public package manifest is missing name, version, or official bins',
    );
  }
  if (requestedVersion && requestedVersion !== 'latest' && manifest.version !== requestedVersion) {
    return publicError(
      'daemon_package_version_mismatch',
      `requested daemon ${requestedVersion}, installed public package ${manifest.version}`,
    );
  }
  const optionalDependencies = manifest.optionalDependencies ?? {};
  const expectedPayloads = Object.values(DAEMON_PAYLOAD_PACKAGES).sort();
  const actualPayloads = Object.keys(optionalDependencies).sort();
  if (
    JSON.stringify(actualPayloads) !== JSON.stringify(expectedPayloads) ||
    Object.values(optionalDependencies).some((version) => version !== manifest.version)
  ) {
    return publicError(
      'daemon_optional_dependencies_invalid',
      `daemon public package must declare exactly ${expectedPayloads.join(', ')} at ${manifest.version}`,
    );
  }
  if (Object.keys(manifest.dependencies ?? {}).length > 0) {
    return publicError(
      'daemon_public_package_dependencies_invalid',
      'daemon public package must not declare regular runtime dependencies',
    );
  }
  return undefined;
}

interface ResolvedDaemonPayload {
  payloadName: string;
  payloadRoot: string;
  manifest: DaemonPackageManifest;
}

function resolveDaemonPayload(
  publicPackageRoot: string,
  publicManifest: DaemonPublicManifest,
  platform: NodeJS.Platform,
  arch: string,
  nodeVersion: string,
  nodeAbi: string,
): ResolvedDaemonPayload | PublicError {
  const payloadName = daemonPayloadPackageName(platform, arch);
  if (!payloadName) {
    return publicError(
      'daemon_platform_mismatch',
      `daemon package has no payload for ${platform}-${arch}`,
    );
  }
  const resolver = createRequire(join(publicPackageRoot, 'package.json'));
  let manifestPath: string;
  try {
    manifestPath = resolver.resolve(`${payloadName}/package.json`);
  } catch {
    return publicError(
      'daemon_payload_missing',
      `daemon public package has no installed ${payloadName}@${publicManifest.version} payload`,
    );
  }
  const payloadRoot = resolve(manifestPath, '..');
  const payloadPackage = readJson<{ name?: string; version?: string }>(manifestPath);
  if (
    !payloadPackage ||
    payloadPackage.name !== payloadName ||
    payloadPackage.version !== publicManifest.version
  ) {
    return publicError(
      'daemon_payload_identity_mismatch',
      `installed payload must be ${payloadName}@${publicManifest.version}`,
    );
  }

  const manifest = readJson<DaemonPackageManifest>(join(payloadRoot, 'zterm-package.json'));
  if (!manifest) {
    return publicError(
      'daemon_payload_manifest_missing',
      `daemon payload has no readable manifest at ${join(payloadRoot, 'zterm-package.json')}`,
    );
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.package?.name !== payloadName ||
    manifest.package?.version !== publicManifest.version
  ) {
    return publicError(
      'daemon_package_manifest_invalid',
      `daemon payload manifest must identify ${payloadName}@${publicManifest.version}`,
    );
  }
  if (manifest.platform?.os !== platform || manifest.platform?.arch !== arch) {
    return publicError(
      'daemon_platform_mismatch',
      `daemon payload targets ${manifest.platform?.os}-${manifest.platform?.arch}; current host is ${platform}-${arch}`,
    );
  }
  if (!nodeVersionAtLeast(nodeVersion, manifest.platform?.node?.minimum ?? '')) {
    return publicError(
      'daemon_node_version_mismatch',
      `daemon payload requires Node ${manifest.platform?.node?.minimum}; current Node is ${nodeVersion}`,
    );
  }
  if (manifest.platform?.node?.abi !== nodeAbi) {
    return publicError(
      'daemon_node_abi_mismatch',
      `daemon payload targets Node ABI ${manifest.platform?.node?.abi}; current ABI is ${nodeAbi}`,
    );
  }

  const declaredComponents = new Set(manifest.runtimeComponents ?? []);
  const missingComponent = daemonPayloadComponents(platform, arch).find(
    (component) =>
      !declaredComponents.has(component) ||
      isAbsolute(component) ||
      !existsSync(join(payloadRoot, component)),
  );
  if (missingComponent) {
    return publicError(
      'daemon_runtime_component_missing',
      `daemon payload is missing required component: ${missingComponent}`,
    );
  }
  return { payloadName, payloadRoot, manifest };
}

async function verifyPayloadNativeLoading(
  payload: ResolvedDaemonPayload,
  platform: NodeJS.Platform,
  arch: string,
  runner: ProcessRunner,
  signal?: AbortSignal,
): Promise<PublicError | undefined> {
  const loadScript = `
const { createRequire } = require('node:module');
const { join } = require('node:path');
const payloadRoot = process.argv[1];
const platform = process.argv[2];
const arch = process.argv[3];
const runtimeRoot = join(payloadRoot, 'runtime');
const load = createRequire(join(runtimeRoot, 'server.cjs'));
load('node-pty');
load('@roamhq/wrtc');
load('@roamhq/wrtc-' + platform + '-' + arch + '/wrtc.node');
load(join(runtimeRoot, 'dagpipe.node'));
`;
  const loaded = await runner(
    process.execPath,
    ['-e', loadScript, payload.payloadRoot, platform, arch],
    { signal },
  );
  if (!successful(loaded)) {
    return publicError(
      'daemon_native_load_failed',
      `daemon native components failed to load with Node ABI ${process.versions.modules}: ${processError(loaded)}`,
    );
  }

  if (platform === 'darwin') {
    const helper = join(payload.payloadRoot, 'support', 'zterm-daemon');
    const probe = await runner(helper, ['--permission-probe'], { signal });
    const permissionDenied =
      probe.exitCode === 5 &&
      /screen recording permission/i.test(`${probe.stdout}\n${probe.stderr}`);
    if (!successful(probe) && !permissionDenied) {
      return publicError(
        'daemon_native_helper_incompatible',
        `Darwin native helper failed its compatibility probe: ${processError(probe)}`,
      );
    }
  }
  return undefined;
}

function publicPackageManifest(packageRoot: string): DaemonPublicManifest | undefined {
  return readJson<DaemonPublicManifest>(join(packageRoot, 'package.json'));
}

function commandAvailable(entryPath: string): boolean {
  return existsSync(entryPath);
}

function addIfPresent(paths: string[], path: string): void {
  if (existsSync(path) && !paths.includes(path)) {
    paths.push(path);
  }
}

function daemonInvocationForEntry(
  platform: NodeJS.Platform,
  entryPath: string,
  packageRoot: string,
  args: string[],
): { command: string; args: string[] } {
  if (platform !== 'win32') {
    return { command: entryPath, args };
  }
  const manifest = publicPackageManifest(packageRoot);
  const bin = manifest?.bin?.['zterm-daemon'];
  if (!bin || win32.isAbsolute(bin)) {
    throw publicError(
      'daemon_entry_unavailable',
      'installed daemon package is missing a relative bin.zterm-daemon entry',
    );
  }
  const scriptPath = win32.resolve(packageRoot, bin);
  if (
    scriptPath !== packageRoot &&
    !scriptPath.toLowerCase().startsWith(`${packageRoot.toLowerCase()}\\`)
  ) {
    throw publicError(
      'daemon_entry_unavailable',
      'installed daemon bin resolves outside its package root',
    );
  }
  return { command: process.execPath, args: [scriptPath, ...args] };
}

export async function installDaemon(
  options: DaemonInstallOptions = {},
): Promise<DaemonInstallResult> {
  const runner = options.runner ?? spawnProcess;
  const platform = options.platform ?? processPlatform();
  const arch = options.arch ?? processArch();
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeAbi = options.nodeAbi ?? process.versions.modules;
  const packageManager = options.packageManager ?? 'npm';
  const version = options.version ?? 'latest';
  const registry = options.registry ?? DEFAULT_NPM_REGISTRY;
  const homeDir = options.homeDir ?? homedir();
  const filesWritten: string[] = [];
  const payloadName = daemonPayloadPackageName(platform, arch);

  if (!payloadName) {
    return {
      phase: 'resolve',
      commandAvailable: 'unknown',
      filesWritten,
      previousEntryPreserved: 'unknown',
      error: publicError(
        'daemon_platform_mismatch',
        `daemon package has no payload for ${platform}-${arch}`,
      ),
    };
  }

  let prefix: string;
  try {
    prefix =
      options.prefix ??
      (await resolveNpmGlobalPrefix(runner, packageManager, options.signal));
  } catch (error) {
    return {
      phase: 'resolve',
      payloadPackage: payloadName,
      commandAvailable: 'unknown',
      filesWritten,
      previousEntryPreserved: 'unknown',
      error:
        error && typeof error === 'object' && 'code' in error
          ? (error as PublicError)
          : publicError('daemon_install_prefix_unavailable', String(error)),
    };
  }

  const entryPath = daemonGlobalEntryPath(prefix, platform);
  const packageRoot = daemonPackageRoot(prefix, platform);
  const stagingDir =
    options.stagingDir ??
    join(homeDir, '.zterm', 'staging', `daemon-install-${process.pid}-${Date.now()}`);
  const stagedPackageRoot = stagedDaemonPackageRoot(stagingDir);
  const entryExistedBefore = commandAvailable(entryPath);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  filesWritten.push(stagingDir);

  const stagedInstall = await runner(
    packageManager,
    [
      'install',
      '--prefix',
      stagingDir,
      `${DAEMON_PACKAGE_NAME}@${version}`,
      '--registry',
      registry,
      '--ignore-scripts',
      '--no-save',
    ],
    { signal: options.signal },
  );

  if (!successful(stagedInstall)) {
    addIfPresent(filesWritten, stagedPackageRoot);
    return {
      phase: 'download',
      payloadPackage: payloadName,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: true,
      error: publicError(
        stagedInstall.signal ? 'daemon_install_cancelled' : 'daemon_package_install_failed',
        processError(stagedInstall),
      ),
    };
  }

  const stagedPublicManifest = publicPackageManifest(stagedPackageRoot);
  if (!stagedPublicManifest) {
    addIfPresent(filesWritten, stagedPackageRoot);
    return {
      phase: 'stage',
      payloadPackage: payloadName,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: entryExistedBefore,
      error: publicError(
        'daemon_public_package_manifest_missing',
        `staged daemon package has no readable ${join(stagedPackageRoot, 'package.json')}`,
      ),
    };
  }
  filesWritten.push(stagedPackageRoot);
  const stagedManifestError = validatePublicManifest(stagedPublicManifest, version);
  if (stagedManifestError) {
    return {
      phase: 'stage',
      installedVersion: stagedPublicManifest.version,
      payloadPackage: payloadName,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: entryExistedBefore,
      error: stagedManifestError,
    };
  }

  const stagedPayload = resolveDaemonPayload(
    stagedPackageRoot,
    stagedPublicManifest,
    platform,
    arch,
    nodeVersion,
    nodeAbi,
  );
  if ('code' in stagedPayload) {
    addIfPresent(filesWritten, daemonPayloadPackageRoot(join(stagingDir, 'node_modules'), platform, arch) ?? '');
    return {
      phase: 'stage',
      installedVersion: stagedPublicManifest.version,
      payloadPackage: payloadName,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: entryExistedBefore,
      error: stagedPayload,
    };
  }
  filesWritten.push(stagedPayload.payloadRoot);
  const stagedNativeError = await verifyPayloadNativeLoading(
    stagedPayload,
    platform,
    arch,
    runner,
    options.signal,
  );
  if (stagedNativeError) {
    return {
      phase: 'stage',
      installedVersion: stagedPublicManifest.version,
      payloadPackage: payloadName,
      payloadPath: stagedPayload.payloadRoot,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: entryExistedBefore,
      error: stagedNativeError,
    };
  }

  const packed = await runner(
    packageManager,
    ['pack', stagedPackageRoot, '--ignore-scripts', '--pack-destination', stagingDir],
    { signal: options.signal },
  );
  const packedOutput = packed.stdout.trim().split('\n').filter(Boolean).at(-1);
  if (!successful(packed) || !packedOutput) {
    return {
      phase: 'stage',
      installedVersion: stagedPublicManifest.version,
      payloadPackage: payloadName,
      payloadPath: stagedPayload.payloadRoot,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: entryExistedBefore,
      error: publicError(
        packed.signal ? 'daemon_install_cancelled' : 'daemon_package_stage_failed',
        processError(packed),
      ),
    };
  }
  const tarballPath = isAbsolute(packedOutput)
    ? packedOutput
    : resolve(stagingDir, basename(packedOutput));
  addIfPresent(filesWritten, tarballPath);

  const globalInstall = await runner(
    packageManager,
    ['install', '--global', '--prefix', prefix, tarballPath, '--ignore-scripts'],
    { signal: options.signal },
  );
  addIfPresent(filesWritten, packageRoot);
  addIfPresent(filesWritten, entryPath);
  const installedPayloadRoot =
    daemonPayloadPackageRoot(
      platform === 'win32' ? win32.join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules'),
      platform,
      arch,
    ) ?? '';
  addIfPresent(filesWritten, installedPayloadRoot);
  if (!successful(globalInstall)) {
    return {
      phase: 'stage',
      installedVersion: stagedPublicManifest.version,
      payloadPackage: payloadName,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: 'unknown',
      error: publicError(
        globalInstall.signal ? 'daemon_install_cancelled' : 'daemon_package_install_failed',
        processError(globalInstall),
      ),
    };
  }

  const installedPublicManifest = publicPackageManifest(packageRoot);
  if (!installedPublicManifest) {
    return {
      phase: 'verify',
      installedVersion: stagedPublicManifest.version,
      payloadPackage: payloadName,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: 'unknown',
      error: publicError(
        'daemon_public_package_manifest_missing',
        `installed daemon package has no readable ${join(packageRoot, 'package.json')}`,
      ),
    };
  }
  const installedManifestError = validatePublicManifest(
    installedPublicManifest,
    installedPublicManifest.version,
  );
  if (installedManifestError) {
    return {
      phase: 'verify',
      installedVersion: installedPublicManifest.version,
      payloadPackage: payloadName,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: 'unknown',
      error: installedManifestError,
    };
  }

  const installedPayload = resolveDaemonPayload(
    packageRoot,
    installedPublicManifest,
    platform,
    arch,
    nodeVersion,
    nodeAbi,
  );
  if ('code' in installedPayload) {
    return {
      phase: 'verify',
      installedVersion: installedPublicManifest.version,
      payloadPackage: payloadName,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: 'unknown',
      error: installedPayload,
    };
  }
  filesWritten.push(installedPayload.payloadRoot);
  const installedNativeError = await verifyPayloadNativeLoading(
    installedPayload,
    platform,
    arch,
    runner,
    options.signal,
  );
  if (installedNativeError) {
    return {
      phase: 'verify',
      installedVersion: installedPublicManifest.version,
      payloadPackage: payloadName,
      payloadPath: installedPayload.payloadRoot,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: 'unknown',
      error: installedNativeError,
    };
  }

  const shimOwner = join(packageRoot, 'support', 'install-user-shims.cjs');
  if (!existsSync(shimOwner)) {
    return {
      phase: 'publish-shim',
      installedVersion: installedPublicManifest.version,
      payloadPackage: payloadName,
      payloadPath: installedPayload.payloadRoot,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: 'unknown',
      error: publicError(
        'daemon_shim_owner_missing',
        `daemon package has no official shim owner: ${shimOwner}`,
      ),
    };
  }

  const shim = await runner(process.execPath, [shimOwner], { signal: options.signal });
  if (!successful(shim)) {
    return {
      phase: 'publish-shim',
      installedVersion: installedPublicManifest.version,
      payloadPackage: payloadName,
      payloadPath: installedPayload.payloadRoot,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: 'unknown',
      error: publicError(
        shim.signal ? 'daemon_shim_publish_cancelled' : 'daemon_shim_publish_failed',
        processError(shim),
      ),
    };
  }
  const userShims = shim.stdout
    .split('\n')
    .map((line) => line.match(/installed user shim (.+)$/)?.[1]?.trim())
    .filter((path): path is string => Boolean(path));
  for (const path of userShims) {
    addIfPresent(filesWritten, path);
  }

  let verificationInvocation: { command: string; args: string[] };
  try {
    verificationInvocation = daemonInvocationForEntry(
      platform,
      entryPath,
      packageRoot,
      ['--version'],
    );
  } catch (error) {
    return {
      phase: 'verify',
      installedVersion: installedPublicManifest.version,
      payloadPackage: payloadName,
      payloadPath: installedPayload.payloadRoot,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: 'unknown',
      userShims,
      error:
        error && typeof error === 'object' && 'code' in error
          ? (error as PublicError)
          : publicError('daemon_entry_unavailable', String(error)),
    };
  }
  const verification = await runner(
    verificationInvocation.command,
    verificationInvocation.args,
    { signal: options.signal },
  );
  if (!successful(verification) || !verification.stdout.includes(installedPublicManifest.version)) {
    return {
      phase: 'verify',
      installedVersion: installedPublicManifest.version,
      payloadPackage: payloadName,
      payloadPath: installedPayload.payloadRoot,
      commandAvailable: commandAvailable(entryPath),
      filesWritten,
      previousEntryPreserved: 'unknown',
      userShims,
      error: publicError(
        verification.signal
          ? 'daemon_entry_verification_cancelled'
          : 'daemon_entry_verification_failed',
        `official daemon command did not report ${installedPublicManifest.version}: ${processError(verification)}`,
      ),
    };
  }

  return {
    phase: 'verify',
    installedVersion: installedPublicManifest.version,
    payloadPackage: payloadName,
    payloadPath: installedPayload.payloadRoot,
    commandAvailable: commandAvailable(entryPath),
    filesWritten,
    previousEntryPreserved: 'unknown',
    userShims,
  };
}

function preflightReadOnlyCommand(
  homeDir: string,
  subcommand: 'status' | 'config',
): PublicError | undefined {
  const ztermHome = join(homeDir, '.zterm');
  const legacyHome = join(homeDir, '.wterm');
  if (!existsSync(ztermHome) && existsSync(legacyHome)) {
    return publicError(
      'legacy_migration_required',
      `${legacyHome} exists without ${ztermHome}; move or initialize the current configuration before running daemon ${subcommand}`,
    );
  }
  return undefined;
}

function unavailableCommandResult(
  command: string,
  args: string[],
  error: PublicError,
): DaemonCommandResult {
  return {
    command,
    args,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: `${error.message}\n`,
    error,
    state: 'entry_unavailable',
  };
}

async function runReadOnlyDaemonCommand(
  subcommand: 'status' | 'config',
  options: DaemonCommandOptions,
): Promise<DaemonCommandResult> {
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? processPlatform();
  const packageManager = options.packageManager ?? 'npm';
  const runner = options.runner ?? spawnProcess;
  const migrationError = preflightReadOnlyCommand(homeDir, subcommand);
  if (migrationError) {
    return {
      command: daemonGlobalEntryPath(options.prefix ?? join(homeDir, '.zterm'), platform),
      args: [subcommand],
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: `${migrationError.message}\n`,
      error: migrationError,
      state: 'legacy_migration_required',
    };
  }

  let prefix = options.prefix;
  if (!prefix) {
    try {
      prefix = await resolveNpmGlobalPrefix(runner, packageManager, options.signal);
    } catch (error) {
      const failure =
        error && typeof error === 'object' && 'code' in error
          ? (error as PublicError)
          : publicError('daemon_entry_unavailable', String(error));
      return unavailableCommandResult(packageManager, ['prefix', '--global'], failure);
    }
  }

  const entryPath = daemonGlobalEntryPath(prefix, platform);
  const packageRoot = daemonPackageRoot(prefix, platform);
  if (!existsSync(entryPath)) {
    return unavailableCommandResult(
      entryPath,
      [subcommand],
      publicError(
        'daemon_entry_missing',
        `official daemon command is not installed at ${entryPath}`,
      ),
    );
  }

  let invocation: { command: string; args: string[] };
  try {
    invocation = daemonInvocationForEntry(platform, entryPath, packageRoot, [subcommand]);
  } catch (error) {
    return unavailableCommandResult(
      entryPath,
      [subcommand],
      error && typeof error === 'object' && 'code' in error
        ? (error as PublicError)
        : publicError('daemon_entry_unavailable', String(error)),
    );
  }

  try {
    const result = await runner(invocation.command, invocation.args, {
      signal: options.signal,
    });
    return { ...result, state: 'observed' };
  } catch (error) {
    return unavailableCommandResult(
      invocation.command,
      invocation.args,
      publicError(
        error && typeof error === 'object' && 'code' in error
          ? String((error as NodeJS.ErrnoException).code)
          : 'daemon_command_failed',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

export function getDaemonStatus(
  options: DaemonCommandOptions = {},
): Promise<DaemonCommandResult> {
  return runReadOnlyDaemonCommand('status', options);
}

export function getDaemonConfig(
  options: DaemonCommandOptions = {},
): Promise<DaemonCommandResult> {
  return runReadOnlyDaemonCommand('config', options);
}
