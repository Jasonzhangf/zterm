// Owner self-check for the routing module. Composes the real organization and
// members public entries (no fakes, no second write store) and checks full-path
// resolution plus cross-workspace same-name isolation.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ERROR_CODES,
  createDevVerifiedAuth,
  createOrganizationService,
  createOrganizationStore,
  isTypedError,
} from '../../../../modules/organization/src/public/index.mjs';
import {
  createBindingStore,
  createMembersService,
} from '../../../../modules/members/src/public/index.mjs';
import { createRoutingService } from '../../../../modules/routing/src/public/index.mjs';

const token = 'routing-self-check-token';
const auth = createDevVerifiedAuth({
  accounts: { [token]: { accountId: 'acct-routing-self-check', scopes: ['routing:read'] } },
});

const runDir = mkdtempSync(join(tmpdir(), 'zterm-routing-self-check-'));
const organization = createOrganizationService({
  store: createOrganizationStore(join(runDir, 'organization.json')),
  auth,
});
const members = createMembersService({
  store: createBindingStore(join(runDir, 'bindings.json')),
  auth,
  organization,
});
const routing = createRoutingService({ organization, members, auth });

async function capture(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (isTypedError(error)) {
      return { ok: false, code: error.code, owningModule: error.owningModule, message: error.message };
    }
    return { ok: false, code: 'UNEXPECTED', message: error?.message ?? String(error) };
  }
}

async function seedWorkspace(label) {
  // Both workspaces share the readable name so their group paths collide; the
  // stable workspaceId must keep resolution isolated.
  const workspace = await organization.createWorkspace({ token, name: 'Acme' });
  const team = await organization.createGroup({ token, workspaceId: workspace.workspaceId, name: 'team' });
  const member = await organization.addMember({
    token,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Bot',
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: `lp-${label}`,
  });
  await members.bindSession({
    token,
    memberId: member.memberId,
    sessionId: `sess-${label}`,
    anchor: `pane-${label}`,
    expectedGeneration: 0,
  });
  return { workspace, team, member };
}

const alpha = await seedWorkspace('alpha');
const beta = await seedWorkspace('beta');

const fullPath = await capture(() => routing.resolve({
  token,
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: alpha.member.memberId },
}));

const isolationAlpha = await capture(() => routing.resolve({
  token,
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: 'Bot' },
}));

const isolationBeta = await capture(() => routing.resolve({
  token,
  workspaceId: beta.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: 'Bot' },
}));

// A third same-name member in the alpha workspace turns a readable-name address
// into a reachable ambiguity; the stable-id address stays unambiguous.
await organization.addMember({
  token,
  workspaceId: alpha.workspace.workspaceId,
  groupId: alpha.team.groupId,
  name: 'Bot',
  machineId: 'mac-1',
  hostKind: 'tmux',
  agentKind: 'claude',
  launchProfileRef: 'lp-alpha-2',
});

const ambiguous = await capture(() => routing.resolve({
  token,
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: 'Bot' },
}));

const unknown = await capture(() => routing.resolve({
  token,
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/missing', memberId: 'Bot' },
}));

const stale = await capture(() => routing.resolve({
  token,
  workspaceId: alpha.workspace.workspaceId,
  address: {
    machineId: 'mac-1',
    groupPath: '/Acme/team',
    memberId: alpha.member.memberId,
    expectedGeneration: 2,
  },
}));

const unauthenticated = await capture(() => routing.resolve({
  token: 'wrong-token',
  workspaceId: alpha.workspace.workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: alpha.member.memberId },
}));

const receipt = {
  kind: 'routing-owner-self-check',
  publicEntry: 'v2/modules/routing/src/public/index.mjs',
  workspace: {
    branch: 'zterm-v2-organization-1103',
    note: 'LayerFS branch identity comes from sandbox list_workspaces; git inside may report main.',
  },
  alpha: { workspaceId: alpha.workspace.workspaceId, memberId: alpha.member.memberId },
  beta: { workspaceId: beta.workspace.workspaceId, memberId: beta.member.memberId },
  fullPath,
  isolationAlpha,
  isolationBeta,
  ambiguous,
  unknown,
  stale,
  unauthenticated,
  outcome:
    fullPath.ok && fullPath.value.bindingGeneration === 1
    && isolationAlpha.ok && isolationAlpha.value.memberId === alpha.member.memberId
    && isolationBeta.ok && isolationBeta.value.memberId === beta.member.memberId
    && isolationAlpha.value.memberId !== isolationBeta.value.memberId
    && !ambiguous.ok && ambiguous.code === ERROR_CODES.ROUTE_AMBIGUOUS
    && !unknown.ok && unknown.code === ERROR_CODES.ROUTE_NOT_FOUND
    && !stale.ok && stale.code === ERROR_CODES.BINDING_GENERATION_STALE
    && !unauthenticated.ok && unauthenticated.code === ERROR_CODES.UNAUTHENTICATED
      ? 'PASS'
      : 'FAIL',
};

const outPath = process.argv[2] ?? join(import.meta.dirname, 'routing-receipt.json');
writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(receipt, null, 2));
