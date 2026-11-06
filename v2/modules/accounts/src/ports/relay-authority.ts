/**
 * A session as reported by the V1 relay. `accessToken` is the relay-issued
 * credential and is the only session material the V2 module relays onward.
 */
export interface RelayAuthSession {
  accessToken: string
  accountId: string
  loginName: string
}

export interface RelayRegistration {
  accountId: string
  loginName: string
}

/**
 * Account/session authority for the V2 accounts module.
 *
 * The V1 relay owns account identity and login sessions. This port delegates
 * authentication (`POST /api/auth/login`), session revalidation
 * (`GET /api/auth/me`), and remote revocation (`POST /api/auth/logout`) to that
 * boundary. Registration (`POST /api/auth/register`) also delegates to the
 * relay and returns account identity only; it does not mint a session or
 * auto-login.
 */
export interface RelayAuthPort {
  register(username: string, password: string): Promise<RelayRegistration>
  authenticate(username: string, password: string): Promise<RelayAuthSession>
  validateSession(accessToken: string): Promise<RelayAuthSession>
  logout(accessToken: string): Promise<void>
}
