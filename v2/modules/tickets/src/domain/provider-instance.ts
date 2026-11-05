/**
 * Server-side provider instance. The identifier, base URL and credential
 * reference are control-plane facts, not ticket content. A binding keeps the
 * identifier forever and resolves the URL and credential by that identifier on
 * every access instead of re-deriving them from the current workspace mapping.
 */
export type ProviderInstanceStatus = 'active' | 'disabled' | 'credential-invalid'

export interface ProviderInstance {
  providerInstanceId: string
  providerKind: 'vikunja-v2'
  baseUrl: string
  credentialRef: string
  status: ProviderInstanceStatus
  createdAt: number
}
