import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
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
  'read-only': {
    accountId: 'acct-read-only',
    scopes: ['org:read'],
    workspaces: '*',
  },
  'write-only': {
    accountId: 'acct-write-only',
    scopes: ['org:write'],
    workspaces: '*',
  },
  'no-workspaces': {
    accountId: 'acct-no-workspaces',
    scopes: ['org:write', 'org:read'],
  },
  'wrong-workspace': {
    accountId: 'acct-wrong-workspace',
    scopes: ['org:read'],
    workspaces: ['ws-other'],
  },
  'member-present-write': {
    accountId: 'acct-member-present',
    scopes: ['org:write', 'org:read'],
    workspaces: '*',
    members: ['mbr-not-yet-created'],
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

async function createWorkspace(service, name = 'Acme') {
  return service.createWorkspace({ token: WRITE, name });
}

async function createGroup(service, workspaceId, expectedRevision, name, parentGroupId) {
  return service.createGroup({
    token: WRITE,
    workspaceId,
    name,
    parentGroupId,
    expectedRevision,
  });
}

async function addMember(service, workspaceId, expectedRevision, groupId, name) {
  return service.addMember({
    token: WRITE,
    workspaceId,
    groupId,
    name,
    expectedRevision,
  });
}

function walk(node, result = []) {
  if (!node) return result;
  result.push(node);
  for (const child of node.children) walk(child, result);
  return result;
}

function findGroup(tree, groupId) {
  return walk(tree.root).find((group) => group.groupId === groupId);
}

function allMembers(tree) {
  return walk(tree.root).flatMap((group) => group.members);
}

test('creates structural workspaces, groups, and members with one revision per mutation', async () => {
  const file = await tempFile('zterm-org-');
  const service = makeService(file);

  const workspace = await createWorkspace(service);
  assert.equal(workspace.revision, 1);

  const team = await createGroup(service, workspace.workspaceId, workspace.revision, 'team');
  assert.equal(team.revision, 2);

  const platform = await createGroup(
    service,
    workspace.workspaceId,
    team.revision,
    'platform',
    team.groupId,
  );
  assert.equal(platform.revision, 3);
  assert.equal(platform.path, '/Acme/team/platform');

  const member = await addMember(
    service,
    workspace.workspaceId,
    platform.revision,
    platform.groupId,
    'Bot',
  );
  assert.equal(member.revision, 4);
  assert.match(member.memberId, /^mbr_/);

  const tree = await service.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  assert.equal(tree.workspace.revision, 4);
  assert.equal(tree.root.path, '/Acme');
  assert.equal(tree.root.children[0].path, '/Acme/team');
  assert.equal(tree.root.children[0].children[0].path, '/Acme/team/platform');
  assert.deepEqual(findGroup(tree, platform.groupId).members, [
    {
      memberId: member.memberId,
      workspaceId: workspace.workspaceId,
      groupId: platform.groupId,
      name: 'Bot',
      managerMemberId: null,
    },
  ]);
});

test('rejects duplicate member names in one group and allows them in different groups', async () => {
  const file = await tempFile('zterm-org-');
  const service = makeService(file);
  const workspace = await createWorkspace(service);
  const a = await createGroup(service, workspace.workspaceId, 1, 'a');
  const b = await createGroup(service, workspace.workspaceId, a.revision, 'b');
  const first = await addMember(service, workspace.workspaceId, b.revision, a.groupId, 'Worker');

  await assert.rejects(
    () => addMember(service, workspace.workspaceId, first.revision, a.groupId, 'Worker'),
    (error) => isCode(error, ERROR_CODES.MEMBER_NAME_CONFLICT),
  );

  const second = await addMember(service, workspace.workspaceId, first.revision, b.groupId, 'Worker');
  assert.notEqual(second.memberId, first.memberId);
  assert.equal(second.revision, 5);

  const tree = await service.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  assert.deepEqual(
    {
      a: findGroup(tree, a.groupId).members.map((member) => member.name),
      b: findGroup(tree, b.groupId).members.map((member) => member.name),
    },
    { a: ['Worker'], b: ['Worker'] },
  );
});

test('updates group names and parents while preserving descendant paths', async () => {
  const file = await tempFile('zterm-org-');
  const service = makeService(file);
  const workspace = await createWorkspace(service);
  const a = await createGroup(service, workspace.workspaceId, 1, 'a');
  const b = await createGroup(service, workspace.workspaceId, a.revision, 'b');
  const child = await createGroup(service, workspace.workspaceId, b.revision, 'child', a.groupId);
  const grandchild = await createGroup(
    service,
    workspace.workspaceId,
    child.revision,
    'grandchild',
    child.groupId,
  );

  const renamed = await service.updateGroup({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: a.groupId,
    name: 'alpha',
    expectedRevision: grandchild.revision,
  });
  assert.equal(renamed.path, '/Acme/alpha');
  assert.equal(renamed.revision, 6);

  const moved = await service.updateGroup({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: a.groupId,
    parentGroupId: b.groupId,
    expectedRevision: renamed.revision,
  });
  assert.equal(moved.path, '/Acme/b/alpha');
  assert.equal(moved.revision, 7);

  const tree = await service.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  assert.equal(findGroup(tree, child.groupId).path, '/Acme/b/alpha/child');
  assert.equal(findGroup(tree, grandchild.groupId).path, '/Acme/b/alpha/child/grandchild');

  await assert.rejects(
    () => service.updateGroup({
      token: WRITE,
      workspaceId: workspace.workspaceId,
      groupId: a.groupId,
      parentGroupId: grandchild.groupId,
      expectedRevision: moved.revision,
    }),
    (error) => isCode(error, ERROR_CODES.VALIDATION),
  );
  await assert.rejects(
    () => service.updateGroup({
      token: WRITE,
      workspaceId: workspace.workspaceId,
      groupId: child.groupId,
      parentGroupId: null,
      expectedRevision: moved.revision,
    }),
    (error) => isCode(error, ERROR_CODES.VALIDATION),
  );

  const afterRejections = await service.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  assert.equal(afterRejections.workspace.revision, moved.revision);
});

test('deletes only empty non-root groups and protects the root', async () => {
  const file = await tempFile('zterm-org-');
  const service = makeService(file);
  const workspace = await createWorkspace(service);
  const empty = await createGroup(service, workspace.workspaceId, 1, 'empty');
  const parent = await createGroup(service, workspace.workspaceId, empty.revision, 'parent');
  const child = await createGroup(
    service,
    workspace.workspaceId,
    parent.revision,
    'child',
    parent.groupId,
  );
  const member = await addMember(
    service,
    workspace.workspaceId,
    child.revision,
    parent.groupId,
    'Worker',
  );

  await assert.rejects(
    () => service.deleteGroup({
      token: WRITE,
      workspaceId: workspace.workspaceId,
      groupId: workspace.rootGroupId,
      expectedRevision: member.revision,
    }),
    (error) => isCode(error, ERROR_CODES.ROOT_GROUP_PROTECTED),
  );
  await assert.rejects(
    () => service.deleteGroup({
      token: WRITE,
      workspaceId: workspace.workspaceId,
      groupId: parent.groupId,
      expectedRevision: member.revision,
    }),
    (error) => isCode(error, ERROR_CODES.GROUP_NOT_EMPTY),
  );

  const deleted = await service.deleteGroup({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: empty.groupId,
    expectedRevision: member.revision,
  });
  assert.deepEqual(deleted, {
    workspaceId: workspace.workspaceId,
    groupId: empty.groupId,
    revision: 6,
  });

  const tree = await service.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  assert.equal(findGroup(tree, empty.groupId), undefined);
  assert.ok(findGroup(tree, parent.groupId));
});

test('updates member name and group and deletes members without changing their id', async () => {
  const file = await tempFile('zterm-org-');
  const service = makeService(file);
  const workspace = await createWorkspace(service);
  const a = await createGroup(service, workspace.workspaceId, 1, 'a');
  const b = await createGroup(service, workspace.workspaceId, a.revision, 'b');
  const member = await addMember(service, workspace.workspaceId, b.revision, a.groupId, 'Worker');

  const renamed = await service.updateMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    memberId: member.memberId,
    name: 'Lead',
    expectedRevision: member.revision,
  });
  assert.equal(renamed.memberId, member.memberId);
  assert.equal(renamed.name, 'Lead');
  assert.equal(renamed.revision, 5);

  const moved = await service.updateMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    memberId: member.memberId,
    groupId: b.groupId,
    expectedRevision: renamed.revision,
  });
  assert.equal(moved.memberId, member.memberId);
  assert.equal(moved.groupId, b.groupId);
  assert.equal(moved.revision, 6);

  const deleted = await service.deleteMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    memberId: member.memberId,
    expectedRevision: moved.revision,
  });
  assert.deepEqual(deleted, {
    workspaceId: workspace.workspaceId,
    memberId: member.memberId,
    revision: 7,
  });

  const tree = await service.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  assert.deepEqual(allMembers(tree), []);
  assert.ok(findGroup(tree, b.groupId));
});

test('keeps stable ids across updates, another delete, and store reopen', async () => {
  const file = await tempFile('zterm-org-');
  const first = makeService(file);
  const workspace = await createWorkspace(first);
  const keep = await createGroup(first, workspace.workspaceId, 1, 'keep');
  const remove = await createGroup(first, workspace.workspaceId, keep.revision, 'remove');
  const member = await addMember(first, workspace.workspaceId, remove.revision, keep.groupId, 'Worker');

  const renamed = await first.updateGroup({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: keep.groupId,
    name: 'kept',
    expectedRevision: member.revision,
  });
  await first.deleteGroup({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: remove.groupId,
    expectedRevision: renamed.revision,
  });

  const reopened = makeService(file);
  const tree = await reopened.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  assert.equal(findGroup(tree, keep.groupId).path, '/Acme/kept');
  assert.equal(findGroup(tree, keep.groupId).members[0].memberId, member.memberId);
  assert.equal(findGroup(tree, remove.groupId), undefined);
});

test('rejects missing and stale revisions without changing the store', async () => {
  const file = await tempFile('zterm-org-');
  const service = makeService(file);
  const workspace = await createWorkspace(service);

  await assert.rejects(
    () => service.createGroup({
      token: WRITE,
      workspaceId: workspace.workspaceId,
      name: 'missing-revision',
    }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_REVISION_STALE),
  );
  await assert.rejects(
    () => service.createGroup({
      token: WRITE,
      workspaceId: workspace.workspaceId,
      name: 'stale-revision',
      expectedRevision: 99,
    }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_REVISION_STALE)
      && error.details?.currentRevision === workspace.revision
      && error.details?.expectedRevision === 99,
  );

  const tree = await service.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  assert.equal(tree.workspace.revision, 1);
  assert.equal(findGroup(tree, tree.root.rootGroupId), undefined);
  assert.equal(tree.root.children.length, 0);
});

test('checks scope, workspace, and member allowlist before touching the store', async () => {
  const file = await tempFile('zterm-org-');
  const service = makeService(file);

  await assert.rejects(
    () => service.createWorkspace({ token: 'read-only', name: 'Denied' }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN),
  );
  await assert.rejects(access(file));

  await assert.rejects(
    () => service.createWorkspace({ token: 'no-workspaces', name: 'Denied' }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN),
  );
  await assert.rejects(access(file));

  const workspace = await createWorkspace(service);
  const tree = await service.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  await assert.rejects(
    () => service.queryTree({ token: 'wrong-workspace', workspaceId: workspace.workspaceId }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN),
  );

  await assert.rejects(
    () => service.addMember({
      token: 'member-present-write',
      workspaceId: workspace.workspaceId,
      groupId: workspace.rootGroupId,
      name: 'Blocked',
      expectedRevision: tree.workspace.revision,
    }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN),
  );
  const after = await service.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  assert.deepEqual(after, tree);
});

test('treats an explicit empty member allowlist as denying every member', async () => {
  const file = await tempFile('zterm-org-');
  const writer = makeService(file);
  const workspace = await createWorkspace(writer);
  const member = await addMember(
    writer,
    workspace.workspaceId,
    1,
    workspace.rootGroupId,
    'Worker',
  );
  const reader = makeService(file, {
    'empty-member-read': {
      accountId: 'acct-empty-member',
      scopes: ['org:read'],
      workspaces: '*',
      members: [],
    },
    'empty-member-write': {
      accountId: 'acct-empty-member-write',
      scopes: ['org:write', 'org:read'],
      workspaces: '*',
      members: [],
    },
  });

  const filtered = await reader.queryTree({
    token: 'empty-member-read',
    workspaceId: workspace.workspaceId,
  });
  assert.deepEqual(allMembers(filtered), []);

  await assert.rejects(
    () => reader.updateMember({
      token: 'empty-member-write',
      workspaceId: workspace.workspaceId,
      memberId: member.memberId,
      name: 'Denied',
      expectedRevision: member.revision,
    }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN),
  );
  await assert.rejects(
    () => reader.deleteMember({
      token: 'empty-member-write',
      workspaceId: workspace.workspaceId,
      memberId: member.memberId,
      expectedRevision: member.revision,
    }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN),
  );
  await assert.rejects(
    () => reader.addMember({
      token: 'empty-member-write',
      workspaceId: workspace.workspaceId,
      groupId: workspace.rootGroupId,
      name: 'New',
      expectedRevision: member.revision,
    }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN),
  );

  const tree = await writer.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  assert.equal(tree.workspace.revision, member.revision);
  assert.deepEqual(allMembers(tree).map((entry) => entry.memberId), [member.memberId]);
});

test('blocks mount when source read is denied and leaves no side effect', async () => {
  const file = await tempFile('zterm-org-');
  const service = makeService(file, {
    'write-only': {
      accountId: 'acct-write-only',
      scopes: ['org:write'],
      workspaces: '*',
    },
  });
  const target = await createWorkspace(service, 'Target');
  const targetGroup = await createGroup(service, target.workspaceId, target.revision, 'team');
  const source = await createWorkspace(service, 'Source');

  await assert.rejects(
    () => service.mountWorkspace({
      token: 'write-only',
      workspaceId: target.workspaceId,
      parentGroupId: targetGroup.groupId,
      sourceWorkspaceId: source.workspaceId,
      expectedRevision: targetGroup.revision,
    }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN),
  );

  const tree = await service.queryTree({ token: READ, workspaceId: target.workspaceId });
  assert.equal(tree.workspace.revision, targetGroup.revision);
  assert.deepEqual(findGroup(tree, targetGroup.groupId).mounts, []);
});

test('rejects self, descendant, duplicate, and name-conflicting mounts', async () => {
  const file = await tempFile('zterm-org-');
  const service = makeService(file);
  const a = await createWorkspace(service, 'A');
  const b = await createWorkspace(service, 'B');
  const c = await createWorkspace(service, 'C');
  const aGroup = await createGroup(service, a.workspaceId, a.revision, 'people');
  const bGroup = await createGroup(service, b.workspaceId, b.revision, 'people');
  const cGroup = await createGroup(service, c.workspaceId, c.revision, 'people');

  const aMount = await service.mountWorkspace({
    token: WRITE,
    workspaceId: a.workspaceId,
    parentGroupId: aGroup.groupId,
    sourceWorkspaceId: b.workspaceId,
    expectedRevision: aGroup.revision,
  });
  assert.equal(aMount.revision, 3);

  await assert.rejects(
    () => service.mountWorkspace({
      token: WRITE,
      workspaceId: a.workspaceId,
      parentGroupId: aGroup.groupId,
      sourceWorkspaceId: a.workspaceId,
      expectedRevision: aMount.revision,
    }),
    (error) => isCode(error, ERROR_CODES.MOUNT_CYCLE),
  );
  await assert.rejects(
    () => service.mountWorkspace({
      token: WRITE,
      workspaceId: a.workspaceId,
      parentGroupId: aGroup.groupId,
      sourceWorkspaceId: b.workspaceId,
      expectedRevision: aMount.revision,
    }),
    (error) => isCode(error, ERROR_CODES.MOUNT_CONFLICT),
  );

  const bMount = await service.mountWorkspace({
    token: WRITE,
    workspaceId: b.workspaceId,
    parentGroupId: bGroup.groupId,
    sourceWorkspaceId: c.workspaceId,
    expectedRevision: bGroup.revision,
  });
  await assert.rejects(
    () => service.mountWorkspace({
      token: WRITE,
      workspaceId: c.workspaceId,
      parentGroupId: cGroup.groupId,
      sourceWorkspaceId: a.workspaceId,
      expectedRevision: cGroup.revision,
    }),
    (error) => isCode(error, ERROR_CODES.MOUNT_CYCLE),
  );

  const names = await createGroup(
    service,
    a.workspaceId,
    aMount.revision,
    'linked',
    aGroup.groupId,
  );
  await assert.rejects(
    () => service.mountWorkspace({
      token: WRITE,
      workspaceId: a.workspaceId,
      parentGroupId: aGroup.groupId,
      sourceWorkspaceId: c.workspaceId,
      name: 'linked',
      expectedRevision: names.revision,
    }),
    (error) => isCode(error, ERROR_CODES.MOUNT_NAME_CONFLICT),
  );
  await assert.rejects(
    () => createGroup(service, a.workspaceId, names.revision, 'linked', aGroup.groupId),
    (error) => isCode(error, ERROR_CODES.GROUP_NAME_CONFLICT),
  );

  const tree = await service.queryTree({ token: READ, workspaceId: a.workspaceId });
  assert.equal(tree.workspace.revision, names.revision);
  assert.equal(bMount.revision, 3);
});

test('persists mounts after reopen without copying source members', async () => {
  const file = await tempFile('zterm-org-');
  const service = makeService(file);
  const target = await createWorkspace(service, 'Target');
  const source = await createWorkspace(service, 'Source');
  const targetGroup = await createGroup(service, target.workspaceId, target.revision, 'people');
  const sourceGroup = await createGroup(service, source.workspaceId, source.revision, 'people');
  const sourceMember = await addMember(
    service,
    source.workspaceId,
    sourceGroup.revision,
    sourceGroup.groupId,
    'Source Worker',
  );
  const mount = await service.mountWorkspace({
    token: WRITE,
    workspaceId: target.workspaceId,
    parentGroupId: targetGroup.groupId,
    sourceWorkspaceId: source.workspaceId,
    expectedRevision: targetGroup.revision,
  });

  const reopened = makeService(file);
  const targetTree = await reopened.queryTree({ token: READ, workspaceId: target.workspaceId });
  const sourceTree = await reopened.queryTree({ token: READ, workspaceId: source.workspaceId });
  const targetNode = findGroup(targetTree, targetGroup.groupId);

  assert.deepEqual(targetNode.mounts, [
    {
      mountId: mount.mountId,
      workspaceId: target.workspaceId,
      groupId: targetGroup.groupId,
      sourceWorkspaceId: source.workspaceId,
      name: 'Source',
    },
  ]);
  assert.deepEqual(targetNode.members, []);
  assert.deepEqual(
    findGroup(sourceTree, sourceGroup.groupId).members.map((entry) => entry.memberId),
    [sourceMember.memberId],
  );
});

test('unmounts only the reference and increments the target revision', async () => {
  const file = await tempFile('zterm-org-');
  const service = makeService(file);
  const target = await createWorkspace(service, 'Target');
  const source = await createWorkspace(service, 'Source');
  const targetGroup = await createGroup(service, target.workspaceId, target.revision, 'people');
  const sourceGroup = await createGroup(service, source.workspaceId, source.revision, 'people');
  const sourceMember = await addMember(
    service,
    source.workspaceId,
    sourceGroup.revision,
    sourceGroup.groupId,
    'Source Worker',
  );
  const mount = await service.mountWorkspace({
    token: WRITE,
    workspaceId: target.workspaceId,
    parentGroupId: targetGroup.groupId,
    sourceWorkspaceId: source.workspaceId,
    expectedRevision: targetGroup.revision,
  });

  const removed = await service.unmountWorkspace({
    token: WRITE,
    workspaceId: target.workspaceId,
    mountId: mount.mountId,
    expectedRevision: mount.revision,
  });
  assert.deepEqual(removed, {
    workspaceId: target.workspaceId,
    mountId: mount.mountId,
    revision: mount.revision + 1,
  });

  const targetTree = await service.queryTree({ token: READ, workspaceId: target.workspaceId });
  const sourceTree = await service.queryTree({ token: READ, workspaceId: source.workspaceId });
  assert.deepEqual(findGroup(targetTree, targetGroup.groupId).mounts, []);
  assert.deepEqual(
    findGroup(sourceTree, sourceGroup.groupId).members.map((entry) => entry.memberId),
    [sourceMember.memberId],
  );
});

test('never exposes members runtime fields through organization outputs', async () => {
  const file = await tempFile('zterm-org-');
  const service = makeService(file);
  const workspace = await createWorkspace(service);
  const member = await service.addMember({
    token: WRITE,
    workspaceId: workspace.workspaceId,
    groupId: workspace.rootGroupId,
    name: 'Worker',
    expectedRevision: workspace.revision,
    machineId: 'should-not-be-owned',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'should-not-be-copied',
  });
  const tree = await service.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  const treeMember = allMembers(tree).find((entry) => entry.memberId === member.memberId);
  const workspaceRead = await service.readWorkspace(workspace.workspaceId);
  const memberRead = await service.getMember(member.memberId);
  const expectedKeys = ['groupId', 'managerMemberId', 'memberId', 'name', 'workspaceId'];

  assert.deepEqual(Object.keys(treeMember).sort(), expectedKeys);
  assert.deepEqual(Object.keys(workspaceRead.members[0]).sort(), expectedKeys);
  assert.deepEqual(Object.keys(memberRead).sort(), expectedKeys);
});

test('filters denied members from query results and blocks their mutations', async () => {
  const file = await tempFile('zterm-org-');
  const writer = makeService(file);
  const workspace = await createWorkspace(writer);
  const visibleGroup = await createGroup(writer, workspace.workspaceId, 1, 'visible');
  const hiddenGroup = await createGroup(writer, workspace.workspaceId, visibleGroup.revision, 'hidden');
  const visible = await addMember(
    writer,
    workspace.workspaceId,
    hiddenGroup.revision,
    visibleGroup.groupId,
    'Visible',
  );
  const hidden = await addMember(
    writer,
    workspace.workspaceId,
    visible.revision,
    hiddenGroup.groupId,
    'Hidden',
  );
  const reader = makeService(file, {
    'member-allowlist': {
      accountId: 'acct-member-allowlist',
      scopes: ['org:write', 'org:read'],
      workspaces: '*',
      members: [visible.memberId],
    },
  });

  const filtered = await reader.queryTree({
    token: 'member-allowlist',
    workspaceId: workspace.workspaceId,
  });
  assert.deepEqual(allMembers(filtered).map((entry) => entry.memberId), [visible.memberId]);
  assert.equal(allMembers(filtered).some((entry) => entry.memberId === hidden.memberId), false);

  await assert.rejects(
    () => reader.updateMember({
      token: 'member-allowlist',
      workspaceId: workspace.workspaceId,
      memberId: hidden.memberId,
      name: 'Denied',
      expectedRevision: hidden.revision,
    }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN),
  );
  await assert.rejects(
    () => reader.deleteMember({
      token: 'member-allowlist',
      workspaceId: workspace.workspaceId,
      memberId: hidden.memberId,
      expectedRevision: hidden.revision,
    }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN),
  );
  await assert.rejects(
    () => reader.addMember({
      token: 'member-allowlist',
      workspaceId: workspace.workspaceId,
      groupId: visibleGroup.groupId,
      name: 'New',
      expectedRevision: hidden.revision,
    }),
    (error) => isCode(error, ERROR_CODES.ORGANIZATION_FORBIDDEN),
  );

  const after = await writer.queryTree({ token: READ, workspaceId: workspace.workspaceId });
  assert.equal(after.workspace.revision, hidden.revision);
});

test('serializes simultaneous A->B and B->A mounts into one MOUNT_CYCLE and acyclic reopen', async () => {
  const file = await tempFile('zterm-org-');
  const service = makeService(file);
  const a = await createWorkspace(service, 'A');
  const b = await createWorkspace(service, 'B');
  const aGroup = await createGroup(service, a.workspaceId, a.revision, 'people');
  const bGroup = await createGroup(service, b.workspaceId, b.revision, 'people');

  const settled = await Promise.allSettled([
    service.mountWorkspace({
      token: WRITE,
      workspaceId: a.workspaceId,
      parentGroupId: aGroup.groupId,
      sourceWorkspaceId: b.workspaceId,
      expectedRevision: aGroup.revision,
    }),
    service.mountWorkspace({
      token: WRITE,
      workspaceId: b.workspaceId,
      parentGroupId: bGroup.groupId,
      sourceWorkspaceId: a.workspaceId,
      expectedRevision: bGroup.revision,
    }),
  ]);

  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
  const rejected = settled.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(isCode(rejected[0].reason, ERROR_CODES.MOUNT_CYCLE));

  const reopened = makeService(file);
  const trees = {
    [a.workspaceId]: await reopened.queryTree({ token: READ, workspaceId: a.workspaceId }),
    [b.workspaceId]: await reopened.queryTree({ token: READ, workspaceId: b.workspaceId }),
  };

  const edges = mountEdges(trees);
  assert.equal(edges.length, 1);
  assertAcyclic(trees);
});

function mountEdges(trees) {
  return Object.values(trees).flatMap((tree) =>
    walk(tree.root).flatMap((group) =>
      group.mounts.map((mount) => ({
        from: mount.workspaceId,
        to: mount.sourceWorkspaceId,
        mountId: mount.mountId,
      })),
    ),
  );
}

function assertAcyclic(trees) {
  const edges = new Map();
  for (const tree of Object.values(trees)) {
    for (const group of walk(tree.root)) {
      edges.set(group.workspaceId, [
        ...(edges.get(group.workspaceId) ?? []),
        ...group.mounts.map((mount) => mount.sourceWorkspaceId),
      ]);
    }
  }

  const visiting = new Set();
  const done = new Set();
  function visit(workspaceId, path) {
    if (done.has(workspaceId)) return;
    assert.equal(
      visiting.has(workspaceId),
      false,
      `mount cycle: ${[...path, workspaceId].join(' -> ')}`,
    );
    visiting.add(workspaceId);
    for (const next of edges.get(workspaceId) ?? []) {
      visit(next, [...path, workspaceId]);
    }
    visiting.delete(workspaceId);
    done.add(workspaceId);
  }

  for (const workspaceId of edges.keys()) {
    visit(workspaceId, []);
  }
}

