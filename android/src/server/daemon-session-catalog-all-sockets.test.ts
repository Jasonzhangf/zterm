import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createTerminalControlRuntime } from './terminal-control-runtime';

const spawnSyncMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const DEFAULT_SOCKET = '/private/tmp/tmux-501/default';
const EXTRA_SOCKET = '/private/tmp/tmux-501/zterm-extra';

function listSessionsFor(args: string[]): { stdout: string } | null {
  const socketIndex = args.indexOf('-S');
  const socketPath = socketIndex >= 0 ? args[socketIndex + 1] : DEFAULT_SOCKET;
  if (args.includes('list-sessions')) {
    if (socketPath === DEFAULT_SOCKET) {
      return { stdout: 'appsdk-1\n' };
    }
    if (socketPath === EXTRA_SOCKET) {
      return { stdout: 'extra-1\n' };
    }
    return null;
  }
  return { stdout: '' };
}

describe('daemon session catalog across tmux sockets', () => {
  it('wires daemon tmux socket discovery into the terminal control runtime owner', () => {
    const serverSource = readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');

    expect(serverSource).toContain("from './terminal-control-runtime'");
    expect(serverSource).toContain('discoverTmuxSocketPaths');
    expect(serverSource).toContain('terminalControlRuntime = createTerminalControlRuntime({');
    expect(serverSource).toContain("tmuxSocketDir: join(WTERM_HOME_DIR, 'tmux'),");
    expect(serverSource).toMatch(
      /tmuxSocketPaths:\s*\(\)\s*=>\s*discoverTmuxSocketPaths\(\{\s*stableSocketDir:\s*join\(WTERM_HOME_DIR,\s*'tmux'\),?\s*\}\)/s,
    );
  });

  it('enumerates sessions from every discovered tmux socket, not only the default socket', () => {
    spawnSyncMock.mockImplementation((_binary: string, args: string[]) => {
      const result = listSessionsFor(args);
      if (!result) {
        return { status: 1, stdout: '', stderr: 'no server running' };
      }
      return { status: 0, stdout: result.stdout, stderr: '' };
    });
    const runtime = createTerminalControlRuntime({
      tmuxBinary: 'tmux',
      defaultSessionName: 'demo',
      hiddenTmuxSessions: new Set(),
      sanitizeSessionName: (input) => input?.trim() || 'demo',
      tmuxSocketDir: '/tmp/stable-tmux',
      tmuxSocketPaths: () => [DEFAULT_SOCKET, EXTRA_SOCKET],
    });

    expect(runtime.listTerminalSessionCatalog().map((entry) => entry.name)).toEqual([
      'appsdk-1',
      'extra-1',
    ]);
  });

  it('resolves a session-targeted tmux command through the cached socket even when the daemon latched the stable socket', () => {
    // Reproduces the production latch: the daemon starts before
    // /private/tmp/tmux-501/default exists, so ensureTmuxServerRunning()
    // falls through to the stable daemon-owned socket and latches it. The
    // real session lives on the default socket, which appears later and is
    // only reachable through the per-session socket cache populated by
    // listTmuxSessions.
    let defaultSocketLive = false;
    const sessionTargetedCalls: Array<{ args: string[]; socketPath?: string }> = [];
    spawnSyncMock.mockImplementation((_binary: string, args: string[]) => {
      const socketIndex = args.indexOf('-S');
      const socketPath = socketIndex >= 0 ? args[socketIndex + 1] : undefined;
      if (args.includes('list-sessions')) {
        if (socketPath === DEFAULT_SOCKET) {
          return defaultSocketLive
            ? { status: 0, stdout: 'real-session\n', stderr: '' }
            : { status: 1, stdout: '', stderr: `error connecting to ${DEFAULT_SOCKET} (No such file or directory)` };
        }
        // Latched stable socket: only the daemon keepalive exists.
        return { status: 0, stdout: 'zterm-daemon-keepalive\n', stderr: '' };
      }
      if (args.includes('display-message')) {
        sessionTargetedCalls.push({ args, socketPath });
        if (socketPath === DEFAULT_SOCKET) {
          return { status: 0, stdout: '%7\t0\t24\t95\t0\t0\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'no server running on stable socket' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const runtime = createTerminalControlRuntime({
      tmuxBinary: 'tmux',
      defaultSessionName: 'demo',
      hiddenTmuxSessions: new Set(),
      sanitizeSessionName: (input) => input?.trim() || 'demo',
      tmuxSocketDir: '/tmp/stable-tmux',
      tmuxSocketPaths: () => [DEFAULT_SOCKET],
    });

    // Default socket is absent -> the daemon latches the stable socket.
    runtime.ensureTmuxServerRunning();
    // The real session's socket appears after the daemon started.
    defaultSocketLive = true;
    expect(runtime.listTmuxSessions()).toContain('real-session');

    const metrics = runtime.runTmuxForSession(
      ['display-message', '-p', '-t', '=real-session:0.0', '#{pane_width}'],
      'real-session',
    );

    expect(metrics.stdout).toBe('%7\t0\t24\t95\t0\t0\n');
    expect(sessionTargetedCalls).toHaveLength(1);
    expect(sessionTargetedCalls[0]?.socketPath).toBe(DEFAULT_SOCKET);
  });
});
