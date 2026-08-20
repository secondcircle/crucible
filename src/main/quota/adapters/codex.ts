import type { QuotaMeter } from '../../../shared/quota/types'
import { onceIn } from '../log'
import { getJson } from './http'
import type { AdapterRequest, AdapterResult, ProviderAdapter } from './types'

/**
 * OpenAI Codex quota adapter: `GET /backend-api/wham/usage` → normalized meters.
 *
 * The parser reads the payload's self-description, never its slot names. A
 * meter is classified by `limit_window_seconds` alone: this account's single
 * *weekly* meter sits in the slot called `primary_window`, with
 * `secondary_window: null`. Reading "primary" as "the 5-hour one" would print a
 * weekly number under an hourly label — the failure that looks exactly like a
 * correct reading.
 *
 * `additional_rate_limits[]` carries per-model scoped meters, with the window
 * struct nested one level deeper than the top-level `rate_limit`. Its label is
 * the last dash-segment of `limit_name` (`GPT-5.3-Codex-Spark` → `SPARK`) — the
 * provider's own name for the meter, never a guess.
 *
 * Identity stays here: the body carries `account_id`, `user_id` and `email`,
 * and none of it reaches a `QuotaMeter`. `chatgpt-account-id` is not sent
 * either — it is optional, and deriving it would mean decoding the token's
 * identity claims for no gain.
 */

export const CODEX_PROVIDER_ID = 'openai-codex'
export const CODEX_QUOTA_URL = 'https://chatgpt.com/backend-api/wham/usage'

/** π's own originator, accepted by the endpoint. */
const ORIGINATOR = 'pi'

/**
 * Window durations this parser recognizes, ±60 s. An unfamiliar duration drops
 * its meter and is logged once per process: a missing meter, never a guessed
 * label. The five-hour row is the one unverified line in the contract — no
 * capture has shown it — and it exists only because the classifier must decide
 * something if such a window appears.
 */
const DURATIONS: { seconds: number; kind: QuotaMeter['kind']; label: string }[] = [
  { seconds: 604_800, kind: 'weekly', label: '7D' },
  { seconds: 18_000, kind: 'session', label: '5H' }
]
const TOLERANCE_SECONDS = 60

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Percent is USED on 0–100; absent, `NaN`, negative or >100 drops the meter. */
function readPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || value > 100) return null
  return value
}

/**
 * `reset_at` is unix **seconds** → epoch ms. A value already large enough to be
 * milliseconds is left alone rather than multiplied into the year 58000.
 */
function readResetsAt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value > 10_000_000_000 ? value : value * 1000
}

function classify(
  seconds: unknown,
  log: (message: string) => void
): (typeof DURATIONS)[number] | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    log(`dropped a meter with no limit_window_seconds (${JSON.stringify(seconds)})`)
    return null
  }
  const match = DURATIONS.find((duration) => Math.abs(seconds - duration.seconds) <= TOLERANCE_SECONDS)
  if (!match) {
    log(`dropped a meter with an unrecognized limit_window_seconds: ${seconds}`)
    return null
  }
  return match
}

/** One `{used_percent, limit_window_seconds, reset_at}` struct → one meter. */
function parseMeter(
  raw: unknown,
  scope: { label: string; scopeName: string } | undefined,
  log: (message: string) => void
): QuotaMeter | null {
  if (!isRecord(raw)) return null
  const duration = classify(raw['limit_window_seconds'], log)
  if (!duration) return null

  const usedPercent = readPercent(raw['used_percent'])
  if (usedPercent === null) {
    log(`dropped ${scope?.label ?? duration.label}: used_percent absent or out of range`)
    return null
  }

  return {
    kind: scope ? 'weekly_scoped' : duration.kind,
    label: scope ? scope.label : duration.label,
    usedPercent,
    resetsAt: readResetsAt(raw['reset_at']),
    ...(scope ? { scopeName: scope.scopeName } : {})
  }
}

/** `GPT-5.3-Codex-Spark` → `SPARK`. The provider's own name, shortened. */
function scopeLabel(limitName: string): string {
  const segments = limitName.split('-').filter((segment) => segment.length > 0)
  return (segments[segments.length - 1] ?? limitName).toUpperCase()
}

/**
 * Pure payload → meters. Never throws, never fetches.
 *
 * `null` = not a recognizable quota document (contract drift). `[]` = it parses
 * but names no meter this parser recognizes.
 */
export function parseCodexQuota(
  payload: unknown,
  opts: { log?: (message: string) => void } = {}
): QuotaMeter[] | null {
  const log = onceIn(CODEX_PROVIDER_ID, opts.log)
  if (!isRecord(payload)) return null
  const rateLimit = payload['rate_limit']
  const additional = payload['additional_rate_limits']
  // The plan's own meter block is the document's signature. Without it this is
  // not a quota payload — an error page, a redirect body, a changed route.
  if (!isRecord(rateLimit)) return null

  const meters: QuotaMeter[] = []
  const seen = new Set<string>()
  const push = (meter: QuotaMeter | null): void => {
    if (!meter) return
    const key = `${meter.kind}\u0000${meter.label}`
    if (seen.has(key)) {
      // A duplicate means the payload changed shape underneath the parser;
      // rendering both would double-count one meter.
      log(`dropped a duplicate ${meter.kind} meter labelled ${meter.label}`)
      return
    }
    seen.add(key)
    meters.push(meter)
  }

  // Both slots, classified by declared length. Neither slot name means anything.
  for (const slot of ['primary_window', 'secondary_window']) {
    if (rateLimit[slot] === null || rateLimit[slot] === undefined) continue
    push(parseMeter(rateLimit[slot], undefined, log))
  }

  if (additional !== undefined && !Array.isArray(additional)) {
    log('additional_rate_limits is present but not an array — ignored')
  } else if (Array.isArray(additional)) {
    for (const entry of additional) {
      if (!isRecord(entry)) continue
      const limitName = entry['limit_name']
      if (typeof limitName !== 'string' || limitName.length === 0) {
        log('dropped an additional_rate_limits[] entry with no limit_name')
        continue
      }
      const nested = entry['rate_limit']
      if (!isRecord(nested)) {
        log(`dropped ${limitName}: no nested rate_limit`)
        continue
      }
      const scope = { label: scopeLabel(limitName), scopeName: limitName }
      for (const slot of ['primary_window', 'secondary_window']) {
        if (nested[slot] === null || nested[slot] === undefined) continue
        push(parseMeter(nested[slot], scope, log))
      }
    }
  }

  return meters
}

async function fetchQuota(bearer: string, req: AdapterRequest): Promise<AdapterResult> {
  // The sink is passed on raw: the parser gates it once per process.
  const res = await getJson({
    ...req,
    url: CODEX_QUOTA_URL,
    bearer,
    headers: { originator: ORIGINATOR }
  })
  if (!res.ok) return res

  // No `rate_limit` block is drift, reported as `unparsed`; the store logs that
  // transition once, so the adapter does not log it at all.
  const meters = parseCodexQuota(res.payload, { log: req.log })
  if (meters === null) return { ok: false, error: 'unparsed' }
  return { ok: true, meters }
}

export const codexAdapter: ProviderAdapter = { providerId: CODEX_PROVIDER_ID, fetchQuota }
