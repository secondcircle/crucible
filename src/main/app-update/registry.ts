// The public npm registry, asked one question: what is `latest`. No auth —
// the package is public — and no client library: one document, one field.

export interface UpdateRegistry {
  /** The version behind the `latest` dist-tag. Rejects when it cannot be read. */
  latest(): Promise<string>
}

const REGISTRY = 'https://registry.npmjs.org'

/** Ten seconds: an unreachable registry is a quiet retry, not a wait. */
const TIMEOUT_MS = 10_000

export function npmRegistry(
  packageName: string,
  options: { readonly fetch?: typeof globalThis.fetch; readonly base?: string } = {}
): UpdateRegistry {
  const fetchOne = options.fetch ?? globalThis.fetch
  const base = options.base ?? REGISTRY
  // A scoped name's slash is the one character the path has to carry encoded.
  const path = packageName.replace('/', '%2f')

  return {
    async latest(): Promise<string> {
      const answer = await fetchOne(`${base}/${path}/latest`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (!answer.ok) {
        throw new Error(`the registry answered ${answer.status} for ${packageName}`)
      }
      const document: unknown = await answer.json()
      const version = (document as { version?: unknown }).version
      if (typeof version !== 'string' || version === '') {
        throw new Error(`the registry named no version for ${packageName}`)
      }
      return version
    }
  }
}
