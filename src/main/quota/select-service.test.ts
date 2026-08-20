// @vitest-environment node
//
// Nothing here builds the SDK-wired service: that would mean loading π, and
// the store's behavior is proven through its injected seams instead.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LogEntry, LogSink } from '../log/sink'
import { quotaServiceKind, selectQuotaService } from './select-service'

function memorySink(): { sink: LogSink; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  return { sink: { append: (entry) => entries.push(entry) }, entries }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('choosing a quota service', () => {
  it('gives the sdk flavor the machine\u2019s own numbers and every other the canned ones', () => {
    expect(quotaServiceKind('sdk')).toBe('live')
    expect(quotaServiceKind('fake')).toBe('canned')
  })

  it('records the choice, so every launch says which one it made', () => {
    const log = memorySink()

    selectQuotaService('fake', log.sink)

    expect(log.entries).toEqual([
      { source: 'main', event: 'quota_service_selected', service: 'canned' }
    ])
  })

  it('serves canned meters under the fake flavor, and performs no IO doing it', async () => {
    const log = memorySink()
    // Pointed somewhere inspectable, because an agent-driven check must never
    // go near the human's quota.
    const home = mkdtempSync(join(tmpdir(), 'crucible-quota-flavor-'))
    vi.stubEnv('PI_CODING_AGENT_DIR', home)
    const fetching = vi.spyOn(globalThis, 'fetch')

    const service = selectQuotaService('fake', log.sink)
    const read = await service.read()
    const refreshed = await service.refresh()

    expect(Object.keys(read.providers).sort()).toEqual(['anthropic', 'openai-codex', 'xai'])
    // The same snapshot from both, because there is nothing behind it to change.
    expect(refreshed).toBe(read)
    expect(fetching).not.toHaveBeenCalled()
    expect(existsSync(join(home, 'usage'))).toBe(false)
    expect(readdirSync(home)).toEqual([])

    rmSync(home, { recursive: true, force: true })
  })
})
