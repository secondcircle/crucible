import { monthlyResetAfter } from '../../../shared/quota/month'
import type { QuotaMeter } from '../../../shared/quota/types'
import { onceIn } from '../log'
import { getJson } from './http'
import type { AdapterRequest, AdapterResult, ProviderAdapter } from './types'

// Only `limits[]` and `.spend` are read, never the top-level slots: those carry
// rotating codenames and omit the scoped meter, so enumerating them would
// couple this client to experiments and still miss the account's highest meter.
// `.spend` is the account's dollar budget and the only monthly source there is;
// the codename pools are one-time credits that pin at 100% once spent, so they
// are no substitute for it. `extra_usage`, `severity`, `cap` and `balance` say
// nothing this strip draws and are never read either.

export const ANTHROPIC_PROVIDER_ID = 'anthropic'
export const ANTHROPIC_QUOTA_URL = 'https://api.anthropic.com/api/oauth/usage'

// Crucible's own, because `.spend` carries no name for itself. Every other
// label on this row is the provider's word.
export const MONTHLY_LABEL = 'MO'

const KINDS: Record<string, { kind: QuotaMeter['kind']; label?: string }> = {
  session: { kind: 'session', label: '5H' },
  weekly_all: { kind: 'weekly', label: '7D' },
  weekly_scoped: { kind: 'weekly_scoped' } // the label comes from the scope
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// An out-of-range percent drops the meter rather than clamping: a fabricated
// zero is indistinguishable from a fresh window.
function readPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || value > 100) return null
  return value
}

function readResetsAt(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/** `amount_minor / 10^exponent`, the exponent defaulting to 2. */
function readAmount(value: unknown): number | null {
  if (!isRecord(value)) return null
  const minor = value['amount_minor']
  if (typeof minor !== 'number' || !Number.isFinite(minor) || minor < 0) return null
  const exponent = value['exponent'] ?? 2
  // A currency has a handful of minor digits. Past that the divisor is large
  // enough to read any amount as $0, which is worse than dropping the meter.
  if (typeof exponent !== 'number' || !Number.isInteger(exponent)) return null
  if (exponent < 0 || exponent > 9) return null
  return minor / 10 ** exponent
}

/**
 * The account's monthly dollar budget. `null` where the plan has none, which is
 * normal rather than drift: only a budget that is there, switched on and
 * unreadable is worth a word.
 */
function parseSpend(
  payload: Record<string, unknown>,
  log: (message: string) => void,
  now: number
): QuotaMeter | null {
  const spend = payload['spend']
  if (!isRecord(spend) || spend['enabled'] !== true) return null

  const used = readAmount(spend['used'])
  const limit = readAmount(spend['limit'])
  if (used === null || limit === null || limit <= 0) {
    log(`dropped ${MONTHLY_LABEL}: .spend is enabled but its amounts are unreadable`)
    return null
  }

  return {
    kind: 'monthly',
    label: MONTHLY_LABEL,
    // Safe to clamp where a limits[] percent is not: this is arithmetic over
    // two real amounts, so 100 is a full budget rather than a fabricated number.
    usedPercent: Math.min(100, (used / limit) * 100),
    resetsAt: monthlyResetAfter(now),
    usedDollars: used,
    limitDollars: limit
  }
}

/** `null` is contract drift; `[]` is a document that legitimately meters nothing. */
export function parseAnthropicQuota(
  payload: unknown,
  opts: { log?: (message: string) => void; now?: number } = {}
): QuotaMeter[] | null {
  const log = onceIn(ANTHROPIC_PROVIDER_ID, opts.log)
  if (!isRecord(payload)) return null
  const limits = payload['limits']
  // No fallback to the top-level keys. If `limits[]` is not there, this payload
  // is drift, not data.
  if (!Array.isArray(limits)) return null

  const meters: QuotaMeter[] = []
  const seen = new Set<string>()
  for (const entry of limits) {
    if (!isRecord(entry)) {
      log('dropped a limits[] entry that is not an object')
      continue
    }
    const rawKind = entry['kind']
    const mapping = typeof rawKind === 'string' ? KINDS[rawKind] : undefined
    if (!mapping) {
      log(`dropped an unrecognized limits[] kind: ${JSON.stringify(rawKind)}`)
      continue
    }

    const scope = isRecord(entry['scope']) ? entry['scope'] : undefined
    const model = scope && isRecord(scope['model']) ? scope['model'] : undefined
    const displayName =
      model && typeof model['display_name'] === 'string' ? model['display_name'] : undefined

    // A scoped meter without the provider's own name for it has no label, and
    // guessing one would print a lie: drop it.
    const label = mapping.label ?? (displayName ? displayName.toUpperCase() : undefined)
    if (label === undefined) {
      log(`dropped a ${rawKind} meter with no scope.model.display_name`)
      continue
    }

    const usedPercent = readPercent(entry['percent'])
    if (usedPercent === null) {
      log(`dropped ${label}: percent absent or out of range (${JSON.stringify(entry['percent'])})`)
      continue
    }

    // A duplicate means the payload changed shape underneath the parser;
    // rendering both would double-count one meter.
    const key = `${mapping.kind}\u0000${label}`
    if (seen.has(key)) {
      log(`dropped a duplicate ${mapping.kind} meter labelled ${label}`)
      continue
    }
    seen.add(key)

    meters.push({
      kind: mapping.kind,
      label,
      usedPercent,
      resetsAt: readResetsAt(entry['resets_at']),
      ...(mapping.kind === 'weekly_scoped' && displayName !== undefined
        ? { scopeName: displayName }
        : {}),
      ...(typeof entry['is_active'] === 'boolean' ? { isActive: entry['is_active'] } : {})
    })
  }

  // Alongside, never instead: an account reporting both shows both, and the
  // work account (`limits: []`, a live `.spend`) shows this one alone.
  const monthly = parseSpend(payload, log, opts.now ?? Date.now())
  if (monthly !== null) meters.push(monthly)

  return meters
}

async function fetchQuota(bearer: string, req: AdapterRequest): Promise<AdapterResult> {
  // The sink is passed on raw: the parser gates it once per process, and gating
  // it twice would leave the second gate never seeing a first delivery.
  const res = await getJson({
    ...req,
    url: ANTHROPIC_QUOTA_URL,
    bearer
    // The endpoint accepts a bare bearer: no `anthropic-beta`, no User-Agent.
  })
  if (!res.ok) return res

  // Not logged here: the store already speaks once per state transition, and
  // saying it twice would be two diagnostics for one.
  const meters = parseAnthropicQuota(res.payload, { log: req.log })
  if (meters === null) return { ok: false, error: 'unparsed' }
  return { ok: true, meters }
}

export const anthropicAdapter: ProviderAdapter = {
  providerId: ANTHROPIC_PROVIDER_ID,
  fetchQuota
}
