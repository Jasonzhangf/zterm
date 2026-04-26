import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTransport {
  state: any;
  scheduleState: any;
  getState: () => any;
  getScheduleState: () => any;
  connect: (target: unknown, handlers?: { onServerMessage?: (message: any) => void }) => void;
  disconnect: () => void;
  setActivityMode: (mode: 'active' | 'idle') => void;
  requestBufferHead: ReturnType<typeof vi.fn>;
  requestBufferSync: ReturnType<typeof vi.fn>;
  requestScheduleList: ReturnType<typeof vi.fn>;
  upsertScheduleJob: ReturnType<typeof vi.fn>;
  deleteScheduleJob: ReturnType<typeof vi.fn>;
  toggleScheduleJob: ReturnType<typeof vi.fn>;
  runScheduleJobNow: ReturnType<typeof vi.fn>;
  sendInput: ReturnType<typeof vi.fn>;
  pasteImage: ReturnType<typeof vi.fn>;
  resizeTerminal: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  subscribe: (listener: () => void) => () => void;
  emitServerMessage: (message: any) => void;
}

let bridgeTransport: FakeTransport;
let localTransport: FakeTransport;

function createFakeTransport(): FakeTransport {
  const listeners = new Set<() => void>();
  let serverHandler: ((message: any) => void) | undefined;
  const transport: FakeTransport = {
    state: {
      status: 'idle',
      error: '',
      connectedSessionId: '',
      title: '',
      activeTarget: null,
    },
    scheduleState: { sessionName: '', jobs: [], loading: false },
    getState: () => transport.state,
    getScheduleState: () => transport.scheduleState,
    connect: (_target, handlers) => {
      serverHandler = handlers?.onServerMessage;
      transport.state = {
        ...transport.state,
        status: 'connecting',
      };
      listeners.forEach((listener) => listener());
    },
    disconnect: () => {
      transport.state = {
        ...transport.state,
        status: 'idle',
      };
      listeners.forEach((listener) => listener());
    },
    setActivityMode: () => {},
    requestBufferHead: vi.fn(),
    requestBufferSync: vi.fn(),
    requestScheduleList: vi.fn(),
    upsertScheduleJob: vi.fn(),
    deleteScheduleJob: vi.fn(),
    toggleScheduleJob: vi.fn(),
    runScheduleJobNow: vi.fn(),
    sendInput: vi.fn(),
    pasteImage: vi.fn(() => true),
    resizeTerminal: vi.fn(),
    dispose: vi.fn(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitServerMessage: (message) => {
      if (message.type === 'connected') {
        transport.state = {
          ...transport.state,
          status: 'connected',
          connectedSessionId: message.payload.sessionId,
        };
        listeners.forEach((listener) => listener());
      }
      serverHandler?.(message);
    },
  };
  return transport;
}

vi.mock('../../mac/src/lib/bridge-transport', () => ({
  createBridgeTransportController: () => bridgeTransport,
  createIdleConnectionState: () => ({ status: 'idle', error: '', connectedSessionId: '', title: '', activeTarget: null }),
}));

vi.mock('../../mac/src/lib/local-tmux-transport', () => ({
  createLocalTmuxTransportController: () => localTransport,
}));

describe('mac terminal-runtime audit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    bridgeTransport = createFakeTransport();
    localTransport = createFakeTransport();
  });

  it('requests head on connect instead of directly requesting a buffer range', async () => {
    const { createTerminalRuntime } = await import('../../mac/src/lib/terminal-runtime');
    const runtime = createTerminalRuntime();

    runtime.connectRemote({
      id: '1',
      createdAt: 1,
      name: 'demo',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      sessionName: 'demo',
      authType: 'password',
      tags: [],
      pinned: false,
      password: '',
    });
    bridgeTransport.emitServerMessage({ type: 'connected', payload: { sessionId: 'remote:demo' } });

    expect(bridgeTransport.requestBufferHead).toHaveBeenCalledTimes(1);
    expect(bridgeTransport.requestBufferSync).not.toHaveBeenCalled();

    runtime.dispose();
  });

  it('requests follow range only after a newer head indicates local tail is behind', async () => {
    const { createTerminalRuntime } = await import('../../mac/src/lib/terminal-runtime');
    const runtime = createTerminalRuntime();

    runtime.connectRemote({
      id: '1',
      createdAt: 1,
      name: 'demo',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      sessionName: 'demo',
      authType: 'password',
      tags: [],
      pinned: false,
      password: '',
    });
    bridgeTransport.emitServerMessage({ type: 'connected', payload: { sessionId: 'remote:demo' } });
    bridgeTransport.emitServerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'remote:demo',
        revision: 1,
        latestEndIndex: 120,
        availableStartIndex: 48,
        availableEndIndex: 120,
      },
    });

    expect(bridgeTransport.requestBufferSync).toHaveBeenCalledTimes(1);
    expect(bridgeTransport.requestBufferSync.mock.calls[0]?.[0]).toMatchObject({
      mode: 'follow',
      viewportEndIndex: 120,
      viewportRows: 24,
    });

    runtime.dispose();
  });

  it('asks head truth immediately after local input', async () => {
    const { createTerminalRuntime } = await import('../../mac/src/lib/terminal-runtime');
    const runtime = createTerminalRuntime();

    runtime.connectRemote({
      id: '1',
      createdAt: 1,
      name: 'demo',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      sessionName: 'demo',
      authType: 'password',
      tags: [],
      pinned: false,
      password: '',
    });
    bridgeTransport.emitServerMessage({ type: 'connected', payload: { sessionId: 'remote:demo' } });
    bridgeTransport.requestBufferHead.mockClear();

    runtime.sendInput('ls\r');

    expect(bridgeTransport.sendInput).toHaveBeenCalledWith('ls\r');
    expect(bridgeTransport.requestBufferHead).toHaveBeenCalledTimes(1);

    runtime.dispose();
  });
});
