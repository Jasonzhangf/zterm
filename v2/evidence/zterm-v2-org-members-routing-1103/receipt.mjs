// Public-entry receipt generator. It composes only the three module public entries
// and exercises the increment acceptance cases. Output is plain JSON; no secrets.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDevVerifiedAuth,
  createOrganizationService,
  createOrganizationStore,
} from '../../modules/organization/src/public/index.mjs';
import { createBindingStore, createMembersService } from '../../modules/members/src/public/index.mjs';
import { createRoutingService } from '../../modules/routing/src/public/index.mjs';

const auth = createDevVerifiedAuth({
  accounts: { 'dev-token': { accountId: 'acct-1', scopes: ['org:write', 'members:write', 'routing:read'] } },
});

async function tempFile(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return join(dir, 'data.json');
}

async function capture(label, fn) {
  try {
    return { [label]: { ok: true, value: await fn() } };
  } catch (error) {
    return { [label]: { ok: false, code: error.code ?? null, owningModule: error.owningModule ?? null } };
  }
}

const orgFile = await tempFile('zterm-receipt-org-');
const bindFile = await tempFile('zterm-receipt-binding-');
const organization = createOrganizationService({ store: createOrganizationStore(orgFile), auth });
const members = createMembersService({ store: createBindingStore(bindFile), auth, organization });
const routing = createRoutingService({ organization, members, auth });

const receipt = {};
receipt.createWorkspace = await capture('createWorkspace', () => organization.createWorkspace({ token: 'dev-token', name: 'Acme' }));
const { workspaceId } = receipt.createWorkspace.createWorkspace.value;

receipt.createGroup = await capture('createGroup', () => organization.createGroup({ token: 'dev-token', workspaceId, name: 'team' }));
const { groupId } = receipt.createGroup.createGroup.value;

receipt.duplicateGroup = await capture('duplicateGroup', () => organization.createGroup({ token: 'dev-token', workspaceId, name: 'team' }));

receipt.addMember = await capture('addMember', () => organization.addMember({
  token: 'dev-token',
  workspaceId,
  groupId,
  name: 'Bot',
  machineId: 'mac-1',
  hostKind: 'tmux',
  agentKind: 'codex',
  launchProfileRef: 'lp-default',
}));
const { memberId } = receipt.addMember.addMember.value;

receipt.reopen = await capture('reopen', async () => {
  const reopened = createOrganizationService({ store: createOrganizationStore(orgFile), auth });
  return (await reopened.queryTree({ token: 'dev-token', workspaceId })).workspace.workspaceId === workspaceId;
});

receipt.bind = await capture('bind', () => members.bindSession({
  token: 'dev-token',
  memberId,
  sessionId: 'sess-a',
  anchor: 'pane:0',
  expectedGeneration: 0,
}));

receipt.staleBinding = await capture('staleBinding', () => members.bindSession({
  token: 'dev-token',
  memberId,
  sessionId: 'sess-b',
  anchor: 'pane:1',
  expectedGeneration: 0,
}));

receipt.resolve = await capture('resolve', () => routing.resolve({
  token: 'dev-token',
  workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: 'Bot' },
}));

receipt.unknownRoute = await capture('unknownRoute', () => routing.resolve({
  token: 'dev-token',
  workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: 'ghost' },
}));

await organization.addMember({
  token: 'dev-token',
  workspaceId,
  groupId,
  name: 'Bot',
  machineId: 'mac-1',
  hostKind: 'tmux',
  agentKind: 'claude',
  launchProfileRef: 'lp-2',
});
receipt.ambiguousRoute = await capture('ambiguousRoute', () => routing.resolve({
  token: 'dev-token',
  workspaceId,
  address: { machineId: 'mac-1', groupPath: '/Acme/team', memberId: 'Bot' },
}));

receipt.unverifiedAuth = await capture('unverifiedAuth', () => organization.createWorkspace({ token: 'nope', name: 'X' }));

const outPath = process.argv[2];
const text = `${JSON.stringify(receipt, null, 2)}\n`;
if (outPath) {
  await writeFile(outPath, text, 'utf8');
}
process.stdout.write(text);
