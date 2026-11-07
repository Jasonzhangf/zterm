import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ERROR_CODES,
  createDevVerifiedAuth,
  createOrganizationService,
  createOrganizationStore,
  isTypedError,
} from '../src/public/index.mjs';

const WRITE = 'write';
const READ = 'read';

const ACCOUNTS = {
  [WRITE]: {
    accountId: 'acct-write',
    scopes: ['org:write', 'org:read'],
    workspaces: '*',
  },
  [READ]: {
    accountId: 'acct-read',
    scopes: ['org:read'],
    workspaces: '*',
  },
};

async function tempFile(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return join(dir, 'organization.json');
}

function makeService(file, extraAccounts = {}) {
  return createOrganizationService({
    store: createOrganizationStore(file),
    auth: createDevVerifiedAuth({ accounts: { ...ACCOUNTS, ...extraAccounts } }),
  });
}

function isCode(error, code) {
  return isTypedError(error) && error.code === code;
}

function assertNoHiddenManagerInError(error, hiddenManagerId) {
  assert.equal(error.message.includes(hiddenManagerId), false);
  assert.equal(JSON.stringify(error.toRecord()).includes(hiddenManagerId), false);
  assert.equal(JSON.stringify(error.details ?? null).includes(hiddenManagerId), false);
  assert.equal(JSON.stringify(error.cause ?? null).includes(hiddenManagerId), false);
}

async function seedWorkspace(service) {
  const workspace = await service.createWorkspace({ token: WRITE, name: 'Acme' });
  const team = await service.createGroup({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    name: 'team',
    expectedRevision: workspace.revision,
  });
  const platform = await service.createGroup({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    name: 'platform',
    parentGroupId: team.groupId,
    expectedRevision: team.revision,
  });
  return { workspace, team, platform };
}

test('manages direct reports through public member and report APIs', async () => {
  const service = makeService(await tempFile('zterm-manager-'));
  const { workspace, team, platform } = await seedWorkspace(service);

  const managerA = await service.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Manager A',
    expectedRevision: platform.revision,
  });
  const managerB = await service.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Manager B',
    managerMemberId: null,
    expectedRevision: managerA.revision,
  });
  const reportOne = await service.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: platform.groupId,
    name: 'Report One',
    managerMemberId: managerA.memberId,
    expectedRevision: managerB.revision,
  });
  const reportTwo = await service.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: platform.groupId,
    name: 'Report Two',
    managerMemberId: managerA.memberId,
    expectedRevision: reportOne.revision,
  });

  const managerAReports = await service.listDirectReports({
    token: READ,
    workspaceId: workspace.workspaceId,
    managerMemberId: managerA.memberId,
  });
  assert.deepEqual(managerAReports, {
    workspaceId: workspace.workspaceId,
    managerMemberId: managerA.memberId,
    directMemberIds: [reportOne.memberId, reportTwo.memberId],
    revision: reportTwo.revision,
  });

  const managerBReports = await service.listDirectReports({
    token: READ,
    workspaceId: workspace.workspaceId,
    managerMemberId: managerB.memberId,
  });
  assert.deepEqual(managerBReports.directMemberIds, []);
  assert.equal(managerBReports.revision, reportTwo.revision);

  const tree = await service.queryTree({
    token: READ,
    workspaceId: workspace.workspaceId,
  });
  const treeMembers = tree.root.children.flatMap((group) => group.children)
    .flatMap((group) => group.members);
  const reportTree = treeMembers.filter((member) => member.memberId === reportOne.memberId);
  assert.deepEqual(reportTree, [{
    memberId: reportOne.memberId,
    workspaceId: workspace.workspaceId,
    groupId: platform.groupId,
    name: 'Report One',
    managerMemberId: managerA.memberId,
  }]);

  const reassigned = await service.updateMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    memberId: reportOne.memberId,
    managerMemberId: managerB.memberId,
    expectedRevision: reportTwo.revision,
  });
  assert.equal(reassigned.managerMemberId, managerB.memberId);

  const afterA = await service.listDirectReports({
    token: READ,
    workspaceId: workspace.workspaceId,
    managerMemberId: managerA.memberId,
  });
  const afterB = await service.listDirectReports({
    token: READ,
    workspaceId: workspace.workspaceId,
    managerMemberId: managerB.memberId,
  });
  assert.deepEqual(afterA.directMemberIds, [reportTwo.memberId]);
  assert.deepEqual(afterB.directMemberIds, [reportOne.memberId]);
});

test('rejects unknown, cross-workspace, self, cycle, and hidden managers', async () => {
  const service = makeService(await tempFile('zterm-manager-'));
  const { workspace, team } = await seedWorkspace(service);
  const other = await service.createWorkspace({ token: WRITE, name: 'Other' });

  const manager = await service.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Manager',
    expectedRevision: 3,
  });
  const report = await service.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Report',
    managerMemberId: manager.memberId,
    expectedRevision: manager.revision,
  });

  await assert.rejects(
    () => service.updateMember({
      token: WRITE,
      workspaceId: workspace.workspaceId,
      memberId: report.memberId,
      managerMemberId: 'mbr_missing',
      expectedRevision: report.revision,
    }),
    (error) => isCode(error, ERROR_CODES.MEMBER_NOT_FOUND),
  );
  await assert.rejects(
    () => service.addMember({
      token: WRITE,
      workspaceId: other.workspaceId,
      groupId: other.rootGroupId,
      name: 'Cross Manager',
      managerMemberId: manager.memberId,
      expectedRevision: other.revision,
    }),
    (error) => isCode(error, ERROR_CODES.MEMBER_NOT_FOUND),
  );
  await assert.rejects(
    () => service.updateMember({
      token: WRITE,
      workspaceId: workspace.workspaceId,
      memberId: report.memberId,
      managerMemberId: report.memberId,
      expectedRevision: report.revision,
    }),
    (error) => isCode(error, ERROR_CODES.VALIDATION),
  );

  await assert.rejects(
    () => service.updateMember({
      token: WRITE,
      workspaceId: workspace.workspaceId,
      memberId: manager.memberId,
      managerMemberId: report.memberId,
      expectedRevision: report.revision,
    }),
    (error) => isCode(error, ERROR_CODES.VALIDATION),
  );
  const afterReject = await service.queryTree({
    token: READ,
    workspaceId: workspace.workspaceId,
  });
  assert.equal(afterReject.workspace.revision, report.revision);
});

test('listDirectReports filters hidden members without leaking ids', async () => {
  const file = await tempFile('zterm-manager-hidden-');
  const writer = makeService(file);
  const { workspace, team, platform } = await seedWorkspace(writer);
  const manager = await writer.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Manager',
    expectedRevision: platform.revision,
  });
  const visible = await writer.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: platform.groupId,
    name: 'Visible',
    managerMemberId: manager.memberId,
    expectedRevision: manager.revision,
  });
  const hidden = await writer.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: platform.groupId,
    name: 'Hidden',
    managerMemberId: manager.memberId,
    expectedRevision: visible.revision,
  });

  const reader = makeService(file, {
    'member-allowlist': {
      accountId: 'acct-member-allowlist',
      scopes: ['org:write', 'org:read'],
      workspaces: '*',
      members: [manager.memberId, visible.memberId],
    },
    'manager-only': {
      accountId: 'acct-manager-only',
      scopes: ['org:read'],
      workspaces: '*',
      members: [manager.memberId],
    },
  });

  const reports = await reader.listDirectReports({
    token: 'member-allowlist',
    workspaceId: workspace.workspaceId,
    managerMemberId: manager.memberId,
  });
  assert.deepEqual(reports.directMemberIds, [visible.memberId]);

  const managerOnlyReports = await reader.listDirectReports({
    token: 'manager-only',
    workspaceId: workspace.workspaceId,
    managerMemberId: manager.memberId,
  });
  assert.deepEqual(managerOnlyReports.directMemberIds, []);
  await assert.rejects(
    () => reader.listDirectReports({
      token: 'manager-only',
      workspaceId: workspace.workspaceId,
      managerMemberId: visible.memberId,
    }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN),
  );
  await assert.rejects(
    () => writer.listDirectReports({
      token: READ,
      workspaceId: workspace.workspaceId,
      managerMemberId: 'mbr_missing',
    }),
    (error) => isCode(error, ERROR_CODES.MEMBER_NOT_FOUND),
  );

  await assert.rejects(
    () => reader.updateMember({
      token: 'member-allowlist',
      workspaceId: workspace.workspaceId,
      memberId: visible.memberId,
      managerMemberId: hidden.memberId,
      expectedRevision: hidden.revision,
    }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN),
  );
});

test('queryTree does not leak an invisible manager id', async () => {
  const file = await tempFile('zterm-manager-projection-');
  const writer = makeService(file);
  const { workspace, team } = await seedWorkspace(writer);
  const hiddenManager = await writer.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Hidden Manager',
    expectedRevision: 3,
  });
  const report = await writer.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Report',
    managerMemberId: hiddenManager.memberId,
    expectedRevision: hiddenManager.revision,
  });
  const reader = makeService(file, {
    'report-only': {
      accountId: 'acct-report-only',
      scopes: ['org:read'],
      workspaces: '*',
      members: [report.memberId],
    },
  });

  const tree = await reader.queryTree({
    token: 'report-only',
    workspaceId: workspace.workspaceId,
  });
  const reportTree = tree.root.children.flatMap((group) => group.members)
    .find((member) => member.memberId === report.memberId);
  assert.equal(reportTree.managerMemberId, null);
  assert.equal(JSON.stringify(tree).includes(hiddenManager.memberId), false);
});

test('denies clearing or reassigning a hidden manager without changing the relation', async () => {
  const file = await tempFile('zterm-manager-old-hidden-');
  const writer = makeService(file);
  const { workspace, team, platform } = await seedWorkspace(writer);
  const hiddenManager = await writer.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Hidden Manager',
    expectedRevision: platform.revision,
  });
  const report = await writer.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: platform.groupId,
    name: 'Report',
    managerMemberId: hiddenManager.memberId,
    expectedRevision: hiddenManager.revision,
  });
  const visibleManager = await writer.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Visible Manager',
    expectedRevision: report.revision,
  });
  const reader = makeService(file, {
    'report-hidden': {
      accountId: 'acct-report-hidden',
      scopes: ['org:write', 'org:read'],
      workspaces: '*',
      members: [report.memberId, visibleManager.memberId],
    },
  });

  let clearError;
  await assert.rejects(
    () => reader.updateMember({
      token: 'report-hidden',
      workspaceId: workspace.workspaceId,
      memberId: report.memberId,
      managerMemberId: null,
      expectedRevision: visibleManager.revision,
    }),
    (error) => {
      clearError = error;
      return isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN);
    },
  );
  assertNoHiddenManagerInError(clearError, hiddenManager.memberId);

  let reassignError;
  await assert.rejects(
    () => reader.updateMember({
      token: 'report-hidden',
      workspaceId: workspace.workspaceId,
      memberId: report.memberId,
      managerMemberId: visibleManager.memberId,
      expectedRevision: visibleManager.revision,
    }),
    (error) => {
      reassignError = error;
      return isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN);
    },
  );
  assertNoHiddenManagerInError(reassignError, hiddenManager.memberId);

  const stored = await writer.getMember(report.memberId);
  assert.equal(stored.managerMemberId, hiddenManager.memberId);
  const tree = await writer.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  assert.equal(tree.workspace.revision, visibleManager.revision);
});

test('projects a hidden manager on ordinary rename and group updates', async () => {
  const file = await tempFile('zterm-manager-update-projection-');
  const writer = makeService(file);
  const { workspace, team, platform } = await seedWorkspace(writer);
  const hiddenManager = await writer.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Hidden Manager',
    expectedRevision: platform.revision,
  });
  const report = await writer.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Report',
    managerMemberId: hiddenManager.memberId,
    expectedRevision: hiddenManager.revision,
  });
  const reader = makeService(file, {
    'report-only': {
      accountId: 'acct-report-only-update',
      scopes: ['org:write', 'org:read'],
      workspaces: '*',
      members: [report.memberId],
    },
  });

  const renamed = await reader.updateMember({
    token: 'report-only',
    workspaceId: workspace.workspaceId,
    memberId: report.memberId,
    name: 'Renamed Report',
    expectedRevision: report.revision,
  });
  assert.equal(renamed.name, 'Renamed Report');
  assert.equal(renamed.managerMemberId, null);
  assert.equal(renamed.revision, report.revision + 1);

  const moved = await reader.updateMember({
    token: 'report-only',
    workspaceId: workspace.workspaceId,
    memberId: report.memberId,
    groupId: platform.groupId,
    expectedRevision: renamed.revision,
  });
  assert.equal(moved.groupId, platform.groupId);
  assert.equal(moved.managerMemberId, null);
  assert.equal(moved.revision, renamed.revision + 1);

  const stored = await writer.getMember(report.memberId);
  assert.equal(stored.name, 'Renamed Report');
  assert.equal(stored.groupId, platform.groupId);
  assert.equal(stored.managerMemberId, hiddenManager.memberId);

  const tree = await reader.queryTree({
    token: 'report-only',
    workspaceId: workspace.workspaceId,
  });
  assert.equal(JSON.stringify(tree).includes(hiddenManager.memberId), false);
});

test('deleting a manager with reports returns an explicit conflict', async () => {
  const service = makeService(await tempFile('zterm-manager-delete-'));
  const { workspace, team } = await seedWorkspace(service);
  const manager = await service.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Manager',
    expectedRevision: 3,
  });
  const report = await service.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: team.groupId,
    name: 'Report',
    managerMemberId: manager.memberId,
    expectedRevision: manager.revision,
  });

  await assert.rejects(
    () => service.deleteMember({
      token: WRITE,
      workspaceId: workspace.workspaceId,
      memberId: manager.memberId,
      expectedRevision: report.revision,
    }),
    (error) => isCode(error, ERROR_CODES.MANAGER_HAS_DIRECT_REPORTS),
  );

  const cleared = await service.updateMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    memberId: report.memberId,
    managerMemberId: null,
    expectedRevision: report.revision,
  });
  assert.equal(cleared.managerMemberId, null);

  const deleted = await service.deleteMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    memberId: manager.memberId,
    expectedRevision: cleared.revision,
  });
  assert.deepEqual(deleted, {
    workspaceId: workspace.workspaceId,
    memberId: manager.memberId,
    revision: cleared.revision + 1,
  });
});
