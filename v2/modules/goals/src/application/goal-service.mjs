import { ERROR_CODES, fail, requireString } from '../../../organization/src/public/index.mjs';
import { randomUUID } from 'node:crypto';

import {
  GOAL_ERROR_CODES,
} from '../public/errors.mjs';
import {
  GOAL_STATUSES,
  goalCopy,
  hasChildGoal,
  isGoalDescendant,
  isGoalStatus,
} from '../domain/goal.mjs';
import { assertGoalReferenceReader, assertGoalStore } from '../ports/goal-store.mjs';

const MODULE = 'goals';
const READ_SCOPE = 'goals:read';
const WRITE_SCOPE = 'goals:write';

export function createGoalService({ store, auth, organization, references }) {
  assertGoalStore(store);
  assertGoalReferenceReader(references);
  if (!auth || typeof auth.verify !== 'function') {
    throw new TypeError('goals service requires an auth adapter with verify(token)');
  }
  if (!organization || typeof organization.readWorkspace !== 'function') {
    throw new TypeError('goals service requires an organization reader with readWorkspace()');
  }

  async function authorize(token, scope, operationId) {
    const context = await auth.verify(token);
    if (!Array.isArray(context?.scopes) || !context.scopes.includes(scope)) {
      fail(GOAL_ERROR_CODES.GOAL_FORBIDDEN, `missing ${scope} scope`, {
        owningModule: MODULE,
        operationId,
        details: { requiredScope: scope },
      });
    }
    return context;
  }

  function workspaceAllowed(context, workspaceId) {
    const granted = context?.workspaces;
    if (granted === '*') return true;
    return Array.isArray(granted) && granted.includes(workspaceId);
  }

  function requireWorkspaceAccess(context, workspaceId, operationId) {
    if (!workspaceAllowed(context, workspaceId)) {
      fail(GOAL_ERROR_CODES.GOAL_FORBIDDEN, `workspace ${workspaceId} is not allowed`, {
        owningModule: MODULE,
        operationId,
      });
    }
  }

  async function readWorkspace(workspaceId, operationId) {
    const snapshot = await organization.readWorkspace(workspaceId);
    if (!snapshot) {
      fail(GOAL_ERROR_CODES.GOAL_WORKSPACE_NOT_FOUND, `unknown workspace ${workspaceId}`, {
        owningModule: MODULE,
        operationId,
      });
    }
    return snapshot;
  }

  function requireOwnerMember(snapshot, ownerMemberId, operationId) {
    const member = snapshot.members.some((candidate) => candidate.memberId === ownerMemberId);
    if (!member) {
      fail(GOAL_ERROR_CODES.GOAL_OWNER_INVALID, `member ${ownerMemberId} is not in workspace`, {
        owningModule: MODULE,
        operationId,
        details: { workspaceId: snapshot.workspace.workspaceId },
      });
    }
  }

  function findGoal(state, workspaceId, goalId, operationId = null) {
    const goal = state.goals[goalId];
    if (!goal || goal.workspaceId !== workspaceId) {
      fail(GOAL_ERROR_CODES.GOAL_NOT_FOUND, `unknown goal ${goalId}`, {
        owningModule: MODULE,
        operationId,
        details: { workspaceId },
      });
    }
    return goal;
  }

  function requireOptionalString(value, field, operationId) {
    if (value === undefined || value === null) return value;
    return requireString(value, field, MODULE, operationId);
  }

  function requireName(value, field, operationId) {
    if (value === undefined) return value;
    if (typeof value !== 'string' || value.trim().length === 0) {
      fail(GOAL_ERROR_CODES.GOAL_INVALID_NAME, `${field} must be a non-empty string when provided`, {
        owningModule: MODULE,
        operationId,
      });
    }
    return value;
  }

  function requireStatus(status, operationId) {
    if (!isGoalStatus(status)) {
      fail(ERROR_CODES.VALIDATION, `status must be one of ${GOAL_STATUSES.join(', ')}`, {
        owningModule: MODULE,
        operationId,
      });
    }
  }

  async function createGoal({
    token,
    workspaceId,
    name,
    ownerMemberId,
    parentGoalId = null,
    status = 'active',
  } = {}) {
    const context = await authorize(token, WRITE_SCOPE, 'createGoal');
    requireString(workspaceId, 'workspaceId', MODULE, 'createGoal');
    requireWorkspaceAccess(context, workspaceId, 'createGoal');
    requireString(name, 'name', MODULE, 'createGoal');
    requireString(ownerMemberId, 'ownerMemberId', MODULE, 'createGoal');
    if (parentGoalId !== null) requireString(parentGoalId, 'parentGoalId', MODULE, 'createGoal');
    requireStatus(status, 'createGoal');

    const snapshot = await readWorkspace(workspaceId, 'createGoal');
    requireOwnerMember(snapshot, ownerMemberId, 'createGoal');

    return store.update((state) => {
      assertParentAvailable(state, workspaceId, parentGoalId, 'createGoal');
      assertNameAvailable(state, workspaceId, parentGoalId, name, 'createGoal');
      const goal = {
        goalId: `goal_${randomUUID()}`,
        workspaceId,
        parentGoalId,
        name,
        ownerMemberId,
        status,
      };
      state.goals[goal.goalId] = goal;
      return goalCopy(goal);
    });
  }

  async function getGoal({ token, workspaceId, goalId } = {}) {
    const context = await authorize(token, READ_SCOPE, 'getGoal');
    requireString(workspaceId, 'workspaceId', MODULE, 'getGoal');
    requireString(goalId, 'goalId', MODULE, 'getGoal');
    requireWorkspaceAccess(context, workspaceId, 'getGoal');
    await readWorkspace(workspaceId, 'getGoal');

    const state = await store.read();
    const goal = findGoal(state, workspaceId, goalId, 'getGoal');
    return goalCopy(goal);
  }

  async function listGoals({ token, workspaceId, parentGoalId } = {}) {
    const context = await authorize(token, READ_SCOPE, 'listGoals');
    requireString(workspaceId, 'workspaceId', MODULE, 'listGoals');
    requireOptionalString(parentGoalId, 'parentGoalId', 'listGoals');
    requireWorkspaceAccess(context, workspaceId, 'listGoals');
    await readWorkspace(workspaceId, 'listGoals');

    const state = await store.read();
    return Object.values(state.goals)
      .filter((goal) => goal.workspaceId === workspaceId)
      .filter((goal) => parentGoalId === undefined || goal.parentGoalId === parentGoalId)
      .sort((a, b) => a.name.localeCompare(b.name) || a.goalId.localeCompare(b.goalId))
      .map(goalCopy);
  }

  async function updateGoal({
    token,
    workspaceId,
    goalId,
    name,
    ownerMemberId,
    parentGoalId,
    status,
  } = {}) {
    const context = await authorize(token, WRITE_SCOPE, 'updateGoal');
    requireString(workspaceId, 'workspaceId', MODULE, 'updateGoal');
    requireString(goalId, 'goalId', MODULE, 'updateGoal');
    requireWorkspaceAccess(context, workspaceId, 'updateGoal');
    requireName(name, 'name', 'updateGoal');
    requireOptionalString(ownerMemberId, 'ownerMemberId', 'updateGoal');
    if (parentGoalId !== undefined && parentGoalId !== null) {
      requireString(parentGoalId, 'parentGoalId', MODULE, 'updateGoal');
    }
    if (status !== undefined) requireStatus(status, 'updateGoal');

    const snapshot = await readWorkspace(workspaceId, 'updateGoal');

    return store.update((state) => {
      const goal = findGoal(state, workspaceId, goalId, 'updateGoal');
      const resolvedName = name === undefined ? goal.name : name;
      const resolvedOwnerId = ownerMemberId === undefined || ownerMemberId === null
        ? goal.ownerMemberId
        : ownerMemberId;
      const resolvedParentId = parentGoalId === undefined ? goal.parentGoalId : parentGoalId;
      requireOwnerMember(snapshot, resolvedOwnerId, 'updateGoal');
      if (resolvedParentId !== null) {
        assertParentAvailable(state, workspaceId, resolvedParentId, 'updateGoal');
        if (
          resolvedParentId === goal.goalId
          || isGoalDescendant(state.goals, goal.goalId, resolvedParentId)
        ) {
          fail(GOAL_ERROR_CODES.GOAL_PARENT_INVALID, 'a goal cannot move below itself or a descendant', {
            owningModule: MODULE,
            operationId: 'updateGoal',
            details: { workspaceId, goalId, parentGoalId: resolvedParentId },
          });
        }
      }
      assertNameAvailable(state, workspaceId, resolvedParentId, resolvedName, {
        operationId: 'updateGoal',
        excludeGoalId: goal.goalId,
      });

      goal.name = resolvedName;
      goal.ownerMemberId = resolvedOwnerId;
      goal.parentGoalId = resolvedParentId;
      if (status !== undefined) goal.status = status;
      return goalCopy(goal);
    });
  }

  async function deleteGoal({ token, workspaceId, goalId } = {}) {
    const context = await authorize(token, WRITE_SCOPE, 'deleteGoal');
    requireString(workspaceId, 'workspaceId', MODULE, 'deleteGoal');
    requireString(goalId, 'goalId', MODULE, 'deleteGoal');
    requireWorkspaceAccess(context, workspaceId, 'deleteGoal');
    await readWorkspace(workspaceId, 'deleteGoal');

    return store.update(async (state) => {
      const goal = findGoal(state, workspaceId, goalId, 'deleteGoal');
      if (hasChildGoal(state.goals, goal.goalId)) {
        fail(GOAL_ERROR_CODES.GOAL_NOT_EMPTY, `goal ${goalId} has child goals`, {
          owningModule: MODULE,
          operationId: 'deleteGoal',
        });
      }

      let referenced;
      try {
        referenced = await references.hasTicketReference(workspaceId, goalId);
      } catch (cause) {
        fail(GOAL_ERROR_CODES.GOAL_REFERENCE_UNAVAILABLE, 'ticket reference check failed', {
          owningModule: MODULE,
          operationId: 'deleteGoal',
          cause,
          retryDisposition: 'retryable',
        });
      }
      if (referenced) {
        fail(GOAL_ERROR_CODES.GOAL_REFERENCED, `goal ${goalId} has ticket references`, {
          owningModule: MODULE,
          operationId: 'deleteGoal',
        });
      }

      delete state.goals[goalId];
      return { workspaceId, goalId };
    });
  }

  // Trusted reader for tickets. The composing service has already authenticated
  // its actor; this method only resolves stable goal ownership.
  async function goalBelongsToWorkspace(workspaceId, goalId) {
    const state = await store.read();
    const goal = state.goals[goalId];
    return Boolean(goal && goal.workspaceId === workspaceId);
  }

  function assertParentAvailable(state, workspaceId, parentGoalId, operationId) {
    if (parentGoalId === null) return;
    const parent = state.goals[parentGoalId];
    if (!parent || parent.workspaceId !== workspaceId) {
      fail(GOAL_ERROR_CODES.GOAL_PARENT_INVALID, `unknown parent goal ${parentGoalId}`, {
        owningModule: MODULE,
        operationId,
        details: { workspaceId },
      });
    }
  }

  function assertNameAvailable(
    state,
    workspaceId,
    parentGoalId,
    name,
    { operationId, excludeGoalId = null },
  ) {
    const duplicate = Object.values(state.goals).some(
      (goal) => goal.workspaceId === workspaceId
        && goal.parentGoalId === parentGoalId
        && goal.name === name
        && goal.goalId !== excludeGoalId,
    );
    if (duplicate) {
      fail(GOAL_ERROR_CODES.GOAL_NAME_CONFLICT, `goal name ${name} already exists under parent`, {
        owningModule: MODULE,
        operationId,
        details: { workspaceId, parentGoalId, name },
      });
    }
  }

  return Object.freeze({
    createGoal,
    getGoal,
    listGoals,
    updateGoal,
    deleteGoal,
    goalBelongsToWorkspace,
  });
}
