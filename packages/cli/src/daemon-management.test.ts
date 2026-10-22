import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DAEMON_PACKAGE_NAME,
  daemonGlobalEntryPath,
  daemonPackageRoot,
  daemonPayloadComponents,
  daemonPayloadPackageName,
  getDaemonConfig,
  getDaemonStatus,
  installDaemon,
  stagedDaemonPackageRoot,
  type DaemonPackageManifest,
} from './daemon-management.js';
import type { ProcessResult, ProcessRunner } from './release.js';

function result(command: string, args: string[]): ProcessResult {
  return {
    command,
    args,
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
  };
}

function expectedDaemonInvocation(
  prefix: string,
  subcommand: 'status' | 'config',
): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return {
      command: daemonGlobalEntryPath(prefix, process.platform),
      args: [subcommand],
    };
  }
  return {
    command: process.execPath,
    args: [
      join(daemonPackageRoot(prefix, process.platform), 'bin', 'zterm-daemon.cjs'),
      subcommand,
    ],
  };
}

function writeFixtureFile(root: string, relativePath: string, content = ''): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function payloadManifest(
  overrides: Partial<DaemonPackageManifest> = {},
  target: { platform?: NodeJS.Platform; arch?: string } = {},
): DaemonPackageManifest {
  const platform = target.platform ?? 'darwin';
  const arch = target.arch ?? 'arm64';
  const name = daemonPayloadPackageName(platform, arch);
  if (!name) {
    throw new Error(`unsupported daemon fixture platform ${platform}-${arch}`);
  }
  return {
    schemaVersion: 1,
    package: {
      name,
      version: '0.1.2',
    },
    platform: {
      os: platform,
      arch,
      node: {
        minimum: '22.0.0',
        abi: '127',
      },
    },
    runtimeComponents: daemonPayloadComponents(platform, arch),
    ...overrides,
  };
}

function writePublicPackage(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFixtureFile(root, 'bin/zterm-daemon.cjs', '#!/usr/bin/env node\n');
  writeFixtureFile(root, 'bin/wterm.cjs', '#!/usr/bin/env node\n');
  writeFixtureFile(root, 'support/install-user-shims.cjs', '');
  writeFixtureFile(
    root,
    'package.json',
    JSON.stringify({
      name: DAEMON_PACKAGE_NAME,
      version: '0.1.2',
      bin: {
        'zterm-daemon': 'bin/zterm-daemon.cjs',
        wterm: 'bin/wterm.cjs',
      },
      optionalDependencies: {
        '@jsonstudio/zterm-daemon-darwin-arm64': '0.1.2',
        '@jsonstudio/zterm-daemon-linux-x64': '0.1.2',
        '@jsonstudio/zterm-daemon-win32-x64': '0.1.2',
      },
    }),
  );
}

function writePayloadPackage(
  root: string,
  packageManifest: DaemonPackageManifest = payloadManifest(),
): void {
  const { os: platform, arch } = packageManifest.platform;
  mkdirSync(root, { recursive: true });
  writeFixtureFile(
    root,
    'package.json',
    JSON.stringify({
      name: packageManifest.package.name,
      version: packageManifest.package.version,
      os: [platform],
      cpu: [arch],
    }),
  );
  writeFixtureFile(root, 'zterm-package.json', JSON.stringify(packageManifest));
  writeFixtureFile(root, 'runtime/server.cjs', '');
  writeFixtureFile(root, 'runtime/dagpipe.node', '');
  writeFixtureFile(root, 'runtime/node_modules/node-pty/package.json', '{}');
  writeFixtureFile(root, 'runtime/node_modules/@roamhq/wrtc/package.json', '{}');
  writeFixtureFile(root, `runtime/node_modules/@roamhq/wrtc-${platform}-${arch}/wrtc.node`, '');
  writeFixtureFile(root, 'support/terminal-config-command.cjs', '');
  if (platform === 'win32') {
    writeFixtureFile(root, 'support/windows/zterm-daemon.ps1', '');
  } else {
    writeFixtureFile(root, 'support/zterm-daemon.sh', '');
    if (platform === 'darwin') {
      writeFixtureFile(root, 'support/zterm-daemon', '');
    }
  }
}

function writeStagedPackages(
  stagingDir: string,
  options: {
    includePayload?: boolean;
    payloadManifest?: DaemonPackageManifest;
  } = {},
): void {
  writePublicPackage(stagedDaemonPackageRoot(stagingDir));
  if (options.includePayload !== false) {
    const payloadManifestValue = options.payloadManifest ?? payloadManifest();
    const payloadPath = join(
      stagingDir,
      'node_modules',
      '@jsonstudio',
      payloadManifestValue.package.name.replace('@jsonstudio/', ''),
    );
    writePayloadPackage(payloadPath, payloadManifestValue);
  }
}

function writeGlobalPackages(
  prefix: string,
  options: {
    includePayload?: boolean;
    payloadManifest?: DaemonPackageManifest;
    platform?: NodeJS.Platform;
    arch?: string;
  } = {},
): void {
  const platform = options.platform ?? 'darwin';
  const arch = options.arch ?? (platform === 'darwin' ? 'arm64' : 'x64');
  const packageRoot = daemonPackageRoot(prefix, platform);
  writePublicPackage(packageRoot);
  if (options.includePayload !== false) {
    const name = daemonPayloadPackageName(platform, arch);
    if (!name) {
      throw new Error(`unsupported daemon fixture platform ${platform}-${arch}`);
    }
    writePayloadPackage(
      join(dirname(packageRoot), name.replace('@jsonstudio/', '')),
      options.payloadManifest ?? payloadManifest(undefined, { platform, arch }),
    );
  }
  const entryPath = daemonGlobalEntryPath(prefix, platform);
  mkdirSync(dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, '#!/usr/bin/env node\n');
  chmodSync(entryPath, 0o755);
}

describe('daemon management package adapter', () => {
  it('validates the public package and local payload before publishing the official shim', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'zterm-daemon-home-'));
    const prefix = mkdtempSync(join(tmpdir(), 'zterm-daemon-prefix-'));
    const configPath = join(homeDir, '.zterm', 'config.json');
    mkdirSync(join(homeDir, '.zterm'), { recursive: true });
    writeFileSync(configPath, '{"daemon":{"keep":true},"unknown":[1,2]}\n', { mode: 0o600 });
    const originalConfig = readFileSync(configPath, 'utf8');
    const stagingDir = join(homeDir, '.zterm', 'staging', 'daemon-install-test');
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: ProcessRunner = vi.fn(async (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'install' && !args.includes('--global')) {
        writeStagedPackages(stagingDir);
      }
      if (args[0] === 'pack') {
        return {
          ...result(command, args),
          stdout: `${join(stagingDir, 'jsonstudio-zterm-daemon-0.1.2.tgz')}\n`,
        };
      }
      if (args[0] === 'install' && args.includes('--global')) {
        writeGlobalPackages(prefix);
      }
      if (command === process.execPath && args[0] === '-e') {
        return result(command, args);
      }
      if (args[0] === '--version') {
        return { ...result(command, args), stdout: '0.1.2\n' };
      }
      return result(command, args);
    });

    const installResult = await installDaemon({
      homeDir,
      prefix,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: '22.22.2',
      nodeAbi: '127',
      stagingDir,
      runner,
    });

    expect(installResult).toMatchObject({
      phase: 'verify',
      installedVersion: '0.1.2',
      payloadPackage: daemonPayloadPackageName('darwin', 'arm64'),
      commandAvailable: true,
    });
    expect(installResult.filesWritten).toContain(
      realpathSync(join(stagingDir, 'node_modules', '@jsonstudio', 'zterm-daemon-darwin-arm64')),
    );
    expect(installResult.filesWritten).toContain(
      realpathSync(join(prefix, 'lib', 'node_modules', '@jsonstudio', 'zterm-daemon-darwin-arm64')),
    );
    const firstNativeCheck = calls.findIndex(
      ({ command, args }) => command === process.execPath && args[0] === '-e',
    );
    const globalInstall = calls.findIndex(({ args }) => args.includes('--global'));
    expect(firstNativeCheck).toBeGreaterThan(-1);
    expect(firstNativeCheck).toBeLessThan(globalInstall);
    expect(
      calls.some(({ command, args }) =>
        [command, ...args].join(' ').match(/start|stop|restart|install-service|launchctl/i),
      ),
    ).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
  });

  it('fails explicitly when the staged public package has no local payload', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'zterm-daemon-home-'));
    const prefix = mkdtempSync(join(tmpdir(), 'zterm-daemon-prefix-'));
    const stagingDir = join(homeDir, '.zterm', 'staging', 'daemon-install-missing-payload');
    const calls: string[][] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push(args);
      if (args[0] === 'install' && !args.includes('--global')) {
        writeStagedPackages(stagingDir, { includePayload: false });
      }
      return result(command, args);
    };

    const installResult = await installDaemon({
      homeDir,
      prefix,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: '22.22.2',
      nodeAbi: '127',
      stagingDir,
      runner,
    });

    expect(installResult.phase).toBe('stage');
    expect(installResult.error?.code).toBe('daemon_payload_missing');
    expect(installResult.filesWritten).toContain(
      join(stagingDir, 'node_modules', '@jsonstudio', 'zterm-daemon'),
    );
    expect(calls.some((args) => args.includes('--global'))).toBe(false);
    expect(calls.some((args) => args[0] === 'pack')).toBe(false);
  });

  it('fails on a native load error before the global install or shim mutation', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'zterm-daemon-home-'));
    const prefix = mkdtempSync(join(tmpdir(), 'zterm-daemon-prefix-'));
    const stagingDir = join(homeDir, '.zterm', 'staging', 'daemon-install-native-error');
    const calls: string[][] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'install' && !args.includes('--global')) {
        writeStagedPackages(stagingDir);
      }
      if (command === process.execPath && args[0] === '-e') {
        return {
          ...result(command, args),
          exitCode: 1,
          stderr: 'cannot load dagpipe.node\n',
        };
      }
      return result(command, args);
    };

    const installResult = await installDaemon({
      homeDir,
      prefix,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: '22.22.2',
      nodeAbi: '127',
      stagingDir,
      runner,
    });

    expect(installResult.phase).toBe('stage');
    expect(installResult.error).toEqual({
      code: 'daemon_native_load_failed',
      message: expect.stringContaining('cannot load dagpipe.node'),
    });
    expect(installResult.filesWritten).toContain(stagingDir);
    expect(calls.some((args) => args.includes('--global'))).toBe(false);
    expect(calls.some((args) => args.includes('install-user-shims.cjs'))).toBe(false);
  });

  it('reports a missing installed payload after npm wrote package files', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'zterm-daemon-home-'));
    const prefix = mkdtempSync(join(tmpdir(), 'zterm-daemon-prefix-'));
    const stagingDir = join(homeDir, '.zterm', 'staging', 'daemon-install-global-payload');
    const runner: ProcessRunner = async (command, args) => {
      if (args[0] === 'install' && !args.includes('--global')) {
        writeStagedPackages(stagingDir);
      }
      if (args[0] === 'pack') {
        return {
          ...result(command, args),
          stdout: `${join(stagingDir, 'jsonstudio-zterm-daemon-0.1.2.tgz')}\n`,
        };
      }
      if (args[0] === 'install' && args.includes('--global')) {
        writeGlobalPackages(prefix, { includePayload: false });
      }
      return result(command, args);
    };

    const installResult = await installDaemon({
      homeDir,
      prefix,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: '22.22.2',
      nodeAbi: '127',
      stagingDir,
      runner,
    });

    expect(installResult.phase).toBe('verify');
    expect(installResult.error?.code).toBe('daemon_payload_missing');
    expect(installResult.commandAvailable).toBe(true);
    expect(installResult.filesWritten).toContain(
      daemonPackageRoot(prefix, 'darwin'),
    );
    expect(installResult.filesWritten).toContain(
      daemonGlobalEntryPath(prefix, 'darwin'),
    );
    expect(installResult.previousEntryPreserved).toBe('unknown');
  });

  it('fails on payload platform and ABI mismatch without invoking native code', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'zterm-daemon-home-'));
    const prefix = mkdtempSync(join(tmpdir(), 'zterm-daemon-prefix-'));
    const stagingDir = join(homeDir, '.zterm', 'staging', 'daemon-install-wrong-abi');
    const calls: string[][] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'install' && !args.includes('--global')) {
        writeStagedPackages(stagingDir, {
          payloadManifest: payloadManifest({
            platform: {
              os: 'darwin',
              arch: 'arm64',
              node: { minimum: '22.0.0', abi: '999' },
            },
          }),
        });
      }
      return result(command, args);
    };

    const installResult = await installDaemon({
      homeDir,
      prefix,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: '22.22.2',
      nodeAbi: '127',
      stagingDir,
      runner,
    });

    expect(installResult.error?.code).toBe('daemon_node_abi_mismatch');
    expect(calls.some((args) => args[0] === '-e')).toBe(false);
    expect(calls.some((args) => args.includes('--global'))).toBe(false);
  });

  it('blocks status before an old wterm directory can be migrated by the wrapper', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'zterm-daemon-home-'));
    mkdirSync(join(homeDir, '.wterm'), { recursive: true });
    const runnerSpy = vi.fn(async (command: string, args: string[]) => result(command, args));

    const statusResult = await getDaemonStatus({
      homeDir,
      prefix: join(homeDir, 'prefix'),
      runner: runnerSpy,
    });

    expect(statusResult.state).toBe('legacy_migration_required');
    expect(statusResult.error?.code).toBe('legacy_migration_required');
    expect(runnerSpy).not.toHaveBeenCalled();
  });

  it('delegates status and config only to the absolute installed package entry', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'zterm-daemon-home-'));
    const prefix = mkdtempSync(join(tmpdir(), 'zterm-daemon-prefix-'));
    mkdirSync(join(homeDir, '.zterm'), { recursive: true });
    writeGlobalPackages(prefix, { platform: process.platform });
    const calls: string[][] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push([command, ...args]);
      const subcommand = process.platform === 'win32' ? args[1] : args[0];
      return {
        ...result(command, args),
        exitCode: subcommand === 'status' ? 1 : 0,
        stdout: subcommand === 'status' ? 'zterm daemon not running (3333)\n' : 'configPath=x\n',
      };
    };

    const statusResult = await getDaemonStatus({ homeDir, prefix, runner });
    const configResult = await getDaemonConfig({ homeDir, prefix, runner });

    expect(statusResult.exitCode).toBe(1);
    expect(statusResult.stdout).toContain('not running');
    expect(configResult.exitCode).toBe(0);
    const statusInvocation = expectedDaemonInvocation(prefix, 'status');
    const configInvocation = expectedDaemonInvocation(prefix, 'config');
    expect(calls).toEqual([
      [statusInvocation.command, ...statusInvocation.args],
      [configInvocation.command, ...configInvocation.args],
    ]);
  });

  it('fails instead of falling back to an old PATH command when the package entry is absent', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'zterm-daemon-home-'));
    const prefix = mkdtempSync(join(tmpdir(), 'zterm-daemon-prefix-'));
    mkdirSync(join(homeDir, '.zterm'), { recursive: true });
    const runnerSpy = vi.fn(async (command: string, args: string[]) => result(command, args));

    const resultValue = await getDaemonConfig({ homeDir, prefix, runner: runnerSpy });

    expect(resultValue.state).toBe('entry_unavailable');
    expect(resultValue.error?.code).toBe('daemon_entry_missing');
    expect(resultValue.command).toBe(daemonGlobalEntryPath(prefix, process.platform));
    expect(runnerSpy).not.toHaveBeenCalled();
    expect(existsSync(daemonGlobalEntryPath(prefix, process.platform))).toBe(false);
  });
});
