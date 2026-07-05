// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeServerMessage, BufferSyncRequestPayload, TerminalBufferPayload } from '@zterm/shared';
import { createTerminalRuntime } from './terminal-runtime';

type LocalTmuxHandler = (message: BridgeServerMessage) => void;

const localTmuxHarness = vi.hoisted(() => ({
  state: {
    status: 'idle',
    error: '',
    connectedSessionId: '',
    title: '',
    activeTarget: null,
  } as any,
  handler: undefined as LocalTmuxHandler | undefined,
  syncRequests: [] as BufferSyncRequestPayload[],
  headRequests: 0,
}));

vi.mock('./bridge-transport', () => ({
  createIdleConnectionState: () => ({
    status: 'idle',
    error: '',
    connectedSessionId: '',
    title: '',
    activeTarget: null,
  }),
  createBridgeTransportController: () => ({
    getState: () => ({
      status: 'idle',
      error: '',
      connectedSessionId: '',
      title: '',
      activeTarget: null,
    }),
    getScheduleState: () => ({ sessionName: '', jobs: [], loading: false }),
    subscribe: () => () => {},
    connect: vi.fn(),
    disconnect: vi.fn(),
    setActivityMode: vi.fn(),
    requestBufferHead: vi.fn(),
    requestBufferSync: vi.fn(),
    requestScheduleList: vi.fn(),
    upsertScheduleJob: vi.fn(),
    deleteScheduleJob: vi.fn(),
    toggleScheduleJob: vi.fn(),
    runScheduleJobNow: vi.fn(),
    sendInput: vi.fn(),
    pasteImage: () => false,
    resizeTerminal: vi.fn(),
    dispose: vi.fn(),
    requestRemoteScreenshot: () => false,
    sendRawJson: () => false,
    onFileTransferMessage: () => () => {},
  }),
}));

vi.mock('./local-tmux-transport', () => ({
  createLocalTmuxTransportController: () => ({
    getState: () => localTmuxHarness.state,
    subscribe: () => () => {},
    connect: (_target: { sessionName: string }, handlers?: { onServerMessage?: LocalTmuxHandler }) => {
      localTmuxHarness.handler = handlers?.onServerMessage;
      localTmuxHarness.state = {
        status: 'connected',
        error: '',
        connectedSessionId: 'zterm',
        title: 'zterm',
        activeTarget: { sessionName: 'zterm' },
      };
      localTmuxHarness.handler?.({ type: 'connected', payload: { sessionId: 'zterm' } });
    },
    disconnect: vi.fn(),
    setActivityMode: vi.fn(),
    requestBufferHead: () => {
      localTmuxHarness.headRequests += 1;
    },
    requestBufferSync: (payload: BufferSyncRequestPayload) => {
      localTmuxHarness.syncRequests.push(payload);
    },
    sendInput: vi.fn(),
    pasteImage: () => false,
    resizeTerminal: vi.fn(),
    dispose: vi.fn(),
  }),
}));

function makeBufferPayload(revision: number, lines: string[]): TerminalBufferPayload {
  return {
    revision,
    startIndex: 50,
    endIndex: 70,
    availableStartIndex: 50,
    availableEndIndex: 70,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    lines: lines.map((text, offset) => ({ i: 50 + offset, t: text })),
  };
}

function emit(message: BridgeServerMessage) {
  localTmuxHarness.handler?.(message);
}

describe('terminal runtime same-end refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localTmuxHarness.state = {
      status: 'idle',
      error: '',
      connectedSessionId: '',
      title: '',
      activeTarget: null,
    };
    localTmuxHarness.handler = undefined;
    localTmuxHarness.syncRequests = [];
    localTmuxHarness.headRequests = 0;
  });

  it('requests a fresh body sync when head revision changes but latestEndIndex stays unchanged', () => {
    const runtime = createTerminalRuntime();
    runtime.connectLocalTmux({ sessionName: 'zterm' });
    runtime.updateViewport({ mode: 'follow', viewportEndIndex: 70, viewportRows: 20 });

    emit({
      type: 'buffer-head',
      payload: {
        sessionId: 'zterm',
        revision: 1,
        latestEndIndex: 70,
        availableStartIndex: 50,
        availableEndIndex: 70,
      },
    });
    expect(localTmuxHarness.syncRequests.length).toBeGreaterThanOrEqual(1);

    emit({ type: 'buffer-sync', payload: makeBufferPayload(1, ['old tail']) });
    const firstRequest = localTmuxHarness.syncRequests.at(-1);
    localTmuxHarness.syncRequests = [];

    emit({
      type: 'buffer-head',
      payload: {
        sessionId: 'zterm',
        revision: 2,
        latestEndIndex: 70,
        availableStartIndex: 50,
        availableEndIndex: 70,
      },
    });

    expect(localTmuxHarness.syncRequests).toHaveLength(1);
    expect(localTmuxHarness.syncRequests[0]).toMatchObject({
      requestStartIndex: firstRequest?.requestStartIndex,
      requestEndIndex: firstRequest?.requestEndIndex,
      targetHeadRevision: 2,
    });
    runtime.dispose();
  });

  it('does not duplicate body sync requests for the same head revision and same window', () => {
    const runtime = createTerminalRuntime();
    runtime.connectLocalTmux({ sessionName: 'zterm' });
    runtime.updateViewport({ mode: 'follow', viewportEndIndex: 70, viewportRows: 20 });

    const head: BridgeServerMessage = {
      type: 'buffer-head',
      payload: {
        sessionId: 'zterm',
        revision: 1,
        latestEndIndex: 70,
        availableStartIndex: 50,
        availableEndIndex: 70,
      },
    };
    emit(head);
    localTmuxHarness.syncRequests = [];
    emit(head);

    expect(localTmuxHarness.syncRequests).toHaveLength(0);
    runtime.dispose();
  });

  it('passes renderer missing ranges through reading repair sync requests', () => {
    const runtime = createTerminalRuntime();
    runtime.connectLocalTmux({ sessionName: 'zterm' });

    emit({
      type: 'buffer-head',
      payload: {
        sessionId: 'zterm',
        revision: 3,
        latestEndIndex: 120,
        availableStartIndex: 50,
        availableEndIndex: 120,
      },
    });
    emit({ type: 'buffer-sync', payload: makeBufferPayload(3, Array.from({ length: 20 }, (_, index) => `line ${index}`)) });
    localTmuxHarness.syncRequests = [];

    runtime.updateViewport({
      mode: 'reading',
      viewportEndIndex: 70,
      viewportRows: 20,
      missingRanges: [{ startIndex: 55, endIndex: 60 }],
    });
    vi.advanceTimersByTime(30);

    expect(localTmuxHarness.syncRequests).toHaveLength(1);
    expect(localTmuxHarness.syncRequests[0]).toMatchObject({
      requestEndIndex: 70,
      targetHeadRevision: 3,
      missingRanges: [{ startIndex: 55, endIndex: 60 }],
    });
    runtime.dispose();
  });
});
