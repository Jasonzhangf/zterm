import { execFileSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const ANDROID_ROOT = process.cwd();
const cleanupDirs: string[] = [];

function readDaemonScript() {
  return readFileSync(join(ANDROID_ROOT, 'scripts', 'zterm-daemon.sh'), 'utf8');
}

function readReleaseScript() {
  return readFileSync(join(ANDROID_ROOT, 'scripts', 'prepare-global-daemon-release.sh'), 'utf8');
}

function readDaemonNpmPackageScript() {
  return readFileSync(join(ANDROID_ROOT, 'scripts', 'prepare-daemon-npm-package.mjs'), 'utf8');
}

function readWindowsDaemonScript() {
  return readFileSync(join(ANDROID_ROOT, 'scripts', 'windows', 'zterm-daemon.ps1'), 'utf8');
}

function readReleaseVerifyScript() {
  return readFileSync(join(ANDROID_ROOT, 'scripts', 'verify-release-assets.mjs'), 'utf8');
}

function readInstallGlobalDaemonCliScript() {
  return readFileSync(join(ANDROID_ROOT, 'scripts', 'install-global-daemon-cli.sh'), 'utf8');
}

function packageVersion(): string {
  return JSON.parse(readFileSync(join(ANDROID_ROOT, 'package.json'), 'utf8')).version as string;
}

function block(script: string, anchor: string, length: number, ownerName: string) {
  const start = script.indexOf(anchor);
  expect(start, `${anchor} should exist in ${ownerName}`).toBeGreaterThanOrEqual(0);
  return script.slice(start, start + length);
}

function extractSupportHeredocBody(): string {
  const packagerLines = readReleaseScript().split('\n');
  const startMarker = "cat > \"${SUPPORT_DIR}/zterm-daemon.sh\" <<'EOF'";
  const start = packagerLines.findIndex((line) => line.trim() === startMarker);
  expect(start, `${startMarker} should exist in release packager`).toBeGreaterThanOrEqual(0);
  const end = packagerLines.findIndex((line, index) => index > start && line.trim() === 'EOF');
  expect(end, `EOF terminator after ${startMarker} should exist in release packager`).toBeGreaterThan(start);
  return packagerLines.slice(start + 1, end).join('\n') + '\n';
}

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'zterm-daemon-script-test-'));
  cleanupDirs.push(home);
  return home;
}

function resolveEsbuildBinary(): string {
  const pnpmRoots = [
    join(ANDROID_ROOT, 'node_modules', '.pnpm'),
    join(ANDROID_ROOT, '..', 'node_modules', '.pnpm'),
  ];
  for (const pnpmRoot of pnpmRoots) {
    if (!existsSync(pnpmRoot)) continue;
    const entries = readdirSync(pnpmRoot)
      .filter((entry) => entry.startsWith('esbuild@'))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    for (const entry of entries.reverse()) {
      const candidate = join(pnpmRoot, entry, 'node_modules', 'esbuild', 'bin', 'esbuild');
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('unable to locate esbuild for the terminal config fixture bundle');
}

function buildTerminalConfigBundle(packageRoot: string): string {
  const supportDir = join(packageRoot, 'support');
  const bundlePath = join(supportDir, 'terminal-config-command.cjs');
  mkdirSync(supportDir, { recursive: true });
  execFileSync(resolveEsbuildBinary(), [
    join(ANDROID_ROOT, 'src', 'server', 'terminal-config-command.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node20',
    `--outfile=${bundlePath}`,
  ], { cwd: ANDROID_ROOT, stdio: 'ignore' });
  chmodSync(bundlePath, 0o755);
  return bundlePath;
}

function installRealSupportAtVersion(home: string): string {
  const version = packageVersion();
  const supportDir = join(home, '.zterm', 'releases', 'zterm-daemon', version, 'support');
  mkdirSync(supportDir, { recursive: true });
  const supportPath = join(supportDir, 'zterm-daemon.sh');
  writeFileSync(supportPath, extractSupportHeredocBody());
  chmodSync(supportPath, 0o755);
  buildTerminalConfigBundle(join(supportDir, '..'));
  return supportPath;
}

function installRecordingSupportAtVersion(home: string, argvPath: string, pathPath: string): string {
  const version = packageVersion();
  const supportDir = join(home, '.zterm', 'releases', 'zterm-daemon', version, 'support');
  mkdirSync(supportDir, { recursive: true });
  const supportPath = join(supportDir, 'zterm-daemon.sh');
  const body = [
    '#!/usr/bin/env bash',
    'set -u',
    `printf '%s\\n' "$0" > "${pathPath}"`,
    `printf '%s\\n' "$@" > "${argvPath}"`,
    'for arg in "$@"; do printf " <%s>" "$arg"; done',
    'printf "\\n"',
    'exit "${FIXTURE_EXIT:-3}"',
    '',
  ].join('\n');
  writeFileSync(supportPath, body);
  chmodSync(supportPath, 0o755);
  return supportPath;
}

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runSourceCli(
  home: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): CliResult {
  try {
    const stdout = execFileSync('bash', [join(ANDROID_ROOT, 'scripts', 'zterm-daemon.sh'), ...args], {
      cwd: ANDROID_ROOT,
      env: { ...process.env, HOME: home, ...options.env },
      input: options.input,
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: unknown; stderr?: unknown };
    return {
      status: failed.status ?? 1,
      stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
      stderr: typeof failed.stderr === 'string' ? failed.stderr : '',
    };
  }
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('zterm daemon service script truth gates', () => {
  it('delegates every argument to the installed package-version support and owns no lifecycle code', () => {
    const script = readDaemonScript();

    expect(script).toContain('PACKAGE_VERSION="$("$NODE_BIN" -p "require(\'${ROOT_DIR}/package.json\').version")"');
    expect(script).toContain('INSTALLED_SUPPORT="${HOME}/.zterm/releases/zterm-daemon/${PACKAGE_VERSION}/support/zterm-daemon.sh"');
    expect(script).toContain('echo "zterm-daemon: installed support script not found at ${INSTALLED_SUPPORT}" >&2');
    expect(script).toContain('echo "run daemon:install-global first" >&2');
    expect(script).toContain('exec bash "${INSTALLED_SUPPORT}" "$@"');

    const removedOwners = [
      'Usage:',
      'Behavior:',
      'case "$cmd" in',
      'configure_relay() {',
      'read_config() {',
      'run_foreground() {',
      'start_service() {',
      'restart_service() {',
      'stop_service() {',
      'status_service() {',
      'write_launch_agent() {',
      'install_service() {',
      'uninstall_service() {',
      'install_user_shims() {',
      'stage_daemon_runtime() {',
      'stage_native_daemon_binary() {',
      'resolve_node_package_dir() {',
      'wait_for_service_ready() {',
      'prime_daemon_install_permissions() {',
      'prepare_iterm2_python_env() {',
      'start_direct() {',
      'stop_direct() {',
      'status_direct() {',
      'DAEMON_PID_FILE=',
      'start_tmux',
      'tmux new-session',
      'tmux kill-session',
      'swiftc',
      'release-dist',
      '.local/bin',
    ];
    for (const removed of removedOwners) {
      expect(script, `${removed} must stay removed from source`).not.toContain(removed);
    }
    expect(script).not.toMatch(/swiftc|compile|node_modules|stage_|bootstrap_service/i);
    expect(script.match(/\bexec\b/g)?.length ?? 0).toBe(1);
  });

  it('preserves exact arguments, exit status, and version-scoped support path through real child bash', () => {
    const home = makeTempHome();
    const argvPath = join(home, '.zterm', 'fixture-argv.txt');
    const pathPath = join(home, '.zterm', 'fixture-support-path.txt');
    installRecordingSupportAtVersion(home, argvPath, pathPath);

    const args = [
      'configure-relay',
      '--relay-url',
      'https://relay.example.com/',
      '--username',
      'zterm-relay-smoke',
      '--password-stdin',
      '--host-id',
      'mac-studio',
      '--device-name',
      'Mac Studio',
      '--no-restart',
    ];
    const result = runSourceCli(home, args);

    expect(result.status).toBe(3);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(` ${args.map((arg) => `<${arg}>`).join(' ')}\n`);
    expect(readFileSync(argvPath, 'utf8').split('\n')).toEqual([...args, '']);
    expect(readFileSync(pathPath, 'utf8').trim()).toBe(
      join(home, '.zterm', 'releases', 'zterm-daemon', packageVersion(), 'support', 'zterm-daemon.sh'),
    );
  });

  it('fails install-first without installed support and creates no canonical native, global shim, or user shim', () => {
    const home = makeTempHome();
    const result = runSourceCli(home, [
      'configure-relay',
      '--relay-url',
      'https://relay.example.com/',
      '--username',
      'zterm-relay-smoke',
      '--password-stdin',
      '--host-id',
      'mac-studio',
      '--device-name',
      'Mac Studio',
      '--no-restart',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('zterm-daemon: installed support script not found at');
    expect(result.stderr).toContain(join(home, '.zterm', 'releases', 'zterm-daemon', packageVersion(), 'support', 'zterm-daemon.sh'));
    expect(result.stderr).toContain('run daemon:install-global first');

    expect(existsSync(join(home, '.zterm', 'bin', 'zterm-daemon'))).toBe(false);
    expect(existsSync(join(home, '.zterm', 'bin', 'wterm'))).toBe(false);
    expect(existsSync(join(home, '.local', 'bin', 'zterm-daemon'))).toBe(false);
    expect(existsSync(join(home, '.local', 'bin', 'wterm'))).toBe(false);
    expect(existsSync(join(home, '.zterm', 'releases'))).toBe(false);
    expect(existsSync(join(home, '.zterm', 'config.json'))).toBe(false);
    expect(existsSync(join(home, '.zterm', 'run'))).toBe(false);
    expect(existsSync(join(home, '.zterm', 'logs'))).toBe(false);
    expect(existsSync(join(home, 'Library', 'LaunchAgents'))).toBe(false);
  });

  it('configures relay through the real installed support while preserving daemon config and hiding the password', () => {
    const home = makeTempHome();
    installRealSupportAtVersion(home);
    mkdirSync(join(home, '.zterm'), { recursive: true });
    writeFileSync(
      join(home, '.zterm', 'config.json'),
      JSON.stringify(
        {
          mobile: {
            daemon: {
              host: '127.0.0.1',
              port: 17680,
              authToken: 'keep-daemon-token',
            },
          },
        },
        null,
        2,
      ),
    );

    const result = runSourceCli(home, [
      'configure-relay',
      '--relay-url',
      'https://relay.example.com/relay/',
      '--username',
      'zterm-relay-smoke',
      '--password-stdin',
      '--host-id',
      'mac-studio',
      '--device-name',
      'Mac Studio',
      '--no-restart',
    ], { input: 'secret-password\n' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('passwordSet=true');
    expect(result.stdout).not.toContain('secret-password');
    expect(result.stdout).toContain("run 'zterm-daemon restart' after configuration to reconnect relay");

    const config = JSON.parse(readFileSync(join(home, '.zterm', 'config.json'), 'utf8'));
    expect(config.mobile.daemon).toEqual({
      host: '127.0.0.1',
      port: 17680,
      authToken: 'keep-daemon-token',
    });
    expect(config.mobile.relay).toMatchObject({
      relayUrl: 'https://relay.example.com/relay/',
      username: 'zterm-relay-smoke',
      password: 'secret-password',
      hostId: 'mac-studio',
      deviceId: 'mac-studio',
      deviceName: 'Mac Studio',
      platform: process.platform,
    });
    expect(existsSync(join(home, '.zterm', 'run'))).toBe(false);
    expect(existsSync(join(home, '.zterm', 'logs'))).toBe(false);
    expect(existsSync(join(home, 'Library', 'LaunchAgents'))).toBe(false);
  });

  it('extracts the bounded write_support_script heredoc as an executable support script', () => {
    const support = extractSupportHeredocBody();
    expect(support).toContain('#!/usr/bin/env bash');
    expect(support).toContain('PACKAGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"');
    expect(support).toContain('WTERM_HOME="${HOME}/.zterm"');
    expect(support).toContain('NATIVE_DAEMON_BIN="${WTERM_BIN_DIR}/zterm-daemon"');
    expect(support).toContain('DAGPIPE_NATIVE_BIN="${RUNTIME_DIR}/dagpipe.node"');

    const home = makeTempHome();
    const supportPath = installRealSupportAtVersion(home);
    expect(readFileSync(supportPath, 'utf8')).toBe(support);
    expect(execFileSync('bash', ['-n', supportPath], { encoding: 'utf8' })).toBe('');
  });

  it('projects config through the shared bundle without exposing account or auth secrets', () => {
    const home = makeTempHome();
    installRealSupportAtVersion(home);
    const configPath = join(home, '.zterm', 'config.json');
    mkdirSync(join(home, '.zterm'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      zterm: {
        android: {
          daemon: {
            host: '127.0.0.1',
            port: 17680,
            authToken: 'daemon-auth-secret',
          },
        },
      },
      mobile: {
        relay: {
          username: 'relay-account-secret',
          password: 'relay-password-secret',
        },
        unknownToken: 'unknown-secret',
      },
    }, null, 2));

    const result = runSourceCli(home, ['config']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`configPath=${configPath}`);
    expect(result.stdout).toContain('configFound=yes');
    expect(result.stdout).toContain('host=127.0.0.1 source=zterm.android.daemon.host');
    expect(result.stdout).toContain('port=17680 source=zterm.android.daemon.port');
    expect(result.stdout).toContain('auth=configured source=zterm.android.daemon.authToken');
    for (const secret of ['daemon-auth-secret', 'relay-account-secret', 'relay-password-secret', 'unknown-secret']) {
      expect(result.stdout).not.toContain(secret);
    }

    const configureBody = block(extractSupportHeredocBody(), 'configure_relay() {', 3600, 'generated support');
    expect(configureBody).toContain('"$TERMINAL_CONFIG_COMMAND"');
    expect(configureBody).toContain('configure-relay');
    expect(configureBody).not.toContain('mobile.relay =');
    expect(configureBody).not.toContain('password=${relay_password}');
  });

  it('does not migrate a legacy ~/.wterm home when projecting ~/.zterm config', () => {
    const home = makeTempHome();
    installRealSupportAtVersion(home);
    const legacyPath = join(home, '.wterm', 'config.json');
    const legacyBody = JSON.stringify({ mobile: { daemon: { host: 'legacy-host', port: 19999 } } }, null, 2);
    mkdirSync(join(home, '.wterm'), { recursive: true });
    writeFileSync(legacyPath, legacyBody);

    const result = runSourceCli(home, ['config']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('host=0.0.0.0 source=default');
    expect(result.stdout).toContain('port=3333 source=default');
    expect(result.stdout).toContain('configFound=no');
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacyBody);
    expect(existsSync(join(home, '.zterm', 'config.json'))).toBe(false);
  });

  it('merges projected daemon config per field with mobile fallback', () => {
    const home = makeTempHome();
    installRealSupportAtVersion(home);
    const configPath = join(home, '.zterm', 'config.json');
    mkdirSync(join(home, '.zterm'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      zterm: {
        android: {
          daemon: {
            host: '127.0.0.1',
            port: 17680,
          },
        },
      },
      mobile: {
        daemon: {
          authToken: 'mobile-auth-secret',
          sessionName: 'mobile-session',
        },
      },
    }, null, 2));

    const result = runSourceCli(home, ['config']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('host=127.0.0.1 source=zterm.android.daemon.host');
    expect(result.stdout).toContain('port=17680 source=zterm.android.daemon.port');
    expect(result.stdout).toContain('sessionName=mobile-session source=mobile.daemon.sessionName');
    expect(result.stdout).toContain('auth=configured source=mobile.daemon.authToken');
    expect(result.stdout).not.toContain('mobile-auth-secret');
  });

  it('keeps install-time native RTC dependencies inside the daemon npm package', () => {
    const script = readDaemonNpmPackageScript();

    expect(script).toContain("'runtime/node_modules/node-pty'");
    expect(script).toContain("'runtime/node_modules/@roamhq/wrtc'");
    expect(script).toContain(
      "`runtime/node_modules/@roamhq/wrtc-${spec.tuple}/wrtc.node`",
    );
  });

  it('keeps the public launcher as the sole bin owner and packages a stable shim installer', () => {
    const script = readDaemonNpmPackageScript();

    expect(script).toContain('const publicBinSource');
    expect(script).toContain('const publicWtermSource');
    expect(script).toContain('const publicShimInstallerSource');
    expect(script).toContain("bin/zterm-daemon.cjs");
    expect(script).toContain("bin/wterm.cjs");
    expect(script).toContain("'zterm-daemon': 'bin/zterm-daemon.cjs'");
    expect(script).toContain("wterm: 'bin/wterm.cjs'");
    expect(script).toContain("join(homedir(), '.local', 'bin')");
    expect(script).toContain("renameSync(temporary, target)");
    expect(script).toContain("join(packageRoot, 'bin', 'zterm-daemon.cjs')");
    expect(script).toContain("join(packageRoot, 'bin', 'wterm.cjs')");
    expect(script).toContain('payloadResolverSource');
  });

  it('packs one public launcher package and three platform payload tarballs', () => {
    const workspace = makeTempHome();
    const projectRoot = join(workspace, 'android');
    const scriptPath = join(projectRoot, 'scripts', 'prepare-daemon-npm-package.mjs');
    const version = '9.9.9';
    const tuples = [
      { tuple: 'darwin-arm64', os: 'darwin', arch: 'arm64' },
      { tuple: 'linux-x64', os: 'linux', arch: 'x64' },
      { tuple: 'win32-x64', os: 'win32', arch: 'x64' },
    ];
    mkdirSync(join(projectRoot, 'scripts'), { recursive: true });
    writeFileSync(scriptPath, readDaemonNpmPackageScript());
    writeFileSync(join(workspace, 'LICENSE'), 'fixture license\n');
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ version }));

    const releases = tuples.map((spec) => {
      const releaseDir = join(projectRoot, 'release-dist', spec.tuple);
      for (const relativePath of [
        'runtime/server.cjs',
        'runtime/dagpipe.node',
        'runtime/node_modules/node-pty/package.json',
        'runtime/node_modules/@roamhq/wrtc/package.json',
        `runtime/node_modules/@roamhq/wrtc-${spec.tuple}/wrtc.node`,
      ]) {
        const path = join(releaseDir, relativePath);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, 'fixture runtime component\n');
      }
      if (spec.os === 'win32') {
        mkdirSync(join(releaseDir, 'support', 'windows'), { recursive: true });
        writeFileSync(
          join(releaseDir, 'support', 'windows', 'zterm-daemon.ps1'),
          readWindowsDaemonScript(),
        );
      } else {
        mkdirSync(join(releaseDir, 'support'), { recursive: true });
        writeFileSync(
          join(releaseDir, 'support', 'zterm-daemon.sh'),
          '#!/usr/bin/env bash\nexit 0\n',
        );
      }
      if (spec.os === 'darwin') {
        mkdirSync(join(releaseDir, 'support'), { recursive: true });
        writeFileSync(join(releaseDir, 'support', 'zterm-daemon'), 'fixture helper\n');
      }
      writeFileSync(join(releaseDir, 'VERSION'), `${version}\n`);
      writeFileSync(
        join(releaseDir, 'zterm-package.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          package: {
            name: `@jsonstudio/zterm-daemon-${spec.tuple}`,
            version,
          },
          platform: {
            os: spec.os,
            arch: spec.arch,
            node: { minimum: '22.0.0', abi: '127' },
          },
          runtimeComponents: [],
        }, null, 2)}\n`,
      );
      buildTerminalConfigBundle(releaseDir);
      return { ...spec, releaseDir };
    });

    const packOutput = execFileSync(process.execPath, [
      scriptPath,
      '--version',
      version,
      ...releases.flatMap(({ tuple, releaseDir }) => [
        '--release',
        `${tuple}=${releaseDir}`,
      ]),
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(packOutput).toContain('[prepare-daemon-npm-package] ready');

    const outputDir = join(
      projectRoot,
      'release-dist',
      'npm',
      `zterm-daemon-${version}`,
    );
    const publicPackageRoot = join(outputDir, 'packages', '@jsonstudio', 'zterm-daemon');
    const publicManifest = JSON.parse(
      readFileSync(join(publicPackageRoot, 'package.json'), 'utf8'),
    );
    expect(publicManifest.name).toBe('@jsonstudio/zterm-daemon');
    expect(publicManifest.version).toBe(version);
    expect(publicManifest.bin).toEqual({
      'zterm-daemon': 'bin/zterm-daemon.cjs',
      wterm: 'bin/wterm.cjs',
    });
    expect(publicManifest.optionalDependencies).toEqual(Object.fromEntries(
      tuples.map(({ tuple }) => [
        `@jsonstudio/zterm-daemon-${tuple}`,
        version,
      ]),
    ));
    expect(existsSync(join(publicPackageRoot, 'runtime'))).toBe(false);

    for (const { tuple, os, arch } of tuples) {
      const payloadRoot = join(
        outputDir,
        'packages',
        '@jsonstudio',
        `zterm-daemon-${tuple}`,
      );
      const payloadManifest = JSON.parse(
        readFileSync(join(payloadRoot, 'package.json'), 'utf8'),
      );
      expect(payloadManifest.name).toBe(`@jsonstudio/zterm-daemon-${tuple}`);
      expect(payloadManifest.os).toEqual([os]);
      expect(payloadManifest.cpu).toEqual([arch]);
      expect(payloadManifest.bin).toBeUndefined();
      expect(existsSync(join(payloadRoot, 'runtime', 'server.cjs'))).toBe(true);
      expect(existsSync(join(
        payloadRoot,
        'runtime',
        'node_modules',
        `@roamhq/wrtc-${tuple}`,
        'wrtc.node',
      ))).toBe(true);
      expect(existsSync(join(payloadRoot, 'support', 'terminal-config-command.cjs'))).toBe(true);

      const tarballName = `jsonstudio-zterm-daemon-${tuple}-${version}.tgz`;
      const tarballPath = join(outputDir, tarballName);
      expect(existsSync(tarballPath), tarballName).toBe(true);
      const entries = execFileSync('tar', ['-tf', tarballPath], { encoding: 'utf8' })
        .trim()
        .split('\n');
      expect(entries).toContain('package/runtime/server.cjs');
      expect(entries).toContain('package/zterm-package.json');
      expect(entries).toContain('package/support/terminal-config-command.cjs');
    }

    expect(existsSync(join(outputDir, `jsonstudio-zterm-daemon-${version}.tgz`))).toBe(true);
    const payloadManifest = JSON.parse(execFileSync(
      'tar',
      [
        '-xOf',
        join(outputDir, `jsonstudio-zterm-daemon-darwin-arm64-${version}.tgz`),
        'package/zterm-package.json',
      ],
      { encoding: 'utf8' },
    ));
    expect(payloadManifest.package.name).toBe('@jsonstudio/zterm-daemon-darwin-arm64');
    expect(payloadManifest.runtimeComponents).toContain('support/terminal-config-command.cjs');

    const extractedBundle = join(workspace, 'extracted', 'terminal-config-command.cjs');
    mkdirSync(join(workspace, 'extracted'), { recursive: true });
    writeFileSync(extractedBundle, execFileSync(
      'tar',
      [
        '-xOf',
        join(outputDir, `jsonstudio-zterm-daemon-darwin-arm64-${version}.tgz`),
        'package/support/terminal-config-command.cjs',
      ],
      { encoding: 'utf8' },
    ));
    const bundleResult = execFileSync(process.execPath, [extractedBundle, 'daemon-config', '--shell'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: workspace },
    });
    expect(bundleResult).toContain("HOST='0.0.0.0'");
    expect(bundleResult).toContain("PORT='3333'");
    expect(bundleResult).toContain("AUTH_SOURCE='default'");
  });

  it('packages a Windows PowerShell daemon runner without duplicating terminal backend truth', () => {
    const packageScript = readDaemonNpmPackageScript();
    const windowsScript = readWindowsDaemonScript();

    expect(packageScript).toContain("if (spec.os === 'win32')");
    expect(packageScript).toContain("files.push('support/windows/zterm-daemon.ps1')");
    expect(packageScript).toContain('ZTERM_PACKAGE_ROOT: payloadRoot');
    expect(packageScript).toContain("powershell.exe");

    expect(windowsScript).toContain('$NativeDir = Join-Path $PackageRoot "runtime"');
    expect(windowsScript).toContain('$RuntimeEntry = Join-Path $NativeDir "server.cjs"');
    expect(windowsScript).toContain('$TerminalConfigCommand = Join-Path $PackageRoot "support\\terminal-config-command.cjs"');
    expect(windowsScript).toContain('function Invoke-TerminalConfigCommand');
    expect(windowsScript).toContain('Invoke-TerminalConfigCommand @("daemon-config", "--shell")');
    expect(windowsScript).toContain('configure-relay');
    expect(windowsScript).toContain('"config" { Invoke-Config }');
    expect(windowsScript).toContain('$TaskName = "ZTermDaemon"');
    expect(windowsScript).toContain('$FirewallRuleName = "ZTerm Daemon 3333"');
    expect(windowsScript).not.toContain('function Write-JsonNoBom');
    expect(windowsScript).not.toContain('ConvertFrom-Json');
    expect(windowsScript).not.toContain("mobile.relay");
    expect(windowsScript).toContain('$env:ZTERM_TERMINAL_BACKEND = "wezterm"');
    expect(windowsScript).toContain('$env:ZTERM_WEZTERM_EXE = $pathCandidate.Source');
    expect(windowsScript).toContain('"D:\\zterm-tools\\wezterm\\portable"');
    expect(windowsScript).toContain('$env:ZTERM_WEZTERM_EXE = $candidate.FullName');
    expect(windowsScript).toContain('New-NetFirewallRule -DisplayName $FirewallRuleName');
    expect(windowsScript.indexOf('Ensure-FirewallRule')).toBeLessThan(windowsScript.indexOf('Register-ScheduledTask -TaskName $TaskName'));
    expect(windowsScript).toContain('Register-ScheduledTask -TaskName $TaskName');
    expect(windowsScript).toContain('$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name');
    expect(windowsScript).toContain('New-ScheduledTaskPrincipal -UserId $taskUser -LogonType S4U -RunLevel Highest');
    expect(windowsScript).toContain('-Principal $principal');
    expect(windowsScript).toContain('New-ScheduledTaskTrigger -AtStartup');
    expect(windowsScript).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(windowsScript).toContain('Start-Process -FilePath $NodeExe');
    expect(windowsScript).toContain('Stop-Process -Id $daemonPid');
    expect(windowsScript).not.toContain('$pid =');
    expect(windowsScript).not.toContain('Get-Process node');
    expect(windowsScript).not.toContain('Stop-Process -Name');
    expect(windowsScript).not.toContain('taskkill /IM');
  });

  it('verifies daemon npm tarballs contain native runtime dependencies before release', () => {
    const script = readReleaseVerifyScript();

    expect(script).toContain('listTarballEntries');
    expect(script).toContain('package/runtime/node_modules/node-pty');
    expect(script).toContain('package/runtime/node_modules/@roamhq/wrtc');
    expect(script).toContain('package/runtime/node_modules/@roamhq/wrtc-darwin-arm64/wrtc.node');
    expect(script).toContain('package/support/zterm-daemon.sh');
    expect(script).toContain('configure-relay');
  });

  it('writes the version-scoped installed support and synchronized user-level CLI shims in the release installer', () => {
    const script = readReleaseScript();
    const installerBody = block(script, 'write_installer() {', 6500, 'release packager');

    expect(installerBody).toContain('VERSION="$(cat "${PACKAGE_ROOT}/VERSION")"');
    expect(installerBody).toContain('INSTALL_ROOT="${HOME}/.zterm/releases/zterm-daemon/${VERSION}"');
    expect(installerBody).toContain('cp -R "${PACKAGE_ROOT}/support" "${INSTALL_ROOT}/support"');
    expect(installerBody).toContain('NATIVE_TMP="${HOME}/.zterm/bin/.zterm-daemon.$$"');
    expect(installerBody).toContain('cp "${INSTALL_ROOT}/support/zterm-daemon" "${NATIVE_TMP}"');
    expect(installerBody).toContain('mv "${NATIVE_TMP}" "${HOME}/.zterm/bin/zterm-daemon"');
    expect(installerBody).not.toContain('cp "${INSTALL_ROOT}/support/zterm-daemon" "${HOME}/.zterm/bin/zterm-daemon"');
    expect(installerBody).toContain('LOCAL_BIN="${HOME}/.local/bin"');
    expect(installerBody).toContain('DAEMON_TMP="${LOCAL_BIN}/.zterm-daemon.shim.$$"');
    expect(installerBody).toContain('cat > "${DAEMON_TMP}" <<WRAP');
    expect(installerBody).toContain('mv "${DAEMON_TMP}" "${LOCAL_BIN}/zterm-daemon"');
    expect(installerBody).toContain('exec "${INSTALL_ROOT}/support/zterm-daemon.sh" "\\$@"');
    expect(installerBody).toContain('WTERM_TMP="${LOCAL_BIN}/.wterm.shim.$$"');
    expect(installerBody).toContain('cat > "${WTERM_TMP}" <<WRAP');
    expect(installerBody).toContain('mv "${WTERM_TMP}" "${LOCAL_BIN}/wterm"');
    expect(installerBody).toContain('cp "${PACKAGE_ROOT}/zterm-package.json" "${INSTALL_ROOT}/zterm-package.json"');

    expect(script).toContain('stage_terminal_config_command() {');
    expect(script).toContain('--outfile="${SUPPORT_DIR}/terminal-config-command.cjs"');
    expect(script).toContain("'support/terminal-config-command.cjs'");
    expect(script.lastIndexOf('stage_terminal_config_command')).toBeGreaterThan(
      script.indexOf('stage_terminal_config_command() {'),
    );
  });

  it('compiles and installs the daemon native binary before the global installer copies it', () => {
    const script = readReleaseScript();
    const stageBody = block(script, 'stage_native_daemon_binary() {', 1000, 'release packager');
    const normalizeBody = block(script, 'normalize_release_tree_metadata() {', 1000, 'release packager');

    expect(stageBody).toContain('swiftc -swift-version 5 -strict-concurrency=minimal "${NATIVE_DAEMON_SOURCE}" "${REMOTE_WINDOW_CAPTURE_SWIFT}" -o "${NATIVE_DAEMON_BIN}"');
    expect(script).not.toContain('ZTerm Remote Capture');
    expect(script).not.toContain('ZTERM_DAEMON_CAPTURE_NATIVE');
    expect(script).not.toContain('zterm-remote-window-capture');
    expect(normalizeBody).toContain('"${release_tree}/support/zterm-daemon"');
    expect(normalizeBody).not.toContain('Remote Capture');
  });

  it('keeps source daemon global install from pointing launchd back at mutable source runtime', () => {
    const script = readInstallGlobalDaemonCliScript();

    expect(script).toContain('PREPARE_RELEASE_SCRIPT="${ROOT_DIR_REAL}/scripts/prepare-global-daemon-release.sh"');
    expect(script).toContain('bash "$PREPARE_RELEASE_SCRIPT"');
    expect(script).toContain('bash "${RELEASE_INSTALLER}"');
    expect(script).toContain('release-dist');
    expect(script).not.toContain('exec bash "${ROOT_DIR_REAL}/scripts/zterm-daemon.sh" "$@"');
    expect(script).not.toContain('exec bash "${ROOT_DIR_REAL}/scripts/zterm-daemon.sh" run');
  });

  it('requires HTTP health for service readiness, status, and launchd preflight in generated support', () => {
    const support = extractSupportHeredocBody();
    const waitBody = block(support, 'wait_for_service_ready() {', 500, 'generated support');
    const statusBody = block(support, 'status_service() {', 1200, 'generated support');
    const launchBody = block(support, 'write_launch_agent() {', 5200, 'generated support');

    expect(support).not.toContain('lsof -nP -iTCP');
    expect(support).toContain('PROBE_SOCKET_HOST="$HOST"');
    expect(support).toContain('PROBE_URL_HOST="$HOST"');
    expect(support).toContain('PROBE_SOCKET_HOST="${PROBE_SOCKET_HOST#[}"');
    expect(support).toContain('PROBE_URL_HOST="[${PROBE_SOCKET_HOST}]"');
    expect(waitBody).toContain('local max_attempts=150');
    expect(waitBody).toContain('daemon_health_ready');
    expect(statusBody).toContain('daemon_health_ready');
    expect(launchBody).toContain('health_ready()');
    expect(launchBody).toContain('http://\\${PROBE_URL_HOST}:\\${PORT}/health');
    expect(launchBody).not.toContain('launchd preflight: port $PORT already listening');
    expect(support).not.toContain('nc -z 127.0.0.1 "${PORT}"');
  });

  it('keeps launchd as a parent watchdog that restarts only its explicit daemon child pid', () => {
    const support = extractSupportHeredocBody();
    const launchBody = block(support, 'write_launch_agent() {', 5200, 'generated support');

    expect(launchBody).toContain('child_pid="\\$!"');
    expect(launchBody).toContain('STARTUP_HEALTH_GRACE_SECONDS=45');
    expect(launchBody).toContain('waiting for startup health');
    expect(launchBody).toContain('while kill -0 "\\${child_pid}"');
    expect(launchBody).toContain('missed_health_checks');
    expect(launchBody).toContain('terminate_child()');
    expect(launchBody).toContain('kill -TERM "\\${child_pid}"');
    expect(launchBody).toContain('kill -KILL "\\${child_pid}"');
    expect(launchBody).toContain('exit 1');
    expect(launchBody).not.toContain('pkill');
    expect(launchBody).not.toContain('killall');
    expect(launchBody).not.toContain('xargs kill');
  });

  it('restages the launch agent before bootstrapping launchd on service start and restart', () => {
    const support = extractSupportHeredocBody();
    const startBody = block(support, 'start_service() {', 1400, 'generated support');
    const restartBody = block(support, 'restart_service() {', 1400, 'generated support');

    expect(startBody.indexOf('write_launch_agent')).toBeGreaterThanOrEqual(0);
    expect(startBody.indexOf('write_launch_agent')).toBeLessThan(startBody.indexOf('bootstrap_service'));
    expect(startBody.indexOf('wait_for_service_unloaded')).toBeGreaterThanOrEqual(0);
    expect(startBody.indexOf('wait_for_service_unloaded')).toBeLessThan(startBody.indexOf('bootstrap_service'));

    expect(restartBody.indexOf('write_launch_agent')).toBeGreaterThanOrEqual(0);
    expect(restartBody.indexOf('write_launch_agent')).toBeLessThan(restartBody.indexOf('bootstrap_service'));
    expect(restartBody.indexOf('wait_for_service_unloaded')).toBeGreaterThanOrEqual(0);
    expect(restartBody.indexOf('wait_for_service_unloaded')).toBeLessThan(restartBody.indexOf('bootstrap_service'));
  });

  it('does not fallback to tmux session when launchd service start or restart is unhealthy', () => {
    const support = extractSupportHeredocBody();
    const startBody = block(support, 'start_service() {', 1400, 'generated support');
    const restartBody = block(support, 'restart_service() {', 1400, 'generated support');

    expect(startBody).not.toContain('falling back to tmux session');
    expect(startBody).not.toContain('start_tmux');
    expect(restartBody).not.toContain('falling back to tmux session');
    expect(restartBody).not.toContain('start_tmux');
    expect(support).not.toContain('start_tmux() {');
    expect(support).not.toContain('stop_tmux() {');
    expect(support).not.toContain('status_tmux() {');
    expect(support).not.toContain('tmux new-session -d -s "$SESSION_NAME"');
    expect(support).not.toContain('tmux kill-session -t "$SESSION_NAME"');
  });

  it('primes file-sync permissions during generated support service install before launchd bootstrap', () => {
    const support = extractSupportHeredocBody();
    const installBody = block(support, 'install_service() {', 900, 'generated support');
    const preflightBody = block(support, 'prime_daemon_install_permissions() {', 2600, 'generated support');

    expect(installBody.indexOf('write_launch_agent')).toBeGreaterThanOrEqual(0);
    expect(installBody.indexOf('prime_daemon_install_permissions')).toBeGreaterThanOrEqual(0);
    expect(installBody.indexOf('prime_daemon_install_permissions')).toBeLessThan(installBody.indexOf('bootstrap_service'));
    expect(preflightBody).toContain('Downloads');
    expect(preflightBody).toContain('.zterm');
    expect(preflightBody).toContain('.zterm-permission-preflight');
    expect(preflightBody).toContain('ZTERM_DAEMON_NATIVE="$NATIVE_DAEMON_BIN"');
    expect(preflightBody).toContain('--permission-probe');
    expect(preflightBody).toContain('ScreenCaptureKit permission preflight failed.');
  });

  it('pins generated support iTerm2 Python API execution to a managed user venv', () => {
    const support = extractSupportHeredocBody();
    const launchBody = block(support, 'write_launch_agent() {', 5200, 'generated support');
    const prepareBody = block(support, 'prepare_iterm2_python_env() {', 900, 'generated support');

    expect(support).toContain('ITERM2_PYTHON_VENV="${WTERM_HOME}/python/iterm2"');
    expect(support).toContain('ITERM2_PYTHON_BIN="${ITERM2_PYTHON_VENV}/bin/python3"');
    expect(prepareBody).toContain('python3 -m venv "$ITERM2_PYTHON_VENV"');
    expect(prepareBody).toContain('import iterm2');
    expect(prepareBody).toContain('"$ITERM2_PYTHON_BIN" -m pip install --upgrade iterm2');
    expect(launchBody).toContain('prepare_iterm2_python_env');
    expect(launchBody).toContain('ZTERM_ITERM2_PYTHON="${ITERM2_PYTHON_BIN}"');
  });

  it('uses one installed daemon binary for permission, capture, and DAGpipe entries', () => {
    const support = extractSupportHeredocBody();
    const releaseScript = readReleaseScript();
    const runBody = block(support, 'run_foreground() {', 700, 'generated support');
    const launchBody = block(support, 'write_launch_agent() {', 5200, 'generated support');
    const preflightBody = block(support, 'prime_daemon_install_permissions() {', 2600, 'generated support');
    const directBody = block(support, 'start_direct() {', 1800, 'generated support');

    expect(support).not.toContain('ZTerm Remote Capture');
    expect(releaseScript).not.toContain('ZTerm Remote Capture');
    expect(support).not.toContain('ZTERM_DAEMON_CAPTURE_NATIVE');
    expect(releaseScript).not.toContain('ZTERM_DAEMON_CAPTURE_NATIVE');
    expect(support).not.toContain('zterm-remote-window-capture');
    expect(releaseScript).not.toContain('zterm-remote-window-capture');
    for (const body of [runBody, launchBody, preflightBody, directBody]) {
      expect(body).toMatch(/ZTERM_DAEMON_NATIVE=("\$\{NATIVE_DAEMON_BIN\}"|"\$NATIVE_DAEMON_BIN"|\$\{NATIVE_DAEMON_BIN\}|\$NATIVE_DAEMON_BIN)/u);
      expect(body).not.toMatch(/\/usr\/sbin\/screencapture|capture-screen/u);
    }
    expect(support).toContain('NATIVE_DAEMON_BIN="${WTERM_BIN_DIR}/zterm-daemon"');
    expect(support).toContain('ZTERM_DAGPIPE_NATIVE="${DAGPIPE_NATIVE_BIN}"');
    expect(support.match(/ZTERM_DAGPIPE_NATIVE=/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('keeps packaging-native compile assertions at the packaging owner and direct-pid paths stay out of source', () => {
    const releaseScript = readReleaseScript();
    const sourceScript = readDaemonScript();
    const stageRuntimeBody = block(releaseScript, 'stage_runtime() {', 2600, 'release packager');
    const stageNativeBody = block(releaseScript, 'stage_native_daemon_binary() {', 1000, 'release packager');

    expect(stageRuntimeBody).toContain('DAGPIPE_PROFILE=release bash "${ROOT_DIR}/scripts/build-dagpipe-native.sh"');
    expect(stageRuntimeBody).toContain('cp "${ROOT_DIR}/native/dagpipe/index.node" "${RUNTIME_DIR}/dagpipe.node"');
    expect(stageNativeBody).toContain('swiftc -swift-version 5 -strict-concurrency=minimal "${NATIVE_DAEMON_SOURCE}" "${REMOTE_WINDOW_CAPTURE_SWIFT}" -o "${NATIVE_DAEMON_BIN}"');
    expect(releaseScript.indexOf('stage_native_daemon_binary')).toBeLessThan(releaseScript.indexOf('write_support_script'));
    expect(releaseScript.lastIndexOf('stage_runtime')).toBeLessThan(releaseScript.lastIndexOf('stage_native_daemon_binary'));
    expect(sourceScript).not.toContain('ZTERM_DAGPIPE_NATIVE');
    expect(sourceScript).not.toContain('stage_native_daemon_binary');
    expect(sourceScript).not.toContain('build-dagpipe-native');
  });

  it('only emits package-resolve error after both require.resolve and filesystem fallback fail', () => {
    const script = readReleaseScript();
    const body = block(script, 'resolve_node_package_dir() {', 1600, 'release packager');
    expect(body).toContain('find "${ROOT_DIR}/node_modules/.pnpm"');
    expect(body).toContain('find "${WORKSPACE_ROOT}/node_modules/.pnpm"');
    expect(body).toContain('if [[ -n "${candidate}" ]]');
    expect(body).toContain('echo "[zterm-daemon] unable to resolve ${package_name} in ${ROOT_DIR} or ${WORKSPACE_ROOT}" >&2');
    expect(body.indexOf('if [[ -n "${candidate}" ]]')).toBeLessThan(body.indexOf('echo "[zterm-daemon] unable to resolve ${package_name} in ${ROOT_DIR} or ${WORKSPACE_ROOT}" >&2'));
  });

  it('uses direct background pid truth instead of tmux sessions in generated support', () => {
    const support = extractSupportHeredocBody();
    const startBody = block(support, 'start_direct() {', 1800, 'generated support');
    const stopBody = block(support, 'stop_direct() {', 1200, 'generated support');

    expect(support).toContain('DAEMON_PID_FILE="${RUNTIME_STATE_DIR}/zterm-daemon.pid"');
    expect(support).toContain('start_direct');
    expect(support).toContain('stop_direct');
    expect(support).toContain('status_direct');
    expect(startBody).toContain("printf '%s\\n' \"${daemon_pid}\" > \"${DAEMON_PID_FILE}\"");
    expect(stopBody).toContain('read_daemon_pid');
    expect(support).not.toContain('start_tmux() {');
    expect(support).not.toContain('stop_tmux() {');
    expect(support).not.toContain('status_tmux() {');
    expect(support).not.toContain('tmux new-session -d -s "$SESSION_NAME"');
    expect(support).not.toContain('tmux kill-session -t "$SESSION_NAME"');
  });

  it('keeps live mirror diff wired through the DAGpipe bridge instead of TS changed ranges', () => {
    const serverSource = readFileSync(join(ANDROID_ROOT, 'src', 'server', 'server.ts'), 'utf8');
    expect(serverSource).toContain('mirrorPublishChangedRanges');
    expect(serverSource).toContain("from './dagpipe-bridge'");
    expect(serverSource).not.toContain('findChangedIndexedRanges');
  });
});
