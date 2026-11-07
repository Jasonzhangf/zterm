import { ERROR_CODES, fail } from '../public/typed-error.mjs';
import { requireString } from '../public/boundary.mjs';
import { newId } from '../domain/ids.mjs';
import { assertPathSegment, computePath } from '../domain/group-path.mjs';

const MODULE = 'organization';

export function createOrganizationService({ store, auth }) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('organization service requires a store with read() and update()');
  }
  if (!auth || typeof auth.verify !== 'function') {
    throw new TypeError('organization service requires an auth adapter with verify(token)');
  }

  async function authorize(token) {
    return auth.verify(token);
  }

  function requireScope(context, scope, operationId) {
    if (!Array.isArray(context?.scopes) || !context.scopes.includes(scope)) {
      fail(ERROR_CODES.ORGANIZATION_FORBIDDEN, `missing ${scope} scope`, {
        owningModule: MODULE,
        operationId,
      });
    }
  }

  function hasWorkspace(context, workspaceId) {
    if (context?.workspaces === '*') return true;
    return Array.isArray(context?.workspaces) && context.workspaces.includes(workspaceId);
  }

  function requireWorkspaceAccess(context, workspaceId, scope, operationId) {
    requireScope(context, scope, operationId);
    if (!hasWorkspace(context, workspaceId)) {
      fail(ERROR_CODES.ORGANIZATION_FORBIDDEN, `workspace ${workspaceId} is not allowed`, {
        owningModule: MODULE,
        operationId,
      });
    }
  }

  function requireCreateWorkspaceAccess(context, operationId) {
    requireScope(context, 'org:write', operationId);
    if (context.workspaces !== '*') {
      fail(ERROR_CODES.ORGANIZATION_FORBIDDEN, 'createWorkspace requires all workspaces', {
        owningModule: MODULE,
        operationId,
      });
    }
  }

  function requireMemberCreationAccess(context, operationId) {
    if (context.members !== undefined) {
      fail(ERROR_CODES.ORGANIZATION_FORBIDDEN, 'member allowlist forbids member creation', {
        owningModule: MODULE,
        operationId,
      });
    }
  }

  function requireMemberAllowlisted(context, memberId, operationId) {
    if (context.members === undefined) return;
    if (!Array.isArray(context.members) || !context.members.includes(memberId)) {
      fail(ERROR_CODES.ORGANIZATION_FORBIDDEN, `member ${memberId} is not allowed`, {
        owningModule: MODULE,
        operationId,
      });
    }
  }

  function isMemberVisible(context, memberId) {
    if (context.members === undefined) return true;
    return Array.isArray(context.members) && context.members.includes(memberId);
  }

  function requireRevisionInput(expectedRevision, operationId) {
    if (!Number.isInteger(expectedRevision)) {
      fail(ERROR_CODES.ORGANIZATION_REVISION_STALE, 'expectedRevision is required', {
        owningModule: MODULE,
        operationId,
        details: { expectedRevision: expectedRevision ?? null, currentRevision: null },
      });
    }
  }

  function requireCurrentRevision(expectedRevision, workspace, operationId) {
    if (workspace.revision !== expectedRevision) {
      fail(
        ERROR_CODES.ORGANIZATION_REVISION_STALE,
        `workspace revision changed from ${expectedRevision} to ${workspace.revision}`,
        {
          owningModule: MODULE,
          operationId,
          details: {
            expectedRevision,
            currentRevision: workspace.revision,
          },
        },
      );
    }
  }

  async function createWorkspace({ token, name, rootGroupName } = {}) {
    const context = await authorize(token);
    requireCreateWorkspaceAccess(context, 'createWorkspace');
    requireString(name, 'name', MODULE);
    assertPathSegment(name, MODULE);
    const resolvedRootName = rootGroupName ?? name;
    requireString(resolvedRootName, 'rootGroupName', MODULE);
    assertPathSegment(resolvedRootName, MODULE);

    return store.update((state) => {
      const workspaceId = newId('ws');
      const rootGroupId = newId('grp');
      const workspace = { workspaceId, name, rootGroupId, revision: 1 };
      state.workspaces[workspaceId] = workspace;
      state.groups[rootGroupId] = {
        groupId: rootGroupId,
        workspaceId,
        parentGroupId: null,
        name: resolvedRootName,
        path: computePath(null, resolvedRootName),
      };
      return { ...workspace };
    });
  }

  async function createGroup({
    token,
    workspaceId,
    name,
    parentGroupId = null,
    expectedRevision,
  } = {}) {
    const context = await authorize(token);
    requireWorkspaceAccess(context, workspaceId, 'org:write', 'createGroup');
    requireString(workspaceId, 'workspaceId', MODULE);
    requireString(name, 'name', MODULE);
    assertPathSegment(name, MODULE);
    if (parentGroupId !== null) requireString(parentGroupId, 'parentGroupId', MODULE);
    requireRevisionInput(expectedRevision, 'createGroup');

    return store.update((state) => {
      const workspace = findWorkspace(state, workspaceId);
      requireCurrentRevision(expectedRevision, workspace, 'createGroup');
      const resolvedParentId = parentGroupId ?? workspace.rootGroupId;
      const parent = findGroup(state, workspaceId, resolvedParentId);
      assertNodeNameAvailable(state, workspaceId, resolvedParentId, name, {
        operationId: 'createGroup',
        conflictCode: ERROR_CODES.GROUP_NAME_CONFLICT,
      });
      const groupId = newId('grp');
      const group = {
        groupId,
        workspaceId,
        parentGroupId: resolvedParentId,
        name,
        path: computePath(parent.path, name),
      };
      state.groups[groupId] = group;
      workspace.revision += 1;
      return { ...group, revision: workspace.revision };
    });
  }

  async function updateGroup({
    token,
    workspaceId,
    groupId,
    name,
    parentGroupId,
    expectedRevision,
  } = {}) {
    const context = await authorize(token);
    requireWorkspaceAccess(context, workspaceId, 'org:write', 'updateGroup');
    requireString(workspaceId, 'workspaceId', MODULE);
    requireString(groupId, 'groupId', MODULE);
    if (name !== undefined) {
      requireString(name, 'name', MODULE);
      assertPathSegment(name, MODULE);
    }
    if (parentGroupId !== undefined && parentGroupId !== null) {
      requireString(parentGroupId, 'parentGroupId', MODULE);
    }
    requireRevisionInput(expectedRevision, 'updateGroup');

    return store.update((state) => {
      const workspace = findWorkspace(state, workspaceId);
      requireCurrentRevision(expectedRevision, workspace, 'updateGroup');
      const group = findGroup(state, workspaceId, groupId);
      const resolvedName = name ?? group.name;
      const resolvedParentId = parentGroupId === undefined ? group.parentGroupId : parentGroupId;

      if (resolvedParentId === null && group.groupId !== workspace.rootGroupId) {
        fail(ERROR_CODES.VALIDATION, 'a non-root group cannot be moved to null', {
          owningModule: MODULE,
          operationId: 'updateGroup',
        });
      }
      if (group.groupId === workspace.rootGroupId && resolvedParentId !== null) {
        fail(ERROR_CODES.VALIDATION, 'the root group cannot be moved', {
          owningModule: MODULE,
          operationId: 'updateGroup',
        });
      }
      if (resolvedParentId !== null) {
        findGroup(state, workspaceId, resolvedParentId);
        if (
          resolvedParentId === group.groupId
          || isDescendantGroup(state, group.groupId, resolvedParentId)
        ) {
          fail(ERROR_CODES.VALIDATION, 'a group cannot move below itself or a descendant', {
            owningModule: MODULE,
            operationId: 'updateGroup',
          });
        }
      }
      assertNodeNameAvailable(state, workspaceId, resolvedParentId, resolvedName, {
        excludeGroupId: group.groupId,
        operationId: 'updateGroup',
        conflictCode: ERROR_CODES.GROUP_NAME_CONFLICT,
      });

      const parent = resolvedParentId === null ? null : state.groups[resolvedParentId];
      group.name = resolvedName;
      group.parentGroupId = resolvedParentId;
      recomputeSubtreePaths(state, group.groupId, computePath(parent?.path ?? null, resolvedName));
      workspace.revision += 1;
      return { ...group, revision: workspace.revision };
    });
  }

  async function deleteGroup({ token, workspaceId, groupId, expectedRevision } = {}) {
    const context = await authorize(token);
    requireWorkspaceAccess(context, workspaceId, 'org:write', 'deleteGroup');
    requireString(workspaceId, 'workspaceId', MODULE);
    requireString(groupId, 'groupId', MODULE);
    requireRevisionInput(expectedRevision, 'deleteGroup');

    return store.update((state) => {
      const workspace = findWorkspace(state, workspaceId);
      requireCurrentRevision(expectedRevision, workspace, 'deleteGroup');
      const group = findGroup(state, workspaceId, groupId);
      if (group.groupId === workspace.rootGroupId) {
        fail(ERROR_CODES.ROOT_GROUP_PROTECTED, 'the root group cannot be deleted', {
          owningModule: MODULE,
          operationId: 'deleteGroup',
        });
      }
      if (groupHasContent(state, group)) {
        fail(ERROR_CODES.GROUP_NOT_EMPTY, `group ${groupId} is not empty`, {
          owningModule: MODULE,
          operationId: 'deleteGroup',
        });
      }
      delete state.groups[groupId];
      workspace.revision += 1;
      return { workspaceId, groupId, revision: workspace.revision };
    });
  }

  async function addMember({
    token,
    workspaceId,
    groupId,
    name,
    managerMemberId,
    expectedRevision,
  } = {}) {
    return addMemberInternal({
      token,
      workspaceId,
      groupId,
      name,
      managerMemberId,
      expectedRevision,
    });
  }

  async function addMemberInternal({
    token,
    workspaceId,
    groupId,
    name,
    managerMemberId = null,
    expectedRevision,
  } = {}) {
    const context = await authorize(token);
    requireWorkspaceAccess(context, workspaceId, 'org:write', 'addMember');
    requireMemberCreationAccess(context, 'addMember');
    requireString(workspaceId, 'workspaceId', MODULE);
    requireString(groupId, 'groupId', MODULE);
    requireString(name, 'name', MODULE);
    assertPathSegment(name, MODULE);
    if (managerMemberId !== undefined && managerMemberId !== null) {
      requireString(managerMemberId, 'managerMemberId', MODULE);
    }
    requireRevisionInput(expectedRevision, 'addMember');

    return store.update((state) => {
      const workspace = findWorkspace(state, workspaceId);
      requireCurrentRevision(expectedRevision, workspace, 'addMember');
      findGroup(state, workspaceId, groupId);
      assertMemberNameAvailable(state, workspaceId, groupId, name, {
        operationId: 'addMember',
      });
      const memberId = newId('mbr');
      if (managerMemberId !== undefined && managerMemberId !== null) {
        const manager = findMember(state, workspaceId, managerMemberId);
        if (manager.memberId === memberId) {
          fail(ERROR_CODES.VALIDATION, 'a member cannot manage itself', {
            owningModule: MODULE,
            operationId: 'addMember',
          });
        }
      }
      const member = {
        memberId,
        workspaceId,
        groupId,
        name,
        managerMemberId: managerMemberId === undefined ? null : managerMemberId,
      };
      state.members[member.memberId] = member;
      workspace.revision += 1;
      return { ...member, revision: workspace.revision };
    });
  }

  async function updateMember({
    token,
    workspaceId,
    memberId,
    name,
    groupId,
    managerMemberId,
    expectedRevision,
  } = {}) {
    const context = await authorize(token);
    requireWorkspaceAccess(context, workspaceId, 'org:write', 'updateMember');
    requireMemberAllowlisted(context, memberId, 'updateMember');
    requireString(workspaceId, 'workspaceId', MODULE);
    requireString(memberId, 'memberId', MODULE);
    if (name !== undefined) {
      requireString(name, 'name', MODULE);
      assertPathSegment(name, MODULE);
    }
    if (groupId !== undefined) requireString(groupId, 'groupId', MODULE);
    if (managerMemberId !== undefined && managerMemberId !== null) {
      requireString(managerMemberId, 'managerMemberId', MODULE);
      requireMemberAllowlisted(context, managerMemberId, 'updateMember');
    }
    requireRevisionInput(expectedRevision, 'updateMember');

    return store.update((state) => {
      const workspace = findWorkspace(state, workspaceId);
      requireCurrentRevision(expectedRevision, workspace, 'updateMember');
      const member = findMember(state, workspaceId, memberId);
      const resolvedManagerId = managerMemberId === undefined
        ? member.managerMemberId ?? null
        : managerMemberId;
      if (managerMemberId !== undefined && resolvedManagerId !== (member.managerMemberId ?? null)) {
        const oldManagerId = member.managerMemberId ?? null;
        if (oldManagerId !== null && !isMemberVisible(context, oldManagerId)) {
          fail(ERROR_CODES.ORGANIZATION_FORBIDDEN, 'member relation update is not allowed', {
            owningModule: MODULE,
            operationId: 'updateMember',
          });
        }
      }
      if (resolvedManagerId !== null) {
        const manager = findMember(state, workspaceId, resolvedManagerId);
        if (manager.memberId === member.memberId) {
          fail(ERROR_CODES.VALIDATION, 'a member cannot manage itself', {
            owningModule: MODULE,
            operationId: 'updateMember',
          });
        }
        if (managerIsDescendantOf(state, manager, member.memberId)) {
          fail(ERROR_CODES.VALIDATION, 'manager relation would form a cycle', {
            owningModule: MODULE,
            operationId: 'updateMember',
          });
        }
      }
      const resolvedName = name ?? member.name;
      const resolvedGroupId = groupId ?? member.groupId;
      findGroup(state, workspaceId, resolvedGroupId);
      assertMemberNameAvailable(state, workspaceId, resolvedGroupId, resolvedName, {
        excludeMemberId: member.memberId,
        operationId: 'updateMember',
      });
      member.name = resolvedName;
      member.groupId = resolvedGroupId;
      member.managerMemberId = resolvedManagerId;
      workspace.revision += 1;
      return { ...memberCopy(member, context.members), revision: workspace.revision };
    });
  }

  async function deleteMember({ token, workspaceId, memberId, expectedRevision } = {}) {
    const context = await authorize(token);
    requireWorkspaceAccess(context, workspaceId, 'org:write', 'deleteMember');
    requireMemberAllowlisted(context, memberId, 'deleteMember');
    requireString(workspaceId, 'workspaceId', MODULE);
    requireString(memberId, 'memberId', MODULE);
    requireRevisionInput(expectedRevision, 'deleteMember');

    return store.update((state) => {
      const workspace = findWorkspace(state, workspaceId);
      requireCurrentRevision(expectedRevision, workspace, 'deleteMember');
      const member = findMember(state, workspaceId, memberId);
      const directReports = Object.values(state.members)
        .filter((candidate) => candidate.workspaceId === workspaceId)
        .filter((candidate) => candidate.managerMemberId === member.memberId);
      if (directReports.length > 0) {
        fail(ERROR_CODES.MANAGER_HAS_DIRECT_REPORTS, `member ${memberId} still has direct reports`, {
          owningModule: MODULE,
          operationId: 'deleteMember',
          details: {
            workspaceId,
            managerMemberId: member.memberId,
            directReportCount: directReports.length,
          },
        });
      }
      delete state.members[memberId];
      workspace.revision += 1;
      return { workspaceId, memberId, revision: workspace.revision };
    });
  }

  async function mountWorkspace({
    token,
    workspaceId,
    parentGroupId,
    sourceWorkspaceId,
    name,
    expectedRevision,
  } = {}) {
    const context = await authorize(token);
    requireWorkspaceAccess(context, workspaceId, 'org:write', 'mountWorkspace');
    requireWorkspaceAccess(context, sourceWorkspaceId, 'org:read', 'mountWorkspace');
    requireString(workspaceId, 'workspaceId', MODULE);
    requireString(parentGroupId, 'parentGroupId', MODULE);
    requireString(sourceWorkspaceId, 'sourceWorkspaceId', MODULE);
    if (name !== undefined) {
      requireString(name, 'name', MODULE);
      assertPathSegment(name, MODULE);
    }
    requireRevisionInput(expectedRevision, 'mountWorkspace');

    return store.update((state) => {
      const workspace = findWorkspace(state, workspaceId);
      const parent = findGroup(state, workspaceId, parentGroupId);
      const sourceWorkspace = findWorkspace(state, sourceWorkspaceId);
      requireCurrentRevision(expectedRevision, workspace, 'mountWorkspace');

      if (workspaceId === sourceWorkspaceId) {
        fail(ERROR_CODES.MOUNT_CYCLE, 'a workspace cannot mount itself', {
          owningModule: MODULE,
          operationId: 'mountWorkspace',
        });
      }
      if (reachesWorkspace(state, sourceWorkspaceId, workspaceId)) {
        fail(ERROR_CODES.MOUNT_CYCLE, 'source workspace reaches the target workspace', {
          owningModule: MODULE,
          operationId: 'mountWorkspace',
          details: { targetWorkspaceId: workspaceId, sourceWorkspaceId },
        });
      }
      if (
        Object.values(state.mounts).some(
          (mount) => mount.workspaceId === workspaceId
            && mount.groupId === parent.groupId
            && mount.sourceWorkspaceId === sourceWorkspaceId,
        )
      ) {
        fail(ERROR_CODES.MOUNT_CONFLICT, 'the exact source is already mounted here', {
          owningModule: MODULE,
          operationId: 'mountWorkspace',
          details: { workspaceId, parentGroupId: parent.groupId, sourceWorkspaceId },
        });
      }

      const resolvedName = name ?? sourceWorkspace.name;
      assertNodeNameAvailable(state, workspaceId, parent.groupId, resolvedName, {
        operationId: 'mountWorkspace',
        conflictCode: ERROR_CODES.MOUNT_NAME_CONFLICT,
      });
      const mount = {
        mountId: newId('mnt'),
        workspaceId,
        groupId: parent.groupId,
        sourceWorkspaceId,
        name: resolvedName,
      };
      state.mounts[mount.mountId] = mount;
      workspace.revision += 1;
      return { ...mount, revision: workspace.revision };
    });
  }

  async function unmountWorkspace({ token, workspaceId, mountId, expectedRevision } = {}) {
    const context = await authorize(token);
    requireWorkspaceAccess(context, workspaceId, 'org:write', 'unmountWorkspace');
    requireString(workspaceId, 'workspaceId', MODULE);
    requireString(mountId, 'mountId', MODULE);
    requireRevisionInput(expectedRevision, 'unmountWorkspace');

    return store.update((state) => {
      const workspace = findWorkspace(state, workspaceId);
      requireCurrentRevision(expectedRevision, workspace, 'unmountWorkspace');
      const mount = state.mounts[mountId];
      if (!mount || mount.workspaceId !== workspaceId) {
        fail(ERROR_CODES.MOUNT_NOT_FOUND, `unknown mount ${mountId}`, {
          owningModule: MODULE,
          operationId: 'unmountWorkspace',
        });
      }
      delete state.mounts[mountId];
      workspace.revision += 1;
      return { workspaceId, mountId, revision: workspace.revision };
    });
  }

  async function queryTree({ token, workspaceId } = {}) {
    const context = await authorize(token);
    requireWorkspaceAccess(context, workspaceId, 'org:read', 'queryTree');
    requireString(workspaceId, 'workspaceId', MODULE);
    const state = await store.read();
    const workspace = findWorkspace(state, workspaceId);
    return buildTree(state, workspace, context.members);
  }

  // Authorized workspace catalog for WebUI navigation. Accounts owns account
  // identity and workspace grants; organization only lists the structural
  // workspace records the verified AuthContext may read. The result is stable
  // references plus display names, not a second organization model.
  async function listWorkspaces({ token } = {}) {
    const context = await authorize(token);
    requireScope(context, 'org:read', 'listWorkspaces');
    const state = await store.read();
    return Object.values(state.workspaces)
      .filter((workspace) => hasWorkspace(context, workspace.workspaceId))
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        revision: workspace.revision,
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.workspaceId.localeCompare(right.workspaceId));
  }

  async function listDirectReports({ token, workspaceId, managerMemberId } = {}) {
    const context = await authorize(token);
    requireWorkspaceAccess(context, workspaceId, 'org:read', 'listDirectReports');
    requireString(workspaceId, 'workspaceId', MODULE);
    requireString(managerMemberId, 'managerMemberId', MODULE);
    requireMemberAllowlisted(context, managerMemberId, 'listDirectReports');

    const state = await store.read();
    const workspace = findWorkspace(state, workspaceId);
    findMember(state, workspaceId, managerMemberId);
    const directMemberIds = Object.values(state.members)
      .filter((member) => member.workspaceId === workspace.workspaceId)
      .filter((member) => member.managerMemberId === managerMemberId)
      .filter((member) => isMemberVisible(context, member.memberId))
      .map((member) => member.memberId);
    return {
      workspaceId: workspace.workspaceId,
      managerMemberId,
      directMemberIds,
      revision: workspace.revision,
    };
  }

  // Read ports for members and routing. They never mutate and never take auth; the
  // composing caller already authenticated the request.
  async function readWorkspace(workspaceId) {
    const state = await store.read();
    const workspace = state.workspaces[workspaceId];
    if (!workspace) return null;
    return {
      workspace: { ...workspace },
      groups: Object.values(state.groups)
        .filter((group) => group.workspaceId === workspaceId)
        .map((group) => ({ ...group })),
      members: Object.values(state.members)
        .filter((member) => member.workspaceId === workspaceId)
        .map((member) => memberCopy(member)),
    };
  }

  async function getMember(memberId) {
    const state = await store.read();
    const member = state.members[memberId];
    return member ? memberCopy(member) : null;
  }

  return Object.freeze({
    createWorkspace,
    createGroup,
    updateGroup,
    deleteGroup,
    addMember,
    updateMember,
    deleteMember,
    mountWorkspace,
    unmountWorkspace,
    queryTree,
    listWorkspaces,
    listDirectReports,
    readWorkspace,
    getMember,
  });
}

function findWorkspace(state, workspaceId) {
  const workspace = state.workspaces[workspaceId];
  if (!workspace) {
    fail(ERROR_CODES.WORKSPACE_NOT_FOUND, `unknown workspace ${workspaceId}`, {
      owningModule: MODULE,
    });
  }
  return workspace;
}

function findGroup(state, workspaceId, groupId) {
  const group = state.groups[groupId];
  if (!group || group.workspaceId !== workspaceId) {
    fail(ERROR_CODES.GROUP_NOT_FOUND, `unknown group ${groupId}`, {
      owningModule: MODULE,
    });
  }
  return group;
}

function findMember(state, workspaceId, memberId) {
  const member = state.members[memberId];
  if (!member || member.workspaceId !== workspaceId) {
    fail(ERROR_CODES.MEMBER_NOT_FOUND, `unknown member ${memberId}`, {
      owningModule: MODULE,
    });
  }
  return member;
}

function assertNodeNameAvailable(
  state,
  workspaceId,
  parentGroupId,
  name,
  { excludeGroupId, conflictCode, operationId },
) {
  const duplicateGroup = Object.values(state.groups).find(
    (group) => group.workspaceId === workspaceId
      && group.parentGroupId === parentGroupId
      && group.name === name
      && group.groupId !== excludeGroupId,
  );
  const duplicateMount = Object.values(state.mounts).find(
    (mount) => mount.workspaceId === workspaceId
      && mount.groupId === parentGroupId
      && mount.name === name,
  );
  if (duplicateGroup || duplicateMount) {
    fail(conflictCode, `node name ${name} already exists under ${parentGroupId}`, {
      owningModule: MODULE,
      operationId,
      details: { workspaceId, parentGroupId, name },
    });
  }
}

function assertMemberNameAvailable(state, workspaceId, groupId, name, { excludeMemberId, operationId }) {
  const duplicate = Object.values(state.members).some(
    (member) => member.workspaceId === workspaceId
      && member.groupId === groupId
      && member.name === name
      && member.memberId !== excludeMemberId,
  );
  if (duplicate) {
    fail(ERROR_CODES.MEMBER_NAME_CONFLICT, `member name ${name} already exists in ${groupId}`, {
      owningModule: MODULE,
      operationId,
      details: { workspaceId, groupId, name },
    });
  }
}

function groupHasContent(state, group) {
  return Object.values(state.groups).some((candidate) => candidate.parentGroupId === group.groupId)
    || Object.values(state.members).some((member) => member.groupId === group.groupId)
    || Object.values(state.mounts).some((mount) => mount.groupId === group.groupId);
}

function isDescendantGroup(state, ancestorGroupId, candidateGroupId) {
  let current = state.groups[candidateGroupId];
  while (current) {
    if (current.parentGroupId === ancestorGroupId) return true;
    current = current.parentGroupId === null ? null : state.groups[current.parentGroupId];
  }
  return false;
}

function managerIsDescendantOf(state, manager, reportId) {
  const visited = new Set();
  let current = manager;
  while (current && !visited.has(current.memberId)) {
    if (current.memberId === reportId) return true;
    visited.add(current.memberId);
    current = current.managerMemberId === null || current.managerMemberId === undefined
      ? null
      : state.members[current.managerMemberId];
  }
  return false;
}

function recomputeSubtreePaths(state, groupId, path) {
  const group = state.groups[groupId];
  if (!group) return;
  group.path = path;
  for (const child of Object.values(state.groups)) {
    if (child.parentGroupId !== groupId) continue;
    recomputeSubtreePaths(state, child.groupId, computePath(path, child.name));
  }
}

function reachesWorkspace(state, fromWorkspaceId, targetWorkspaceId) {
  const visited = new Set();
  const queue = [fromWorkspaceId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === targetWorkspaceId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const mount of Object.values(state.mounts)) {
      if (mount.workspaceId === current) queue.push(mount.sourceWorkspaceId);
    }
  }
  return false;
}

function buildTree(state, workspace, memberAllowlist) {
  const nodes = new Map();
  for (const group of Object.values(state.groups)) {
    if (group.workspaceId !== workspace.workspaceId) continue;
    nodes.set(group.groupId, { ...group, members: [], children: [], mounts: [] });
  }
  let root = null;
  for (const node of nodes.values()) {
    if (node.parentGroupId === null) {
      root = node;
      continue;
    }
    nodes.get(node.parentGroupId)?.children.push(node);
  }
  for (const member of Object.values(state.members)) {
    if (member.workspaceId !== workspace.workspaceId) continue;
    if (memberAllowlist !== undefined && !memberAllowlist.includes(member.memberId)) continue;
    nodes.get(member.groupId)?.members.push(memberCopy(member, memberAllowlist));
  }
  for (const mount of Object.values(state.mounts)) {
    if (mount.workspaceId !== workspace.workspaceId) continue;
    nodes.get(mount.groupId)?.mounts.push({ ...mount });
  }
  sortTree(root);
  return { workspace: { ...workspace }, root };
}

function sortTree(node) {
  if (!node) return;
  node.children.sort((a, b) => a.path.localeCompare(b.path));
  node.members.sort((a, b) => a.name.localeCompare(b.name) || a.memberId.localeCompare(b.memberId));
  node.mounts.sort((a, b) => a.name.localeCompare(b.name) || a.mountId.localeCompare(b.mountId));
  for (const child of node.children) sortTree(child);
}

function memberCopy(member, visibleMemberIds) {
  const managerVisible = visibleMemberIds === undefined || visibleMemberIds.includes(member.managerMemberId);
  return {
    memberId: member.memberId,
    workspaceId: member.workspaceId,
    groupId: member.groupId,
    name: member.name,
    managerMemberId: managerVisible ? member.managerMemberId ?? null : null,
  };
}
