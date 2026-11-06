import { normalizeLoginName, type AuthContext } from '../domain/accounts.ts'
import type { RelayAuthPort, RelayAuthSession } from '../ports/relay-authority.ts'
import { AccountsError } from '../public/errors.ts'

export interface AuthServiceOptions {
  authority: RelayAuthPort
  now?: () => number
  sessionTtlMs?: number
}

export interface RegisterInput {
  loginName: string
  credential: string
  displayName?: string
}

export interface LoginInput {
  loginName: string
  credential: string
}

export interface LoginResult {
  token: string
  authContext: AuthContext
}

export interface RegisterResult {
  accountId: string
  loginName: string
}

export interface LogoutResult {
  sessionId: string
  revokedAt: number
}

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Account use cases backed by the V1 relay boundary.
 *
 * The relay owns identity and sessions, so this service never mints a local
 * account or a local session token. Logout calls the relay logout endpoint to
 * revoke the bearer session at the authority; a later revalidation of that
 * token is rejected by the relay.
 */
export class AuthService {
  readonly #authority: RelayAuthPort
  readonly #now: () => number
  readonly #sessionTtlMs: number

  constructor(options: AuthServiceOptions) {
    this.#authority = options.authority
    this.#now = options.now ?? Date.now
    this.#sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  }

  async register(input: RegisterInput): Promise<RegisterResult> {
    const loginName = normalizeLoginName(input.loginName)
    const registered = await this.#authority.register(loginName, input.credential)
    return {
      accountId: registered.accountId,
      loginName: registered.loginName,
    }
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const loginName = normalizeLoginName(input.loginName)
    const session = await this.#authority.authenticate(loginName, input.credential)
    return {
      token: session.accessToken,
      authContext: this.#context(session),
    }
  }

  async verifySession(token: string): Promise<AuthContext> {
    if (typeof token !== 'string' || token.length === 0) {
      throw new AccountsError('AUTHENTICATION_REQUIRED', 401)
    }
    const session = await this.#authority.validateSession(token)
    return this.#context(session)
  }

  async logout(token: string): Promise<LogoutResult> {
    if (typeof token !== 'string' || token.length === 0) {
      throw new AccountsError('AUTHENTICATION_REQUIRED', 401)
    }
    await this.#authority.logout(token)
    return { sessionId: token, revokedAt: this.#now() }
  }

  #context(session: RelayAuthSession): AuthContext {
    const now = this.#now()
    return {
      sessionId: session.accessToken,
      accountId: session.accountId,
      loginName: session.loginName,
      displayName: session.loginName,
      credentialState: 'active',
      issuedAt: now,
      expiresAt: now + this.#sessionTtlMs,
    }
  }
}
