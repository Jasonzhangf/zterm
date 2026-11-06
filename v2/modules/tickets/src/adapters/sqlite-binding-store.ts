import { DatabaseSync } from 'node:sqlite'
import type { TicketBinding, WorkspaceProviderBinding } from '../domain/ticket-binding.ts'
import type { ProviderInstance } from '../domain/provider-instance.ts'
import type {
  OperationRef,
  WriteOperation,
  WriteOperationState,
} from '../domain/write-operation.ts'
import { operationRefKey } from '../domain/write-operation.ts'
import { TicketError } from '../public/errors.ts'
import type {
  BindingFilter,
  BindingStorePort,
  CommitWriteResult,
  CreateOperationResult,
  Lease,
  OperationFilter,
  PendingWriteScope,
} from '../ports/binding-store.ts'

export interface SqliteBindingStoreOptions {
  path: string
}

function externalKey(providerInstanceId: string, externalTaskId: number): string {
  return `${providerInstanceId}\u0000${externalTaskId}`
}

function memberKey(memberId: string, providerInstanceId: string): string {
  return `${memberId}\u0000${providerInstanceId}`
}

function commentKey(providerInstanceId: string, externalCommentId: number): string {
  return `${providerInstanceId}\u0000${externalCommentId}`
}

function claimRefKey(ref: OperationRef): string {
  return JSON.stringify([ref.workspaceId, ref.actorAccountId, ref.operationId])
}

function operationKeyFromClaimRefKey(refKey: string, refKeyHex: string): string {
  try {
    const parts = JSON.parse(refKey) as unknown
    if (
      Array.isArray(parts) &&
      parts.length === 3 &&
      parts.every((part) => typeof part === 'string')
    ) {
      return operationRefKey({
        workspaceId: parts[0],
        actorAccountId: parts[1],
        operationId: parts[2],
      })
    }
  } catch {
    // Fall through to the legacy key below.
  }
  // Legacy claim rows store operationRefKey directly. Read through hex so the
  // SQLite C-string conversion cannot remove bytes after a NUL separator.
  return Buffer.from(refKeyHex, 'hex').toString('utf8')
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T
}

/**
 * Durable production store. The SQLite file is the module's only persistent
 * control truth: binding, operation, provider instance, workspace mapping,
 * member mapping and per-binding intent version all live here.
 *
 * A successful write commits the operation row and its binding row in one
 * SQLite transaction, so a process exit can never leave a succeeded operation
 * without the binding it produced. Binding IDs are allocated inside the store
 * sequence so two service instances sharing one file never reuse an ID.
 */
export class SqliteBindingStore implements BindingStorePort {
  readonly #db: DatabaseSync

  constructor(options: SqliteBindingStoreOptions) {
    this.#db = new DatabaseSync(options.path)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS bindings (
        binding_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        external_key TEXT NOT NULL UNIQUE,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bindings_workspace ON bindings(workspace_id);
      CREATE TABLE IF NOT EXISTS operations (
        ref_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        actor_account_id TEXT NOT NULL,
        state TEXT NOT NULL,
        binding_id TEXT,
        external_comment_id INTEGER,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operations_workspace ON operations(workspace_id);
      -- Comment identity is provider-scoped (see comment_claims); a global
      -- unique index on external_comment_id would wrongly reject the same
      -- numeric id produced by two different providers.
      DROP INDEX IF EXISTS operations_comment_unique;
      CREATE TABLE IF NOT EXISTS comment_claims (
        provider_instance_id TEXT NOT NULL,
        external_comment_id INTEGER NOT NULL,
        ref_key TEXT NOT NULL,
        PRIMARY KEY (provider_instance_id, external_comment_id)
      );
      CREATE TABLE IF NOT EXISTS workspace_providers (
        workspace_id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_instances (
        provider_instance_id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS member_mappings (
        member_id TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (member_id, provider_instance_id)
      );
      CREATE TABLE IF NOT EXISTS intent_versions (
        binding_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS binding_seq (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO binding_seq (id, next) VALUES (1, 1);
    `)
    this.#transaction(() => this.#migrateLegacyCommentClaims())
  }

  close(): void {
    this.#db.close()
  }

  async getOperation(ref: OperationRef): Promise<WriteOperation | undefined> {
    const row = this.#db.prepare('SELECT json FROM operations WHERE ref_key = ?').get(operationRefKey(ref)) as
      | { json: string }
      | undefined
    return row ? parseJson<WriteOperation>(row.json) : undefined
  }

  async recoverExpiredPending(ref: OperationRef, now: number): Promise<WriteOperation | undefined> {
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT json FROM operations WHERE ref_key = ?').get(operationRefKey(ref)) as
        | { json: string }
        | undefined
      if (!row) return undefined
      const current = parseJson<WriteOperation>(row.json)
      if (current.state !== 'pending') return current
      // Only a lapsed lease is recoverable: a running executor keeps its
      // pending claim and must not be preempted.
      if ((current.executionLeaseUntil ?? 0) > now) return current
      const recovered: WriteOperation = {
        ...current,
        state: 'unknown',
        errorCode: 'WRITE_OUTCOME_UNKNOWN',
        errorMessage: 'execution lease expired before the local state commit; verify the remote result manually',
        observedAt: now,
      }
      this.#upsertOperation(recovered)
      return recovered
    })
  }

  async putOperation(operation: WriteOperation): Promise<void> {
    this.#putOperation(operation)
  }

  async createOperationIfAbsent(operation: WriteOperation, lease: Lease): Promise<CreateOperationResult> {
    const key = operationRefKey(operation.operationRef)
    const withLease: WriteOperation = {
      ...operation,
      executionLeaseOwner: lease.owner,
      executionLeaseUntil: lease.until,
    }
    const result = this.#db
      .prepare(
        `INSERT INTO operations (ref_key, workspace_id, actor_account_id, state, binding_id, external_comment_id, json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref_key) DO NOTHING`,
      )
      .run(
        key,
        withLease.operationRef.workspaceId,
        withLease.operationRef.actorAccountId,
        withLease.state,
        withLease.bindingId ?? null,
        withLease.externalCommentId ?? null,
        JSON.stringify(withLease),
      )
    if (Number(result.changes) === 0) {
      const existing = await this.getOperation(operation.operationRef)
      return { created: false, operation: existing ?? withLease }
    }
    return { created: true, operation: withLease }
  }

  async beginStateOperation(operation: WriteOperation, lease: Lease): Promise<CreateOperationResult> {
    return this.#transaction(() => {
      const key = operationRefKey(operation.operationRef)
      const existing = this.#db.prepare('SELECT json FROM operations WHERE ref_key = ?').get(key) as
        | { json: string }
        | undefined
      if (existing) return { created: false, operation: parseJson<WriteOperation>(existing.json) }
      if (!operation.bindingId) throw new TicketError('BINDING_CONFLICT', 'state operation without bindingId')

      const bindingRow = this.#db
        .prepare('SELECT json FROM bindings WHERE binding_id = ?')
        .get(operation.bindingId) as { json: string } | undefined
      if (!bindingRow) return { created: false, operation }
      const intentVersion = this.#currentIntentVersion(operation.bindingId) + 1
      this.#setIntentVersion(operation.bindingId, intentVersion)

      // Only older close/reopen state intents are superseded. create/appendReport
      // operations stay available for manual reconciliation.
      const candidates = this.#db
        .prepare('SELECT hex(ref_key) AS ref_key_hex, json FROM operations WHERE binding_id = ? AND ref_key <> ?')
        .all(operation.bindingId, key) as Array<{ ref_key_hex: string; json: string }>
      for (const row of candidates) {
        const candidate = parseJson<WriteOperation>(row.json)
        if (candidate.kind !== 'close' && candidate.kind !== 'reopen') continue
        if (candidate.state !== 'pending' && candidate.state !== 'unknown') continue
        // operationRefKey embeds NUL separators; node:sqlite truncates a TEXT
        // value at the first NUL, so the UPDATE key must come from hex readback.
        const refKey = Buffer.from(row.ref_key_hex, 'hex').toString('utf8')
        const superseded: WriteOperation = {
          ...candidate,
          state: 'superseded',
          errorCode: 'OPERATION_SUPERSEDED',
          errorMessage: 'superseded by a newer state intent',
        }
        this.#db
          .prepare('UPDATE operations SET state = ?, json = ? WHERE ref_key = ?')
          .run(superseded.state, JSON.stringify(superseded), refKey)
      }

      const withLease: WriteOperation = {
        ...operation,
        intentVersion,
        executionLeaseOwner: lease.owner,
        executionLeaseUntil: lease.until,
      }
      this.#insertOperation(withLease)
      return { created: true, operation: withLease }
    })
  }

  async listOperations(filter: OperationFilter): Promise<WriteOperation[]> {
    const rows = this.#db
      .prepare('SELECT json FROM operations WHERE workspace_id = ?')
      .all(filter.workspaceId) as Array<{ json: string }>
    return rows
      .map((row) => parseJson<WriteOperation>(row.json))
      .filter((operation) => {
        if (filter.actorAccountId && operation.operationRef.actorAccountId !== filter.actorAccountId) return false
        if (filter.states && !filter.states.includes(operation.state)) return false
        if (filter.kinds && !filter.kinds.includes(operation.kind)) return false
        return true
      })
  }

  async listPendingWrites(filter: PendingWriteScope): Promise<WriteOperation[]> {
    const rows = this.#db
      .prepare('SELECT json FROM operations WHERE workspace_id = ?')
      .all(filter.workspaceId) as Array<{ json: string }>
    return rows
      .map((row) => parseJson<WriteOperation>(row.json))
      .filter((operation) => {
        if (filter.actorAccountId && operation.operationRef.actorAccountId !== filter.actorAccountId) return false
        if (filter.states && !filter.states.includes(operation.state)) return false
        if (filter.kinds && !filter.kinds.includes(operation.kind)) return false
        return true
      })
  }

  async getBinding(bindingId: string): Promise<TicketBinding | undefined> {
    const row = this.#db.prepare('SELECT json FROM bindings WHERE binding_id = ?').get(bindingId) as
      | { json: string }
      | undefined
    return row ? parseJson<TicketBinding>(row.json) : undefined
  }

  async getBindingByExternal(providerInstanceId: string, externalTaskId: number): Promise<TicketBinding | undefined> {
    const row = this.#db
      .prepare('SELECT json FROM bindings WHERE external_key = ?')
      .get(externalKey(providerInstanceId, externalTaskId)) as { json: string } | undefined
    return row ? parseJson<TicketBinding>(row.json) : undefined
  }

  async getOperationByExternalComment(
    providerInstanceId: string,
    externalCommentId: number,
  ): Promise<WriteOperation | undefined> {
    const claim = this.#db
      .prepare(
        'SELECT ref_key, hex(ref_key) AS ref_key_hex FROM comment_claims WHERE provider_instance_id = ? AND external_comment_id = ?',
      )
      .get(providerInstanceId, externalCommentId) as { ref_key: string; ref_key_hex: string } | undefined
    if (!claim) return undefined
    const refKey = operationKeyFromClaimRefKey(claim.ref_key, claim.ref_key_hex)
    const row = this.#db.prepare('SELECT json FROM operations WHERE ref_key = ?').get(refKey) as
      | { json: string }
      | undefined
    return row ? parseJson<WriteOperation>(row.json) : undefined
  }

  async listBindings(filter: BindingFilter): Promise<TicketBinding[]> {
    const rows = this.#db
      .prepare('SELECT json FROM bindings WHERE workspace_id = ?')
      .all(filter.workspaceId) as Array<{ json: string }>
    return rows
      .map((row) => parseJson<TicketBinding>(row.json))
      .filter((binding) => {
        if (filter.goalId && binding.goalId !== filter.goalId) return false
        if (filter.ownerMemberId && binding.ownerMemberId !== filter.ownerMemberId) return false
        return true
      })
  }

  async putBinding(binding: TicketBinding): Promise<void> {
    this.#transaction(() => {
      this.#putBindingLocked(binding)
    })
  }

  async allocateBindingId(): Promise<string> {
    return this.#transaction(() => {
      const sequence = this.#db.prepare('SELECT next FROM binding_seq WHERE id = 1').get() as { next: number }
      let next = Number(sequence.next)
      let bindingId = ''
      do {
        bindingId = `binding-${next}`
        next += 1
      } while (this.#db.prepare('SELECT 1 FROM bindings WHERE binding_id = ?').get(bindingId))
      this.#db.prepare('UPDATE binding_seq SET next = ? WHERE id = 1').run(next)
      return bindingId
    })
  }

  async nextIntentVersion(bindingId: string): Promise<number> {
    return this.#transaction(() => {
      const binding = this.#requireBindingJson(bindingId)
      const next = Math.max(this.#currentIntentVersion(bindingId), binding.stateIntentVersion) + 1
      this.#setIntentVersion(bindingId, next)
      return next
    })
  }

  async getWorkspaceProvider(workspaceId: string): Promise<WorkspaceProviderBinding | undefined> {
    const row = this.#db
      .prepare('SELECT json FROM workspace_providers WHERE workspace_id = ?')
      .get(workspaceId) as { json: string } | undefined
    return row ? parseJson<WorkspaceProviderBinding>(row.json) : undefined
  }

  async putWorkspaceProvider(binding: WorkspaceProviderBinding): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO workspace_providers (workspace_id, json) VALUES (?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET json = excluded.json`,
      )
      .run(binding.workspaceId, JSON.stringify(binding))
  }

  async getProviderInstance(providerInstanceId: string): Promise<ProviderInstance | undefined> {
    const row = this.#db
      .prepare('SELECT json FROM provider_instances WHERE provider_instance_id = ?')
      .get(providerInstanceId) as { json: string } | undefined
    return row ? parseJson<ProviderInstance>(row.json) : undefined
  }

  async putProviderInstance(provider: ProviderInstance): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO provider_instances (provider_instance_id, json) VALUES (?, ?)
         ON CONFLICT(provider_instance_id) DO UPDATE SET json = excluded.json`,
      )
      .run(provider.providerInstanceId, JSON.stringify(provider))
  }

  async getMemberMapping(
    memberId: string,
    providerInstanceId: string,
  ): Promise<{ providerAssigneeId?: number } | undefined> {
    const row = this.#db
      .prepare('SELECT json FROM member_mappings WHERE member_id = ? AND provider_instance_id = ?')
      .get(memberId, providerInstanceId) as { json: string } | undefined
    return row ? parseJson<{ providerAssigneeId?: number }>(row.json) : undefined
  }

  async commitWriteSuccess(operation: WriteOperation, binding?: TicketBinding): Promise<CommitWriteResult> {
    return this.#transaction(() => {
      const key = operationRefKey(operation.operationRef)
      const existingRow = this.#db.prepare('SELECT json FROM operations WHERE ref_key = ?').get(key) as
        | { json: string }
        | undefined
      if (!existingRow) return { committed: false, operation: undefined, conflict: 'operation-state' }
      const existing = parseJson<WriteOperation>(existingRow.json)
      if (existing.state === 'superseded') {
        return { committed: false, operation: existing, conflict: 'intent-superseded' }
      }
      if (existing.state !== 'pending' && existing.state !== 'unknown') {
        return { committed: false, operation: existing, conflict: 'operation-state' }
      }
      if (operation.intentVersion !== undefined && operation.bindingId) {
        if (operation.intentVersion !== this.#currentIntentVersion(operation.bindingId)) {
          return { committed: false, operation: existing, conflict: 'intent-superseded' }
        }
      }
      if (binding) {
        const existingBinding = this.#db
          .prepare('SELECT json FROM bindings WHERE binding_id = ?')
          .get(binding.bindingId) as { json: string } | undefined
        const sameExternal = this.#db
          .prepare('SELECT json FROM bindings WHERE external_key = ?')
          .get(externalKey(binding.providerInstanceId, binding.externalTaskId)) as { json: string } | undefined
        if (operation.kind === 'create') {
          if (existingBinding || (sameExternal && parseJson<TicketBinding>(sameExternal.json).bindingId !== binding.bindingId)) {
            return { committed: false, operation: existing, conflict: 'binding-conflict' }
          }
        } else if (sameExternal && parseJson<TicketBinding>(sameExternal.json).bindingId !== binding.bindingId) {
          return { committed: false, operation: existing, conflict: 'binding-conflict' }
        }
        this.#putBindingLocked(binding)
      }
      this.#upsertOperation(operation)
      return { committed: true, operation }
    })
  }

  async markOperation(operation: WriteOperation): Promise<void> {
    this.#putOperation(operation)
  }

  async transitionOperation(
    ref: OperationRef,
    expected: { states?: WriteOperationState[]; intentVersion?: number },
    next: WriteOperation,
  ): Promise<{ ok: boolean; current: WriteOperation | undefined }> {
    return this.#transaction(() => {
      const key = operationRefKey(ref)
      const row = this.#db.prepare('SELECT json FROM operations WHERE ref_key = ?').get(key) as
        | { json: string }
        | undefined
      if (!row) return { ok: false, current: undefined }
      const current = parseJson<WriteOperation>(row.json)
      if (expected.states && !expected.states.includes(current.state)) return { ok: false, current }
      if (expected.intentVersion !== undefined && current.intentVersion !== expected.intentVersion) {
        return { ok: false, current }
      }
      this.#upsertOperation(next)
      return { ok: true, current: next }
    })
  }

  async claimComment(
    ref: OperationRef,
    bindingId: string,
    externalCommentId: number,
    next: WriteOperation,
  ): Promise<{ ok: boolean; current: WriteOperation | undefined; conflicting?: OperationRef }> {
    return this.#transaction(() => {
      const key = operationRefKey(ref)
      const row = this.#db.prepare('SELECT json FROM operations WHERE ref_key = ?').get(key) as
        | { json: string }
        | undefined
      if (!row) return { ok: false, current: undefined, conflicting: ref }
      const current = parseJson<WriteOperation>(row.json)
      if (current.state !== 'pending' && current.state !== 'unknown') {
        return { ok: false, current, conflicting: ref }
      }
      const bindingRow = this.#db
        .prepare('SELECT json FROM bindings WHERE binding_id = ?')
        .get(bindingId) as { json: string } | undefined
      if (!bindingRow) return { ok: false, current, conflicting: ref }
      const binding = parseJson<TicketBinding>(bindingRow.json)
      const claim = this.#db
        .prepare(
          'SELECT ref_key, hex(ref_key) AS ref_key_hex FROM comment_claims WHERE provider_instance_id = ? AND external_comment_id = ?',
        )
        .get(binding.providerInstanceId, externalCommentId) as
        | { ref_key: string; ref_key_hex: string }
        | undefined
      if (claim) {
        const claimedRefKey = operationKeyFromClaimRefKey(claim.ref_key, claim.ref_key_hex)
        if (claimedRefKey !== key) {
          const conflictingRow = this.#db.prepare('SELECT json FROM operations WHERE ref_key = ?').get(claimedRefKey) as
            | { json: string }
            | undefined
          const conflicting = conflictingRow ? parseJson<WriteOperation>(conflictingRow.json).operationRef : ref
          return { ok: false, current, conflicting }
        }
      }
      // Claim uniqueness is provider-scoped via comment_claims(provider_instance_id,
      // external_comment_id); there is no global numeric-id claim across providers.
      this.#db
        .prepare(
          `INSERT INTO comment_claims (provider_instance_id, external_comment_id, ref_key) VALUES (?, ?, ?)
           ON CONFLICT(provider_instance_id, external_comment_id) DO UPDATE SET ref_key = excluded.ref_key`,
        )
        .run(binding.providerInstanceId, externalCommentId, claimRefKey(ref))
      this.#upsertOperation(next)
      return { ok: true, current: next }
    })
  }

  #migrateLegacyCommentClaims(): void {
    const operations = this.#db
      .prepare('SELECT hex(ref_key) AS ref_key_hex, json FROM operations')
      .all() as Array<{ ref_key_hex: string; json: string }>
    const encodedKeys = new Map<string, string>()
    for (const row of operations) {
      const operation = parseJson<WriteOperation>(row.json)
      encodedKeys.set(row.ref_key_hex, claimRefKey(operation.operationRef))
    }

    const claims = this.#db
      .prepare(
        'SELECT provider_instance_id, external_comment_id, hex(ref_key) AS ref_key_hex FROM comment_claims',
      )
      .all() as Array<{ provider_instance_id: string; external_comment_id: number; ref_key_hex: string }>
    for (const claim of claims) {
      const encodedKey = encodedKeys.get(claim.ref_key_hex)
      if (!encodedKey) continue
      this.#db
        .prepare(
          'UPDATE comment_claims SET ref_key = ? WHERE provider_instance_id = ? AND external_comment_id = ?',
        )
        .run(encodedKey, claim.provider_instance_id, claim.external_comment_id)
    }
  }

  #putOperation(operation: WriteOperation): void {
    this.#upsertOperation(operation)
  }

  #insertOperation(operation: WriteOperation): void {
    this.#db
      .prepare(
        `INSERT INTO operations (ref_key, workspace_id, actor_account_id, state, binding_id, external_comment_id, json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operationRefKey(operation.operationRef),
        operation.operationRef.workspaceId,
        operation.operationRef.actorAccountId,
        operation.state,
        operation.bindingId ?? null,
        operation.externalCommentId ?? null,
        JSON.stringify(operation),
      )
  }

  #upsertOperation(operation: WriteOperation): void {
    this.#db
      .prepare(
        `INSERT INTO operations (ref_key, workspace_id, actor_account_id, state, binding_id, external_comment_id, json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref_key) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           actor_account_id = excluded.actor_account_id,
           state = excluded.state,
           binding_id = excluded.binding_id,
           external_comment_id = excluded.external_comment_id,
           json = excluded.json`,
      )
      .run(
        operationRefKey(operation.operationRef),
        operation.operationRef.workspaceId,
        operation.operationRef.actorAccountId,
        operation.state,
        operation.bindingId ?? null,
        operation.externalCommentId ?? null,
        JSON.stringify(operation),
      )
  }

  #putBindingLocked(binding: TicketBinding): void {
    const key = externalKey(binding.providerInstanceId, binding.externalTaskId)
    const claimed = this.#db
      .prepare('SELECT json FROM bindings WHERE external_key = ?')
      .get(key) as { json: string } | undefined
    if (claimed && parseJson<TicketBinding>(claimed.json).bindingId !== binding.bindingId) {
      throw new TicketError('BINDING_CONFLICT', 'external task already bound')
    }
    this.#db
      .prepare(
        `INSERT INTO bindings (binding_id, workspace_id, external_key, json) VALUES (?, ?, ?, ?)
         ON CONFLICT(binding_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           external_key = excluded.external_key,
           json = excluded.json`,
      )
      .run(binding.bindingId, binding.workspaceId, key, JSON.stringify(binding))
    const known = this.#currentIntentVersion(binding.bindingId)
    if (binding.stateIntentVersion > known) this.#setIntentVersion(binding.bindingId, binding.stateIntentVersion)
  }

  #requireBindingJson(bindingId: string): TicketBinding {
    const row = this.#db.prepare('SELECT json FROM bindings WHERE binding_id = ?').get(bindingId) as
      | { json: string }
      | undefined
    if (!row) throw new TicketError('BINDING_CONFLICT', 'binding not found for intent version')
    return parseJson<TicketBinding>(row.json)
  }

  #currentIntentVersion(bindingId: string): number {
    const row = this.#db.prepare('SELECT version FROM intent_versions WHERE binding_id = ?').get(bindingId) as
      | { version: number }
      | undefined
    const bindingRow = this.#db.prepare('SELECT json FROM bindings WHERE binding_id = ?').get(bindingId) as
      | { json: string }
      | undefined
    const bindingVersion = bindingRow ? parseJson<TicketBinding>(bindingRow.json).stateIntentVersion : 0
    return Math.max(Number(row?.version ?? 0), bindingVersion)
  }

  #setIntentVersion(bindingId: string, version: number): void {
    const current = this.#currentIntentVersion(bindingId)
    const next = Math.max(current, version)
    this.#db
      .prepare(
        `INSERT INTO intent_versions (binding_id, version) VALUES (?, ?)
         ON CONFLICT(binding_id) DO UPDATE SET version = MAX(version, excluded.version)`,
      )
      .run(bindingId, next)
    const bindingRow = this.#db.prepare('SELECT json FROM bindings WHERE binding_id = ?').get(bindingId) as
      | { json: string }
      | undefined
    if (!bindingRow) return
    const binding = parseJson<TicketBinding>(bindingRow.json)
    if (binding.stateIntentVersion >= next) return
    this.#db
      .prepare('UPDATE bindings SET json = ? WHERE binding_id = ?')
      .run(JSON.stringify({ ...binding, stateIntentVersion: next }), bindingId)
  }

  #transaction<T>(run: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK')
      } catch {
        // Keep the original failure; a failed rollback must not mask it.
      }
      if (error instanceof Error && /UNIQUE constraint failed: bindings\.external_key/.test(error.message)) {
        throw new TicketError('BINDING_CONFLICT', 'external task already bound', { cause: error })
      }
      throw error
    }
  }
}
