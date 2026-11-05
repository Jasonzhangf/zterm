// Public-entry receipt for the zterm V2 routing increment (R2 narrow rework).
// It drives routing only through its public entry and a minimal runtime-binding
// PORT FIXTURE. This is NOT the real members reader: the real
// members.getRuntimeBinding integration is deferred to Jenny's combined
// milestone after the members head lands. No secrets are written.
//
// Usage: node v2/evidence/zterm-v2-routing-impl-1103/receipt.mjs [outPath]

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ERROR_CODES, TypedError, isTypedError } from '../../modules/organization/src/public/typed-error.mjs';
import {
  createOrganizationService,
  createOrganizationStore,
} from '../../modules/organization/src/public/index.mjs';
import {
  MEMBER_BINDING_INVALID,
  MEMBER_BINDING_NOT_FOUND,
  MEMBER_RUNTIME_NOT_CONFIGURED,
  ROUTE_FORBIDDEN,
  ROUTE_RESOLVE_ACTION,
  createRoutingDevAuth,
  createRoutingService,
} from '../../modules/routing/src/public/index.mjs';

const SEED_TOKEN = 'seed-token';
const runDir = mkdtempSync(join(tmpdir(), 'zterm-routing-receipt-'));
const orgFile = join(runDir, 'organization.json');

const seedAuth = createRoutingDevAuth({
  accounts: { [SEED_TOKEN]: { accountId: 'acct-seed', scopes: [ROUTE_RESOLVE_ACTION, 'org:write'], workspaces: '*' } },
});
const organization = createOrganizationService({ store: createOrganizationStore(orgFile), auth: seedAuth });

// Minimal runtime-binding port fixture (in-memory Map). It returns the real
// shape or throws a shared TypedError; it does not copy any members store.
function createBindingPort(entries = {}) {
  const bindings = new Map(Object.entries(entries));
  let calls = 0;
  return {
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
        throw new TypedError(entry.failWith, entry.message ?? `runtime binding failure for ${memberId}`, {
          owningModule: 'members',
          details: { memberId },
        });
      }
      return { ...entry };
    },
    set(memberId, entry) {
      bindings.set(memberId, entry);
    },
    calls() {
      return calls;
    },
  };
}

function bindingFor(memberId, machineId, options = {}) {
  return {
    memberId,
    machineId,
    hostKind: options.hostKind ?? 'tmux',
    agentKind: options.agentKind ?? 'codex',
    launchProfileRef: options.launchProfileRef ?? 'lp',
    generation: options.generation ?? 1,
    sessionId: options.sessionId ?? 'sess',
    anchor: options.anchor ?? 'pane:0',
  };
}

async function capture(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (isTypedError(error)) {
      return { ok: false, code: error.code, owningModule: error.owningModule, details: error.details ?? null };
    }
    return { ok: false, code: 'UNEXPECTED', message: error?.message ?? String(error) };
  }
}

async function seedWorkspace(label) {
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
    name: 'Bot',
    expectedRevision: team.revision,
    machineId: 'org-stale-machine',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: `lp-${label}`,
  });
  return { workspace, team, member };
}

const alpha = await seedWorkspace('alpha');
const beta = await seedWorkspace('beta');
const port = createBindingPort({
  [alpha.member.memberId]: bindingFor(alpha.member.memberId, 'mac-1', {
    sessionId: 'sess-alpha',
    anchor: 'pane-alpha',
    hostKind: 'vm',
    agentKind: 'other',
    launchProfileRef: 'lp-live-alpha',
  }),
  [beta.member.memberId]: bindingFor(beta.member.memberId, 'mac-1', {
    hostKind: 'vm',
    agentKind: 'other',
    launchProfileRef: 'lp-live-beta',
    sessionId: 'sess-beta',
    anchor: 'pane-beta',
  }),
});

function routingWith(accounts) {
  return createRoutingService({ organization, members: port, auth: createRoutingDevAuth({ accounts }) });
}

const allowAlpha = { accountId: 'acct-alpha', scopes: [ROUTE_RESOLVE_ACTION], workspaces: [alpha.workspace.workspaceId] };
const allowBeta = { accountId: 'acct-beta', scopes: [ROUTE_RESOLVE_ACTION], workspaces: [beta.workspace.workspaceId] };
const router = routingWith({ 'alpha-token': allowAlpha, 'beta-token': allowBeta });

const cases = [];
function record(name, expected, actual, pass) {
  cases.push({ name, expected, actual, pass });
}

const unique = await capture(() => router.resolve({
  token: 'alpha-token',
  workspaceId: alpha.workspace.workspaceId,
  address: {
    machineId: 'mac-1',
    groupPath: '/Acme/team',
    memberId: alpha.member.memberId,
    expectedGeneration: 1,
  },
}));
const alphaRevision = (await organization.readWorkspace(alpha.workspace.workspaceId)).workspace.revision;
record(
  'unique resolve returns group reference, revision, runtime machine id, config, generation, session and anchor',
  `ok memberId=${alpha.member.memberId} groupId=${alpha.team.groupId} groupPath=/Acme/team organizationRevision=${alphaRevision} machineId=mac-1 hostKind=vm agentKind=other launchProfileRef=lp-live-alpha bindingGeneration=1 sessionId=sess-alpha anchor=pane-alpha`,
  unique.ok
    ? `ok memberId=${unique.value.memberId} groupId=${unique.value.groupId} groupPath=${unique.value.groupPath} organizationRevision=${unique.value.organizationRevision} machineId=${unique.value.machineId} hostKind=${unique.value.hostKind} agentKind=${unique.value.agentKind} launchProfileRef=${unique.value.launchProfileRef} bindingGeneration=${unique.value.bindingGeneration} sessionId=${unique.value.sessionId} anchor=${unique.value.anchor}`
    : `rejected ${unique.code}`,
  unique.ok
    && unique.value.memberId === alpha.member.memberId
    && unique.value.groupId === alpha.team.groupId
    && unique.value.groupPath === '/Acme/team'
    && unique.value.organizationRevision === alphaRevision
    && unique.value.machineId === 'mac-1'
    && unique.value.hostKind === 'vm'
    && unique.value.agentKind === 'other'
    && unique.value.launchProfileRef === 'lp-live-alpha'
    && unique.value.bindingGeneration === 1
    && unique.value.sessionId === 'sess-alpha'
    && unique.value.anchor === 'pane-alpha'
);

const staleMachine = await capture(() => router.resolve({
  token: 'alpha-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'org-stale-machine', groupPath: '/Acme/team', memberId: alpha.member.memberId },
}));
record(
  'old organization machineId is not used for matching',
  'ROUTE_NOT_FOUND',
  staleMachine.code ?? 'ok',
  !staleMachine.ok && staleMachine.code === ERROR_CODES.ROUTE_NOT_FOUND,
);

const unknown = await capture(() => router.resolve({
  token: 'alpha-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/gone', memberName: 'Bot' },
}));
record('unknown group path rejected', 'ROUTE_NOT_FOUND', unknown.code ?? 'ok', !unknown.ok && unknown.code === ERROR_CODES.ROUTE_NOT_FOUND);

const scout = await organization.addMember({
  token: SEED_TOKEN,
  workspaceId: alpha.workspace.workspaceId,
  groupId: alpha.team.groupId,
  name: 'Scout',
  expectedRevision: alpha.member.revision,
  machineId: 'mac-1',
  hostKind: 'tmux',
  agentKind: 'claude',
  launchProfileRef: 'lp-scout',
});
port.set(scout.memberId, bindingFor(scout.memberId, 'mac-1', { agentKind: 'claude', launchProfileRef: 'lp-scout' }));
const ambiguous = await capture(() => router.resolve({
  token: 'alpha-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team' },
}));
record(
  'co-located distinct members rejected as ambiguous without a selector',
  'ROUTE_AMBIGUOUS with matchCount 2',
  ambiguous.code ? `${ambiguous.code} matchCount=${ambiguous.details?.matchCount}` : 'ok',
  !ambiguous.ok && ambiguous.code === ERROR_CODES.ROUTE_AMBIGUOUS && ambiguous.details?.matchCount === 2,
);

const byName = await capture(() => router.resolve({
  token: 'alpha-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberName: 'Scout' },
}));
record('memberName selector resolves the named member', `memberId=${scout.memberId}`, byName.value ? `memberId=${byName.value.memberId}` : `rejected ${byName.code}`, byName.ok && byName.value.memberId === scout.memberId);

const idAsName = await capture(() => router.resolve({
  token: 'alpha-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: 'Bot' },
}));
record('memberId selector does not match a readable name', 'ROUTE_NOT_FOUND', idAsName.code ?? 'ok', !idAsName.ok && idAsName.code === ERROR_CODES.ROUTE_NOT_FOUND);

const fromAlpha = await capture(() => router.resolve({
  token: 'alpha-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberName: 'Bot' },
}));
const fromBeta = await capture(() => router.resolve({
  token: 'beta-token',
  workspaceId: beta.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberName: 'Bot' },
}));
record(
  'same group path and member name in another workspace stays isolated',
  `alpha=${alpha.member.memberId} beta=${beta.member.memberId}`,
  `alpha=${fromAlpha.value?.memberId} beta=${fromBeta.value?.memberId}`,
  fromAlpha.ok && fromBeta.ok
    && fromAlpha.value.memberId === alpha.member.memberId
    && fromBeta.value.memberId === beta.member.memberId
    && fromAlpha.value.memberId !== fromBeta.value.memberId,
);

const stale = await capture(() => router.resolve({
  token: 'alpha-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: alpha.member.memberId, expectedGeneration: 0 },
}));
record(
  'stale expectedGeneration rejected with the current generation',
  'BINDING_GENERATION_STALE with currentGeneration 1',
  stale.code ? `${stale.code} currentGeneration=${stale.details?.currentGeneration}` : 'ok',
  !stale.ok && stale.code === ERROR_CODES.BINDING_GENERATION_STALE && stale.details?.currentGeneration === 1,
);

const wrongScope = routingWith({ 'scope-token': { accountId: 'acct-scope', scopes: ['routing:other'], workspaces: '*' } });
const scopeDenied = await capture(() => wrongScope.resolve({
  token: 'scope-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: alpha.member.memberId },
}));
record(
  'wrong action scope rejected before any read',
  'ROUTE_FORBIDDEN for routing:resolve',
  scopeDenied.code ? `${scopeDenied.code} action=${scopeDenied.details?.action}` : 'ok',
  !scopeDenied.ok && scopeDenied.code === ROUTE_FORBIDDEN && scopeDenied.details?.action === ROUTE_RESOLVE_ACTION,
);

const crossDenied = await capture(() => router.resolve({
  token: 'beta-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: alpha.member.memberId },
}));
record(
  'cross-account workspace target rejected with no member leak',
  'ROUTE_FORBIDDEN with workspaceId and no memberId detail',
  crossDenied.code ? `${crossDenied.code} workspaceId=${crossDenied.details?.workspaceId}` : 'ok',
  !crossDenied.ok && crossDenied.code === ROUTE_FORBIDDEN
    && crossDenied.details?.workspaceId === alpha.workspace.workspaceId
    && crossDenied.details?.memberId === undefined,
);

const emptyGrant = routingWith({
  'empty-token': { accountId: 'acct-empty', scopes: [ROUTE_RESOLVE_ACTION], workspaces: [alpha.workspace.workspaceId], members: [] },
});
const emptyDenied = await capture(() => emptyGrant.resolve({
  token: 'empty-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: alpha.member.memberId },
}));
record(
  'empty member grant rejects instead of widening',
  'ROUTE_FORBIDDEN',
  emptyDenied.code ?? 'ok',
  !emptyDenied.ok && emptyDenied.code === ROUTE_FORBIDDEN,
);

const wildGrant = routingWith({
  'wild-token': { accountId: 'acct-wild', scopes: [ROUTE_RESOLVE_ACTION], workspaces: [alpha.workspace.workspaceId], members: '*' },
});
const wildDenied = await capture(() => wildGrant.resolve({
  token: 'wild-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: alpha.member.memberId },
}));
record(
  'wildcard member grant is not an undeclared expansion',
  'ROUTE_FORBIDDEN',
  wildDenied.code ?? 'ok',
  !wildDenied.ok && wildDenied.code === ROUTE_FORBIDDEN,
);

const scanEmptyPort = createBindingPort();
scanEmptyPort.set(alpha.member.memberId, bindingFor(alpha.member.memberId, 'mac-1'));
const scanEmptyRouter = createRoutingService({
  organization,
  members: scanEmptyPort,
  auth: createRoutingDevAuth({
    accounts: {
      'empty-scan-token': {
        accountId: 'acct-empty-scan',
        scopes: [ROUTE_RESOLVE_ACTION],
        workspaces: [alpha.workspace.workspaceId],
        members: [],
      },
    },
  }),
});
const scanEmpty = await capture(() => scanEmptyRouter.resolve({
  token: 'empty-scan-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team' },
}));
record(
  'no-selector scan rejects empty member grant before reading any binding',
  'ROUTE_FORBIDDEN and zero runtime-binding reads',
  `${scanEmpty.code ?? 'ok'} reads=${scanEmptyPort.calls()}`,
  !scanEmpty.ok && scanEmpty.code === ROUTE_FORBIDDEN && scanEmptyPort.calls() === 0,
);

const scanNarrowPort = createBindingPort({
  [alpha.member.memberId]: bindingFor(alpha.member.memberId, 'mac-2'),
  [scout.memberId]: bindingFor(scout.memberId, 'mac-1'),
});
const scanNarrowRouter = createRoutingService({
  organization,
  members: scanNarrowPort,
  auth: createRoutingDevAuth({
    accounts: {
      'narrow-scan-token': {
        accountId: 'acct-narrow-scan',
        scopes: [ROUTE_RESOLVE_ACTION],
        workspaces: [alpha.workspace.workspaceId],
        members: [alpha.member.memberId],
      },
    },
  }),
});
const scanNarrow = await capture(() => scanNarrowRouter.resolve({
  token: 'narrow-scan-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team' },
}));
record(
  'no-selector scan narrow grant does not read or leak an unauthorized member',
  'ROUTE_NOT_FOUND with no unauthorized member id and one authorized read',
  `${scanNarrow.code ?? 'ok'} reads=${scanNarrowPort.calls()} leak=${JSON.stringify(scanNarrow.details ?? {}).includes(scout.memberId)}`,
  !scanNarrow.ok && scanNarrow.code === ERROR_CODES.ROUTE_NOT_FOUND
    && scanNarrowPort.calls() === 1
    && !JSON.stringify(scanNarrow.details ?? {}).includes(scout.memberId),
);

const scanAdmitPort = createBindingPort({
  [alpha.member.memberId]: bindingFor(alpha.member.memberId, 'mac-1'),
  [scout.memberId]: bindingFor(scout.memberId, 'mac-1'),
});
const scanAdmitRouter = createRoutingService({
  organization,
  members: scanAdmitPort,
  auth: createRoutingDevAuth({
    accounts: {
      'narrow-scan-token': {
        accountId: 'acct-narrow-scan',
        scopes: [ROUTE_RESOLVE_ACTION],
        workspaces: [alpha.workspace.workspaceId],
        members: [alpha.member.memberId],
      },
    },
  }),
});
const scanAdmit = await capture(() => scanAdmitRouter.resolve({
  token: 'narrow-scan-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team' },
}));
record(
  'no-selector scan narrow grant resolves the authorized member only',
  `memberId=${alpha.member.memberId} reads=1`,
  scanAdmit.ok
    ? `memberId=${scanAdmit.value.memberId} reads=${scanAdmitPort.calls()}`
    : `rejected ${scanAdmit.code} reads=${scanAdmitPort.calls()}`,
  scanAdmit.ok && scanAdmit.value.memberId === alpha.member.memberId && scanAdmitPort.calls() === 1,
);

const scanAmbiguousPort = createBindingPort({
  [alpha.member.memberId]: bindingFor(alpha.member.memberId, 'mac-1'),
  [scout.memberId]: bindingFor(scout.memberId, 'mac-1'),
});
const scanAmbiguousRouter = createRoutingService({
  organization,
  members: scanAmbiguousPort,
  auth: createRoutingDevAuth({
    accounts: {
      'narrow-both-token': {
        accountId: 'acct-narrow-both',
        scopes: [ROUTE_RESOLVE_ACTION],
        workspaces: [alpha.workspace.workspaceId],
        members: [alpha.member.memberId, scout.memberId],
      },
    },
  }),
});
const scanAmbiguous = await capture(() => scanAmbiguousRouter.resolve({
  token: 'narrow-both-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team' },
}));
record(
  'no-selector scan keeps ambiguity across multiple authorized targets',
  'ROUTE_AMBIGUOUS with matchCount 2 and two authorized reads',
  `${scanAmbiguous.code ?? 'ok'} matchCount=${scanAmbiguous.details?.matchCount} reads=${scanAmbiguousPort.calls()}`,
  !scanAmbiguous.ok && scanAmbiguous.code === ERROR_CODES.ROUTE_AMBIGUOUS
    && scanAmbiguous.details?.matchCount === 2
    && scanAmbiguousPort.calls() === 2,
);

const directedFailure = createBindingPort();
directedFailure.set(alpha.member.memberId, { failWith: MEMBER_BINDING_INVALID, message: 'binding invalid' });
const directedRouter = createRoutingService({ organization, members: directedFailure, auth: createRoutingDevAuth({ accounts: { 'alpha-token': allowAlpha } }) });
const directedDenied = await capture(() => directedRouter.resolve({
  token: 'alpha-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: alpha.member.memberId },
}));
record(
  'directed selection propagates runtime binding typed failure',
  'MEMBER_BINDING_INVALID',
  directedDenied.code ?? 'ok',
  !directedDenied.ok && directedDenied.code === MEMBER_BINDING_INVALID,
);

const scanPort = createBindingPort();
scanPort.set(alpha.member.memberId, { failWith: MEMBER_RUNTIME_NOT_CONFIGURED, message: 'not configured' });
scanPort.set(scout.memberId, bindingFor(scout.memberId, 'mac-other'));
const scanRouter = createRoutingService({ organization, members: scanPort, auth: createRoutingDevAuth({ accounts: { 'alpha-token': allowAlpha } }) });
const scanDenied = await capture(() => scanRouter.resolve({
  token: 'alpha-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team' },
}));
record(
  'machine+group scan reports bindingFailures and does not treat failures as matches',
  'ROUTE_NOT_FOUND with bindingFailures [MEMBER_RUNTIME_NOT_CONFIGURED]',
  scanDenied.code
    ? `${scanDenied.code} matchCount=${scanDenied.details?.matchCount} bindingFailures=${JSON.stringify(scanDenied.details?.bindingFailures)}`
    : 'ok',
  !scanDenied.ok && scanDenied.code === ERROR_CODES.ROUTE_NOT_FOUND
    && scanDenied.details?.matchCount === 0
    && Array.isArray(scanDenied.details?.bindingFailures)
    && scanDenied.details.bindingFailures[0]?.code === MEMBER_RUNTIME_NOT_CONFIGURED,
);

let constructorRejectsOldPort = false;
try {
  createRoutingService({ organization, members: { getBinding: async () => null }, auth: seedAuth });
} catch (error) {
  constructorRejectsOldPort = error instanceof TypeError;
}
record(
  'constructor requires getRuntimeBinding and rejects the old getBinding port',
  'TypeError for getBinding-only port',
  constructorRejectsOldPort ? 'TypeError' : 'accepted',
  constructorRejectsOldPort,
);

const unauthenticated = await capture(() => router.resolve({
  token: 'nope',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: alpha.member.memberId },
}));
record('missing/unknown token rejected', 'UNAUTHENTICATED', unauthenticated.code ?? 'ok', !unauthenticated.ok && unauthenticated.code === ERROR_CODES.UNAUTHENTICATED);

const receipt = {
  kind: 'routing-port-fixture-receipt',
  task: 'zterm-v2-routing-impl-1103',
  branch: 'zterm-v2-routing-impl-1103',
  publicEntry: 'v2/modules/routing/src/public/index.mjs',
  dependencies: {
    membersReader: 'deferred to Jenny combined milestone after members getRuntimeBinding head lands',
    fixture: 'in-memory Map port (not the real members reader)',
  },
  crossWorkspaceIsolation: {
    alpha: alpha.workspace.workspaceId,
    beta: beta.workspace.workspaceId,
  },
  cases,
  outcome: cases.every((entry) => entry.pass) ? 'PASS' : 'FAIL',
};

const outPath = process.argv[2] ?? join(import.meta.dirname, 'receipt.json');
writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(receipt, null, 2));
console.log(receipt.outcome === 'PASS' ? 'routing-receipt-ok' : 'routing-receipt-failed');
