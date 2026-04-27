import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readDaemonScript() {
  return readFileSync(join(process.cwd(), 'scripts', 'zterm-daemon.sh'), 'utf8');
}

function extractFunctionBody(script: string, name: string) {
  const match = script.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`, 'm'));
  expect(match, `${name}() should exist in zterm-daemon.sh`).not.toBeNull();
  return match?.[1] || '';
}

describe('zterm daemon service script truth gates', () => {
  it('restages the current daemon runtime before bootstrapping launchd on service start', () => {
    const script = readDaemonScript();
    const body = extractFunctionBody(script, 'start_service');
    expect(body).toContain('write_launch_agent');
    expect(body.indexOf('write_launch_agent')).toBeLessThan(body.indexOf('bootstrap_service'));
  });

  it('restages the current daemon runtime before bootstrapping launchd on service restart', () => {
    const script = readDaemonScript();
    const body = extractFunctionBody(script, 'restart_service');
    expect(body).toContain('write_launch_agent');
    expect(body.indexOf('write_launch_agent')).toBeLessThan(body.indexOf('bootstrap_service'));
  });

  it('does not fallback to tmux session when launchd service start or restart is unhealthy', () => {
    const script = readDaemonScript();
    const startBody = extractFunctionBody(script, 'start_service');
    const restartBody = extractFunctionBody(script, 'restart_service');
    expect(startBody).not.toContain('falling back to tmux session');
    expect(startBody).not.toContain('start_tmux');
    expect(restartBody).not.toContain('falling back to tmux session');
    expect(restartBody).not.toContain('start_tmux');
  });
});
