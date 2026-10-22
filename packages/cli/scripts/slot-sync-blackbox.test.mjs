import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  fixtureBinding,
  assertNoForbiddenCloudFields,
} from './slot-sync-fixture-helper.mjs';
import {
  parseSlotSyncArgs,
} from './slot-sync-blackbox.mjs';
import {
  parseRollbackArgs,
} from '../../../android/scripts/relay-slot-config-rollback-blackbox.mjs';

test('slot sync parser accepts env and explicit tarballs', () => {
  const fromEnv = parseSlotSyncArgs(
    ['--evidence-dir', './evidence'],
    { CLI_TARBALL: './fixture.tgz' },
  );
  assert.equal(fromEnv.cliTarball, resolve('./fixture.tgz'));
  assert.equal(fromEnv.evidenceDir, resolve('./evidence'));

  const explicit = parseSlotSyncArgs(
    ['--cli-tarball', './explicit.tgz', '--evidence-dir', './explicit-evidence'],
    {},
  );
  assert.equal(explicit.cliTarball, resolve('./explicit.tgz'));
  assert.equal(explicit.evidenceDir, resolve('./explicit-evidence'));
  assert.throws(
    () => parseSlotSyncArgs(['--unknown'], {}),
    /unknown slot sync argument/u,
  );
});

test('rollback parser accepts the required previous runtime from env or arg', () => {
  const fromEnv = parseRollbackArgs(
    ['--evidence-dir', './rollback-evidence'],
    { ZTERM_PREVIOUS_RELAY_RUNTIME: './previous/runtime/server.cjs' },
  );
  assert.equal(
    fromEnv.previousRelayRuntime,
    resolve('./previous/runtime/server.cjs'),
  );
  assert.equal(fromEnv.evidenceDir, resolve('./rollback-evidence'));

  const explicit = parseRollbackArgs(
    [
      '--previous-relay-runtime',
      './explicit/server.cjs',
      '--evidence-dir',
      './explicit-rollback-evidence',
    ],
    {},
  );
  assert.equal(
    explicit.previousRelayRuntime,
    resolve('./explicit/server.cjs'),
  );
});

test('cloud payload audit rejects ownership, credentials, and endpoint URLs', () => {
  const binding = fixtureBinding({
    relayBaseUrl: 'http://127.0.0.1:1234/relay',
    userId: 'fixture-user',
    slotName: 'audit',
  });
  const cloudSlot = {
    slot: 1,
    server: binding.server,
    session: binding.session,
    widthMode: binding.widthMode,
  };
  assert.equal(
    assertNoForbiddenCloudFields({ configured: true, slots: [cloudSlot] }),
    true,
  );
  assert.throws(
    () => assertNoForbiddenCloudFields({
      configured: true,
      slots: [{ ...cloudSlot, account: binding.account }],
    }),
    /account is forbidden/u,
  );
  assert.throws(
    () => assertNoForbiddenCloudFields({
      configured: true,
      slots: [{ ...cloudSlot, endpoint: 'wss://secret.invalid' }],
    }),
    /endpoint is forbidden/u,
  );
  assert.throws(
    () => assertNoForbiddenCloudFields(
      { configured: true, slots: [{ ...cloudSlot, alias: 'token-value' }] },
      ['token-value'],
    ),
    /account secret/u,
  );
});
