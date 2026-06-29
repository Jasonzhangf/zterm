import { describe, expect, it, vi } from 'vitest';
import {
  createWezTermBackendRuntime,
  type WezTermCommandRunner,
} from './wezterm-backend';

interface MockPane {
  paneId: number;
  workspace: string;
  size: string;
  title: string;
  cwd: string;
  text: string;
}

interface MockWezTermRunner extends WezTermCommandRunner {
  panes: MockPane[];
  run: (args: string[]) => string;
  runWithInput: (args: string[], input: Buffer | string) => void;
}

function createRunner(): MockWezTermRunner {
  const panes: MockPane[] = [
    {
      paneId: 7,
      workspace: 'zterm-existing',
      size: '80x24',
      title: 'cmd.exe',
      cwd: 'file:///C:/Users/huawei/',
      text: 'EXISTING_READY',
    },
  ];
  const runner: MockWezTermRunner = {
    panes,
    run: vi.fn((args: string[]): string => {
      const command = args.join(' ');
      if (command === 'cli --prefer-mux list') {
        return [
          'WINID TABID PANEID WORKSPACE SIZE TITLE CWD',
          ...runner.panes.map((pane) =>
            `1 1 ${pane.paneId} ${pane.workspace} ${pane.size} ${pane.title} ${pane.cwd}`),
        ].join('\n');
      }
      if (args[0] === 'cli' && args[2] === 'spawn') {
        const workspace = args[args.indexOf('--workspace') + 1]!;
        const nextPaneId = Math.max(...runner.panes.map((pane) => pane.paneId)) + 1;
        runner.panes.push({
          paneId: nextPaneId,
          workspace,
          size: '100x30',
          title: args[args.length - 1] || 'cmd.exe',
          cwd: 'file:///D:/work/',
          text: 'CREATED_READY',
        });
        return `Spawned pane ${nextPaneId}`;
      }
      if (args[0] === 'cli' && args[2] === 'get-text') {
        const paneId = Number(args[args.indexOf('--pane-id') + 1]);
        const pane = runner.panes.find((candidate) => candidate.paneId === paneId);
        if (!pane) {
          throw new Error(`pane not found: ${paneId}`);
        }
        return pane.text;
      }
      if (args[0] === 'cli' && args[2] === 'kill-pane') {
        const paneId = Number(args[args.indexOf('--pane-id') + 1]);
        runner.panes = runner.panes.filter((pane) => pane.paneId !== paneId);
        return '';
      }
      throw new Error(`unexpected command: ${command}`);
    }),
    runWithInput: vi.fn((args: string[], input: Buffer | string): void => {
      if (args[0] !== 'cli' || args[2] !== 'send-text' || !args.includes('--no-paste')) {
        throw new Error(`unexpected input command: ${args.join(' ')}`);
      }
      const paneId = Number(args[args.indexOf('--pane-id') + 1]);
      const pane = runner.panes.find((candidate) => candidate.paneId === paneId);
      if (!pane) {
        throw new Error(`pane not found: ${paneId}`);
      }
      pane.text = `${pane.text}\n${Buffer.isBuffer(input) ? input.toString('utf8') : input}`;
    }),
  };
  return runner;
}

describe('wezterm backend runtime', () => {
  it('lists wezterm panes as backend sessions without leaking raw pane table parsing to callers', () => {
    const runner = createRunner();
    const runtime = createWezTermBackendRuntime({ runner });

    expect(runtime.listSessions()).toEqual([
      {
        sessionName: 'existing',
        paneId: 7,
        workspace: 'zterm-existing',
        title: 'cmd.exe',
        cwd: 'file:///C:/Users/huawei/',
        cols: 80,
        rows: 24,
      },
    ]);
  });

  it('creates a pane, tracks it by session name, reads snapshots, writes stdin input, and closes it', async () => {
    const runner = createRunner();
    const runtime = createWezTermBackendRuntime({
      runner,
      defaultCommand: ['cmd.exe', '/k', 'echo READY'],
    });

    const session = runtime.createSession({ sessionName: 'demo shell' });
    expect(session).toMatchObject({
      sessionName: 'demo-shell',
      paneId: 8,
      workspace: 'zterm-demo-shell',
      cols: 100,
      rows: 30,
    });
    expect(runner.run).toHaveBeenCalledWith([
      'cli',
      '--prefer-mux',
      'spawn',
      '--new-window',
      '--workspace',
      'zterm-demo-shell',
      '--',
      'cmd.exe',
      '/k',
      'echo READY',
    ]);

    const first = await runtime.readSnapshot('demo-shell');
    expect(first.revision).toBe(1);
    expect(first.bufferLines.map((row) => row.map((cell) => String.fromCodePoint(cell.char)).join(''))).toContain('CREATED_READY');

    runtime.writeInput('demo-shell', Buffer.from('echo INPUT_OK\r', 'utf8'));
    expect(runner.runWithInput).toHaveBeenCalledWith(
      ['cli', '--prefer-mux', 'send-text', '--pane-id', '8', '--no-paste'],
      Buffer.from('echo INPUT_OK\r', 'utf8'),
    );

    const second = await runtime.readSnapshot('demo-shell');
    expect(second.revision).toBe(2);
    expect(second.bufferLines.map((row) => row.map((cell) => String.fromCodePoint(cell.char)).join(''))).toContain('echo INPUT_OK');

    runtime.closeSession('demo-shell');
    expect(runner.panes.some((pane) => pane.paneId === 8)).toBe(false);
    expect(() => runtime.readSnapshot('demo-shell')).rejects.toThrow('wezterm session not found: demo-shell');
  });

  it('passes cwd to wezterm spawn without putting terminal input in command arguments', () => {
    const runner = createRunner();
    const runtime = createWezTermBackendRuntime({ runner });

    runtime.createSession({ sessionName: 'cwd demo', cwd: 'D:/work/project' });
    runtime.writeInput('cwd-demo', 'echo STDIN_ONLY\r');

    expect(runner.run).toHaveBeenCalledWith([
      'cli',
      '--prefer-mux',
      'spawn',
      '--new-window',
      '--workspace',
      'zterm-cwd-demo',
      '--cwd',
      'D:/work/project',
      '--',
      'cmd.exe',
    ]);
    expect(runner.runWithInput).toHaveBeenCalledWith(
      ['cli', '--prefer-mux', 'send-text', '--pane-id', '8', '--no-paste'],
      'echo STDIN_ONLY\r',
    );
  });

  it('throws explicit errors for missing sessions instead of falling back to another pane', async () => {
    const runtime = createWezTermBackendRuntime({ runner: createRunner() });

    expect(() => runtime.writeInput('missing', 'x')).toThrow('wezterm session not found: missing');
    await expect(runtime.readSnapshot('missing')).rejects.toThrow('wezterm session not found: missing');
    expect(() => runtime.closeSession('missing')).toThrow('wezterm session not found: missing');
  });
});
