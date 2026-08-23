// @vitest-environment node
//
// The seam that puts the meters in front of a node's model.
import { describe, expect, it } from 'vitest'
import type { QuotaRefreshOptions, QuotaService } from '../../shared/quota/service'
import type { QuotaMeter, QuotaSnapshot } from '../../shared/quota/types'
import { chooserFrom } from './select-service'

const FABLE = 'anthropic/claude-fable-5:high'
const OPUS = 'anthropic/claude-opus-5:high'

function anthropic(meters: QuotaMeter[]): QuotaSnapshot {
  const now = Date.now()
  return {
    providers: { anthropic: { providerId: 'anthropic', meters, fetchedAt: now } },
    fetchedAt: now
  }
}

const WEEK_AHEAD = Date.now() + 3 * 24 * 60 * 60 * 1000

function quotaSaying(meters: QuotaMeter[]): QuotaService & { readonly scopes: unknown[] } {
  const scopes: unknown[] = []
  return {
    scopes,
    read: () => Promise.resolve(anthropic(meters)),
    refresh(opts: QuotaRefreshOptions = {}) {
      scopes.push(opts.providers)
      return Promise.resolve(anthropic(meters))
    },
    onChange: () => () => {}
  }
}

describe('the chooser the engine is wired with', () => {
  it('sends a fable node to opus while fable leads the account week', async () => {
    const quota = quotaSaying([
      { kind: 'weekly', label: '7D', usedPercent: 67, resetsAt: WEEK_AHEAD },
      { kind: 'weekly_scoped', label: 'FABLE', usedPercent: 92, resetsAt: WEEK_AHEAD }
    ])

    expect(await chooserFrom(quota)(FABLE)).toBe(OPUS)
    // Only the provider whose model is in question; nobody else's request is spent.
    expect(quota.scopes).toEqual([['anthropic']])
  })

  it('leaves the node alone while the account week leads', async () => {
    const quota = quotaSaying([
      { kind: 'weekly', label: '7D', usedPercent: 92, resetsAt: WEEK_AHEAD },
      { kind: 'weekly_scoped', label: 'FABLE', usedPercent: 67, resetsAt: WEEK_AHEAD }
    ])

    expect(await chooserFrom(quota)(FABLE)).toBe(FABLE)
  })
})
