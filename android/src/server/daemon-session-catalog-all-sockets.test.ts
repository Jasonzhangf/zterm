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
});
