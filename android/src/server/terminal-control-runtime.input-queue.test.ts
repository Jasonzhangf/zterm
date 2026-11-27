import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalControlRuntime } from './terminal-control-runtime';
import {
  buildRexSessionStableId,
  type TerminalSourceAdapter,
} from './terminal-source-adapter';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

function createRuntime() {
  const runtime = createTerminalControlRuntime({
    tmuxBinary: 'tmux',
    defaultSessionName: 'demo',
    hiddenTmuxSessions: new Set(),
    sanitizeSessionName: (input) => input?.trim() || 'demo',
  });
  return { runtime };
}

function createWezTermRuntime() {
  const wezTermBackend: TerminalSourceAdapter = {
    listSessions: vi.fn(() => [{ sessionName: 'demo', paneId: 9, workspace: 'zterm-demo', title: 'cmd.exe', cwd: 'D:/work', cols: 100, rows: 30 }]),
    createSession: vi.fn(({ sessionName, cwd } = {}) => ({
      sessionName: sessionName || 'demo',
      paneId: 10,
      workspace: `zterm-${sessionName || 'demo'}`,
      title: 'cmd.exe',
      cwd: cwd || 'D:/work',
      cols: 100,
      rows: 30,
    })),
    readSnapshot: vi.fn(),
    writeInput: vi.fn(),
    closeSession: vi.fn(),
    readCurrentPath: vi.fn(() => 'D:/work'),
  };
  const runtime = createTerminalControlRuntime({
    tmuxBinary: 'tmux',
    defaultSessionName: 'demo',
    hiddenTmuxSessions: new Set(),
    sanitizeSessionName: (input) => input?.trim() || 'demo',
    wezTermBackend,
    defaultBackend: 'wezterm',
  });
  return { runtime, wezTermBackend };
}

function createHerdrOnlyRuntime() {
  const herdrBackend: TerminalSourceAdapter = {
    listSessions: vi.fn(() => [{ sessionName: 'herdr-demo', paneId: 1, workspace: 'herdr-single-session', title: 'herdr', cwd: '/tmp', cols: 80, rows: 24 }]),
    createSession: vi.fn(({ sessionName } = {}) => ({
      sessionName: sessionName || 'herdr-demo',
      paneId: 2,
      workspace: 'herdr-single-session',
      title: 'herdr',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    })),
    readSnapshot: vi.fn(),
    writeInput: vi.fn(),
    closeSession: vi.fn(),
    readCurrentPath: vi.fn(() => '/tmp'),
  };
  const runtime = createTerminalControlRuntime({
    tmuxBinary: 'tmux',
    defaultSessionName: 'demo',
    defaultBackend: 'herdr',
    hiddenTmuxSessions: new Set(),
    sanitizeSessionName: (input) => input?.trim() || 'demo',
    backendRuntimes: { herdr: herdrBackend },
  });
  return { runtime, herdrBackend };
}

function createRexCombinedRuntime() {
  const stableId = buildRexSessionStableId({
    instanceId: 'rex-instance',
    sessionId: 'session:rex',
    blockId: 'block:rex',
  });
  const rexBackend: TerminalSourceAdapter = {
    listSessions: vi.fn(() => [
      {
        sessionName: 'rex-demo',
        paneId: 'block:rex',
        stableId,
        workspace: 'zterm-rex',
        title: 'shell',
        cwd: '/tmp/rex',
        cols: 80,
        rows: 24,
      },
    ]),
    createSession: vi.fn(),
    readSnapshot: vi.fn(),
    writeInput: vi.fn(),
    closeSession: vi.fn(),
    readCurrentPath: vi.fn(() => '/tmp/rex'),
  };
  const runtime = createTerminalControlRuntime({
    tmuxBinary: 'tmux',
    defaultSessionName: 'demo',
    defaultBackend: 'rex',
    hiddenTmuxSessions: new Set(),
    sanitizeSessionName: (input) => input?.trim() || 'demo',
    backendRuntimes: { rex: rexBackend },
    tmuxSocketPaths: () => ['/socket-test'],
  });
  return { runtime, rexBackend, stableId };
}

describe('terminal control runtime input queue', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });

  it('surfaces a missing tmux socket instead of fabricating an empty session list', () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'error connecting to /private/tmp/tmux-501/default (No such file or directory)',
    });
    const { runtime } = createRuntime();

    expect(() => runtime.listTmuxSessions()).toThrow(/error connecting to/);
    expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual(['list-sessions', '-F', '#S']);
  });

  it('enumerates every live tmux socket and records the owning socket for controls', async () => {
    spawnSyncMock.mockImplementation((_binary: string, args: string[]) => {
      const socketPath = args[0] === '-S' ? args[1] : 'default';
      const stdout = socketPath === '/socket-old' ? 'legacy-a\nlegacy-b\n' : 'current\n';
      return { status: 0, stdout, stderr: '' };
    });
    spawnMock.mockImplementation((_binary: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
        stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
      };
      child.stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
      child.stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
      child.stdout.setEncoding = vi.fn();
      child.stderr.setEncoding = vi.fn();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    const runtime = createTerminalControlRuntime({
      tmuxBinary: 'tmux',
      defaultSessionName: 'demo',
      hiddenTmuxSessions: new Set(),
      sanitizeSessionName: (input) => input?.trim() || 'demo',
      tmuxSocketPaths: () => ['/socket-current', '/socket-old'],
    });

    expect(runtime.listTmuxSessions()).toEqual(['current', 'legacy-a', 'legacy-b']);
    await runtime.writeBackendInputGroup('legacy-a', 'echo old', false);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      '-S', '/socket-old', 'send-keys', '-t', '=legacy-a:.{top-left}', '-l', '--', 'echo old',
    ]);
  });

  it('selects the stable daemon socket when the default socket has no server', () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'no server running on /private/tmp/tmux-501/default',
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'no server running on /Users/test/.zterm/tmux/tmux-501/default',
      })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: 'demo\n', stderr: '' });
    const runtime = createTerminalControlRuntime({
      tmuxBinary: 'tmux',
      defaultSessionName: 'demo',
      hiddenTmuxSessions: new Set(),
      tmuxSocketDir: '/tmp/zterm-stable-tmux-test',
      sanitizeSessionName: (input) => input?.trim() || 'demo',
    });

    runtime.ensureTmuxServerRunning();
    expect(runtime.listTmuxSessions()).toEqual(['demo']);
    expect(spawnSyncMock.mock.calls[2]?.[2]?.env?.TMUX_TMPDIR).toBe('/tmp/zterm-stable-tmux-test');
    expect(spawnSyncMock.mock.calls[3]?.[2]?.env?.TMUX_TMPDIR).toBe('/tmp/zterm-stable-tmux-test');
  });

  it('does not hide non-list tmux socket errors as empty sessions', () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'error connecting to /private/tmp/tmux-501/default (No such file or directory)',
    });
    const { runtime } = createRuntime();

    expect(() => runtime.runTmux(['send-keys', '-t', '=demo:.{top-left}', '-l', '--', 'x']))
      .toThrow(/error connecting to/);
  });

  it('writes one backend input group with an explicit Enter boundary', async () => {
    const { runtime } = createRuntime();
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
        stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
      };
      child.stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
      child.stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
      child.stdout.setEncoding = vi.fn();
      child.stderr.setEncoding = vi.fn();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });

    await runtime.writeBackendInputGroup('demo', 'echo OK', true);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'send-keys', '-t', '=demo:.{top-left}', '-l', '--', 'echo OK',
    ]);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      'send-keys', '-t', '=demo:.{top-left}', 'Enter',
    ]);
  });

  it('routes list/create/write/close through wezterm backend without invoking tmux', async () => {
    const { runtime, wezTermBackend } = createWezTermRuntime();

    expect(runtime.listTmuxSessions()).toEqual(['demo']);
    expect(runtime.listTerminalSessions()).toEqual(['demo']);
    expect(runtime.createDetachedTmuxSession('new-demo', 'D:/src')).toBe('new-demo');
    await runtime.writeBackendInputGroup('demo', 'echo OK', true);
    runtime.closeDetachedTerminalSession('demo');

    expect(wezTermBackend.listSessions).toHaveBeenCalled();
    expect(wezTermBackend.createSession).toHaveBeenCalledWith({ sessionName: 'new-demo', cwd: 'D:/src' });
    expect(wezTermBackend.writeInput).toHaveBeenNthCalledWith(1, 'demo', 'echo OK');
    expect(wezTermBackend.writeInput).toHaveBeenNthCalledWith(2, 'demo', '\r');
    expect(wezTermBackend.closeSession).toHaveBeenCalledWith('demo');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('creates detached tmux sessions with the 80x80 manual initialization geometry', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const { runtime } = createRuntime();

    expect(runtime.createDetachedTmuxSession('new-demo', '/tmp')).toBe('new-demo');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'tmux',
      ['new-session', '-d', '-s', 'new-demo', '-x', '80', '-y', '80', '-c', '/tmp'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('returns a unified catalog while keeping backend-specific calls available', () => {
    const { runtime } = createHerdrOnlyRuntime();

    expect(runtime.listTerminalSessions()).toEqual(['herdr-demo']);
    expect(runtime.listTmuxSessions('herdr')).toEqual(['herdr-demo']);
    expect(runtime.listTerminalSessionCatalog()).toEqual([
      { name: 'herdr-demo', backend: 'herdr', cwd: '/tmp' },
    ]);
  });

  it('publishes tmux pane cwd in the daemon-owned session catalog', () => {
    spawnSyncMock.mockImplementation((_binary: string, args: string[]) => ({
      status: 0,
      stdout: args[0] === 'list-panes'
        ? 'demo\t/Users/jason/project\nother\t/Users/jason/project'
        : 'demo\nother\n',
      stderr: '',
    }));
    const { runtime } = createRuntime();

    expect(runtime.listTerminalSessionCatalog()).toEqual([
      { name: 'demo', backend: 'tmux', cwd: '/Users/jason/project' },
      { name: 'other', backend: 'tmux', cwd: '/Users/jason/project' },
    ]);
  });

  it('keeps the live tmux catalog alongside a Rex-default backend', () => {
    spawnSyncMock.mockImplementation((_binary: string, args: string[]) => {
      if (args.includes('list-panes')) {
        return { status: 0, stdout: 'tmux-demo\t/tmp/tmux\n', stderr: '' };
      }
      if (args.includes('-F') && args.includes('#{session_name}\t#{session_id}\t#{session_created}\t#{pid}')) {
        return { status: 0, stdout: 'tmux-demo\t$1\t1790000000\t4242\n', stderr: '' };
      }
      if (args.includes('-F') && args.includes('#S')) {
        return { status: 0, stdout: 'tmux-demo\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const { runtime, stableId } = createRexCombinedRuntime();

    const catalog = runtime.listTerminalSessionCatalog();

    expect(catalog).toEqual([
      {
        name: 'rex-demo',
        backend: 'rex',
        stableId,
        cwd: '/tmp/rex',
      },
      {
        name: 'tmux-demo',
        backend: 'tmux',
        stableId: expect.stringMatching(/^tmux:v1:/u),
        cwd: '/tmp/tmux',
      },
    ]);
    expect(runtime.resolveTerminalSessionBackend('tmux-demo')).toBe('tmux');
  });

  it('publishes a recreated Rex identity from current discovery despite a stale binding', () => {
    spawnSyncMock.mockImplementation((_binary: string, args: string[]) => ({
      status: 0,
      stdout: args.includes('list-panes') ? 'tmux-demo\t/tmp/tmux\n' : 'tmux-demo\n',
      stderr: '',
    }));
    const { runtime, rexBackend } = createRexCombinedRuntime();
    const recreatedStableId = buildRexSessionStableId({
      instanceId: 'rex-instance',
      sessionId: 'session:rex-recreated',
      blockId: 'block:recreated',
    });
    rexBackend.listSessions = vi.fn(() => [
      {
        sessionName: 'rex-demo',
        paneId: 'block:recreated',
        stableId: recreatedStableId,
        workspace: 'zterm-rex',
        title: 'shell',
        cwd: '/tmp/rex',
        cols: 80,
        rows: 24,
      },
    ]);
    rexBackend.readSessionIdentity = vi.fn(() => {
      throw new Error('Rex block identity is no longer present: rex-demo');
    });

    expect(runtime.listTerminalSessionCatalog()).toContainEqual({
      name: 'rex-demo',
      backend: 'rex',
      stableId: recreatedStableId,
      cwd: '/tmp/rex',
    });
    expect(rexBackend.readSessionIdentity).not.toHaveBeenCalled();
  });

  it.each(['Rex server unavailable', 'Rex backend supports API revision 24, received 23'])(
    'preserves healthy tmux and Herdr catalogs when optional Rex fails: %s',
    (message) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        spawnSyncMock.mockImplementation((_binary: string, args: string[]) => ({
          status: 0,
          stdout: args.includes('list-panes') ? 'tmux-demo\t/tmp/tmux\n' : 'tmux-demo\n',
          stderr: '',
        }));
        const { rexBackend } = createRexCombinedRuntime();
        const { herdrBackend } = createHerdrOnlyRuntime();
        rexBackend.listSessions = vi.fn(() => { throw new Error(message); });
        const runtime = createTerminalControlRuntime({
          tmuxBinary: 'tmux', defaultSessionName: 'demo', defaultBackend: 'tmux',
          hiddenTmuxSessions: new Set(), sanitizeSessionName: (input) => input || 'demo',
          backendRuntimes: { rex: rexBackend, herdr: herdrBackend },
          tmuxSocketPaths: () => ['/socket-test'],
        });
        expect(runtime.listTerminalSessionCatalog().map((entry) => entry.name)).toEqual(['herdr-demo', 'tmux-demo']);
        expect(errorLog).toHaveBeenCalledWith('[terminal-control-runtime] rex catalog discovery failed', expect.objectContaining({ error: message }));
        expect(() => runtime.listTmuxSessions('rex')).toThrow(message);
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it('enumerates each Rex session once so catalog identity cannot drop between discovery reads', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const { runtime, rexBackend, stableId } = createRexCombinedRuntime();
    const listSessions = vi.fn()
      .mockReturnValueOnce([{
        sessionName: 'rex-demo',
        paneId: 'block:rex',
        stableId,
        workspace: 'zterm-rex',
        title: 'shell',
        cwd: '/tmp/rex',
        cols: 80,
        rows: 24,
      }])
      .mockReturnValue([]);
    rexBackend.listSessions = listSessions;

    expect(runtime.listTerminalSessionCatalog()).toContainEqual({
      name: 'rex-demo',
      backend: 'rex',
      stableId,
      cwd: '/tmp/rex',
    });
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it('rejects a Rex catalog row without an exact rex:v1 identity', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const { runtime, rexBackend } = createRexCombinedRuntime();
    rexBackend.listSessions = vi.fn(() => [{
      sessionName: 'rex-demo',
      paneId: 'block:rex',
      workspace: 'zterm-rex',
      title: 'shell',
      cwd: '/tmp/rex',
      cols: 80,
      rows: 24,
    }]);

    expect(() => runtime.listTerminalSessionCatalog()).toThrow(
      'rex session rex-demo is missing an exact rex:v1 identity',
    );
  });

  it('lists and resolves Herdr sessions without probing tmux on a Herdr-only daemon', () => {
    const { runtime, herdrBackend } = createHerdrOnlyRuntime();

    expect(runtime.listTerminalSessions()).toEqual(['herdr-demo']);
    expect(runtime.resolveTerminalSessionBackend('herdr-demo')).toBe('herdr');
    expect(herdrBackend.listSessions).toHaveBeenCalledTimes(2);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('keeps a Herdr-only catalog isolated from tmux even when a tmux probe would have returned names', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'tmux-demo\nshared\n', stderr: '' });
    const { runtime, herdrBackend } = createHerdrOnlyRuntime();
    herdrBackend.listSessions = vi.fn(() => [
      { sessionName: 'herdr-demo', paneId: 1, workspace: 'herdr-single-session', title: 'herdr', cwd: '/tmp', cols: 80, rows: 24 },
      { sessionName: 'shared', paneId: 2, workspace: 'herdr-single-session', title: 'herdr', cwd: '/tmp', cols: 80, rows: 24 },
    ]);
    expect(runtime.listTmuxSessions('herdr')).toContain('herdr-demo');
    expect(runtime.listTerminalSessions()).toEqual(['herdr-demo', 'shared']);
    expect(runtime.listTerminalSessionCatalog()).toEqual([
      { name: 'herdr-demo', backend: 'herdr', cwd: '/tmp' },
      { name: 'shared', backend: 'herdr', cwd: '/tmp' },
    ]);
    expect(runtime.resolveTerminalSessionBackend('shared')).toBe('herdr');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('routes close through tmux only when tmux is the selected backend', () => {
    const { runtime } = createRuntime();

    runtime.closeDetachedTerminalSession('demo');

    expect(spawnSyncMock.mock.calls[0]?.slice(0, 2)).toEqual([
      'tmux',
      ['kill-session', '-t', '=demo'],
    ]);
  });

  it('keeps tmux control available while explicit external backend operations stay typed', async () => {
    const { runtime } = createWezTermRuntime();

    expect(() => runtime.runTmux(['list-sessions'])).not.toThrow();
    expect(() => runtime.renameTmuxSession('a', 'b', 'wezterm')).toThrow('wezterm backend does not support session rename');
  });
});
