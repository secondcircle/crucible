// @vitest-environment node
//
// π's code is imported on the main thread only after a worker has imported it
// first, and a warm-up that goes wrong only ever costs the head start.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPiLoader, warmInWorker, type WarmOutcome } from './pi-modules'

type CodingAgent = typeof import('@earendil-works/pi-coding-agent')
type Ai = typeof import('@earendil-works/pi-ai')

const CODING_AGENT = { name: 'coding-agent' } as unknown as CodingAgent
const AI = { name: 'ai' } as unknown as Ai

/** A warm-up the test finishes by hand, and a record of who did what when. */
function rig(finishWith: 'resolve' | 'reject' = 'resolve') {
  const order: string[] = []
  let finish: () => void = () => {}
  const warms: number[] = []
  const outcomes: WarmOutcome[] = []
  const loader = createPiLoader({
    warm: () => {
      warms.push(1)
      order.push('warm started')
      return new Promise<void>((resolve, reject) => {
        finish = () => {
          order.push('warm finished')
          if (finishWith === 'resolve') resolve()
          else reject(new Error('the worker could not start'))
        }
      })
    },
    onWarm: (outcome) => outcomes.push(outcome),
    importCodingAgent: async () => {
      order.push('coding agent imported')
      return CODING_AGENT
    },
    importAi: async () => {
      order.push('ai imported')
      return AI
    }
  })
  return { loader, order, warms, outcomes, finish: () => finish() }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('loading π', () => {
  it('imports on this thread only once the warm-up has finished', async () => {
    const { loader, order, finish } = rig()
    const agent = loader.codingAgent()
    const ai = loader.ai()
    await tick()
    expect(order).toEqual(['warm started'])

    finish()
    expect(await agent).toBe(CODING_AGENT)
    expect(await ai).toBe(AI)
    expect(order.slice(0, 2)).toEqual(['warm started', 'warm finished'])
    expect(order.slice(2).sort()).toEqual(['ai imported', 'coding agent imported'])
  })

  it('warms once and imports each package once, however many ask', async () => {
    const { loader, order, warms, finish } = rig()
    const asks = [loader.codingAgent(), loader.codingAgent(), loader.ai(), loader.ai()]
    finish()
    await Promise.all(asks)
    await loader.codingAgent()

    expect(warms).toHaveLength(1)
    expect(order.filter((step) => step === 'coding agent imported')).toHaveLength(1)
    expect(order.filter((step) => step === 'ai imported')).toHaveLength(1)
  })

  it('still imports when the warm-up fails, and says why on the log', async () => {
    const { loader, outcomes, finish } = rig('reject')
    const agent = loader.codingAgent()
    finish()

    expect(await agent).toBe(CODING_AGENT)
    expect(outcomes).toEqual([
      expect.objectContaining({ outcome: 'failed', message: 'the worker could not start' })
    ])
  })

  it('says how long a warm-up that worked took', async () => {
    const { loader, outcomes, finish } = rig()
    const agent = loader.codingAgent()
    finish()
    await agent

    expect(outcomes).toEqual([{ outcome: 'warmed', ms: expect.any(Number) }])
  })

  it('imports straight away when nobody named a warm-up', async () => {
    const loader = createPiLoader({ importCodingAgent: async () => CODING_AGENT })
    expect(await loader.codingAgent()).toBe(CODING_AGENT)
  })
})

describe('the warm-up worker', () => {
  const scratch: string[] = []
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function workerFile(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'crucible-pi-warm-'))
    scratch.push(dir)
    const file = join(dir, 'worker.cjs')
    writeFileSync(file, body, 'utf8')
    return file
  }

  it('is done when the worker says it has imported', async () => {
    const file = workerFile(
      "const { parentPort } = require('node:worker_threads')\n" +
        "parentPort.postMessage('warmed')\n" +
        // Still running: the warm-up ends it rather than waiting on it.
        'setInterval(() => {}, 1000)\n'
    )
    await expect(warmInWorker(file)).resolves.toBeUndefined()
  })

  it('fails when the worker throws', async () => {
    const file = workerFile("throw new Error('no such package')\n")
    await expect(warmInWorker(file)).rejects.toThrow('no such package')
  })

  it('fails when the worker leaves without a word', async () => {
    const file = workerFile('process.exit(0)\n')
    await expect(warmInWorker(file)).rejects.toThrow(/exited/)
  })

  it('gives up on a worker that never answers', async () => {
    const file = workerFile('setInterval(() => {}, 1000)\n')
    await expect(warmInWorker(file, 50)).rejects.toThrow(/longer than 50 ms/)
  })

  it('imports π for real from the shipped entry', async () => {
    // Type stripping runs the entry as written, which is what proves the
    // specifiers in it resolve from main's own folder.
    await expect(warmInWorker(join(__dirname, 'pi-warm.ts'))).resolves.toBeUndefined()
  })
})
