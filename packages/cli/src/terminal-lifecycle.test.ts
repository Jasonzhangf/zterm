import { describe, expect, it } from 'vitest';
import {
  createTerminalLifecycle,
  type TerminalLifecycleHooks,
} from './terminal-lifecycle.js';

class FakeOutput {
  writes: string[] = [];
  failOnWrite = 0;
  private writeCount = 0;

  write(value: string) {
    this.writes.push(value);
    this.writeCount += 1;
    if (this.writeCount === this.failOnWrite) {
      throw new Error('write failed');
    }
    return true;
  }
}

class FakeTty {
  isRaw = false;
  rawModes: boolean[] = [];
  failRawMode = false;

  setRawMode(value: boolean) {
    if (this.failRawMode) {
      throw new Error('raw mode failed');
    }
    this.rawModes.push(value);
    this.isRaw = value;
  }
}

function hooks(events: string[], options: {
  releaseError?: Error;
  projectionError?: Error;
} = {}): TerminalLifecycleHooks {
  return {
    stopInput() {
      events.push('stop-input');
    },
    async settleInput() {
      events.push('settle-input');
    },
    async releaseConnection() {
      events.push('release-connection');
      if (options.releaseError) throw options.releaseError;
    },
    async restoreProjection() {
      events.push('restore-projection');
      if (options.projectionError) throw options.projectionError;
    },
  };
}

describe('terminal-lifecycle public contract', () => {
  it('saves raw and only the modes it enables, then restores them once', async () => {
    const tty = new FakeTty();
    const output = new FakeOutput();
    const events: string[] = [];
    const lifecycle = createTerminalLifecycle({ tty, output, hooks: hooks(events) });

    const started = await lifecycle.start();
    if (started.kind !== 'ok') {
      throw started.error.cause;
    }
    expect(started.kind).toBe('ok');
    expect(tty.rawModes).toEqual([true]);
    expect(started.saved).toMatchObject({
      rawMode: false,
      changedModes: ['raw', 'alternate-screen', 'cursor', 'color', 'bracketed-paste'],
    });
    expect(output.writes.join('')).toContain('\x1b[?2004h');

    const first = await lifecycle.cleanup({ kind: 'normal' });
    const writesAfterFirst = output.writes.length;
    const second = await lifecycle.cleanup({ kind: 'signal', signal: 'SIGTERM' });

    expect(first.kind).toBe('ok');
    expect(second.alreadyCleaned).toBe(true);
    expect(tty.rawModes).toEqual([true, false]);
    expect(output.writes).toHaveLength(writesAfterFirst);
    expect(events).toEqual([
      'stop-input',
      'settle-input',
      'release-connection',
      'restore-projection',
    ]);
    expect(output.writes.slice(1).join('')).toContain('\x1b[?2004l');
  });

  it('continues terminal restore when network and projection cleanup fail', async () => {
    const tty = new FakeTty();
    const output = new FakeOutput();
    const events: string[] = [];
    const lifecycle = createTerminalLifecycle({
      tty,
      output,
      hooks: hooks(events, {
        releaseError: new Error('socket close failed'),
        projectionError: new Error('projection restore failed'),
      }),
    });

    await lifecycle.start();
    const result = await lifecycle.cleanup({ kind: 'network-error' });

    expect(result.kind).toBe('failed');
    expect(result.cleanupErrors.map(({ stage }) => stage)).toEqual([
      'release-connection',
      'restore-projection',
    ]);
    expect(tty.rawModes).toEqual([true, false]);
    expect(output.writes.slice(1).join('')).toContain('\x1b[?1049l');
  });

  it('runs the same cleanup after partial initialization failure', async () => {
    const tty = new FakeTty();
    const output = new FakeOutput();
    output.failOnWrite = 1;
    const events: string[] = [];
    const lifecycle = createTerminalLifecycle({ tty, output, hooks: hooks(events) });

    const started = await lifecycle.start();
    expect(started.kind).toBe('failed');
    expect(tty.rawModes).toEqual([true, false]);
    expect(events).toEqual([
      'stop-input',
      'settle-input',
      'release-connection',
      'restore-projection',
    ]);
  });

  it('unifies external signals and EPIPE through one idempotent cleanup path', async () => {
    const tty = new FakeTty();
    const output = new FakeOutput();
    const events: string[] = [];
    const lifecycle = createTerminalLifecycle({ tty, output, hooks: hooks(events) });
    await lifecycle.start();

    const signal = await lifecycle.handleSignal('SIGINT');
    const writesAfterSignal = output.writes.length;
    const epipe = await lifecycle.handleOutputError(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));

    expect(signal.kind).toBe('ok');
    expect(epipe.alreadyCleaned).toBe(true);
    expect(output.writes).toHaveLength(writesAfterSignal);
    expect(tty.rawModes).toEqual([true, false]);
  });

  it('does not emit terminal restore when initialization never changed a mode', async () => {
    const tty = new FakeTty();
    tty.failRawMode = true;
    const output = new FakeOutput();
    const events: string[] = [];
    const lifecycle = createTerminalLifecycle({ tty, output, hooks: hooks(events) });

    const started = await lifecycle.start();
    expect(started.kind).toBe('failed');
    expect(output.writes).toEqual([]);
    expect(tty.rawModes).toEqual([]);
  });
});
