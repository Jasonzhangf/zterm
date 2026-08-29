import { describe, expect, it } from 'vitest';
import { readDaemonSessionObservation } from './daemon-session-agent-status-runtime';

describe('daemon passive session observation', () => {
  it('reports process, output, and OSC facts from tmux only', () => {
    const history = new Map();
    const deps = {
      history,
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
      runTmux: (args: string[]) => ({
        ok: true as const,
        stdout: args[0] === 'list-panes' ? '42\tcodex' : '\u001b]0;title\u0007\u001b]133;A\u0007thinking',
      }),
    };
    readDaemonSessionObservation(deps, 'fixture', 1000);
    const result = readDaemonSessionObservation(deps, 'fixture', 4000);
    expect(result).toEqual({
      observedAt: 4000, foregroundProcess: 'codex', processGroupAlive: true,
      recentOutput: true, oscTitleSeen: true, oscProgressSeen: true,
      status: 'running', statusReason: 'evidence-confirmed',
      stableRefreshDue: true,
    });
  });

  it('keeps a running result while the observed content sequence changes', () => {
    const history = new Map();
    let output = 'thinking step 1';
    const deps = {
      history,
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
      runTmux: (args: string[]) => ({
        ok: true as const,
        stdout: args[0] === 'list-panes' ? '42\tcodex' : output,
      }),
    };
    readDaemonSessionObservation(deps, 'sequence', 0);
    expect(readDaemonSessionObservation(deps, 'sequence', 2999).status).toBe('unknown');
    output = 'thinking step 2';
    expect(readDaemonSessionObservation(deps, 'sequence', 3100).status).toBe('running');
  });

  it('returns unknown when process/output evidence is insufficient', () => {
    const result = readDaemonSessionObservation({
      runTmux: (args) => ({ ok: true as const, stdout: args[0] === 'list-panes' ? '' : '' }),
    }, 'empty', 1000);
    expect(result).toEqual({
      observedAt: 1000, recentOutput: false,
      oscTitleSeen: false, oscProgressSeen: false,
      status: 'unknown', statusReason: 'insufficient-evidence',
    });
  });

  it('classifies idle only from a known process plus an explicit manifest signal', () => {
    const history = new Map();
    const deps = {
      history,
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
      runTmux: (args: string[]) => ({
        ok: true as const,
        stdout: args[0] === 'list-panes' ? '42\tcodex' : 'ready',
      }),
    };
    readDaemonSessionObservation(deps, 'idle-fixture', 0);
    readDaemonSessionObservation(deps, 'idle-fixture', 3000);
    readDaemonSessionObservation(deps, 'idle-fixture', 3100);
    readDaemonSessionObservation(deps, 'idle-fixture', 3300);
    const result = readDaemonSessionObservation(deps, 'idle-fixture', 3400);
    expect(result.status).toBe('idle');
    expect(result.statusReason).toBe('evidence-confirmed');
  });

  it('does not infer running from output alone or idle from no output', () => {
    const outputOnly = readDaemonSessionObservation({
      runTmux: (args) => ({ ok: true as const, stdout: args[0] === 'list-panes' ? '42\tsh' : 'thinking' }),
    }, 'output-only', 1000);
    const noOutput = readDaemonSessionObservation({
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
      runTmux: (args) => ({ ok: true as const, stdout: args[0] === 'list-panes' ? '42\tcodex' : '' }),
    }, 'no-output', 1000);
    expect(outputOnly.status).toBe('unknown');
    expect(noOutput.status).toBe('unknown');
  });

  it('returns error instead of reusing prior success when tmux observation fails', () => {
    const result = readDaemonSessionObservation({
      runTmux: () => ({ ok: false as const, error: 'session disappeared' }),
    }, 'gone', 1000);
    expect(result.status).toBe('error');
    expect(result.statusReason).toBe('observation-error');
  });

  it('stabilizes a changed process/output sample before publishing a new status', () => {
    const history = new Map();
    let output = 'thinking';
    const deps = {
      history,
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
      runTmux: (args: string[]) => ({
        ok: true as const,
        stdout: args[0] === 'list-panes' ? '42\tcodex' : output,
      }),
    };
    readDaemonSessionObservation(deps, 'replacement', 0);
    expect(readDaemonSessionObservation(deps, 'replacement', 4000).status).toBe('running');
    output = 'ready';
    expect(readDaemonSessionObservation(deps, 'replacement', 4100).status).toBe('unknown');
    expect(readDaemonSessionObservation(deps, 'replacement', 4200).status).toBe('unknown');
    expect(readDaemonSessionObservation(deps, 'replacement', 4300).status).toBe('unknown');
    expect(readDaemonSessionObservation(deps, 'replacement', 4400).status).toBe('idle');
  });
});
