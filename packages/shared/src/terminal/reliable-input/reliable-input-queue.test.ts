import { describe, expect, it } from 'vitest';
import type { TerminalInputAckPayload } from '../../connection/protocol';
import {
  cliNoReplayPolicy,
  createReliableInputQueue,
  type ReliableInputQueue,
  type ReliableInputSettlement,
  type ReliableInputTransportSnapshot,
} from './reliable-input-queue';

interface TimerEntry {
  id: number;
  at: number;
  cancelled: boolean;
  callback: () => void;
}

function createHarness(options: {
  sendError?: Error;
  sendResult?: Promise<void>;
  onSettled?: (settlement: ReliableInputSettlement, queue: ReliableInputQueue) => void;
  transport?: Partial<ReliableInputTransportSnapshot>;
} = {}) {
  let now = 10_000;
  let nextTimerId = 1;
  let timers: TimerEntry[] = [];
  const sent: Array<{
    seq: string;
    data: string;
    bytes: number;
    attempt: number;
    channel: string | null;
    generation: string | null;
  }> = [];
  const settled: ReliableInputSettlement[] = [];
  let transport: ReliableInputTransportSnapshot = {
    available: true,
    ready: true,
    backpressured: false,
    channel: 'channel-a',
    generation: 'generation-a',
    ...options.transport,
  };

  const queue: ReliableInputQueue = createReliableInputQueue({
    connectionId: 'connection-a',
    policy: cliNoReplayPolicy,
    now: () => now,
    schedule: (callback, delayMs) => {
      const timer: TimerEntry = {
        id: nextTimerId,
        at: now + Math.max(0, delayMs),
        cancelled: false,
        callback,
      };
      timers.push(timer);
      return nextTimerId++;
    },
    cancelTimer: (handle) => {
      const timer = timers.find((candidate) => candidate.id === handle);
      if (timer) {
        timer.cancelled = true;
      }
    },
    readTransport: () => transport,
    send: (item) => {
      sent.push({
        seq: item.seq,
        data: item.data,
        bytes: item.bytes,
        attempt: item.attempt,
        channel: item.channel,
        generation: item.generation,
      });
      if (options.sendError) {
        throw options.sendError;
      }
      return options.sendResult;
    },
    onSettled: (result) => {
      settled.push(result);
      options.onSettled?.(result, queue);
    },
  });

  const advance = (milliseconds: number) => {
    const target = now + milliseconds;
    while (true) {
      timers.sort((left, right) => left.at - right.at);
      const timer = timers.find((candidate) => !candidate.cancelled && candidate.at <= target);
      if (!timer) {
        break;
      }
      timer.cancelled = true;
      now = timer.at;
      timer.callback();
    }
    now = target;
  };

  return {
    queue,
    sent,
    settled,
    advance,
    setTransport: (next: Partial<ReliableInputTransportSnapshot>) => {
      transport = { ...transport, ...next };
    },
    context: () => ({
      channel: transport.channel,
      generation: transport.generation,
    }),
  };
}

function ack(
  seq: string,
  overrides: Partial<TerminalInputAckPayload> = {},
): TerminalInputAckPayload {
  return {
    version: 1,
    seq,
    accepted: true,
    bytes: 1,
    ...overrides,
  };
}

describe('shared reliable input CLI no-replay policy', () => {
  it('settles a possible partial-write NACK as uncertain and cancels all unsent input', () => {
    const harness = createHarness();
    harness.queue.enqueueChunks(['a', 'b']);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.attempt).toBe(0);

    harness.queue.handleAck(
      ack(harness.sent[0]!.seq, {
        accepted: false,
        bytes: 0,
        error: 'input_stale_transport',
      }),
      harness.context(),
    );
    harness.advance(60_000);

    expect(harness.sent).toHaveLength(1);
    expect(harness.queue.snapshot().items.map((item) => item.state)).toEqual([
      'uncertain',
      'cancelled',
    ]);
    expect(harness.settled.map((entry) => entry.outcome)).toEqual([
      'uncertain',
      'cancelled',
    ]);
    expect(harness.settled[0]?.error?.code).toBe('input_stale_transport');
  });

  it('does not replay or release later input when the ACK is lost', () => {
    const harness = createHarness();
    harness.queue.enqueueChunks(['a', 'b']);

    harness.advance(4_999);
    expect(harness.sent).toHaveLength(1);
    harness.advance(1);
    harness.advance(60_000);

    expect(harness.sent).toHaveLength(1);
    expect(harness.queue.snapshot().items.map((item) => item.state)).toEqual([
      'uncertain',
      'cancelled',
    ]);
  });

  it('accepts success only for the matching seq, channel, generation, and UTF-8 bytes', () => {
    const harness = createHarness();
    harness.queue.enqueueChunks(['中', 'b']);
    const first = harness.sent[0]!;
    expect(first.bytes).toBe(3);

    expect(harness.queue.handleAck(ack('unknown', { bytes: 3 }), harness.context()).kind)
      .toBe('ignored');
    expect(harness.queue.handleAck(ack(first.seq, { bytes: 3 }), {
      channel: 'channel-old',
      generation: first.generation,
    }).kind).toBe('ignored');
    expect(harness.queue.handleAck(ack(first.seq, { bytes: 3 }), {
      channel: first.channel,
      generation: 'generation-old',
    }).kind).toBe('ignored');
    expect(harness.sent).toHaveLength(1);

    harness.queue.handleAck(ack(first.seq, { bytes: 3 }), harness.context());
    expect(harness.sent).toHaveLength(2);
    expect(harness.settled[0]).toMatchObject({ outcome: 'accepted' });
  });

  it('turns a mismatched success byte count into uncertain without releasing the next item', () => {
    const harness = createHarness();
    harness.queue.enqueueChunks(['abc', 'next']);
    const first = harness.sent[0]!;

    harness.queue.handleAck(ack(first.seq, { bytes: 2 }), harness.context());
    harness.advance(60_000);

    expect(harness.sent).toHaveLength(1);
    expect(harness.queue.snapshot().items.map((item) => item.state)).toEqual([
      'uncertain',
      'cancelled',
    ]);
    expect(harness.settled[0]?.error?.stage).toBe('protocol');
  });

  it('treats an exception after send starts and a transport generation change as uncertain', () => {
    const sendFailure = createHarness({ sendError: new Error('socket write threw') });
    sendFailure.queue.enqueueChunks(['a', 'b']);
    expect(sendFailure.sent).toHaveLength(1);
    expect(sendFailure.queue.snapshot().items.map((item) => item.state)).toEqual([
      'uncertain',
      'cancelled',
    ]);

    const generationChange = createHarness();
    generationChange.queue.enqueueChunks(['a', 'b']);
    generationChange.setTransport({ generation: 'generation-b' });
    generationChange.queue.pump();
    generationChange.advance(60_000);
    expect(generationChange.sent).toHaveLength(1);
    expect(generationChange.queue.snapshot().items.map((item) => item.state)).toEqual([
      'uncertain',
      'cancelled',
    ]);
    expect(generationChange.settled[0]?.error?.stage).toBe('generation');
  });

  it('treats an asynchronous send rejection as uncertain without replaying input', async () => {
    const harness = createHarness({
      sendResult: Promise.reject(new Error('socket write rejected')),
    });
    harness.queue.enqueueChunks(['a', 'b']);

    await Promise.resolve();
    await Promise.resolve();
    harness.advance(60_000);

    expect(harness.sent).toHaveLength(1);
    expect(harness.queue.snapshot().items.map((item) => item.state)).toEqual([
      'uncertain',
      'cancelled',
    ]);
    expect(harness.settled[0]?.error?.stage).toBe('send');
  });

  it('closes the send pump before notifying a consumer about an uncertain item', () => {
    let reentrantPump = false;
    const harness = createHarness({
      onSettled: (settlement, queue) => {
        if (settlement.outcome === 'uncertain' && !reentrantPump) {
          reentrantPump = true;
          queue.pump();
        }
      },
    });
    harness.queue.enqueueChunks(['a', 'b']);

    harness.queue.handleAck(
      ack(harness.sent[0]!.seq, {
        accepted: false,
        bytes: 0,
        error: 'input_stale_transport',
      }),
      harness.context(),
    );

    expect(reentrantPump).toBe(true);
    expect(harness.sent).toHaveLength(1);
    expect(harness.queue.snapshot().items.map((item) => item.state)).toEqual([
      'uncertain',
      'cancelled',
    ]);
  });
});
