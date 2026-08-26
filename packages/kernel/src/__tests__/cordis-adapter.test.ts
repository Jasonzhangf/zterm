import assert from 'node:assert/strict';
import test from 'node:test';
import { CordisAdapter, CORDIS_PACKAGE, CORDIS_VERSION } from '../cordis/index.ts';
import type { Context } from '@cordisjs/core';

test('pins Cordis and runs service/plugin lifecycle in process-local context', async () => {
  const adapter = new CordisAdapter({ name: 'test-kernel' });
  const events: string[] = [];
  const service = {
    dispose(reason: string) {
      events.push(`service-dispose:${reason}`);
    },
  };
  adapter.registerService('test-service', service);
  adapter.plugin((ctx: Context) => {
    ctx.on('ready', () => {
      events.push('ready');
    });
    ctx.on('dispose', () => {
      events.push('plugin-dispose');
    });
  });

  await adapter.start();
  assert.equal(adapter.state, 'started');
  assert.equal(adapter.context.get('test-service'), service);
  assert.equal(CORDIS_PACKAGE, '@cordisjs/core');
  assert.equal(CORDIS_VERSION, '3.18.1');
  assert.ok(events.includes('ready'));

  await adapter.stop();
  assert.equal(adapter.state, 'stopped');
  assert.ok(events.includes('plugin-dispose'));
  assert.equal(events.filter((event) => event.startsWith('service-dispose:')).length, 1);
  await adapter.stop();
});

test('rejects duplicate services and surfaces disposal errors', async () => {
  const adapter = new CordisAdapter();
  adapter.registerService('unique', {});
  assert.throws(
    () => adapter.registerService('unique', {}),
    (error: unknown) => (error as { code?: string }).code === 'DUPLICATE_SERVICE',
  );

  const failing = new CordisAdapter();
  failing.registerService('failing', {
    dispose() {
      throw new Error('cleanup failed');
    },
  });
  await assert.rejects(
    () => failing.stop(),
    (error: unknown) => (error as { code?: string }).code === 'DISPOSE_FAILED',
  );
  assert.equal(failing.state, 'stopped');
});

test('does not expose terminal data-plane registration or event APIs', () => {
  const adapter = new CordisAdapter();
  const publicApi = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter));
  assert.deepEqual(
    publicApi.filter((name) => /stream|terminal|buffer|chunk|frame|media/i.test(name)),
    [],
  );
  assert.equal('openDataStream' in adapter, false);
  assert.equal('send' in adapter, false);
});
