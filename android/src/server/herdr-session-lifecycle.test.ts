import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHerdrBackendRuntime, HerdrSessionLifecycleError } from './herdr-backend-runtime';
const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('node:child_process', () => childProcessMocks);
interface MockProcess {
  unref: () => void;
  killed: boolean;
  exitCode: number | null;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  stdout: { setEncoding: string; on: ReturnType<typeof vi.fn> };
  stderr: { setEncoding: string; on: ReturnType<typeof vi.fn> };
  stdin: { writable: boolean; write: ReturnType<typeof vi.fn> };
}
function createMockProcess(): MockProcess {
  return {
    unref: vi.fn(),
    killed: false,
    exitCode: null,
    pid: 4242,
    kill: vi.fn(),
    stdout: { setEncoding: 'utf8', on: vi.fn() },
    stderr: { setEncoding: 'utf8', on: vi.fn() },
    stdin: { writable: true, write: vi.fn() },
  };
}
function buildCreateFlowHandlers(options: {
  workspaceCreate?: () => unknown;
  snapshotPaneId: string;
  geometry: { cols: number; rows: number };
  registeredSessions?: Set<string>;
  serverPid?: number;
}): { registeredSessions: Set<string>; spawnProcess: MockProcess } {
  const registeredSessions = options.registeredSessions ?? new Set<string>();
  const spawnProcess = createMockProcess();
  spawnProcess.pid = options.serverPid ?? 4242;
  childProcessMocks.spawn.mockImplementation(() => spawnProcess);
  childProcessMocks.execFileSync.mockImplementation((_executable: string, args: string[]) => {
    const joined = args.join(' ');
    if (joined === 'session list --json') {
      return JSON.stringify({
        sessions: Array.from(registeredSessions).map((name) => ({ name, running: true })),
      });
    }
    if (joined.endsWith('pane list')) {
      return JSON.stringify({ result: { panes: [{ terminal_id: 'term-disc', pane_id: options.snapshotPaneId }] } });
    }
    if (joined.endsWith('api snapshot')) {
      return JSON.stringify({
        result: {
          snapshot: {
            layouts: [{
              panes: [{ pane_id: options.snapshotPaneId, rect: { x: 0, y: 0, width: options.geometry.cols, height: options.geometry.rows } }],
            }],
          },
        },
      });
    }
    if (joined.includes('workspace create')) {
      const payload = options.workspaceCreate?.() ?? {
        result: {
          root_pane: {
            terminal_id: 'term-' + options.snapshotPaneId,
            pane_id: options.snapshotPaneId,
            cwd: '/tmp',
          },
        },
      };
      return JSON.stringify(payload);
    }
    if (joined.includes('server stop')) {
      registeredSessions.delete(args[1]?.replace('--session', '')?.trim() ?? '');
      return '';
    }
  throw new Error('unexpected Herdr command: ' + joined);
});
return { registeredSessions, spawnProcess };
}
describe('Herdr backend session lifecycle (create/close parity)', () => {
  beforeEach(() => {
    childProcessMocks.execFileSync.mockReset();
    childProcessMocks.spawn.mockReset();
  });

  it('creates a session, lists it with exact identity, then closes and removes the tracked entry', () => {
    const sessionName = 'zterm-herdr-lifecycle-create-close';
    const { registeredSessions } = buildCreateFlowHandlers({
      snapshotPaneId: 'pane-create-close',
      geometry: { cols: 80, rows: 24 },
    });

    const runtime = createHerdrBackendRuntime({ executable: 'herdr' });
    const created = runtime.createSession({ sessionName, cwd: '/tmp' });
    expect(created).toMatchObject({ sessionName, cwd: '/tmp', cols: 80, rows: 24 });

    registeredSessions.add(sessionName);
    expect(runtime.listSessions().map((entry) => entry.sessionName)).toEqual([sessionName]);

    runtime.closeSession(sessionName);
    registeredSessions.delete(sessionName);
    expect(runtime.listSessions()).toEqual([]);
    const stopCalls = childProcessMocks.execFileSync.mock.calls
      .map((call) => call[1]?.join(' '))
      .filter((joined) => typeof joined === 'string' && joined.includes('server stop'));
    expect(stopCalls.length).toBeGreaterThan(0);
  });

  it('rejects a second create with the exact identity already tracked', () => {
    const sessionName = 'zterm-herdr-lifecycle-dup';
    buildCreateFlowHandlers({
      snapshotPaneId: 'pane-dup',
      geometry: { cols: 80, rows: 24 },
    });

    const runtime = createHerdrBackendRuntime({ executable: 'herdr' });
    runtime.createSession({ sessionName, cwd: '/tmp' });
    expect(() => runtime.createSession({ sessionName, cwd: '/tmp' })).toThrowError(HerdrSessionLifecycleError);
  });

  it('rejects double close with a typed lifecycle error and no orphan process tracking', () => {
    const sessionName = 'zterm-herdr-lifecycle-double-close';
    const { spawnProcess } = buildCreateFlowHandlers({
      snapshotPaneId: 'pane-double-close',
      geometry: { cols: 80, rows: 24 },
    });

    const runtime = createHerdrBackendRuntime({ executable: 'herdr' });
    runtime.createSession({ sessionName, cwd: '/tmp' });
    runtime.closeSession(sessionName);
    const killCallsBefore = spawnProcess.kill.mock.calls.length;
    expect(() => runtime.closeSession(sessionName)).toThrowError(HerdrSessionLifecycleError);
    expect(spawnProcess.kill.mock.calls.length).toBe(killCallsBefore);
  });

  it('releases the server process and removes the session when workspace create fails', () => {
    const sessionName = 'zterm-herdr-lifecycle-create-fail';
    buildCreateFlowHandlers({
      workspaceCreate: () => ({ result: {} }),
      snapshotPaneId: 'pane-create-fail',
      geometry: { cols: 80, rows: 24 },
    });

    const runtime = createHerdrBackendRuntime({ executable: 'herdr' });
    expect(() => runtime.createSession({ sessionName, cwd: '/tmp' })).toThrowError(HerdrSessionLifecycleError);
    expect(() => runtime.closeSession(sessionName)).toThrowError(HerdrSessionLifecycleError);
  });

  it('re-creates a closed session using the exact same identity after close', () => {
    const sessionName = 'zterm-herdr-lifecycle-recreate';
    buildCreateFlowHandlers({
      snapshotPaneId: 'pane-recreate',
      geometry: { cols: 80, rows: 24 },
    });

    const runtime = createHerdrBackendRuntime({ executable: 'herdr' });
    runtime.createSession({ sessionName, cwd: '/tmp' });
    runtime.closeSession(sessionName);
    const recreated = runtime.createSession({ sessionName, cwd: '/tmp' });
    expect(recreated.sessionName).toBe(sessionName);
  });
});
