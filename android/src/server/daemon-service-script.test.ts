import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readDaemonScript() {
  return readFileSync(join(process.cwd(), 'scripts', 'zterm-daemon.sh'), 'utf8');
}

function readReleaseScript() {
  return readFileSync(join(process.cwd(), 'scripts', 'prepare-global-daemon-release.sh'), 'utf8');
}

function readDaemonNpmPackageScript() {
  return readFileSync(join(process.cwd(), 'scripts', 'prepare-daemon-npm-package.mjs'), 'utf8');
}

function readWindowsDaemonScript() {
  return readFileSync(join(process.cwd(), 'scripts', 'windows', 'zterm-daemon.ps1'), 'utf8');
}

function readReleaseVerifyScript() {
  return readFileSync(join(process.cwd(), 'scripts', 'verify-release-assets.mjs'), 'utf8');
}

function extractBlock(script: string, anchor: string, length = 1200) {
  const start = script.indexOf(anchor);
  expect(start, `${anchor} should exist in zterm-daemon.sh`).toBeGreaterThanOrEqual(0);
  return script.slice(start, start + length);
}

describe('zterm daemon service script truth gates', () => {
  it('exposes relay account configuration as a global daemon command without leaking secrets', () => {
    const script = readDaemonScript();
    const usageBlock = extractBlock(script, 'Usage:', 1200);
    const caseBlock = extractBlock(script, 'case "$cmd" in', 1200);
    const configureBody = extractBlock(script, 'configure_relay() {', 5200);

    expect(usageBlock).toContain('configure-relay --relay-url');
    expect(caseBlock).toContain('configure-relay) configure_relay "$@" ;;');
    expect(configureBody).toContain('mobile.relay');
    expect(configureBody).toContain('passwordSet=true');
    expect(configureBody).not.toContain('password=${relay_password}');
  });

  it('writes relay config from the global command while preserving daemon config', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'zterm-daemon-relay-config-'));
    try {
      const configPath = join(tempHome, '.zterm', 'config.json');
      mkdirSync(join(tempHome, '.zterm'), { recursive: true });
      writeFileSync(
        configPath,
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

      const output = execFileSync(
        'bash',
        [
          './scripts/zterm-daemon.sh',
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
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, HOME: tempHome },
          encoding: 'utf8',
        },
      );

      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(config.mobile.daemon.authToken).toBe('keep-daemon-token');
      expect(config.mobile.relay).toMatchObject({
        relayUrl: 'https://relay.example.com/relay/',
        username: 'zterm-relay-smoke',
        password: 'secret-password',
        hostId: 'mac-studio',
        deviceName: 'Mac Studio',
      });
      expect(output).toContain('passwordSet=true');
      expect(output).not.toContain('secret-password');
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('keeps relay configuration available in generated global release installers', () => {
    const script = readReleaseScript();

    expect(script).toContain('zterm-daemon configure-relay --relay-url URL');
    expect(script).toContain('configure-relay) configure_relay "$@" ;;');
    expect(script).toContain('wait_for_service_unloaded()');
    expect(script).toContain("resolve_node_package_dir '@roamhq/wrtc'");
    expect(script).toContain('resolve_wrtc_platform_package_name');
    expect(extractBlock(script, 'start_service() {', 1300)).not.toContain('prime_daemon_install_permissions');
    expect(extractBlock(script, 'restart_service() {', 1300)).not.toContain('prime_daemon_install_permissions');
    expect(script).toContain('start|stop|restart|status|configure-relay|install-service|uninstall-service|service-status|run');
  });

  it('migrates legacy ~/.wterm home before reading released daemon config', () => {
    const script = readReleaseScript();
    const configBlock = extractBlock(script, "const configPath = path.join(home, '.zterm', 'config.json');", 500);

    expect(script).toContain("const ztermHome = path.join(home, '.zterm');");
    expect(script).toContain("const legacyWtermHome = path.join(home, '.wterm');");
    expect(script).toContain('fs.renameSync(legacyWtermHome, ztermHome)');
    expect(script.indexOf('fs.renameSync(legacyWtermHome, ztermHome)')).toBeLessThan(script.indexOf("const configPath = path.join(home, '.zterm', 'config.json');"));
    expect(configBlock).toContain("const configPath = path.join(home, '.zterm', 'config.json');");
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

  it('restages the current daemon runtime before bootstrapping launchd on service start', () => {
    const script = readDaemonScript();
    const body = extractBlock(script, 'start_service() {', 1400);
    expect(body).toContain('write_launch_agent');
    expect(body.indexOf('write_launch_agent')).toBeLessThan(body.indexOf('bootstrap_service'));
    expect(body).toContain('wait_for_service_unloaded');
    expect(body.indexOf('wait_for_service_unloaded')).toBeLessThan(body.indexOf('bootstrap_service'));
  });

  it('restages the current daemon runtime before bootstrapping launchd on service restart', () => {
    const script = readDaemonScript();
    const body = extractBlock(script, 'restart_service() {', 1400);
    expect(body).toContain('write_launch_agent');
    expect(body.indexOf('write_launch_agent')).toBeLessThan(body.indexOf('bootstrap_service'));
    expect(body).toContain('wait_for_service_unloaded');
    expect(body.indexOf('wait_for_service_unloaded')).toBeLessThan(body.indexOf('bootstrap_service'));
  });

  it('keeps global CLI shims synchronized when writing launchd service runners', () => {
    const script = readDaemonScript();
    const body = extractBlock(script, 'install_user_shims() {', 900);
    const launchBody = extractBlock(script, 'write_launch_agent() {', 500);

    expect(script).toContain('USER_BIN_DIR="${HOME}/.local/bin"');
    expect(body).toContain('rm -f "${USER_BIN_DIR}/zterm-daemon" "${USER_BIN_DIR}/wterm"');
    expect(body).toContain('${USER_BIN_DIR}/zterm-daemon');
    expect(body).toContain('${USER_BIN_DIR}/wterm');
    expect(body).toContain('exec bash "${ROOT_DIR}/scripts/zterm-daemon.sh" "\\$@"');
    expect(launchBody).toContain('install_user_shims');
    expect(launchBody.indexOf('install_user_shims')).toBeLessThan(launchBody.indexOf('stage_daemon_runtime'));
  });

  it('keeps released service runner installs synchronized with user-level shims', () => {
    const script = readReleaseScript();
    const body = extractBlock(script, 'install_user_shims() {', 900);
    const launchBody = extractBlock(script, 'write_launch_agent() {', 500);

    expect(script).toContain('USER_BIN_DIR="${HOME}/.local/bin"');
    expect(body).toContain('rm -f "${USER_BIN_DIR}/zterm-daemon" "${USER_BIN_DIR}/wterm"');
    expect(body).toContain('${USER_BIN_DIR}/zterm-daemon');
    expect(body).toContain('${USER_BIN_DIR}/wterm');
    expect(body).toContain('exec "${PACKAGE_ROOT}/support/zterm-daemon.sh" "\\$@"');
    expect(launchBody).toContain('install_user_shims');
    expect(launchBody.indexOf('install_user_shims')).toBeLessThan(launchBody.indexOf('mkdir -p "${HOME}/Library/LaunchAgents"'));
  });

  it('does not fallback to tmux session when launchd service start or restart is unhealthy', () => {
    const script = readDaemonScript();
    const startBody = extractBlock(script, 'start_service() {', 1400);
    const restartBody = extractBlock(script, 'restart_service() {', 1400);
    expect(startBody).not.toContain('falling back to tmux session');
    expect(startBody).not.toContain('start_tmux');
    expect(restartBody).not.toContain('falling back to tmux session');
    expect(restartBody).not.toContain('start_tmux');
  });

  it('primes file-sync permissions during daemon service install before launchd bootstrap', () => {
    const script = readDaemonScript();
    const installBody = extractBlock(script, 'install_service() {', 900);
    const preflightBody = extractBlock(script, 'prime_daemon_install_permissions() {', 1600);
    expect(script).toContain('prime_daemon_install_permissions()');
    expect(installBody).toContain('write_launch_agent');
    expect(installBody).toContain('prime_daemon_install_permissions');
    expect(installBody.indexOf('prime_daemon_install_permissions')).toBeLessThan(installBody.indexOf('bootstrap_service'));
    expect(preflightBody).toContain('Downloads');
    expect(preflightBody).toContain('.zterm');
    expect(preflightBody).toContain('.zterm-permission-preflight');
  });

  it('only emits package-resolve error after both require.resolve and filesystem fallback fail', () => {
    const script = readDaemonScript();
    const body = extractBlock(script, 'resolve_node_package_dir() {', 1600);
    expect(body).toContain('find "${ROOT_DIR}/node_modules/.pnpm"');
    expect(body).toContain('find "${WORKSPACE_ROOT}/node_modules/.pnpm"');
    expect(body).toContain('if [[ -n "${candidate}" ]]');
    expect(body).toContain('echo "[zterm-daemon] unable to resolve ${package_name} in ${ROOT_DIR} or ${WORKSPACE_ROOT}" >&2');
    expect(body.indexOf('if [[ -n "${candidate}" ]]')).toBeLessThan(body.indexOf('echo "[zterm-daemon] unable to resolve ${package_name} in ${ROOT_DIR} or ${WORKSPACE_ROOT}" >&2'));
  });

  it('uses direct background pid truth instead of tmux sessions when launchd service is not installed', () => {
    const script = readDaemonScript();
    const usageBlock = extractBlock(script, 'Behavior:', 300);
    const startBody = extractBlock(script, 'start() {', 260);
    const stopBody = extractBlock(script, 'stop() {', 260);
    const restartBody = extractBlock(script, 'restart() {', 320);
    const statusBody = extractBlock(script, 'status() {', 420);
    const directStartBody = extractBlock(script, 'start_direct() {', 1800);
    const directStopBody = extractBlock(script, 'stop_direct() {', 1200);

    expect(script).toContain('DAEMON_PID_FILE=');
    expect(usageBlock).toContain('direct background daemon process');
    expect(startBody).toContain('start_direct');
    expect(stopBody).toContain('stop_direct');
    expect(restartBody).toContain('stop_direct');
    expect(restartBody).toContain('start_direct');
    expect(statusBody).toContain('status_direct');
    expect(directStartBody).toContain("printf '%s\\n' \"${daemon_pid}\" > \"${DAEMON_PID_FILE}\"");
    expect(directStopBody).toContain('read_daemon_pid');
    expect(script).not.toContain('start_tmux() {');
    expect(script).not.toContain('stop_tmux() {');
    expect(script).not.toContain('status_tmux() {');
    expect(script).not.toContain('tmux new-session -d -s "$SESSION_NAME"');
    expect(script).not.toContain('tmux kill-session -t "$SESSION_NAME"');
  });
});
