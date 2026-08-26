import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlCommand, okOutcome } from '@zterm/runtime-contracts';
import { createIosNativeHost } from './ios-native-bridge.ts';
import { createIosCapacitorAdapter } from '@zterm/ios-host';
import { projectImeContext } from '@zterm/ios-host';

function bridge() {
  const listeners = new Map<string, (body: string) => void>();
  return {
    posted: [] as Array<{ channel: string; body: string }>,
    postMessage(channel: string, body: string) {
      this.posted.push({ channel, body });
    },
    onMessage(channel: string, listener: (body: string) => void) {
      listeners.set(channel, listener);
    },
    offMessage(channel: string) {
      listeners.delete(channel);
    },
    emit(channel: string, body: string) {
      listeners.get(channel)?.(body);
    },
  };
}

test('native host composes typed lifecycle, permission, IME, and command bridge', async () => {
  const nativeBridge = bridge();
  const host = createIosNativeHost(
    nativeBridge,
    {
      async execute(wire) {
        return { commandId: wire.commandId, generation: wire.generation, outcome: okOutcome({ accepted: true }) };
      },
      async readSnapshot() {
        return { revision: 0, generation: 1, data: {} };
      },
    },
    {
      getAppState: () => ({ isActive: true, isMultiTasking: false }),
      addAppStateListener: () => ({ dispose() {} }),
    },
    { check: async () => 'granted', request: async () => 'granted' },
    { getKeyboardHeight: () => 0, addKeyboardListener: () => ({ remove() {} }), getInputMode: () => 'text' },
  );

  const outcome = await host.gateway.execute(createControlCommand('session.list', 'command-1', 'corr-1', {}));
  assert.deepEqual(outcome, okOutcome({ accepted: true }));
  assert.equal(nativeBridge.posted.length, 1);
  assert.equal(host.lifecycle.getCurrentSignal(), 'foreground-resume');
  assert.deepEqual(await host.permissions.check('camera'), { kind: 'camera', state: 'granted' });
  assert.equal(host.ime.getCurrentContext().visibility, 'hidden');
});

test('native host rejects invalid lifecycle and IME projection instead of repairing it', () => {
  const nativeBridge = bridge();
  const host = createIosNativeHost(
    nativeBridge,
    { async execute() { throw new Error('unused'); }, async readSnapshot() { return { revision: 0, generation: 1, data: {} }; } },
    { getAppState: () => ({ isActive: true, isMultiTasking: false }), addAppStateListener: () => ({ dispose() {} }) },
    { check: async () => 'granted', request: async () => 'granted' },
    { getKeyboardHeight: () => 0, addKeyboardListener: () => ({ remove() {} }), getInputMode: () => 'text' },
  );
  assert.throws(() => createIosCapacitorAdapter(nativeBridge).projectLifecycle('connected'), /unsupported lifecycle signal/);
  assert.throws(() => projectImeContext(true, -1, 'text'), /keyboardHeight/);
  assert.equal(host.ime.getCurrentContext().visibility, 'hidden');
});
