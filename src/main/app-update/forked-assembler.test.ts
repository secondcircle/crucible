// @vitest-environment node
//
// The forked assembler against a stand-in child: what is proved is the
// request it hands over, and that every way a child can end — clean exit,
// failing exit with or without a reason, fatal error, hang — comes back as
// exactly one settled promise.
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAssembleRequest } from '../install/assemble-request'
import { forkedAssembler, type ForkedChild } from './forked-assembler'

class StubChild extends EventEmitter implements ForkedChild {
  readonly stderr = new EventEmitter()
  killed = 0
  kill(): boolean {
    this.killed += 1
    return true
  }
}

interface Rig {
  readonly forks: Array<{ readonly script: string; readonly args: readonly string[] }>
  readonly child: StubChild
  readonly assemble: (tree: string, target: string) => Promise<void>
}

function rig(timeoutMs?: number): Rig {
  const forks: Array<{ script: string; args: readonly string[] }> = []
  const child = new StubChild()
  const assemble = forkedAssembler({
    script: '/bundle/out/main/assemble-cli.js',
    packageName: '@scope/crucible',
    fork: (script, args) => {
      forks.push({ script, args })
      return child
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  })
  return { forks, child, assemble }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('forkedAssembler', () => {
  it('hands the child the built entry and the whole request as one JSON argument', async () => {
    const { forks, child, assemble } = rig()
    const pending = assemble('/staging/tree', '/Applications/Crucible.app')
    child.emit('exit', 0)
    await pending

    expect(forks).toHaveLength(1)
    expect(forks[0].script).toBe('/bundle/out/main/assemble-cli.js')
    expect(parseAssembleRequest(forks[0].args[0])).toEqual({
      tree: '/staging/tree',
      packageName: '@scope/crucible',
      target: '/Applications/Crucible.app'
    })
  })

  it('fails with what the child said on stderr', async () => {
    const { child, assemble } = rig()
    const pending = assemble('/staging/tree', '/Applications/Crucible.app')
    child.stderr.emit('data', Buffer.from('Crucible could not find '))
    child.stderr.emit('data', '@scope/crucible in /staging/tree.\n')
    child.emit('exit', 1)

    await expect(pending).rejects.toThrow(
      'Crucible could not find @scope/crucible in /staging/tree.'
    )
  })

  it('names the exit code when the child said nothing', async () => {
    const { child, assemble } = rig()
    const pending = assemble('/staging/tree', '/Applications/Crucible.app')
    child.emit('exit', 137)

    await expect(pending).rejects.toThrow('exited with code 137')
  })

  it('fails on a fatal error in the child', async () => {
    const { child, assemble } = rig()
    const pending = assemble('/staging/tree', '/Applications/Crucible.app')
    child.emit('error', 'FatalError', 'assemble-cli.js:1', 'report')

    await expect(pending).rejects.toThrow('FatalError at assemble-cli.js:1')
  })

  it('kills a child that outlives the timeout and fails once', async () => {
    vi.useFakeTimers()
    const { child, assemble } = rig(5_000)
    const pending = assemble('/staging/tree', '/Applications/Crucible.app')
    // Attached before the clock moves, so the rejection is never unhandled.
    const outcome = pending.then(
      () => 'resolved',
      (cause: Error) => cause.message
    )

    vi.advanceTimersByTime(5_000)
    expect(child.killed).toBe(1)
    // The kill lands as an exit, which must not settle the promise a second
    // way or throw.
    child.emit('exit', 0)

    expect(await outcome).toBe('Assembling the update took longer than 5s.')
  })
})

describe('parseAssembleRequest', () => {
  it('refuses a missing, malformed or incomplete request plainly', () => {
    expect(() => parseAssembleRequest(undefined)).toThrow('needs a request')
    expect(() => parseAssembleRequest('{')).toThrow('not JSON')
    expect(() => parseAssembleRequest('"tree"')).toThrow('not an object')
    expect(() => parseAssembleRequest('{"packageName":"x"}')).toThrow('names no tree')
    expect(() => parseAssembleRequest('{"tree":"/t"}')).toThrow('names no package')
    expect(() => parseAssembleRequest('{"tree":"/t","packageName":"x","target":3}')).toThrow(
      'not a path'
    )
  })

  it('leaves the target out when none was given, as postinstall does', () => {
    expect(parseAssembleRequest('{"tree":"/t","packageName":"x"}')).toEqual({
      tree: '/t',
      packageName: 'x'
    })
  })
})
