import type { TerminalSessionObservation } from '@zterm/shared/protocol';

export interface DaemonSessionObservationDeps {
  runTmux: (args: string[]) => { ok: true; stdout: string };
}

export function readDaemonSessionObservation(
  deps: DaemonSessionObservationDeps,
  sessionName: string,
  observedAt: number,
): TerminalSessionObservation {
  const pane = deps.runTmux([
    'list-panes', '-t', sessionName, '-F', '#{pane_pid}\t#{pane_current_command}',
  ]).stdout.trim().split('\t');
  const output = deps.runTmux(['capture-pane', '-p', '-e', '-t', sessionName, '-S', '-20']).stdout;
  const foregroundProcess = pane[1]?.trim() || undefined;
  return {
    observedAt,
    ...(foregroundProcess ? { foregroundProcess } : {}),
    processGroupAlive: Boolean(pane[0]?.trim()),
    recentOutput: output.trim().length > 0,
    oscTitleSeen: /\x1b\]0;|\x1b\]2;/u.test(output),
    oscProgressSeen: /\x1b\]9;|\x1b\]133;/u.test(output),
  };
}
