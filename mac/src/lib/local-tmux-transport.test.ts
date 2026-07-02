// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalTmuxTransportController } from './local-tmux-transport';
import type { BridgeServerMessage, BufferHeadPayload, TerminalBufferPayload } from '@zterm/shared';

type LocalTmuxEvent = {
  clientId: string;
  message: BridgeServerMessage;
};

const localTmuxApi = {
  subscribe: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  setActivityMode: vi.fn(),
  requestBufferHead: vi.fn(),
  requestBufferSync: vi.fn(),
  sendInput: vi.fn(),
  resize: vi.fn(),
};

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function installLocalTmuxApi() {
  let eventHandler: ((event: LocalTmuxEvent) => void) | null = null;
  localTmuxApi.subscribe.mockImplementation((handler: (event: LocalTmuxEvent) => void) => {
    eventHandler = handler;
    return () => {
      eventHandler = null;
    };
  });
  localTmuxApi.connect.mockResolvedValue(undefined);
  localTmuxApi.disconnect.mockResolvedValue(undefined);
  localTmuxApi.setActivityMode.mockResolvedValue(undefined);
  localTmuxApi.requestBufferHead.mockResolvedValue(null);
  localTmuxApi.requestBufferSync.mockResolvedValue(null);
  localTmuxApi.sendInput.mockResolvedValue(undefined);
  localTmuxApi.resize.mockResolvedValue(undefined);

  (window as unknown as {
    ztermMac: {
      localTmux: typeof localTmuxApi;
    };
  }).ztermMac = {
    localTmux: localTmuxApi,
  };

  return {
    emit: (event: LocalTmuxEvent) => {
      eventHandler?.(event);
    },
  };
}

function resetLocalTmuxApi() {
  for (const mock of Object.values(localTmuxApi)) {
    mock.mockReset();
  }
  delete (window as unknown as { ztermMac?: unknown }).ztermMac;
}

function makeHeadPayload(): BufferHeadPayload {
  return {
    sessionId: 'local:zterm_mirror_lab',
    revision: 2,
    latestEndIndex: 44,
    availableStartIndex: 20,
    availableEndIndex: 44,
  };
}

function makeSyncPayload(): TerminalBufferPayload {
  return {
    revision: 2,
    startIndex: 20,
    endIndex: 44,
    availableStartIndex: 20,
    availableEndIndex: 44,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    lines: [{ i: 43, t: 'local tmux ok' }],
  };
}

describe('Mac local tmux transport connection', () => {
  beforeEach(() => {
    resetLocalTmuxApi();
  });

  afterEach(() => {
    resetLocalTmuxApi();
  });

  it('connects through Electron local tmux API and materializes connected state from emitted events', () => {
    const harness = installLocalTmuxApi();
    const controller = createLocalTmuxTransportController();
    const serverMessages: BridgeServerMessage[] = [];

    controller.connect({ sessionName: 'zterm_mirror_lab', title: 'Lab' }, {
      onServerMessage: (message) => serverMessages.push(message),
    });

    expect(controller.getState()).toMatchObject({
      status: 'connecting',
      connectedSessionId: '',
      title: 'Lab',
      activeTarget: { sessionName: 'zterm_mirror_lab', title: 'Lab' },
    });
    expect(localTmuxApi.subscribe).toHaveBeenCalledTimes(1);
    expect(localTmuxApi.connect).toHaveBeenCalledTimes(1);

    const connectPayload = localTmuxApi.connect.mock.calls[0]![0];
    expect(connectPayload).toMatchObject({
      sessionName: 'zterm_mirror_lab',
      cols: 80,
      rows: 24,
      mode: 'active',
    });
    expect(connectPayload.clientId).toMatch(/^local-/);

    harness.emit({
      clientId: connectPayload.clientId,
      message: {
        type: 'connected',
        payload: { sessionId: 'local:zterm_mirror_lab' },
      } as BridgeServerMessage,
    });

    expect(controller.getState()).toMatchObject({
      status: 'connected',
      connectedSessionId: 'local:zterm_mirror_lab',
      error: '',
    });
    expect(serverMessages.map((message) => message.type)).toEqual(['connected']);
  });

  it('requests head/body and forwards returned local tmux payloads through the same server-message path', async () => {
    const harness = installLocalTmuxApi();
    const controller = createLocalTmuxTransportController();
    const serverMessages: BridgeServerMessage[] = [];
    localTmuxApi.requestBufferHead.mockResolvedValue(makeHeadPayload());
    localTmuxApi.requestBufferSync.mockResolvedValue(makeSyncPayload());

    controller.connect({ sessionName: 'zterm_mirror_lab' }, {
      onServerMessage: (message) => serverMessages.push(message),
    });
    const clientId = localTmuxApi.connect.mock.calls[0]![0].clientId;
    harness.emit({
      clientId,
      message: {
        type: 'connected',
        payload: { sessionId: 'local:zterm_mirror_lab' },
      } as BridgeServerMessage,
    });

    controller.requestBufferHead();
    await flushPromises();
    expect(localTmuxApi.requestBufferHead).toHaveBeenCalledWith(clientId);
    expect(serverMessages.at(-1)).toMatchObject({
      type: 'buffer-head',
      payload: { revision: 2, latestEndIndex: 44 },
    });

    controller.requestBufferSync({
      knownRevision: 1,
      localStartIndex: 20,
      localEndIndex: 44,
      requestStartIndex: 20,
      requestEndIndex: 44,
    });
    await flushPromises();

    expect(localTmuxApi.requestBufferSync).toHaveBeenCalledWith(clientId, {
      knownRevision: 1,
      localStartIndex: 20,
      localEndIndex: 44,
      requestStartIndex: 20,
      requestEndIndex: 44,
    });
    expect(serverMessages.at(-1)).toMatchObject({
      type: 'buffer-sync',
      payload: {
        revision: 2,
        lines: [{ i: 43, t: 'local tmux ok' }],
      },
    });
  });

  it('routes input, resize, activity mode, and disconnect to the same local tmux client id', () => {
    installLocalTmuxApi();
    const controller = createLocalTmuxTransportController();

    controller.connect({ sessionName: 'zterm_mirror_lab' });
    const clientId = localTmuxApi.connect.mock.calls[0]![0].clientId;

    controller.setActivityMode('idle');
    controller.sendInput('echo local-client\\r');
    controller.resizeTerminal(120, 30);
    controller.disconnect();

    expect(localTmuxApi.setActivityMode).toHaveBeenCalledWith(clientId, 'idle');
    expect(localTmuxApi.sendInput).toHaveBeenCalledWith(clientId, 'echo local-client\\r');
    expect(localTmuxApi.resize).toHaveBeenCalledWith(clientId, 120, 30);
    expect(localTmuxApi.disconnect).toHaveBeenCalledWith(clientId);
    expect(controller.getState()).toMatchObject({
      status: 'idle',
      connectedSessionId: '',
    });
  });
});
