import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAppStateChange, isIosDeviceLifecycleSignal } from './ios-device-lifecycle.ts';
import { validatePermissionKind, validatePermissionState, projectPermissionStatus } from './ios-permissions.ts';
import { projectImeContext } from './ios-ime.ts';

test('rejects invalid lifecycle projection when appState is missing required fields', () => {
  assert.throws(() => {
    projectAppStateChange(null as unknown as { isActive: boolean; isMultiTasking: boolean; batteryLevel?: number });
  }, TypeError);
});

test('rejects invalid permission kind in bridge validation', () => {
  assert.throws(() => validatePermissionKind('invalid-permission'), /invalid permission kind/);
});

test('rejects invalid permission state in bridge validation', () => {
  assert.throws(() => validatePermissionState('invalid-state'), /invalid permission state/);
});

test('rejects permission projection when either field is invalid', () => {
  assert.throws(() => projectPermissionStatus('bluetooth', 'granted'), /invalid permission kind/);
  assert.throws(() => projectPermissionStatus('camera', 'authorized'), /invalid permission state/);
});

test('rejects unknown device lifecycle signal', () => {
  assert.equal(isIosDeviceLifecycleSignal('connected'), false);
  assert.equal(isIosDeviceLifecycleSignal('unknown-signal'), false);
});

test('rejects negative IME keyboard height instead of silently clamping', () => {
  assert.throws(() => projectImeContext(true, -100, 'text'), /keyboardHeight/);
});
