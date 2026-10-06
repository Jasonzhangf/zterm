import { execFileSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

function installRealSupportAtVersion(home: string): string {
  const version = packageVersion();
  const supportDir = join(home, '.zterm', 'releases', 'zterm-daemon', version, 'support');
  mkdirSync(supportDir, { recursive: true });
  const supportPath = join(supportDir, 'zterm-daemon.sh');
  writeFileSync(supportPath, extractSupportHeredocBody());
  chmodSync(supportPath, 0o755);
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

function runSourceCli(home: string, args: string[]): CliResult {
  try {
    const stdout = execFileSync('bash', [join(ANDROID_ROOT, 'scripts', 'zterm-daemon.sh'), ...args], {
      cwd: ANDROID_ROOT,
      env: { ...process.env, HOME: home },
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
      '--password',
      'secret-password',
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
      '--password',
      'secret-password',
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
      '--password',
      'secret-password',
      '--host-id',
      'mac-studio',
      '--device-name',
      'Mac Studio',
      '--no-restart',
    ]);

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

  it('keeps relay account configuration explicit and secret-free in generated support', () => {
    const support = extractSupportHeredocBody();
    const usageBlock = block(support, 'Usage:', 1200, 'generated support');
    const caseBlock = block(support, 'case "$cmd" in', 1200, 'generated support');
    const configureBody = block(support, 'configure_relay() {', 5200, 'generated support');

    expect(usageBlock).toContain('configure-relay --relay-url');
    expect(caseBlock).toContain('configure-relay) configure_relay "$@" ;;');
    expect(configureBody).toContain('mobile.relay');
    expect(configureBody).toContain('passwordSet=true');
    expect(configureBody).not.toContain('password=${relay_password}');
  });

  it('migrates legacy ~/.wterm home before reading released daemon config', () => {
    const support = extractSupportHeredocBody();
    const configBlock = block(support, "const configPath = path.join(home, '.zterm', 'config.json');", 500, 'generated support');

    expect(support).toContain("const ztermHome = path.join(home, '.zterm');");
    expect(support).toContain("const legacyWtermHome = path.join(home, '.wterm');");
    expect(support).toContain('fs.renameSync(legacyWtermHome, ztermHome)');
    expect(support.indexOf('fs.renameSync(legacyWtermHome, ztermHome)')).toBeLessThan(support.indexOf("const configPath = path.join(home, '.zterm', 'config.json');"));
    expect(configBlock).toContain("const configPath = path.join(home, '.zterm', 'config.json');");
  });

  it('merges released daemon config per field so empty zterm config cannot mask legacy mobile auth', () => {
    const support = extractSupportHeredocBody();
    const configBlock = block(support, 'read_config() {', 3600, 'generated support');

    expect(configBlock).toContain('const ztermDaemonConfig = ((config.zterm || {}).android || {}).daemon || {};');
    expect(configBlock).toContain('const mobileDaemonConfig = (config.mobile || {}).daemon || {};');
    expect(configBlock).toContain('asString(ztermDaemonConfig.host) || asString(mobileDaemonConfig.host)');
    expect(configBlock).toContain('asPositiveInteger(ztermDaemonConfig.port) || asPositiveInteger(mobileDaemonConfig.port)');
    expect(configBlock).toContain('const authTokenFromConfig = asString(ztermDaemonConfig.authToken) || asString(mobileDaemonConfig.authToken);');
    expect(configBlock).toContain('asString(ztermDaemonConfig.sessionName) || asString(mobileDaemonConfig.sessionName)');
    expect(configBlock).not.toContain('const daemonConfig = ((config.zterm || {}).android || {}).daemon || ((config.mobile || {}).daemon || {});');
  });

  it('keeps install-time native RTC dependencies inside the daemon npm package', () => {
    const script = readDaemonNpmPackageScript();

    expect(script).not.toContain("rmSync(resolve(npmPackageDir, 'runtime/node_modules')");
    expect(script).toContain("requirePath(resolve(releaseDir, 'runtime/node_modules/node-pty')");
    expect(script).toContain("requirePath(resolve(releaseDir, 'runtime/node_modules/@roamhq/wrtc')");
    expect(script).toContain("resolve(releaseDir, `runtime/node_modules/@roamhq/wrtc-${targetOs}-${targetArch}/wrtc.node`)");
    expect(script).toContain('zterm-daemon configure-relay --relay-url');
    expect(script).toContain('--password-stdin');
    expect(script).toContain('passwordSet=true');
  });

  it('makes npm global installs create stable user-level daemon shims', () => {
    const script = readDaemonNpmPackageScript();

    expect(script).toContain("writeFileSync(resolve(npmPackageDir, 'support/install-user-shims.cjs')");
    expect(script).toContain("postinstall: 'node support/install-user-shims.cjs'");
    expect(script).toContain("bin/zterm-daemon.cjs");
    expect(script).toContain("bin/wterm.cjs");
    expect(script).toContain("'zterm-daemon': 'bin/zterm-daemon.cjs'");
    expect(script).toContain("wterm: 'bin/wterm.cjs'");
    expect(script).toContain("writeShim('zterm-daemon'");
    expect(script).toContain("writeShim('wterm'");
    expect(script).toContain("writeShim('zterm-daemon.cmd'");
    expect(script).toContain("writeShim('wterm.cmd'");
    expect(script).toContain("resolve(homedir(), '.local/bin')");
    expect(script).toContain("rmSync(target, { force: true })");
    expect(script).toContain('exec node "\\${packageRoot}/bin/zterm-daemon.cjs" "$@"');
  });

  it('packages a Windows PowerShell daemon runner without duplicating terminal backend truth', () => {
    const packageScript = readDaemonNpmPackageScript();
    const windowsScript = readWindowsDaemonScript();

    expect(packageScript).toContain("mkdirSync(resolve(npmPackageDir, 'support/windows')");
    expect(packageScript).toContain("scripts/windows/zterm-daemon.ps1");
    expect(packageScript).toContain("support/windows/zterm-daemon.ps1");
    expect(packageScript).toContain("process.platform === 'win32'");
    expect(packageScript).toContain("ZTERM_PACKAGE_ROOT: packageRoot");
    expect(packageScript).toContain("powershell.exe");

    expect(windowsScript).toContain('$RuntimeEntry = Join-Path $PackageRoot "runtime\\server.cjs"');
    expect(windowsScript).toContain('$TaskName = "ZTermDaemon"');
    expect(windowsScript).toContain('$FirewallRuleName = "ZTerm Daemon 3333"');
    expect(windowsScript).toContain('function Write-JsonNoBom');
    expect(windowsScript).toContain('[System.Text.UTF8Encoding]::new($false)');
    expect(windowsScript).toContain('[System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)');
    expect(windowsScript).toContain('Write-JsonNoBom $configPath $config');
    expect(windowsScript).not.toContain('Set-Content -LiteralPath $configPath -Encoding UTF8');
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
    const installerBody = block(script, 'write_installer() {', 2600, 'release packager');

    expect(installerBody).toContain('VERSION="$(cat "${PACKAGE_ROOT}/VERSION")"');
    expect(installerBody).toContain('INSTALL_ROOT="${HOME}/.zterm/releases/zterm-daemon/${VERSION}"');
    expect(installerBody).toContain('cp -R "${PACKAGE_ROOT}/support" "${INSTALL_ROOT}/support"');
    expect(installerBody).toContain('cp "${INSTALL_ROOT}/support/zterm-daemon" "${HOME}/.zterm/bin/zterm-daemon"');
    expect(installerBody).toContain('LOCAL_BIN="${HOME}/.local/bin"');
    expect(installerBody).toContain('cat > "${LOCAL_BIN}/zterm-daemon" <<WRAP');
    expect(installerBody).toContain('exec "${INSTALL_ROOT}/support/zterm-daemon.sh" "\\$@"');
    expect(installerBody).toContain('cat > "${LOCAL_BIN}/wterm" <<WRAP');
    expect(installerBody.indexOf('cp "${INSTALL_ROOT}/support/zterm-daemon"')).toBeLessThan(installerBody.indexOf('cat > "${LOCAL_BIN}/zterm-daemon" <<WRAP'));
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
