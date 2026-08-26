import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePermissionKind, validatePermissionState } from './ios-permissions.ts';
import { projectImeContext } from './ios-ime.ts';
import { isIosDeviceLifecycleSignal } from './ios-device-lifecycle.ts';

test('rejects unknown lifecycle and permission values', () => {
  assert.equal(isIosDeviceLifecycleSignal('connected'), false);
  assert.throws(() => validatePermissionKind('screen'), /invalid permission kind/);
  assert.throws(() => validatePermissionState('ok'), /invalid permission state/);
});

test('rejects invalid IME dimensions', () => {
  assert.throws(() => projectImeContext(true, -1, 'text'), /keyboardHeight/);
  assert.throws(() => projectImeContext(true, 1.5, 'text'), /keyboardHeight/);
});
