// @vitest-environment node
//
// The updater against fakes for everything it touches: the registry, the
// stager, the assembler, the relaunch and the clock. What is proved here is
// the order — staged, assembled into *this* bundle, and only then announced —
// and that a failure anywhere leaves the reported state exactly as it was.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppVersionState } from '../../shared/app-update/service'
import { createAppUpdateService } from './service'
import { createDevVersionService } from './dev-service'

const RUNNING = '1.4.0'
const BUNDLE = '/Applications/Crucible.app'

// What the fakes answer, held in one mutable record so a test can change the
// world between ticks the way the world changes.
interface Plan {
  latest: string | Error
  stagingFails?: string
  assemblyFails?: string
}

interface Rig {
  readonly plan: Plan
  readonly states: AppVersionState[]
  readonly staged: string[]
  readonly assembled: Array<{ readonly tree: string; readonly target: string }>
  readonly failures: string[]
  readonly relaunches: number[]
  readonly service: ReturnType<typeof createAppUpdateService>
}

function watching(latest: string | Error): Rig {
  const plan: Plan = { latest }
  const states: AppVersionState[] = []
  const staged: string[] = []
  const assembled: Array<{ tree: string; target: string }> = []
  const failures: string[] = []
  const relaunches: number[] = []

  const service = createAppUpdateService({
    version: RUNNING,
    bundleRoot: BUNDLE,
    registry: {
      latest: async () => {
        if (plan.latest instanceof Error) throw plan.latest
        return plan.latest
      }
    },
    stage: async (version) => {
      if (plan.stagingFails !== undefined) throw new Error(plan.stagingFails)
      staged.push(version)
      return `/staging/${version}`
    },
    assemble: async (tree, target) => {
      if (plan.assemblyFails !== undefined) throw new Error(plan.assemblyFails)
      assembled.push({ tree, target })
    },
    relaunch: () => relaunches.push(1),
    onFailure: (message) => failures.push(message),
    intervalMs: 50
  })

  return { plan, states, staged, assembled, failures, relaunches, service }
}

function subscribe(rig: Rig): void {
  rig.service.onEvent((state) => rig.states.push(state))
}

/** Lets the check that runs at construction, or on a tick, settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('the installed app checking for a newer version', () => {
  it('stages it, assembles it into its own bundle, and only then says it is ready', async () => {
    const rig = watching('1.5.0')
    subscribe(rig)

    await settle()

    expect(rig.staged).toEqual(['1.5.0'])
    // The running bundle's own root, handed in explicitly: the assembler
    // derives nothing for an app that is already installed.
    expect(rig.assembled).toEqual([{ tree: '/staging/1.5.0', target: BUNDLE }])
    expect(rig.states).toEqual([
      { kind: 'installed', version: RUNNING, update: { kind: 'ready', version: '1.5.0' } }
    ])
    expect(await rig.service.state()).toEqual(rig.states[0])
    rig.service.dispose()
  })

  it('reports a version staged before any window subscribed', async () => {
    const rig = watching('1.5.0')
    await settle()

    // No listener existed while that ran, and the snapshot still holds it.
    expect(await rig.service.state()).toMatchObject({ update: { kind: 'ready', version: '1.5.0' } })
    rig.service.dispose()
  })

  it('is current when the registry has nothing newer', async () => {
    const rig = watching(RUNNING)
    subscribe(rig)

    await settle()

    expect(rig.staged).toEqual([])
    expect(rig.states).toEqual([
      { kind: 'installed', version: RUNNING, update: { kind: 'current' } }
    ])
    rig.service.dispose()
  })

  it('never downgrades: an older latest is current, not an update', async () => {
    const rig = watching('1.3.9')
    subscribe(rig)

    await settle()

    expect(rig.staged).toEqual([])
    expect(rig.states[0]).toMatchObject({ update: { kind: 'current' } })
    rig.service.dispose()
  })

  it('leaves the state untouched when the registry cannot be reached, and retries', async () => {
    const rig = watching(new Error('getaddrinfo ENOTFOUND'))
    subscribe(rig)
    await settle()

    expect(rig.states).toEqual([])
    expect(await rig.service.state()).toEqual({
      kind: 'installed',
      version: RUNNING,
      update: { kind: 'unchecked' }
    })
    expect(rig.failures).toEqual(['getaddrinfo ENOTFOUND'])

    // The next tick tries again, and this time the registry answers.
    rig.plan.latest = '1.5.0'
    await new Promise((wake) => setTimeout(wake, 80))
    await settle()

    expect(rig.states).toEqual([
      { kind: 'installed', version: RUNNING, update: { kind: 'ready', version: '1.5.0' } }
    ])
    rig.service.dispose()
  })

  it('announces nothing when staging fails, and holds the state it had', async () => {
    const rig = watching(RUNNING)
    subscribe(rig)
    await settle()
    const wasCurrent = rig.states[0]

    rig.plan.latest = '1.5.0'
    rig.plan.stagingFails = 'npm install exited 1'
    await new Promise((wake) => setTimeout(wake, 80))
    await settle()

    expect(rig.states).toEqual([wasCurrent])
    expect(rig.assembled).toEqual([])
    expect(rig.failures).toEqual(['npm install exited 1'])
    rig.service.dispose()
  })

  it('announces nothing when the assembly fails', async () => {
    const rig = watching('1.5.0')
    rig.plan.assemblyFails = 'EPERM'
    subscribe(rig)

    await settle()

    expect(rig.staged).toEqual(['1.5.0'])
    expect(rig.states).toEqual([])
    expect(rig.failures).toEqual(['EPERM'])
    rig.service.dispose()
  })

  it('stages a version once, however many checks see it', async () => {
    const rig = watching('1.5.0')
    subscribe(rig)
    await settle()

    await new Promise((wake) => setTimeout(wake, 120))
    await settle()

    expect(rig.staged).toEqual(['1.5.0'])
    expect(rig.states).toHaveLength(1)
    rig.service.dispose()
  })

  it('stages again when something newer still is published', async () => {
    const rig = watching('1.5.0')
    subscribe(rig)
    await settle()

    rig.plan.latest = '1.6.0'
    await new Promise((wake) => setTimeout(wake, 80))
    await settle()

    expect(rig.staged).toEqual(['1.5.0', '1.6.0'])
    expect(rig.states.at(-1)).toMatchObject({ update: { kind: 'ready', version: '1.6.0' } })
    rig.service.dispose()
  })

  it('restarts through the injected relaunch, and never on its own', async () => {
    const rig = watching('1.5.0')
    await settle()
    expect(rig.relaunches).toEqual([])

    await rig.service.restart()

    expect(rig.relaunches).toEqual([1])
    rig.service.dispose()
  })

  it('checks on request, settling when the check has said its piece', async () => {
    const rig = watching(RUNNING)
    subscribe(rig)
    await settle()
    expect(rig.states).toHaveLength(1)

    rig.plan.latest = '1.5.0'
    await rig.service.check()

    expect(rig.staged).toEqual(['1.5.0'])
    expect(rig.states.at(-1)).toMatchObject({ update: { kind: 'ready', version: '1.5.0' } })
    rig.service.dispose()
  })

  it('joins a check already in flight rather than starting a second', async () => {
    let answer: ((latest: string) => void) | undefined
    const staged: string[] = []
    const service = createAppUpdateService({
      version: RUNNING,
      bundleRoot: BUNDLE,
      registry: { latest: () => new Promise((resolve) => (answer = resolve)) },
      stage: async (version) => {
        staged.push(version)
        return `/staging/${version}`
      },
      assemble: async () => {},
      relaunch: () => {},
      intervalMs: 60_000
    })
    // The launch check is waiting on the registry; both of these join it.
    const first = service.check()
    const second = service.check()
    answer?.('1.5.0')
    await Promise.all([first, second])

    expect(staged).toEqual(['1.5.0'])
    service.dispose()
  })

  it('settles a requested check that failed, quietly', async () => {
    const rig = watching(new Error('getaddrinfo ENOTFOUND'))
    await settle()

    await expect(rig.service.check()).resolves.toBeUndefined()

    expect(rig.failures).toEqual(['getaddrinfo ENOTFOUND', 'getaddrinfo ENOTFOUND'])
    expect(await rig.service.state()).toMatchObject({ update: { kind: 'unchecked' } })
    rig.service.dispose()
  })

  it('is silent after dispose', async () => {
    const rig = watching(RUNNING)
    subscribe(rig)
    rig.service.dispose()

    rig.plan.latest = '1.5.0'
    await new Promise((wake) => setTimeout(wake, 80))
    await settle()

    expect(rig.states).toEqual([])
  })
})

describe('the version service a dev launch serves', () => {
  it('answers the checkout it is running, and can carry no update state at all', async () => {
    const service = createDevVersionService({ version: '0.1.0', commit: 'd2d0bba' })
    const states: AppVersionState[] = []
    service.onEvent((state) => states.push(state))

    expect(await service.state()).toEqual({ kind: 'dev', version: '0.1.0', commit: 'd2d0bba' })
    await service.restart()
    await service.check()
    expect(states).toEqual([])
    service.dispose()
  })

  it('names no commit when git could not answer', async () => {
    const service = createDevVersionService({ version: '0.1.0' })

    expect(await service.state()).toEqual({ kind: 'dev', version: '0.1.0' })
  })
})
