import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteBindingStore, TicketService, VikunjaV2Adapter } from '../../src/public/contracts.ts'
import type { TicketPublicReaders, VerifiedAuthContext } from '../../src/public/contracts.ts'

const BASE = process.env.VIKUNJA_BASE ?? ''
const TOKEN = process.env.VIKUNJA_TOKEN ?? ''
const TOKEN_B = process.env.VIKUNJA_TOKEN_B ?? ''
const PROJECT_A = Number(process.env.VIKUNJA_PROJECT_A ?? 0)
const PROJECT_B = Number(process.env.VIKUNJA_PROJECT_B ?? 0)

function actor(accountId = 'acct-a', memberId = 'member-a'): VerifiedAuthContext {
  return { sessionId: `sess-${accountId}`, accountId, memberId, credentialState: 'active' }
}

function readers(): TicketPublicReaders {
  return {
    hasWorkspaceAction: async () => true,
    goalBelongsToWorkspace: async () => true,
    memberExists: async () => true,
    actorOwnsMember: async (current, memberId) => current.memberId === memberId,
    hasReportDelegation: async () => false,
  }
}

async function unreachableReason(): Promise<string | undefined> {
  if (!BASE || !TOKEN || !PROJECT_A) {
    return 'VIKUNJA_BASE, VIKUNJA_TOKEN and VIKUNJA_PROJECT_A were not supplied'
  }
  try {
    const response = await fetch(`${BASE}/info`, { headers: { authorization: `Bearer ${TOKEN}` } })
    if (!response.ok) return `/api/v2/info responded ${response.status}`
    const info = (await response.json()) as { version?: string }
    if (info.version !== 'v2.7.1') return `unexpected Vikunja version ${info.version}`
    return undefined
  } catch (error) {
    return `isolated Vikunja is not reachable at ${BASE}: ${(error as Error).message}`
  }
}

async function withTempDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'zterm-tickets-real-'))
  try {
    await run(join(dir, 'tickets.sqlite'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('real Vikunja /api/v2 blackbox: persistent store create/get/report/close/reopen and same-ref no re-POST', async () => {
  const reason = await unreachableReason()
  if (reason) throw new Error(`UNVERIFIED: ${reason}`)

  await withTempDb(async (dbPath) => {
    const store = new SqliteBindingStore({ path: dbPath })
    const now = Date.now()
    await store.putProviderInstance({
      providerInstanceId: 'vk-real',
      providerKind: 'vikunja-v2',
      baseUrl: BASE,
      credentialRef: 'cred-real',
      status: 'active',
      createdAt: now,
    })
    await store.putWorkspaceProvider({
      workspaceId: 'ws-1',
      providerInstanceId: 'vk-real',
      externalProjectId: PROJECT_A,
      authority: 'local',
      createdAt: now,
      updatedAt: now,
    })
    const client = new VikunjaV2Adapter({ fetchImpl: fetch })
    const service = new TicketService({
      store,
      credentials: { getCredential: async () => ({ token: TOKEN }) },
      client,
      readers: readers(),
      now: () => Date.now(),
    })

    const title = `zterm tickets real ${Date.now()}`
    const created = await service.create(actor(), {
      operationId: 'real-create-1',
      workspaceId: 'ws-1',
      goalId: 'goal-1',
      ownerMemberId: 'member-a',
      category: 'requirement',
      title,
      description: 'real blackbox body',
      priority: 50,
    })
    assert.equal(created.operation.state, 'succeeded')
    const bindingId = created.binding?.bindingId
    const taskId = created.binding?.externalTaskId
    assert.ok(bindingId)
    assert.equal(typeof taskId, 'number')

    const replay = await service.create(actor(), {
      operationId: 'real-create-1',
      workspaceId: 'ws-1',
      goalId: 'goal-1',
      ownerMemberId: 'member-a',
      category: 'requirement',
      title,
      description: 'real blackbox body',
      priority: 50,
    })
    assert.equal(replay.operation.state, 'succeeded')
    assert.equal(replay.binding?.externalTaskId, taskId)
    const listed = await client.listTasks({ baseUrl: BASE, token: TOKEN, filter: `title = "${title}"`, perPage: 50 })
    assert.equal(listed.kind, 'ok')
    if (listed.kind === 'ok') assert.equal(listed.value?.items.length, 1)

    const observed = await service.get(actor(), { bindingId: bindingId as string })
    assert.equal(observed.freshness, 'fresh')
    assert.equal(observed.ticket?.title, title)

    const report = await service.appendReport(actor(), {
      operationId: 'real-report-1',
      bindingId: bindingId as string,
      actorMemberId: 'member-a',
      reportKind: 'status',
      body: 'real blackbox report',
    })
    assert.equal(report.operation.state, 'succeeded')
    assert.equal(typeof report.operation.externalCommentId, 'number')

    const closed = await service.close(actor(), { operationId: 'real-close-1', bindingId: bindingId as string })
    assert.equal(closed.operation.state, 'succeeded')

    const reopened = await service.reopen(actor(), { operationId: 'real-reopen-1', bindingId: bindingId as string })
    assert.equal(reopened.operation.state, 'succeeded')

    // A fresh process-equivalent store over the same SQLite file still finds the
    // binding and its fixed provider identity.
    store.close()
    const reopenedStore = new SqliteBindingStore({ path: dbPath })
    const persisted = await reopenedStore.getBinding(bindingId as string)
    assert.equal(persisted?.externalTaskId, taskId)
    assert.equal(persisted?.providerInstanceId, 'vk-real')

    const second = new TicketService({
      store: reopenedStore,
      credentials: { getCredential: async () => ({ token: TOKEN }) },
      client,
      readers: readers(),
      now: () => Date.now(),
    })
    const secondCreate = await second.create(actor(), {
      operationId: 'real-create-2',
      workspaceId: 'ws-1',
      goalId: 'goal-1',
      ownerMemberId: 'member-a',
      category: 'requirement',
      title: `${title} two`,
      description: 'real blackbox body',
      priority: 40,
    })
    assert.equal(secondCreate.operation.state, 'succeeded')
    assert.notEqual(secondCreate.binding?.externalTaskId, taskId)
    reopenedStore.close()
  })
})

test('real Vikunja /api/v2 blackbox: cross-project read is 403', async () => {
  const reason = await unreachableReason()
  if (reason) throw new Error(`UNVERIFIED: ${reason}`)
  if (!TOKEN_B || !PROJECT_B) {
    throw new Error('UNVERIFIED: VIKUNJA_TOKEN_B and VIKUNJA_PROJECT_B are required for cross-project isolation')
  }

  const store = new SqliteBindingStore({ path: join(tmpdir(), `zterm-tickets-cross-${Date.now()}.sqlite`) })
  const now = Date.now()
  await store.putProviderInstance({
    providerInstanceId: 'vk-real',
    providerKind: 'vikunja-v2',
    baseUrl: BASE,
    credentialRef: 'cred-real',
    status: 'active',
    createdAt: now,
  })
  await store.putWorkspaceProvider({
    workspaceId: 'ws-1',
    providerInstanceId: 'vk-real',
    externalProjectId: PROJECT_A,
    authority: 'local',
    createdAt: now,
    updatedAt: now,
  })
  const client = new VikunjaV2Adapter({ fetchImpl: fetch })
  const service = new TicketService({
    store,
    credentials: { getCredential: async () => ({ token: TOKEN }) },
    client,
    readers: readers(),
    now: () => Date.now(),
  })
  const created = await service.create(actor(), {
    operationId: 'real-cross-create',
    workspaceId: 'ws-1',
    goalId: 'goal-1',
    ownerMemberId: 'member-a',
    category: 'requirement',
    title: `zterm tickets cross ${Date.now()}`,
    description: 'body',
    priority: 10,
  })
  const taskId = created.binding?.externalTaskId
  assert.equal(typeof taskId, 'number')

  const response = await fetch(`${BASE}/tasks/${taskId}`, { headers: { authorization: `Bearer ${TOKEN_B}` } })
  assert.equal(response.status, 403)
  store.close()
})
