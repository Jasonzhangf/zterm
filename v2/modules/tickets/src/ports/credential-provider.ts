export interface ProviderCredential {
  token: string
}

/**
 * Resolves a provider credential by provider instance. The token is a secret:
 * callers must never log it or include it in operation views or evidence.
 */
export interface CredentialProviderPort {
  getCredential(providerInstanceId: string): Promise<ProviderCredential>
}
