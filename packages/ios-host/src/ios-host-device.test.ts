import assert from 'node:assert/strict';
import test from 'node:test';
import { createIosDeviceLifecycleManager, projectAppStateChange } from './ios-device-lifecycle.ts';
import { createIosPermissionsManager, projectPermissionStatus } from './ios-permissions.ts';
import { createIosImeManager, projectImeContext } from './ios-ime.ts';

test('lifecycle projects foreground, background, and low battery', () => {
  assert.equal(projectAppStateChange({ isActive: false, isMultiTasking: false }), 'background-entered');
  assert.equal(projectAppStateChange({ isActive: true, isMultiTasking: true }), 'foreground-resume');
  assert.equal(projectAppStateChange({ isActive: true, isMultiTasking: false, batteryLevel: 0.1 }), 'low-battery');
  const manager = createIosDeviceLifecycleManager({
    getAppState: () => ({ isActive: true, isMultiTasking: false }),
    addAppStateListener: () => ({ dispose() {} }),
  });
  assert.equal(manager.getCurrentSignal(), 'foreground-resume');
});

test('permission states and IME contexts remain typed', async () => {
  assert.deepEqual(projectPermissionStatus('camera', 'granted'), { kind: 'camera', state: 'granted' });
  const permissions = createIosPermissionsManager({ check: async () => 'prompt', request: async () => 'granted' });
  assert.equal((await permissions.check('microphone')).state, 'prompt');
  const ime = createIosImeManager({ getKeyboardHeight: () => 280, addKeyboardListener: () => ({ remove() {} }), getInputMode: () => 'text' });
  assert.deepEqual(ime.getCurrentContext(), { visibility: 'visible', keyboardHeight: 280, inputMode: 'text' });
  assert.equal(projectImeContext(false, 0, 'numeric').visibility, 'hidden');
});
