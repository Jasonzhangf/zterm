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
    const script = readProjectFile('scripts/zterm-daemon.sh');
    const installBody = extractBlock(script, 'install_service() {', 1100);
    const stageNativeBody = extractBlock(script, 'stage_native_daemon_binary() {', 900);
    const preflightBody = extractBlock(script, 'prime_daemon_install_permissions() {', 2200);

    expect(installBody).toContain('prime_daemon_install_permissions');
    expect(installBody.indexOf('prime_daemon_install_permissions')).toBeLessThan(installBody.indexOf('bootstrap_service'));
    expect(stageNativeBody).toContain('-nt "$NATIVE_DAEMON_SOURCE"');
    expect(preflightBody).toMatch(/screen|screenshot|screencapture|ScreenCaptureKit/u);
    expect(preflightBody).toContain('zterm-daemon');
    expect(preflightBody).toContain('capture-screen');
    expect(preflightBody).not.toContain("execFileSync('/usr/sbin/screencapture'");
    expect(preflightBody).not.toContain("execFileSync('/bin/launchctl'");
    expect(preflightBody).not.toMatch(/permission belongs to the GUI screenshot helper|Mac 端截图 helper/u);
  });

  it('keeps packaged global daemon install-service aligned with source preflight', () => {
    const releaseScript = readProjectFile('scripts/prepare-global-daemon-release.sh');
    const installBody = extractBlock(releaseScript, 'install_service() {', 1200);

    expect(releaseScript).toContain('prime_daemon_install_permissions()');
    expect(releaseScript).toContain('capture-screen');
    expect(releaseScript).toContain('ZTERM_DAEMON_NATIVE');
    expect(installBody).toContain('prime_daemon_install_permissions');
    expect(installBody.indexOf('prime_daemon_install_permissions')).toBeLessThan(installBody.indexOf('bootstrap_service'));
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
