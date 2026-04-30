import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readDaemonScript() {
  return readFileSync(join(process.cwd(), 'scripts', 'zterm-daemon.sh'), 'utf8');
}

function extractBlock(script: string, anchor: string, length = 1200) {
  const start = script.indexOf(anchor);
  expect(start, `${anchor} should exist in zterm-daemon.sh`).toBeGreaterThanOrEqual(0);
  return script.slice(start, start + length);
}

describe('zterm daemon service script truth gates', () => {
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

  it('does not fallback to tmux session when launchd service start or restart is unhealthy', () => {
    const script = readDaemonScript();
    const startBody = extractBlock(script, 'start_service() {', 1400);
    const restartBody = extractBlock(script, 'restart_service() {', 1400);
    expect(startBody).not.toContain('falling back to tmux session');
    expect(startBody).not.toContain('start_tmux');
    expect(restartBody).not.toContain('falling back to tmux session');
    expect(restartBody).not.toContain('start_tmux');
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
