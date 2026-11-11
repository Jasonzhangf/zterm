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
} from '../../../organization/src/public/index.mjs';
import {
  GOAL_ERROR_CODES,
  createFileGoalStore,
  createGoalService,
} from '../../src/public/index.mjs';

const OWNER = 'goal-owner-token';
const READER = 'goal-reader-token';
const OTHER_WORKSPACE = 'goal-other-workspace-token';
const NO_SCOPE = 'goal-no-scope-token';

const auth = createDevVerifiedAuth({
  accounts: {
    [OWNER]: {
      accountId: 'acct-goal-owner',
      scopes: ['goals:read', 'goals:write', 'org:read', 'org:write'],
      workspaces: '*',
    },
    [READER]: {
      accountId: 'acct-goal-reader',
      scopes: ['goals:read'],
      workspaces: '*',
    },
    [OTHER_WORKSPACE]: {
      accountId: 'acct-goal-other',
      scopes: ['goals:read', 'goals:write'],
      workspaces: ['ws-other-only'],
    },
    [NO_SCOPE]: {
      accountId: 'acct-goal-no-scope',
      scopes: ['organization:read'],
      workspaces: '*',
    },
  },
});

function isCode(error, code) {
  return isTypedError(error) && error.code === code;
}

function createReferenceDouble() {
  const references = new Set();
  return {
    references,
    port: Object.freeze({
      async hasTicketReference(workspaceId, goalId) {
        return references.has(`${workspaceId}:${goalId}`);
      },
    }),
  };
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'zterm-goals-'));
  const organization = createOrganizationService({
    store: createOrganizationStore(join(dir, 'organization.json')),
    auth,
  });
  const workspace = await organization.createWorkspace({ token: OWNER, name: 'Primary' });
  const owner = await organization.addMember({
    token: OWNER,
    workspaceId: workspace.workspaceId,
    groupId: workspace.rootGroupId,
    name: 'GoalOwner',
    expectedRevision: workspace.revision,
  });
  const otherWorkspace = await organization.createWorkspace({ token: OWNER, name: 'Other' });
  const otherOwner = await organization.addMember({
    token: OWNER,
    workspaceId: otherWorkspace.workspaceId,
    groupId: otherWorkspace.rootGroupId,
    name: 'OtherOwner',
    expectedRevision: otherWorkspace.revision,
  });
  const referenceDouble = createReferenceDouble();
  const goalFile = join(dir, 'goals.json');

  function makeService() {
    return createGoalService({
      store: createFileGoalStore(goalFile),
      auth,
      organization,
      references: referenceDouble.port,
    });
  }

  return {
    dir,
    goalFile,
    organization,
    workspace,
    owner,
    otherWorkspace,
    otherOwner,
    referenceDouble,
    makeService,
  };
}

function createGoal(service, fixture, overrides = {}) {
  return service.createGoal({
    token: OWNER,
    workspaceId: fixture.workspace.workspaceId,
    name: 'Ship I3',
    ownerMemberId: fixture.owner.memberId,
    ...overrides,
  });
}

test('creates, reads back, updates, lists, and reopens a stable goal from the public port', async () => {
  const fixture = await harness();
  const service = fixture.makeService();

  const root = await createGoal(service, fixture);
  assert.match(root.goalId, /^goal_/);
  assert.equal(root.workspaceId, fixture.workspace.workspaceId);
  assert.equal(root.parentGoalId, null);
  assert.equal(root.ownerMemberId, fixture.owner.memberId);
  assert.equal(root.status, 'active');

  const child = await createGoal(service, fixture, {
    name: 'Implement goal store',
    parentGoalId: root.goalId,
  });
  assert.equal(child.parentGoalId, root.goalId);

  const read = await service.getGoal({
    token: READER,
    workspaceId: fixture.workspace.workspaceId,
    goalId: root.goalId,
  });
  assert.deepEqual(read, root);

  const updated = await service.updateGoal({
    token: OWNER,
    workspaceId: fixture.workspace.workspaceId,
    goalId: child.goalId,
    name: 'Implement persistent goal store',
    ownerMemberId: fixture.owner.memberId,
    status: 'completed',
  });
  assert.equal(updated.goalId, child.goalId);
  assert.equal(updated.name, 'Implement persistent goal store');
  assert.equal(updated.status, 'completed');

  const listed = await service.listGoals({
    token: READER,
    workspaceId: fixture.workspace.workspaceId,
    parentGoalId: root.goalId,
  });
  assert.deepEqual(listed.map((goal) => goal.goalId), [child.goalId]);

  const reopened = fixture.makeService();
  const readback = await reopened.getGoal({
    token: READER,
    workspaceId: fixture.workspace.workspaceId,
    goalId: child.goalId,
  });
  assert.deepEqual(readback, updated);
  assert.equal(await reopened.goalBelongsToWorkspace(fixture.workspace.workspaceId, child.goalId), true);
  assert.equal(await reopened.goalBelongsToWorkspace(fixture.otherWorkspace.workspaceId, child.goalId), false);
});

test('rejects cross-workspace goal actions before returning target data', async () => {
  const fixture = await harness();
  const service = fixture.makeService();
  const goal = await createGoal(service, fixture);

  await assert.rejects(
    () => service.getGoal({
      token: OTHER_WORKSPACE,
      workspaceId: fixture.workspace.workspaceId,
      goalId: goal.goalId,
    }),
    (error) => isCode(error, GOAL_ERROR_CODES.GOAL_FORBIDDEN),
  );
  await assert.rejects(
    () => service.updateGoal({
      token: OTHER_WORKSPACE,
      workspaceId: fixture.workspace.workspaceId,
      goalId: goal.goalId,
      name: 'Cross-workspace edit',
    }),
    (error) => isCode(error, GOAL_ERROR_CODES.GOAL_FORBIDDEN),
  );

  const otherGoal = await createGoal(service, fixture, {
    workspaceId: fixture.otherWorkspace.workspaceId,
    ownerMemberId: fixture.otherOwner.memberId,
    name: 'Other workspace goal',
  });
  await assert.rejects(
    () => service.getGoal({
      token: OWNER,
      workspaceId: fixture.workspace.workspaceId,
      goalId: otherGoal.goalId,
    }),
    (error) => isCode(error, GOAL_ERROR_CODES.GOAL_NOT_FOUND),
  );

  await assert.rejects(
    () => service.listGoals({
      token: NO_SCOPE,
      workspaceId: fixture.workspace.workspaceId,
    }),
    (error) => isCode(error, GOAL_ERROR_CODES.GOAL_FORBIDDEN),
  );
});

test('rejects duplicate names under one parent and invalid owner or hierarchy references', async () => {
  const fixture = await harness();
  const service = fixture.makeService();
  const root = await createGoal(service, fixture);
  const child = await createGoal(service, fixture, {
    name: 'Child',
    parentGoalId: root.goalId,
  });

  await assert.rejects(
    () => createGoal(service, fixture, {
      name: 'Ship I3',
    }),
    (error) => isCode(error, GOAL_ERROR_CODES.GOAL_NAME_CONFLICT),
  );

  await assert.rejects(
    () => createGoal(service, fixture, {
      name: 'Unknown parent',
      parentGoalId: 'goal_missing',
    }),
    (error) => isCode(error, GOAL_ERROR_CODES.GOAL_PARENT_INVALID),
  );

  await assert.rejects(
    () => createGoal(service, fixture, {
      name: 'Unknown owner',
      ownerMemberId: 'mbr_missing',
    }),
    (error) => isCode(error, GOAL_ERROR_CODES.GOAL_OWNER_INVALID),
  );

  await assert.rejects(
    () => service.updateGoal({
      token: OWNER,
      workspaceId: fixture.workspace.workspaceId,
      goalId: root.goalId,
      parentGoalId: child.goalId,
    }),
    (error) => isCode(error, GOAL_ERROR_CODES.GOAL_PARENT_INVALID),
  );

  await assert.rejects(
    () => service.updateGoal({
      token: OWNER,
      workspaceId: fixture.workspace.workspaceId,
      goalId: root.goalId,
      status: 'unknown-status',
    }),
    (error) => isCode(error, ERROR_CODES.VALIDATION),
  );
});

test('updateGoal rejects explicit null or empty name without changing the stored goal', async () => {
  const fixture = await harness();
  const service = fixture.makeService();
  const root = await createGoal(service, fixture);

  await assert.rejects(
    () => service.updateGoal({
      token: OWNER,
      workspaceId: fixture.workspace.workspaceId,
      goalId: root.goalId,
      name: null,
    }),
    (error) => isCode(error, 'GOAL_INVALID_NAME'),
  );

  assert.deepEqual(
    await service.getGoal({
      token: READER,
      workspaceId: fixture.workspace.workspaceId,
      goalId: root.goalId,
    }),
    root,
  );

  const afterNullRejection = await service.listGoals({
    token: READER,
    workspaceId: fixture.workspace.workspaceId,
  });
  assert.equal(afterNullRejection.length, 1);
  assert.equal(afterNullRejection[0].name, 'Ship I3');

  await assert.rejects(
    () => service.updateGoal({
      token: OWNER,
      workspaceId: fixture.workspace.workspaceId,
      goalId: root.goalId,
      name: '',
    }),
    (error) => isCode(error, 'GOAL_INVALID_NAME'),
  );

  assert.deepEqual(
    await service.getGoal({
      token: READER,
      workspaceId: fixture.workspace.workspaceId,
      goalId: root.goalId,
    }),
    root,
  );

  const renamed = await service.updateGoal({
    token: OWNER,
    workspaceId: fixture.workspace.workspaceId,
    goalId: root.goalId,
    name: 'Ship I3 next',
  });
  assert.equal(renamed.name, 'Ship I3 next');
  assert.equal(
    (await service.getGoal({
      token: READER,
      workspaceId: fixture.workspace.workspaceId,
      goalId: root.goalId,
    })).name,
    'Ship I3 next',
  );
});

test('deletion is allowed only for an unreferenced leaf and never creates orphan tickets', async () => {
  const fixture = await harness();
  const service = fixture.makeService();
  const root = await createGoal(service, fixture);
  const child = await createGoal(service, fixture, {
    name: 'Referenced child',
    parentGoalId: root.goalId,
  });

  fixture.referenceDouble.references.add(`${fixture.workspace.workspaceId}:${child.goalId}`);
  await assert.rejects(
    () => service.deleteGoal({
      token: OWNER,
      workspaceId: fixture.workspace.workspaceId,
      goalId: child.goalId,
    }),
    (error) => isCode(error, GOAL_ERROR_CODES.GOAL_REFERENCED),
  );
  const stillThere = await service.getGoal({
    token: READER,
    workspaceId: fixture.workspace.workspaceId,
    goalId: child.goalId,
  });
  assert.equal(stillThere.goalId, child.goalId);

  await assert.rejects(
    () => service.deleteGoal({
      token: OWNER,
      workspaceId: fixture.workspace.workspaceId,
      goalId: root.goalId,
    }),
    (error) => isCode(error, GOAL_ERROR_CODES.GOAL_NOT_EMPTY),
  );

  fixture.referenceDouble.references.delete(`${fixture.workspace.workspaceId}:${child.goalId}`);
  const deleted = await service.deleteGoal({
    token: OWNER,
    workspaceId: fixture.workspace.workspaceId,
    goalId: child.goalId,
  });
  assert.deepEqual(deleted, {
    workspaceId: fixture.workspace.workspaceId,
    goalId: child.goalId,
  });
  await assert.rejects(
    () => service.getGoal({
      token: READER,
      workspaceId: fixture.workspace.workspaceId,
      goalId: child.goalId,
    }),
    (error) => isCode(error, GOAL_ERROR_CODES.GOAL_NOT_FOUND),
  );
});

test('typed authorization failures do not echo the supplied bearer token', async () => {
  const fixture = await harness();
  const service = fixture.makeService();

  await assert.rejects(
    () => service.listGoals({
      token: OTHER_WORKSPACE,
      workspaceId: fixture.workspace.workspaceId,
    }),
    (error) => {
      assert.equal(isCode(error, GOAL_ERROR_CODES.GOAL_FORBIDDEN), true);
      assert.equal(JSON.stringify(error.toRecord()).includes(OTHER_WORKSPACE), false);
      assert.equal(JSON.stringify(error.details ?? {}).includes(OTHER_WORKSPACE), false);
      return true;
    },
  );
});
