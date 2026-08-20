import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { AuthLike } from './store'

// Credentials come through π rather than from its files: π rotates tokens
// under a lock, so a second reader of them eventually holds a dead bearer.

export interface Credentials {
  /** `undefined` means logged out: the store deletes that provider's cache. */
  getAuth(providerId: string): Promise<AuthLike | undefined>
  /** The gate that keeps API-key accounts out of the strip. */
  credentialType(providerId: string): 'oauth' | 'api_key' | undefined
}

export function createPiCredentials(): Credentials {
  let runtime: Promise<ModelRuntime> | undefined
  // Filled beside every lookup, because the store's gate is synchronous and
  // π's answer is not.
  const types = new Map<string, 'oauth' | 'api_key'>()

  function models(): Promise<ModelRuntime> {
    runtime ??= import('@earendil-works/pi-coding-agent').then((pi) => pi.ModelRuntime.create())
    return runtime
  }

  return {
    async getAuth(providerId: string): Promise<AuthLike | undefined> {
      const registry = await models()
      // Asked before the credential resolves, so the gate answers about the
      // account this bearer belongs to.
      const check = await registry.checkAuth(providerId).catch(() => undefined)
      if (check === undefined) types.delete(providerId)
      else types.set(providerId, check.type)
      return registry.getAuth(providerId)
    },

    credentialType: (providerId: string) => types.get(providerId)
  }
}
