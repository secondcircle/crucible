import type { AuthMethod, ProviderState } from '../../shared/agent/port'

// The classification π's provider catalog needs before it can be shown: kept
// pure and apart from the adapter so it can be tested without constructing one
// (and therefore without a paid call).

/** What π's `Provider` says about itself, reduced to what a status needs. */
export interface ProviderFacts {
  readonly id: string
  readonly name: string
  /** π's `auth.oauth`; absent when the provider has no OAuth flow. */
  readonly oauth?: { readonly name?: string; readonly isSubscription?: boolean }
  // π's `auth.apiKey`. `interactive` is false for ambient-only providers,
  // which offer no `login` and so cannot be logged into from Crucible.
  readonly apiKey?: { readonly interactive: boolean }
}

/** π's `AuthCheck`, or nothing at all when the provider has no credential. */
export interface AuthFacts {
  readonly type: 'api_key' | 'oauth'
  /** π's human-readable label: "ANTHROPIC_API_KEY", "OAuth", "~/.aws/…". */
  readonly source?: string
}

// π labels an ambient key with the variable it came from, and a variable name
// is the one thing that looks like this.
const ENVIRONMENT_VARIABLE = /^[A-Z][A-Z0-9_]*$/

export function methodsOf(provider: ProviderFacts): readonly AuthMethod[] {
  const methods: AuthMethod[] = []
  if (provider.oauth !== undefined) methods.push('oauth')
  if (provider.apiKey?.interactive === true) methods.push('api-key')
  return methods
}

/**
 * One provider, as the settings surface sees it: a name, what a login could
 * use, and what the stored credentials currently say.
 */
export function toProviderState(provider: ProviderFacts, check?: AuthFacts): ProviderState {
  return {
    id: provider.id,
    name: provider.name,
    methods: methodsOf(provider),
    status: statusOf(provider, check)
  }
}

function statusOf(provider: ProviderFacts, check?: AuthFacts): ProviderState['status'] {
  if (check === undefined) return { kind: 'none' }

  if (check.type === 'oauth') {
    const detail = oauthDetail(provider, check.source)
    return detail === undefined ? { kind: 'oauth' } : { kind: 'oauth', detail }
  }

  const source = check.source?.trim() ?? ''
  // A key that came from the environment is managed outside Crucible, and
  // saying which variable is the whole of what can be done about it.
  if (ENVIRONMENT_VARIABLE.test(source)) return { kind: 'env', variable: source }
  return { kind: 'api-key' }
}

// π's own word for the credential when it has one worth showing — a
// subscription label reads better than the bare word "OAuth".
function oauthDetail(provider: ProviderFacts, source?: string): string | undefined {
  const said = source?.trim() ?? ''
  if (said !== '' && said.toLowerCase() !== 'oauth') return said
  const name = provider.oauth?.name?.trim()
  return name === undefined || name === '' ? undefined : name
}
