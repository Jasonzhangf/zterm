import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildNpmInstallArgs,
  buildNpmViewVersionArgs,
  globalBinPath,
  resolveInstalledEntryInvocation,
  upgradeCli,
  type ProcessResult,
  type ProcessRunner,
} from './release.js';

function processResult(
  source: Pick<ProcessResult, 'command' | 'args'>,
  overrides: Partial<ProcessResult> = {},
): ProcessResult {
  return {
    command: source.command,
    args: source.args,
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

function updateRunner(overrides: {
  install?: Partial<ProcessResult>;
  verifyStdout?: string;
} = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ProcessRunner = vi.fn(async (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'prefix') {
      return processResult({ command, args }, { stdout: '/opt/zterm-prefix\n' });
    }
    if (args[0] === 'view') {
      return processResult({ command, args }, { stdout: '"1.2.0"\n' });
    }
    if (args[0] === 'install') {
      return processResult({ command, args }, overrides.install);
    }
    if (args[0] === '--version') {
      return processResult(
        { command, args },
        { stdout: overrides.verifyStdout ?? 'zterm 1.2.0\n' },
      );
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  });
  return { runner, calls };
}

describe('CLI npm upgrade adapter', () => {
  it('uses fixed package, global prefix, and argument arrays for an update', async () => {
    const { runner, calls } = updateRunner();
    const result = await upgradeCli({
      beforeVersion: '1.0.0',
      packageRoot: '/opt/zterm-prefix/lib/node_modules/@jsonstudio/zterm-cli',
      platform: 'darwin',
      registry: 'https://registry.example.test/',
      runner,
    });

    expect(result).toMatchObject({
      beforeVersion: '1.0.0',
      requestedVersion: '1.2.0',
      packageManagerExit: 0,
      observedVersion: '1.2.0',
      installationState: 'updated',
    });
    expect(calls).toEqual([
      { command: 'npm', args: ['prefix', '--global'] },
      {
        command: 'npm',
        args: [
          'view',
          '@jsonstudio/zterm-cli',
          'version',
          '--json',
          '--registry',
          'https://registry.example.test/',
        ],
      },
      {
        command: 'npm',
        args: buildNpmInstallArgs(
          '/opt/zterm-prefix',
          '1.2.0',
          'https://registry.example.test/',
        ),
      },
      { command: '/opt/zterm-prefix/bin/zterm', args: ['--version'] },
    ]);
    expect(calls[2].args).toEqual([
      'install',
      '--global',
      '--prefix',
      '/opt/zterm-prefix',
      '@jsonstudio/zterm-cli@1.2.0',
      '--registry',
      'https://registry.example.test/',
    ]);
  });

  it('reports unchanged without installing or replacing the entry', async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push(args);
      if (args[0] === 'prefix') {
        return processResult({ command, args }, { stdout: '/opt/zterm-prefix\n' });
      }
      return processResult({ command, args }, { stdout: '"1.0.0"\n' });
    };

    const result = await upgradeCli({
      beforeVersion: '1.0.0',
      packageRoot: '/opt/zterm-prefix/lib/node_modules/@jsonstudio/zterm-cli',
      platform: 'darwin',
      runner,
    });

    expect(result.installationState).toBe('unchanged');
    expect(result.observedVersion).toBe('1.0.0');
    expect(calls.map((args) => args[0])).toEqual(['prefix', 'view']);
  });

  it('keeps npm failure and observed entry state instead of claiming success', async () => {
    const { runner } = updateRunner({
      install: {
        exitCode: 1,
        stderr: 'EACCES: permission denied',
      },
      verifyStdout: 'zterm 1.0.0\n',
    });

    const result = await upgradeCli({
      beforeVersion: '1.0.0',
      packageRoot: '/opt/zterm-prefix/lib/node_modules/@jsonstudio/zterm-cli',
      platform: 'darwin',
      runner,
    });

    expect(result).toMatchObject({
      packageManagerExit: 1,
      observedVersion: '1.0.0',
      installationState: 'unverified',
      error: {
        code: 'npm_install_failed',
      },
    });
    expect(result.error?.message).toContain('EACCES');
  });

  it('leaves shared configuration unchanged during an install', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'zterm-cli-upgrade-home-'));
    const configPath = join(homeDir, '.zterm', 'config.json');
    mkdirSync(join(homeDir, '.zterm'), { recursive: true });
    writeFileSync(configPath, '{"server":{"keep":true},"unknown":[1,2]}\n', { mode: 0o600 });
    const originalConfig = readFileSync(configPath, 'utf8');
    const { runner } = updateRunner();

    const result = await upgradeCli({
      beforeVersion: '1.0.0',
      packageRoot: '/opt/zterm-prefix/lib/node_modules/@jsonstudio/zterm-cli',
      platform: 'darwin',
      runner,
    });

    expect(result.installationState).toBe('updated');
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
  });

  it('rejects an entry outside the npm global package root before mutation', async () => {
    const runner: ProcessRunner = async (command, args) =>
      processResult({ command, args }, { stdout: '/opt/zterm-prefix\n' });

    const result = await upgradeCli({
      beforeVersion: '1.0.0',
      packageRoot: '/Users/test/src/zterm/packages/cli',
      platform: 'darwin',
      runner,
    });

    expect(result.installationState).toBe('unverified');
    expect(result.error?.code).toBe('upgrade_install_context_unsupported');
  });

  it('accepts the same npm package tree through a directory symlink', async () => {
    const physicalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'zterm-cli-prefix-')));
    const aliasRoot = realpathSync(mkdtempSync(join(tmpdir(), 'zterm-cli-alias-')));
    const aliasPrefix = join(aliasRoot, 'prefix');
    const packageRoot = join(
      physicalRoot,
      'lib',
      'node_modules',
      '@jsonstudio',
      'zterm-cli',
    );
    mkdirSync(packageRoot, { recursive: true });
    symlinkSync(
      physicalRoot,
      aliasPrefix,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    try {
      const { runner } = updateRunner();
      const result = await upgradeCli({
        beforeVersion: '1.0.0',
        packageRoot,
        platform: process.platform,
        runner: async (command, args) => {
          if (args[0] === 'prefix') {
            return processResult({ command, args }, { stdout: `${aliasPrefix}\n` });
          }
          return runner(command, args);
        },
      });

      expect(result.installationState).toBe('updated');
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
      rmSync(physicalRoot, { recursive: true, force: true });
    }
  });

  it('reports cancellation without promising the previous entry remains healthy', async () => {
    const { runner } = updateRunner({
      install: {
        exitCode: null,
        signal: 'SIGINT',
      },
      verifyStdout: 'zterm 1.0.0\n',
    });

    const result = await upgradeCli({
      beforeVersion: '1.0.0',
      packageRoot: '/opt/zterm-prefix/lib/node_modules/@jsonstudio/zterm-cli',
      platform: 'darwin',
      runner,
    });

    expect(result.installationState).toBe('unverified');
    expect(result.packageManagerSignal).toBe('SIGINT');
    expect(result.error?.code).toBe('upgrade_cancelled');
    expect(result.observedVersion).toBe('1.0.0');
  });

  it('constructs npm and entry locations without shell command text', () => {
    expect(buildNpmViewVersionArgs('https://registry.example.test/')).toEqual([
      'view',
      '@jsonstudio/zterm-cli',
      'version',
      '--json',
      '--registry',
      'https://registry.example.test/',
    ]);
    expect(globalBinPath('/opt/prefix with space', 'darwin')).toBe(
      '/opt/prefix with space/bin/zterm',
    );
    expect(globalBinPath('C:\\Users\\test\\AppData\\Roaming\\npm', 'win32')).toBe(
      'C:\\Users\\test\\AppData\\Roaming\\npm\\zterm.cmd',
    );
  });

  it('verifies a Windows upgrade through the same-prefix formal CLI JS bin', () => {
    const execPath = 'C:\\Program Files\\nodejs\\node.exe';
    const packageRoot =
      'C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@jsonstudio\\zterm-cli';
    const invocation = resolveInstalledEntryInvocation(['--version'], {
      platform: 'win32',
      execPath,
      entryPath: 'C:\\Users\\test\\AppData\\Roaming\\npm\\zterm.cmd',
      packageRoot,
      manifest: { bin: { zterm: './bin/zterm.mjs' } },
    });

    expect(invocation).toEqual({
      command: execPath,
      args: [`${packageRoot}\\bin\\zterm.mjs`, '--version'],
    });
    expect(invocation.command).not.toMatch(/\.cmd$/i);
    expect(invocation.args[0].toLowerCase()).toContain(
      '\\node_modules\\@jsonstudio\\zterm-cli\\bin\\zterm.mjs',
    );
  });

  it('fails explicitly when the formal Windows CLI bin is absent from the manifest', () => {
    expect(() =>
      resolveInstalledEntryInvocation(['--version'], {
        platform: 'win32',
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        entryPath: 'C:\\Users\\test\\AppData\\Roaming\\npm\\zterm.cmd',
        packageRoot:
          'C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@jsonstudio\\zterm-cli',
        manifest: {},
      }),
    ).toThrowError(/bin\.zterm/);
  });
});
