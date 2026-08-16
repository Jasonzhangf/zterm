import { describe, expect, it, vi } from 'vitest';
import { createHerdrBackendSessionAdapter, type HerdrControlMessage } from './herdr-backend';
import { HerdrFrameCanonicalizer } from './herdr-frame-canonicalizer';

function frame(bytes: string, seq: number, full: boolean) {
  return {
    type: 'terminal.frame' as const,
    bytes: Buffer.from(bytes).toString('base64'),
    seq,
    full,
    width: 12,
    height: 3,
  };
}

async function makeAdapter() {
  const sent: HerdrControlMessage[] = [];
  const frames: number[] = [];
  const errors: Error[] = [];
  const closed: string[] = [];
  const adapter = createHerdrBackendSessionAdapter({
    canonicalizer: await HerdrFrameCanonicalizer.create(),
    transport: { send: (message) => sent.push(message), close: vi.fn() },
    events: {
      onCanonicalFrame: (snapshot) => frames.push(snapshot.ztermRevision),
      onClosed: (reason) => closed.push(reason),
      onError: (error) => errors.push(error),
    },
  });
  return { adapter, sent, frames, errors, closed };
}

describe('Herdr single-session backend adapter', () => {
  it('keeps control messages typed and terminal frame errors off the success path', async () => {
    const state = await makeAdapter();
    state.adapter.inputText('echo marker');
    state.adapter.input(new Uint8Array([0x65, 0x63, 0x68, 0x6f]));
    state.adapter.resize({ cols: 100, rows: 30 });
    state.adapter.receive(frame('ready', 1, true));
    state.adapter.receive(frame('bad', 3, false));

    expect(state.sent).toEqual([
      { type: 'terminal.input', text: 'echo marker' },
      { type: 'terminal.input', bytes: 'ZWNobw==' },
      { type: 'terminal.resize', cols: 100, rows: 30 },
    ]);
    expect(state.frames).toEqual([1]);
    expect(state.errors.map((error) => error.message)).toEqual([
      'Herdr frame cannot advance attachment seq=1 to seq=3',
    ]);
  });

  it('handles release and reconnect without reusing the old delta baseline', async () => {
    const state = await makeAdapter();
    state.adapter.receive(frame('first', 4, true));
    state.adapter.release();
    expect(state.sent[state.sent.length - 1]).toEqual({ type: 'terminal.release' });
    expect(() => state.adapter.input(new Uint8Array([1]))).toThrow(/after release/);

    state.adapter.reconnect();
    state.adapter.receive(frame('second', 1, true));
    expect(state.frames).toEqual([1, 2]);
    expect(state.errors).toEqual([]);
  });

  it('keeps independent adapter instances for multiple observers/controllers', async () => {
    const first = await makeAdapter();
    const second = await makeAdapter();
    first.adapter.receive(frame('first', 1, true));
    second.adapter.receive(frame('second', 1, true));
    first.adapter.receive(frame('delta', 2, false));

    expect(first.frames).toEqual([1, 2]);
    expect(second.frames).toEqual([1]);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
  });

  it('rejects control operations after an explicit source close', async () => {
    const state = await makeAdapter();
    state.adapter.receive({ type: 'terminal.closed', reason: 'detached' });
    expect(state.closed).toEqual(['detached']);
    expect(() => state.adapter.resize({ cols: 80, rows: 24 })).toThrow(/after release/);
    state.adapter.receive(frame('late', 1, true));
    expect(state.errors.map((error) => error.message)).toEqual([
      'Herdr source message received after release',
    ]);
  });

  it('treats source termination as idempotent release cleanup', async () => {
    const state = await makeAdapter();
    state.adapter.receive({ type: 'terminal.closed', reason: 'detached' });

    expect(() => state.adapter.release()).not.toThrow();
    expect(state.sent).toEqual([]);
  });
});
