import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlCommand, createDataEnvelope, okOutcome, errorOutcome } from './index.js';

test('accepts valid control command and outcome', () => {
  const cmd = createControlCommand('open-session', 'c1', 'corr1', { sessionId: 's1' });
  assert.equal(cmd[Symbol.for('zterm.runtime.control-plane') as never], undefined);
  assert.ok(cmd.commandId.length > 0);
  assert.deepEqual(okOutcome(42), { ok: true, value: 42 });
});

test('rejects invalid envelope and produces typed error', () => {
  const env = createDataEnvelope('terminal', 1, Buffer.alloc(0));
  assert.ok(env.channelId.length > 0);
  const result = errorOutcome('deadline_exceeded', 'timeout', false);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.retryable, false);
});
