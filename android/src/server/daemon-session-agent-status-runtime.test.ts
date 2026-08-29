import { describe, expect, it } from 'vitest';
import { readDaemonSessionObservation } from './daemon-session-agent-status-runtime';

describe('daemon passive session observation', () => {
  it('reports process, output, and OSC facts from tmux only', () => {
    const result = readDaemonSessionObservation({
      runTmux: (args) => ({
        ok: true as const,
        stdout: args[0] === 'list-panes' ? '42\tcodex' : '\u001b]0;title\u0007\u001b]133;A\u0007output',
      }),
    }, 'fixture', 1000);
    expect(result).toEqual({
      observedAt: 1000, foregroundProcess: 'codex', processGroupAlive: true,
      recentOutput: true, oscTitleSeen: true, oscProgressSeen: true,
    });
  });

  it('does not fabricate agent semantic state when process/output is absent', () => {
    const result = readDaemonSessionObservation({
      runTmux: (args) => ({ ok: true as const, stdout: args[0] === 'list-panes' ? '' : '' }),
    }, 'empty', 1000);
    expect(result).toEqual({
      observedAt: 1000, processGroupAlive: false, recentOutput: false,
      oscTitleSeen: false, oscProgressSeen: false,
    });
  });
});
