import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from '@zterm/shared/protocol';
import {
  buildRemoteWindowInputConfig,
  createDefaultRemoteWindowInputHelper,
  normalizeRemoteWindowNativeKey,
  remoteWindowNativeCarrierKey,
  type RemoteWindowInputConfig,
  type RemoteWindowInputHelper,
} from './remote-window-input-helper';

interface FakeStream {
  writes: string[];
  write: (line: string, callback?: (error?: Error | null) => void) => boolean;
  setEncoding: (encoding: string) => void;
}

interface FakeChild {
  stdout: FakeStream & EventEmitter;
  stderr: FakeStream & EventEmitter;
  stdin: FakeStream;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  kill: (signal?: string) => boolean;
  emitLine: (object: unknown) => void;
  exit: () => void;
}

function createFakeChild(): FakeChild {
  const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { writes, write() { return true; }, setEncoding() {} });
  const stderr = Object.assign(new EventEmitter(), { writes, write() { return true; }, setEncoding() {} });
  const stdin: FakeStream = {
    writes,
    write(line, callback) { writes.push(line); callback?.(null); return true; },
    setEncoding() {},
  };
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill() { child.killed = true; return true; },
  }) as unknown as FakeChild;
  (child as unknown as { emitLine: FakeChild['emitLine'] }).emitLine = (object) => {
    stdout.emit('data', `${JSON.stringify(object)}\n`);
  };
  (child as unknown as { exit: FakeChild['exit'] }).exit = () => {
    child.exitCode = 0;
    (child as unknown as EventEmitter).emit('exit', 0, null);
  };
  return child;
}

function createTestHelper(): { helper: RemoteWindowInputHelper; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const helper = createDefaultRemoteWindowInputHelper({
    swiftBinary: 'swift',
    processFactory: () => {
      const child = createFakeChild();
      children.push(child);
      return child as never;
    },
  });
  return { helper, children };
}

async function warmHelper(helper: RemoteWindowInputHelper, children: FakeChild[]): Promise<void> {
  const warm = helper.warm();
  await new Promise((resolve) => setImmediate(resolve));
  children[0].emitLine({ ready: true });
  await warm;
}

function downConfig(streamId: string, code: string): RemoteWindowInputConfig {
  return {
    streamId,
    daemonReceivedAtMs: Date.now(),
    pid: 1,
    appBundleId: 'fixture.app',
    focusPolicy: 'bring-to-focus',
    window: { windowId: '1', title: 't', bounds: { x: 0, y: 0, width: 10, height: 10 } },
    event: { kind: 'key', phase: 'down', key: 'w', code },
  };
}

function downKeyConfig(
  streamId: string,
  event: Extract<RemoteWindowInputConfig['event'], { kind: 'key' }>,
): RemoteWindowInputConfig {
  return {
    streamId,
    daemonReceivedAtMs: Date.now(),
    pid: 1,
    appBundleId: 'fixture.app',
    focusPolicy: 'bring-to-focus',
    window: { windowId: '1', title: 't', bounds: { x: 0, y: 0, width: 10, height: 10 } },
    event,
  };
}

const targetFixture = {
  videoTarget: {
    pid: 42,
    appBundleId: 'fixture.app',
    windowId: '7',
    title: 't',
    windowBoundsTopLeftPx: { x: 0, y: 0, width: 10, height: 10 },
  },
  focusPolicy: 'bring-to-focus',
} as unknown as RemoteWindowStreamTargetManifest;

describe('remote-window-input-helper', () => {
  it('returns native operation results for resize without changing void success compatibility', async () => {
    const { helper, children } = createTestHelper();
    await warmHelper(helper, children);
    const send = helper.send({
      streamId: 's1',
      daemonReceivedAtMs: Date.now(),
      pid: 1,
      appBundleId: 'fixture.app',
      focusPolicy: 'bring-to-focus',
      window: { windowId: '1', title: 't', bounds: { x: 0, y: 0, width: 10, height: 10 } },
      event: { kind: 'window-resize', width: 1080, height: 1395 },
    } as RemoteWindowInputConfig);

    children[0].emitLine({
      ok: true,
      operation: {
        kind: 'window-resize',
        position: { x: 617, y: 1405 },
        size: { width: 384, height: 624 },
      },
    });
    const result = await send;
    expect(result).toEqual({
      kind: 'window-resize',
      position: { x: 617, y: 1405 },
      size: { width: 384, height: 624 },
    });
  });

  it('rejects a resize response without native observed bounds', async () => {
    const { helper, children } = createTestHelper();
    await warmHelper(helper, children);
    const send = helper.send({
      streamId: 's1',
      daemonReceivedAtMs: Date.now(),
      pid: 1,
      appBundleId: 'fixture.app',
      focusPolicy: 'bring-to-focus',
      window: { windowId: '1', title: 't', bounds: { x: 0, y: 0, width: 10, height: 10 } },
      event: { kind: 'window-resize', width: 1080, height: 1395 },
    } as RemoteWindowInputConfig);

    children[0].emitLine({ ok: true });
    await expect(send).rejects.toThrow(/resize readback/);
  });

  it('keeps non-resize success as a void-compatible empty result', async () => {
    const { helper, children } = createTestHelper();
    await warmHelper(helper, children);
    const send = helper.send(downConfig('s1', 'KeyW'));
    children[0].emitLine({ ok: true });
    await expect(send).resolves.toBeUndefined();
  });

  it('normalizes native key carriers from a single typed mapping source', () => {
    expect(normalizeRemoteWindowNativeKey({ kind: 'key', phase: 'down', key: 'w', code: 'KeyW' })).toEqual({
      kind: 'key',
      nativeKeyCode: 13,
      nativeKeyText: null,
      flags: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
    });
    expect(normalizeRemoteWindowNativeKey({ kind: 'key', phase: 'down', key: 'z', code: '', text: 'z' })).toEqual({
      kind: 'key',
      nativeKeyCode: null,
      nativeKeyText: 'z',
      flags: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
    });
    expect(normalizeRemoteWindowNativeKey({ kind: 'key', phase: 'down', key: 'a', code: 'KeyA' })).toEqual({
      kind: 'key',
      nativeKeyCode: 0,
      nativeKeyText: null,
      flags: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
    });
    expect(remoteWindowNativeCarrierKey({
      kind: 'key',
      nativeKeyCode: null,
      nativeKeyText: '甲',
      flags: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
    })).toBe('key:0');
    expect(remoteWindowNativeCarrierKey({
      kind: 'key',
      nativeKeyCode: 0,
      nativeKeyText: null,
      flags: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
    })).toBe('key:0');
    expect(() => normalizeRemoteWindowNativeKey({ kind: 'key', phase: 'down', key: '', code: 'KeyQ' }))
      .toThrow(/unsupported/);
  });

  it('builds an internal config with stream id and normalized native carrier', () => {
    const config = buildRemoteWindowInputConfig({
      streamId: 's1',
      targetId: 't1',
      event: { kind: 'key', phase: 'down', key: 'w', code: 'KeyW', metaKey: true },
    }, targetFixture);
    expect(config.streamId).toBe('s1');
    expect(config.native).toEqual({
      kind: 'key',
      nativeKeyCode: 13,
      nativeKeyText: null,
      flags: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: true },
    });
  });

  it('reserves one holder per stream/carrier and withdraws shared holders without a native up', async () => {
    const { helper, children } = createTestHelper();
    await warmHelper(helper, children);
    const first = helper.send(downConfig('s1', 'KeyW'));
    children[0].emitLine({ ok: true });
    await first;
    expect(helper.hasLease('s1')).toBe(true);
    expect(helper.hasLease('s2')).toBe(false);
    const repeat = helper.send(downConfig('s1', 'KeyW'));
    children[0].emitLine({ ok: true });
    await repeat;
    const second = helper.send(downConfig('s2', 'KeyW'));
    children[0].emitLine({ ok: true });
    await second;
    const result = await helper.releaseStream('s1');
    expect(result.sharedReleased).toEqual(['key:13']);
    expect(result.released).toEqual([]);
    expect(result.remaining).toEqual([]);
    expect(helper.hasLease('s1')).toBe(false);
    expect(helper.hasLease('s2')).toBe(true);
    expect(children[0].stdin.writes.filter((line) => line.includes('"release"'))).toHaveLength(0);
  });

  it('releases the final holder through a serialized native release operation', async () => {
    const { helper, children } = createTestHelper();
    await warmHelper(helper, children);
    const send = helper.send(downConfig('s1', 'KeyW'));
    children[0].emitLine({ ok: true });
    await send;
    const release = helper.releaseStream('s1');
    await new Promise((resolve) => setImmediate(resolve));
    const releaseWrite = children[0].stdin.writes.find((line) => line.includes('"release"'));
    expect(releaseWrite).toBeTruthy();
    const parsed = JSON.parse(releaseWrite!);
    expect(parsed.release.nativeKeyCode).toBe(13);
    expect(parsed.release.observeKeyCode).toBe(13);
    children[0].emitLine({ ok: true, release: { status: 'released' } });
    const result = await release;
    expect(result.status).toBe('released');
    expect(result.released).toEqual(['key:13']);
    expect(helper.hasLease('s1')).toBe(false);
  });

  it('retains the exact holder when the native release is unconfirmed', async () => {
    const { helper, children } = createTestHelper();
    await warmHelper(helper, children);
    const send = helper.send(downConfig('s1', 'KeyW'));
    children[0].emitLine({ ok: true });
    await send;
    const release = helper.releaseStream('s1');
    await new Promise((resolve) => setImmediate(resolve));
    children[0].emitLine({ ok: true, release: { status: 'unverified' } });
    const result = await release;
    expect(result.status).toBe('unverified');
    expect(result.remaining).toEqual(['key:13']);
    expect(helper.hasLease('s1')).toBe(true);
  });

  it('retains the lease after a lost down reply and releases through the replacement child', async () => {
    const { helper, children } = createTestHelper();
    await warmHelper(helper, children);
    const send = helper.send(downConfig('s1', 'KeyW'));
    send.catch(() => undefined);
    expect(helper.hasLease('s1')).toBe(true);
    await expect(send).rejects.toThrow(/timed out/);
    expect(helper.hasLease('s1')).toBe(true);
    expect(children[0].killed).toBe(true);
    children[0].exit();
    const release = helper.releaseStream('s1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(children[1]).toBeTruthy();
    children[1].emitLine({ ready: true });
    await new Promise((resolve) => setImmediate(resolve));
    const releaseWrite = children[1].stdin.writes.find((line) => line.includes('"release"'));
    expect(releaseWrite).toBeTruthy();
    children[1].emitLine({ ok: true, release: { status: 'released' } });
    const result = await release;
    expect(result.status).toBe('released');
    expect(helper.hasLease('s1')).toBe(false);
  });

  it('releases all own holders during async dispose and surfaces a release failure', async () => {
    const { helper, children } = createTestHelper();
    await warmHelper(helper, children);
    const send = helper.send(downConfig('s1', 'KeyW'));
    children[0].emitLine({ ok: true });
    await send;
    const dispose = helper.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    const releaseWrite = children[0].stdin.writes.find((line) => line.includes('"release"'));
    expect(releaseWrite).toBeTruthy();
    children[0].emitLine({ ok: true, release: { status: 'failed', error: 'held' } });
    children[0].exit();
    await expect(dispose).rejects.toThrow(/disposal failed/);
    expect(helper.hasLease('s1')).toBe(true);
  });

  it('shares key0 between unicode and mapped KeyA and releases the remaining holder with its own carrier', async () => {
    const { helper, children } = createTestHelper();
    await warmHelper(helper, children);
    const a = helper.send(downKeyConfig('ua', { kind: 'key', phase: 'down', key: '甲', code: '', text: '甲' }));
    children[0].emitLine({ ok: true });
    await a;
    const b = helper.send(downKeyConfig('ub', { kind: 'key', phase: 'down', key: 'a', code: 'KeyA' }));
    children[0].emitLine({ ok: true });
    await b;
    const shared = await helper.releaseStream('ua');
    expect(shared.sharedReleased).toEqual(['key:0']);
    expect(shared.released).toEqual([]);
    expect(helper.hasLease('ua')).toBe(false);
    expect(helper.hasLease('ub')).toBe(true);
    const final = helper.releaseStream('ub');
    await new Promise((resolve) => setImmediate(resolve));
    const finalWrite = children[0].stdin.writes.find((line) => line.includes('"release"'));
    expect(finalWrite).toBeTruthy();
    const parsed = JSON.parse(finalWrite!);
    expect(parsed.release.nativeKeyCode).toBe(0);
    expect(parsed.release.nativeKeyText).toBeNull();
    expect(parsed.release.observeKeyCode).toBe(0);
    children[0].emitLine({ ok: true, release: { status: 'released' } });
    const result = await final;
    expect(result.status).toBe('released');
    expect(result.released).toEqual(['key:0']);
    expect(helper.hasLease('ub')).toBe(false);
  });
});
