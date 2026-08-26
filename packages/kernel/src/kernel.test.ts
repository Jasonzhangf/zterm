import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CapabilityRegistry,
  CompositionRoot,
  ControlCenter,
  ObservabilityHub,
  PluginLifecycle,
  ProjectionRegistry,
  KernelContractError,
  createKernel,
} from './index.ts';

test('composes declared services and disposes them in reverse order', async () => {
  const calls: string[] = [];
  const root = new CompositionRoot();
  root.bind('first', { dispose: () => calls.push('first') });
  root.bind('second', { dispose: () => calls.push('second') });
  root.require(['first', 'second']);
  assert.equal(root.resolve<object>('first').constructor, Object);

  await root.dispose();
  assert.deepEqual(calls, ['second', 'first']);
  await assert.rejects(() => root.dispose(), KernelContractError);
});

test('rejects missing and duplicate composition bindings', () => {
  const root = new CompositionRoot();
  assert.throws(() => root.require(['missing']), KernelContractError);
  root.bind('service', {});
  assert.throws(() => root.bind('service', {}), KernelContractError);
});

test('registers unique capabilities and enforces explicit authorization', () => {
  const registry = new CapabilityRegistry();
  registry.register('sessions', { open: () => 'ok' });
  assert.deepEqual(registry.resolve<{ open(): string }>('sessions').open(), 'ok');
  assert.throws(() => registry.register('sessions', {}), KernelContractError);
  assert.throws(() => registry.resolve('missing'), KernelContractError);
  assert.throws(() => registry.require(['sessions', 'missing']), KernelContractError);
  assert.equal(registry.authorize(['sessions'], 'sessions'), true);
  assert.equal(registry.authorize([], 'sessions'), false);
});

test('runs plugin lifecycle and cleans a failed start without hiding the error', async () => {
  const calls: string[] = [];
  const lifecycle = new PluginLifecycle();
  lifecycle.install({
    pluginId: 'good',
    start: () => { calls.push('good:start'); },
    stop: () => { calls.push('good:stop'); },
    dispose: () => { calls.push('good:dispose'); },
  });
  lifecycle.install({
    pluginId: 'bad',
    start: () => {
      calls.push('bad:start');
      throw new Error('start failed');
    },
    stop: () => { calls.push('bad:stop'); },
    dispose: () => { calls.push('bad:dispose'); },
  });

  await lifecycle.start('good');
  await assert.rejects(() => lifecycle.start('bad'), /start failed/);
  assert.equal(lifecycle.state('bad'), 'installed');
  await lifecycle.disposeAll('test');
  assert.deepEqual(calls, ['good:start', 'bad:start', 'bad:dispose', 'good:stop', 'good:dispose']);
});

test('rejects illegal plugin transitions and repeated installation', async () => {
  const lifecycle = new PluginLifecycle();
  const plugin = { pluginId: 'plugin', start: () => {}, stop: () => {}, dispose: () => {} };
  lifecycle.install(plugin);
  assert.throws(() => lifecycle.install(plugin), KernelContractError);
  await assert.rejects(() => lifecycle.stop('plugin', 'before start'), KernelContractError);
  await lifecycle.start('plugin');
  await lifecycle.stop('plugin', 'done');
  await assert.rejects(() => lifecycle.start('plugin'), KernelContractError);
  await lifecycle.dispose('plugin', 'done');
  await assert.rejects(() => lifecycle.dispose('plugin', 'again'), KernelContractError);
});

test('disposes a running plugin even when stop reports an error', async () => {
  const calls: string[] = [];
  const lifecycle = new PluginLifecycle();
  lifecycle.install({
    pluginId: 'stop-fails',
    start: () => {},
    stop: () => {
      calls.push('stop');
      throw new Error('stop failed');
    },
    dispose: () => {
      calls.push('dispose');
    },
  });
  await lifecycle.start('stop-fails');
  await assert.rejects(() => lifecycle.dispose('stop-fails', 'shutdown'), /stop failed/);
  assert.deepEqual(calls, ['stop', 'dispose']);
  assert.equal(lifecycle.state('stop-fails'), 'disposed');
});

test('executes authorized controls once and preserves the first idempotent outcome', async () => {
  let executions = 0;
  const center = new ControlCenter({ now: () => 1 });
  center.register('open', 'sessions', async () => {
    executions += 1;
    return { opened: true };
  });
  const request = {
    commandId: 'command-1',
    correlationId: 'correlation-1',
    commandType: 'open',
    subject: 'session-1',
    capabilities: ['sessions'],
    idempotencyKey: 'open-1',
    params: { sessionId: 's1' },
  } as const;
  assert.deepEqual(await center.execute(request), { ok: true, value: { opened: true } });
  assert.deepEqual(await center.execute({ ...request, capabilities: ['sessions'] }), {
    ok: true,
    value: { opened: true },
  });
  assert.equal(executions, 1);
});

test('rejects unauthorized, unknown, invalid, and expired controls explicitly', async () => {
  const center = new ControlCenter({ now: () => 100, defaultDeadlineMs: 1 });
  center.register('open', 'sessions', async () => true);
  assert.deepEqual(await center.execute({
    commandId: 'c1',
    correlationId: 'corr',
    commandType: 'open',
    subject: 's1',
    capabilities: [],
  }), { ok: false, error: { code: 'capability_denied', message: 'capability denied: open', retryable: false } });
  assert.deepEqual(await center.execute({
    commandId: 'c2',
    correlationId: 'corr',
    commandType: 'unknown',
    subject: 's1',
    capabilities: ['sessions'],
  }), { ok: false, error: { code: 'unknown_command', message: 'unknown command: unknown', retryable: false } });
  assert.deepEqual(await center.execute({
    commandId: '',
    correlationId: 'corr',
    commandType: 'open',
    subject: 's1',
    capabilities: ['sessions'],
  }), { ok: false, error: { code: 'invalid_command', message: 'command fields and subject are required', retryable: false } });

  const expired = new ControlCenter({ now: () => 100 });
  expired.register('slow', undefined, async () => new Promise(() => {}));
  const result = await expired.execute({
    commandId: 'c3',
    correlationId: 'corr',
    commandType: 'slow',
    subject: 's1',
    capabilities: [],
    deadlineMs: 1,
  });
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'deadline_exceeded',
      message: 'control deadline exceeded: slow',
      retryable: false,
      deadlineMs: 1,
    },
  });
});

test('does not cache a timed-out control as an idempotent success', async () => {
  let executions = 0;
  const center = new ControlCenter({ now: () => 100 });
  center.register('slow', undefined, async () => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 'done';
  });
  const request = {
    commandId: 'command-1',
    correlationId: 'correlation-1',
    commandType: 'slow',
    subject: 'session-1',
    capabilities: [],
    idempotencyKey: 'slow-1',
    deadlineMs: 1,
  } as const;

  const first = await center.execute(request);
  assert.deepEqual(first, {
    ok: false,
    error: {
      code: 'deadline_exceeded',
      message: 'control deadline exceeded: slow',
      retryable: false,
      deadlineMs: 1,
    },
  });

  const second = await center.execute({ ...request, deadlineMs: 100 });
  assert.deepEqual(second, { ok: true, value: 'done' });
  assert.equal(executions, 2);
});

test('projects immutable snapshots and rejects stale revisions', () => {
  const projections = new ProjectionRegistry<{ status: string }>();
  assert.deepEqual(projections.commit(1, { status: 'ready' }), { revision: 1, value: { status: 'ready' } });
  assert.deepEqual(projections.read(), { revision: 1, value: { status: 'ready' } });
  assert.deepEqual(projections.commit(2, { status: 'connected' }), { revision: 2, value: { status: 'connected' } });
  assert.throws(() => projections.commit(1, { status: 'stale' }), KernelContractError);
  const snapshot = projections.read()!;
  assert.throws(() => (snapshot.value as { status: string }).status = 'mutated', TypeError);
});

test('bounds observability records and never accepts a business payload', () => {
  const hub = new ObservabilityHub(2);
  hub.record({ kind: 'start', at: 1, metadata: { scope: 'kernel' } });
  hub.record({ kind: 'ready', at: 2, metadata: {} });
  hub.record({ kind: 'stop', at: 3, metadata: {} });
  assert.deepEqual(hub.read(), [
    { kind: 'ready', at: 2, metadata: {} },
    { kind: 'stop', at: 3, metadata: {} },
  ]);
  assert.equal(hub.droppedCount(), 1);
  assert.throws(() => hub.record({
    kind: 'bad',
    at: 4,
    metadata: { payload: { business: true } },
  }), KernelContractError);
});

test('creates a kernel with independent control, capability, projection, and observability owners', () => {
  const kernel = createKernel();
  assert.ok(kernel.capabilities instanceof CapabilityRegistry);
  assert.ok(kernel.control instanceof ControlCenter);
  assert.ok(kernel.projections instanceof ProjectionRegistry);
  assert.ok(kernel.observability instanceof ObservabilityHub);
  assert.ok(kernel.plugins instanceof PluginLifecycle);
});
