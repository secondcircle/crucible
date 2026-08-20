// @vitest-environment node
//
// The whole detection is one file changing under a running process, so the
// tests are a temp directory and a fake clock.
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateReady } from '../../shared/app-update/service'
import { createAppUpdateService, stillAppUpdateService } from './service'

let directory: string
let stampPath: string

function stamp(commit: string): void {
  writeFileSync(stampPath, JSON.stringify({ commit, builtAt: 'whenever' }))
}

beforeEach(() => {
  vi.useFakeTimers()
  directory = mkdtempSync(join(tmpdir(), 'crucible-update-'))
  stampPath = join(directory, 'build-stamp.json')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

function watching(relaunch = vi.fn()): {
  events: UpdateReady[]
  relaunch: ReturnType<typeof vi.fn>
  service: ReturnType<typeof createAppUpdateService>
} {
  const service = createAppUpdateService({ stampPath, relaunch, intervalMs: 50 })
  const events: UpdateReady[] = []
  service.onEvent((event) => events.push(event))
  return { events, relaunch, service }
}

describe('watching the installed bundle', () => {
  it('says nothing while the stamp still names the running build', async () => {
    stamp('aaa1111')
    const { events, service } = watching()

    vi.advanceTimersByTime(500)

    expect(events).toEqual([])
    expect(await service.pending()).toBeNull()
    service.dispose()
  })

  it('announces a changed stamp once, and pending() then names it', async () => {
    stamp('aaa1111')
    const { events, service } = watching()

    stamp('bbb2222')
    vi.advanceTimersByTime(500)

    expect(events).toEqual([{ type: 'update_ready', commit: 'bbb2222' }])
    expect(await service.pending()).toBe('bbb2222')
    service.dispose()
  })

  it('rides out the install window, when the stamp is briefly unreadable', () => {
    stamp('aaa1111')
    const { events, service } = watching()

    unlinkSync(stampPath)
    vi.advanceTimersByTime(100)
    expect(events).toEqual([])

    stamp('ccc3333')
    vi.advanceTimersByTime(100)
    expect(events).toEqual([{ type: 'update_ready', commit: 'ccc3333' }])
    service.dispose()
  })

  it('adopts the first readable stamp as the running build rather than announcing it', () => {
    // No stamp at launch: a stamp appearing is not an update.
    const { events, service } = watching()

    stamp('ddd4444')
    vi.advanceTimersByTime(100)
    expect(events).toEqual([])

    stamp('eee5555')
    vi.advanceTimersByTime(100)
    expect(events).toEqual([{ type: 'update_ready', commit: 'eee5555' }])
    service.dispose()
  })

  it('restarts through the injected relaunch', async () => {
    stamp('aaa1111')
    const { relaunch, service } = watching()

    await service.restart()

    expect(relaunch).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('is silent after dispose', () => {
    stamp('aaa1111')
    const { events, service } = watching()

    service.dispose()
    stamp('fff6666')
    vi.advanceTimersByTime(500)

    expect(events).toEqual([])
  })
})

describe('the still service, which dev launches serve', () => {
  it('never has an update and restarts nothing', async () => {
    const service = stillAppUpdateService()
    const events: UpdateReady[] = []
    service.onEvent((event) => events.push(event))

    expect(await service.pending()).toBeNull()
    await service.restart()
    vi.advanceTimersByTime(500)

    expect(events).toEqual([])
    service.dispose()
  })
})
