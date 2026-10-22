import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveNpmInvocation,
  type ProcessInvocation,
} from '../scripts/process-entry.mjs';

export const CLI_PACKAGE_NAME = '@jsonstudio/zterm-cli';
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';

export interface PublicError {
  code: string;
  message: string;
}

export interface ProcessResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: PublicError;
}

export interface ProcessRunnerOptions {
  signal?: AbortSignal;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options?: ProcessRunnerOptions,
) => Promise<ProcessResult>;

export interface GlobalInstallContext {
  prefix: string;
  packageRoot: string;
  entryPath: string;
}

export interface ResolveInstalledEntryOptions {
  platform: NodeJS.Platform;
  execPath?: string;
  entryPath: string;
  packageRoot: string;
  manifest: unknown;
}

export interface UpgradeResult {
  beforeVersion: string;
  requestedVersion?: string;
  packageManagerExit?: number;
  packageManagerSignal?: NodeJS.Signals;
  observedVersion?: string;
  installationState: 'unchanged' | 'updated' | 'unverified';
  entryPath?: string;
  error?: PublicError;
}

export interface UpgradeCliOptions {
  beforeVersion?: string;
  packageRoot?: string;
  platform?: NodeJS.Platform;
  registry?: string;
  npmCommand?: string;
  runner?: ProcessRunner;
  signal?: AbortSignal;
}

function publicError(code: string, message: string): PublicError {
  return { code, message };
}

function errorMessage(result: ProcessResult): string {
  return result.error?.message || result.stderr.trim() || result.stdout.trim() || 'unknown error';
}

function isSuccessful(result: ProcessResult): boolean {
  return result.exitCode === 0 && !result.signal && !result.error;
}

function pathsForPlatform(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

function normalizedPath(path: string, platform: NodeJS.Platform): string {
  const paths = pathsForPlatform(platform);
  const lexical = paths.normalize(paths.resolve(path));
  let canonical = lexical;
  try {
    canonical = realpathSync.native(lexical);
  } catch {
    // Keep lexical identity when the path is not installed yet.
  }
  const normalized = paths.normalize(paths.resolve(canonical));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export const spawnProcess: ProcessRunner = (command, args, options = {}) =>
  new Promise((resolveResult) => {
    let settled = false;
    let spawnError: PublicError | undefined;
    let stdout = '';
    let stderr = '';
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      resolveResult({
        command,
        args,
        exitCode,
        signal,
        stdout,
        stderr,
        ...(spawnError ? { error: spawnError } : {}),
      });
    };

    try {
      const invocation = resolveNpmInvocation(args, { npmCommand: command });
      const child = spawn(invocation.command, invocation.args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        signal: options.signal,
        killSignal: 'SIGKILL',
      });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', (error) => {
        spawnError = publicError(
          (error as NodeJS.ErrnoException).code || 'process_error',
          error.message,
        );
      });
      child.once('close', finish);
    } catch (error) {
      spawnError = publicError(
        error instanceof Error && 'code' in error
          ? String((error as NodeJS.ErrnoException).code)
          : 'process_error',
        error instanceof Error ? error.message : String(error),
      );
      finish(null, null);
    }
  });

export function globalBinPath(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return pathsForPlatform(platform).join(
    prefix,
    platform === 'win32' ? 'zterm.cmd' : 'bin/zterm',
  );
}

export function npmGlobalPackageRoot(
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = pathsForPlatform(platform);
  return platform === 'win32'
    ? paths.join(prefix, 'node_modules', '@jsonstudio', 'zterm-cli')
    : paths.join(prefix, 'lib', 'node_modules', '@jsonstudio', 'zterm-cli');
}

function cliBinFromManifest(manifest: unknown): string {
  if (!manifest || typeof manifest !== 'object') {
    throw publicError('upgrade_entry_unavailable', 'installed CLI manifest is not an object');
  }
  const bin = (manifest as { bin?: unknown }).bin;
  const entry =
    bin && typeof bin === 'object'
      ? (bin as Record<string, unknown>).zterm
      : undefined;
  if (typeof entry !== 'string' || !entry.trim()) {
    throw publicError(
      'upgrade_entry_unavailable',
      'installed CLI manifest is missing bin.zterm',
    );
  }
  return entry;
}

export function resolveInstalledEntryInvocation(
  args: string[],
  options: ResolveInstalledEntryOptions,
): ProcessInvocation {
  if (options.platform !== 'win32') {
    return { command: options.entryPath, args };
  }

  const cliBin = cliBinFromManifest(options.manifest);
  if (win32.isAbsolute(cliBin)) {
    throw publicError(
      'upgrade_entry_unavailable',
      'installed CLI bin.zterm must be relative to its package root',
    );
  }
  const packageRoot = win32.resolve(options.packageRoot);
  const scriptPath = win32.resolve(packageRoot, cliBin);
  if (
    scriptPath !== packageRoot &&
    !scriptPath.toLowerCase().startsWith(`${packageRoot.toLowerCase()}\\`)
  ) {
    throw publicError(
      'upgrade_entry_unavailable',
      'installed CLI bin.zterm resolves outside its package root',
    );
  }

  return {
    command: options.execPath ?? process.execPath,
    args: [scriptPath, ...args],
  };
}

export function buildNpmViewVersionArgs(
  registry: string = DEFAULT_NPM_REGISTRY,
): string[] {
  return ['view', CLI_PACKAGE_NAME, 'version', '--json', '--registry', registry];
}

export function buildNpmInstallArgs(
  prefix: string,
  version: string,
  registry: string = DEFAULT_NPM_REGISTRY,
): string[] {
  return [
    'install',
    '--global',
    '--prefix',
    prefix,
    `${CLI_PACKAGE_NAME}@${version}`,
    '--registry',
    registry,
  ];
}

export async function resolveNpmGlobalPrefix(
  runner: ProcessRunner = spawnProcess,
  npmCommand = 'npm',
  signal?: AbortSignal,
): Promise<string> {
  const result = await runner(npmCommand, ['prefix', '--global'], { signal });
  if (!isSuccessful(result)) {
    throw publicError('npm_global_prefix_unavailable', errorMessage(result));
  }
  const prefix = result.stdout.trim();
  if (!prefix) {
    throw publicError('npm_global_prefix_unavailable', 'npm returned an empty global prefix');
  }
  return prefix;
}

export async function resolveGlobalInstallContext(
  options: UpgradeCliOptions = {},
): Promise<GlobalInstallContext> {
  const runner = options.runner ?? spawnProcess;
  const npmCommand = options.npmCommand ?? 'npm';
  const platform = options.platform ?? process.platform;
  const prefix = await resolveNpmGlobalPrefix(runner, npmCommand, options.signal);
  const expectedPackageRoot = npmGlobalPackageRoot(prefix, platform);
  const currentPackageRoot =
    options.packageRoot ??
    fileURLToPath(new URL('..', import.meta.url));

  if (
    normalizedPath(expectedPackageRoot, platform) !==
    normalizedPath(currentPackageRoot, platform)
  ) {
    throw publicError(
      'upgrade_install_context_unsupported',
      `current CLI is not in the npm global package tree for prefix ${prefix}; install with: npm install -g ${CLI_PACKAGE_NAME}`,
    );
  }

  return {
    prefix,
    packageRoot: expectedPackageRoot,
    entryPath: globalBinPath(prefix, platform),
  };
}

export function parseCliVersion(output: string): string | undefined {
  const match = output.trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/);
  return match?.[1];
}

function readOwnedVersion(): string {
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error(`missing CLI package version in ${manifestPath}`);
  }
  return manifest.version;
}

async function verifyInstalledEntry(
  context: GlobalInstallContext,
  runner: ProcessRunner,
  platform: NodeJS.Platform,
): Promise<{ available: boolean; version?: string; error?: PublicError }> {
  let invocation: ProcessInvocation;
  try {
    const manifestPath = pathsForPlatform(platform).join(context.packageRoot, 'package.json');
    const manifest =
      platform === 'win32'
        ? JSON.parse(readFileSync(manifestPath, 'utf8'))
        : undefined;
    invocation = resolveInstalledEntryInvocation(['--version'], {
      platform,
      entryPath: context.entryPath,
      packageRoot: context.packageRoot,
      manifest,
    });
  } catch (error) {
    return {
      available: false,
      error:
        error && typeof error === 'object' && 'code' in error
          ? (error as PublicError)
          : publicError(
              'upgrade_entry_unavailable',
              error instanceof Error ? error.message : String(error),
            ),
    };
  }

  const result = await runner(invocation.command, invocation.args);
  const version = parseCliVersion(result.stdout);
  if (!isSuccessful(result)) {
    return {
      available: false,
      version,
      error: publicError('upgrade_entry_unavailable', errorMessage(result)),
    };
  }
  if (!version) {
    return {
      available: false,
      error: publicError(
        'upgrade_version_unreadable',
        `could not read a version from ${context.entryPath} --version`,
      ),
    };
  }
  return { available: true, version };
}

export async function upgradeCli(options: UpgradeCliOptions = {}): Promise<UpgradeResult> {
  let beforeVersion: string;
  try {
    beforeVersion = options.beforeVersion ?? readOwnedVersion();
  } catch (error) {
    return {
      beforeVersion: 'unknown',
      installationState: 'unverified',
      error: publicError(
        'cli_version_unavailable',
        error instanceof Error ? error.message : String(error),
      ),
    };
  }

  const runner = options.runner ?? spawnProcess;
  const npmCommand = options.npmCommand ?? 'npm';
  const registry = options.registry ?? DEFAULT_NPM_REGISTRY;
  const platform = options.platform ?? process.platform;
  let context: GlobalInstallContext;

  try {
    context = await resolveGlobalInstallContext({
      ...options,
      platform,
      runner,
      npmCommand,
      registry,
    });
  } catch (error) {
    return {
      beforeVersion,
      installationState: 'unverified',
      error:
        error && typeof error === 'object' && 'code' in error
          ? (error as PublicError)
          : publicError('upgrade_install_context_unsupported', String(error)),
    };
  }

  const latest = await runner(npmCommand, buildNpmViewVersionArgs(registry), {
    signal: options.signal,
  });
  if (!isSuccessful(latest)) {
    return {
      beforeVersion,
      installationState: 'unverified',
      entryPath: context.entryPath,
      error: publicError('latest_version_query_failed', errorMessage(latest)),
    };
  }

  let requestedVersion: string;
  try {
    const parsed = JSON.parse(latest.stdout.trim()) as unknown;
    if (typeof parsed !== 'string' || !parsed.trim()) throw new Error('empty version');
    requestedVersion = parsed.trim();
  } catch (error) {
    return {
      beforeVersion,
      installationState: 'unverified',
      entryPath: context.entryPath,
      error: publicError(
        'latest_version_query_failed',
        `invalid npm view result: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }

  if (requestedVersion === beforeVersion) {
    return {
      beforeVersion,
      requestedVersion,
      observedVersion: beforeVersion,
      installationState: 'unchanged',
      entryPath: context.entryPath,
    };
  }

  const install = await runner(
    npmCommand,
    buildNpmInstallArgs(context.prefix, requestedVersion, registry),
    { signal: options.signal },
  );
  const verification = await verifyInstalledEntry(context, runner, platform);
  const baseResult: UpgradeResult = {
    beforeVersion,
    requestedVersion,
    entryPath: context.entryPath,
    installationState: 'unverified',
    observedVersion: verification.version,
    ...(typeof install.exitCode === 'number'
      ? { packageManagerExit: install.exitCode }
      : {}),
    ...(install.signal ? { packageManagerSignal: install.signal } : {}),
  };

  if (options.signal?.aborted || install.signal) {
    return {
      ...baseResult,
      error: publicError(
        'upgrade_cancelled',
        `npm installation was cancelled; observed entry state: ${verification.version ?? 'unavailable'}`,
      ),
    };
  }

  if (!isSuccessful(install)) {
    return {
      ...baseResult,
      error: publicError('npm_install_failed', errorMessage(install)),
    };
  }

  if (!verification.available || verification.version !== requestedVersion) {
    return {
      ...baseResult,
      error: publicError(
        'upgrade_verification_failed',
        verification.error?.message ??
          `expected ${requestedVersion}, observed ${verification.version ?? 'unavailable'}`,
      ),
    };
  }

  return {
    ...baseResult,
    installationState: 'updated',
  };
}
