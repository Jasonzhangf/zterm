import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ERROR_CODES,
  createOrganizationService,
  createOrganizationStore,
  isTypedError,
} from '../../organization/src/public/index.mjs';
import {
  MEMBER_ERROR_CODES,
  createBindingStore,
  createMembersService,
  resolveBindingTarget,
} from '../src/public/index.mjs';
import { createTrustedAuthDouble } from './support/trusted-auth-double.mjs';

const TOKENS = {
  owner: 'owner-token',
  reader: 'reader-token',
  noScope: 'no-scope-token',
  otherWorkspace: 'other-workspace-token',
};

// Members-local trusted auth double; see support/trusted-auth-double.mjs. It is
// not a production account store.
const auth = createTrustedAuthDouble({
  accounts: {
    [TOKENS.owner]: { accountId: 'acct-owner', scopes: ['org:write', 'members:read', 'members:write'], workspaces: '*' },
    [TOKENS.reader]: { accountId: 'acct-reader', scopes: ['members:read'], workspaces: '*' },
    [TOKENS.noScope]: { accountId: 'acct-noscope', scopes: ['other:read'], workspaces: '*' },
    [TOKENS.otherWorkspace]: { accountId: 'acct-other', scopes: ['members:read', 'members:write'], workspaces: ['ws-unrelated'] },
  },
});

async function tempFile(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return join(dir, 'data.json');
}

function isCode(error, code) {
  return isTypedError(error) && error.code === code;
}

function hostProbeDouble(overrides = {}) {
  // In-process TEST DOUBLE for the host probe port. The real consumer is
  // createTmuxSessionProbe in tests/support; the real-tmux receipt is recorded
  // separately.
  return Object.freeze({
    async probe() {
      return {
        available: true,
        machineId: 'mac-1',
        sessionId: '$0',
        anchor: '%0',
        anchorPresent: true,
        observedAt: new Date().toISOString(),
        ...overrides,
      };
    },
  });
}

async function fixture({ hostProbe = hostProbeDouble() } = {}) {
  const orgFile = await tempFile('zterm-members-org-');
  const bindFile = await tempFile('zterm-members-binding-');
  const organization = createOrganizationService({ store: createOrganizationStore(orgFile), auth });
  const members = createMembersService({ store: createBindingStore(bindFile), auth, organization, hostProbe });

  const workspace = await organization.createWorkspace({ token: TOKENS.owner, name: 'Acme' });
  const first = await organization.addMember({
    token: TOKENS.owner,
    workspaceId: workspace.workspaceId,
    groupId: workspace.rootGroupId,
    name: 'Worker',
    expectedRevision: workspace.revision,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-default',
  });
  const second = await organization.addMember({
    token: TOKENS.owner,
    workspaceId: workspace.workspaceId,
    groupId: workspace.rootGroupId,
    name: 'Agent',
    expectedRevision: first.revision,
    machineId: 'mac-2',
    hostKind: 'dsh',
    agentKind: 'claude',
    launchProfileRef: 'lp-default',
  });
  return { bindFile, workspace, organization, members, first, second };
}

async function readStore(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, bindings: {}, runtimeConfigs: {}, generations: {} };
    throw error;
  }
}

test('runtime config is owned by members, keyed by memberId, and survives reopen', async () => {
  const { bindFile, organization, members, first, second } = await fixture();

  const configured = await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  assert.deepEqual(configured, {
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });

  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: second.memberId,
    machineId: 'mac-2',
    hostKind: 'dsh',
    agentKind: 'claude',
    launchProfileRef: 'lp-b',
  });

  assert.equal((await members.queryRuntime({ token: TOKENS.owner, memberId: first.memberId })).launchProfileRef, 'lp-a');
  assert.equal((await members.queryRuntime({ token: TOKENS.owner, memberId: second.memberId })).machineId, 'mac-2');

  const reopened = createMembersService({ store: createBindingStore(bindFile), auth, organization, hostProbe: hostProbeDouble() });
  assert.equal((await reopened.queryRuntime({ token: TOKENS.owner, memberId: first.memberId })).agentKind, 'codex');

  const stored = await readStore(bindFile);
  assert.equal(stored.runtimeConfigs[first.memberId].machineId, 'mac-1');
  assert.equal(stored.runtimeConfigs[second.memberId].machineId, 'mac-2');
});

test('bindings are independent per member and CAS update advances generation', async () => {
  const { members, first, second } = await fixture();
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: second.memberId,
    machineId: 'mac-2',
    hostKind: 'dsh',
    agentKind: 'claude',
    launchProfileRef: 'lp-b',
  });

  const boundFirst = await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a',
    anchor: 'pane:0',
    expectedGeneration: 0,
  });
  assert.equal(boundFirst.generation, 1);
  assert.equal(boundFirst.sessionId, 'sess-a');

  const boundSecond = await members.bindSession({
    token: TOKENS.owner,
    memberId: second.memberId,
    sessionId: 'sess-b',
    anchor: 'pane:1',
    expectedGeneration: 0,
  });
  assert.equal(boundSecond.generation, 1);

  const updatedFirst = await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a2',
    anchor: 'pane:2',
    expectedGeneration: 1,
  });
  assert.equal(updatedFirst.generation, 2);
  assert.equal((await members.queryBinding({ token: TOKENS.owner, memberId: first.memberId })).sessionId, 'sess-a2');
  assert.equal((await members.queryBinding({ token: TOKENS.owner, memberId: second.memberId })).generation, 1);
});

test('stale expected generation is rejected with BINDING_GENERATION_STALE', async () => {
  const { members, first } = await fixture();
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a',
    anchor: 'pane:0',
    expectedGeneration: 0,
  });

  await assert.rejects(
    () => members.bindSession({
      token: TOKENS.owner,
      memberId: first.memberId,
      sessionId: 'sess-a2',
      anchor: 'pane:1',
      expectedGeneration: 0,
    }),
    (error) => isCode(error, ERROR_CODES.BINDING_GENERATION_STALE),
  );
});

test('binding and runtime persist across a reopened store instance', async () => {
  const { bindFile, organization, members, first } = await fixture();
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  const bound = await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a',
    anchor: 'pane:0',
    expectedGeneration: 0,
  });

  const reopened = createMembersService({ store: createBindingStore(bindFile), auth, organization, hostProbe: hostProbeDouble() });
  const queried = await reopened.queryBinding({ token: TOKENS.owner, memberId: first.memberId });
  assert.deepEqual(queried, bound);
  assert.equal((await reopened.queryRuntime({ token: TOKENS.owner, memberId: first.memberId })).machineId, 'mac-1');
});

test('missing or wrong token is rejected before any members store write', async () => {
  const { bindFile, members, first } = await fixture();

  await assert.rejects(
    () => members.configureRuntime({
      token: undefined,
      memberId: first.memberId,
      machineId: 'mac-1',
      hostKind: 'tmux',
      agentKind: 'codex',
      launchProfileRef: 'lp-a',
    }),
    (error) => isCode(error, ERROR_CODES.UNAUTHENTICATED),
  );
  await assert.rejects(
    () => members.bindSession({
      token: 'wrong-token',
      memberId: first.memberId,
      sessionId: 'sess-a',
      anchor: 'pane:0',
      expectedGeneration: 0,
    }),
    (error) => isCode(error, ERROR_CODES.UNAUTHENTICATED),
  );

  const stored = await readStore(bindFile);
  assert.equal(stored.runtimeConfigs[first.memberId], undefined);
  assert.equal(stored.bindings[first.memberId], undefined);
});

test('missing scope is rejected with MEMBER_FORBIDDEN_SCOPE and no side effect', async () => {
  const { bindFile, members, first } = await fixture();

  await assert.rejects(
    () => members.configureRuntime({
      token: TOKENS.reader,
      memberId: first.memberId,
      machineId: 'mac-1',
      hostKind: 'tmux',
      agentKind: 'codex',
      launchProfileRef: 'lp-a',
    }),
    (error) => isCode(error, MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_SCOPE),
  );
  await assert.rejects(
    () => members.bindSession({
      token: TOKENS.noScope,
      memberId: first.memberId,
      sessionId: 'sess-a',
      anchor: 'pane:0',
      expectedGeneration: 0,
    }),
    (error) => isCode(error, MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_SCOPE),
  );

  const stored = await readStore(bindFile);
  assert.equal(stored.runtimeConfigs[first.memberId], undefined);
  assert.equal(stored.bindings[first.memberId], undefined);
});

test('cross workspace and cross account targets are rejected with no side effect', async () => {
  const { bindFile, members, first } = await fixture();
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a',
    anchor: 'pane:0',
    expectedGeneration: 0,
  });

  await assert.rejects(
    () => members.queryRuntime({ token: TOKENS.otherWorkspace, memberId: first.memberId }),
    (error) => isCode(error, MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_WORKSPACE),
  );
  await assert.rejects(
    () => members.bindSession({
      token: TOKENS.otherWorkspace,
      memberId: first.memberId,
      sessionId: 'sess-b',
      anchor: 'pane:1',
      expectedGeneration: 1,
    }),
    (error) => isCode(error, MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_WORKSPACE),
  );

  const stored = await readStore(bindFile);
  assert.equal(stored.bindings[first.memberId].generation, 1);
  assert.equal(stored.bindings[first.memberId].sessionId, 'sess-a');
});

test('verifyHost confirms the host machine identity and rejects mismatch', async () => {
  const ok = await fixture();
  await ok.members.configureRuntime({
    token: TOKENS.owner,
    memberId: ok.first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  await ok.members.bindSession({
    token: TOKENS.owner,
    memberId: ok.first.memberId,
    sessionId: '$0',
    anchor: '%0',
    expectedGeneration: 0,
  });

  const verified = await ok.members.verifyHost({ token: TOKENS.owner, memberId: ok.first.memberId });
  assert.equal(verified.verified, true);
  assert.equal(verified.machineId, 'mac-1');
  assert.equal(verified.generation, 1);

  const mismatch = await fixture({ hostProbe: hostProbeDouble({ machineId: 'mac-2' }) });
  await mismatch.members.configureRuntime({
    token: TOKENS.owner,
    memberId: mismatch.first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  await mismatch.members.bindSession({
    token: TOKENS.owner,
    memberId: mismatch.first.memberId,
    sessionId: '$0',
    anchor: '%0',
    expectedGeneration: 0,
  });
  await assert.rejects(
    () => mismatch.members.verifyHost({ token: TOKENS.owner, memberId: mismatch.first.memberId }),
    (error) => isCode(error, MEMBER_ERROR_CODES.BINDING_HOST_MISMATCH),
  );
});

test('restoreBinding re-verifies the host and returns typed BINDING_HOST_UNAVAILABLE', async () => {
  const ok = await fixture();
  await ok.members.configureRuntime({
    token: TOKENS.owner,
    memberId: ok.first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  await ok.members.bindSession({
    token: TOKENS.owner,
    memberId: ok.first.memberId,
    sessionId: '$0',
    anchor: '%0',
    expectedGeneration: 0,
  });
  const restored = await ok.members.restoreBinding({ token: TOKENS.owner, memberId: ok.first.memberId });
  assert.equal(restored.restored, true);
  assert.equal(restored.sessionId, '$0');

  const down = await fixture({ hostProbe: hostProbeDouble({ available: false }) });
  await down.members.configureRuntime({
    token: TOKENS.owner,
    memberId: down.first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  await down.members.bindSession({
    token: TOKENS.owner,
    memberId: down.first.memberId,
    sessionId: '$0',
    anchor: '%0',
    expectedGeneration: 0,
  });

  await assert.rejects(
    () => down.members.verifyHost({ token: TOKENS.owner, memberId: down.first.memberId }),
    (error) => isCode(error, MEMBER_ERROR_CODES.BINDING_HOST_UNAVAILABLE) && error.retryDisposition === 'retryable',
  );
  await assert.rejects(
    () => down.members.restoreBinding({ token: TOKENS.owner, memberId: down.first.memberId }),
    (error) => isCode(error, MEMBER_ERROR_CODES.BINDING_HOST_UNAVAILABLE) && error.retryDisposition === 'retryable',
  );
});

test('verifyHost and restoreBinding reject missing authoritative machine identity', async () => {
  const { members, first } = await fixture({ hostProbe: hostProbeDouble({ machineId: null }) });
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: '$0',
    anchor: '%0',
    expectedGeneration: 0,
  });

  await assert.rejects(
    () => members.verifyHost({ token: TOKENS.owner, memberId: first.memberId }),
    (error) => isCode(error, MEMBER_ERROR_CODES.BINDING_HOST_IDENTITY_UNAVAILABLE),
  );
  await assert.rejects(
    () => members.restoreBinding({ token: TOKENS.owner, memberId: first.memberId }),
    (error) => isCode(error, MEMBER_ERROR_CODES.BINDING_HOST_IDENTITY_UNAVAILABLE),
  );
});

test('bindSession requires a runtime configuration before writing a binding', async () => {
  const { members, first } = await fixture();
  await assert.rejects(
    () => members.bindSession({
      token: TOKENS.owner,
      memberId: first.memberId,
      sessionId: 'sess-a',
      anchor: 'pane:0',
      expectedGeneration: 0,
    }),
    (error) => isCode(error, MEMBER_ERROR_CODES.MEMBER_RUNTIME_NOT_CONFIGURED),
  );
});

test('configureRuntime to a different machine invalidates the old binding atomically', async () => {
  const { bindFile, members, first } = await fixture();
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  const bound = await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a',
    anchor: 'pane:0',
    expectedGeneration: 0,
  });
  assert.equal(bound.generation, 1);
  assert.equal(bound.machineId, 'mac-1');

  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-2',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  const state = await readStore(bindFile);
  assert.equal(state.runtimeConfigs[first.memberId].machineId, 'mac-2');
  assert.equal(state.bindings[first.memberId], undefined);
});

test('getRuntimeBinding returns machineId and bindingGeneration for the same generation', async () => {
  const { members, first } = await fixture();
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a',
    anchor: 'pane:0',
    expectedGeneration: 0,
  });
  const reader = await members.getRuntimeBinding(first.memberId);
  assert.equal(reader.machineId, 'mac-1');
  assert.equal(reader.bindingGeneration, 1);
  assert.equal(reader.sessionId, 'sess-a');
  assert.equal(reader.hostKind, 'tmux');
});

test('getRuntimeBinding rejects missing runtime configuration', async () => {
  const { members, first } = await fixture();
  await assert.rejects(
    () => members.getRuntimeBinding(first.memberId),
    (error) => isCode(error, MEMBER_ERROR_CODES.MEMBER_RUNTIME_NOT_CONFIGURED),
  );
});

test('getRuntimeBinding rejects an invalid binding with a typed error', async () => {
  const { bindFile, members, first } = await fixture();
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  const bound = await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a',
    anchor: 'pane:0',
    expectedGeneration: 0,
  });
  assert.equal(bound.generation, 1);
  const state = JSON.parse(await readFile(bindFile, 'utf8'));
  state.bindings[first.memberId].machineId = 'mac-9';
  await writeFile(bindFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await assert.rejects(
    () => members.getRuntimeBinding(first.memberId),
    (error) => isCode(error, MEMBER_ERROR_CODES.MEMBER_BINDING_INVALID),
  );
});

test('bindSession persists terminalTarget, rebind replaces it, and omission clears it', async () => {
  const { members, first } = await fixture();
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });

  const bound = await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a',
    anchor: 'pane:0',
    expectedGeneration: 0,
    terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:aa' },
  });
  assert.equal(bound.generation, 1);
  assert.deepEqual(bound.terminalTarget, { backend: 'tmux', stableId: 'tmux:v1:aa' });
  assert.deepEqual(
    (await members.queryBinding({ token: TOKENS.owner, memberId: first.memberId })).terminalTarget,
    { backend: 'tmux', stableId: 'tmux:v1:aa' },
  );
  assert.deepEqual((await members.getRuntimeBinding(first.memberId)).terminalTarget, {
    backend: 'tmux',
    stableId: 'tmux:v1:aa',
  });

  const rebound = await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a2',
    anchor: 'pane:1',
    expectedGeneration: 1,
    terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:bb' },
  });
  assert.equal(rebound.generation, 2);
  assert.deepEqual(rebound.terminalTarget, { backend: 'tmux', stableId: 'tmux:v1:bb' });

  const cleared = await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a3',
    anchor: 'pane:2',
    expectedGeneration: 2,
  });
  assert.equal(cleared.generation, 3);
  assert.equal(cleared.terminalTarget, null);
  assert.equal(
    (await members.queryBinding({ token: TOKENS.owner, memberId: first.memberId })).terminalTarget,
    null,
  );
  assert.equal((await members.getRuntimeBinding(first.memberId)).terminalTarget, null);
});

test('bindSession rejects a malformed terminalTarget before writing a binding', async () => {
  const { members, first } = await fixture();
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a',
    anchor: 'pane:0',
    expectedGeneration: 0,
    terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:aa' },
  });

  await assert.rejects(
    () => members.bindSession({
      token: TOKENS.owner,
      memberId: first.memberId,
      sessionId: 'sess-a2',
      anchor: 'pane:1',
      expectedGeneration: 1,
      terminalTarget: { backend: 'tmux' },
    }),
    (error) => isCode(error, ERROR_CODES.VALIDATION),
  );
  await assert.rejects(
    () => members.bindSession({
      token: TOKENS.owner,
      memberId: first.memberId,
      sessionId: 'sess-a2',
      anchor: 'pane:1',
      expectedGeneration: 1,
      terminalTarget: 'tmux:v1:aa',
    }),
    (error) => isCode(error, ERROR_CODES.VALIDATION),
  );
  // A refused bind is not a rebind: the recorded binding and generation stay.
  const binding = await members.queryBinding({ token: TOKENS.owner, memberId: first.memberId });
  assert.equal(binding.generation, 1);
  assert.deepEqual(binding.terminalTarget, { backend: 'tmux', stableId: 'tmux:v1:aa' });
});

test('resolveBindingTarget returns a copy only on an exact catalog match', () => {
  const binding = {
    memberId: 'mbr-1',
    machineId: 'mac-1',
    bindingGeneration: 2,
    sessionId: 'sess-a',
    anchor: 'pane:0',
    terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:aa' },
  };
  const catalog = [
    { name: 'alpha', backend: 'tmux', stableId: 'tmux:v1:aa' },
    { name: 'beta', backend: 'tmux', stableId: 'tmux:v1:bb' },
  ];
  const resolved = resolveBindingTarget({ binding, catalog });
  assert.deepEqual(resolved, { backend: 'tmux', stableId: 'tmux:v1:aa' });
  // The adapter returns a copy, never the stored binding target or a catalog entry.
  assert.notEqual(resolved, binding.terminalTarget);
  assert.notEqual(resolved, catalog[0]);
  resolved.backend = 'tampered';
  assert.equal(catalog[0].backend, 'tmux');
  assert.equal(binding.terminalTarget.backend, 'tmux');
  // Catalog and binding stay read-only.
  assert.deepEqual(catalog[0], { name: 'alpha', backend: 'tmux', stableId: 'tmux:v1:aa' });

  assert.equal(resolveBindingTarget({
    binding,
    catalog: [{ name: 'beta', backend: 'tmux', stableId: 'tmux:v1:bb' }],
  }), null);
  assert.equal(resolveBindingTarget({ binding, catalog: [] }), null);
  assert.equal(resolveBindingTarget({
    binding: { ...binding, terminalTarget: null },
    catalog,
  }), null);
  assert.equal(resolveBindingTarget({ binding: {}, catalog }), null);
  // Two live entries for the same identity are unresolved, not a pick-one guess.
  assert.equal(resolveBindingTarget({
    binding,
    catalog: [
      { name: 'alpha', backend: 'tmux', stableId: 'tmux:v1:aa' },
      { name: 'alpha-copy', backend: 'tmux', stableId: 'tmux:v1:aa' },
    ],
  }), null);
  assert.throws(() => resolveBindingTarget({ binding, catalog: 'tmux' }), TypeError);
});


test('binding generation stays monotonic across invalidation and never reissues an old tuple', async () => {
  const { bindFile, organization, members, first } = await fixture();
  const config = {
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  };
  await members.configureRuntime(config);
  const firstBinding = await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a',
    anchor: 'pane:a',
    expectedGeneration: 0,
  });
  assert.equal(firstBinding.generation, 1);

  await members.configureRuntime({ ...config, machineId: 'mac-2' });
  assert.equal(await members.queryBinding({ token: TOKENS.owner, memberId: first.memberId }), null);

  const rebindB = await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-b',
    anchor: 'pane:b',
    expectedGeneration: 1,
  });
  assert.equal(rebindB.generation, 2);
  assert.equal(rebindB.machineId, 'mac-2');

  await members.configureRuntime(config);
  assert.equal(await members.queryBinding({ token: TOKENS.owner, memberId: first.memberId }), null);
  await assert.rejects(
    () => members.bindSession({
      token: TOKENS.owner,
      memberId: first.memberId,
      sessionId: 'sess-a2',
      anchor: 'pane:a2',
      expectedGeneration: 1,
    }),
    (error) => isCode(error, ERROR_CODES.BINDING_GENERATION_STALE),
  );

  const rebindA = await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a3',
    anchor: 'pane:a3',
    expectedGeneration: 2,
  });
  assert.equal(rebindA.generation, 3);
  assert.equal(rebindA.machineId, 'mac-1');

  const reopened = createMembersService({
    store: createBindingStore(bindFile),
    auth,
    organization,
    hostProbe: hostProbeDouble(),
  });
  assert.equal((await reopened.queryBinding({ token: TOKENS.owner, memberId: first.memberId })).generation, 3);
  const stored = await readStore(bindFile);
  assert.equal(stored.generations[first.memberId], 3);
});

test('configureRuntime invalidates the binding when hostKind, agentKind, or launchProfileRef changes', async () => {
  const { members, first } = await fixture();
  let config = {
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  };
  await members.configureRuntime(config);
  await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-1',
    anchor: 'pane:1',
    expectedGeneration: 0,
  });
  // Re-asserting the same identity keeps the current binding valid.
  await members.configureRuntime(config);
  assert.equal((await members.queryBinding({ token: TOKENS.owner, memberId: first.memberId })).generation, 1);

  let expected = 1;
  for (const change of [{ hostKind: 'dsh' }, { agentKind: 'claude' }, { launchProfileRef: 'lp-b' }]) {
    config = { ...config, ...change };
    await members.configureRuntime(config);
    assert.equal(await members.queryBinding({ token: TOKENS.owner, memberId: first.memberId }), null);
    const rebound = await members.bindSession({
      token: TOKENS.owner,
      memberId: first.memberId,
      sessionId: `sess-${expected + 1}`,
      anchor: `pane:${expected + 1}`,
      expectedGeneration: expected,
    });
    assert.equal(rebound.generation, expected + 1);
    expected += 1;
  }
});

test('AuthContext.members allowlist gates every public action before store or probe side effects', async () => {
  const { bindFile, organization, members, first } = await fixture();
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'sess-a',
    anchor: 'pane:a',
    expectedGeneration: 0,
  });

  const narrowAuth = createTrustedAuthDouble({
    accounts: {
      granted: { accountId: 'acct-granted', scopes: ['members:read', 'members:write'], workspaces: '*', members: [first.memberId] },
      empty: { accountId: 'acct-empty', scopes: ['members:read', 'members:write'], workspaces: '*', members: [] },
      other: { accountId: 'acct-other', scopes: ['members:read', 'members:write'], workspaces: '*', members: ['someone-else'] },
      malformed: { accountId: 'acct-malformed', scopes: ['members:read', 'members:write'], workspaces: '*', members: 'not-an-array' },
      wildcard: { accountId: 'acct-wildcard', scopes: ['members:read', 'members:write'], workspaces: '*', members: '*' },
    },
  });
  const narrow = createMembersService({
    store: createBindingStore(bindFile),
    auth: narrowAuth,
    organization,
    hostProbe: hostProbeDouble(),
  });

  assert.equal((await narrow.queryRuntime({ token: 'granted', memberId: first.memberId })).machineId, 'mac-1');
  assert.equal((await narrow.queryBinding({ token: 'granted', memberId: first.memberId })).sessionId, 'sess-a');

  for (const token of ['empty', 'other', 'malformed', 'wildcard']) {
    await assert.rejects(
      () => narrow.queryRuntime({ token, memberId: first.memberId }),
      (error) => isCode(error, MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_MEMBER),
    );
    await assert.rejects(
      () => narrow.queryBinding({ token, memberId: first.memberId }),
      (error) => isCode(error, MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_MEMBER),
    );
    await assert.rejects(
      () => narrow.configureRuntime({
        token,
        memberId: first.memberId,
        machineId: 'mac-9',
        hostKind: 'tmux',
        agentKind: 'codex',
        launchProfileRef: 'lp-z',
      }),
      (error) => isCode(error, MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_MEMBER),
    );
    await assert.rejects(
      () => narrow.bindSession({
        token,
        memberId: first.memberId,
        sessionId: 'sess-z',
        anchor: 'pane:z',
        expectedGeneration: 1,
      }),
      (error) => isCode(error, MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_MEMBER),
    );
    await assert.rejects(
      () => narrow.verifyHost({ token, memberId: first.memberId }),
      (error) => isCode(error, MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_MEMBER),
    );
    await assert.rejects(
      () => narrow.restoreBinding({ token, memberId: first.memberId }),
      (error) => isCode(error, MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_MEMBER),
    );
  }

  const stored = await readStore(bindFile);
  assert.equal(stored.runtimeConfigs[first.memberId].launchProfileRef, 'lp-a');
  assert.equal(stored.bindings[first.memberId].sessionId, 'sess-a');
  assert.equal(stored.bindings[first.memberId].generation, 1);
});

test('legacy version-1 store backfills the binding generation before any rebind', async () => {
  const { bindFile, organization, first } = await fixture();
  const legacy = {
    version: 1,
    bindings: {
      [first.memberId]: {
        memberId: first.memberId,
        machineId: 'mac-1',
        sessionId: 'legacy-sess',
        anchor: 'legacy-pane',
        generation: 2,
      },
    },
    runtimeConfigs: {
      [first.memberId]: {
        memberId: first.memberId,
        machineId: 'mac-1',
        hostKind: 'tmux',
        agentKind: 'codex',
        launchProfileRef: 'lp-a',
      },
    },
  };
  await writeFile(bindFile, JSON.stringify(legacy, null, 2) + '\n', 'utf8');

  const reopened = createMembersService({
    store: createBindingStore(bindFile),
    auth,
    organization,
    hostProbe: hostProbeDouble(),
  });
  await assert.rejects(
    () => reopened.bindSession({
      token: TOKENS.owner,
      memberId: first.memberId,
      sessionId: 'reissue-from-zero',
      anchor: 'pane:0',
      expectedGeneration: 0,
    }),
    (error) => isCode(error, ERROR_CODES.BINDING_GENERATION_STALE),
  );

  await reopened.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: 'mac-2',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'lp-a',
  });
  assert.equal(await reopened.queryBinding({ token: TOKENS.owner, memberId: first.memberId }), null);

  const rebound = await reopened.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: 'new-sess',
    anchor: 'pane:new',
    expectedGeneration: 2,
  });
  assert.equal(rebound.generation, 3);

  const reopenedAgain = createMembersService({
    store: createBindingStore(bindFile),
    auth,
    organization,
    hostProbe: hostProbeDouble(),
  });
  assert.equal((await reopenedAgain.queryBinding({ token: TOKENS.owner, memberId: first.memberId })).generation, 3);
});
