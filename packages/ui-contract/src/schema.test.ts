import assert from 'node:assert/strict';
import test from 'node:test';
import { validateUiPluginManifest, validateUiViewModel } from './index.ts';

const validManifest = {
  pluginId: 'session-drawer',
  requires: ['capability:sessions'],
  contributes: [{ surfaceId: 'terminal.drawer', route: '/drawer', viewModelSchema: 'drawer@1' }],
};

test('accepts valid manifest and view model', () => {
  assert.deepEqual(validateUiPluginManifest(validManifest), { ok: true, manifest: validManifest });
  assert.deepEqual(
    validateUiViewModel({ type: 'object', required: ['open'] }, { open: true }),
    { ok: true },
  );
});

test('rejects duplicate surfaces and invalid route', () => {
  assert.equal(
    validateUiPluginManifest({
      ...validManifest,
      contributes: [...validManifest.contributes, validManifest.contributes[0]],
    }).ok,
    false,
  );
  assert.equal(
    validateUiPluginManifest({
      ...validManifest,
      contributes: [{ ...validManifest.contributes[0], route: 'drawer' }],
    }).ok,
    false,
  );
});

test('rejects missing required properties and wrong types', () => {
  assert.deepEqual(
    validateUiViewModel({ type: 'object', required: ['count'] }, {}),
    { ok: false, reason: 'missing required property: count' },
  );
  assert.deepEqual(validateUiViewModel({ type: 'integer' }, 1.5), { ok: false, reason: 'expected integer' });
});
