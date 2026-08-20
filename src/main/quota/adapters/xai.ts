import type { QuotaMeter } from '../../../shared/quota/types'
import { onceIn } from '../log'
import { getJson } from './http'
import type { AdapterRequest, AdapterResult, ProviderAdapter } from './types'

/**
 * xAI quota adapter: `GET /v1/billing?format=credits` → one weekly meter.
 *
 * The same URL returns two different objects: with `?format=credits` it is the
 * SuperGrok weekly usage pool (`currentPeriod.type: "USAGE_PERIOD_TYPE_WEEKLY"`,
 * `end − start` exactly 604800 s); without it, a monthly dollar envelope whose
 * period runs the calendar month. One query parameter separates them, which is
 * why two third parties disagreed about the same host — so the adapter never
 * trusts the URL it sent and requires the period to say weekly. Anything else
 * is drift, reported as `unparsed`, never rendered as a meter.
 *
 * `onDemandCap`, `onDemandUsed`, `prepaidBalance` and `topUpMethod` are dollar
 * overage — the xAI analogue of Anthropic's `extra_usage` — and are never
 * mapped to a meter.
 */

export const XAI_PROVIDER_ID = 'xai'
export const XAI_QUOTA_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'

/** The payload's own word for the pool this adapter reports. */
const WEEKLY_SUFFIX = '_WEEKLY'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || value > 100) return null
  return value
}

/** ISO-8601 UTC → epoch ms. Anything that does not parse becomes `null`. */
function readResetsAt(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Pure payload → meters. Never throws, never fetches.
 *
 * `null` = not the weekly credits document (the monthly envelope lands here
 * too, deliberately). `[]` = weekly period, but no usable percent.
 */
export function parseXaiQuota(
  payload: unknown,
  opts: { log?: (message: string) => void } = {}
): QuotaMeter[] | null {
  const log = onceIn(XAI_PROVIDER_ID, opts.log)
  if (!isRecord(payload)) return null
  const config = payload['config']
  if (!isRecord(config)) return null

  // Both of these are the same answer: this is not the weekly credits document.
  // The monthly envelope has no `currentPeriod` at all; a period that does not
  // call itself weekly is refused rather than read as a quota window. Either
  // way the caller reports `unparsed`, and the store logs that state once.
  const period = config['currentPeriod']
  if (!isRecord(period)) return null
  const type = period['type']
  if (typeof type !== 'string' || !type.endsWith(WEEKLY_SUFFIX)) return null

  const usedPercent = readPercent(config['creditUsagePercent'])
  if (usedPercent === null) {
    log(
      `dropped 7D: creditUsagePercent absent or out of range (${JSON.stringify(config['creditUsagePercent'])})`
    )
    return []
  }

  return [{ kind: 'weekly', label: '7D', usedPercent, resetsAt: readResetsAt(period['end']) }]
}

async function fetchQuota(bearer: string, req: AdapterRequest): Promise<AdapterResult> {
  // The sink is passed on raw: the parser gates it once per process. Neither
  // `x-xai-token-auth` nor a grok-flavored User-Agent is required; the 401
  // control proved the 200s are genuinely authenticated.
  const res = await getJson({ ...req, url: XAI_QUOTA_URL, bearer })
  if (!res.ok) return res

  const meters = parseXaiQuota(res.payload, { log: req.log })
  if (meters === null) return { ok: false, error: 'unparsed' }
  return { ok: true, meters }
}

export const xaiAdapter: ProviderAdapter = { providerId: XAI_PROVIDER_ID, fetchQuota }
