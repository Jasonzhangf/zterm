import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  BoardError,
  GoalsPublicAdapter,
  ManagerBoardReader,
  OrganizationPublicAdapter,
} from '../../src/public/contracts.ts'

const goalsEntry = process.env.ZTERM_GOALS_PUBLIC_ENTRY
  ? pathToFileURL(resolve(process.env.ZTERM_GOALS_PUBLIC_ENTRY)).href
  : new URL('../../../goals/src/public/index.mjs', import.meta.url).href
const {
  createFileGoalStore,
  createGoalService,
} = await import(goalsEntry)

const organizationEntry = process.env.ZTERM_ORGANIZATION_PUBLIC_ENTRY
  ? pathToFileURL(resolve(process.env.ZTERM_ORGANIZATION_PUBLIC_ENTRY)).href
  : new URL('../../../organization/src/public/index.mjs', import.meta.url).href
const {
  createDevVerifiedAuth,
  createOrganizationService,
  createOrganizationStore,
} = await import(organizationEntry)

const ADMIN = 'admin-token'
const MANAGER_A = 'manager-a-token'
const MANAGER_B = 'manager-b-token'
const MANAGER_C = 'manager-c-token'
const WORKSPACE_A_ONLY = 'workspace-a-only-token'
const NO_GOALS_READ = 'no-goals-read-token'
const ALLOWLISTED_TO_A = 'allowlisted-to-a-token'

function boardAuth(auth, memberByToken) {
  return {
    async verifySession(token, workspaceId) {
      const context = await auth.verify(token)
      const memberId = memberByToken[token]
      if (!memberId) {
        throw Object.assign(new Error('board member binding is missing'), {
          name: 'BoardAuthError',
          code: 'UNAUTHENTICATED',
        })
      }
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        throw Object.assign(new Error('board workspace is missing'), {
          name: 'BoardAuthError',
          code: 'UNAUTHENTICATED',
        })
      }
      return {
        sessionId: token,
        accountId: context.accountId,
        memberId,
        credentialState: 'active',
      }
    },
  }
}

function ticketReader() {
  return {
    async listForGoalTopFive(_actor, workspaceId, goalId) {
      return {
        goalId,
        items: [],
        freshness: 'fresh',
        observedAt: Date.UTC(2026, 10, 7, 8, 0, 0),
        workspaceId,
      }
    },
  }
}

function memberStatusReader() {
  return {
    async observeMember({ actor, workspaceId, memberId }) {
      return {
        subjectRef: { kind: 'member', workspaceId, memberId },
        source: 'public-consumer-fixture',
        observedAt: Date.UTC(2026, 10, 7, 8, 0, 0),
        freshness: 'fresh',
        value: actor.memberId === memberId ? 'busy' : 'idle',
      }
    },
  }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zterm-board-public-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const bootstrapAuth = createDevVerifiedAuth({
    accounts: {
      [ADMIN]: {
        accountId: 'account-admin',
        scopes: ['org:read', 'org:write', 'goals:read', 'goals:write'],
        workspaces: '*',
      },
    },
  })
  const organization = createOrganizationService({
    store: createOrganizationStore(join(dir, 'organization.json')),
    auth: bootstrapAuth,
  })
  const goals = createGoalService({
    store: createFileGoalStore(join(dir, 'goals.json')),
    auth: bootstrapAuth,
    organization,
    references: { hasTicketReference: async () => false },
  })

  const workspace = await organization.createWorkspace({ token: ADMIN, name: 'Board' })
  const sharedManagers = await organization.createGroup({
    token: ADMIN,
    workspaceId: workspace.workspaceId,
    name: 'shared-managers',
    expectedRevision: workspace.revision,
  })
  const reports = await organization.createGroup({
    token: ADMIN,
    workspaceId: workspace.workspaceId,
    name: 'reports',
    parentGroupId: sharedManagers.groupId,
    expectedRevision: sharedManagers.revision,
  })
  const managerA = await organization.addMember({
    token: ADMIN,
    workspaceId: workspace.workspaceId,
    groupId: sharedManagers.groupId,
    name: 'Manager A',
    expectedRevision: reports.revision,
  })
  const managerB = await organization.addMember({
    token: ADMIN,
    workspaceId: workspace.workspaceId,
    groupId: sharedManagers.groupId,
    name: 'Manager B',
    expectedRevision: managerA.revision,
  })
  const directA = await organization.addMember({
    token: ADMIN,
    workspaceId: workspace.workspaceId,
    groupId: reports.groupId,
    name: 'Direct A',
    managerMemberId: managerA.memberId,
    expectedRevision: managerB.revision,
  })
  const directA2 = await organization.addMember({
    token: ADMIN,
    workspaceId: workspace.workspaceId,
    groupId: reports.groupId,
    name: 'Direct A2',
    managerMemberId: managerA.memberId,
    expectedRevision: directA.revision,
  })
  const directB = await organization.addMember({
    token: ADMIN,
    workspaceId: workspace.workspaceId,
    groupId: reports.groupId,
    name: 'Direct B',
    managerMemberId: managerB.memberId,
    expectedRevision: directA2.revision,
  })
  const unrelated = await organization.addMember({
    token: ADMIN,
    workspaceId: workspace.workspaceId,
    groupId: reports.groupId,
    name: 'Unrelated',
    expectedRevision: directB.revision,
  })
  const managerC = await organization.addMember({
    token: ADMIN,
    workspaceId: workspace.workspaceId,
    groupId: sharedManagers.groupId,
    name: 'Manager C',
    expectedRevision: unrelated.revision,
  })
  const otherWorkspace = await organization.createWorkspace({ token: ADMIN, name: 'Other' })

  const goalA = await goals.createGoal({
    token: ADMIN,
    workspaceId: workspace.workspaceId,
    name: 'Goal A',
    ownerMemberId: managerA.memberId,
  })
  const childOwnedByB = await goals.createGoal({
    token: ADMIN,
    workspaceId: workspace.workspaceId,
    name: 'B child under A',
    ownerMemberId: managerB.memberId,
    parentGoalId: goalA.goalId,
  })
  const goalB = await goals.createGoal({
    token: ADMIN,
    workspaceId: workspace.workspaceId,
    name: 'Goal B',
    ownerMemberId: managerB.memberId,
  })

  const auth = createDevVerifiedAuth({
    accounts: {
      [MANAGER_A]: {
        accountId: 'account-manager-a',
        scopes: ['org:read', 'goals:read'],
        workspaces: [workspace.workspaceId],
      },
      [MANAGER_B]: {
        accountId: 'account-manager-b',
        scopes: ['org:read', 'goals:read'],
        workspaces: [workspace.workspaceId],
      },
      [MANAGER_C]: {
        accountId: 'account-manager-c',
        scopes: ['org:read', 'goals:read'],
        workspaces: [workspace.workspaceId],
      },
      [WORKSPACE_A_ONLY]: {
        accountId: 'account-workspace-a-only',
        scopes: ['org:read', 'goals:read'],
        workspaces: [workspace.workspaceId],
      },
      [NO_GOALS_READ]: {
        accountId: 'account-no-goals-read',
        scopes: ['org:read'],
        workspaces: [workspace.workspaceId],
      },
      [ALLOWLISTED_TO_A]: {
        accountId: 'account-allowlisted-to-a',
        scopes: ['org:read', 'goals:read'],
        workspaces: [workspace.workspaceId],
        members: [managerA.memberId, directA.memberId],
      },
    },
  })
  const goalService = createGoalService({
    store: createFileGoalStore(join(dir, 'goals.json')),
    auth,
    organization: createOrganizationService({
      store: createOrganizationStore(join(dir, 'organization.json')),
      auth,
    }),
    references: { hasTicketReference: async () => false },
  })
  const scopedOrganization = createOrganizationService({
    store: createOrganizationStore(join(dir, 'organization.json')),
    auth,
  })
  const memberByToken = {
    [MANAGER_A]: managerA.memberId,
    [MANAGER_B]: managerB.memberId,
    [MANAGER_C]: managerC.memberId,
    [WORKSPACE_A_ONLY]: managerA.memberId,
    [NO_GOALS_READ]: managerA.memberId,
    [ALLOWLISTED_TO_A]: managerA.memberId,
  }
  const board = new ManagerBoardReader({
    accounts: boardAuth(auth, memberByToken),
    organization: new OrganizationPublicAdapter(scopedOrganization),
    goals: new GoalsPublicAdapter(goalService),
    tickets: ticketReader(),
    members: memberStatusReader(),
    now: () => Date.UTC(2026, 10, 7, 8, 0, 0),
  })

  return {
    board,
    workspace,
    otherWorkspace,
    managerA: managerA.memberId,
    managerB: managerB.memberId,
    managerC: managerC.memberId,
    directA: directA.memberId,
    directA2: directA2.memberId,
    directB: directB.memberId,
    unrelated: unrelated.memberId,
    goalA,
    goalB,
    childOwnedByB,
  }
}

function isBoardCode(code) {
  return (error) => error instanceof BoardError && error.code === code
}

test('same-group managers receive only their own explicit direct reports', async (t) => {
  const f = await fixture(t)
  const resultA = await f.board.queryManagerBoard({
    token: MANAGER_A,
    workspaceId: f.workspace.workspaceId,
    managerId: f.managerA,
  })
  const resultB = await f.board.queryManagerBoard({
    token: MANAGER_B,
    workspaceId: f.workspace.workspaceId,
    managerId: f.managerB,
  })

  assert.deepEqual(
    resultA.memberStatuses.map(({ subjectRef }) => subjectRef.memberId),
    [f.directA, f.directA2],
  )
  assert.deepEqual(
    resultB.memberStatuses.map(({ subjectRef }) => subjectRef.memberId),
    [f.directB],
  )
})

test('group nesting never turns unrelated child members into direct reports', async (t) => {
  const f = await fixture(t)
  const result = await f.board.queryManagerBoard({
    token: MANAGER_A,
    workspaceId: f.workspace.workspaceId,
    managerId: f.managerA,
  })

  const memberIds = result.memberStatuses.map(({ subjectRef }) => subjectRef.memberId)
  assert.equal(memberIds.includes(f.unrelated), false)
  assert.equal(memberIds.includes(f.directB), false)
})

test('a visible manager with no relation returns an empty direct-member projection', async (t) => {
  const f = await fixture(t)
  const result = await f.board.queryManagerBoard({
    token: MANAGER_C,
    workspaceId: f.workspace.workspaceId,
    managerId: f.managerC,
  })

  assert.deepEqual(result.memberStatuses, [])
  assert.deepEqual(result.goals.map(({ goal }) => goal.goalId), [])
})

test('organization allowlist filtering does not leak invisible member ids', async (t) => {
  const f = await fixture(t)
  const result = await f.board.queryManagerBoard({
    token: ALLOWLISTED_TO_A,
    workspaceId: f.workspace.workspaceId,
    managerId: f.managerA,
  })

  assert.deepEqual(
    result.memberStatuses.map(({ subjectRef }) => subjectRef.memberId),
    [f.directA],
  )
  assert.equal(
    JSON.stringify(result).includes(f.directA2),
    false,
  )
})

test('real organization and goals services enforce direct manager scope', async (t) => {
  const f = await fixture(t)
  const result = await f.board.queryManagerBoard({
    token: MANAGER_A,
    workspaceId: f.workspace.workspaceId,
    managerId: f.managerA,
  })

  assert.deepEqual(result.goals.map(({ goal }) => goal.goalId), [f.goalA.goalId])
  assert.deepEqual(
    result.memberStatuses.map(({ subjectRef }) => subjectRef.memberId),
    [f.directA, f.directA2],
  )
  assert.equal(result.goals.some(({ goal }) => goal.goalId === f.childOwnedByB.goalId), false)
})

test('real organization service refuses a workspace outside the caller grant', async (t) => {
  const f = await fixture(t)

  await assert.rejects(
    f.board.queryManagerBoard({
      token: WORKSPACE_A_ONLY,
      workspaceId: f.otherWorkspace.workspaceId,
      managerId: f.managerA,
    }),
    isBoardCode('BOARD_SCOPE_FORBIDDEN'),
  )
})

test('real goals service refuses a caller without goals read permission', async (t) => {
  const f = await fixture(t)

  await assert.rejects(
    f.board.queryManagerBoard({
      token: NO_GOALS_READ,
      workspaceId: f.workspace.workspaceId,
      managerId: f.managerA,
    }),
    isBoardCode('BOARD_SCOPE_FORBIDDEN'),
  )
})

test('same-workspace manager b sees only b-owned goals and b direct members', async (t) => {
  const f = await fixture(t)
  const result = await f.board.queryManagerBoard({
    token: MANAGER_B,
    workspaceId: f.workspace.workspaceId,
    managerId: f.managerB,
  })

  assert.deepEqual(
    new Set(result.goals.map(({ goal }) => goal.goalId)),
    new Set([f.childOwnedByB.goalId, f.goalB.goalId]),
  )
  assert.deepEqual(result.memberStatuses.map(({ subjectRef }) => subjectRef.memberId), [f.directB])
  assert.equal(result.goals.some(({ goal }) => goal.goalId === f.goalA.goalId), false)
})
