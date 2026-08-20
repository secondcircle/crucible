import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { AuthLike } from './store'

// π's own credential path, and nothing else. The store never reads `auth.json`
// itself: π rotates tokens under a file lock, so a second reader of that file
// eventually holds a dead bearer.
//
// The SDK is imported dynamically, exactly as the SDK adapter imports it, so
// the CommonJS main bundle can load this module and a fake-flavor launch never
// pulls π in at all.

export interface Credentials {
  /** `undefined` means logged out: the store deletes that provider's cache. */
  getAuth(providerId: string): Promise<AuthLike | undefined>
  /** π's auth check, as the gate that keeps API-key accounts out of the strip. */
  credentialType(providerId: string): 'oauth' | 'api_key' | undefined
}

export function createPiCredentials(): Credentials {
  let runtime: Promise<ModelRuntime> | undefined
  // What π last said about each provider's credential type. Filled by the
  // check that runs beside every lookup, because the store's gate is
  // synchronous and π's answer is not.
  const types = new Map<string, 'oauth' | 'api_key'>()

  function models(): Promise<ModelRuntime> {
    runtime ??= import('@earendil-works/pi-coding-agent').then((pi) => pi.ModelRuntime.create())
    return runtime
  }

  return {
    async getAuth(providerId: string): Promise<AuthLike | undefined> {
      const registry = await models()
      // Asked before the credential is resolved, so the gate below is answering
      // about the account this bearer belongs to.
      const check = await registry.checkAuth(providerId).catch(() => undefined)
      if (check === undefined) types.delete(providerId)
      else types.set(providerId, check.type)
      return registry.getAuth(providerId)
    },

    credentialType: (providerId: string) => types.get(providerId)
  }
}
