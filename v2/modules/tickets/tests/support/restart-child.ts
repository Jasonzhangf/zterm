import { SqliteBindingStore, TicketService } from '../../src/public/contracts.ts'
import type { TicketPublicReaders, VerifiedAuthContext } from '../../src/public/contracts.ts'

const [mode, dbPath, nowArg] = process.argv.slice(2)

if ((mode !== 'write' && mode !== 'replay' && mode !== 'crash-after-post') || !dbPath) {
  throw new Error('usage: restart-child <write|replay|crash-after-post> <sqlite-path> [now]')
}

const now = nowArg ? Number(nowArg) : 1000

const actor: VerifiedAuthContext = {
  sessionId: 'sess-acct-a',
  accountId: 'acct-a',
  memberId: 'member-a',
  credentialState: 'active',
}

const readers: TicketPublicReaders = {
  hasWorkspaceAction: async () => true,
  goalBelongsToWorkspace: async () => true,
  memberExists: async () => true,
  actorOwnsMember: async (current, memberId) => current.memberId === memberId,
  hasReportDelegation: async () => false,
}

const createInput = {
  operationId: 'op-restart-1',
  workspaceId: 'ws-1',
  goalId: 'goal-1',
  ownerMemberId: 'member-a',
  category: 'requirement' as const,
  title: 'Fix login',
  description: 'body',
  priority: 10,
}

let createCalls = 0

const createdTask = {
  id: 42,
  project_id: 3,
  title: 'Fix login',
  description: 'body',
  priority: 10,
  done: false,
  done_at: '0001-01-01T00:00:00Z',
}

const client = {
  async createTask() {
    createCalls += 1
    if (mode === 'crash-after-post') {
      // The remote write has been issued; the process dies before the local
      // state commit, leaving a durable pending operation with a live lease.
      process.exit(0)
    }
    if (mode === 'write') {
      return { kind: 'transport-error' as const, cause: new Error('response lost after POST') }
    }
    return { kind: 'ok' as const, status: 201, value: createdTask }
  },
  async getTask() {
    return { kind: 'transport-error' as const, cause: new Error('no provider for restart probe') }
  },
  async updateTask() {
    return { kind: 'transport-error' as const, cause: new Error('no provider for restart probe') }
  },
  async createComment() {
    return { kind: 'transport-error' as const, cause: new Error('no provider for restart probe') }
  },
  async listComments() {
    return { kind: 'transport-error' as const, cause: new Error('no provider for restart probe') }
  },
  async listTasks() {
    return { kind: 'transport-error' as const, cause: new Error('no provider for restart probe') }
  },
}

const store = new SqliteBindingStore({ path: dbPath })

if (mode !== 'replay') {
  await store.putProviderInstance({
    providerInstanceId: 'vk-restart',
    providerKind: 'vikunja-v2',
    baseUrl: 'http://vikunja.restart.invalid/api/v2',
    credentialRef: 'cred-restart',
    status: 'active',
    createdAt: 1,
  })
  await store.putWorkspaceProvider({
    workspaceId: 'ws-1',
    providerInstanceId: 'vk-restart',
    externalProjectId: 3,
    authority: 'local',
    createdAt: 1,
    updatedAt: 1,
  })
}

const service = new TicketService({
  store,
  credentials: { getCredential: async () => ({ token: 'not-a-real-token' }) },
  client,
  readers,
  now: () => now,
})

const result = await service.create(actor, createInput)
process.stdout.write(
  `${JSON.stringify({
    mode,
    state: result.operation.state,
    createCalls,
    bindingId: result.binding?.bindingId,
    operationRef: result.operation.operationRef,
  })}\n`,
)
store.close()
