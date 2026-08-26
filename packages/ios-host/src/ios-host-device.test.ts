import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isIosDeviceLifecycleSignal,
  projectAppStateChange,
  createIosDeviceLifecycleManager,
  IOS_LIFECYCLE_CHANNEL,
  type IosDeviceLifecycleSignal,
} from './ios-device-lifecycle.ts';
import {
  validatePermissionKind,
  validatePermissionState,
  projectPermissionStatus,
  createIosPermissionsManager,
  type IosPermissionKind,
  type IosPermissionState,
} from './ios-permissions.ts';
import {
  projectImeContext,
  createIosImeManager,
  type IosImeVisibility,
} from './ios-ime.ts';

// === device lifecycle tests ===

test('isIosDeviceLifecycleSignal rejects unknown signals and accepts known ones', () => {
  assert.equal(isIosDeviceLifecycleSignal('foreground-resume'), true);
  assert.equal(isIosDeviceLifecycleSignal('background-entered'), true);
  assert.equal(isIosDeviceLifecycleSignal('memory-warning'), true);
  assert.equal(isIosDeviceLifecycleSignal('low-battery'), true);
  assert.equal(isIosDeviceLifecycleSignal('network-status-change'), true);
  assert.equal(isIosDeviceLifecycleSignal('connected'), false);
  assert.equal(isIosDeviceLifecycleSignal('unknown-signal'), false);
  assert.equal(isIosDeviceLifecycleSignal(null), false);
  assert.equal(isIosDeviceLifecycleSignal(undefined), false);
  assert.equal(isIosDeviceLifecycleSignal(123), false);
});

test('projectAppStateChange projects Capacitor AppState to typed lifecycle signal', () => {
  assert.equal(projectAppStateChange({ isActive: false, isMultiTasking: true }), 'background-entered');
  assert.equal(projectAppStateChange({ isActive: true, isMultiTasking: true }), 'foreground-resume');
  assert.equal(projectAppStateChange({ isActive: true, isMultiTasking: false, batteryLevel: 0.15 }), 'low-battery');
  assert.equal(projectAppStateChange({ isActive: true, isMultiTasking: false, batteryLevel: 0.5 }), 'foreground-resume');
  assert.equal(projectAppStateChange({ isActive: false, isMultiTasking: false, batteryLevel: 0.1 }), 'background-entered');
});

test('IosDeviceLifecycleManager projects current signal and subscribes without native leakage', () => {
  let listenerCallCount = 0;
  let receivedSignals: IosDeviceLifecycleSignal[] = [];
  const manager = createIosDeviceLifecycleManager({
    getAppState: () => ({ isActive: true, isMultiTasking: true }),
    addAppStateListener: (listener) => ({
      dispose: () => {},
    }),
  });
  assert.equal(manager.getCurrentSignal(), 'foreground-resume');
  const sub = manager.subscribe((signal) => {
    listenerCallCount++;
    receivedSignals.push(signal);
  });
  assert.equal(listenerCallCount, 0);
  sub.dispose('test');
});

test('IOS_LIFECYCLE_CHANNEL is a constant string channel', () => {
  assert.equal(typeof IOS_LIFECYCLE_CHANNEL, 'string');
  assert.equal(IOS_LIFECYCLE_CHANNEL, 'zterm:ios:lifecycle');
});

// === permission tests ===

test('validatePermissionKind rejects invalid kinds and accepts valid ones', () => {
  assert.equal(validatePermissionKind('camera'), 'camera');
  assert.equal(validatePermissionKind('microphone'), 'microphone');
  assert.equal(validatePermissionKind('location'), 'location');
  assert.equal(validatePermissionKind('notification'), 'notification');
  assert.equal(validatePermissionKind('notification'), 'notification');
  assert.throws(() => validatePermissionKind('invalid'), /invalid permission kind/);
  assert.throws(() => validatePermissionKind(null), /invalid permission kind/);
  assert.throws(() => validatePermissionKind(''), /invalid permission kind/);
  assert.throws(() => validatePermissionKind(123), /invalid permission kind/);
});

test('validatePermissionState rejects invalid states and accepts valid ones', () => {
  assert.equal(validatePermissionState('granted'), 'granted');
  assert.equal(validatePermissionState('denied'), 'denied');
  assert.equal(validatePermissionState('prompt'), 'prompt');
  assert.equal(validatePermissionState('restricted'), 'restricted');
  assert.equal(validatePermissionState('restricted'), 'restricted');
  assert.throws(() => validatePermissionState('unknown'), /invalid permission state/);
  assert.throws(() => validatePermissionState(null), /invalid permission state/);
  assert.throws(() => validatePermissionState('GRANTED'), /invalid permission state/);
});

test('projectPermissionStatus validates and projects native state to typed permission status', () => {
  const status = projectPermissionStatus('camera', 'granted');
  assert.equal(status.kind, 'camera');
  assert.equal(status.state, 'granted');
  assert.throws(() => projectPermissionStatus('invalid-kind', 'granted'), /invalid permission kind/);
  assert.throws(() => projectPermissionStatus('camera', 'invalid-state'), /invalid permission state/);
});

test('IosPermissionsManager checks and requests without native leakage', async () => {
  let checkedKinds: IosPermissionKind[] = [];
  let requestedKinds: IosPermissionKind[] = [];
  const manager = createIosPermissionsManager({
    async check(kind) {
      checkedKinds.push(kind);
      return 'granted';
    },
    async request(kind) {
      requestedKinds.push(kind);
      return 'granted';
    },
  });
  const status = await manager.check('camera');
  assert.equal(status.kind, 'camera');
  assert.equal(status.state, 'granted');
  assert.deepEqual(checkedKinds, ['camera']);
  const reqStatus = await manager.request('microphone');
  assert.deepEqual(requestedKinds, ['microphone']);
  const all = await manager.checkAll();
  assert.equal(all.length, 4);
  assert.equal(all.find(s => s.kind === 'notification')?.state, 'granted');
});

// === IME tests ===

test('projectImeContext normalizes keyboard state to typed IME context', () => {
  const ctx1 = projectImeContext(true, 300, 'text');
  assert.equal(ctx1.visibility, 'visible');
  assert.equal(ctx1.keyboardHeight, 300);
  assert.equal(ctx1.inputMode, 'text');

  const ctx2 = projectImeContext(false, 0, 'numeric');
  assert.equal(ctx2.visibility, 'hidden');
  assert.equal(ctx2.keyboardHeight, 0);
  assert.equal(ctx2.inputMode, 'numeric');

  assert.throws(() => projectImeContext(true, -50, 'default'), /keyboardHeight/);

  const ctx4 = projectImeContext(true, 400, 'email');
  assert.equal(ctx4.inputMode, 'email');

  const ctx5 = projectImeContext(true, 200, 'search');
  assert.equal(ctx5.inputMode, 'text'); // falls back to text

  const ctx6 = projectImeContext(true, 200, 'url');
  assert.equal(ctx6.inputMode, 'url');
});

test('createIosImeManager projects current context and subscribes without native leakage', () => {
  const manager = createIosImeManager({
    getKeyboardHeight: () => 250,
    addKeyboardListener: () => ({ remove: () => {} }),
    getInputMode: () => 'text',
  });
  const ctx = manager.getCurrentContext();
  assert.equal(ctx.visibility, 'visible');
  assert.equal(ctx.keyboardHeight, 250);
  assert.equal(ctx.inputMode, 'text');
  const sub = manager.subscribe(() => {});
  sub.remove();
});

// === integration: all contracts compose without cross-contamination ===

test('all contracts export from ios-host index', async () => {
  const mod = await import('./index.ts');
  assert.equal(typeof mod.IosHostGateway, 'function');
  assert.equal(typeof mod.createIosCapacitorAdapter, 'function');
  assert.equal(typeof mod.decodeIosCommand, 'function');
  assert.equal(typeof mod.decodeIosEvent, 'function');
  assert.equal(typeof mod.decodeIosSnapshot, 'function');
  assert.equal(typeof mod.isIosLifecycleSignal, 'function');
  assert.equal(typeof mod.isIosDeviceLifecycleSignal, 'function');
  assert.equal(typeof mod.validatePermissionKind, 'function');
  assert.equal(typeof mod.validatePermissionState, 'function');
  assert.equal(typeof mod.projectImeContext, 'function');
  assert.equal(typeof mod.IOS_COMMAND_CHANNEL, 'string');
  assert.equal(typeof mod.IOS_LIFECYCLE_CHANNEL, 'string');
});
