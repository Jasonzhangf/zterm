import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ERROR_CODES, TypedError, isTypedError } from '../../organization/src/public/typed-error.mjs';
import { createOrganizationService, createOrganizationStore } from '../../organization/src/public/index.mjs';
import {
  MEMBER_BINDING_INVALID,
  MEMBER_BINDING_NOT_FOUND,
  MEMBER_RUNTIME_NOT_CONFIGURED,
  ROUTE_FORBIDDEN,
  ROUTE_RESOLVE_ACTION,
  createRoutingDevAuth,
  createRoutingService,
} from '../src/public/index.mjs';

const SEED_TOKEN = 'seed-token';

function isCode(error, code) {
  return isTypedError(error) && error.code === code;
}

function bindingFor(memberId, machineId, {
  generation = 1,
  sessionId = 'sess',
  anchor = 'pane:0',
  hostKind = 'tmux',
  agentKind = 'codex',
  launchProfileRef = 'lp',
} = {}) {
  return { memberId, machineId, hostKind, agentKind, launchProfileRef, generation, sessionId, anchor };
}

// Minimal members runtime-binding port fixture: an in-memory Map of memberId ->
// runtime binding, or an explicit shared TypedError for that member. It is not
// the real members reader; the real getRuntimeBinding reader integration is
// deferred to Jenny's combined milestone after the members head lands.
function createBindingPort(entries = {}) {
  const bindings = new Map(Object.entries(entries));
  let calls = 0;
  const port = {
    async getRuntimeBinding(memberId) {
      calls += 1;
      const entry = bindings.get(memberId);
      if (!entry) {
        throw new TypedError(MEMBER_BINDING_NOT_FOUND, `runtime binding not configured for member ${memberId}`, {
          owningModule: 'members',
          details: { memberId },
        });
      }
      if (entry.failWith) {
        throw new TypedError(entry.failWith, entry.message ?? `runtime binding failure for member ${memberId}`, {
          owningModule: 'members',
          details: { memberId },
        });
      }
      return { ...entry };
    },
    set(memberId, entry) {
      bindings.set(memberId, entry);
    },
    failure(memberId, code, message) {
      bindings.set(memberId, { failWith: code, message });
    },
    calls() {
      return calls;
    },
  };
  return Object.freeze(port);
}

// Seeds organization truth only. Organization members locate group/name/memberId;
// the machineId for routing comes from the runtime-binding fixture instead.
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'zterm-routing-'));
  const orgFile = join(dir, 'organization.json');
  const seedAuth = createRoutingDevAuth({
    accounts: {
      [SEED_TOKEN]: { accountId: 'acct-seed', scopes: [ROUTE_RESOLVE_ACTION, 'org:write'], workspaces: '*' },
    },
  });
  const organization = createOrganizationService({ store: createOrganizationStore(orgFile), auth: seedAuth });

  async function addWorkspace(label, { memberName = 'Bot', machineId = 'mac-1' } = {}) {
    const workspace = await organization.createWorkspace({ token: SEED_TOKEN, name: 'Acme' });
    const team = await organization.createGroup({
      token: SEED_TOKEN,
      workspaceId: workspace.workspaceId,
      name: 'team',
      expectedRevision: workspace.revision,
    });
    const member = await organization.addMember({
      token: SEED_TOKEN,
      workspaceId: workspace.workspaceId,
      groupId: team.groupId,
      name: memberName,
      expectedRevision: team.revision,
      machineId,
      hostKind: 'tmux',
      agentKind: 'codex',
      launchProfileRef: `lp-${label}`,
    });
    return { workspace, team, member };
  }

  return { orgFile, organization, addWorkspace };
}

function routingWith(organization, port, accounts) {
  return createRoutingService({
    organization,
    members: port,
    auth: createRoutingDevAuth({ accounts }),
  });
}

function accountFor(workspaceId, extra = {}) {
  return {
    ...extra,
    scopes: extra.scopes ?? [ROUTE_RESOLVE_ACTION],
    workspaces: extra.workspaces ?? [workspaceId],
  };
}

test('unique address returns member, runtime binding machine id, generation, session and anchor', async () => {
  const h = await harness();
  const { workspace, team, member } = await h.addWorkspace('a');
  const port = createBindingPort({
    [member.memberId]: bindingFor(member.memberId, 'mac-1', {
      generation: 1,
      sessionId: 'sess-a',
      anchor: 'pane:0',
      launchProfileRef: 'lp-a',
    }),
  });
  const routing = routingWith(h.organization, port, {
    'a-token': { accountId: 'acct-a', ...accountFor(workspace.workspaceId) },
  });

  const first = await routing.resolve({
    token: 'a-token',
    workspaceId: workspace.workspaceId,
    address: {
      machineId: 'mac-1',
      groupPath: '/Acme/team',
      memberId: member.memberId,
      expectedGeneration: 1,
    },
  });
  assert.equal(first.memberId, member.memberId);
  assert.equal(first.machineId, 'mac-1');
  assert.equal(first.hostKind, 'tmux');
  assert.equal(first.agentKind, 'codex');
  assert.equal(first.launchProfileRef, 'lp-a');
  assert.equal(first.bindingGeneration, 1);
  assert.equal(first.sessionId, 'sess-a');
  assert.equal(first.anchor, 'pane:0');
  assert.equal(team.groupId, member.groupId);
});

test('unknown machine, group path, or member is rejected without a fuzzy fallback', async () => {
  const h = await harness();
  const { workspace, member } = await h.addWorkspace('a');
  const port = createBindingPort({ [member.memberId]: bindingFor(member.memberId, 'mac-1') });
  const routing = routingWith(h.organization, port, {
    'a-token': { accountId: 'acct-a', ...accountFor(workspace.workspaceId) },
  });

  await assert.rejects(
    () => routing.resolve({
      token: 'a-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/missing', memberName: 'Bot' },
    }),
    (error) => isCode(error, ERROR_CODES.ROUTE_NOT_FOUND),
  );
  await assert.rejects(
    () => routing.resolve({
      token: 'a-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team', memberName: 'Ghost' },
    }),
    (error) => isCode(error, ERROR_CODES.ROUTE_NOT_FOUND),
  );
  await assert.rejects(
    () => routing.resolve({
      token: 'a-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-9', groupPath: '/Acme/team', memberName: 'Bot' },
    }),
    (error) => isCode(error, ERROR_CODES.ROUTE_NOT_FOUND),
  );
  // memberId only matches a stable id, never a readable name.
  await assert.rejects(
    () => routing.resolve({
      token: 'a-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: 'Bot' },
    }),
    (error) => isCode(error, ERROR_CODES.ROUTE_NOT_FOUND),
  );
});

test('co-located distinct members are ambiguous without a selector and each selector disambiguates', async () => {
  const h = await harness();
  const { workspace, team, member } = await h.addWorkspace('a');
  const scout = await h.organization.addMember({
    token: SEED_TOKEN,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Scout',
    expectedRevision: member.revision,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'claude',
    launchProfileRef: 'lp-scout',
  });
  const port = createBindingPort({
    [member.memberId]: bindingFor(member.memberId, 'mac-1'),
    [scout.memberId]: bindingFor(scout.memberId, 'mac-1', { agentKind: 'claude', launchProfileRef: 'lp-scout' }),
  });
  const routing = routingWith(h.organization, port, {
    'a-token': { accountId: 'acct-a', ...accountFor(workspace.workspaceId) },
  });

  await assert.rejects(
    () => routing.resolve({
      token: 'a-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team' },
    }),
    (error) => isCode(error, ERROR_CODES.ROUTE_AMBIGUOUS) && error.details.matchCount === 2,
  );

  const byId = await routing.resolve({
    token: 'a-token',
    workspaceId: workspace.workspaceId,
    address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: member.memberId },
  });
  assert.equal(byId.memberId, member.memberId);

  const byName = await routing.resolve({
    token: 'a-token',
    workspaceId: workspace.workspaceId,
    address: { machineId: 'mac-1', groupPath: '/Acme/team', memberName: 'Scout' },
  });
  assert.equal(byName.memberId, scout.memberId);
});

test('memberName matches the readable name only', async () => {
  const h = await harness();
  const { workspace, member } = await h.addWorkspace('a');
  const port = createBindingPort({ [member.memberId]: bindingFor(member.memberId, 'mac-1') });
  const routing = routingWith(h.organization, port, {
    'a-token': { accountId: 'acct-a', ...accountFor(workspace.workspaceId) },
  });

  await assert.rejects(
    () => routing.resolve({
      token: 'a-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team', memberName: member.memberId },
    }),
    (error) => isCode(error, ERROR_CODES.ROUTE_NOT_FOUND),
  );

  const byName = await routing.resolve({
    token: 'a-token',
    workspaceId: workspace.workspaceId,
    address: { machineId: 'mac-1', groupPath: '/Acme/team', memberName: 'Bot' },
  });
  assert.equal(byName.memberId, member.memberId);
});

test('same group path and member name in another workspace stays isolated', async () => {
  const h = await harness();
  const a = await h.addWorkspace('a');
  const b = await h.addWorkspace('b');
  const port = createBindingPort({
    [a.member.memberId]: bindingFor(a.member.memberId, 'mac-1'),
    [b.member.memberId]: bindingFor(b.member.memberId, 'mac-1'),
  });
  const routing = routingWith(h.organization, port, {
    'a-token': { accountId: 'acct-a', ...accountFor(a.workspace.workspaceId) },
    'b-token': { accountId: 'acct-b', ...accountFor(b.workspace.workspaceId) },
  });

  const fromA = await routing.resolve({
    token: 'a-token',
    workspaceId: a.workspace.workspaceId,
    address: { machineId: 'mac-1', groupPath: '/Acme/team', memberName: 'Bot' },
  });
  const fromB = await routing.resolve({
    token: 'b-token',
    workspaceId: b.workspace.workspaceId,
    address: { machineId: 'mac-1', groupPath: '/Acme/team', memberName: 'Bot' },
  });
  assert.equal(fromA.memberId, a.member.memberId);
  assert.equal(fromB.memberId, b.member.memberId);
  assert.notEqual(fromA.memberId, fromB.memberId);

  await assert.rejects(
    () => routing.resolve({
      token: 'a-token',
      workspaceId: b.workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team', memberName: 'Bot' },
    }),
    (error) => isCode(error, ROUTE_FORBIDDEN),
  );
});

test('expectedGeneration mismatch is rejected with the current generation', async () => {
  const h = await harness();
  const { workspace, member } = await h.addWorkspace('a');
  const port = createBindingPort({ [member.memberId]: bindingFor(member.memberId, 'mac-1', { generation: 1 }) });
  const routing = routingWith(h.organization, port, {
    'a-token': { accountId: 'acct-a', ...accountFor(workspace.workspaceId) },
  });

  await assert.rejects(
    () => routing.resolve({
      token: 'a-token',
      workspaceId: workspace.workspaceId,
      address: {
        machineId: 'mac-1',
        groupPath: '/Acme/team',
        memberId: member.memberId,
        expectedGeneration: 0,
      },
    }),
    (error) => isCode(error, ERROR_CODES.BINDING_GENERATION_STALE)
      && error.details.expectedGeneration === 0
      && error.details.currentGeneration === 1,
  );

  const current = await routing.resolve({
    token: 'a-token',
    workspaceId: workspace.workspaceId,
    address: {
      machineId: 'mac-1',
      groupPath: '/Acme/team',
      memberId: member.memberId,
      expectedGeneration: 1,
    },
  });
  assert.equal(current.bindingGeneration, 1);

  await assert.rejects(
    () => routing.resolve({
      token: 'a-token',
      workspaceId: workspace.workspaceId,
      address: {
        machineId: 'mac-1',
        groupPath: '/Acme/team',
        memberId: member.memberId,
        expectedGeneration: '1',
      },
    }),
    (error) => isCode(error, ERROR_CODES.VALIDATION),
  );
});

test('wrong action scope is rejected before any read with no binding side effects', async () => {
  const h = await harness();
  const { workspace, member } = await h.addWorkspace('a');
  const port = createBindingPort({ [member.memberId]: bindingFor(member.memberId, 'mac-1') });
  const routing = routingWith(h.organization, port, {
    'wrong-scope': { accountId: 'acct-x', ...accountFor(workspace.workspaceId, { scopes: ['routing:other'] }) },
  });

  await assert.rejects(
    () => routing.resolve({
      token: 'wrong-scope',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: member.memberId },
    }),
    (error) => isCode(error, ROUTE_FORBIDDEN) && error.details.action === ROUTE_RESOLVE_ACTION,
  );
  // A caller-supplied action must not bypass the fixed resolve scope.
  await assert.rejects(
    () => routing.resolve({
      token: 'wrong-scope',
      workspaceId: workspace.workspaceId,
      action: 'routing:other',
      address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: member.memberId },
    }),
    (error) => isCode(error, ROUTE_FORBIDDEN) && error.details.action === ROUTE_RESOLVE_ACTION,
  );
  assert.equal(port.calls(), 0);

  const allowed = routingWith(h.organization, port, {
    'a-token': { accountId: 'acct-a', ...accountFor(workspace.workspaceId) },
  });
  const unchanged = await allowed.resolve({
    token: 'a-token',
    workspaceId: workspace.workspaceId,
    address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: member.memberId },
  });
  assert.equal(unchanged.bindingGeneration, 1);
});

test('cross-account workspace target is rejected before any read with no binding side effects', async () => {
  const h = await harness();
  const a = await h.addWorkspace('a');
  const b = await h.addWorkspace('b');
  const port = createBindingPort({
    [a.member.memberId]: bindingFor(a.member.memberId, 'mac-1'),
    [b.member.memberId]: bindingFor(b.member.memberId, 'mac-1'),
  });
  const routing = routingWith(h.organization, port, {
    'b-token': { accountId: 'acct-b', ...accountFor(b.workspace.workspaceId) },
  });

  let captured;
  try {
    await routing.resolve({
      token: 'b-token',
      workspaceId: a.workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: a.member.memberId },
    });
    assert.fail('cross-account resolve must be rejected');
  } catch (error) {
    captured = error;
  }
  assert.ok(isCode(captured, ROUTE_FORBIDDEN));
  assert.equal(captured.details.workspaceId, a.workspace.workspaceId);
  assert.equal(captured.details.memberId, undefined);
  assert.equal(port.calls(), 0);
});

test('member allowlist only accepts string[]: absent narrows nothing, empty rejects, wildcard rejects', async () => {
  const h = await harness();
  const { workspace, team, member } = await h.addWorkspace('a');
  const scout = await h.organization.addMember({
    token: SEED_TOKEN,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Scout',
    expectedRevision: member.revision,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'claude',
    launchProfileRef: 'lp-scout',
  });
  const port = createBindingPort({
    [member.memberId]: bindingFor(member.memberId, 'mac-1'),
    [scout.memberId]: bindingFor(scout.memberId, 'mac-1'),
  });

  // Explicit allowlist containing the target is allowed.
  const scoped = routingWith(h.organization, port, {
    'member-token': {
      accountId: 'acct-m',
      scopes: [ROUTE_RESOLVE_ACTION],
      workspaces: [workspace.workspaceId],
      members: [member.memberId],
    },
  });
  const allowed = await scoped.resolve({
    token: 'member-token',
    workspaceId: workspace.workspaceId,
    address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: member.memberId },
  });
  assert.equal(allowed.memberId, member.memberId);

  // A member outside the allowlist is rejected.
  await assert.rejects(
    () => scoped.resolve({
      token: 'member-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: scout.memberId },
    }),
    (error) => isCode(error, ROUTE_FORBIDDEN),
  );

  // Empty array is an explicit "no members" grant, not unlimited.
  const empty = routingWith(h.organization, port, {
    'empty-token': {
      accountId: 'acct-empty',
      scopes: [ROUTE_RESOLVE_ACTION],
      workspaces: [workspace.workspaceId],
      members: [],
    },
  });
  const callsBefore = port.calls();
  await assert.rejects(
    () => empty.resolve({
      token: 'empty-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: member.memberId },
    }),
    (error) => isCode(error, ROUTE_FORBIDDEN),
  );
  assert.equal(port.calls(), callsBefore, 'empty grant must reject before reading the runtime binding');

  // '*' is an undeclared grant expansion, not all-member authorization.
  const wildcard = routingWith(h.organization, port, {
    'wild-token': {
      accountId: 'acct-wild',
      scopes: [ROUTE_RESOLVE_ACTION],
      workspaces: [workspace.workspaceId],
      members: '*',
    },
  });
  await assert.rejects(
    () => wildcard.resolve({
      token: 'wild-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: member.memberId },
    }),
    (error) => isCode(error, ROUTE_FORBIDDEN),
  );

  // Absent members means no member-level narrowing inside the allowed workspace.
  const absent = routingWith(h.organization, port, {
    'none-token': { accountId: 'acct-none', ...accountFor(workspace.workspaceId) },
  });
  const unscoped = await absent.resolve({
    token: 'none-token',
    workspaceId: workspace.workspaceId,
    address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: scout.memberId },
  });
  assert.equal(unscoped.memberId, scout.memberId);
});

test('machineId and runtime config come from the runtime binding, not the organization member', async () => {
  const h = await harness();
  const { workspace, member } = await h.addWorkspace('a', { machineId: 'org-stale-machine' });
  const port = createBindingPort({
    [member.memberId]: bindingFor(member.memberId, 'mac-live', {
      hostKind: 'vm',
      agentKind: 'other',
      launchProfileRef: 'lp-live',
    }),
  });
  const routing = routingWith(h.organization, port, {
    'a-token': { accountId: 'acct-a', ...accountFor(workspace.workspaceId) },
  });

  const live = await routing.resolve({
    token: 'a-token',
    workspaceId: workspace.workspaceId,
    address: { machineId: 'mac-live', groupPath: '/Acme/team', memberId: member.memberId },
  });
  assert.equal(live.machineId, 'mac-live');
  // hostKind/agentKind/launchProfileRef come from the members runtime-binding
  // reader, never from the organization member's migrated runtime fields.
  assert.equal(live.hostKind, 'vm');
  assert.equal(live.agentKind, 'other');
  assert.equal(live.launchProfileRef, 'lp-live');

  await assert.rejects(
    () => routing.resolve({
      token: 'a-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'org-stale-machine', groupPath: '/Acme/team', memberId: member.memberId },
    }),
    (error) => isCode(error, ERROR_CODES.ROUTE_NOT_FOUND),
  );
});

test('directed selection propagates runtime binding typed failures', async () => {
  const h = await harness();
  const { workspace, member } = await h.addWorkspace('a');
  const port = createBindingPort();
  port.failure(member.memberId, MEMBER_BINDING_INVALID, 'binding payload is invalid');
  const routing = routingWith(h.organization, port, {
    'a-token': { accountId: 'acct-a', ...accountFor(workspace.workspaceId) },
  });

  await assert.rejects(
    () => routing.resolve({
      token: 'a-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: member.memberId },
    }),
    (error) => isCode(error, MEMBER_BINDING_INVALID),
  );

  await assert.rejects(
    () => routing.resolve({
      token: 'a-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team', memberName: 'Bot' },
    }),
    (error) => isCode(error, MEMBER_BINDING_INVALID),
  );
});

test('machine+group scan records bindingFailures instead of treating failed members as matches', async () => {
  const h = await harness();
  const { workspace, team, member } = await h.addWorkspace('a');
  const scout = await h.organization.addMember({
    token: SEED_TOKEN,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Scout',
    expectedRevision: member.revision,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'claude',
    launchProfileRef: 'lp-scout',
  });
  const port = createBindingPort();
  port.failure(member.memberId, MEMBER_RUNTIME_NOT_CONFIGURED, 'no runtime config');
  port.set(scout.memberId, bindingFor(scout.memberId, 'mac-other'));
  const routing = routingWith(h.organization, port, {
    'a-token': { accountId: 'acct-a', ...accountFor(workspace.workspaceId) },
  });

  let captured;
  try {
    await routing.resolve({
      token: 'a-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team' },
    });
    assert.fail('scan must reject with no machine match');
  } catch (error) {
    captured = error;
  }
  assert.ok(isCode(captured, ERROR_CODES.ROUTE_NOT_FOUND));
  assert.equal(captured.details.matchCount, 0);
  assert.equal(Array.isArray(captured.details.bindingFailures), true);
  assert.equal(captured.details.bindingFailures.length, 1);
  assert.equal(captured.details.bindingFailures[0].memberId, member.memberId);
  assert.equal(captured.details.bindingFailures[0].code, MEMBER_RUNTIME_NOT_CONFIGURED);

  // A later member with a matching runtime binding is still found while the
  // earlier member's typed failure stays recorded in the scan.
  port.set(scout.memberId, bindingFor(scout.memberId, 'mac-1'));
  const found = await routing.resolve({
    token: 'a-token',
    workspaceId: workspace.workspaceId,
    address: { machineId: 'mac-1', groupPath: '/Acme/team' },
  });
  assert.equal(found.memberId, scout.memberId);
});

test('no-selector scan rejects an empty member grant before any binding read', async () => {
  const h = await harness();
  const { workspace, member } = await h.addWorkspace('a');
  const port = createBindingPort({ [member.memberId]: bindingFor(member.memberId, 'mac-1') });
  const routing = routingWith(h.organization, port, {
    'empty-token': {
      accountId: 'acct-empty',
      scopes: [ROUTE_RESOLVE_ACTION],
      workspaces: [workspace.workspaceId],
      members: [],
    },
  });

  let captured;
  try {
    await routing.resolve({
      token: 'empty-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team' },
    });
    assert.fail('scan with an empty member grant must be rejected');
  } catch (error) {
    captured = error;
  }
  assert.ok(isCode(captured, ROUTE_FORBIDDEN));
  assert.equal(captured.details.memberId, undefined, 'empty grant rejection must not name a member');
  assert.equal(port.calls(), 0, 'empty grant must reject before reading any runtime binding');
});

test('no-selector scan narrow grant only admits authorized members', async () => {
  const h = await harness();
  const { workspace, team, member } = await h.addWorkspace('a');
  const scout = await h.organization.addMember({
    token: SEED_TOKEN,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Scout',
    expectedRevision: member.revision,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'claude',
    launchProfileRef: 'lp-scout',
  });
  const port = createBindingPort({
    [member.memberId]: bindingFor(member.memberId, 'mac-1'),
    [scout.memberId]: bindingFor(scout.memberId, 'mac-1'),
  });
  const routing = routingWith(h.organization, port, {
    'narrow-token': {
      accountId: 'acct-narrow',
      scopes: [ROUTE_RESOLVE_ACTION],
      workspaces: [workspace.workspaceId],
      members: [member.memberId],
    },
  });

  const found = await routing.resolve({
    token: 'narrow-token',
    workspaceId: workspace.workspaceId,
    address: { machineId: 'mac-1', groupPath: '/Acme/team' },
  });
  assert.equal(found.memberId, member.memberId);
  assert.equal(port.calls(), 1, 'only the authorized member binding may be read');
});

test('no-selector scan keeps ambiguity for multiple authorized targets', async () => {
  const h = await harness();
  const { workspace, team, member } = await h.addWorkspace('a');
  const scout = await h.organization.addMember({
    token: SEED_TOKEN,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Scout',
    expectedRevision: member.revision,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'claude',
    launchProfileRef: 'lp-scout',
  });
  const port = createBindingPort({
    [member.memberId]: bindingFor(member.memberId, 'mac-1'),
    [scout.memberId]: bindingFor(scout.memberId, 'mac-1'),
  });
  const routing = routingWith(h.organization, port, {
    'narrow-token': {
      accountId: 'acct-narrow',
      scopes: [ROUTE_RESOLVE_ACTION],
      workspaces: [workspace.workspaceId],
      members: [member.memberId, scout.memberId],
    },
  });

  let captured;
  try {
    await routing.resolve({
      token: 'narrow-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team' },
    });
    assert.fail('two authorized matching members must stay ambiguous');
  } catch (error) {
    captured = error;
  }
  assert.ok(isCode(captured, ERROR_CODES.ROUTE_AMBIGUOUS));
  assert.equal(captured.details.matchCount, 2);
  assert.deepEqual(
    [...captured.details.memberIds].sort(),
    [member.memberId, scout.memberId].sort(),
  );
  assert.equal(port.calls(), 2, 'only the two authorized members are read');
});

test('no-selector scan rejects when only an unauthorized member would match', async () => {
  const h = await harness();
  const { workspace, team, member } = await h.addWorkspace('a');
  const scout = await h.organization.addMember({
    token: SEED_TOKEN,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Scout',
    expectedRevision: member.revision,
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'claude',
    launchProfileRef: 'lp-scout',
  });
  const port = createBindingPort({
    [member.memberId]: bindingFor(member.memberId, 'mac-other'),
    [scout.memberId]: bindingFor(scout.memberId, 'mac-1'),
  });
  const routing = routingWith(h.organization, port, {
    'narrow-token': {
      accountId: 'acct-narrow',
      scopes: [ROUTE_RESOLVE_ACTION],
      workspaces: [workspace.workspaceId],
      members: [member.memberId],
    },
  });

  let captured;
  try {
    await routing.resolve({
      token: 'narrow-token',
      workspaceId: workspace.workspaceId,
      address: { machineId: 'mac-1', groupPath: '/Acme/team' },
    });
    assert.fail('scan must reject when no authorized member matches');
  } catch (error) {
    captured = error;
  }
  assert.ok(isCode(captured, ERROR_CODES.ROUTE_NOT_FOUND));
  assert.equal(captured.details.matchCount, 0);
  assert.deepEqual(captured.details.bindingFailures, []);
  assert.equal(port.calls(), 1, 'the unauthorized member binding must not be read');
  assert.equal(
    JSON.stringify(captured.details).includes(scout.memberId),
    false,
    'the unauthorized member id must not leak into the error',
  );
});

test('resolve carries group reference, organization revision and binding runtime config', async () => {
  const h = await harness();
  const { workspace, team, member } = await h.addWorkspace('a');
  const port = createBindingPort({
    [member.memberId]: bindingFor(member.memberId, 'mac-live', {
      hostKind: 'vm',
      agentKind: 'other',
      launchProfileRef: 'lp-live',
      generation: 2,
    }),
  });
  const routing = routingWith(h.organization, port, {
    'a-token': { accountId: 'acct-a', ...accountFor(workspace.workspaceId) },
  });

  const fresh = await h.organization.readWorkspace(workspace.workspaceId);
  const result = await routing.resolve({
    token: 'a-token',
    workspaceId: workspace.workspaceId,
    address: { machineId: 'mac-live', groupPath: '/Acme/team', memberId: member.memberId },
  });
  assert.equal(result.memberId, member.memberId);
  assert.equal(result.groupId, team.groupId);
  assert.equal(result.groupPath, '/Acme/team');
  assert.equal(result.organizationRevision, fresh.workspace.revision);
  assert.equal(result.machineId, 'mac-live');
  assert.equal(result.hostKind, 'vm');
  assert.equal(result.agentKind, 'other');
  assert.equal(result.launchProfileRef, 'lp-live');
  assert.equal(result.bindingGeneration, 2);
});

test('constructor requires a getRuntimeBinding reader and rejects the old getBinding port', async () => {
  const h = await harness();
  const auth = createRoutingDevAuth({ accounts: {} });

  assert.throws(
    () => createRoutingService({ organization: h.organization, members: {}, auth }),
    TypeError,
  );
  assert.throws(
    () => createRoutingService({
      organization: h.organization,
      members: { getBinding: async () => null },
      auth,
    }),
    TypeError,
  );
  const port = createBindingPort();
  assert.doesNotThrow(
    () => createRoutingService({ organization: h.organization, members: port, auth }),
  );
});

test('missing or unknown token is rejected as UNAUTHENTICATED', async () => {
  const h = await harness();
  const { workspace, member } = await h.addWorkspace('a');
  const port = createBindingPort({ [member.memberId]: bindingFor(member.memberId, 'mac-1') });
  const routing = routingWith(h.organization, port, {
    'a-token': { accountId: 'acct-a', ...accountFor(workspace.workspaceId) },
  });
  const address = { machineId: 'mac-1', groupPath: '/Acme/team', memberId: member.memberId };

  await assert.rejects(
    () => routing.resolve({ token: 'unknown-token', workspaceId: workspace.workspaceId, address }),
    (error) => isCode(error, ERROR_CODES.UNAUTHENTICATED),
  );
  await assert.rejects(
    () => routing.resolve({ workspaceId: workspace.workspaceId, address }),
    (error) => isCode(error, ERROR_CODES.UNAUTHENTICATED),
  );
});
