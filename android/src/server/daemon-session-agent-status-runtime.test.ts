import { describe, expect, it } from 'vitest';
import {
  readDaemonSessionObservations,
  type DaemonSessionObservationHistoryEntry,
} from './daemon-session-agent-status-runtime';

function batchDeps(options: {
  names: readonly string[];
  history?: Map<string, DaemonSessionObservationHistoryEntry>;
  output?: string | ((sessionName: string) => string);
  readProcessGroup?: () => { groupId: string; alive: boolean };
  listPanes?: () => string;
  listPanesFails?: boolean;
}) {
  const output = options.output ?? 'thinking';
  return {
    history: options.history,
    readProcessGroup: options.readProcessGroup ?? (() => ({ groupId: 'pg-1', alive: true })),
    runTmuxAsync: async (args: string[]) => {
      if (args[0] === 'list-panes') {
        if (options.listPanesFails) {
          throw new Error('tmux list-panes failed');
        }
        return {
          ok: true as const,
          stdout: options.listPanes
            ? options.listPanes()
            : options.names.map((name) => `${name}\t42\tcodex`).join('\n'),
        };
      }
      const sessionName = args[args.indexOf('-t') + 1]!;
      return {
        ok: true as const,
        stdout: typeof output === 'function' ? output(sessionName) : output,
      };
    },
  };
}

describe('daemon passive session observation', () => {
  it('reports process, output, and OSC facts from tmux only', async () => {
    const history = new Map();
    const deps = batchDeps({
      names: ['fixture'],
      history,
      output: '\u001b]0;title\u0007\u001b]133;A\u0007thinking',
    });

    await readDaemonSessionObservations(deps, ['fixture'], 1000);
    const result = (await readDaemonSessionObservations(deps, ['fixture'], 4000)).get('fixture');
    expect(result).toEqual({
      observedAt: 4000, foregroundProcess: 'codex', processGroupAlive: true,
      recentOutput: true, oscTitleSeen: true, oscProgressSeen: true,
      status: 'running', statusReason: 'evidence-confirmed',
      stableRefreshDue: true,
    });
  });

  it('keeps a running result while the observed content sequence changes', async () => {
    const history = new Map();
    let output = 'thinking step 1';
    const deps = batchDeps({ names: ['sequence'], history, output: () => output });

    await readDaemonSessionObservations(deps, ['sequence'], 0);
    expect((await readDaemonSessionObservations(deps, ['sequence'], 2999)).get('sequence')?.status).toBe('unknown');
    output = 'thinking step 2';
    expect((await readDaemonSessionObservations(deps, ['sequence'], 3100)).get('sequence')?.status).toBe('running');
  });

  it('returns unknown when process/output evidence is insufficient', async () => {
    // Pane row present but with no process facts, and no captured output.
    const deps = batchDeps({ names: ['empty'], output: '', listPanes: () => 'empty\t\t' });
    const result = (await readDaemonSessionObservations(deps, ['empty'], 1000)).get('empty');
    expect(result).toEqual({
      observedAt: 1000, recentOutput: false,
      oscTitleSeen: false, oscProgressSeen: false,
      status: 'unknown', statusReason: 'insufficient-evidence',
    });
  });

  it('classifies idle only from a known process plus an explicit manifest signal', async () => {
    const history = new Map();
    const deps = batchDeps({ names: ['idle-fixture'], history, output: 'ready' });

    await readDaemonSessionObservations(deps, ['idle-fixture'], 0);
    await readDaemonSessionObservations(deps, ['idle-fixture'], 3000);
    await readDaemonSessionObservations(deps, ['idle-fixture'], 3100);
    await readDaemonSessionObservations(deps, ['idle-fixture'], 3300);
    const result = (await readDaemonSessionObservations(deps, ['idle-fixture'], 3400)).get('idle-fixture');
    expect(result?.status).toBe('idle');
    expect(result?.statusReason).toBe('evidence-confirmed');
  });

  it('does not infer running from output alone or idle from no output', async () => {
    const outputOnly = (await readDaemonSessionObservations(
      batchDeps({ names: ['output-only'], output: 'thinking', listPanes: () => 'output-only\t42\tsh' }),
      ['output-only'],
      1000,
    )).get('output-only');
    const noOutput = (await readDaemonSessionObservations(
      batchDeps({ names: ['no-output'], output: '', listPanes: () => 'no-output\t42\tcodex' }),
      ['no-output'],
      1000,
    )).get('no-output');
    expect(outputOnly?.status).toBe('unknown');
    expect(noOutput?.status).toBe('unknown');
  });

  it('returns error instead of reusing prior success when tmux observation fails', async () => {
    const deps = batchDeps({ names: ['gone'], listPanesFails: true });
    const result = (await readDaemonSessionObservations(deps, ['gone'], 1000)).get('gone');
    expect(result?.status).toBe('error');
    expect(result?.statusReason).toBe('observation-error');
  });

  it('stabilizes a changed process/output sample before publishing a new status', async () => {
    const history = new Map();
    let output = 'thinking';
    const deps = batchDeps({ names: ['replacement'], history, output: () => output });

    await readDaemonSessionObservations(deps, ['replacement'], 0);
    expect((await readDaemonSessionObservations(deps, ['replacement'], 4000)).get('replacement')?.status).toBe('running');
    output = 'ready';
    expect((await readDaemonSessionObservations(deps, ['replacement'], 4100)).get('replacement')?.status).toBe('unknown');
    expect((await readDaemonSessionObservations(deps, ['replacement'], 4200)).get('replacement')?.status).toBe('unknown');
    expect((await readDaemonSessionObservations(deps, ['replacement'], 4300)).get('replacement')?.status).toBe('unknown');
    expect((await readDaemonSessionObservations(deps, ['replacement'], 4400)).get('replacement')?.status).toBe('idle');
  });
});
