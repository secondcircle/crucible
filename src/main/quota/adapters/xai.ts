import type { QuotaMeter } from '../../../shared/quota/types'
import { onceIn } from '../log'
import { getJson } from './http'
import type { AdapterRequest, AdapterResult, ProviderAdapter } from './types'

// One query parameter apart, this URL also returns a monthly dollar envelope,
// so the adapter never trusts the URL it sent and requires the payload's own
// period to say weekly.

export const XAI_PROVIDER_ID = 'xai'
export const XAI_QUOTA_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'

const WEEKLY_SUFFIX = '_WEEKLY'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

/** `null` is contract drift, the monthly envelope included, and deliberately so. */
export function parseXaiQuota(
  payload: unknown,
  opts: { log?: (message: string) => void } = {}
): QuotaMeter[] | null {
  const log = onceIn(XAI_PROVIDER_ID, opts.log)
  if (!isRecord(payload)) return null
  const config = payload['config']
  if (!isRecord(config)) return null

  // A period that does not call itself weekly is refused rather than read as a
  // quota window: the monthly envelope would print dollars as a weekly meter.
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
  // The sink is passed on raw: the parser gates it once per process. The
  // endpoint accepts a bare bearer, so no vendor headers are sent.
  const res = await getJson({ ...req, url: XAI_QUOTA_URL, bearer })
  if (!res.ok) return res

  const meters = parseXaiQuota(res.payload, { log: req.log })
  if (meters === null) return { ok: false, error: 'unparsed' }
  return { ok: true, meters }
}

export const xaiAdapter: ProviderAdapter = { providerId: XAI_PROVIDER_ID, fetchQuota }
