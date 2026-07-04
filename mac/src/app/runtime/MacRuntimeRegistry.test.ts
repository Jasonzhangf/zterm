import { describe, expect, it, vi } from 'vitest';
import { createMacRuntimeRegistry, type MacRuntimeEnsureTarget } from './MacRuntimeRegistry';
import type { TerminalRuntimeController, TerminalRuntimeState } from '../../lib/terminal-runtime';

type RuntimeStub = TerminalRuntimeController & {
  emit: () => void;
  id: string;
};

function makeRuntimeState(status = 'idle'): TerminalRuntimeState {
  return {
    connection: {
      status,
      error: '',
      connectedSessionId: '',
      title: '',
      activeTarget: null,
    } as any,
    buffer: { canonicalBuffer: {} as any, renderBuffer: { lines: [], cols: 80, rows: 24 } as any } as any,
    render: { lines: [], cols: 80, rows: 24 } as any,
    schedule: { jobs: [], loading: false } as any,
    head: null,
  };
}

function createRuntimeFactory() {
  const runtimes: RuntimeStub[] = [];
  const factory = vi.fn(() => {
    const listeners = new Set<() => void>();
    const runtime: RuntimeStub = {
      id: `runtime-${runtimes.length + 1}`,
      getState: vi.fn(() => makeRuntimeState('connected')),
      subscribe: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      emit: () => listeners.forEach((listener) => listener()),
      connectRemote: vi.fn(),
      connectLocalTmux: vi.fn(),
      disconnect: vi.fn(),
      setActivityMode: vi.fn(),
      updateViewport: vi.fn(),
      requestScheduleList: vi.fn(),
      upsertScheduleJob: vi.fn(),
      deleteScheduleJob: vi.fn(),
      toggleScheduleJob: vi.fn(),
      runScheduleJobNow: vi.fn(),
      sendInput: vi.fn(),
      pasteImage: vi.fn(() => true),
      resizeTerminal: vi.fn(),
      requestRemoteScreenshot: vi.fn(() => true),
      sendRawJson: vi.fn(() => true),
      onFileTransferMessage: vi.fn(() => () => {}),
      dispose: vi.fn(),
    };
    runtimes.push(runtime);
    return runtime;
  });
  return { factory, runtimes };
}

function remoteTarget(runtimeKey = 'remote:server-a:main'): MacRuntimeEnsureTarget {
  return {
    kind: 'remote',
    runtimeKey: runtimeKey as any,
    target: {
      name: 'server-a',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      sessionName: 'main',
      authType: 'password',
      authToken: 'token',
      tags: [],
      pinned: false,
    } as any,
  };
}

function localTarget(sessionName = 'zterm_mac_goal_a'): MacRuntimeEnsureTarget {
  return {
    kind: 'local-tmux',
    runtimeKey: `local-tmux:${sessionName}` as any,
    sessionName,
    title: sessionName,
  };
}

describe('MacRuntimeRegistry', () => {
  it('creates distinct controllers for distinct runtime keys', () => {
    const { factory, runtimes } = createRuntimeFactory();
    const registry = createMacRuntimeRegistry(factory);

    const first = registry.ensureRuntime(remoteTarget('remote:server-a:main'));
    const second = registry.ensureRuntime(remoteTarget('remote:server-b:main'));

    expect(first).not.toBe(second);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(runtimes).toHaveLength(2);
  });

  it('reuses the same controller for the same runtime key', () => {
    const { factory } = createRuntimeFactory();
    const registry = createMacRuntimeRegistry(factory);

    const first = registry.ensureRuntime(remoteTarget());
    const second = registry.ensureRuntime(remoteTarget());

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('connects a remote runtime once for the same key and target signature', () => {
    const { runtimes, factory } = createRuntimeFactory();
    const registry = createMacRuntimeRegistry(factory);

    registry.ensureRuntime(remoteTarget());
    registry.ensureRuntime(remoteTarget());

    expect(runtimes[0].connectRemote).toHaveBeenCalledTimes(1);
    expect(runtimes[0].connectLocalTmux).not.toHaveBeenCalled();
  });

  it('connects a local tmux runtime once for the same key and session signature', () => {
    const { runtimes, factory } = createRuntimeFactory();
    const registry = createMacRuntimeRegistry(factory);

    registry.ensureRuntime(localTarget('zterm_mac_goal_a'));
    registry.ensureRuntime(localTarget('zterm_mac_goal_a'));

    expect(runtimes[0].connectLocalTmux).toHaveBeenCalledTimes(1);
    expect(runtimes[0].connectLocalTmux).toHaveBeenCalledWith({
      sessionName: 'zterm_mac_goal_a',
      title: 'zterm_mac_goal_a',
    });
    expect(runtimes[0].connectRemote).not.toHaveBeenCalled();
  });

  it('marks the previous active runtime idle and the next runtime active', () => {
    const { runtimes, factory } = createRuntimeFactory();
    const registry = createMacRuntimeRegistry(factory);

    registry.ensureRuntime(localTarget('zterm_mac_goal_a'));
    registry.ensureRuntime(localTarget('zterm_mac_goal_b'));
    registry.setActiveRuntimeKey('local-tmux:zterm_mac_goal_a');
    registry.setActiveRuntimeKey('local-tmux:zterm_mac_goal_b');

    expect(runtimes[0].setActivityMode).toHaveBeenCalledWith('idle');
    expect(runtimes[1].setActivityMode).toHaveBeenCalledWith('active');
    expect(registry.getActiveRuntimeKey()).toBe('local-tmux:zterm_mac_goal_b');
  });

  it('does not reconnect when the same tab becomes active again', () => {
    const { runtimes, factory } = createRuntimeFactory();
    const registry = createMacRuntimeRegistry(factory);

    registry.ensureRuntime(localTarget('zterm_mac_goal_a'));
    registry.setActiveRuntimeKey('local-tmux:zterm_mac_goal_a');
    registry.setActiveRuntimeKey('local-tmux:zterm_mac_goal_a');
    registry.ensureRuntime(localTarget('zterm_mac_goal_a'));

    expect(runtimes[0].connectLocalTmux).toHaveBeenCalledTimes(1);
    expect(runtimes[0].setActivityMode).toHaveBeenCalledWith('active');
  });

  it('does not dispose hidden runtimes when active runtime changes', () => {
    const { runtimes, factory } = createRuntimeFactory();
    const registry = createMacRuntimeRegistry(factory);

    registry.ensureRuntime(localTarget('zterm_mac_goal_a'));
    registry.ensureRuntime(localTarget('zterm_mac_goal_b'));
    registry.setActiveRuntimeKey('local-tmux:zterm_mac_goal_a');
    registry.setActiveRuntimeKey('local-tmux:zterm_mac_goal_b');

    expect(runtimes[0].dispose).not.toHaveBeenCalled();
    expect(runtimes[1].dispose).not.toHaveBeenCalled();
  });

  it('releases only the requested runtime', () => {
    const { runtimes, factory } = createRuntimeFactory();
    const registry = createMacRuntimeRegistry(factory);

    registry.ensureRuntime(localTarget('zterm_mac_goal_a'));
    registry.ensureRuntime(localTarget('zterm_mac_goal_b'));
    registry.releaseRuntime('local-tmux:zterm_mac_goal_a');

    expect(runtimes[0].dispose).toHaveBeenCalledTimes(1);
    expect(runtimes[1].dispose).not.toHaveBeenCalled();
    expect(registry.getRuntime('local-tmux:zterm_mac_goal_a')).toBeNull();
    expect(registry.getRuntime('local-tmux:zterm_mac_goal_b')).toBe(runtimes[1]);
  });

  it('does not notify another runtime projection when a stale runtime emits', () => {
    const { runtimes, factory } = createRuntimeFactory();
    const registry = createMacRuntimeRegistry(factory);
    const runtimeAListener = vi.fn();
    const runtimeBListener = vi.fn();

    registry.ensureRuntime(localTarget('zterm_mac_goal_a'));
    registry.ensureRuntime(localTarget('zterm_mac_goal_b'));
    registry.subscribeRuntime('local-tmux:zterm_mac_goal_a', runtimeAListener);
    registry.subscribeRuntime('local-tmux:zterm_mac_goal_b', runtimeBListener);

    runtimes[0].emit();

    expect(runtimeAListener).toHaveBeenCalledTimes(1);
    expect(runtimeBListener).not.toHaveBeenCalled();
  });

  it('routes input, viewport, and resize only to the assigned runtime key', () => {
    const { runtimes, factory } = createRuntimeFactory();
    const registry = createMacRuntimeRegistry(factory);

    registry.ensureRuntime(localTarget('zterm_mac_goal_a'));
    registry.ensureRuntime(localTarget('zterm_mac_goal_b'));
    registry.sendInput('local-tmux:zterm_mac_goal_b', 'x');
    registry.updateViewport('local-tmux:zterm_mac_goal_b', { mode: 'follow', viewportEndIndex: 10, viewportRows: 24 });
    registry.resizeTerminal('local-tmux:zterm_mac_goal_b', 120, 40);

    expect(runtimes[0].sendInput).not.toHaveBeenCalled();
    expect(runtimes[1].sendInput).toHaveBeenCalledWith('x');
    expect(runtimes[1].updateViewport).toHaveBeenCalledWith({ mode: 'follow', viewportEndIndex: 10, viewportRows: 24 });
    expect(runtimes[1].resizeTerminal).toHaveBeenCalledWith(120, 40);
  });
});

