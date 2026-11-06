import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ERROR_CODES,
  createDevVerifiedAuth,
  createOrganizationService,
  createOrganizationStore,
  isTypedError,
} from '../../modules/organization/src/public/index.mjs';

const auth = createDevVerifiedAuth({
  accounts: {
    write: {
      accountId: 'acct-self-check',
      scopes: ['org:write', 'org:read'],
      workspaces: '*',
    },
    read: {
      accountId: 'acct-self-check-read',
      scopes: ['org:read'],
      workspaces: '*',
    },
  },
});

const dir = await mkdtemp(join(tmpdir(), 'zterm-org-self-check-'));
const file = join(dir, 'organization.json');
const service = createOrganizationService({ store: createOrganizationStore(file), auth });

try {
  const target = await service.createWorkspace({ token: 'write', name: 'Target' });
  const source = await service.createWorkspace({ token: 'write', name: 'Source' });
  const targetGroup = await service.createGroup({
    token: 'write',
    workspaceId: target.workspaceId,
    name: 'people',
    expectedRevision: target.revision,
  });
  const sourceGroup = await service.createGroup({
    token: 'write',
    workspaceId: source.workspaceId,
    name: 'people',
    expectedRevision: source.revision,
  });
  const sourceMember = await service.addMember({
    token: 'write',
    workspaceId: source.workspaceId,
    groupId: sourceGroup.groupId,
    name: 'Source Worker',
    expectedRevision: sourceGroup.revision,
  });

  const mount = await service.mountWorkspace({
    token: 'write',
    workspaceId: target.workspaceId,
    parentGroupId: targetGroup.groupId,
    sourceWorkspaceId: source.workspaceId,
    expectedRevision: targetGroup.revision,
  });
  assert.equal(mount.revision, 3);

  const tree = await service.queryTree({ token: 'read', workspaceId: target.workspaceId });
  const targetNode = tree.root.children.find((group) => group.groupId === targetGroup.groupId);
  assert.deepEqual(targetNode.mounts.map((entry) => entry.sourceWorkspaceId), [source.workspaceId]);

  await assert.rejects(
    () => service.mountWorkspace({
      token: 'write',
      workspaceId: target.workspaceId,
      parentGroupId: targetGroup.groupId,
      sourceWorkspaceId: target.workspaceId,
      expectedRevision: mount.revision,
    }),
    (error) => isTypedError(error) && error.code === ERROR_CODES.MOUNT_CYCLE,
  );
  await assert.rejects(
    () => service.mountWorkspace({
      token: 'write',
      workspaceId: target.workspaceId,
      parentGroupId: targetGroup.groupId,
      sourceWorkspaceId: source.workspaceId,
      expectedRevision: mount.revision,
    }),
    (error) => isTypedError(error) && error.code === ERROR_CODES.MOUNT_CONFLICT,
  );
  await assert.rejects(
    () => service.addMember({
      token: 'write',
      workspaceId: source.workspaceId,
      groupId: sourceGroup.groupId,
      name: 'Source Worker',
      expectedRevision: mount.revision,
    }),
    (error) => isTypedError(error) && error.code === ERROR_CODES.MEMBER_NAME_CONFLICT,
  );
  await assert.rejects(
    () => service.createGroup({
      token: 'write',
      workspaceId: target.workspaceId,
      name: 'stale',
      expectedRevision: 99,
    }),
    (error) => isTypedError(error) && error.code === ERROR_CODES.ORGANIZATION_REVISION_STALE,
  );

  const reopened = createOrganizationService({ store: createOrganizationStore(file), auth });
  const reopenedTree = await reopened.queryTree({ token: 'read', workspaceId: target.workspaceId });
  const reopenedNode = reopenedTree.root.children.find((group) => group.groupId === targetGroup.groupId);
  assert.equal(reopenedNode.mounts[0].mountId, mount.mountId);
  assert.deepEqual(reopenedNode.members, []);
  assert.equal(reopenedNode.mounts[0].name, 'Source');

  const sourceTree = await reopened.queryTree({ token: 'read', workspaceId: source.workspaceId });
  const sourceNode = sourceTree.root.children.find((group) => group.groupId === sourceGroup.groupId);
  assert.deepEqual(sourceNode.members.map((entry) => entry.memberId), [sourceMember.memberId]);
  assert.equal(Object.hasOwn(sourceNode.members[0], 'machineId'), false);
  assert.equal(Object.hasOwn(sourceNode.members[0], 'hostKind'), false);

  const removed = await reopened.unmountWorkspace({
    token: 'write',
    workspaceId: target.workspaceId,
    mountId: mount.mountId,
    expectedRevision: mount.revision,
  });
  assert.equal(removed.revision, mount.revision + 1);

  const afterUnmount = await reopened.queryTree({ token: 'read', workspaceId: target.workspaceId });
  const afterNode = afterUnmount.root.children.find((group) => group.groupId === targetGroup.groupId);
  assert.deepEqual(afterNode.mounts, []);

  console.log('organization-receipt-ok');
} finally {
  await rm(dir, { recursive: true, force: true });
}
