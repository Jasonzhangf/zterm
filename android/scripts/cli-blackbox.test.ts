import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FULL_CLI_USER_PATH_STAGES,
  deriveCliBlackboxOutcome,
  type CliBlackboxStageResult,
} from './cli-blackbox';
import { projectVisibleTerminalText } from './cli-blackbox-pty';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const wrapperPath = join(scriptDir, 'cli-blackbox-tmux-wrapper.mjs');
const ownedSocket = '/tmp/cli-blackbox-owned.sock';
const ownedSession = 'cli-blackbox-owned-session';

describe('cli blackbox PTY projection', () => {
  it('matches a marker whose characters are separated by ANSI CSI sequences', () => {
    const marker = 'CLI_BLACKBOX_MARKER_owned';
    const projected = [marker, 'missing']
      .map((value, index) => (
        index === 0
          ? value.split('').map((char) => `\x1B[0;39;49m${char}`).join('')
          : value
      ))
      .map(projectVisibleTerminalText);

    expect(projected[0]).toContain(marker);
    expect(projected[1]).not.toContain(marker);
  });
});

function runWrapper(args: string[], socket = ownedSocket) {
  return spawnSync(process.execPath, [wrapperPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLI_BLACKBOX_REAL_TMUX: '/bin/echo',
      CLI_BLACKBOX_TMUX_SOCKET: socket,
      CLI_BLACKBOX_TMUX_SESSION: ownedSession,
      CLI_BLACKBOX_TMUX_AUDIT_LOG: '',
    },
  });
}

describe('cli blackbox tmux wrapper', () => {
  it('pins every invocation to the owned socket', () => {
    const result = runWrapper(['list-sessions']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`-S ${ownedSocket} list-sessions`);
  });

  it('accepts the owned socket when the daemon supplies it explicitly', () => {
    const result = runWrapper(['-S', ownedSocket, 'display-message', '-p', '#{pid}']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`-S ${ownedSocket} display-message -p #{pid}`);
  });

  it('rejects a foreign explicit socket', () => {
    const result = runWrapper(['-S', '/tmp/some-other.sock', 'list-sessions']);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('foreign tmux socket rejected');
  });

  it('rejects a named socket', () => {
    const result = runWrapper(['-L', 'other', 'list-sessions']);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('named tmux sockets are not allowed');
  });

  it('rejects leading tmux options before the command', () => {
    const result = runWrapper(['-2', 'kill-server']);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('command must be the first non-socket argument');
  });

  it('preserves capture-pane start-line -S as a command option', () => {
    const result = runWrapper([
      'capture-pane',
      '-p',
      '-e',
      '-t',
      ownedSession,
      '-S',
      '-20',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `-S ${ownedSocket} capture-pane -p -e -t ${ownedSession} -S -20`,
    );
  });

  it('rejects kill-server', () => {
    const result = runWrapper(['kill-server']);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('kill-server is forbidden');
  });

  it('rejects kill-session for any other session', () => {
    const result = runWrapper(['kill-session', '-t', 'some-other-session']);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('limited to the owned session');
  });

  it('allows kill-session only for the exact owned session', () => {
    const result = runWrapper(['kill-session', '-t', `=${ownedSession}`]);
    expect(result.status).toBe(0);
  });

  it('rejects indirect shell commands', () => {
    const result = runWrapper(['run-shell', 'tmux kill-server']);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('could bypass isolated lifecycle guards');
  });

  it('rejects command-prompt', () => {
    const result = runWrapper(['command-prompt', '-p', 'kill-server']);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('could bypass isolated lifecycle guards');
  });
});

function stagesWith(
  overrides: Record<string, CliBlackboxStageResult['status']>,
): CliBlackboxStageResult[] {
  return FULL_CLI_USER_PATH_STAGES.map((stage) => ({
    stage,
    status: overrides[stage] || 'passed',
    startedAt: '2026-10-20T00:00:00.000Z',
    durationMs: 1,
  }));
}

describe('cli blackbox completion contract', () => {
  it('reports incomplete when the formal CLI path was not run', () => {
    const outcome = deriveCliBlackboxOutcome({
      stages: stagesWith({ 'full-cli-user-path': 'not-run' }),
      cleanup: { cleaned: true },
      formalEntryExists: false,
    });

    expect(outcome).toMatchObject({
      ok: false,
      state: 'incomplete',
    });
    expect(outcome.gaps.join('\n')).toContain('full-cli-user-path');
    expect(outcome.gaps.join('\n')).toContain('packages/cli/src/main.ts');
  });

  it('reports a failure when any required stage fails', () => {
    const outcome = deriveCliBlackboxOutcome({
      stages: stagesWith({ 'cli-slot-set': 'failed' }),
      cleanup: { cleaned: true },
      formalEntryExists: true,
    });

    expect(outcome).toMatchObject({
      ok: false,
      state: 'failed',
    });
    expect(outcome.gaps.join('\n')).toContain('cli-slot-set');
  });

  it('does not pass unless every required stage passed and cleanup completed', () => {
    expect(deriveCliBlackboxOutcome({
      stages: stagesWith({}),
      cleanup: { cleaned: false },
      formalEntryExists: true,
    })).toMatchObject({
      ok: false,
      state: 'failed',
    });

    expect(deriveCliBlackboxOutcome({
      stages: stagesWith({}),
      cleanup: { cleaned: true },
      formalEntryExists: true,
    })).toEqual({
      ok: true,
      state: 'full-user-path-passed',
      gaps: [],
    });
  });
});
