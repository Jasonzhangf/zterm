import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRemoteScreenshotErrorMessage } from './remote-screenshot';

function readProjectFile(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

function extractBlock(source: string, anchor: string, length = 1800) {
  const start = source.indexOf(anchor);
  expect(start, `${anchor} should exist`).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('remote screenshot daemon black-box contract', () => {
  it('documents daemon install/runtime as the only screenshot capability owner', () => {
    const architecture = readProjectFile('docs/architecture.md');
    const decision = readProjectFile('docs/remote-screenshot-daemon-blackbox-regression.md');
    const remoteScreenshotSection = extractBlock(architecture, '## Remote screenshot 链路', 900);

    expect(decision).toContain('安装 `zterm-daemon` 时完成 macOS 截图权限申请');
    expect(remoteScreenshotSection).toContain('daemon');
    expect(remoteScreenshotSection).toContain('截图能力的唯一执行主体');
    expect(remoteScreenshotSection).not.toMatch(/GUI screenshot helper|helper 与 daemon|helper 不关心/u);
  });

  it('primes screenshot permission from daemon install-service before bootstrap', () => {
    const script = readProjectFile('scripts/prepare-global-daemon-release.sh');
    const installBody = extractBlock(script, 'install_service() {', 1100);
    const stageNativeBody = extractBlock(script, 'stage_native_daemon_binary() {', 900);
    const preflightBody = extractBlock(script, 'prime_daemon_install_permissions() {', 2600);

    expect(installBody).toContain('prime_daemon_install_permissions');
    expect(installBody.indexOf('prime_daemon_install_permissions')).toBeLessThan(installBody.indexOf('bootstrap_service'));
    expect(stageNativeBody).toContain('-nt "${NATIVE_DAEMON_SOURCE}"');
    expect(stageNativeBody).toContain('-nt "${REMOTE_WINDOW_CAPTURE_SOURCE}"');
    expect(preflightBody).toMatch(/screen|screenshot|screencapture|ScreenCaptureKit/u);
    expect(preflightBody).toContain('zterm-daemon');
    expect(preflightBody).toContain("process.env.ZTERM_DAEMON_NATIVE");
    expect(preflightBody).not.toContain('ZTERM_DAEMON_CAPTURE_NATIVE');
    expect(preflightBody).toContain('--permission-probe');
    expect(preflightBody).toContain('ScreenCaptureKit permission preflight failed');
    expect(preflightBody).toContain('Privacy & Security -> Screen & System Audio Recording');
    expect(preflightBody).toContain('clicking + and adding that exact file');
    expect(preflightBody).toContain('refused to show a grant dialog');
    expect(preflightBody).not.toContain('grant dialog is owned by this install step');
    expect(preflightBody).not.toContain("execFileSync('/usr/sbin/screencapture'");
    expect(preflightBody).not.toContain("execFileSync('/bin/launchctl'");
    expect(preflightBody).not.toMatch(/permission belongs to the GUI screenshot helper|Mac 端截图 helper/u);
  });

  it('keeps packaged global daemon install-service aligned with source preflight', () => {
    const releaseScript = readProjectFile('scripts/prepare-global-daemon-release.sh');
    const installBody = extractBlock(releaseScript, 'install_service() {', 1200);
    const preflightBody = extractBlock(releaseScript, 'prime_daemon_install_permissions() {', 2600);

    expect(releaseScript).toContain('prime_daemon_install_permissions()');
    expect(releaseScript).toContain('ZTERM_DAEMON_NATIVE');
    expect(releaseScript).toContain('--permission-probe');
    expect(releaseScript).not.toContain('ZTERM_DAEMON_CAPTURE_NATIVE');
    expect(releaseScript).not.toContain('zterm-remote-window-capture');
    expect(preflightBody).toContain("process.env.ZTERM_DAEMON_NATIVE");
    expect(preflightBody).not.toContain('ZTERM_DAEMON_CAPTURE_NATIVE');
    expect(preflightBody).not.toMatch(/\/usr\/sbin\/screencapture|capture-screen/u);
    expect(installBody).toContain('prime_daemon_install_permissions');
    expect(installBody.indexOf('prime_daemon_install_permissions')).toBeLessThan(installBody.indexOf('bootstrap_service'));
  });

  it('installs the canonical daemon native binary through the global installer', () => {
    const releaseScript = readProjectFile('scripts/prepare-global-daemon-release.sh');
    const marker = 'write_installer() {';
    const start = releaseScript.indexOf(marker);
    const end = releaseScript.indexOf('\nEOF\n', start);
    expect(start, `${marker} should exist`).toBeGreaterThanOrEqual(0);
    expect(end, 'write_installer heredoc should end with newline EOF newline').toBeGreaterThanOrEqual(0);
    const installerBody = releaseScript.slice(start, end + '\nEOF\n'.length);

    const copyIndex = installerBody.indexOf('cp "${INSTALL_ROOT}/support/zterm-daemon" "${NATIVE_TMP}"');
    const chmodIndex = installerBody.indexOf('chmod +x "${NATIVE_TMP}"');
    const moveIndex = installerBody.indexOf('mv "${NATIVE_TMP}" "${HOME}/.zterm/bin/zterm-daemon"');

    expect(releaseScript).not.toContain('install_user_shims');
    expect(installerBody).toContain('mkdir -p "${INSTALL_ROOT}" "${LOCAL_BIN}" "${HOME}/.zterm/bin"');
    expect(installerBody).toContain('NATIVE_TMP="${HOME}/.zterm/bin/.zterm-daemon.$$"');
    expect(copyIndex).toBeGreaterThanOrEqual(0);
    expect(chmodIndex).toBeGreaterThan(copyIndex);
    expect(moveIndex).toBeGreaterThan(chmodIndex);
  });

  it('captures screenshots with ScreenCaptureKit inside one daemon identity', () => {
    const nativeDaemon = readProjectFile('scripts/native/zterm-daemon.swift');
    const windowIdBlock = extractBlock(nativeDaemon, 'if let windowId = windowId {', 520);
    const captureSource = readProjectFile('src/server/remote-window-screen-capture-script.ts');

    expect(windowIdBlock).toContain('SCContentFilter(desktopIndependentWindow: window)');
    expect(nativeDaemon).toContain('guard hasScreenCapturePermission() else');
    expect(captureSource).toContain('CGPreflightScreenCaptureAccess()');
    expect(nativeDaemon).toContain('SCScreenshotManager.captureImage');
    expect(nativeDaemon).not.toContain('/usr/sbin/screencapture');
    expect(nativeDaemon).not.toMatch(/(^|[^\w])Process\(\)/u);
  });

  it('requests Screen Recording permission at install time instead of leaving the user to add it', () => {
    // The install probe is the product's grant step. A preflight-only probe made
    // macOS never prompt, so the Privacy list had no zterm entry and every first
    // user had to open System Settings and pick the capture binary by hand.
    const nativeDaemon = readProjectFile('scripts/native/zterm-daemon.swift');
    const permissionProbeBlock = extractBlock(nativeDaemon, 'if args.dropFirst().first == "--permission-probe"', 520);
    const requestBlock = extractBlock(nativeDaemon, 'static func requestScreenCapturePermission()', 900);

    expect(permissionProbeBlock).toContain('requestScreenCapturePermission()');
    expect(permissionProbeBlock).not.toContain('hasScreenCapturePermission() else');
    expect(requestBlock).toContain('CGRequestScreenCaptureAccess()');
    // One request, one bounded wait, one exit: never a loop that re-asks or resets TCC.
    expect(requestBlock).toContain('permissionGrantDeadline()');
    // The install step must say what it is waiting for, not fall silent.
    expect(requestBlock).toContain('Answer the macOS dialog');
    expect(nativeDaemon).not.toContain('tccutil');
  });

  it('does not expose helper/socket/start-Mac-app guidance to Android users', () => {
    const message = resolveRemoteScreenshotErrorMessage(new Error('daemon screenshot capture unavailable'), 15000);

    expect(message).toMatch(/daemon|zterm-daemon|截图权限/u);
    expect(message).not.toMatch(/helper|Mac 端|socket|Codex/u);
  });

  it('keeps daemon remote screenshot runtime free of helper socket dependency', () => {
    const runtime = readProjectFile('src/server/terminal-file-transfer-list-runtime.ts');
    const daemonCapture = readProjectFile('src/server/remote-screenshot-daemon.ts');

    expect(runtime).toContain('remote-screenshot-status');
    expect(runtime).toContain("phase: 'capturing'");
    expect(runtime).toContain("phase: 'transferring'");
    expect(runtime).not.toMatch(/remote-screenshot-helper-client|requestRemoteScreenshotViaHelper|remote-screenshot-helper\.sock/u);
    expect(daemonCapture).toContain('ZTERM_DAEMON_NATIVE');
    expect(daemonCapture).toContain("'capture-screen'");
    expect(daemonCapture).not.toMatch(/\/usr\/sbin\/screencapture|\/bin\/launchctl/u);
  });
});
